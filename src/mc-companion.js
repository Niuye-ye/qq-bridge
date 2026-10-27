// Minecraft 陪伴：轮询 Numen 模组内置的 MCP 服务端（默认 http://127.0.0.1:8766/mcp），
// 把主人在游戏里说的话（<query>…</query>）交回桥，由桥唤醒小鲸鱼的会话去回话。
//
// 为什么单独一个模块：bridge.js 已经 1.2 万行，轮询器是纯 I/O + 队列，不碰会话状态机，
// 拆出来零风险（同 goals-life.js 的思路）。队列模块级，buildWakePromptV2 直接 take。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const QUEUE = [];          // [{ at, text }]
const MAX_QUEUE = 20;      // 攒太多轮也没意义；20 条 ≈ 主人连说一阵子
let QUEUE_FILE = '';       // 落盘位置（state/mc-queue.json），空 = 只放内存
// 她的状态快照：轮询器顺手抓，桥拼提示词时兜底用（她身体被长任务锁住时唯一的信息源）
let LAST_STATUS = null;
let STATUS_AT = 0;
let LAST_OK_AT = 0;        // 最近一次轮询成功（她在世界里、服务端答话）
let BUSY_SINCE = 0;        // 身体被长任务锁住的起点（0 = 空着）
let STUCK_NOTIFIED_AT = 0; // 上次因为「卡太久」提醒主人的时间
let WATCHER = null;

/** 最近一次抓到的她的状态（血/饱食/位置/离主人多远/背包件数）。没抓到过就是 null。 */
export function mcStatus() {
  if (!LAST_STATUS) return null;
  return { ...LAST_STATUS, at: STATUS_AT, agoMs: Date.now() - STATUS_AT, busyMs: BUSY_SINCE ? Date.now() - BUSY_SINCE : 0 };
}

/** 她身体被长任务锁住多久了（毫秒，0 = 空着）。桌宠/接口用它提示「要按停止」。 */
export function mcBusyMs() {
  return BUSY_SINCE ? Date.now() - BUSY_SINCE : 0;
}

/** 她是不是正活在游戏里（桥用它判断「现在能不能叫她自己玩」）。 */
export function mcAlive(maxAgeMs = 150000) {
  return LAST_OK_AT > 0 && Date.now() - LAST_OK_AT < maxAgeMs;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function saveQueue() {
  if (!QUEUE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(QUEUE.slice(-MAX_QUEUE)), 'utf8');
  } catch { /* 落盘失败不影响投递 */ }
}

function loadQueue() {
  if (!QUEUE_FILE) return 0;
  try {
    const arr = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const it of arr.slice(-MAX_QUEUE)) {
      const text = String(it?.text ?? '').trim();
      if (!text) continue;
      QUEUE.push({ at: Number(it?.at) || Date.now(), text });
      n++;
    }
    if (n > 0 && WATCHER) WATCHER.log(`[mc] 从上次退出时捡回 ${n} 条没送出去的话`);
    return n;
  } catch { return 0; }
}

/** 取走并清空待处理的游戏内消息。 */
export function takeMcMessages() {
  const out = QUEUE.splice(0, QUEUE.length);
  if (out.length) saveQueue();
  return out;
}

/** 只看，不清空（拼提示词时用；真交付成功后再 drop）。 */
export function peekMcMessages() {
  return QUEUE.slice();
}

/** 交付成功后清掉已带过去的那几条。 */
export function dropMcMessages(n) {
  const count = Number(n) > 0 ? Math.min(Number(n), QUEUE.length) : QUEUE.length;
  const out = QUEUE.splice(0, count);
  if (out.length) saveQueue();
  return out;
}

/** 队列里还有多少条没交出去。 */
export function mcQueueSize() {
  return QUEUE.length;
}

/** 停掉轮询（重启/退出时用）。 */
export function stopMcWatcher() {
  if (WATCHER) {
    WATCHER.stopped = true;
    if (WATCHER.timer) clearTimeout(WATCHER.timer);
    WATCHER = null;
  }
}

function pushMessage(text) {
  const now = Date.now();
  const t = String(text ?? '').trim();
  if (!t) return 0;
  // 去重：只跟「队列里最后一条还没送出去」的比，窗口 8 秒。
  // 原来是跟全局 LAST_TEXT 比 20 秒 —— 同一个事件确实会重复上报，但主人在游戏里
  // 连说两句「过来」也会被当成重复吞掉（2026-10-27 审计）。
  const last = QUEUE[QUEUE.length - 1];
  if (last && last.text === t && now - last.at < 8000) return 0;
  QUEUE.push({ at: now, text: t });
  let dropped = 0;
  while (QUEUE.length > MAX_QUEUE) { QUEUE.shift(); dropped++; }
  if (dropped > 0 && WATCHER) WATCHER.log(`[mc] 队列满了，丢掉最早的 ${dropped} 条`);
  saveQueue();
  return 1;
}

