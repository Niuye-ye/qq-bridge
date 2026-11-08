// 控制台「发送域」路由（src/console/send.mjs）离线测试。
// 直测 handler：构造假 ctx（不启 HTTP、不拉 OneBot、不碰真实 state/），断言状态码与副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSendRoutes } from '../src/console/send.mjs';

function makeEnv(overrides = {}) {
  const calls = {
    sent: [], logs: [], acts: [], saves: 0, reserves: [], rollbacks: [], quotaOk: true,
    sendCalls: [], records: [], scheds: [], rawCalls: [], imgCalls: [], stickerCalls: [], shots: 0
  };
  const state = {
    sendTimes: [], recentMessages: [],
    lastAiReplyAt: 0, lastActionAt: 0, wakeConfig: { noActionCount: 3 },
    preSleepWaitSatisfiedAt: 5, preSleepWaitObservedAt: 5, preSleepWaitAccumMs: 5
  };
  let body = {};
  const ctx = {
    req: { method: 'POST', headers: { 'x-agent-token': 'tok' } },
    url: new URL('http://127.0.0.1/api/socialV2/send-burst'),
    sendJson: (b, status = 200) => { calls.sent.push({ body: b, status }); },
    readBody: async () => body,
    log: (...a) => { calls.logs.push(a.join(' ')); },
    fs: { readFileSync: (p) => { if (String(p).includes('missing')) throw new Error('ENOENT'); return Buffer.from('local-img'); } },
    cfg: { socialV2: { send: {}, context: { recentLimit: 3 } } },
    socialV2: { paused: false },
    currentMode: 'reserved2',
    modeAllowed: () => true,
    shouldBlockSilentReply: () => false,
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    getSocialV2State: () => state,
    saveSocialV2State: () => { calls.saves += 1; },
    appendActivity: (s) => { calls.acts.push(s); },
    bot: { raw: async (action, payload) => { calls.rawCalls.push({ action, payload }); } },
    truncateText: (s, n) => String(s).slice(0, n),
    SENSITIVE_RE: /secret/,
    looksLikeImageBuffer: () => true,
    formatBytes: (n) => n + 'B',
    safeFetchBuffer: async () => ({ buffer: Buffer.from('url-img') }),
    MAX_MEDIA_BYTES: 1000,
    checkQuota: () => ({ ok: calls.quotaOk }),
    reserveQuota: (arr, n) => { calls.reserves.push(n); return [...arr, { n }]; },
    rollbackQuota: (arr, n) => { calls.rollbacks.push(n); return arr; },
    computeGapsV2: () => [0],
    sendMessagesV2: async (key, msgs, delays, replyTo, atUserId) => {
      calls.sendCalls.push({ key, msgs, delays, replyTo, atUserId });
      return msgs.map((_, i) => ({ messageId: 'm' + i }));
    },
    recordSentMessagesV2: (k, m) => { calls.records.push(m.length); },
    scheduleReplyCheckV2: (k) => { calls.scheds.push(k); },
    findCjkSpaceWarning: () => null,
    findSplitBoundaryWarning: () => null,
    resolveReplyTargetV2: async (st, kind, id, ref) => (ref === '-5' ? null : { info: { text: '引用内容' }, messageId: '300' }),
    captureSendGuard: () => () => {},
    assertGroupMember: async (g, u) => (u === '999' ? '不是本群成员' : null),
    captureDeviceScreenshotV2: async () => { calls.shots += 1; return Buffer.from('shot-img'); },
    resolveImageSourcePath: (raw) => ({ abs: raw, label: '本地图片' }),
    sendImageV2: async (k, buf) => { calls.imgCalls.push(buf.length); return { messageId: 'img1' }; },
    stickerEnabled: () => true,
    syncStickerLibrary: async () => ({ entries: [{ id: 'st1', desc: '猫猫' }] }),
    pickStickerByQuery: (entries, q) => (q ? entries[0] : null),
    getStickerEntries: () => [],
    sendStickerV2: async (k, id) => { calls.stickerCalls.push(id); return { messageId: 's1', entry: { id, desc: '猫猫' } }; }
  };
  Object.assign(ctx, overrides.ctx || {});
  return {
    calls, state, ctx,
    setBody: (b) => { body = b; },
    setPath: (p) => { ctx.url = new URL('http://127.0.0.1' + p); },
    last: () => calls.sent[calls.sent.length - 1]
  };
}

test('非本域路径返回 false', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/unread');
  assert.equal(await handleSendRoutes(env.ctx), false);
  assert.equal(env.calls.sent.length, 0);
});

test('send-burst：缺 messages → 400', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-burst');
  env.setBody({ key: 'private:1', messages: [] });
  assert.equal(await handleSendRoutes(env.ctx), true);
  assert.equal(env.last().status, 400);
  assert.match(env.last().body.error, /不能为空/);
});

test('send-burst：带 replyToMessageId → 400（暂不支持引用）', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-burst');
  env.setBody({ key: 'private:1', messages: ['hi'], replyToMessageId: '5' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 400);
  assert.match(env.last().body.error, /暂不支持引用/);
});

test('send-burst：静默模式 → 403 且不预占额度', async () => {
  const env = makeEnv({ ctx: { shouldBlockSilentReply: () => true } });
  env.setPath('/api/socialV2/send-burst');
  env.setBody({ key: 'private:1', messages: ['hi'] });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 403);
  assert.deepEqual(env.calls.reserves, []);
});

