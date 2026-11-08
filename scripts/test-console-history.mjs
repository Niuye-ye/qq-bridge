// 控制台「查询历史域」路由（src/console/history.mjs）离线测试。
// 直测 handler：构造假 ctx（不启 HTTP、不碰真实 state/），断言状态码、字段与副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHistoryRoutes } from '../src/console/history.mjs';

function makeState(overrides = {}) {
  return {
    paused: true,
    recentMessages: [],
    unread: [],
    ...overrides,
  };
}

function makeEnv(overrides = {}) {
  const calls = { sent: [], logs: [], raws: [], resolved: [], fetched: [], modes: [] };
  const state = makeState();
  const socialV2 = { conversations: new Map([['private:1', state]]) };
  const seenForwardIds = new Map();
  const ctx = {
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/my-recent'),
    sendJson: (body, status = 200) => { calls.sent.push({ body, status }); },
    readBody: async () => ({}),
    log: (...args) => { calls.logs.push(args.join(' ')); },
    cfg: { ownerQQ: '1' },
    currentMode: 'reserved2',
    agentTokenOk: (key, token) => token === 'good-token',
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    modeAllowed: () => true,
    getSocialV2State: (key) => socialV2.conversations.get(key) ?? makeState(),
    readThroughSeqV2: (st) => st.readThroughSeq ?? 7,
    resolveReplyInfo: async (kind, id, messageId) => { calls.resolved.push({ kind, id, messageId }); return null; },
    fetchMediaData: async (media) => { calls.fetched.push(media); return media.map((m, i) => ({ index: i, base64: 'AAA' })); },
    findMessageMedia: () => [],
    seenForwardIds,
    bot: { raw: async (action, params) => { calls.raws.push({ action, params }); return { messages: [] }; } },
    ...overrides,
  };
  return { ctx, calls, state, socialV2, seenForwardIds };
}

function run(ctx, { method = 'GET', pathname = '/api/socialV2/my-recent', body = {}, headers = {}, query = '' } = {}) {
  ctx.req = { method, headers };
  ctx.url = new URL('http://127.0.0.1' + pathname + query);
  ctx.readBody = async () => body;
  return handleHistoryRoutes(ctx);
}

const last = (calls) => calls.sent[calls.sent.length - 1];

test('不归本域的路径返回 false 且不写响应', async () => {
  const { ctx, calls } = makeEnv();
  for (const p of ['/api/status', '/api/socialV2/send-message', '/api/authorize/read', '/api/socialV2/wake-config']) {
    assert.equal(await run(ctx, { pathname: p }), false, p);
  }
  assert.equal(calls.sent.length, 0);
});

test('my-recent：缺 key 返回 400', async () => {
  const { ctx, calls } = makeEnv();
  assert.equal(await run(ctx), true);
  assert.equal(last(calls).status, 400);
  assert.match(last(calls).body.error, /key 不能为空/);
});

test('my-recent：只回 isSelf、limit 夹到 50、带 paused（桌宠依赖）', async () => {
  const { ctx, calls, state } = makeEnv();
  const recent = [];
  for (let i = 1; i <= 60; i++) recent.push({ seq: i, isSelf: true, text: 'mine' + i });
  for (let i = 61; i <= 70; i++) recent.push({ seq: i, isSelf: false, text: 'other' + i });
  state.recentMessages = recent;
  assert.equal(await run(ctx, { query: '?key=private:1&limit=999' }), true);
  const body = last(calls).body;
  assert.equal(last(calls).status, 200);
  assert.equal(body.messages.length, 50);
  assert.ok(body.messages.every((m) => m.isSelf));
  assert.equal(body.messages[49].seq, 60);
  assert.equal(body.paused, true);
  assert.equal(body.readThroughSeq, 7);
  assert.equal(body.key, 'private:1');
});

test('my-recent：工具关闭时带 agent token 返回 403', async () => {
  const { ctx, calls } = makeEnv({ v2ToolEnabled: (flag) => flag !== 'getMyRecent' });
  await run(ctx, { query: '?key=private:1', headers: { 'x-agent-token': 'good-token' } });
  assert.equal(last(calls).status, 403);
  assert.match(last(calls).body.error, /qq_get_my_recent_messages/);
});

