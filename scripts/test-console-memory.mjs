// 控制台「轻量记忆」域路由（src/console/memory.mjs）离线测试。
// 直测 handler：构造假 ctx（不启 HTTP 服务、不碰真实 state/），断言状态码、响应体与副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMemoryRoutes } from '../src/console/memory.mjs';

function makeEnv(overrides = {}) {
  const state = {
    activeTopics: [],
    pendingThoughts: [],
    memberImpressions: {},
  };
  const calls = { sent: [], saves: 0, appended: [] };
  const st = state;
  const ctx = {
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/memory'),
    sendJson: (body, status = 200) => { calls.sent.push({ body, status }); },
    readBody: async () => ({}),
    getSocialV2State: () => st,
    appendMemoryV2: (target, category, content, extra) => {
      calls.appended.push({ category, content, extra });
      if (category === 'activeTopic') target.activeTopics.push({ text: content, participants: [], pendingQuestion: '' });
      else if (category === 'pendingThought') target.pendingThoughts.push({ text: content, motivation: '' });
      else target.memberImpressions[String(extra.target || '').trim()] = { traits: [content], interactionCount: 1, lastSeenAt: Date.now() };
    },
    formatMemoryV2: (s) => JSON.stringify({
      activeTopics: (s.activeTopics ?? []).map((t) => t.text),
      pendingThoughts: (s.pendingThoughts ?? []).map((t) => t.text),
      memberImpressions: Object.keys(s.memberImpressions ?? {}),
    }),
    saveSocialV2State: () => { calls.saves += 1; },
    redactKnownTokensOnly: (s) => s,
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    ...overrides,
  };
  return { state, calls, ctx };
}

function run(ctx, { method = 'GET', pathname = '/api/socialV2/memory', body = {}, headers = {} } = {}) {
  ctx.req = { method, headers };
  ctx.url = new URL('http://127.0.0.1' + pathname);
  ctx.readBody = async () => body;
  return handleMemoryRoutes(ctx);
}

test('不归本域的路径返回 false 且不写响应', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { pathname: '/api/status' }), false);
  assert.equal(await run(ctx, { pathname: '/api/socialV2/memoryx' }), false);
  assert.equal(calls.sent.length, 0);
});

test('memory-append：缺字段 / 非法 category / memberImpression 缺 target 都 400', async () => {
  const { calls, ctx } = makeEnv();
  let ok = await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-append', body: {} });
  assert.equal(ok, true);
  assert.equal(calls.sent.at(-1).status, 400);
  assert.equal(calls.sent.at(-1).body.error, 'key/category/content 不能为空');

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-append', body: { key: 'group:1', category: 'bogus', content: 'x' } });
  assert.equal(calls.sent.at(-1).body.error, 'category 必须是 activeTopic / pendingThought / memberImpression');

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-append', body: { key: 'group:1', category: 'memberImpression', content: 'x' } });
  assert.equal(calls.sent.at(-1).body.error, 'memberImpression 需要 extra.target 指定群友名字');
  assert.equal(calls.appended.length, 0);
});

test('memory-append：成功写入并返回 formatted memory', async () => {
  const { calls, state, ctx } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-append', body: { key: 'group:1', category: 'activeTopic', content: '在聊搬家' } });
  assert.equal(calls.sent.at(-1).status, 200);
  assert.equal(calls.sent.at(-1).body.ok, true);
  assert.match(calls.sent.at(-1).body.memory, /在聊搬家/);
  assert.equal(state.activeTopics.length, 1);
});

test('memory-update：activeTopic 找不到 404，找到则截断到 200 字并保存', async () => {
  const { calls, state, ctx } = makeEnv();
  state.activeTopics.push({ text: '旧话题', participants: [], pendingQuestion: '' });
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-update', body: { key: 'group:1', category: 'activeTopic', oldContent: '不存在' } });
  assert.equal(calls.sent.at(-1).status, 404);
  assert.equal(calls.sent.at(-1).body.error, '找不到要编辑的 activeTopic');

  const long = 'x'.repeat(300);
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-update', body: { key: 'group:1', category: 'activeTopic', oldContent: '旧话题', newContent: long, newExtra: { participants: ['a', 'b'], pendingQuestion: '问一句' } } });
  assert.equal(calls.sent.at(-1).status, 200);
  assert.equal(state.activeTopics[0].text.length, 200);
  assert.deepEqual(state.activeTopics[0].participants, ['a', 'b']);
  assert.equal(state.activeTopics[0].pendingQuestion, '问一句');
  assert.equal(calls.saves, 1);
});

test('memory-update：memberImpression 原型链名字 400、不存在 404、可改名', async () => {
  const { calls, state, ctx } = makeEnv();
  state.memberImpressions['阿明'] = { traits: ['话少'], interactionCount: 1, lastSeenAt: 1 };
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-update', body: { key: 'group:1', category: 'memberImpression', target: '__proto__' } });
  assert.equal(calls.sent.at(-1).status, 400);
  assert.equal(calls.sent.at(-1).body.error, '非法的群友名字');

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-update', body: { key: 'group:1', category: 'memberImpression', target: 'toString' } });
  assert.equal(calls.sent.at(-1).status, 404);
  assert.equal(calls.sent.at(-1).body.error, '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）');
  assert.equal(Object.prototype.hasOwnProperty.call(state.memberImpressions, 'toString'), false);

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-update', body: { key: 'group:1', category: 'memberImpression', target: '阿明', newContent: '话少，爱笑', newExtra: { target: '小阿明', interactionCount: 3 } } });
  assert.equal(calls.sent.at(-1).status, 200);
  assert.equal(state.memberImpressions['阿明'], undefined);
  assert.deepEqual(state.memberImpressions['小阿明'].traits, ['话少', '爱笑']);
  assert.equal(state.memberImpressions['小阿明'].interactionCount, 3);
});

