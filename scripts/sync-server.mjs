#!/usr/bin/env node
// sync-server.mjs —— PC 侧「记忆/日记 同步合并」端点（只给手机经 adb reverse 访问）
//
// 为什么这样设计：
// - 合并语义只写一遍（src/sync-merge.mjs），手机端不重复实现，避免两边规则漂移；
// - 服务只监听 127.0.0.1，手机通过 `adb reverse tcp:8799 tcp:8799` 走 adb 隧道够到它，
//   **不开局域网端口**（少一个暴露面），PC 不在线时手机侧自然失败，语义清晰；
// - 设备地址默认现找（--dev auto）：手机走 DHCP，IP 换过一次（172.27.88.60 → 172.26.145.12），
//   写死的结果是 adb reverse 永远失败、同步静默变单向；
// - 每次请求都是「手机传自己的、PC 传自己的 → 合并 → 两边各自落地」，所以谁先谁后都不会丢。
//
// 用法：
//   node scripts/sync-server.mjs --root F:/qq-bridge/state --diary F:/qq-bridge/diary \
//        --token-file C:/dsh/state/sync-token --port 8799 [--adb C:/dsh/phone/platform-tools/adb.exe --dev auto]
//
// 落盘容器：facts.json / facts-forgotten.json 都是 { facts: [...] }（memory-facts.mjs 的 readFactsV2 读的就是这个键），
// 不能写裸数组 —— 写裸数组桥会读成空、等于把记忆清掉。
//
// 环境变量等价：SYNC_ROOT / SYNC_DIARY / SYNC_TOKEN_FILE / SYNC_PORT / SYNC_ADB / SYNC_DEV

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { mergeFactsState, mergeForgottenState, mergeDiaryText } from '../src/sync-merge.mjs';

function arg(name, env, def = '') {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[env] || def;
}

const STATE = arg('state', 'SYNC_STATE');         // PC 的 qq-bridge/state
const ROOT = STATE;                              // 兼容旧参数名
const DIARY = arg('diary', 'SYNC_DIARY');         // PC 的 qq-bridge/diary
const TOKEN_FILE = arg('token-file', 'SYNC_TOKEN_FILE');
const PORT = Number(arg('port', 'SYNC_PORT', '8799'));
const ADB = arg('adb', 'SYNC_ADB');
// 设备序列号：默认 'auto' = 每次现找（手机走 DHCP，IP 会变：172.27.88.60 → 172.26.145.12 实测）。
// 显式传 --dev 1.2.3.4:5555 则固定用它。
let DEV = arg('dev', 'SYNC_DEV');
const DEV_AUTO = !DEV || DEV === 'auto';
if (DEV_AUTO) DEV = '';
const VERSION = '1.0.0';

if (!STATE || !DIARY || !TOKEN_FILE) {
  console.error('缺参数：--state / --diary / --token-file');
  process.exit(2);
}

function log(s) {
  const line = '[' + new Date().toISOString() + '] ' + s;
  console.log(line);
  try { fs.appendFileSync(path.join(path.dirname(TOKEN_FILE), 'sync-server.log'), line + '\n'); } catch {}
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

// 历史事故形态：facts.json 曾被写成裸数组（readFactsV2 会读成空）。同步时按容器等价读出来，
// 写回时统一成 {facts:[...]} —— 相当于顺手把坏文件救回来，而不是把它当「没有记忆」丢掉。
function unwrapFacts(o) {
  if (Array.isArray(o)) return { facts: o };
  return o;
}

function readToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

function tokenOk(got) {
  const want = readToken();
  if (!want || !got) return false;
  const a = Buffer.from(String(got)); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 日记的「键」是文件名。手机传上来的键可能是 2026-11-10 也可能带 .md，
// 统一成 <日期>.md；不匹配的一律忽略 —— 这是防路径穿越的唯一一道闸（写盘直接用这个键）。
function canonDiaryName(k) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:\.md)?$/.exec(String(k || '').trim());
  return m ? m[1] + '.md' : '';
}

function readDiaryDir() {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(DIARY); } catch { return out; }
  for (const n of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(n)) continue;
    try { out.set(n, fs.readFileSync(path.join(DIARY, n), 'utf8')); } catch {}
  }
  return out;
}

