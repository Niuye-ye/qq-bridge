'use strict';
// ────────────────────────────── 桥 HTTP 客户端 ──────────────────────────────
// 2026-10-27 从 pet-electron/main.js:727-766 整块搬出来（交接文档第 4 项，桌宠拆块第一块）。
// 这一块原本是 main.js 里唯一「零 electron 依赖」的部分：fs / net / fetch 而已，
// 所以能原样搬，不需要窗口、菜单、托盘任何东西。
//
// 设计要点（别改回去）：
//   - token 有状态：readToken() 可能被调多次（桥重启后 token 不变，但文件可能后写），
//     所以外部不要缓存读到的值，一律走 client.token。
//   - getJson 的 3.5 秒 AbortSignal 超时是故意的：桥卡住时桌宠要能自己缓过来，不能一起僵住。
//   - probePort 只探 127.0.0.1，不解析 DNS，400ms 拿不到就当没开（链路体检用）。
//   - markQuit / clearQuit 只是退出标记文件，路径由调用方给（main.js 里是 state\pet-quit）。

const fs = require('fs');
const net = require('net');

const p2 = (n) => String(n).padStart(2, '0');

function createBridgeClient(opts) {
  const {
    bridgeUrl,
    tokenFile,
    bridgeCfg,
    log = () => {},
    quitMark,
    timeoutMs = 3500,
  } = opts || {};

  let token = '';

  function readToken() {
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (_) {}
    if (!token) {
      try { token = String(JSON.parse(fs.readFileSync(bridgeCfg, 'utf8')).consoleToken || '').trim(); } catch (_) {}
    }
    log('token', token ? '已读到(' + token.slice(0, 6) + '…)' : '没读到');
    return token;
  }

  /** 2026-10-27 修（审计 P2）：token 只在启动时读一次，桥换了 token（或首次读得太早、
   *  文件后写）之后每个请求都静默 401 —— 界面上只表现为「她一直发呆」，日志里一个字都没有。
   *  现在 401/403 就重读一次 token 再试一遍，还不行就把这一条记进日志（每种路径每分钟最多一条）。 */
  const authWarn = new Map();   // path → 上次记日志的时间戳，防刷屏
  async function getJson(p, opt) {
    const call = (tok) => fetch(bridgeUrl + p, {
      ...(opt || {}),
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'x-console-token': tok, ...((opt && opt.headers) || {}) },
    });
    let r = await call(token);
    if (r.status === 401 || r.status === 403) {
      let body = '';
      try { body = await r.text(); } catch (_) {}
      const old = token;
      readToken();                       // 桥可能重写过 console-token / config.json
      if (token && token !== old) {
        log('桥回 ' + r.status + '，token 变了，重试一次', p);
        r = await call(token);
      }
      if (r.status === 401 || r.status === 403) {
        const last = authWarn.get(p) || 0;
        if (Date.now() - last > 60000) {
          authWarn.set(p, Date.now());
          log('!!! 桥拒绝访问 ' + r.status + ' ' + p + (body ? ' | ' + body.slice(0, 120) : '') + '（token ' + (token ? '非空' : '为空') + '）');
        }
      }
    }
    return r.json();
  }

  async function postJson(p, body) {
    return getJson(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  function probePort(port, timeout = 400) {
    return new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
      s.setTimeout(timeout, () => fin(false));
      s.on('connect', () => fin(true));
      s.on('error', () => fin(false));
    });
  }

  function clock(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  function markQuit() {
    try { fs.writeFileSync(quitMark, String(Date.now())); } catch (_) {}
  }
  function clearQuit() {
    try { fs.unlinkSync(quitMark); } catch (_) {}
  }

  return {
    readToken,
    getJson,
    postJson,
    probePort,
    clock,
    markQuit,
    clearQuit,
    p2,
    get token() { return token; },
  };
}

module.exports = { createBridgeClient, p2 };
