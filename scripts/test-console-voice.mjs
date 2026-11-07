// 控制台「语音」域路由（src/console/voice.mjs）离线测试。
// 直测 handler：构造假 ctx（不启 HTTP、不碰真实语音库/state），断言状态码、响应体与副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { handleVoiceRoutes } from '../src/console/voice.mjs';

const VOICE_DIR = 'D:/qq-bridge/voice';
const FILE = VOICE_DIR + '/hello.mp3';

function makeEnv(overrides = {}) {
  const calls = { sent: [], logs: [], activities: [], budgetChecks: [], commits: [], checkedModes: [] };
  const cfg = { allow: { groups: [111], private: [222] } };
  const state = { mode: 'reserved2' };
  const ctx = {
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/voices'),
    sendJson: (body, status = 200) => { calls.sent.push({ body, status }); },
    readBody: async () => ({}),
    log: (m) => { calls.logs.push(String(m)); },
    cfg,
    path,
    get currentMode() { return state.mode; },
    voiceCfg: () => ({
      enabled: state.voiceEnabled !== false,
      dir: VOICE_DIR,
      maxSeconds: 60,
      maxBytes: 5 * 1024 * 1024,
      maxPerMinute: 3,
      maxPerHour: 20,
      ffmpegPath: 'ffmpeg',
      defaultVolume: 1,
      loudness: null
    }),
    modeAllowed: () => state.targetAllowed !== false,
    parseTargetKey: (key) => {
      const m = /^(group|private):(\d+)$/.exec(key);
      return m ? { kind: m[1], id: m[2] } : null;
    },
    resolveVoicePathForOperator: (f) => {
      if (!f) throw new Error('file 不能为空');
      return { path: FILE, via: 'library' };
    },
    resolveVoicePathForV2: (f) => {
      if (!f) throw new Error('voice 不能为空');
      return { path: FILE, via: 'library' };
    },
    resolveAudioProcessing: () => ({}),
    inspectAudio: async () => ({ ok: true, size: 1024, duration: 1.5, codec: 'mp3', warnings: [] }),
    describeAudio: () => '1.5s mp3 1KB',
    sendVoiceV2: async () => ({ messageId: 900, detail: '1.5s mp3', audioMode: 'original', audioProcessing: 'original', volume: 1, loudness: null }),
    sendVoiceForV2: async () => ({ messageId: 901, detail: '1.5s mp3', file: FILE, audioProcessing: 'original', warnings: [], verification: { confirmed: true }, readback: null }),
    verifyVoiceMessageSent: async () => ({ confirmed: true }),
    voiceBudgetCheck: (k) => { calls.budgetChecks.push(k); },
    voiceBudgetCommit: (k) => { calls.commits.push(k); },
    listAudioFiles: () => [FILE, VOICE_DIR + '/two.mp3'],
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    shouldBlockSilentReply: () => false,
    appendActivity: (s) => { calls.activities.push(s); },
    ...overrides
  };
  return { calls, ctx, state, cfg };
}

function run(ctx, { method = 'GET', pathname = '/api/socialV2/voices', body = {}, headers = {}, search = '' } = {}) {
  ctx.req = { method, headers };
  ctx.url = new URL('http://127.0.0.1' + pathname + search);
  ctx.readBody = async () => body;
  return handleVoiceRoutes(ctx);
}

test('不归本域的路径返回 false 且不写响应', async () => {
  const { calls, ctx } = makeEnv();
  assert.equal(await run(ctx, { pathname: '/api/status' }), false);
  assert.equal(await run(ctx, { pathname: '/api/socialV2/send-images' }), false);
  assert.equal(calls.sent.length, 0);
});

test('/api/send/voice 带 agent token 一律 403（不许借操作者通道绕过"只能发自己会话"）', async () => {
  const { calls, ctx } = makeEnv();
  const ok = await run(ctx, { method: 'POST', pathname: '/api/send/voice', body: { target: 'group:111' }, headers: { 'x-agent-token': 'tok' } });
  assert.equal(ok, true);
  assert.equal(calls.sent.at(-1).status, 403);
  assert.match(calls.sent.at(-1).body.error, /socialV2\/send-voice/);
});

test('操作者通道：target 格式错 400 / 不在白名单 403', async () => {
  const { calls, ctx, state } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/voice/send', body: { target: 'oops', file: 'a.mp3' } });
  assert.equal(calls.sent.at(-1).status, 400);
  assert.match(calls.sent.at(-1).body.error, /target 格式/);
  state.targetAllowed = false;
  await run(ctx, { method: 'POST', pathname: '/api/voice/send', body: { target: 'group:999', file: 'a.mp3' } });
  assert.equal(calls.sent.at(-1).status, 403);
  assert.match(calls.sent.at(-1).body.error, /不在白名单内/);
});

test('操作者通道：dryRun 只回预览，不记账不发送', async () => {
  const { calls, ctx } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/voice/send', body: { target: 'group:111', file: 'a.mp3', dryRun: true } });
  const last = calls.sent.at(-1);
  assert.equal(last.status, 200);
  assert.equal(last.body.dryRun, true);
  assert.equal(last.body.key, 'group:111');
  assert.equal(last.body.detail, '1.5s mp3 1KB');
  assert.equal(calls.budgetChecks.length, 0);
  assert.equal(calls.commits.length, 0);
});