test('record-sent：恒 403，不读 body、不写状态', async () => {
  const { ctx, calls } = makeEnv();
  let read = 0;
  ctx.readBody = async () => { read += 1; return {}; };
  const ret = await handleHistoryRoutes(Object.assign(ctx, {
    req: { method: 'POST', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/record-sent'),
  }));
  assert.equal(ret, true);
  assert.equal(last(calls).status, 403);
  assert.match(last(calls).body.error, /仅桥接内部使用/);
  assert.equal(read, 0);
});

test('message-detail：缺参 400 / key 格式错 400', async () => {
  const { ctx, calls } = makeEnv();
  await run(ctx, { pathname: '/api/socialV2/message-detail', query: '?key=private:1' });
  assert.equal(last(calls).status, 400);
  assert.match(last(calls).body.error, /key 和 messageId 不能为空/);
  await run(ctx, { pathname: '/api/socialV2/message-detail', query: '?key=bad&messageId=1' });
  assert.equal(last(calls).status, 400);
  assert.match(last(calls).body.error, /key 格式/);
});

test('message-detail：本地命中优先，不再查 OneBot，200 字符标记截断并补转发字段', async () => {
  const { ctx, calls, state } = makeEnv();
  state.recentMessages = [{
    seq: 42, messageId: '777', sender: '主人', text: 'x'.repeat(250), userId: '1946431105',
    forwardIds: ['f1'], hasForward: true,
  }];
  await run(ctx, { pathname: '/api/socialV2/message-detail', query: '?key=private:1&messageId=42' });
  const body = last(calls).body;
  assert.equal(last(calls).status, 200);
  assert.equal(body.info.sender, '主人');
  assert.equal(body.info.messageId, '777');
  assert.equal(body.info.seq, 42);
  assert.equal(body.info.text.length, 200);
  assert.equal(body.info.textTruncated, true);
  assert.deepEqual(body.info.forwardIds, ['f1']);
  assert.equal(body.info.hasForward, true);
  assert.equal(calls.resolved.length, 0, '本地命中不应再调 resolveReplyInfo');
});

test('message-detail：本地未命中回落 resolveReplyInfo，失败时 200 info=null', async () => {
  const { ctx, calls } = makeEnv({
    resolveReplyInfo: async (kind, id, messageId) => { calls.resolved.push({ kind, id, messageId }); return { sender: 'A', text: 'hello', userId: '5', messageId, seq: 9 }; },
  });
  await run(ctx, { pathname: '/api/socialV2/message-detail', query: '?key=group:100&messageId=abc' });
  const body = last(calls).body;
  assert.equal(last(calls).status, 200);
  assert.equal(calls.resolved[0].kind, 'group');
  assert.equal(calls.resolved[0].id, 100);
  assert.equal(body.info.sender, 'A');
  assert.equal(body.info.textTruncated, false);
  const empty = makeEnv();
  await run(empty.ctx, { pathname: '/api/socialV2/message-detail', query: '?key=group:100&messageId=zzz' });
  assert.equal(last(empty.calls).status, 200);
  assert.equal(last(empty.calls).body.info, null);
});

test('forward-message：非 reserved2 / 无 token / 未见过 id 三道闸', async () => {
  const { ctx, calls } = makeEnv({ currentMode: 'chat' });
  await run(ctx, { pathname: '/api/socialV2/forward-message', query: '?key=private:1&id=f1' });
  assert.equal(last(calls).status, 403);
  assert.match(last(calls).body.error, /仅 reserved2 模式可用/);

  const b = makeEnv();
  b.ctx.currentMode = 'reserved2';
  await run(b.ctx, { pathname: '/api/socialV2/forward-message', query: '?key=private:1&id=f1' });
  assert.equal(last(b.calls).status, 403);
  assert.match(last(b.calls).body.error, /必须携带 agent token/);

  const c = makeEnv();
  await run(c.ctx, { pathname: '/api/socialV2/forward-message', query: '?key=private:1&id=not-seen', headers: { 'x-agent-token': 'good-token' } });
  assert.equal(last(c.calls).status, 404);
  assert.match(last(c.calls).body.error, /不在当前会话可见范围内/);
  assert.equal(c.calls.raws.length, 0, '越界 id 不应打到 OneBot');
});

test('forward-message：成功展开 + 嵌套预览最多 5 个 + 登记 seenForwardIds', async () => {
  const { ctx, calls, state, seenForwardIds } = makeEnv();
  state.recentMessages = [{ seq: 1, text: 'fwd', forwardIds: ['F1'], hasForward: true }];
  const node = (id, text, nested) => ({
    sender: { nickname: 'A', user_id: '11' },
    time: 100, message_id: id, message_seq: 1,
    content: [{ type: 'text', data: { text } }, ...(nested ? [{ type: 'forward', data: { id: nested } }] : [])],
  });
  ctx.bot.raw = async (action, params) => {
    calls.raws.push({ action, params });
    if (params.id === 'F1') {
      return { messages: [
        node('m1', 'hello', 'N1'),
        node('m2', 'world', 'N2'),
        node('m3', 'a', 'N3'), node('m4', 'b', 'N4'), node('m5', 'c', 'N5'), node('m6', 'd', 'N6'),
      ] };
    }
    return { messages: [node('n-' + params.id, 'nested ' + params.id)] };
  };
  await run(ctx, { pathname: '/api/socialV2/forward-message', query: '?key=private:1&id=F1', headers: { 'x-agent-token': 'good-token' } });
  const body = last(calls).body;
  assert.equal(last(calls).status, 200);
  assert.equal(body.key, 'private:1');
  assert.equal(body.id, 'F1');
  assert.equal(body.messages.length, 6);
  assert.equal(body.nestedPreviews.length, 5);
  assert.equal(body.nestedPreviews[0].messages[0].text, 'nested N1');
  const set = seenForwardIds.get('private:1');
  assert.ok(set, '应登记本会话已见 forward id');
  assert.equal(set.has('N1'), true);
  assert.equal(set.has('N6'), true, '主层出现的嵌套 id 全部登记（预览只抓前 5 个）');
});

test('forward-media：缺 key 400 / 非 reserved2 403 / 空 media 直接回空 / 成功转图片', async () => {
  const { ctx, calls } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/forward-media', body: {} });
  assert.equal(last(calls).status, 400);
  assert.match(last(calls).body.error, /key 不能为空/);

  const b = makeEnv({ currentMode: 'chat' });
  await run(b.ctx, { method: 'POST', pathname: '/api/socialV2/forward-media', body: { key: 'private:1', media: [] } });
  assert.equal(last(b.calls).status, 403);
  assert.match(last(b.calls).body.error, /转发媒体读取仅 reserved2 模式可用/);

  const c = makeEnv();
  await run(c.ctx, { method: 'POST', pathname: '/api/socialV2/forward-media', body: { key: 'private:1', media: [] } });
  assert.equal(last(c.calls).status, 200);
  assert.deepEqual(last(c.calls).body.images, []);

  const d = makeEnv();
  await run(d.ctx, { method: 'POST', pathname: '/api/socialV2/forward-media', body: { key: 'private:1', media: [{ kind: 'image', url: 'u' }] } });
  assert.equal(last(d.calls).status, 200);
  assert.equal(d.calls.fetched.length, 1);
  assert.equal(last(d.calls).body.images[0].base64, 'AAA');
});

test('active-members：缺 key 400 / 按发言数排序 / limit 夹到 20 / isOwner 标记', async () => {
  const { ctx, calls, state } = makeEnv();
  await run(ctx, { pathname: '/api/socialV2/active-members' });
  assert.equal(last(calls).status, 400);

  const recent = [];
  for (let i = 0; i < 3; i++) recent.push({ seq: i + 1, sender: '主人', userId: '1', isOwner: true, time: 10 + i });
  for (let i = 0; i < 5; i++) recent.push({ seq: 100 + i, sender: 'B', userId: '2', time: 50 + i });
  recent.push({ seq: 200, sender: 'me', isSelf: true, text: 'x' });
  state.recentMessages = recent;
  await run(ctx, { pathname: '/api/socialV2/active-members', query: '?key=private:1&limit=99' });
  const body = last(calls).body;
  assert.equal(last(calls).status, 200);
  assert.equal(body.members.length, 2);
  assert.equal(body.members[0].sender, 'B');
  assert.equal(body.members[0].count, 5);
  assert.equal(body.members[1].count, 3);
  assert.equal(body.members[1].isOwner, true);
  assert.equal(body.members[1].lastTime, 12);
});

test('images/message：格式/模式/无媒体/成功四种分支', async () => {
  const { ctx, calls } = makeEnv();
  await run(ctx, { pathname: '/api/images/message', query: '?key=bad&messageId=1' });
  assert.equal(last(calls).status, 400);

  const b = makeEnv();
  await run(b.ctx, { pathname: '/api/images/message', query: '?key=private:1&messageId=1' });
  assert.equal(last(b.calls).status, 403);
  assert.match(last(b.calls).body.error, /必须携带 agent token/);

  const c = makeEnv({ currentMode: 'chat' });
  await run(c.ctx, { pathname: '/api/images/message', query: '?key=private:1&messageId=1' });
  assert.equal(last(c.calls).status, 403);
  assert.match(last(c.calls).body.error, /仅 reserved2 模式可用/);

  const d = makeEnv();
  await run(d.ctx, { pathname: '/api/images/message', query: '?key=private:1&messageId=1', headers: { 'x-agent-token': 'good-token' } });
  assert.equal(last(d.calls).status, 200);
  assert.match(last(d.calls).body.note, /没有可读取的图片/);

  const e = makeEnv({ findMessageMedia: () => [{ kind: 'image', url: 'u1' }] });
  await run(e.ctx, { pathname: '/api/images/message', query: '?key=private:1&messageId=1', headers: { 'x-agent-token': 'good-token' } });
  assert.equal(last(e.calls).status, 200);
  assert.equal(last(e.calls).body.media.length, 1);
  assert.equal(last(e.calls).body.images[0].base64, 'AAA');
});

test('images/message：closed-agent 不带 token 时也受工具开关约束', async () => {
  const { ctx, calls } = makeEnv({ currentMode: 'closed-agent', v2ToolEnabled: () => false });
  await run(ctx, { pathname: '/api/images/message', query: '?key=private:1&messageId=1' });
  assert.equal(last(calls).status, 403);
  assert.match(last(calls).body.error, /qq_get_message_images/);
});
