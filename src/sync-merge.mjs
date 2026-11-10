/**
 * PC ↔ 手机 记忆/日记 双向同步的**纯合并层**（2026-11-10）。
 *
 * 为什么单独一层纯函数：同步两侧是两台设备、各自离线可写，合并结果必须
 * 1) 与调用顺序无关（merge(a,b) 和 merge(b,a) 得到同一份结果，否则两侧会互相覆盖、无限来回收敛不了）；
 * 2) 不改入参（bridge 手里还握着刚解析出来的 state 对象，合并完要分别写盘，改坏一处就是两份记忆同时烂）；
 * 3) 单条坏数据不能让整次同步失败（一台设备上一条缺 id 的记录不该把 80 条记忆全卡住）。
 * 这三条是这一层存在的理由；所以这里不碰 fs/path，不读时间（now），也不做任何 I/O。
 *
 * 字段真相（2026-11-10 对着 src/memory-facts.mjs 的 addFactV2 / touchFactV2 / archiveFactsV2 / removeFactV2 核过）：
 *   facts 条目真实字段：id text kind tier at hits str touched
 *                       + 复习状态 rev lifeMul reviewedAt dueAt
 *                       + 约定 expiresAt（可选）
 *                       + 归档/软删后：forgotAt expiredAt deletedAt deletedBy
 *   没有 updatedAt / createdAt / lastReviewAt / lastRevAt —— 「最近更新」实际是 touched、at、reviewedAt、dueAt。
 *   任务书里那几个名字按**兼容别名**也认（历史数据/别的端可能这么写），真实字段优先。
 *   遗忘池文件真实的容器是 `{ facts: [...] }`（readForgottenFactsV2 读的是 o.facts），
 *   任务书写的 `{ items: [...] }` 也认；两种都读，免得同步时读空。
 *
 * 合并语义与理由：
 *  · facts 按 id 取并集，不是「谁新谁整条覆盖」——两台设备离线时都会新增，整条覆盖会丢记忆。
 *  · str / hits / rev 取较大值：强度与复习次数只会单调涨（衰减是在读取时算的，不落盘），
 *    取小会让同步把「复习过的记忆」打回原形，越同步越淡。
 *  · dueAt / reviewedAt（含 lastReviewAt / lastRevAt 别名）取较晚的：复习日程不能倒退，
 *    否则两台设备互相把 dueAt 提前，每轮都触发复习，复习次数被刷爆（6 小时闸也会被反复越过）。
 *  · text 取「非空且更长」那条：沿用 addFactV2 里「同一件事换个说法留更长那条」的规则，信息量只增不减；
 *    等长时按字符串字典序取大的，保证两侧算出来是同一条（对称，不依赖参数顺序）。
 *  · tier 优先 long：long 永不归档、下限 0.3，同步时把 long 降成 normal 等于悄悄把她记得最牢的事降级；
 *    kind 跟 tier 的判定侧走（同一条记忆的类型两边不一致时，以「更该信的那侧」为准）。
 *  · 其他未知字段：以较新的一侧为准（较新 = touched / at / reviewedAt / dueAt 里最晚的那个时间）。
 *    两侧都没有时间戳时按稳定序列化后的字典序定胜负 —— 仍然是**对称**的，不退回「取 a」，
 *    否则 merge(a,b) 与 merge(b,a) 的未知字段会不同，两侧写盘后又互相改，永远收敛不了。
 *  · 结果排序：str 降序 → at 升序 → id 升序。前两条是任务要求；id 兜底是「两侧字节一致」的必要条件
 *    （同 str 同 at 的两条如果只靠稳定排序，输入顺序不同结果就不同）。排序的意义不只是好看：
 *    文件字节一致，同步才能靠哈希判断「要不要写盘」，否则每轮都在写同一份内容。
 *  · 遗忘池只做并集，不截断：容量上限（FACTS_FORGOTTEN_MAX=300，写盘时 slice(-300)）属于存储层，
 *    合并层截断会把「较新的遗忘条目」挤掉；顺序也保留（先 a 后 b 新增），因为保留的是最后 N 条。
 *  · diary 行级并集：A 的每一行原样保留（含空行、标题、行尾），只把 B 里「非空且 A 没有」的行按 B 的顺序追加。
 *    不重排、不合并段落、不改行内容 —— 日记是她的原文，同步不是编辑器。
 *
 * 明确不做（留给上层）：不处理删除传播（墓碑）、不做容量淘汰、不做跨条目查重（isSameByFillersV2 属于写入路径）、
 * 不解析 / 不格式化时间（只比较字符串；ISO-8601 字典序即时间序）。
 */

