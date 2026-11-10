#!/usr/bin/env node
// hub —— 统一 App 的后端（方案 M：一台后端 + 多个前端壳）。
//
// 它是「一个账号登录就有全部数据」里的那个「后端」：手机上跑的这条链路（桥 + dsh + QQ）
// 只此一份数据，PC 浏览器 / 手机 PWA / 以后的 Electron 壳都只是客户端。
//
// 为什么单独一个进程、不塞进桥的控制台：
//   1. 桥的控制台能发消息、能起停链路，暴露到局域网风险太大；hub 默认只读。
//   2. 桥挂了也要能看状态 —— hub 自己读文件 + 探端口，不依赖桥活着。
//
// 契约：
//   GET  /healthz            → {ok, version, hasToken}
//   GET  /                   → 单页 App（?token= 或 Authorization 通过后返回）
//   GET  /api/hub/snapshot   → collectSnapshot() 的结果（见 src/hub/snapshot.mjs）
//   POST /api/hub/action     → 受控动作（turbo / level / activity），代理到桥的 /api/socialV2/*
//   其余 404 JSON。
//
// 安全：
//   - 令牌在 <root>/state/hub-token（首次启动自动生成 32 位 hex），请求带 ?token= 或 Authorization: Bearer。
//   - 绑定地址默认 127.0.0.1；要局域网/内网穿透访问必须显式 --host 0.0.0.0（配 Tailscale 用）。
//   - 只读为主；动作白名单写死在 ACTIONS 里，不做「转发任意路径」那种万能代理。

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectSnapshot, HUB_PORTS } from './snapshot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const VERSION = '0.1.0';

function arg(name, env, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const e = process.env[env];
  return e !== undefined && e !== '' ? e : dflt;
}

const PORT = Number(arg('port', 'HUB_PORT', '8800')) || 8800;
const HOST = arg('host', 'HUB_HOST', '127.0.0.1');
const STATE = arg('state', 'HUB_STATE', path.join(ROOT, 'state'));
const DIARY = arg('diary', 'HUB_DIARY', path.join(ROOT, 'diary'));
const TOKEN_FILE = arg('token-file', 'HUB_TOKEN_FILE', path.join(STATE, 'hub-token'));
const BRIDGE = arg('bridge', 'HUB_BRIDGE', 'http://127.0.0.1:3100');

function log(msg) {
  const line = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(path.join(STATE, 'hub.log'), line + '\n');
  } catch {}
}

function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch {}
  const t = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, t + '\n', 'utf8');
  } catch (e) {
    log('写令牌失败：' + (e && e.message ? e.message : e));
  }
  return t;
}

const TOKEN = readToken();

function tokenOk(got) {
  if (!got || typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// 同机直连（127.0.0.1 / ::1）免令牌：手机浏览器开 127.0.0.1:8800 时本来就只有自己能访问，
// 没必要让主人先去文件里抄 32 位令牌。局域网/穿透进来的（remoteAddress 是真实内网 IP）仍然要令牌。
function isLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function needToken(req, url) {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const x = req.headers['x-hub-token'];
  if (typeof x === 'string') return x;
  return url.searchParams.get('token') || '';
}

function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, '127.0.0.1');
  });
}

async function bridgeStatus() {
  try {
    let token = '';
    try {
      token = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
    } catch {}
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(BRIDGE + '/api/status', {
      headers: token ? { 'x-console-token': token } : {},
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 受控动作：只白名单这几个，全部转给桥的 /api/socialV2/*（那里已经有完整的校验与日志）
const ACTIONS = {
  'turbo': { path: '/api/socialV2/turbo' },
  'level': { path: '/api/socialV2/level' },
  'activity': { path: '/api/socialV2/activity' },
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// PWA：手机「添加到主屏幕」后要有一个像 App 的图标与全屏体验。
// manifest / icon 不做令牌校验（浏览器取 manifest 时不带自定义头），里面只有公开的静态内容。
const MANIFEST = JSON.stringify({
  name: '小鲸鱼',
  short_name: '小鲸鱼',
  description: '她的状态、记忆、日记与链路',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0f1117',
  theme_color: '#0f1117',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
  ],
});

const ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">',
  '<rect width="192" height="192" rx="44" fill="#0f1117"/>',
  '<path d="M38 104c0-26 24-44 56-44 30 0 52 16 56 40 3 18-6 32-22 38-8 3-16 4-26 4H74c-22 0-36-14-36-38z" fill="#2f6fd0"/>',
  '<path d="M150 96c14-10 26-8 26-8-4 12-10 20-18 26" fill="#2f6fd0"/>',
  '<circle cx="86" cy="92" r="7" fill="#0f1117"/>',
  '<path d="M64 84c2 6 8 8 14 7" stroke="#8fd0ff" stroke-width="5" stroke-linecap="round" fill="none"/>',
  '<path d="M74 130c10 8 26 8 36 1" stroke="#8fd0ff" stroke-width="5" stroke-linecap="round" fill="none"/>',
  '</svg>',
].join('');

const PAGE = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  } catch (e) {
    log('读页面失败：' + (e && e.message ? e.message : e));
    return '';
  }
})();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/healthz') {
    return send(res, 200, { ok: true, version: VERSION, hasToken: !!TOKEN });
  }

  if (p === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=600' });
    return res.end(MANIFEST);
  }
  if (p === '/icon.svg' || p === '/favicon.svg' || p === '/apple-touch-icon.png') {
    // apple-touch-icon.png 也回 SVG：iOS 不认，但不会报错，Android/桌面用的是上面那张
    res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' });
    return res.end(ICON_SVG);
  }

  const got = needToken(req, url);
  if (!tokenOk(got) && !isLoopback(req)) {
    return send(res, 401, { ok: false, error: '令牌无效：用 ?token=… 或 Authorization: Bearer …' });
  }

  try {
    if (p === '/' || p === '/index.html') {
      if (!PAGE) return send(res, 500, { ok: false, error: '页面文件缺失' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE);
    }
    if (p === '/api/hub/snapshot') {
      const snap = await collectSnapshot({
        root: path.dirname(STATE),
        ports: HUB_PORTS,
        probePort,
        bridgeStatus,
      });
      return send(res, 200, snap);
    }
    if (p === '/api/hub/action' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.action || '');
      const table = ACTIONS[name];
      if (!table) return send(res, 400, { ok: false, error: '不支持的动作：' + name });
      let token = '';
      try {
        token = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
      } catch {}
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      let r;
      try {
        r = await fetch(BRIDGE + table.path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': token },
          body: JSON.stringify(body.body && typeof body.body === 'object' ? body.body : {}),
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await r.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { ok: false, error: text.slice(0, 300) };
      }
      log('动作 ' + name + ' → 桥 ' + r.status);
      return send(res, r.status, payload);
    }
    return send(res, 404, { ok: false, error: '没有这个接口' });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log('处理 ' + p + ' 出错：' + msg);
    return send(res, 500, { ok: false, error: msg });
  }
});

server.listen(PORT, HOST, () => {
  log('hub 已监听 http://' + HOST + ':' + PORT + '  v' + VERSION + '  state=' + STATE);
  if (HOST === '127.0.0.1' || HOST === 'localhost') {
    log('打开：http://127.0.0.1:' + PORT + '/?token=' + TOKEN.slice(0, 8) + '…（完整令牌在 ' + TOKEN_FILE + '）');
  } else {
    log('局域网访问：http://<本机IP>:' + PORT + '/?token=…（令牌在 ' + TOKEN_FILE + '）');
  }
});