/** 一次同步：手机发来的 + PC 本地的 → 合并 → 两边都是合并结果。 */
function doSync(body) {
  const localFacts = unwrapFacts(readJson(path.join(STATE, 'facts.json')));
  const localForgotten = unwrapFacts(readJson(path.join(STATE, 'facts-forgotten.json')));
  const facts = mergeFactsState(localFacts, body.facts ?? null);
  const forgotten = mergeForgottenState(localForgotten, body.forgotten ?? null);

  const localDiary = readDiaryDir();
  const rawDiary = body.diary && typeof body.diary === 'object' ? body.diary : {};
  const remoteDiary = {};
  for (const [k, v] of Object.entries(rawDiary)) {
    const name = canonDiaryName(k);
    if (name && typeof v === 'string') remoteDiary[name] = v;
  }
  const dates = [...new Set([...localDiary.keys(), ...Object.keys(remoteDiary)])].sort();
  const diary = {};
  for (const n of dates) {
    const a = localDiary.get(n) ?? null;
    const b = typeof remoteDiary[n] === 'string' ? remoteDiary[n] : null;
    diary[n] = a == null ? (b ?? '') : b == null ? a : mergeDiaryText(a, b);
  }

  // 落地到 PC（先写内容，最后写状态；中途失败也不会写半个 merge 结果）
  atomicWrite(path.join(STATE, 'facts.json'), JSON.stringify({ facts: facts.merged }, null, 2) + '\n');
  atomicWrite(path.join(STATE, 'facts-forgotten.json'), JSON.stringify({ facts: forgotten.merged }, null, 2) + '\n');
  fs.mkdirSync(DIARY, { recursive: true });
  for (const [n, text] of Object.entries(diary)) atomicWrite(path.join(DIARY, n), text);

  const at = new Date().toISOString();
  const stats = { at, by: String(body.by || 'phone'), facts: facts.stats, forgotten: forgotten.stats };
  atomicWrite(path.join(STATE, 'sync-state.json'), JSON.stringify(stats, null, 2) + '\n');
  // 返回给手机的是**文件级容器**，手机端直接落盘即可（不用自己包一层）
  return { ok: true, at, stats, facts: { facts: facts.merged }, forgotten: { facts: forgotten.merged }, diary };
}

const DEV_CACHE = path.join(path.dirname(TOKEN_FILE), 'phone-dev.txt');

function execOut(file, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}
async function deviceReady(serial) {
  if (!serial) return false;
  return (await execOut(ADB, ['-s', serial, 'get-state'])).trim() === 'device';
}
function writeDevCache(s) { try { atomicWrite(DEV_CACHE, s + '\n'); } catch {} }

/** 找设备：缓存 → adb devices → mdns 广播。找不到返回空串，60 秒后再来一轮（不阻塞服务）。 */
async function discoverDev() {
  if (DEV) return DEV;
  let cached = '';
  try { cached = fs.readFileSync(DEV_CACHE, 'utf8').trim(); } catch {}
  if (cached && await deviceReady(cached)) { DEV = cached; log('设备（缓存）：' + DEV); return DEV; }
  const online = [];
  for (const line of (await execOut(ADB, ['devices'])).split(/\r?\n/).slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state === 'device') online.push(serial);
  }
  const pick = online.find((s) => /^[\d.]+:\d+$/.test(s) && !s.startsWith('127.0.0.1:'))
    || online.find((s) => !s.startsWith('emulator-') && !s.startsWith('127.0.0.1:'))
    || online[0];
  if (pick) { DEV = pick; writeDevCache(pick); log('设备（adb devices）：' + pick); return DEV; }
  const cands = [];
  for (const line of (await execOut(ADB, ['mdns', 'services'])).split(/\r?\n/)) {
    const m = line.match(/_adb\._tcp\s+([\d.]+:\d+)/);
    if (m) cands.push(m[1]);
  }
  for (const addr of cands) {
    await execOut(ADB, ['connect', addr]);
    if (await deviceReady(addr)) { DEV = addr; writeDevCache(addr); log('设备（mdns）：' + addr); return DEV; }
  }
  log('还没找到手机（adb devices 与 mdns 都是空的），60 秒后再找');
  return '';
}

async function reverseLoop() {
  if (!ADB) return;
  const tick = async () => {
    const dev = await discoverDev();
    if (!dev) return;
    execFile(ADB, ['-s', dev, 'reverse', 'tcp:' + PORT, 'tcp:' + PORT], { timeout: 15000 }, (err) => {
      if (err) {
        log('adb reverse 失败：' + String(err.message || err).split('\n')[0]);
        if (DEV_AUTO) DEV = '';   // 掉线了别死守旧地址，下一轮重新找
      }
    });
  };
  await tick();
  setInterval(() => { void tick(); }, 60000).unref?.();
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body 太大')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const send = (code, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(b) });
    res.end(b);
  };
  try {
    if (url.pathname === '/healthz') return send(200, { ok: true, version: VERSION, hasToken: !!readToken() });
    if (url.pathname === '/status' && req.method === 'GET') {
      return send(200, { ok: true, version: VERSION, last: readJson(path.join(STATE, 'sync-state.json')) });
    }
    if (url.pathname === '/sync' && req.method === 'POST') {
      if (!tokenOk(req.headers['x-sync-token'])) return send(401, { ok: false, error: '同步令牌不对' });
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { ok: false, error: 'body 不是 JSON' }); }
      const out = doSync(body);
      log('同步完成（来源 ' + out.stats.by + '）：facts ' + out.stats.facts.mergedCount + ' 条，日记 ' + Object.keys(out.diary).length + ' 天');
      return send(200, out);
    }
    send(404, { ok: false, error: '404' });
  } catch (e) {
    log('处理 ' + url.pathname + ' 出错：' + (e && e.stack ? e.stack : e));
    try { send(500, { ok: false, error: '服务端错误' }); } catch {}
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') { log(PORT + ' 已被占用，退出'); process.exit(1); }
  log('监听失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log('sync-server 已监听 127.0.0.1:' + PORT + '  v' + VERSION + '  state=' + STATE);
  reverseLoop();
});
