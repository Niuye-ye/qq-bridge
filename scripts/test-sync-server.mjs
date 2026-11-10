// sync-server.mjs 的离线集成测试：真起服务（临时目录 / 随机端口），打一次 /sync 看落盘。
// 为什么要集成测：这个服务的坑几乎都在「文件容器」上（facts.json 必须是 {facts:[...]}，
// 写裸数组桥会读成空 = 把记忆清掉），单测合并函数是查不出来的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'scripts', 'sync-server.mjs');
const TOKEN = 'test-token-0123456789';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function mkdirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncsrv-'));
  const state = path.join(root, 'state');
  const diary = path.join(root, 'diary');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(diary, { recursive: true });
  const tokenFile = path.join(root, 'sync-token');
  fs.writeFileSync(tokenFile, TOKEN + '\n');
  return { root, state, diary, tokenFile };
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverPath, '--state', env.state, '--diary', env.diary, '--token-file', env.tokenFile, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/healthz');
      if (r.ok) return { child, port, getLog: () => out };
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill('SIGKILL');
  throw new Error('服务没起来：' + out);
}

const fact = (id, text) => ({ id, text, kind: 'fact', tier: 'normal', at: '2026-11-01T00:00:00.000Z', hits: 1, str: 1, touched: '2026-11-01T00:00:00.000Z' });

test('第一 次同步：手机侧的事实并进 PC，落盘是 {facts:[...]} 容器而不是裸数组', async () => {
  const env = mkdirs();
  fs.writeFileSync(path.join(env.state, 'facts.json'), JSON.stringify({ facts: [fact('a1', 'PC 记得的')] }, null, 2));
  fs.writeFileSync(path.join(env.diary, '2026-11-09.md'), '# 11-09\nPC 这一天的日记\n');
  const s = await startServer(env);
  try {
    const r = await fetch('http://127.0.0.1:' + s.port + '/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-token': TOKEN },
      body: JSON.stringify({ by: 'phone', facts: { facts: [fact('b1', '手机记得的')] }, diary: { '2026-11-10': '# 11-10\n手机写的\n' } }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.facts.facts.map((f) => f.id).sort(), ['a1', 'b1']);
    assert.ok(body.diary['2026-11-10.md'].includes('手机写的'), '返回的键统一成 <日期>.md');

    const pcFacts = JSON.parse(fs.readFileSync(path.join(env.state, 'facts.json'), 'utf8'));
    assert.ok(Array.isArray(pcFacts.facts), 'PC 落盘必须是 {facts:[...]}');
    assert.equal(pcFacts.facts.length, 2);
    const pcForgotten = JSON.parse(fs.readFileSync(path.join(env.state, 'facts-forgotten.json'), 'utf8'));
    assert.ok(Array.isArray(pcForgotten.facts), '遗忘池也是容器');
    assert.ok(fs.existsSync(path.join(env.diary, '2026-11-10.md')), '键不带 .md 也要落成 <日期>.md');
    assert.ok(JSON.parse(fs.readFileSync(path.join(env.state, 'sync-state.json'), 'utf8')).at);
  } finally { s.child.kill('SIGKILL'); }
});

test('第二次同步是幂等的：同一份数据再来一次，条数不变、两侧内容按字节一致', async () => {
  const env = mkdirs();
  const s = await startServer(env);
  try {
    const payload = { by: 'phone', facts: { facts: [fact('x1', '同一条')] }, forgotten: null, diary: { '2026-11-10': '甲\n' } };
    const once = await (await fetch('http://127.0.0.1:' + s.port + '/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-token': TOKEN }, body: JSON.stringify(payload) })).json();
    const first = fs.readFileSync(path.join(env.state, 'facts.json'), 'utf8');
    const twice = await (await fetch('http://127.0.0.1:' + s.port + '/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-token': TOKEN }, body: JSON.stringify({ ...payload, facts: once.facts }) })).json();
    assert.equal(twice.stats.facts.mergedCount, 1);
    assert.equal(twice.stats.facts.onlyB, 0);
    assert.equal(fs.readFileSync(path.join(env.state, 'facts.json'), 'utf8'), first, '第二次写盘不该改字节');
  } finally { s.child.kill('SIGKILL'); }
});

test('令牌不对 → 401，且一个字节都不写', async () => {
  const env = mkdirs();
  const s = await startServer(env);
  try {
    const r = await fetch('http://127.0.0.1:' + s.port + '/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-token': 'wrong' },
      body: JSON.stringify({ facts: { facts: [fact('z1', '不该落地')] } }),
    });
    assert.equal(r.status, 401);
    assert.equal(fs.existsSync(path.join(env.state, 'facts.json')), false);
  } finally { s.child.kill('SIGKILL'); }
});

test('容器坏掉（裸数组）时不崩：按容器等价读出来并顺手修好，返回 200 而不是 500', async () => {
  const env = mkdirs();
  fs.writeFileSync(path.join(env.state, 'facts.json'), JSON.stringify([fact('bare', '裸数组')])); // 历史事故形态
  const s = await startServer(env);
  try {
    const r = await fetch('http://127.0.0.1:' + s.port + '/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-token': TOKEN },
      body: JSON.stringify({ by: 'phone', facts: { facts: [fact('p1', '手机的')] } }),
    });
    assert.equal(r.status, 200);
    const pcFacts = JSON.parse(fs.readFileSync(path.join(env.state, 'facts.json'), 'utf8'));
    assert.ok(Array.isArray(pcFacts.facts));
    // 裸数组里的老数据被当容器读出来一起参与合并 —— 数据不丢，写回时统一成容器
    assert.equal(pcFacts.facts.length, 2);
    assert.deepEqual(pcFacts.facts.map((f) => f.id).sort(), ['bare', 'p1']);
  } finally { s.child.kill('SIGKILL'); }
});

test('日记键不是 <日期>.md 的一律忽略（防路径穿越），合法键照写', async () => {
  const env = mkdirs();
  const s = await startServer(env);
  try {
    const r = await fetch('http://127.0.0.1:' + s.port + '/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-token': TOKEN },
      body: JSON.stringify({ by: 'phone', facts: { facts: [] }, diary: { '../../evil.md': 'x', '2026-11-10': '合法' } }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(Object.keys(body.diary), ['2026-11-10.md']);
    assert.equal(fs.existsSync(path.join(env.root, '..', 'evil.md')), false);
  } finally { s.child.kill('SIGKILL'); }
});