test('操作者通道：正常发送记账 + 写活动 + 返回 verified', async () => {
  const { calls, ctx } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/voice/send', body: { target: 'group:111', file: 'a.mp3' } });
  const last = calls.sent.at(-1);
  assert.equal(last.status, 200);
  assert.equal(last.body.messageId, 900);
  assert.equal(last.body.verified, true);
  assert.deepEqual(calls.budgetChecks, ['operator:cli']);
  assert.deepEqual(calls.commits, ['operator:cli']);
  assert.equal(calls.activities.length, 1);
  assert.match(calls.activities[0], /\[voice\]/);
});

test('AI 通道：语音关闭 403 / 非 reserved2 403 / 缺 token 403 / 缺 key 400', async () => {
  const { calls, ctx, state } = makeEnv();
  state.voiceEnabled = false;
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/send-voice', body: { key: 'group:111', token: 't', voice: 'a.mp3' } });
  assert.equal(calls.sent.at(-1).status, 403);
  assert.match(calls.sent.at(-1).body.error, /语音功能已关闭/);
  state.voiceEnabled = true;
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/send-voice', body: { voice: 'a.mp3' } });
  assert.equal(calls.sent.at(-1).status, 400);
  assert.match(calls.sent.at(-1).body.error, /key 不能为空/);
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/send-voice', body: { key: 'group:111', voice: 'a.mp3' }, headers: {} });
  assert.equal(calls.sent.at(-1).status, 403);
  assert.match(calls.sent.at(-1).body.error, /必须携带 agent token/);
  state.mode = 'closed';
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/send-voice', body: { key: 'group:111', token: 't', voice: 'a.mp3' } });
  assert.equal(calls.sent.at(-1).status, 403);
  assert.match(calls.sent.at(-1).body.error, /reserved2/);
});

test('AI 通道：工具开关 / 静默模式 / agent token 三道闸', async () => {
  const { calls, ctx } = makeEnv({
    v2ToolEnabled: () => false
  });
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/send-voice', body: { key: 'group:111', token: 't', voice: 'a.mp3' } });
  assert.equal(calls.sent.at(-1).status, 403);
  assert.match(calls.sent.at(-1).body.error, /qq_send_voice/);

  const env2 = makeEnv({ agentTokenOk: () => false });
  await run(env2.ctx, { method: 'POST', pathname: '/api/socialV2/send-voice', body: { key: 'group:111', token: 'bad', voice: 'a.mp3' } });
  assert.equal(env2.calls.sent.at(-1).status, 403);
  assert.match(env2.calls.sent.at(-1).body.error, /agent token 无效/);

  const env3 = makeEnv({ shouldBlockSilentReply: () => true });
  await run(env3.ctx, { method: 'POST', pathname: '/api/socialV2/send-voice', body: { key: 'group:111', token: 't', voice: 'a.mp3' } });
  assert.equal(env3.calls.sent.at(-1).status, 403);
  assert.match(env3.calls.sent.at(-1).body.error, /静默模式/);
});

test('AI 通道：dryRun 只探测不发送', async () => {
  const { calls, ctx } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/send-voice', body: { key: 'group:111', token: 't', voice: 'a.mp3', dryRun: true } });
  const last = calls.sent.at(-1);
  assert.equal(last.status, 200);
  assert.equal(last.body.dryRun, true);
  assert.equal(last.body.file, FILE);
  // 原码顺序：先 voiceBudgetCheck 预占额度，再判 dryRun —— 所以 check=1、commit=0
  assert.equal(calls.budgetChecks.length, 1);
  assert.equal(calls.commits.length, 0);
});

test('AI 通道：正常发送返回 verified 与 audioProcessing', async () => {
  const { calls, ctx } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/socialV2/send-voice', body: { key: 'group:111', token: 't', voice: 'a.mp3' } });
  const last = calls.sent.at(-1);
  assert.equal(last.status, 200);
  assert.equal(last.body.messageId, 901);
  assert.equal(last.body.verified, true);
  assert.equal(last.body.file, 'hello.mp3');
  assert.deepEqual(calls.budgetChecks, ['group:111']);
});

test('语音库列表：控制台通道不需要 key，且响应里不含目录绝对路径', async () => {
  const { calls, ctx } = makeEnv();
  await run(ctx, { method: 'GET', pathname: '/api/socialV2/voices', search: '?probe=0' });
  const last = calls.sent.at(-1);
  assert.equal(last.status, 200);
  assert.equal(last.body.count, 2);
  assert.equal(last.body.dir, VOICE_DIR);
  assert.ok(!JSON.stringify(last.body.voices).includes(VOICE_DIR), '列表项只能是相对文件名');
  assert.match(last.body.hint, /qq_send_voice/);
});

test('语音库列表：agent 通道缺 key 400 / 工具关闭 403 / key 无效 403', async () => {
  const { calls, ctx } = makeEnv();
  await run(ctx, { method: 'GET', pathname: '/api/socialV2/voices', headers: { 'x-agent-token': 't' } });
  assert.equal(calls.sent.at(-1).status, 400);
  assert.match(calls.sent.at(-1).body.error, /key 不能为空/);

  const env2 = makeEnv({ v2ToolEnabled: () => false });
  await run(env2.ctx, { method: 'GET', pathname: '/api/socialV2/voices', search: '?key=group:111', headers: { 'x-agent-token': 't' } });
  assert.equal(env2.calls.sent.at(-1).status, 403);
  assert.match(env2.calls.sent.at(-1).body.error, /qq_send_voice/);

  const env3 = makeEnv({ agentTokenOk: () => false });
  await run(env3.ctx, { method: 'GET', pathname: '/api/socialV2/voices', search: '?key=group:111', headers: { 'x-agent-token': 'bad' } });
  assert.equal(env3.calls.sent.at(-1).status, 403);
  assert.match(env3.calls.sent.at(-1).body.error, /agent token 无效/);
});
