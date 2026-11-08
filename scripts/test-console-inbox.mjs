// 控制台「收件箱与唤醒域」路由（src/console/inbox.mjs）离线测试。
// 直测 handler：构造假 ctx（不启 HTTP、不碰真实 state/），断言状态码、归一化结果与副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInboxRoutes } from '../src/console/inbox.mjs';

function makeState(overrides = {}) {
  return {
    wakeConfig: {
      mode: 'diving', infinite: true, sleepUntil: null, everyMinutes: 0,
      triggers: { atMention: true, nameMention: false, question: false, anyMessage: false, poke: false, keywords: [] },
      noActionCount: 2, wakeCount: 0, lastWakeAt: 0,
    },
    unread: [{ seq: 1, text: 'a' }, { seq: 2, text: 'b' }],
    recentMessages: [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }],
    lastWakeReason: 'message', lastAiReplyAt: 111, lastIncomingAt: Date.now() - 60000,
    pendingWakeTimer: null, bootstrapSent: true, deskMessages: [],
    ...overrides,
  };
}

function makeEnv(overrides = {}) {
  const calls = {
    sent: [], logs: [], saves: 0, activities: [], wakes: [], cleared: [], cancelled: [],
    sleepTimers: [], intervalTimers: [], readThrough: [], noted: [], acknowledged: [], ensured: [],
    updatedKeys: [], missedDeletes: [],
  };
  const state = makeState();
  const socialV2 = { conversations: new Map([['private:1', state]]) };
  const cfg = { ownerQQ: '1', socialV2: { wake: { preSleepWaitMs: 300000, sleepMinMs: 0, sleepMaxMs: 0, recommendedSleepMinMs: 1, recommendedSleepMaxMs: 2 } } };
  const ctx = {
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/unread'),
    sendJson: (body, status = 200) => { calls.sent.push({ body, status }); },
    readBody: async () => ({}),
    log: (...args) => { calls.logs.push(args.join(' ')); },
    cfg,
    socialV2,
    currentMode: 'reserved2',
    modeAllowed: () => true,
    getSocialV2State: (key) => socialV2.conversations.get(key) ?? makeState(),
    saveSocialV2State: () => { calls.saves += 1; },
    appendActivity: (line) => { calls.activities.push(line); },
    agentTokenOk: (key, token) => token === 'good-token',
    v2SessionAllowed: () => true,
    v2ToolEnabled: (flag) => !['unread', 'recent', 'markRead', 'setWakeConfig'].includes(flag) || flag !== 'off',
    noteModelMessagesV2: (st, messages) => { calls.noted.push(messages.length); return 99; },
    readThroughSeqV2: (st) => 7,
    requestedReadThroughSeqV2: (st, body, hasToken) => (body.readThroughSeq ?? null),
    acknowledgeMessagesV2: (st, through) => { calls.acknowledged.push(through); st.unread = []; return 2; },
    isSleepingConfigV2: (wc) => wc?.mode === 'diving',
    preSleepWaitBlockedV2: () => false,
    ensureWakeableV2: (st, extra) => { calls.ensured.push({ st, extra }); },
    computeWakeSafetyV2: (wc) => ({ safe: true, guaranteed: true }),
    pickWakeTriggersV2: (input, current) => ({ ...current, ...input }),
    normalizeSpeakerIdsV2: (ids) => (Array.isArray(ids) ? ids.filter((x) => Number.isInteger(x) && x > 0) : []),
    markReadCalledKeys: new Set(),
    wakeConfigUpdatedKeys: new Set(),
    wakeConfigMissCount: new Map(),
    cancelReplyCheckV2: (key) => { calls.cancelled.push(key); },
    setupSleepTimerV2: (key) => { calls.sleepTimers.push(key); },
    setupIntervalTimerV2: (key) => { calls.intervalTimers.push(key); },
    sendWakePromptV2: async (key, reason) => { calls.wakes.push({ key, reason }); },
    ...overrides,
  };
  return { ctx, calls, state, socialV2, cfg };
}

