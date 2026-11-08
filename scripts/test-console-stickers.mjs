// 控制台「表情包域」路由（src/console/stickers.mjs）离线测试。
// 直测 handler：构造假 ctx（不启 HTTP、不拉 OneBot、不碰真实 state/），断言状态码与副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStickerRoutes } from '../src/console/stickers.mjs';

function makeEnv(overrides = {}) {
  const calls = {
    sent: [], logs: [], activities: [], saves: 0, syncs: [], collect: [], notes: [], remarks: [],
    quotaChecks: [], reserves: [], rollbacks: [], quota: { ok: true },
    entries: [
      { id: 's1', desc: '猫猫', localNote: '', tags: [], url: 'https://example.com/s1.png', md5: 'm1' },
      { id: 's2', desc: '狗头', localNote: '', tags: [], url: 'https://example.com/s2.png', md5: 'm2' }
    ],
    syncedAt: 1234,
    writable: true,
    stickerOn: true,
    imageDims: { width: 10, height: 10 },
  };
  const ctx = {
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/sticker-image'),
    sendJson: (body, status = 200) => { calls.sent.push({ body, status }); },
    readBody: async () => ({}),
    log: (...args) => { calls.logs.push(args.join(' ')); },
    cfg: { socialV2: { sticker: { maxListCount: 100, collect: { enabled: true, maxPerMinute: 3, maxPerHour: 5 } } } },
    stickerEnabled: () => calls.stickerOn,
    getStickerImageData: async (id) => {
      const hit = calls.entries.find((e) => e.id === id);
      if (!hit) throw new Error('找不到表情');
      return hit;
    },
    applyStickerNoteV2: (id, note, tags, usage) => {
      calls.notes.push({ id, note, tags, usage });
      const hit = calls.entries.find((e) => e.id === id);
      if (!hit) return null;
      return { ...hit, localNote: note ?? hit.localNote, tags: tags ?? hit.tags, usage: usage ?? '' };
    },
    setStickerRemarkV2: async (id, remark) => {
      calls.remarks.push({ id, remark });
      if (id === 'boom') throw new Error('上游炸了');
      const hit = calls.entries.find((e) => e.id === id);
      if (!hit) throw new Error('找不到表情');
      return { ...hit, desc: remark };
    },
    collectStickerV2: async (key, messageRef, remark) => {
      calls.collect.push({ key, messageRef, remark });
      return { entry: { id: 'new1' }, emojiId: 'new1', remark };
    },
    safeFetchBuffer: async () => ({ buffer: Buffer.from('png-bytes') }),
    MAX_MEDIA_BYTES: 1024,
    MAX_MEDIA_PIXELS: 100000,
    getImageDimensions: () => calls.imageDims,
    mimeFromBuffer: () => 'image/png',
    mimeFromUrl: () => 'image/jpeg',
    checkQuota: (times, opts) => { calls.quotaChecks.push(opts); return calls.quota; },
    reserveQuota: (times, n, now) => { calls.reserves.push(n); return [{ at: now }]; },
    rollbackQuota: (times, n) => { calls.rollbacks.push(n); return []; },
    syncStickerLibrary: async (force) => { calls.syncs.push(force); return { entries: calls.entries, syncedAt: calls.syncedAt, fromCache: !force }; },
    formatStickerList: (entries, query, count) => ({ total: entries.length, count, query, stickers: entries.slice(0, count) }),
    getSocialV2State: (key) => ({ key, stickerCollectTimes: [] }),
    saveSocialV2State: () => { calls.saves += 1; },
    appendActivity: (text) => { calls.activities.push(text); },
    agentTokenOk: (key, token) => token === 'good-token',
    v2SessionAllowed: () => true,
    v2ToolEnabled: (flag) => calls.enabledFlags ? calls.enabledFlags.includes(flag) : true,
    getStickerEntries: () => calls.entries,
    getStickerSyncedAt: () => calls.syncedAt,
    getStickerStoreWritable: () => calls.writable,
    ...overrides,
  };
  return { calls, ctx };
}

function run(ctx, { method = 'GET', pathname = '/api/socialV2/sticker-image', body = {}, headers = {}, query = '' } = {}) {
  ctx.req = { method, headers };
  ctx.url = new URL('http://127.0.0.1' + pathname + query);
  ctx.readBody = async () => body;
  return handleStickerRoutes(ctx);
}

