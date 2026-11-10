// 控制台「二代仿真会话状态域」路由（src/console/social-state.mjs）离线测试。
// 直测 handler：构造假 ctx（不启 HTTP、不碰真实 state/），断言状态码、归一化结果与副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleSocialStateRoutes } from '../src/console/social-state.mjs';

function makeEnv(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'social-state-'));
  const socialV2 = {
    conversations: new Map(),
    paused: false,
    level: null,
    turbo: null,
    mcMode: null,
  };
  const cfg = { ownerQQ: '1946431105', socialV2: {} };
  const calls = {
    sent: [], logs: [], saves: 0, clearedTimers: 0, resets: 0,
    sleepTimers: [], proactive: [], intervalTimers: [], turboArgs: [], refreshed: 0, written: [],
  };
  const ctx = {
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/config'),
    sendJson: (body, status = 200) => { calls.sent.push({ body, status }); },
    readBody: async () => ({}),
    log: (...args) => { calls.logs.push(args.join(' ')); },
    path,
    ROOT: root,
    cfg,
    readConfigObject: (file) => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
    },
    atomicWriteJson: (file, value) => {
      calls.written.push({ file, value });
      fs.writeFileSync(file, JSON.stringify(value), 'utf8');
    },
    refreshAllDefaultWakeConfigsV2: () => { calls.refreshed += 1; },
    socialV2,
    saveSocialV2State: () => { calls.saves += 1; },
    clearAllSocialV2Timers: () => { calls.clearedTimers += 1; },
    setupSleepTimerV2: (key) => { calls.sleepTimers.push(key); },
    scheduleProactiveCheckV2: (key) => { calls.proactive.push(key); },
    setupIntervalTimerV2: (key) => { calls.intervalTimers.push(key); },
    checkProactiveThrottleV2: () => ({ ok: false, reason: 'minGap', minGapMs: 1200000, maxPerDay: 16, todayCount: 3, gapLeftMs: 540000 }),
    turboStatusV2: () => ({ on: !!socialV2.turbo, remainMinutes: 12, focus: '', focusLabel: '', everyMinutes: 10, costTurboCny: 0.5 }),
    setTurboV2: (on, hours, by, intervalMinutes, focus) => {
      calls.turboArgs.push({ on, hours, by, intervalMinutes, focus });
      socialV2.turbo = on ? { on: true, hours } : null;
      return { on: !!on, hours };
    },
    turboActiveV2: () => !!socialV2.turbo,
    turboFocusV2: () => 'phone',
    mcModeActiveV2: () => !!socialV2.mcMode,
    ACTIVE_LEVELS: [{ id: 'moyu', label: '摸鱼', minutes: 30 }, { id: 'normal', label: '正常', minutes: 10 }],
    readActivityV2: () => ({ doing: '画画', at: 1 }),
    readFeelV2: () => ({ mood: '开心', affinity: 10 }),
    isConversationBusyV2: () => false,
    getSocialV2State: (key) => ({
      wakeConfig: { everyMinutes: 10 }, unread: [{ id: 1 }], recentMessages: [{ id: 2 }, { id: 3 }],
      lastWakeReason: 'message', lastAiReplyAt: Date.now() - 1000,
    }),
    computeWakeSafetyV2: () => ({ safe: true }),
    agentTokenOk: (key, token) => token === 'good-token',
    v2SessionAllowed: () => true,
    v2ToolEnabled: (flag) => (flag === 'socialState' ? true : false),
    resetSocialV2AllStateV2: () => { calls.resets += 1; },
    ...overrides,
  };
  return { root, socialV2, cfg, calls, ctx };
}

function run(ctx, { method = 'GET', pathname = '/api/socialV2/config', body = {}, headers = {}, query = '' } = {}) {
  ctx.req = { method, headers };
  ctx.url = new URL('http://127.0.0.1' + pathname + query);
  ctx.readBody = async () => body;
  return handleSocialStateRoutes(ctx);
}

test('不归本域的路径返回 false 且不写响应', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { pathname: '/api/status' }), false);
  assert.equal(await run(ctx, { pathname: '/api/socialV2/prompt' }), false);
  assert.equal(await run(ctx, { pathname: '/api/socialV2/configx' }), false);
  assert.equal(calls.sent.length, 0);
});

test('GET config 返回运行时 socialV2 配置', async () => {
  const { calls, cfg, ctx } = makeEnv();
  cfg.socialV2 = { enabled: true };
  assert.equal(await run(ctx), true);
  assert.deepEqual(calls.sent.at(-1).body, { ok: true, config: { enabled: true } });
});