function run(ctx, { method = 'GET', pathname = '/api/socialV2/unread', body = {}, headers = {}, query = '' } = {}) {
  ctx.req = { method, headers };
  ctx.url = new URL('http://127.0.0.1' + pathname + query);
  ctx.readBody = async () => body;
  return handleInboxRoutes(ctx);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('不归本域的路径返回 false 且不写响应', async () => {
  const { ctx, calls } = makeEnv();
  for (const p of ['/api/status', '/api/socialV2/prompt', '/api/socialV2/initial-prompt', '/api/socialV2/send-message']) {
    assert.equal(await run(ctx, { pathname: p }), false);
  }
  assert.equal(calls.sent.length, 0);
});

test('GET unread：key 必填，afterSeq 必须是非负安全整数', async () => {
  const { ctx, calls } = makeEnv();
  assert.equal(await run(ctx), true);
  assert.equal(calls.sent.at(-1).status, 400);
  assert.match(calls.sent.at(-1).body.error, /key 不能为空/);
  await run(ctx, { query: '?key=private:1&afterSeq=-1' });
  assert.equal(calls.sent.at(-1).status, 400);
  assert.match(calls.sent.at(-1).body.error, /afterSeq/);
});

test('GET unread：游标分页按 seq 过滤，带 agent token 才推进水位', async () => {
  const { ctx, calls } = makeEnv();
  await run(ctx, { query: '?key=private:1&limit=10' });
  assert.deepEqual(calls.sent.at(-1).body.messages.map((m) => m.seq), [1, 2]);
  assert.equal(calls.sent.at(-1).body.readThroughSeq, 7);
  assert.equal(calls.noted.length, 0);
  await run(ctx, { query: '?key=private:1&afterSeq=1', headers: { 'x-agent-token': 'good-token' } });
  assert.deepEqual(calls.sent.at(-1).body.messages.map((m) => m.seq), [2]);
  assert.deepEqual(calls.noted, [1]);
  assert.equal(calls.sent.at(-1).body.readThroughSeq, 99);
});

test('GET recent：limit/offset 从尾部切片', async () => {
  const { ctx, calls } = makeEnv();
  await run(ctx, { pathname: '/api/socialV2/recent', query: '?key=private:1&limit=2' });
  assert.deepEqual(calls.sent.at(-1).body.messages.map((m) => m.seq), [4, 5]);
  await run(ctx, { pathname: '/api/socialV2/recent', query: '?key=private:1&limit=2&offset=2' });
  assert.deepEqual(calls.sent.at(-1).body.messages.map((m) => m.seq), [2, 3]);
});

test('POST mark-read：沉睡前观察窗口未满时 400 并带剩余分钟', async () => {
  const { ctx, calls } = makeEnv({ preSleepWaitBlockedV2: () => true });
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/mark-read', body: { key: 'private:1' } });
  const out = calls.sent.at(-1);
  assert.equal(out.status, 400);
  assert.match(out.body.error, /不能通过 qq_mark_read 直接回到潜水/);
  assert.equal(out.body.preSleepWaitMs, 300000);
  assert.equal(calls.acknowledged.length, 0);
});

test('POST mark-read：成功时清未读、补 infinite、确认唤醒并记 markReadCalledKeys', async () => {
  const { ctx, calls, state } = makeEnv();
  state.wakeConfig.infinite = false;
  state.wakeConfig.sleepUntil = null; // 补 infinite 分支要求既非无限期、也没有 sleepUntil
  const r = await run(ctx, { method: 'POST', pathname: '/api/socialV2/mark-read', body: { key: 'private:1', readThroughSeq: 2 } });
  assert.equal(r, true);
  assert.deepEqual(calls.acknowledged, [2]);
  assert.equal(state.wakeConfig.noActionCount, 0);
  assert.equal(state.wakeConfig.confirmedBy, 'mark_read');
  assert.equal(state.wakeConfig.infinite, true);
  assert.equal(calls.ensured.length, 1);
  assert.equal(calls.saves, 1);
  assert.equal(ctx.markReadCalledKeys.has('private:1'), true);
  assert.equal(calls.sent.at(-1).status, 200);
});

test('POST wake-config：无限期潜水没有任何触发条件时拒绝（防永眠）', async () => {
  const { ctx, calls } = makeEnv();
  const config = { mode: 'diving', infinite: true, triggers: { atMention: false, nameMention: false, question: false, anyMessage: false, poke: false, keywords: [] } };
  // 当前配置本身也没有触发条件 —— next 继承后仍为空
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/wake-config', body: { key: 'private:1', config } });
  const out = calls.sent.at(-1);
  assert.equal(out.status, 400);
  assert.match(out.body.error, /无限期潜水必须至少保留一个唤醒条件/);
});

test('POST wake-config：active 模式强制无限期 + anyMessage + 清 sleepUntil', async () => {
  const { ctx, calls, state } = makeEnv();
  state.wakeConfig.infinite = false;
  state.wakeConfig.sleepUntil = '2099-01-01T00:00:00.000Z';
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/wake-config', body: { key: 'private:1', config: { mode: 'active' } } });
  assert.equal(state.wakeConfig.mode, 'active');
  assert.equal(state.wakeConfig.infinite, true);
  assert.equal(state.wakeConfig.sleepUntil, null);
  assert.equal(state.wakeConfig.triggers.anyMessage, true);
  assert.equal(state.wakeConfig.confirmedBy, 'set_wake_config');
  assert.equal(calls.sleepTimers.length, 1);
  assert.equal(calls.intervalTimers.length, 1);
  assert.equal(calls.cancelled.length, 1);
  assert.equal(ctx.wakeConfigUpdatedKeys.has('private:1'), true);
  assert.equal(calls.sent.at(-1).status, 200);
});

test('POST wake-config：everyMinutes 夹在 5~1440，私有会话清空指定成员触发', async () => {
  const { ctx, state } = makeEnv();
  state.wakeConfig.triggers.speakerIds = [123456];
  state.wakeConfig.triggers.atMention = true;
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/wake-config', body: { key: 'private:1', config: { infinite: true, everyMinutes: 1 } } });
  assert.equal(state.wakeConfig.everyMinutes, 5);
  assert.deepEqual(state.wakeConfig.triggers.speakerIds, []);
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/wake-config', body: { key: 'private:1', config: { infinite: true, everyMinutes: 99999 } } });
  assert.equal(state.wakeConfig.everyMinutes, 1440);
});

test('POST wake-config：沉睡前观察窗口未满时拒绝', async () => {
  const { ctx, calls } = makeEnv({ preSleepWaitBlockedV2: () => true });
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/wake-config', body: { key: 'private:1', config: { mode: 'diving', infinite: true } } });
  const out = calls.sent.at(-1);
  assert.equal(out.status, 400);
  assert.match(out.body.error, /不能立刻设置潜水/);
  assert.equal(calls.sleepTimers.length, 0);
});

test('GET states：列出每个会话的唤醒与未读摘要', async () => {
  const { ctx, calls, socialV2 } = makeEnv();
  socialV2.conversations.set('group:9', makeState({ unread: [], recentMessages: [1] }));
  await run(ctx, { pathname: '/api/socialV2/states' });
  const list = calls.sent.at(-1).body.conversations;
  assert.equal(list.length, 2);
  assert.deepEqual(Object.keys(list[0]).sort(), ['key', 'lastAiReplyAt', 'lastWakeReason', 'noActionCount', 'recentCount', 'unreadCount', 'wakeConfig'].sort());
  assert.equal(list[0].noActionCount, 2);
});

test('POST wake：非 reserved2 模式 403；首次唤醒升级成 bootstrap', async () => {
  const { ctx, calls, state } = makeEnv({ currentMode: 'chat' });
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/wake', body: { key: 'private:1' } });
  assert.equal(calls.sent.at(-1).status, 403);
  ctx.currentMode = 'reserved2';
  state.bootstrapSent = false;
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/wake', body: { key: 'private:1', reason: 'admin' } });
  const out = calls.sent.at(-1).body;
  assert.equal(out.firstWake, true);
  assert.equal(out.reason, 'bootstrap');
  await flush();
  assert.deepEqual(calls.wakes, [{ key: 'private:1', reason: 'bootstrap' }]);
});

test('POST wake：异步唤醒失败被 catch 住，不会成为 unhandledRejection', async () => {
  const { ctx, calls } = makeEnv({ sendWakePromptV2: async () => { throw new Error('boom'); } });
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    await run(ctx, { method: 'POST', pathname: '/api/socialV2/wake', body: { key: 'private:1' } });
    await flush();
    assert.equal(calls.sent.at(-1).status, 200);
    assert.equal(unhandled, 0);
    assert.ok(calls.logs.some((l) => /手动唤醒异常/.test(l)));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('POST desk-message：存留言（最多 10 条）并触发唤醒、记活动', async () => {
  const { ctx, calls, state } = makeEnv();
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/desk-message', body: { key: 'private:1' } }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  for (let i = 0; i < 12; i++) {
    await run(ctx, { method: 'POST', pathname: '/api/socialV2/desk-message', body: { key: 'private:1', text: 'm' + i } });
  }
  assert.equal(state.deskMessages.length, 10);
  assert.equal(state.deskMessages.at(-1).text, 'm11');
  await flush();
  assert.equal(calls.wakes.at(-1).reason, 'desk');
  assert.equal(calls.activities.length, 12);
  assert.equal(calls.sent.at(-1).body.ok, true);
});