test('不归本域的路径返回 false 且不写响应', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { pathname: '/api/socialV2/self-image' }), false);
  assert.equal(await run(ctx, { pathname: '/api/socialV2/prompt' }), false);
  assert.equal(await run(ctx, { pathname: '/api/stickersx' }), false);
  assert.equal(calls.sent.length, 0);
});

test('表情包体系关闭时 AI 侧三条一律 403，但控制台 /api/stickers 不受总闸影响', async () => {
  const { calls, ctx } = makeEnv();
  calls.stickerOn = false;
  const cases = [
    { method: 'GET', pathname: '/api/socialV2/sticker-image', query: '?key=private:1&stickerId=s1' },
    { method: 'POST', pathname: '/api/socialV2/collect-sticker', body: { key: 'private:1', messageId: '9' } },
    { method: 'GET', pathname: '/api/socialV2/sticker-list', query: '?key=private:1' },
  ];
  for (const c of cases) {
    assert.equal(await run(ctx, c), true);
    assert.equal(calls.sent.at(-1).status, 403);
    assert.match(calls.sent.at(-1).body.error, /表情包体系已关闭/);
  }
  // 管理端接口原本就没有 stickerEnabled 总闸（关掉 AI 侧不影响控制台整理表情库），搬迁后保持一致
  assert.equal(await run(ctx, { method: 'GET', pathname: '/api/stickers' }), true);
  assert.equal(calls.sent.at(-1).status, 200);
});

test('sticker-image：缺参 400 / token 与工具开关 403 / 成功回 base64 / 像素超限 400', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { query: '' }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  assert.equal(await run(ctx, { query: '?key=private:1&stickerId=s1', headers: { 'x-agent-token': 'bad' } }), true);
  assert.equal(calls.sent.at(-1).status, 403);
  calls.enabledFlags = ['getStickerImage'];
  assert.equal(await run(ctx, { query: '?key=private:1&stickerId=s1', headers: { 'x-agent-token': 'good-token' } }), true);
  assert.equal(calls.sent.at(-1).status, 200);
  assert.equal(calls.sent.at(-1).body.image.data, Buffer.from('png-bytes').toString('base64'));
  assert.equal(calls.sent.at(-1).body.sticker.id, 's1');
  calls.imageDims = { width: 4000, height: 4000 };
  assert.equal(await run(ctx, { query: '?key=private:1&stickerId=s1' }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  assert.match(calls.sent.at(-1).body.error, /像素超限/);
});

test('sticker-image：拉取失败回 500', async () => {
  const { calls, ctx } = makeEnv({ safeFetchBuffer: async () => { throw new Error('网络断了'); } });
  assert.equal(await run(ctx, { query: '?key=private:1&stickerId=s1' }), true);
  assert.equal(calls.sent.at(-1).status, 500);
  assert.match(calls.sent.at(-1).body.error, /网络断了/);
});

test('sticker-note：缺参 400 / 找不到 404 / 成功写 note 并记日志', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/sticker-note', body: { key: 'private:1' } }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/sticker-note', body: { key: 'private:1', stickerId: 'nope' } }), true);
  assert.equal(calls.sent.at(-1).status, 404);
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/sticker-note', body: { key: 'private:1', stickerId: 's1', note: '好图', tags: ['猫', ''], usage: '日常' } }), true);
  assert.equal(calls.sent.at(-1).status, 200);
  assert.deepEqual(calls.notes.at(-1), { id: 's1', note: '好图', tags: ['猫'], usage: '日常' });
  assert.ok(calls.logs.some((l) => l.includes('[sticker]') && l.includes('更新表情本地认知')));
});

test('sticker-remark：工具未启用 403 / 成功改备注 / 上游失败 500', async () => {
  const { calls, ctx } = makeEnv();
  calls.enabledFlags = [];
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/sticker-remark', headers: { 'x-agent-token': 'good-token' }, body: { key: 'private:1', stickerId: 's1', remark: '图' } }), true);
  assert.equal(calls.sent.at(-1).status, 403);
  assert.match(calls.sent.at(-1).body.error, /工具未启用/);
  ctx.v2ToolEnabled = () => true;
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/sticker-remark', body: { key: 'private:1', stickerId: 's1', remark: '偷了' } }), true);
  assert.equal(calls.sent.at(-1).status, 200);
  assert.equal(calls.sent.at(-1).body.sticker.desc, '偷了');
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/sticker-remark', body: { key: 'private:1', stickerId: 'boom', remark: 'x' } }), true);
  assert.equal(calls.sent.at(-1).status, 500);
});