test('POST config：tools 只收布尔，且默认关闭的工具不会被一次保存静默打开', async () => {
  const { root, cfg, calls, ctx } = makeEnv();
  cfg.socialV2 = { tools: { setStickerRemark: false, sendVoice: false }, send: {} };
  // 文件里没有 socialV2 段 —— 必须回落到 cfg.socialV2，否则 current={} 会把两个默认关闭的开关打开
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ownerQQ: '1' }), 'utf8');
  assert.equal(await run(ctx, { method: 'POST', body: { tools: { getUnread: true, sendGroup: 'yes' } } }), true);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(saved.socialV2.tools.getUnread, true);
  assert.equal(saved.socialV2.tools.sendGroup, true);
  assert.equal(saved.socialV2.tools.setStickerRemark, false);
  assert.equal(saved.socialV2.tools.sendVoice, false);
  assert.equal(calls.sent.at(-1).status, 200);
  assert.ok(calls.logs.some((l) => l.includes('二代仿真配置已更新')));
});

test('POST config：wake/send 概率夹 0~1、数值非负取整、defaultMode 归一', async () => {
  const { cfg, ctx } = makeEnv();
  cfg.socialV2 = { wake: {}, send: {} };
  await run(ctx, {
    method: 'POST',
    body: {
      wake: { sleepMinMs: -5, recommendedProbability: 3, defaultMode: 'whatever' },
      send: { longGapProbability: -1, burstMaxMessages: 2.7 },
    },
  });
  assert.equal(cfg.socialV2.wake.sleepMinMs, 0);
  assert.equal(cfg.socialV2.wake.recommendedProbability, 1);
  assert.equal(cfg.socialV2.wake.defaultMode, 'diving');
  assert.equal(cfg.socialV2.send.longGapProbability, 0);
  assert.equal(cfg.socialV2.send.burstMaxMessages, 3);
});

test('POST config：只有影响默认唤醒配置的 wake 字段才刷新会话', async () => {
  const a = makeEnv();
  a.cfg.socialV2 = { wake: {} };
  await run(a.ctx, { method: 'POST', body: { wake: { sleepMinMs: 1000 } } });
  assert.equal(a.calls.refreshed, 1);

  const b = makeEnv();
  b.cfg.socialV2 = { wake: {}, send: {} };
  await run(b.ctx, { method: 'POST', body: { send: { maxSendPerMinute: 3 } } });
  assert.equal(b.calls.refreshed, 0);
});

test('POST activity：暂停会关掉超活跃模式并清定时器', async () => {
  const { socialV2, calls, ctx } = makeEnv();
  socialV2.turbo = { hours: 2 };
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/activity', body: { paused: true } });
  assert.equal(socialV2.paused, true);
  assert.equal(socialV2.turbo, null);
  assert.equal(calls.clearedTimers, 1);
  assert.equal(calls.saves, 1);
  assert.ok(calls.logs.some((l) => l.includes('超活跃模式自动关闭')));
  assert.deepEqual(calls.sent.at(-1).body, { ok: true, paused: true });
});

test('POST activity：恢复时给每个会话重设潜水与主动机会定时器', async () => {
  const { socialV2, calls, ctx } = makeEnv();
  socialV2.conversations.set('group:1', {});
  socialV2.conversations.set('private:2', {});
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/activity', body: { paused: false } });
  assert.equal(socialV2.paused, false);
  assert.deepEqual(calls.sleepTimers, ['group:1', 'private:2']);
  assert.deepEqual(calls.proactive, ['group:1', 'private:2']);
  assert.equal(calls.saves, 1);
});

test('turbo：GET 透出状态，POST 把参数原样交给 setTurboV2', async () => {
  const { calls, ctx } = makeEnv();
  await run(ctx, { pathname: '/api/socialV2/turbo' });
  assert.equal(calls.sent.at(-1).body.ok, true);
  assert.equal(calls.sent.at(-1).body.on, false);

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/turbo', body: { on: true, hours: 1.5, intervalMinutes: 5, focus: 'mc' } });
  assert.deepEqual(calls.turboArgs.at(-1), { on: true, hours: 1.5, by: 'console', intervalMinutes: 5, focus: 'mc' });
});