const FACT_LIST_KEYS = ['facts', 'items'];
const FORGOTTEN_LIST_KEYS = ['facts', 'items', 'forgotten'];

// 真实字段在前，兼容别名在后（只用于「谁更新」与「时间取较晚」的比较，不写回别名）。
const FACT_RECENCY_FIELDS = ['touched', 'at', 'reviewedAt', 'dueAt', 'updatedAt', 'createdAt', 'lastReviewAt', 'lastRevAt'];
const FACT_TIME_FIELDS = ['dueAt', 'reviewedAt', 'lastReviewAt', 'lastRevAt'];
const FORGOTTEN_RECENCY_FIELDS = ['forgotAt', 'forgottenAt', 'deletedAt', 'expiredAt', 'touched', 'at', 'reviewedAt', 'dueAt', 'updatedAt', 'createdAt'];
const FORGOTTEN_TIME_FIELDS = ['forgottenAt', 'forgotAt', 'deletedAt', 'expiredAt', 'dueAt', 'reviewedAt', 'lastReviewAt', 'lastRevAt'];
const FACT_KINDS = new Set(['fact', 'pref', 'event', 'promise']);
const FACT_TIERS = new Set(['long', 'normal']);

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isFilled(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/** 从 {facts:[...]} / {items:[...]} / 裸数组 里取条目列表；畸形输入一律当空。 */
function readList(obj, keys) {
  if (Array.isArray(obj)) return obj;
  if (!isObject(obj)) return [];
  for (const k of keys) if (Array.isArray(obj[k])) return obj[k];
  return [];
}

/** 条目 id：只认字符串/数字，缺 id 或空 id 的条目由调用方跳过。 */
function idOf(entry) {
  if (!isObject(entry)) return '';
  const raw = entry.id;
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
}

/** 时间解析成毫秒；空串/undefined/非日期一律 0（= 没有）。数字按毫秒理解。 */
function parseTimeMs(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string') return 0;
  const ms = Date.parse(v.trim());
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 取较晚的那个时间字符串。空串/undefined 当「没有」。
 * 解析都失败时按字典序兜底 —— 保证对称（两个都是垃圾串时也只有一个确定答案）。
 */
export function isoLater(x, y) {
  const mx = parseTimeMs(x);
  const my = parseTimeMs(y);
  if (!mx && !my) {
    if (!isFilled(x)) return isFilled(y) ? y : x;
    if (!isFilled(y)) return x;
    return String(x) >= String(y) ? x : y;
  }
  if (!mx) return y;
  if (!my) return x;
  if (mx !== my) return my > mx ? y : x;
  return String(x) >= String(y) ? x : y;
}

/** 数值字段取大；空串/布尔/非数字当「没有」。两侧都没有返回 null。 */
function maxNum(x, y) {
  const nx = (x === '' || x === null || x === undefined || typeof x === 'boolean') ? null : Number(x);
  const ny = (y === '' || y === null || y === undefined || typeof y === 'boolean') ? null : Number(y);
  const vx = Number.isFinite(nx) ? nx : null;
  const vy = Number.isFinite(ny) ? ny : null;
  if (vx === null && vy === null) return null;
  if (vx === null) return vy;
  if (vy === null) return vx;
  return Math.max(vx, vy);
}

/** 取「非空且更长」的正文；等长取字典序大的（对称）。 */
function longerText(x, y) {
  const sx = x === undefined || x === null ? '' : String(x);
  const sy = y === undefined || y === null ? '' : String(y);
  const ax = sx.trim() ? sx : '';
  const ay = sy.trim() ? sy : '';
  if (!ax) return ay;
  if (!ay) return ax;
  if (ay.length > ax.length) return ay;
  if (ax.length > ay.length) return ax;
  return ax >= ay ? ax : ay;
}

/** 键排序的稳定序列化：用于比较「内容是否相同」和未知字段的对称决胜。 */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) === undefined ? 'undefined' : JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** 条目「最近活动」毫秒：取指定字段里最晚的那个；都缺为 0。 */
export function entryRecencyMs(entry, fields = FACT_RECENCY_FIELDS) {
  if (!isObject(entry)) return 0;
  let best = 0;
  for (const k of fields) {
    const ms = parseTimeMs(entry[k]);
    if (ms > best) best = ms;
  }
  return best;
}

/** 两侧同 id 条目谁更新：'a' | 'b' | 'tie'。时间都缺时按稳定序列化对称决胜（不依赖参数顺序）。 */
export function newerFactsEntry(a, b) {
  return newerEntry(a, b, FACT_RECENCY_FIELDS);
}

function newerEntry(a, b, fields) {
  const ra = entryRecencyMs(a, fields);
  const rb = entryRecencyMs(b, fields);
  if (ra !== rb) return ra > rb ? 'a' : 'b';
  const ca = stableStringify(a);
  const cb = stableStringify(b);
  if (ca === cb) return 'tie';
  return ca > cb ? 'a' : 'b';
}

/** 同 id 的 facts 条目逐字段合并（不改入参，返回新对象）。 */
function mergeFactPair(a, b) {
  const side = newerFactsEntry(a, b);
  const newer = side === 'b' ? b : a;
  const older = side === 'b' ? a : b;
  // 未知字段：并集 + 较新侧优先（只在一侧出现的字段保留，不丢信息）。
  const out = { ...older, ...newer };

  const text = longerText(a.text, b.text);
  if (isFilled(text)) out.text = text; else delete out.text;

  for (const k of ['str', 'hits', 'rev']) {
    const v = maxNum(a[k], b[k]);
    if (v === null) delete out[k]; else out[k] = v;
  }
  for (const k of FACT_TIME_FIELDS) {
    const v = isoLater(a[k], b[k]);
    if (isFilled(v)) out[k] = v; else delete out[k];
  }

  // kind/tier：先看 tier==='long' 的那侧（long 是「她记得最牢的事」，不能被同步降级），
  // 两侧一致时跟「较新」的那侧走。
  const aLong = a.tier === 'long';
  const bLong = b.tier === 'long';
  const source = aLong !== bLong ? (aLong ? a : b) : newer;
  const other = source === a ? b : a;
  const kind = FACT_KINDS.has(source.kind) ? source.kind
    : (FACT_KINDS.has(other.kind) ? other.kind : source.kind);
  const tier = FACT_TIERS.has(source.tier) ? source.tier
    : (FACT_TIERS.has(other.tier) ? other.tier : source.tier);
  if (kind === undefined) delete out.kind; else out.kind = kind;
  if (tier === undefined) delete out.tier; else out.tier = tier;

  return out;
}

/** 同 id 的遗忘池条目合并：较新那条为底，str 取大、正文取长、时间字段取晚。 */
function mergeForgottenPair(a, b) {
  const side = newerEntry(a, b, FORGOTTEN_RECENCY_FIELDS);
  const newer = side === 'b' ? b : a;
  const older = side === 'b' ? a : b;
  const out = { ...older, ...newer };

  const text = longerText(a.text, b.text);
  if (isFilled(text)) out.text = text; else delete out.text;
  const str = maxNum(a.str, b.str);
  if (str === null) delete out.str; else out.str = str;
  for (const k of FORGOTTEN_TIME_FIELDS) {
    const v = isoLater(a[k], b[k]);
    if (isFilled(v)) out[k] = v; else delete out[k];
  }
  return out;
}

/** facts 合并后的排序：str 降序 → at 升序 → id 升序（id 兜底保证两侧字节一致）。 */
export function factsSortCompare(a, b) {
  const sa = maxNum(a?.str, null);
  const sb = maxNum(b?.str, null);
  const va = sa === null ? -Infinity : sa;
  const vb = sb === null ? -Infinity : sb;
  if (va !== vb) {
    if (va === -Infinity) return 1;
    if (vb === -Infinity) return -1;
    return vb - va;
  }
  const ta = createdMs(a);
  const tb = createdMs(b);
  if (ta !== tb) return ta - tb;
  const ia = idOf(a);
  const ib = idOf(b);
  if (ia === ib) return 0;
  return ia < ib ? -1 : 1;
}

function createdMs(entry) {
  if (!isObject(entry)) return 0;
  return parseTimeMs(entry.at) || parseTimeMs(entry.createdAt) || parseTimeMs(entry.updatedAt) || 0;
}

/**
 * 把一侧的条目按 id 建索引。同侧出现重复 id 时先就地合并（视作同一件事的两次写入），
 * 缺 id / 非对象的坏条目直接跳过（不抛错 —— 一条坏数据不该让整次同步失败）。
 */
function indexEntries(list, mergePair) {
  const map = new Map();
  let count = 0;
  for (const entry of list) {
    const id = idOf(entry);
    if (!id) continue;
    count += 1;
    if (map.has(id)) map.set(id, mergePair(map.get(id), entry));
    else map.set(id, entry);
  }
  return { map, count };
}

function emptyStats() {
  return { aCount: 0, bCount: 0, mergedCount: 0, onlyA: 0, onlyB: 0, updated: 0, bothSame: 0 };
}

function mergeEntryStates(a, b, listKeys, mergePair) {
  const ia = indexEntries(readList(a, listKeys), mergePair);
  const ib = indexEntries(readList(b, listKeys), mergePair);
  const merged = [];
  let onlyA = 0;
  let onlyB = 0;
  let updated = 0;
  let bothSame = 0;
  for (const [id, ea] of ia.map) {
    if (!ib.map.has(id)) {
      merged.push({ ...ea });
      onlyA += 1;
      continue;
    }
    const eb = ib.map.get(id);
    merged.push(mergePair(ea, eb));
    if (stableStringify(ea) === stableStringify(eb)) bothSame += 1;
    else updated += 1;
  }
  for (const [id, eb] of ib.map) {
    if (!ia.map.has(id)) {
      merged.push({ ...eb });
      onlyB += 1;
    }
  }
  return {
    merged,
    stats: {
      aCount: ia.count,
      bCount: ib.count,
      mergedCount: merged.length,
      onlyA,
      onlyB,
      updated,
      bothSame
    }
  };
}

/**
 * 合并两侧 facts.json 解析后的对象（{facts:[...]}；裸数组也认）。
 * 返回 { merged, stats }，merged 是排序后的新数组，stats 见 emptyStats()。
 */
export function mergeFactsState(a, b) {
  const result = mergeEntryStates(a, b, FACT_LIST_KEYS, mergeFactPair);
  result.merged.sort(factsSortCompare);
  return result;
}

/**
 * 合并两侧遗忘池（{facts:[...]} 或 {items:[...]}）。只做并集、不截断、不重排
 * （保留原顺序：先 a 后 b 新增；写盘层的 slice(-N) 依赖这个近似时间序）。
 */
export function mergeForgottenState(a, b) {
  return mergeEntryStates(a, b, FORGOTTEN_LIST_KEYS, mergeForgottenPair);
}

function countLines(text) {
  if (!text) return 0;
  const s = String(text);
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

function lineKey(line) {
  return String(line).replace(/\r+$/, '');
}

/**
 * 日记按行合并：A 原样保留（含空行、标题、行尾），只把 B 里「非空且 A 没有完全相同的行」
 * 按 B 的相对顺序追加到末尾。不重排、不合并段落、不改行内容。
 * 一侧为空（'' / null / undefined）时视为恒等，直接返回另一侧原文（不借机清洗空行）。
 */
export function mergeDiaryText(textA, textB) {
  const A = textA === undefined || textA === null ? '' : String(textA);
  const B = textB === undefined || textB === null ? '' : String(textB);
  if (!A) return B;
  if (!B) return A;

  const endsWithNL = A.endsWith('\n');
  const linesA = A.split('\n');
  const seen = new Set(linesA.map(lineKey));
  const added = [];
  for (const line of B.split('\n')) {
    if (!line.trim()) continue;           // B 的空行不搬（A 的空行本来就整段保留）
    const key = lineKey(line);
    if (seen.has(key)) continue;          // 完全相同（容忍 CRLF 的行尾 \r）
    seen.add(key);                        // B 内部的重复行也只加一次
    added.push(line);
  }
  if (!added.length) return A;
  // A 以换行结尾时，split 出来的最后一个空串是「行尾哨兵」，追加要插在它前面，否则会多出一个空行。
  if (endsWithNL) return linesA.slice(0, -1).concat(added, ['']).join('\n');
  return linesA.concat(added).join('\n');
}

/**
 * 合并两侧日记文件。a / b 为 null/undefined 表示该侧没有这个文件。
 * 返回 { text, stats }，stats = { linesA, linesB, linesMerged, addedFromB }。
 */
export function mergeDiaryFile({ a, b } = {}) {
  const A = a === undefined || a === null ? null : String(a);
  const B = b === undefined || b === null ? null : String(b);
  if (A === null && B === null) {
    return { text: '', stats: { linesA: 0, linesB: 0, linesMerged: 0, addedFromB: 0 } };
  }
  if (A === null) {
    const n = countLines(B);
    return { text: B, stats: { linesA: 0, linesB: n, linesMerged: n, addedFromB: n } };
  }
  if (B === null) {
    const n = countLines(A);
    return { text: A, stats: { linesA: n, linesB: 0, linesMerged: n, addedFromB: 0 } };
  }
  const text = mergeDiaryText(A, B);
  const linesA = countLines(A);
  const linesB = countLines(B);
  const linesMerged = countLines(text);
  return { text, stats: { linesA, linesB, linesMerged, addedFromB: linesMerged - linesA } };
}
