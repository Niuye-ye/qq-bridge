// Minecraft 陪伴：轮询 Numen 模组内置的 MCP 服务端（默认 http://127.0.0.1:8766/mcp），
// 把主人在游戏里说的话（<query>…</query>）交回桥，由桥唤醒小鲸鱼的会话去回话。
//
// 为什么单独一个模块：bridge.js 已经 1.2 万行，轮询器是纯 I/O + 队列，不碰会话状态机，
// 拆出来零风险（同 goals-life.js 的思路）。队列模块级，buildWakePromptV2 直接 take。
import http from 'node:http';

const QUEUE = [];          // [{ at, text }]
const MAX_QUEUE = 8;       // 攒太多轮也没意义，主人早就不等了
let LAST_TEXT = '';        // 去重：同一条事件可能在下一次 get_events 里重复出现
let LAST_AT = 0;
let WATCHER = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 取走并清空待处理的游戏内消息。 */
export function takeMcMessages() {
  return QUEUE.splice(0, QUEUE.length);
}

/** 只看，不清空（拼提示词时用；真交付成功后再 drop）。 */
export function peekMcMessages() {
  return QUEUE.slice();
}

/** 交付成功后清掉已带过去的那几条。 */
export function dropMcMessages(n) {
  const count = Number(n) > 0 ? Math.min(Number(n), QUEUE.length) : QUEUE.length;
  return QUEUE.splice(0, count);
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
  if (t === LAST_TEXT && now - LAST_AT < 20000) return 0; // 同一个事件重复上报
  LAST_TEXT = t;
  LAST_AT = now;
  QUEUE.push({ at: now, text: t });
  while (QUEUE.length > MAX_QUEUE) QUEUE.shift();
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

async function loop(ctx) {
  while (!ctx.stopped) {
    try {
      if (!ctx.ready) await handshake(ctx);
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
            ctx.lastWakeAt = now;
            try { await ctx.onQuery(); } catch (e) { ctx.log(`[mc] 唤醒失败：${e?.message ?? e}`); }
          } else {
            ctx.log('[mc] 冷却中，攒着下一轮再叫');
          }
        }
      }
    } catch (e) {
      ctx.ready = false;
      ctx.fails = (ctx.fails || 0) + 1;
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
    lastWakeAt: 0,
    fails: 0,
  };
  if (!ctx.companion) {
    ctx.log('[mc] 没配置同伴名（socialV2.mc.companion），轮询不启动');
    return null;
  }
  WATCHER = ctx;
  ctx.log(`[mc] 开始轮询 ${ctx.url}（同伴 ${ctx.companion}，每次等 ${ctx.waitSeconds} 秒）`);
  // unref 掉，别因为它在长轮询就拖住进程退出
  const t = setTimeout(() => { void loop(ctx); }, 1000);
  ctx.timer = t;
  if (typeof t.unref === 'function') t.unref();
  return ctx;
}
