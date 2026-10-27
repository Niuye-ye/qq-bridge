/**
 * 长期记忆（facts）数据层：读写、衰减、归档/翻回、查重、注入行格式化。
 *
 * 2026-10-27 从 bridge.js（原 10591-11142）整块搬出（架构第二步）。
 * 搬出时**一个字没改语义**，只把 `ROOT` 换成入参 `root`，`fs`/`path`/`log`/`atomicWriteJson` 改成依赖注入 ——
 * 这样数据层能离线测（scripts/test-memory-facts.mjs），bridge.js 里那一大坨 ATP 逻辑才看得清。
 *
 * 为什么是工厂而不是顶层函数：两个状态文件路径和 log 都是运行期决定的，模块本身不该知道
 * 仓库根在哪；bridge.js 只负责注入。
 *
 * 契约（改之前先看这几条）：
 *  1. `readFactsV2()` 解析失败**不返回空数组就当没事** —— 切只读、日志一次、之后 `writeFactsV2()` 抛错。
 *     历史事故：写方都以读到的数组为基准整份覆盖，坏一次就把 80 条记忆清空且无日志。
 *  2. 所有落盘走注入的 `atomicWriteJson`（唯一临时名 + rename 重试）。原来 facts-forgotten 用固定 `.tmp`，
 *     并发写会互相踩。
 *  3. `addFactV2` 淘汰一律「全局按 scoreFactV2 升序」，并且**排除刚写入的那条**；全 long 时也照删，文件不会无上限增长。
 *  4. 衰减/复习公式的参数（半衰期、复习间隔、6 小时闸、3 天宽限）全在本文件，别散回 bridge.js。
 */
import fs from 'node:fs';
import path from 'node:path';