test('level：命中档位写进每个会话；minutes<=0 关闭档位', async () => {
  const { socialV2, calls, ctx } = makeEnv();
  socialV2.conversations.set('group:1', {});
  socialV2.conversations.set('private:2', { wakeConfig: { everyMinutes: 99 } });
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/level', body: { level: 'moyu' } });
  assert.deepEqual(socialV2.level, { id: 'moyu', label: '摸鱼', minutes: 30 });
  assert.equal(socialV2.conversations.get('group:1').wakeConfig.everyMinutes, 30);
  assert.equal(socialV2.conversations.get('private:2').wakeConfig.everyMinutes, 30);
  assert.deepEqual(calls.intervalTimers, ['group:1', 'private:2']);

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/level', body: { level: 'custom', minutes: 999 } });
  assert.equal(socialV2.level.minutes, 720);
  assert.equal(socialV2.level.label, '自定义');

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/level', body: { minutes: 0 } });
  assert.equal(socialV2.level, null);
});

test('GET state：缺 key / token 错 / 工具关都按原状态码拒绝，正常时回会话摘要', async () => {
  const { calls, ctx } = makeEnv();
  await run(ctx, { pathname: '/api/socialV2/state', query: '?key=' });
  assert.equal(calls.sent.at(-1).status, 400);
  assert.equal(calls.sent.at(-1).body.error, 'key 不能为空');

  await run(ctx, { pathname: '/api/socialV2/state', query: '?key=group:1', headers: { 'x-agent-token': 'bad' } });
  assert.equal(calls.sent.at(-1).status, 403);
  assert.equal(calls.sent.at(-1).body.error, 'agent token 无效');

  const off = makeEnv({ v2ToolEnabled: () => false });
  await run(off.ctx, { pathname: '/api/socialV2/state', query: '?key=group:1', headers: { 'x-agent-token': 'good-token' } });
  assert.equal(off.calls.sent.at(-1).status, 403);
  assert.equal(off.calls.sent.at(-1).body.error, '工具未启用：qq_social_state');

  await run(ctx, { pathname: '/api/socialV2/state', query: '?key=group:1', headers: { 'x-agent-token': 'good-token' } });
  const body = calls.sent.at(-1).body;
  assert.equal(body.key, 'group:1');
  assert.equal(body.unreadCount, 1);
  assert.equal(body.recentCount, 2);
  assert.deepEqual(body.wakeSafety, { safe: true });
});

test('GET self：聚合她在干嘛（含 mc 状态与在玩什么）', async () => {
  const { socialV2, calls, ctx } = makeEnv();
  socialV2.turbo = { hours: 1 };
  socialV2.level = { id: 'normal', label: '正常', minutes: 10 };
  await run(ctx, { pathname: '/api/socialV2/self' });
  const body = calls.sent.at(-1).body;
  assert.equal(body.ok, true);
  assert.equal(body.activity.doing, '画画');
  assert.equal(body.feel.mood, '开心');
  assert.equal(body.paused, false);
  assert.equal(body.level.label, '正常');
  assert.equal(body.playing.everyMinutes, 10);
  assert.equal(typeof body.mc.alive, 'boolean');
  assert.equal(typeof body.mc.queue, 'number');
  // 手机桌宠页要显示「她主动找你」的额度：今天已开口几次 / 上限 / 还要等多久
  assert.equal(body.key, 'private:1946431105', 'self 要回会话 key，页里不写死 QQ 号');
  assert.equal(body.proactive.todayCount, 3);
  assert.equal(body.proactive.maxPerDay, 16);
  assert.equal(body.proactive.gapLeftMs, 540000);
  assert.equal(body.proactive.enabled, true);
});

test('GET self：拿不到节流信息时 proactive 为 null，不抛异常', async () => {
  const env = makeEnv();
  delete env.ctx.checkProactiveThrottleV2;
  await run(env.ctx, { pathname: '/api/socialV2/self' });
  assert.equal(env.calls.sent.at(-1).body.ok, true);
  assert.equal(env.calls.sent.at(-1).body.proactive, null);
});

test('GET mc-mode 与 reset', async () => {
  const { socialV2, calls, ctx } = makeEnv();
  socialV2.mcMode = { on: true };
  socialV2.turbo = { hours: 1 };
  await run(ctx, { pathname: '/api/socialV2/mc-mode' });
  const mode = calls.sent.at(-1).body;
  assert.equal(mode.on, true);
  assert.deepEqual(mode.mcMode, { on: true });
  assert.equal(mode.focus, 'phone');

  await run(ctx, { method: 'POST', pathname: '/api/socialV2/reset' });
  assert.equal(calls.resets, 1);
  assert.deepEqual(calls.sent.at(-1).body, { ok: true });
});
