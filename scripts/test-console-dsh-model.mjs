// 控制台「DSH 模型与思考强度」域路由（src/console/dsh-model.mjs）离线测试。
// 纯函数直测 handler：构造假 ctx（不启 HTTP 服务、不打真实 DSH），断言状态码、响应体与副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDshModelRoutes } from '../src/console/dsh-model.mjs';

const OPTIONS = ['low', 'high', 'max'];
const DEFAULT_EFFORT = 'max';

function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!OPTIONS.includes(v)) throw new Error('思考强度只能是 ' + OPTIONS.join(' / '));
  return v;
}

function makeEnv({ callUnary, cfgPatch } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-model-test-'));
  const calls = { sent: [], logs: [], atomic: [], bumps: 0, unary: [] };
  const cfg = { dsh: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }, ...(cfgPatch ?? {}) };
  const ctx = {
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/dsh/model'),
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
    withTimeout: (promise) => promise,
    unwrap: (value, label) => {
      if (value && typeof value === 'object' && value.ok === false) throw new Error(label + ': ' + (value.error ?? 'failed'));
      return value;
    },
    normalizeReasoningEffort,
    REASONING_EFFORT_OPTIONS: OPTIONS,
    REASONING_EFFORT_DEFAULT: DEFAULT_EFFORT,
    bumpModelSelectionEpoch: () => { calls.bumps += 1; },
  };
  const unary = callUnary ?? (async (method) => { calls.unary.push(method); return {}; });
  const wrapped = async (method, params) => { calls.unary.push(method); return unary(method, params); };
  const handler = createDshModelRoutes({ callUnary: wrapped });
  return { root, ctx, calls, handler };
}

function run(ctx, handler, { method = 'GET', pathname = '/api/dsh/model', body = {} } = {}) {
  ctx.req = { method, headers: {} };
  ctx.url = new URL('http://127.0.0.1' + pathname);
  ctx.readBody = async () => body;
  return handler(ctx);
}

test('不归本域的路径返回 false 且不写响应', async () => {
  const { ctx, calls, handler } = makeEnv();
  assert.equal(await run(ctx, handler, { pathname: '/api/status' }), false);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.logs.length, 0);
});

test('GET /api/dsh/model 用 DSH 公布的档位覆盖内置清单', async () => {
  const catalog = {
    groups: [{
      id: 'deepseek-official',
      models: [{
        id: 'deepseek-flash',
        reasoning: {
          defaultEffort: 'high',
          efforts: [
            { id: 'low', name: '低', description: '快' },
            { id: 'max', name: '最高', description: '深' },
            { id: 'off', name: '关', description: '不用' },   // DSH 有但控制台不提供
          ],
        },
      }],
    }],
  };
  const { ctx, calls, handler } = makeEnv({ callUnary: async () => catalog });
  assert.equal(await run(ctx, handler), true);
  const body = calls.sent[0].body;
  assert.equal(calls.sent[0].status, 200);
  assert.equal(body.catalogSource, 'dsh');
  assert.deepEqual(body.options, ['low', 'max']);          // 'off' 被白名单过滤
  assert.equal(body.providerDefault, 'high');
  assert.equal(body.default, 'max');
  assert.equal(body.reasoningEffort, 'max');
  assert.equal(body.globalSideEffect, true);
  assert.equal(body.labels.max.name, '最高');
  assert.deepEqual(calls.unary, ['session.modelCatalog']);
  assert.equal(calls.logs.length, 0);
});

test('GET /api/dsh/model 目录读取失败 → 回内置清单，同一条原因只记一次日志', async () => {
  const { ctx, calls, handler } = makeEnv({ callUnary: async () => { throw new Error('boom: rpc exploded'); } });
  assert.equal(await run(ctx, handler), true);
  assert.equal(await run(ctx, handler), true);
  const first = calls.sent[0].body;
  assert.equal(first.catalogSource, 'fallback');
  assert.deepEqual(first.options, OPTIONS);
  assert.equal(first.providerDefault, null);
  assert.equal(calls.logs.length, 1);                       // 第二次同原因不再刷日志
  assert.match(calls.logs[0], /读取 DSH 模型能力失败/);
  assert.match(calls.logs[0], /boom: rpc exploded/);
});

test('session/modelCatalog 不存在时回落到 session/models', async () => {
  const catalog = { groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash', reasoning: { efforts: [{ id: 'high', name: '高' }] } }] }] };
  const { ctx, calls, handler } = makeEnv({
    callUnary: async (method) => {
      if (method === 'session.modelCatalog') throw new Error('method not found');
      return catalog;
    },
  });
  assert.equal(await run(ctx, handler), true);
  const body = calls.sent[0].body;
  assert.deepEqual(calls.unary, ['session.modelCatalog', 'session.models']);
  assert.equal(body.catalogSource, 'dsh');
  assert.deepEqual(body.options, ['high']);
});

test('POST /api/dsh/effort 合法值 → 写 config.json、更新 cfg、递增代号', async () => {
  const { root, ctx, calls, handler } = makeEnv();
  assert.equal(await run(ctx, handler, { method: 'POST', pathname: '/api/dsh/effort', body: { reasoningEffort: ' HIGH ' } }), true);
  assert.equal(calls.sent[0].status, 200);
  assert.deepEqual(calls.sent[0].body, { ok: true, reasoningEffort: 'high' });
  assert.equal(calls.atomic.length, 1);
  assert.equal(calls.atomic[0].file, path.join(root, 'config.json'));
  assert.equal(calls.atomic[0].obj.dsh.reasoningEffort, 'high');
  assert.equal(ctx.cfg.dsh.reasoningEffort, 'high');
  assert.equal(calls.bumps, 1);
  assert.match(calls.logs[0], /DSH 思考强度已设为 high/);
});

test('POST /api/dsh/effort 非法值 → 400，不写盘、不递增代号', async () => {
  const { ctx, calls, handler } = makeEnv();
  assert.equal(await run(ctx, handler, { method: 'POST', pathname: '/api/dsh/effort', body: { reasoningEffort: 'ultra' } }), true);
  assert.equal(calls.sent[0].status, 400);
  assert.equal(calls.sent[0].body.ok, false);
  assert.match(calls.sent[0].body.error, /思考强度只能是/);
  assert.equal(calls.atomic.length, 0);
  assert.equal(calls.bumps, 0);
});

test('GET /api/dsh/model 目录里没有当前模型 → 仍是内置清单但不记失败日志', async () => {
  const { ctx, calls, handler } = makeEnv({ callUnary: async () => ({ groups: [{ id: 'another-provider', models: [] }] }) });
  assert.equal(await run(ctx, handler), true);
  const body = calls.sent[0].body;
  assert.equal(body.catalogSource, 'fallback');
  assert.deepEqual(body.options, OPTIONS);
  assert.equal(calls.logs.length, 0);
});