function parseBody(raw, ctype) {
  if (String(ctype || '').includes('text/event-stream')) {
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { out.push(JSON.parse(payload)); } catch { /* 忽略坏帧 */ }
    }
    return out.length ? out[out.length - 1] : null;
  }
  const t = String(raw ?? '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function postJson(ctx, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(ctx.url); } catch (e) { reject(new Error(`url 不合法：${ctx.url}`)); return; }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': body.length,
    };
    if (ctx.token) headers.authorization = `Bearer ${ctx.token}`;
    if (ctx.sessionId) headers['mcp-session-id'] = ctx.sessionId;
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers,
    }, (res) => {
      const sid = res.headers['mcp-session-id'];
      if (sid) ctx.sessionId = String(sid);
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} ${raw.slice(0, 160)}`));
          return;
        }
        resolve(parseBody(raw, res.headers['content-type']));
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractText(res) {
  if (!res) throw new Error('空响应');
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error).slice(0, 160));
  const content = res?.result?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => String(c.text ?? '')).join('\n');
}

async function handshake(ctx) {
  await postJson(ctx, {
    jsonrpc: '2.0',
    id: ++ctx.id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'qq-bridge', version: '1.0.0' },
    },
  }, 15000);
  try {
    await postJson(ctx, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, 8000);
  } catch { /* 通知失败不影响后面调用 */ }
  ctx.ready = true;
}

/** 调一个工具，返回拼好的文本（失败抛错）。 */
async function callTool(ctx, name, args, timeoutMs) {
  const res = await postJson(ctx, {
    jsonrpc: '2.0',
    id: ++ctx.id,
    method: 'tools/call',
    params: { name, arguments: args },
  }, timeoutMs);
  return extractText(res);
}

/**
 * 她的身体现在能不能跑新程序？
 * lua 在同一只同伴上是串行的：上一条程序没结束时，新的会直接被拒
 * （"a program is already running for this companion"）。这里用一个空程序探一下，
 * 免得叫醒她、花掉一轮 token，最后只换来这句报错。
 * 探不动（网络抖/服务刚重启）时按「不忙」处理 —— 宁可试一次，也不要把她的消息无限攒着。
 */
async function bodyBusy(ctx) {
  const BUSY_RE = /already running|already in progress|built-in brain/i;
  try {
    // 注意：Numen 把「身体被占」当**正常文本**返回（isError 都不一定置位），
    // 所以不能靠 try/catch 判断，必须看正文（2026-10-27 实测：busyMs 一直是 0 就是这个坑）。
    const text = await callTool(ctx, 'lua', { companion: ctx.companion, code: 'return 1' }, 8000);
    if (BUSY_RE.test(String(text || ''))) {
      BUSY_SINCE ||= Date.now();
      checkStuck(ctx);
      return true;
    }
    BUSY_SINCE = 0;
    return false;
  } catch (e) {
    const m = String(e?.message ?? e);
    const busy = BUSY_RE.test(m);
    if (busy) {
      BUSY_SINCE ||= Date.now();
      checkStuck(ctx);
    }
    return busy;
  }
}

/**
 * 身体卡太久就提醒主人一次。
 * 为什么只能“提醒”：MCP 那 9 个工具里没有停止类工具（list/create/delete_companion、get_events、
 * say、lua、skill、todo、memory），而 lua 又被身体锁挡着 —— 桥这边没有任何手段能自行解开，
 * 只有游戏里提示条上的「停止」（numen.task.stop）或重召同伴能解。所以最多每 30 分钟喊一次。
 */
function checkStuck(ctx) {
  if (!BUSY_SINCE) return;
  const busyMs = Date.now() - BUSY_SINCE;
  const limitMs = Number(ctx?.stuckAfterMs) || 10 * 60 * 1000;
  if (busyMs < limitMs) return;
  const now = Date.now();
  if (now - STUCK_NOTIFIED_AT < 30 * 60 * 1000) return;
  STUCK_NOTIFIED_AT = now;
  try { ctx?.onStuck?.(Math.round(busyMs / 60000)); } catch { /* 提醒失败不影响轮询 */ }
}

/**
 * 抓一份她的状态快照。为什么要：她身体被长任务锁住时，lua 全部被拒（"a program is already
 * running"），她自己看不到主人在哪、血多少；桥这边留一份最近的快照，唤醒时塞进提示词，
 * 至少她还能用 say 说话（say 不受身体锁影响，实测）。
 * 90 秒一次，成本是纯本地一次 lua（不花钱）。
 */
async function sampleStatus(ctx) {
  const code = [
    'local s = numen.status.self()',
    'local ok, o = pcall(numen.status.owner)',
    'if not ok then o = { distance = -1, hp = -1 } end',
    'local inv = 0',
    'local ok2, items = pcall(numen.inv.items)',
    'if ok2 and type(items) == "table" then',
    '  for _, it in ipairs(items) do inv = inv + (it.count or 0) end',
    'end',
    'print(string.format("{\\"x\\":%.1f,\\"y\\":%.1f,\\"z\\":%.1f,\\"hp\\":%.1f,\\"maxHp\\":%.1f,\\"food\\":%.0f,\\"dim\\":\\"%s\\",\\"dist\\":%.1f,\\"ownerHp\\":%.1f,\\"items\\":%d}",',
    '  s.pos.x, s.pos.y, s.pos.z, s.hp, s.max_hp, s.hunger, tostring(s.dimension),',
    '  tonumber(o.distance) or -1, tonumber(o.hp) or -1, inv))',
  ].join('\n');
  try {
    const text = await callTool(ctx, 'lua', { companion: ctx.companion, code }, 15000);
    const raw = String(text || '');
    // 「身体被占」是正常文本返回，不是异常（见 bodyBusy 的注释）
    if (/already running|already in progress|built-in brain/i.test(raw)) {
      BUSY_SINCE ||= Date.now();
      checkStuck(ctx);
      return;
    }
    const m = raw.match(/\{[^{}]*"hp"[^{}]*\}/);
    if (!m) return;
    const s = JSON.parse(m[0]);
    LAST_STATUS = {
      pos: [Number(s.x) || 0, Number(s.y) || 0, Number(s.z) || 0],
      hp: Number(s.hp) || 0,
      maxHp: Number(s.maxHp) || 0,
      food: Number(s.food) || 0,
      dim: String(s.dim || ''),
      dist: Number(s.dist) || -1,
      ownerHp: Number(s.ownerHp) || -1,
      items: Number(s.items) || 0,
    };
    STATUS_AT = Date.now();
    BUSY_SINCE = 0;
  } catch (e) {
    const msg = String(e?.message ?? e);
    // 身体被占不是故障，安静跳过；下次再抓。但记下锁了多久，卡太久会提醒主人。
    if (/already running|already in progress|built-in brain/i.test(msg)) {
      BUSY_SINCE ||= Date.now();
      checkStuck(ctx);
    } else {
      ctx.log(`[mc] 状态快照失败：${msg}`);
    }
  }
}

/**
 * 世界里没有她时自己召唤一个。
 * 为什么需要：Numen 的同伴是**按世界存档**存在世界里的实体，主人换地图 / 开新世界后
 * 她就消失了（面板里也看不到），必须重新 create_companion 才会出现。
 * 注意 create_companion 只认 3~16 位字母、数字、下划线 —— 中文名会被服务端静默忽略
 * （返回仍是一句 "summoning…"，但永远不出现），所以这里先做一次白名单校验。
 */
async function ensureCompanion(ctx) {
  const now = Date.now();
  if (now - ctx.lastRejoinAt < 20000) return false;   // 别把服务端敲爆
  ctx.lastRejoinAt = now;
  if (!/^[A-Za-z0-9_]{3,16}$/.test(ctx.companion)) {
    ctx.log(`[mc] 同伴名 "${ctx.companion}" 不合规（只能 3~16 位字母/数字/下划线），无法自动召唤`);
    return false;
  }
  try {
    const live = await callTool(ctx, 'list_companions', {}, 15000);
    const here = new RegExp(`(^|[^A-Za-z0-9_])${ctx.companion}([^A-Za-z0-9_]|$)`, 'i').test(live);
    if (!looksMissingCompanion(live) && here) return true; // 她已经在世界里了
    ctx.log('[mc] 世界里没有她（换地图/新世界），自动召唤');
    await callTool(ctx, 'create_companion', { name: ctx.companion }, 20000);
    await sleep(3000);
    if (ctx.model) {
      // 新召唤出来的身体是默认皮，顺手把女仆装穿回去（失败不影响陪伴）
      try {
        const code = `local ok, err = pcall(ysm.model.switch, ${JSON.stringify(ctx.model)}); if not ok then print(err.kind, err.message) end`;
        // ysm 换模型要把 .ysm 解包加载，第一次可能十几秒；给足 120 秒（原来 30 秒会 timeout）
        await callTool(ctx, 'lua', { companion: ctx.companion, code }, 120000);
        ctx.log(`[mc] 已把外观换成 ${ctx.model}`);
      } catch (e) {
        const m = String(e?.message ?? e);
        // 她的身体正被别的程序占用（比如上一次换装还没跑完）—— 不是故障，别刷日志
        ctx.log(/already running|already in progress/i.test(m)
          ? '[mc] 换外观跳过：她的身体正忙着跑别的程序'
          : `[mc] 换外观失败：${m}`);
      }
    }
    const after = await callTool(ctx, 'list_companions', {}, 15000);
    if (looksMissingCompanion(after) || !new RegExp(`(^|[^A-Za-z0-9_])${ctx.companion}([^A-Za-z0-9_]|$)`, 'i').test(after)) {
      ctx.log('[mc] 召唤后仍然没有她（检查同伴名与模组版本）');
      return false;
    }
    ctx.log('[mc] 她回来了，继续轮询');
    LAST_OK_AT = Date.now();
    return true;
  } catch (e) {
    ctx.log(`[mc] 自动召唤失败：${e?.message ?? e}`);
    return false;
  }
}

/** 服务端说「这个世界里没有她」的各种说法：
 *  - 新世界/换地图：No companions are live in the world right now…
 *  - 名字不存在：get_events needs a 'companion' argument (a name or id from list_companions)  ← 实测就是这个
 * 两种都必须触发自动召唤，否则轮询会安静地空转（踩过：换地图后一句话都不打，也不召唤）。
 */
const MISSING_COMPANION_RE = /No companions are live|needs a ['"]?companion['"]? argument|no such companion|unknown companion|companion.*not found/i;

function looksMissingCompanion(text) {
  return MISSING_COMPANION_RE.test(String(text ?? ''));
}

async function loop(ctx) {
  while (!ctx.stopped) {
    try {
      if (!ctx.ready) await handshake(ctx);
      // 顺手留一份状态快照（90 秒一次，身体被占时自然跳过）
      if (Date.now() - STATUS_AT > ctx.statusEveryMs) await sampleStatus(ctx);
      const res = await postJson(ctx, {
        jsonrpc: '2.0',
        id: ++ctx.id,
        method: 'tools/call',
        params: { name: 'get_events', arguments: { companion: ctx.companion, wait_seconds: ctx.waitSeconds } },
      }, ctx.waitSeconds * 1000 + 20000);
      if (ctx.fails > 0) {
        ctx.log(`[mc] 连上了（之前失败 ${ctx.fails} 次），继续轮询`);
        ctx.fails = 0;
      }
      const text = extractText(res);
      if (looksMissingCompanion(text)) {
        // 不报错、而是把「没有这个同伴」当正文返回（0.1.4.1 就是这样）
        await ensureCompanion(ctx);
        continue;
      }
      LAST_OK_AT = Date.now();   // 轮询成功 = 她活着（出生点、世界都通）
      if (text) {
        // 只认 <query>…</query>：那是主人在游戏里说的话。
        const re = /<query>([\s\S]*?)<\/query>/g;
        let m;
        let added = 0;
        while ((m = re.exec(text)) !== null) added += pushMessage(m[1]);
        if (added > 0) {
          ctx.log(`[mc] 游戏里收到 ${added} 条消息（队列 ${QUEUE.length}）`);
          const now = Date.now();
          if (now - ctx.lastWakeAt > ctx.cooldownMs) {
            // 先探一下她的身体是不是空着：previous 的 lua 没结束的话，叫醒她也是白花一轮钱
            // （2026-10-27 实测：身体被占时每次唤醒都只换来一句 already running）
            if (await bodyBusy(ctx)) {
              ctx.log('[mc] 她身上还有个程序没结束（游戏内需要点一下「停止」），这几句先攒着');
            } else {
              ctx.lastWakeAt = now;
              try { await ctx.onQuery(); } catch (e) { ctx.log(`[mc] 唤醒失败：${e?.message ?? e}`); }
            }
          } else {
            ctx.log('[mc] 冷却中，攒着下一轮再叫');
          }
        } else if (QUEUE.length > 0 && Date.now() - ctx.lastWakeAt > ctx.cooldownMs) {
          // 攒着的话没人喊她：身体一空出来就把积压的投出去（她去干活时不看新消息，也不会自己醒）
          if (!(await bodyBusy(ctx))) {   // 还占着就下一轮再看，不 return（别把这一轮的清理/退避逻辑一起跳掉）
            ctx.lastWakeAt = Date.now();
            ctx.log(`[mc] 身体空了，把攒着的 ${QUEUE.length} 句话交给她`);
            try { await ctx.onQuery(); } catch (e) { ctx.log(`[mc] 补投失败：${e?.message ?? e}`); }
          }
        }
      }
    } catch (e) {
      ctx.ready = false;
      ctx.fails = (ctx.fails || 0) + 1;
      const msg = String(e?.message ?? e);
      // 换地图 / 开新世界 → 她要重新落地。这不算故障，别走退避、别刷日志。
      if (looksMissingCompanion(msg)) {
        if (await ensureCompanion(ctx)) { ctx.ready = false; continue; }
      }
      // 游戏没开时这条路每 5 秒就 ECONNREFUSED 一次，一天两万行日志没意义。
      // 失败越多等越久（5s→10s→…→60s），只在第 1 次和每 20 次打一行。
      const wait = Math.min(60000, ctx.backoffMs * ctx.fails);
      if (ctx.fails === 1 || ctx.fails % 20 === 0) {
        ctx.log(`[mc] 轮询出错：${e?.message ?? e}（之后每 ${wait}ms 试一次，连上会自动恢复）`);
      }
      if (ctx.stopped) break;
      await sleep(wait);
      continue;
    }
    if (ctx.stopped) break;
    // 队列里还压着话（她当时在忙 → 桥没接）：过一会儿再敲一次门。
    // 不能只靠"下一条消息来了才叫"，主人在游戏里说一句就等回话，不会一直说。
    if (QUEUE.length > 0 && Date.now() - ctx.lastWakeAt > ctx.cooldownMs) {
      ctx.lastWakeAt = Date.now();
      ctx.log(`[mc] 队列还有 ${QUEUE.length} 条没送出去，再叫一次`);
      try { await ctx.onQuery(); } catch (e) { ctx.log(`[mc] 补叫失败：${e?.message ?? e}`); }
    }
    await sleep(400);
  }
}

/**
 * 启动轮询。
 * @param {object} opts
 * @param {string} opts.url         MCP 端点，如 http://127.0.0.1:8766/mcp
 * @param {string} [opts.token]     Bearer 令牌
 * @param {string} opts.companion   同伴名（游戏里 create_companion 的那个）
 * @param {(msg:string)=>void} [opts.log]
 * @param {()=>Promise<void>} opts.onQuery 收到消息时调用（桥里就是唤醒她的会话）
 */
export function startMcWatcher(opts) {
  stopMcWatcher();
  const ctx = {
    url: String(opts.url || 'http://127.0.0.1:8766/mcp'),
    token: String(opts.token || ''),
    companion: String(opts.companion || ''),
    log: typeof opts.log === 'function' ? opts.log : () => {},
    onQuery: typeof opts.onQuery === 'function' ? opts.onQuery : async () => {},
    sessionId: '',
    id: 0,
    ready: false,
    stopped: false,
    timer: null,
    waitSeconds: Math.max(5, Math.min(55, Number(opts.waitSeconds) || 25)),
    cooldownMs: Math.max(0, Number(opts.cooldownMs) || 15000),
    backoffMs: Math.max(1000, Number(opts.backoffMs) || 5000),
    model: String(opts.model || ''),        // 召唤后要穿的外观（YSM 模型 id），空 = 不动
    lastRejoinAt: 0,
    lastWakeAt: 0,
    fails: 0,
    statusEveryMs: Math.max(30000, Number(opts.statusEveryMs) || 90000),
  };
  QUEUE_FILE = String(opts.queueFile || '');
  if (!ctx.companion) {
    ctx.log('[mc] 没配置同伴名（socialV2.mc.companion），轮询不启动');
    return null;
  }
  WATCHER = ctx;
  loadQueue();
  ctx.log(`[mc] 开始轮询 ${ctx.url}（同伴 ${ctx.companion}，每次等 ${ctx.waitSeconds} 秒）`);
  // unref 掉，别因为它在长轮询就拖住进程退出
  const t = setTimeout(() => { void loop(ctx); }, 1000);
  ctx.timer = t;
  if (typeof t.unref === 'function') t.unref();
  return ctx;
}