test('collect-sticker：key 格式 400 / 收藏功能关闭 403 / 限频 429 且不预占', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/collect-sticker', body: { key: 'bad', messageId: '9' } }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  ctx.cfg.socialV2.sticker.collect.enabled = false;
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/collect-sticker', body: { key: 'private:1', messageId: '9' } }), true);
  assert.equal(calls.sent.at(-1).status, 403);
  ctx.cfg.socialV2.sticker.collect.enabled = true;
  calls.quota = { ok: false };
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/collect-sticker', body: { key: 'private:1', messageId: '9' } }), true);
  assert.equal(calls.sent.at(-1).status, 429);
  assert.equal(calls.reserves.length, 0);
  assert.equal(calls.collect.length, 0);
});

test('collect-sticker：成功先预占后保存并记 activity；失败回滚额度', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/collect-sticker', body: { key: 'private:1', messageId: '9', remark: '猫猫' } }), true);
  assert.equal(calls.sent.at(-1).status, 200);
  assert.equal(calls.reserves.length, 1);
  assert.equal(calls.saves, 1);
  assert.ok(calls.activities.some((t) => t.includes('AI 收藏表情')));
  const boom = makeEnv({ collectStickerV2: async () => { throw new Error('收藏失败'); } });
  assert.equal(await run(boom.ctx, { method: 'POST', pathname: '/api/socialV2/collect-sticker', body: { key: 'private:1', messageId: '9' } }), true);
  assert.equal(boom.calls.sent.at(-1).status, 500);
  assert.equal(boom.calls.rollbacks.length, 1);
  assert.equal(boom.calls.saves, 1);
});

test('sticker-list GET：不触发强制同步、count 受 maxListCount 夹取、key 空 400', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { pathname: '/api/socialV2/sticker-list', query: '' }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  ctx.cfg.socialV2.sticker.maxListCount = 5;
  assert.equal(await run(ctx, { pathname: '/api/socialV2/sticker-list', query: '?key=private:1&count=99' }), true);
  assert.deepEqual(calls.syncs, [false]);
  assert.equal(calls.sent.at(-1).body.count, 5);
  assert.equal(calls.sent.at(-1).body.syncedAt, 1234);
});

test('sticker-list POST：AI 强制刷新有 10 秒节流（第二次被降级为缓存）', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/sticker-list', headers: { 'x-agent-token': 'good-token' }, body: { key: 'private:1', refresh: true } }), true);
  assert.equal(calls.sent.at(-1).status, 200);
  assert.deepEqual(calls.syncs, [true]);
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/socialV2/sticker-list', headers: { 'x-agent-token': 'good-token' }, body: { key: 'private:1', refresh: true } }), true);
  assert.deepEqual(calls.syncs, [true, false]);
});

test('POST /api/stickers/sync 强制同步并回条数；GET /api/stickers 透传 writable', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/stickers/sync' }), true);
  assert.deepEqual(calls.syncs, [true]);
  assert.equal(calls.sent.at(-1).body.total, 2);
  calls.writable = false;
  assert.equal(await run(ctx, { pathname: '/api/stickers' }), true);
  assert.equal(calls.sent.at(-1).body.writable, false);
  assert.equal(calls.sent.at(-1).body.total, 2);
});

test('管理端 note 缺 stickerId 400 / remark 走 setStickerRemarkV2', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/stickers/note', body: {} }), true);
  assert.equal(calls.sent.at(-1).status, 400);
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/stickers/note', body: { stickerId: 's1', note: '图' } }), true);
  assert.equal(calls.sent.at(-1).status, 200);
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/stickers/remark', body: { stickerId: 's1', remark: '备注' } }), true);
  assert.equal(calls.remarks.at(-1).remark, '备注');
  assert.equal(calls.sent.at(-1).status, 200);
});