test('memory-update：memberImpressions 超过 50 条按 lastSeenAt 淘汰最旧', async () => {
  const { state, ctx } = makeEnv();
  for (let i = 0; i < 51; i += 1) state.memberImpressions['m' + i] = { traits: [], interactionCount: 0, lastSeenAt: i };
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-update', body: { key: 'group:1', category: 'memberImpression', target: 'm50' } });
  const keys = Object.keys(state.memberImpressions);
  assert.equal(keys.length, 50);
  assert.equal(keys.includes('m0'), false);
  assert.equal(keys.includes('m1'), true);
});

test('GET memory：缺 key 400，category 过滤，过期 pendingThought 不返回', async () => {
  const { calls, state, ctx } = makeEnv();
  state.activeTopics.push({ text: '话题' });
  state.pendingThoughts.push({ text: '想说', expiresAt: Date.now() - 1000 }, { text: '还说', expiresAt: Date.now() + 60000 });
  state.memberImpressions['阿明'] = { traits: ['话少'] };

  await run(ctx, { pathname: '/api/socialV2/memory' });
  assert.equal(calls.sent.at(-1).status, 400);
  assert.equal(calls.sent.at(-1).body.error, 'key 不能为空');

  await run(ctx, { pathname: '/api/socialV2/memory?key=group:1' });
  const body = calls.sent.at(-1).body;
  assert.deepEqual(body.raw.activeTopics.map((t) => t.text), ['话题']);
  assert.deepEqual(body.raw.pendingThoughts.map((t) => t.text), ['还说']);
  assert.deepEqual(Object.keys(body.raw.memberImpressions), ['阿明']);

  await run(ctx, { pathname: '/api/socialV2/memory?key=group:1&category=memberImpression' });
  const filtered = calls.sent.at(-1).body.raw;
  assert.deepEqual(filtered.activeTopics, []);
  assert.deepEqual(filtered.pendingThoughts, []);
  assert.deepEqual(Object.keys(filtered.memberImpressions), ['阿明']);
});

test('memory-remove：缺 content 400，按内容删除，memberImpression 按 target 删除', async () => {
  const { calls, state, ctx } = makeEnv();
  state.activeTopics.push({ text: '删我' }, { text: '留我' });
  state.memberImpressions['阿明'] = { traits: [] };

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-remove', body: { key: 'group:1', category: 'activeTopic' } });
  assert.equal(calls.sent.at(-1).status, 400);
  assert.equal(calls.sent.at(-1).body.error, '该类别需要 content 指定要删除的记忆内容');

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-remove', body: { key: 'group:1', category: 'activeTopic', content: '删我' } });
  assert.deepEqual(state.activeTopics.map((t) => t.text), ['留我']);

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-remove', body: { key: 'group:1', category: 'memberImpression', target: '阿明' } });
  assert.deepEqual(Object.keys(state.memberImpressions), []);
});

test('memory-clear：不带 category 全清且响应 category=all，带 category 只清一类', async () => {
  const { calls, state, ctx } = makeEnv();
  state.activeTopics.push({ text: 'a' });
  state.pendingThoughts.push({ text: 'b' });
  state.memberImpressions['阿明'] = {};

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-clear', body: { key: 'group:1', category: 'activeTopic' } });
  assert.equal(calls.sent.at(-1).body.category, 'activeTopic');
  assert.equal(state.activeTopics.length, 0);
  assert.equal(state.pendingThoughts.length, 1);

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-clear', body: { key: 'group:1' } });
  assert.equal(calls.sent.at(-1).body.category, 'all');
  assert.equal(state.pendingThoughts.length, 0);
  assert.deepEqual(state.memberImpressions, {});
});

test('agent token：无效 403，工具开关关闭 403 且文案带具体工具名', async () => {
  const { calls, ctx } = makeEnv({ agentTokenOk: () => false });
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/memory-append', body: { key: 'group:1', category: 'activeTopic', content: 'x' }, headers: { 'x-agent-token': 'bad' } });
  assert.equal(calls.sent.at(-1).status, 403);
  assert.equal(calls.sent.at(-1).body.error, 'agent token 无效');

  const env2 = makeEnv({ v2ToolEnabled: () => false });
  await run(env2.ctx, { method: 'POST', pathname: '/api/socialV2/memory-append', body: { key: 'group:1', category: 'activeTopic', content: 'x' }, headers: { 'x-agent-token': 'ok' } });
  assert.equal(env2.calls.sent.at(-1).body.error, '工具未启用：qq_memory_append');
  await run(env2.ctx, { method: 'POST', pathname: '/api/socialV2/memory-update', body: { key: 'group:1', category: 'activeTopic', oldContent: 'x' }, headers: { 'x-agent-token': 'ok' } });
  assert.equal(env2.calls.sent.at(-1).body.error, '工具未启用：qq_memory_*');
  await run(env2.ctx, { pathname: '/api/socialV2/memory?key=group:1', headers: { 'x-agent-token': 'ok' } });
  assert.equal(env2.calls.sent.at(-1).body.error, '工具未启用：qq_memory_query');
  await run(env2.ctx, { method: 'POST', pathname: '/api/socialV2/memory-remove', body: { key: 'group:1', category: 'activeTopic', content: 'x' }, headers: { 'x-agent-token': 'ok' } });
  assert.equal(env2.calls.sent.at(-1).body.error, '工具未启用：qq_memory_remove');
  await run(env2.ctx, { method: 'POST', pathname: '/api/socialV2/memory-clear', body: { key: 'group:1' }, headers: { 'x-agent-token': 'ok' } });
  assert.equal(env2.calls.sent.at(-1).body.error, '工具未启用：qq_memory_clear');
});