test('send-burst：额度不足 → 429 且未预占', async () => {
  const env = makeEnv({ ctx: { checkQuota: () => ({ ok: false }) } });
  env.setPath('/api/socialV2/send-burst');
  env.setBody({ key: 'private:1', messages: ['hi'] });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 429);
  assert.deepEqual(env.calls.reserves, []);
});

test('send-burst：成功 → 200，预占 2 条、记录已发、排回复检查、状态更新', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-burst');
  env.setBody({ key: 'private:1', messages: ['a', 'b'] });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 200);
  assert.equal(env.last().body.sent, 2);
  assert.deepEqual(env.calls.reserves, [2]);
  assert.deepEqual(env.calls.records, [2]);
  assert.deepEqual(env.calls.scheds, ['private:1']);
  assert.equal(env.state.wakeConfig.noActionCount, 0);
  assert.equal(env.state.lastAiReplyAt > 0, true);
  assert.ok(env.calls.saves >= 1);
});

test('send-message：引用解析失败 → 400 且回滚额度', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-message');
  env.setBody({ key: 'private:1', messages: ['hi'], replyToMessageId: '-5' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 400);
  assert.deepEqual(env.calls.reserves, [1]);
  assert.deepEqual(env.calls.rollbacks, [1]);
});

test('send-message：成功引用 → replyTo 用解析后的 messageId', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-message');
  env.setBody({ key: 'private:1', messages: ['hi'], replyToMessageId: '77' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 200);
  assert.equal(env.calls.sendCalls[0].replyTo, '300');
  assert.deepEqual(env.last().body.quoted, { text: '引用内容' });
});

test('send-poke：群聊缺 targetUserId → 400', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-poke');
  env.setBody({ key: 'group:100' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 400);
  assert.match(env.last().body.error, /targetUserId/);
});

test('send-poke：目标不是群成员 → 403', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-poke');
  env.setBody({ key: 'group:100', targetUserId: '999' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 403);
  assert.match(env.last().body.error, /不是本群成员/);
});

test('send-poke：成功 → bot.raw 调 group_poke，且记录最近消息', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-poke');
  env.setBody({ key: 'group:100', targetUserId: '123' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 200);
  assert.deepEqual(env.calls.rawCalls[0], { action: 'group_poke', payload: { group_id: 100, user_id: 123 } });
  assert.equal(env.state.recentMessages.at(-1).text, '[拍一拍] 我拍了拍 123');
});

test('send-image：三个来源都没给 → 400', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-image');
  env.setBody({ key: 'private:1' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 400);
  assert.match(env.last().body.error, /至少要给一个/);
});

test('send-image：读本地文件失败 → 400 图片读取失败', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-image');
  env.setBody({ key: 'private:1', path: 'missing.png' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 400);
  assert.match(env.last().body.error, /图片读取失败/);
});

test('send-image：success → recentMessages 推入 [图片] 且 media 带 label', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-image');
  env.setBody({ key: 'private:1', path: 'ok.png' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 200);
  assert.equal(env.last().body.source, '本地图片');
  assert.deepEqual(env.calls.imgCalls, [9]);
  const rec = env.state.recentMessages.at(-1);
  assert.equal(rec.text, '[图片]');
  assert.equal(rec.media[0].desc, '本地图片');
  assert.equal(env.state.preSleepWaitSatisfiedAt, 0);
});

test('send-sticker：带文字 → 400（表情不能附带文字）', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-sticker');
  env.setBody({ key: 'private:1', stickerId: 'st1', message: '嘿嘿' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 400);
  assert.match(env.last().body.error, /不能附带文字/);
});

test('send-sticker：表情体系关闭 → 403', async () => {
  const env = makeEnv({ ctx: { stickerEnabled: () => false } });
  env.setPath('/api/socialV2/send-sticker');
  env.setBody({ key: 'private:1', stickerId: 'st1' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 403);
});

test('send-sticker：按分类挑中 → 200 且 replyTo 解析生效', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/send-sticker');
  env.setBody({ key: 'private:1', query: '猫' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 200);
  assert.deepEqual(env.calls.stickerCalls, ['st1']);
  assert.equal(env.state.recentMessages.at(-1).sticker.desc, '猫猫');
});

test('check-send：缺 token/tool → 400', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/check-send');
  env.setBody({ key: 'private:1' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 400);
});

test('check-send：未知 tool → 400', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/check-send');
  env.setBody({ key: 'private:1', tool: 'nope', token: 't' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 400);
  assert.match(env.last().body.error, /sendGroup/);
});

test('check-send：工具被关闭 → 403', async () => {
  const env = makeEnv({ ctx: { v2ToolEnabled: () => false } });
  env.setPath('/api/socialV2/check-send');
  env.setBody({ key: 'private:1', tool: 'reply', token: 't' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 403);
  assert.match(env.last().body.error, /工具未启用/);
});

test('check-send：成功 → 200 {ok,key,tool}', async () => {
  const env = makeEnv();
  env.setPath('/api/socialV2/check-send');
  env.setBody({ key: 'private:1', tool: 'sendPrivate', token: 't' });
  await handleSendRoutes(env.ctx);
  assert.equal(env.last().status, 200);
  assert.deepEqual(env.last().body, { ok: true, key: 'private:1', tool: 'sendPrivate' });
});
