// 控制台「群聊黑话 / 网络用语」域路由（src/console/slang.mjs）离线测试。
// 直测 handler：构造假 ctx（不启 HTTP 服务、不碰真实 state/），断言状态码、响应体与副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleSlangRoutes } from '../src/console/slang.mjs';

function makeEnv(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-slang-'));
  const state = {
    entries: [],
    writable: true,
    windows: new Map(),
    cooldowns: new Map(),
    submitTimes: new Map(),
    researching: new Set(),
  };
  const calls = { sent: [], logs: [], saves: 0, queued: [], extracted: [], researched: [], invalidated: 0, atomic: [] };
  const cfg = { slang: { enabled: true, injectMax: 5, autoResearch: false, inferenceThresholds: [2, 4, 8] } };
  const ctx = {
    req: { method: 'GET' },
    url: new URL('http://127.0.0.1/api/slang'),
    sendJson: (body, status = 200) => { calls.sent.push({ body, status }); },
    readBody: async () => ({}),
    log: (line) => { calls.logs.push(line); },
    path,
    ROOT: root,
    cfg,
    readConfigObject: (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}),
    atomicWriteJson: (file, obj) => {
      calls.atomic.push({ file, obj });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    },
    slangStoreWritable: state.writable,
    getSlangEntries: () => state.entries,
    setSlangEntries: (value) => { state.entries = value; },
    slangWindows: state.windows,
    slangExtractionCooldowns: state.cooldowns,
    slangSubmitTimes: state.submitTimes,
    slangResearchingIds: state.researching,
    saveSlangStore: () => { calls.saves += 1; },
    queueSlangTask: (fn) => { calls.queued.push(fn); },
    runSlangExtraction: (key) => { calls.extracted.push(key); return Promise.resolve(); },
    runSlangResearch: (candidates) => { calls.researched.push(candidates); return Promise.resolve(); },
    invalidateSlangLearnerSession: () => { calls.invalidated += 1; },
    ...overrides,
  };
  return { root, state, calls, ctx };
}

function run(ctx, { method = 'GET', pathname = '/api/slang', body = {} } = {}) {
  ctx.req = { method };
  ctx.url = new URL('http://127.0.0.1' + pathname);
  ctx.readBody = async () => body;
  return handleSlangRoutes(ctx);
}

function entry(id, status = 'confirmed', extra = {}) {
  return { id, content: 'yyds', meaning: '永远的神', status, sources: [], evidence: [], ...extra };
}

test('不归本域的路径返回 false 且不写响应', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { pathname: '/api/status' }), false);
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/sessions/reset' }), false);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.logs.length, 0);
});

test('GET /api/slang 返回全部条目与配置，?status= 只筛该状态', async () => {
  const { state, calls, ctx } = makeEnv();
  state.entries = [entry('a', 'confirmed'), entry('b', 'candidate')];
  assert.equal(await run(ctx), true);
  assert.deepEqual(calls.sent[0].body.entries.map((e) => e.id), ['a', 'b']);
  assert.equal(calls.sent[0].body.writable, true);
  assert.equal(calls.sent[0].body.config, ctx.cfg.slang);

  assert.equal(await run(ctx, { pathname: '/api/slang', body: {} , method: 'GET' }), true);
  const filtered = await (async () => {
    ctx.url = new URL('http://127.0.0.1/api/slang?status=candidate');
    calls.sent.length = 0;
    return handleSlangRoutes(ctx);
  })();
  assert.equal(filtered, true);
  assert.deepEqual(calls.sent[0].body.entries.map((e) => e.id), ['b']);
});