export function createFactsStore({ root, log, atomicWriteJson }) {
  if (typeof root !== 'string' || !root) throw new Error('createFactsStore: 缺少 root');
  if (typeof log !== 'function') throw new Error('createFactsStore: 缺少 log');
  if (typeof atomicWriteJson !== 'function') throw new Error('createFactsStore: 缺少 atomicWriteJson');

const FACTS_PATH = path.join(root, 'state', 'facts.json');
const FACTS_FORGOTTEN_PATH = path.join(root, 'state', 'facts-forgotten.json');
const FACTS_TICK_PATH = path.join(root, 'state', 'facts.tick');
const FACTS_MAX = 80;
// 每轮注入的记忆条数。原来是 6+4，实测「【你记得的事】」一段就占 1246 字符/轮；
// 4+2 仍能覆盖画像与近期见闻，长尾让 AI 用 qq_recall 按需翻。
const FACTS_INJECT_LONG = 4;
const FACTS_INJECT_NORMAL = 2;
// 各 kind 的半衰期（天）：见闻掉得最快，约定最耐用。
const FACT_HALF_LIFE_DAYS = { promise: 120, pref: 90, fact: 45, event: 12 };
const FACT_LONG_HALF_LIFE_DAYS = 365;
// 新建记忆的初始强度。
const FACT_INIT_STR = { promise: 0.9, pref: 0.85, fact: 0.55, event: 0.4 };
// 跌破这条线就淡忘（long 永不归档）。
const FACTS_FORGET_BELOW = 0.12;
// long 也有下限：再久也不会低于这个值。
const FACTS_LONG_FLOOR = 0.3;
// 衰减扫描的频率闸，别每轮都写盘。
const FACTS_DECAY_TICK_MS = 20 * 60 * 1000;
const FACTS_FORGOTTEN_MAX = 300;
// 复习（间隔重复）：被想起来一次，就按 FACT_REVIEW_DAYS 排下一次该想起来的间隔。
// 每复习一次半衰期乘 FACT_REVIEW_LIFE_MUL（上限 x4）—— 常想起的事忘得更慢，这才像人的记忆。
const FACT_REVIEW_DAYS = [1, 2, 4, 7, 15, 30, 60];
const FACT_REVIEW_LIFE_MUL = 1.35;
const FACT_REVIEW_LIFE_MUL_MAX = 4;
// 到期该复习的记忆排序加权，不然老记忆永远被新记忆压着、排不到注入位。
const FACT_DUE_BOOST = 1.15;
// 同一条至少隔 6 小时才算一次复习：超活跃模式一分钟一轮，不设闸会被刷爆。
const FACT_REVIEW_MIN_GAP_MS = 6 * 60 * 60 * 1000;
// 约定过期后再给 3 天宽限才归档（她可能还惦记着）。
const FACT_EXPIRE_GRACE_MS = 3 * 86400000;

// 2026-10-27（审计 bridge-core P3，也是 P1 那条的引信）：原来读坏一律 return []，
// 而写入方都以它的返回值为基础整份覆盖 —— 坏一次就把 80 条记忆整体清空，日志一个字没有。
// 现在区分「文件不存在（真没记忆）」和「解析失败（切只读 + 拒绝覆盖）」，
// 写盘换成唯一的原子写（唯一临时名 + rename 重试，绕开 Windows 覆盖正被打开的文件会抛 EPERM）。
let FACTS_READONLY = '';
function readFactsV2() {
  try {
    if (!fs.existsSync(FACTS_PATH)) return [];
    const raw = fs.readFileSync(FACTS_PATH, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return [];
    const o = JSON.parse(raw);
    if (!Array.isArray(o?.facts)) throw new Error('顶层没有 facts 数组');
    FACTS_READONLY = '';
    return o.facts;
  } catch (e) {
    const why = e?.message ?? String(e);
    if (FACTS_READONLY !== why) {
      FACTS_READONLY = why;
      log('[facts] state/facts.json 解析失败，已切成只读、拒绝覆盖：' + why);
    }
    return [];
  }
}

function writeFactsV2(facts) {
  if (FACTS_READONLY) {
    throw new Error('state/facts.json 之前解析失败（' + FACTS_READONLY + '），已切成只读：先备份修好它再写，避免整份覆盖把记忆清空');
  }
  atomicWriteJson(FACTS_PATH, { facts });
}

// 遗忘池：还记得有过这回事，但细节已经想不起来了。不删，随时能被翻回来。
function readForgottenFactsV2() {
  try {
    if (!fs.existsSync(FACTS_FORGOTTEN_PATH)) return [];
    const raw = fs.readFileSync(FACTS_FORGOTTEN_PATH, 'utf8').replace(/^\uFEFF/, '');
    const o = JSON.parse(raw);
    return Array.isArray(o?.facts) ? o.facts : [];
  } catch {
    return [];
  }
}

function writeForgottenFactsV2(list) {
  try {
    const dir = path.dirname(FACTS_FORGOTTEN_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const keep = (Array.isArray(list) ? list : []).slice(-FACTS_FORGOTTEN_MAX);
    atomicWriteJson(FACTS_FORGOTTEN_PATH, { facts: keep });
  } catch (e) {
    log('[facts] 写遗忘池失败：' + (e?.message ?? e));
  }
}

// 半衰期（天）：long 一年，其余看 kind。
function factHalfLifeDaysV2(f) {
  const hl = Number(f?.halfLifeDays);
  const mul = Math.min(FACT_REVIEW_LIFE_MUL_MAX, Math.max(1, Number(f?.lifeMul) || 1));
  let base;
  if (Number.isFinite(hl) && hl > 0) base = hl;
  else if (f?.tier === 'long') base = FACT_LONG_HALF_LIFE_DAYS;
  else base = FACT_HALF_LIFE_DAYS[f?.kind] ?? FACT_HALF_LIFE_DAYS.fact;
  return base * mul;
}

// 约定到期没有：expiresAt 只对「有时间点」的事有意义（周六一起看电影、下周交作业）。
function factExpiredV2(f, now = Date.now()) {
  const t = Date.parse(f?.expiresAt || '');
  if (!Number.isFinite(t)) return false;
  return now > t;
}

// 该复习了？没有 dueAt 的老数据按「创建后一天」算，让它们也能进复习轮转。
function factDueV2(f, now = Date.now()) {
  const t = Date.parse(f?.dueAt || '');
  if (Number.isFinite(t)) return now >= t;
  const at = Date.parse(f?.at || '') || 0;
  return at > 0 && now - at >= 86400000;
}

// 到期时间解析：'2026-11-01' 按当天 23:59:59（本地）算，也接受完整 ISO。
function parseFactExpiresV2(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const parts = s.split('-');
  if (parts.length === 3 && parts[0].length === 4 && parts[1].length === 2 && parts[2].length === 2) {
    const ms = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 23, 59, 59, 999).getTime();
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const ms2 = Date.parse(s);
  return Number.isFinite(ms2) ? new Date(ms2).toISOString() : '';
}

// 基础强度：老数据没有 str，就按 kind/tier 现算一个（不落盘）。
function factBaseStrengthV2(f) {
  const s = Number(f?.str);
  if (Number.isFinite(s) && s > 0) return Math.min(1, s);
  if (f?.tier === 'long') return 1;
  return FACT_INIT_STR[f?.kind] ?? FACT_INIT_STR.fact;
}

// 当前强度 = 基础强度 × 半衰期衰减，起点是上次被想起的时间。
// 每次都从 str 起算而不是逐次连乘，所以重复调用不会越算越淡。
function factStrengthV2(f, now = Date.now()) {
  const base = factBaseStrengthV2(f);
  const anchor = Date.parse(f?.touched || f?.at || '') || now;
  const days = Math.max(0, (now - anchor) / 86400000);
  const decayed = base * Math.pow(0.5, days / factHalfLifeDaysV2(f));
  return f?.tier === 'long' ? Math.max(FACTS_LONG_FLOOR, decayed) : decayed;
}

// 记起一次：先把衰减后的现值定下来，再加增量，touched 推到当下。
function touchFactV2(f, delta = 0, now = Date.now()) {
  if (!f) return false;
  const cur = factStrengthV2(f, now);
  const d = Number(delta);
  f.str = Math.max(0.02, Math.min(1, cur + (Number.isFinite(d) ? d : 0)));
  f.touched = new Date(now).toISOString();
  f.hits = (Number(f.hits) || 0) + 1;
  return true;
}

// 扫一遍：强度跌破阈值的挪进遗忘池（不删）。20 分钟一趟，force 可跳过频率闸。
function archiveFactsV2(force = false) {
  try {
    const now = Date.now();
    if (!force) {
      let last = 0;
      try { last = Number(fs.readFileSync(FACTS_TICK_PATH, 'utf8').trim()) || 0; } catch { last = 0; }
      if (now - last < FACTS_DECAY_TICK_MS) return { archived: 0, skipped: true };
    }
    const facts = readFactsV2();
    try { fs.writeFileSync(FACTS_TICK_PATH, String(now), 'utf8'); } catch {}
    if (!facts.length) return { archived: 0, skipped: false };
    const gone = [];
    const kept = [];
    for (const f of facts) {
      // 兜底：老数据没有 str/touched 的，先把现值钉下来，之后才谈衰减。
      if (!Number.isFinite(Number(f.str)) || !f.touched) {
        const from = new Date(Date.parse(f.at || '') || now).toISOString();
        f.str = factStrengthV2({ ...f, touched: from }, now);
        f.touched = new Date(now).toISOString();
      }
      // 约定过期：宽限期一过就归档，不再当约定提（翻回来会降级成见闻）。
      if (factExpiredV2(f, now)) {
        const exp = Date.parse(f.expiresAt) || now;
        if (now - exp > FACT_EXPIRE_GRACE_MS) {
          f.str = factStrengthV2(f, now);
          f.forgotAt = new Date(now).toISOString();
          f.expiredAt = String(f.expiresAt);
          gone.push(f);
          continue;
        }
      }
      const s = factStrengthV2(f, now);
      if (f.tier !== 'long' && s < FACTS_FORGET_BELOW) {
        f.str = s;
        f.forgotAt = new Date(now).toISOString();
        gone.push(f);
      } else kept.push(f);
    }
    if (gone.length) {
      writeForgottenFactsV2(readForgottenFactsV2().concat(gone));
      writeFactsV2(kept);
      log('[facts] 淡忘了 ' + gone.length + ' 条：' + gone.slice(0, 3).map((f) => String(f.text || '').slice(0, 16)).join(' / '));
    } else {
      writeFactsV2(facts);
    }
    return { archived: gone.length, skipped: false };
  } catch (e) {
    log('[facts] 衰减失败：' + (e?.message ?? e));
    return { archived: 0, skipped: true };
  }
}

// 翻旧账翻到了 = 想起来了：拉回活跃池，强度给到 0.25。
function restoreFactV2(f, now = Date.now()) {
  try {
    if (!f || !f.id) return null;
    const back = { ...f, str: 0.25, touched: new Date(now).toISOString(), hits: (Number(f.hits) || 0) + 1 };
    delete back.forgotAt;
    delete back.deletedAt;
    delete back.deletedBy;
    // 翻回来的是「已经过去的约定」：降级成见闻，别再催她去做一件已经过去的事。
    if (back.expiredAt || factExpiredV2(back, now)) {
      if (back.kind === 'promise') back.kind = 'event';
      delete back.expiresAt;
    }
    delete back.expiredAt;
    back.dueAt = new Date(now + 86400000).toISOString();
    const facts = readFactsV2();
    if (!facts.some((x) => x.id === back.id)) facts.push(back);
    writeFactsV2(facts);
    writeForgottenFactsV2(readForgottenFactsV2().filter((x) => x.id !== back.id));
    log('[facts] 想起来了：' + String(back.text || '').slice(0, 24));
    return back;
  } catch {
    return null;
  }
}

// 分数（排序/淘汰用）：就是当前强度。
function scoreFactV2(f, now = Date.now()) {
  return factStrengthV2(f, now);
}

// —— 同一件事换个说法（2026-10-27）——
// 以前只认「一字不差」，于是「她喜欢在晚上写代码」和「她喜欢晚上写代码」要各记一条，
// 「说好了周六」和「说好周六」也各算一条，80 条上限很快被同一件事的几种写法挤满。
// 这里只认**很保守**的一种重复：去掉标点后，两句话只差「虚词 / 程度副词」——
//   · 长度相同：允许 ≤2 个位置不同，且每个不同的字都落在虚词集里（很↔好、在↔∅ 这种）；
//   · 长度不同：短的必须能在长的上「删掉 ≤2 个虚词」得到。
// 为什么不用相似度（试过大 bigram Jaccard）：中文实测
//   「她喜欢在晚上写代码 / 她喜欢晚上写代码」只有 0.67，
//   「主人今天心情不好 / 主人今天心情不错」却有 0.75 —— 一个阈值分不开「同义」和「反义」，
//   真按相似度合并会把「心情不好」改写成「心情不错」。宁可漏合并，也不能记反。
// 另外三条硬约束：只跟同 kind 比（"明天吃饭"vs"今天吃饭"不是一件事）；event（见闻）永不合并；
// 差的是实词（饭/面、好/错）一律不合并。
// 虚词集：只放「删掉/替换不改变意思」的字。注意 不/没/别 故意不在里面 ——
// 「他很好」和「他不好」只差一个字，但意思正好相反，绝不能当重复合并掉。
const FACT_FILLER = new Set(Array.from('的了着过是在和与我啊吧呢吗嘛呀就都也还挺很太更好又才要将会把被给对从向跟同及或而但地得们一'));
function factNormTextV2(s) {
  return String(s || '').toLowerCase().replace(/[\s，。！？、,.!?~～"'“”‘’（）()【】\[\]…—\-]+/g, '');
}
const factRemoveAtV2 = (s, i) => s.slice(0, i) + s.slice(i + 1);
// 两句话是否只差虚词
function isSameByFillersV2(a, b) {
  const A = factNormTextV2(a);
  const B = factNormTextV2(b);
  if (!A || !B) return false;
  if (A === B) return true;
  if (Math.abs(A.length - B.length) > 2) return false;
  if (A.length === B.length) {
    let diff = 0;
    for (let i = 0; i < A.length; i += 1) {
      if (A[i] === B[i]) continue;
      diff += 1;
      if (diff > 2) return false;
      if (!FACT_FILLER.has(A[i]) || !FACT_FILLER.has(B[i])) return false;
    }
    return true;
  }
  const shorter = A.length < B.length ? A : B;
  const longer = A.length < B.length ? B : A;
  const drop = longer.length - shorter.length;
  const pool = [];
  for (let i = 0; i < longer.length && pool.length <= 8; i += 1) if (FACT_FILLER.has(longer[i])) pool.push(i);
  if (pool.length < drop) return false;
  if (drop === 1) return pool.some((i) => factRemoveAtV2(longer, i) === shorter);
  if (drop === 2) {
    for (let i = 0; i < pool.length; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1) {
        // 先删靠后的下标，再删靠前的，避免下标错位
        const once = factRemoveAtV2(longer, pool[j]);
        if (factRemoveAtV2(once, pool[i]) === shorter) return true;
      }
    }
  }
  return false;
}
function findSameFactV2(facts, text, kind) {
  if (!text || kind === 'event') return null;
  for (const f of facts) {
    const other = String(f.text || '');
    if (!other || other === text) continue;
    if (String(f.kind || '') !== kind) continue;
    if (isSameByFillersV2(other, text)) return f;
  }
  return null;
}

function addFactV2(text, opts = {}) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('text 不能为空');
  const kind = ['fact', 'pref', 'event', 'promise'].includes(opts.kind) ? opts.kind : 'fact';
  const tier = opts.tier === 'long' ? 'long' : 'normal';
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = parseFactExpiresV2(opts.expiresAt);
  const facts = readFactsV2();
  const dup = facts.find((f) => String(f.text || '').trim() === t);
  if (dup) {
    // 又记了一遍同一件事 = 记得更牢（原来这里只更新时间，强度从不涨）。
    dup.kind = kind;
    dup.tier = tier;
    dup.at = now;
    if (expiresAt) dup.expiresAt = expiresAt;
    touchFactV2(dup, 0.4, nowMs);
    writeFactsV2(facts);
    log('[facts] 又记了一遍：' + t.slice(0, 24) + '（强度 ' + Number(dup.str || 0).toFixed(2) + '）');
    return dup;
  }
  // 以前忘了/删过同一句：这次又提起来 = 想起来了，直接从遗忘池捞回，别新建一条。
  const poolHit = readForgottenFactsV2().find((f) => String(f.text || '').trim() === t);
  if (poolHit) {
    const revived = restoreFactV2(poolHit, nowMs);
    if (revived) {
      revived.kind = kind;
      revived.tier = tier;
      if (expiresAt) revived.expiresAt = expiresAt;
      touchFactV2(revived, 0.3, nowMs);
      const all = readFactsV2();
      const i = all.findIndex((x) => x.id === revived.id);
      if (i >= 0) { all[i] = revived; writeFactsV2(all); }
      log('[facts] 从遗忘池捞回来了：' + t.slice(0, 24));
      return revived;
    }
  }
  // 同一件事换个说法（"她喜欢在晚上写代码" vs "她喜欢晚上写代码"）：只算复习，不新增一条。
  const same = findSameFactV2(facts, t, kind);
  if (same) {
    const oldText = String(same.text || '');
    // 保留信息量更大（更长）的那条作为正文
    if (t.length > oldText.length) same.text = t.slice(0, 300);
    same.kind = kind;
    same.tier = tier;
    same.at = now;
    if (expiresAt) same.expiresAt = expiresAt;
    touchFactV2(same, 0.35, nowMs);
    writeFactsV2(facts);
    log('[facts] 同一件事换个说法，只算复习：' + String(same.text || '').slice(0, 24) + '（强度 ' + Number(same.str || 0).toFixed(2) + '）');
    return same;
  }
  const entry = {
    id: 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
    text: t.slice(0, 300),
    kind,
    tier,
    at: now,
    hits: 0,
    str: tier === 'long' ? 1 : (FACT_INIT_STR[kind] ?? FACT_INIT_STR.fact),
    touched: now,
    // 复习状态：rev 复习次数、lifeMul 半衰期倍率、dueAt 下次该想起来的时间。
    rev: 0,
    lifeMul: 1,
    reviewedAt: now,
    dueAt: new Date(nowMs + 86400000).toISOString(),
  };
  if (expiresAt) entry.expiresAt = expiresAt;
  facts.push(entry);
  if (facts.length > FACTS_MAX) {
    // 2026-10-27 修（审计 bridge-core P2）：原来只在 tier !== 'long' 里淘汰 —— 全被 long
    // 占满时一条都删不掉（文件无上限增长），而刚写进去的新条目可能当场被裁掉却仍以
    // 「成功」返回。现在全局按分数排（long 有 FACTS_LONG_FLOOR 兜底，不会先被淘汰），
    // 并显式排除刚写入的那条。
    const overflow = facts.length - FACTS_MAX;
    const victims = facts
      .filter((f) => f.id !== entry.id)
      .sort((a, b) => scoreFactV2(a) - scoreFactV2(b))
      .slice(0, overflow);
    const kill = new Set(victims.map((f) => f.id));
    if (kill.size) log('[facts] 超过上限 ' + FACTS_MAX + '，淘汰 ' + kill.size + ' 条最弱的记忆');
    writeFactsV2(facts.filter((f) => !kill.has(f.id)));
    return entry;
  }
  writeFactsV2(facts);
  return entry;
}

// 删除分两级：第一次是软删（挪进遗忘池，还翻得回来），对池里那条再删才彻底抹掉。
// 说「忘了」不等于没痕迹，但刻意要抹掉就该抹掉 —— 两个都要能表达。
function removeFactV2(ref) {
  const r = String(ref ?? '').trim();
  if (!r) throw new Error('要删哪条？给 id 或原文关键词');
  const hit = (f) => f.id === r || String(f.text || '').trim() === r || String(f.text || '').includes(r);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // 顺序要紧：先看「这次之前就已经软删过」的那些（再删一次 = 彻底抹掉），再软删活跃池的。
  // 反过来的话刚挪进池的条目会立刻被同一次调用抹掉，软删就白做了。
  const poolBefore = readForgottenFactsV2();
  const killed = poolBefore.filter((f) => hit(f) && f.deletedAt);
  let pool = poolBefore;
  if (killed.length) {
    pool = poolBefore.filter((f) => !(hit(f) && f.deletedAt && killed.includes(f)));
    log('[facts] 彻底抹掉 ' + killed.length + ' 条');
  }
  const facts = readFactsV2();
  const soft = facts.filter(hit);
  const kept = facts.filter((f) => !hit(f));
  if (soft.length) {
    for (const f of soft) {
      f.str = factStrengthV2(f, now);
      f.forgotAt = nowIso;
      f.deletedAt = nowIso;
      f.deletedBy = 'forgot';
    }
    writeFactsV2(kept);
    pool = pool.concat(soft);
    log('[facts] 忘了（软删，可恢复）' + soft.length + ' 条：' + soft.slice(0, 3).map((f) => String(f.text || '').slice(0, 16)).join(' / '));
  }
  if (killed.length || soft.length) writeForgottenFactsV2(pool);
  return {
    soft: soft.length,
    hard: killed.length,
    texts: soft.concat(killed).slice(0, 5).map((f) => String(f.text || '').slice(0, 30)),
  };
}

function searchFactsV2(query = '', limit = 20, includeForgotten = true) {
  const now = Date.now();
  archiveFactsV2();
  const q = String(query ?? '').trim().toLowerCase();
  const match = (f) => !q || String(f.text || '').toLowerCase().includes(q);
  const live = readFactsV2().filter(match).map((f) => ({ f, s: factStrengthV2(f, now), forgotten: false, deleted: false }));
  // 只有真的带着关键词去翻，才把遗忘池倒出来 —— 空查询不能把「想不起来的事」全捞上来。
  const dead = (includeForgotten && q)
    ? readForgottenFactsV2().filter(match).map((f) => ({ f, s: 0.02, forgotten: true, deleted: Boolean(f.deletedAt) }))
    : [];
  const rows = live.concat(dead)
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(1, Math.min(60, Number(limit) || 20)));
  const out = [];
  for (const r of rows) {
    const base = { id: r.f.id, text: r.f.text, kind: r.f.kind, tier: r.f.tier, at: r.f.at, hits: r.f.hits ?? 0 };
    if (r.f.expiresAt) base.expiresAt = r.f.expiresAt;
    if (r.forgotten) {
      // 她自己主动删掉的不自动复活：只告诉她「这条你删过」。
      if (r.deleted) { out.push({ ...base, strength: 0, forgotten: true, deleted: true }); continue; }
      if (factExpiredV2(r.f, now)) { out.push({ ...base, strength: 0, forgotten: true, expired: true }); continue; }
      const back = restoreFactV2(r.f, now);
      if (!back) continue;
      out.push({ ...base, hits: back.hits ?? 0, strength: 0.25, forgotten: true });
      continue;
    }
    const row = { ...base, strength: Number(r.s.toFixed(3)), forgotten: false };
    if (factExpiredV2(r.f, now)) row.expired = true;
    out.push(row);
  }
  return out;
}

// 对方提到某件事 = 她想起来了：命中记忆里的连续片段就强化一点。
// 一轮最多 3 条，免得聊天里反复出现同一个词就把所有记忆都刷满。
function reinforceFactsV2(text, maxTouch = 3) {
  try {
    const src = String(text || '').trim();
    if (src.length < 6) return 0;
    const facts = readFactsV2();
    if (!facts.length) return 0;
    const now = Date.now();
    let touched = 0;
    for (const f of facts) {
      if (touched >= maxTouch) break;
      if (factExpiredV2(f, now)) continue;
      const t = String(f.text || '').trim();
      if (t.length < 6) continue;
      const probes = [];
      for (let k = 0; k + 6 <= t.length && probes.length < 5; k += 3) probes.push(t.slice(k, k + 6));
      if (!probes.some((p) => src.includes(p))) continue;
      touchFactV2(f, 0.12, now);
      touched += 1;
    }
    if (touched) writeFactsV2(facts);
    return touched;
  } catch {
    return 0;
  }
}

// 每轮注入：long 取最近 4 条，normal 取强度最高 2 条；到期该复习的加权，别让老记忆永远排不上。
// 注入一次就算「想起一次」：排下一次复习、把半衰期拉长（间隔重复），常想起的忘得更慢。
// 强度低的带「记不太清了」的口气 —— 她说话时自然会含糊，而不是背书。
function formatFactsLineV2() {
  archiveFactsV2();
  const facts = readFactsV2();
  const forgottenCount = readForgottenFactsV2().length;
  if (!facts.length && !forgottenCount) return '';
  const now = Date.now();
  const tagged = facts
    .filter((f) => !factExpiredV2(f, now))
    .map((f) => {
      const s = factStrengthV2(f, now);
      return { f, s, score: s * (factDueV2(f, now) ? FACT_DUE_BOOST : 1) };
    });
  const longs = tagged
    .filter((x) => x.f.tier === 'long')
    .sort((a, b) => (Date.parse(b.f.at || '') || 0) - (Date.parse(a.f.at || '') || 0))
    .slice(0, FACTS_INJECT_LONG);
  const normals = tagged
    .filter((x) => x.f.tier !== 'long')
    .sort((a, b) => b.score - a.score)
    .slice(0, FACTS_INJECT_NORMAL);
  const picked = longs.concat(normals);
  // 复习：到点了、且距上次复习够久，才把间隔往后排并加固（不然一分钟一轮会刷爆）。
  let reviewed = 0;
  for (const x of picked) {
    const f = x.f;
    if (!factDueV2(f, now)) continue;
    const last = Date.parse(f.reviewedAt || '') || 0;
    if (now - last < FACT_REVIEW_MIN_GAP_MS) continue;
    const rev = (Number(f.rev) || 0) + 1;
    f.rev = rev;
    f.reviewedAt = new Date(now).toISOString();
    const days = FACT_REVIEW_DAYS[Math.min(rev, FACT_REVIEW_DAYS.length - 1)];
    f.dueAt = new Date(now + days * 86400000).toISOString();
    f.lifeMul = Math.min(FACT_REVIEW_LIFE_MUL_MAX, Math.round((Number(f.lifeMul) || 1) * FACT_REVIEW_LIFE_MUL * 100) / 100);
    touchFactV2(f, 0.06, now);
    reviewed += 1;
  }
  if (reviewed) writeFactsV2(facts);
  const tag = { pref: '喜好', promise: '约定', event: '见闻', fact: '事实' };
  const fmt = (x) => {
    const f = x.f;
    const days = Math.floor((now - (Date.parse(f.at || '') || now)) / 86400000);
    const when = days <= 0 ? '今天' : (days === 1 ? '昨天' : (days + ' 天前'));
    const blur = x.s >= 0.65 ? '' : (x.s >= 0.35 ? '，记不太清了' : '，只记得个大概');
    const exp = f.expiresAt ? ('，说的是 ' + String(f.expiresAt).slice(0, 10)) : '';
    return '- ' + f.text + '（' + (tag[f.kind] || '事实') + '，' + when + blur + exp + '）';
  };
  const parts = [];
  if (longs.length) parts.push('长期记得的：\n' + longs.map(fmt).join('\n'));
  if (normals.length) parts.push('最近记得的：\n' + normals.map(fmt).join('\n'));
  const tail = forgottenCount
    ? ('\n还有些事已经想不太起来了（大概 ' + forgottenCount + ' 件），真去翻可能翻得到：qq_recall。')
    : '';
  return '【你记得的事】这些是你自己以前记下来的，不是这轮对话里刚出现的；用得上就用，别硬提。'
    + '带「记不太清了」的是快忘掉的，说的时候可以含糊一点。'
    + '想记新东西用 qq_remember，想翻旧的用 qq_recall，记错了用 qq_forget。\n'
    + parts.join('\n') + tail;
}
  return {
    readFactsV2, writeFactsV2, readForgottenFactsV2, writeForgottenFactsV2, factHalfLifeDaysV2, factExpiredV2, factDueV2, parseFactExpiresV2, factBaseStrengthV2, factStrengthV2, touchFactV2, archiveFactsV2, restoreFactV2, scoreFactV2, factNormTextV2, isSameByFillersV2, findSameFactV2, addFactV2, removeFactV2, searchFactsV2, reinforceFactsV2, formatFactsLineV2,
  };
}
