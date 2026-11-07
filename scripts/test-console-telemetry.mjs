// src/console/telemetry.mjs 的离线测试（架构第 11 项：startConsoleServer 按域切分的守门测试）。
//
// 这一层是纯函数：ctx 全部由调用方注入，不起 HTTP 服务、不读真实 state。
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTelemetryRoutes } from '../src/console/telemetry.mjs';

function makeCtx({ method = 'GET', pathname = '/', query = {}, headers = {}, fsImpl = null } = {}) {
  const url = new URL('http://127.0.0.1:3100' + pathname);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const sent = [];
  const logs = [];
  const calls = { reset: 0, summaryLimits: [], seriesArgs: [], conversation: [], recent: [], toolLogLimits: [], writes: [] };
  const tokenLedger = {
    summary: ({ limit } = {}) => { calls.summaryLimits.push(limit); return { ok: true, rows: [] }; },
    stats: () => ({ totalTokens: 42 }),
    series: (args) => { calls.seriesArgs.push(args); return { ok: true, buckets: [] }; },
    conversation: (key, args) => { calls.conversation.push([key, args]); return key === 'known' ? { ok: true, turns: [] } : null; },
    recent: (limit) => { calls.recent.push(limit); return []; },
    reset: () => { calls.reset += 1; }
  };
  const ctx = {
    req: { method, headers },
    url,
    sendJson: (obj, status = 200) => sent.push({ obj, status }),
    log: (m) => logs.push(String(m)),
    fs: fsImpl ?? { writeFileSync: (...args) => calls.writes.push(args) },
    tokenLedger,
    priceTable: { symbol: '$' },
    readToolLog: (limit) => { calls.toolLogLimits.push(limit); return [{ limit }]; },
    toolLogFile: '/tmp/tool-calls.jsonl'
  };
  return { ctx, sent, logs, calls };
}

test('不认识的路径 → 返回 false，不写响应', () => {
  const { ctx, sent } = makeCtx({ pathname: '/api/status' });
  assert.equal(handleTelemetryRoutes(ctx), false);
  assert.equal(sent.length, 0);
});

test('/api/tokens/* 带 agent token 一律 403（跨群花费不给 AI 看）', () => {
  const { ctx, sent } = makeCtx({ pathname: '/api/tokens/summary', headers: { 'x-agent-token': 'abc' } });
  assert.equal(handleTelemetryRoutes(ctx), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 403);
  assert.equal(sent[0].obj.error, '该接口仅控制台可用');
});

test('summary 的 limit 被夹在 1..500，并带上 ledger.stats()', () => {
  const { ctx, sent, calls } = makeCtx({ pathname: '/api/tokens/summary', query: { limit: 9999 } });
  assert.equal(handleTelemetryRoutes(ctx), true);
  assert.equal(calls.summaryLimits.at(-1), 500);
  assert.equal(sent[0].status, 200);
  assert.deepEqual(sent[0].obj.ledger, { totalTokens: 42 });
});

test('series 的 hours/buckets 被夹紧', () => {
  const { ctx, calls } = makeCtx({ pathname: '/api/tokens/series', query: { hours: 99999, buckets: 1 } });
  assert.equal(handleTelemetryRoutes(ctx), true);
  assert.equal(calls.seriesArgs.at(-1).hours, 24 * 90);
  assert.equal(calls.seriesArgs.at(-1).maxBuckets, 6);
});

test('turns 查不到会话 → 404；查到就原样返回', () => {
  let r = makeCtx({ pathname: '/api/tokens/turns', query: { key: 'missing' } });
  assert.equal(handleTelemetryRoutes(r.ctx), true);
  assert.equal(r.sent[0].status, 404);

  r = makeCtx({ pathname: '/api/tokens/turns', query: { key: 'known', limit: 5 } });
  assert.equal(handleTelemetryRoutes(r.ctx), true);
  assert.equal(r.sent[0].status, 200);
  assert.equal(r.calls.conversation.at(-1)[0], 'known');
  assert.equal(r.calls.conversation.at(-1)[1].turnLimit, 5);
});

test('未知的 /api/tokens/xxx → 404 收尾（不落到后面的路由）', () => {
  const { ctx, sent } = makeCtx({ pathname: '/api/tokens/whatever' });
  assert.equal(handleTelemetryRoutes(ctx), true);
  assert.equal(sent[0].status, 404);
  assert.equal(sent[0].obj.error, 'not found');
});

test('POST /api/tokens/reset 会重置账本并写日志', () => {
  const { ctx, sent, logs, calls } = makeCtx({ method: 'POST', pathname: '/api/tokens/reset' });
  assert.equal(handleTelemetryRoutes(ctx), true);
  assert.equal(calls.reset, 1);
  assert.match(logs.at(-1), /token 用量账本已重置/);
  assert.deepEqual(sent[0].obj, { ok: true });
});

test('GET tool-log 透传 limit', () => {
  const { ctx, sent, calls } = makeCtx({ pathname: '/api/socialV2/tool-log', query: { limit: 7 } });
  assert.equal(handleTelemetryRoutes(ctx), true);
  assert.equal(calls.toolLogLimits.at(-1), 7);
  assert.deepEqual(sent[0].obj, { ok: true, entries: [{ limit: 7 }] });
});

test('清空 tool-log：带 agent token 拒绝，不带才落盘', () => {
  let r = makeCtx({ method: 'POST', pathname: '/api/socialV2/tool-log/clear', headers: { 'x-agent-token': 'abc' } });
  assert.equal(handleTelemetryRoutes(r.ctx), true);
  assert.equal(r.sent[0].status, 403);
  assert.equal(r.calls.writes.length, 0);

  r = makeCtx({ method: 'POST', pathname: '/api/socialV2/tool-log/clear' });
  assert.equal(handleTelemetryRoutes(r.ctx), true);
  assert.deepEqual(r.calls.writes.at(-1), ['/tmp/tool-calls.jsonl', '', 'utf8']);
  assert.match(r.logs.at(-1), /工具调用日志已清空/);
  assert.deepEqual(r.sent[0].obj, { ok: true });
});

test('清空时写盘抛错也不影响响应（原文 try/catch 吞掉）', () => {
  const r = makeCtx({
    method: 'POST',
    pathname: '/api/socialV2/tool-log/clear',
    fsImpl: { writeFileSync: () => { throw new Error('EACCES'); } }
  });
  assert.equal(handleTelemetryRoutes(r.ctx), true);
  assert.deepEqual(r.sent[0].obj, { ok: true });
});