test('POST /api/slang 新增条目：空内容 400、重复 400、成功落库并 saveSlangStore', async () => {
  const { state, calls, ctx } = makeEnv();
  state.entries = [entry('a', 'confirmed', { content: '绝了' })];
  assert.equal(await run(ctx, { method: 'POST', body: { content: '  ' } }), true);
  assert.equal(calls.sent.at(-1).status, 400);

  assert.equal(await run(ctx, { method: 'POST', body: { content: '绝了' } }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  assert.match(calls.sent.at(-1).body.error, /已存在/);

  assert.equal(await run(ctx, { method: 'POST', body: { content: '破防了', meaning: '心理防线被击穿' } }), true);
  assert.equal(calls.sent.at(-1).status, 200);
  assert.equal(calls.sent.at(-1).body.ok, true);
  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[1].content, '破防了');
  assert.equal(calls.saves, 1);
  assert.match(calls.logs.at(-1), /新增黑话/);
});

test('POST /api/slang/clear：按状态删、清空全部并复位四个内存态、非法 status 400', async () => {
  const { state, calls, ctx } = makeEnv();
  state.entries = [entry('a', 'confirmed'), entry('b', 'candidate'), entry('c', 'candidate')];
  state.windows.set('k', []);
  state.cooldowns.set('k', 1);
  state.submitTimes.set('k', [1]);
  state.researching.add('b');

  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/clear', body: { status: 'bogus' } }), true);
  assert.equal(calls.sent.at(-1).status, 400);

  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/clear', body: { status: 'candidate' } }), true);
  assert.equal(calls.sent.at(-1).body.removedCount, 2);
  assert.deepEqual(state.entries.map((e) => e.id), ['a']);

  state.entries = [entry('x', 'confirmed'), entry('y', 'candidate')];
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/clear', body: {} }), true);
  assert.equal(calls.sent.at(-1).body.removedCount, 2);
  assert.deepEqual(state.entries, []);
  assert.equal(state.windows.size, 0);
  assert.equal(state.cooldowns.size, 0);
  assert.equal(state.submitTimes.size, 0);
  assert.equal(state.researching.size, 0);
});

test('POST /api/slang/batch-delete：ids 命中删、未命中 404、缺参数 400、按 status 删', async () => {
  const { state, calls, ctx } = makeEnv();
  state.entries = [entry('a'), entry('b'), entry('c', 'candidate')];

  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/batch-delete', body: {} }), true);
  assert.equal(calls.sent.at(-1).status, 400);

  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/batch-delete', body: { ids: ['nope'] } }), true);
  assert.equal(calls.sent.at(-1).status, 404);

  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/batch-delete', body: { ids: ['a'] } }), true);
  assert.equal(calls.sent.at(-1).body.removedCount, 1);
  assert.deepEqual(state.entries.map((e) => e.id), ['b', 'c']);

  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/batch-delete', body: { status: 'candidate' } }), true);
  assert.equal(calls.sent.at(-1).body.removedCount, 1);
  assert.deepEqual(state.entries.map((e) => e.id), ['b']);
});

test('PATCH /api/slang/:id 更新：404、空内容 400、重名 400、成功写回', async () => {
  const { state, calls, ctx } = makeEnv();
  state.entries = [entry('a', 'confirmed', { content: '绝了' }), entry('b', 'confirmed', { content: '破防' })];

  assert.equal(await run(ctx, { method: 'PATCH', pathname: '/api/slang/none', body: {} }), true);
  assert.equal(calls.sent.at(-1).status, 404);

  assert.equal(await run(ctx, { method: 'PATCH', pathname: '/api/slang/a', body: { content: '' } }), true);
  assert.equal(calls.sent.at(-1).status, 400);

  assert.equal(await run(ctx, { method: 'PATCH', pathname: '/api/slang/a', body: { content: '破防' } }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  assert.match(calls.sent.at(-1).body.error, /已存在/);

  assert.equal(await run(ctx, { method: 'PATCH', pathname: '/api/slang/a', body: { meaning: '太强了' } }), true);
  assert.equal(calls.sent.at(-1).body.entry.meaning, '太强了');
  assert.equal(state.entries[0].meaning, '太强了');
  assert.ok(calls.saves >= 1);
});

test('POST /api/slang/:id/confirm 与 /reject：缺含义 400、成功改状态', async () => {
  const { state, calls, ctx } = makeEnv();
  state.entries = [entry('a', 'candidate', { meaning: '' }), entry('b', 'candidate', { meaning: '有含义' })];

  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/a/confirm', body: {} }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  assert.equal(state.entries[0].status, 'candidate');

  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/b/confirm', body: {} }), true);
  assert.equal(state.entries[1].status, 'confirmed');

  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/b/reject', body: {} }), true);
  assert.equal(state.entries[1].status, 'rejected');
});

test('POST /api/slang/extract：关闭时 400、无窗口 400、有窗口排队并优先指定 key', async () => {
  const { state, calls, ctx } = makeEnv();
  ctx.cfg.slang.enabled = false;
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/extract', body: {} }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  assert.equal(calls.queued.length, 0);

  ctx.cfg.slang.enabled = true;
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/extract', body: {} }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  assert.match(calls.sent.at(-1).body.error, /没有可学习消息窗口/);

  state.windows.set('private:1', []);
  state.windows.set('group:2', []);
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/extract', body: { key: 'group:2' } }), true);
  assert.equal(calls.sent.at(-1).body.key, 'group:2');
  assert.equal(calls.queued.length, 1);
});

test('POST /api/slang/config：写 config.json、同步 cfg.slang、preset 变更触发学习会话重置', async () => {
  const { root, calls, ctx } = makeEnv();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ slang: { enabled: true, learnerPreset: 'old' } }), 'utf8');

  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/config', body: { injectMax: 99, inferenceThresholds: '3,1,3' } }), true);
  const sent = calls.sent.at(-1);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.config.injectMax, 30);
  assert.deepEqual(sent.body.config.inferenceThresholds, [1, 3]);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(saved.slang.injectMax, 30);
  assert.equal(calls.invalidated, 0);

  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/slang/config', body: { learnerPreset: 'new-preset' } }), true);
  assert.equal(calls.invalidated, 1);
  assert.equal(ctx.cfg.slang.learnerPreset, 'new-preset');
});
