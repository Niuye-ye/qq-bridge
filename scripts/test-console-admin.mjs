import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleAdminRoutes } from '../src/console/admin.mjs';

// ── 假 ctx：只实现被管理端路由用到的那一小撮 ─────────────────────────────
function makeEnv(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-'));
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'deepseek娘.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const sent = [];
  const logs = [];
  const env = {
    root,
    sent,
    logs,
    body: {},
    headers: {},
    url: { pathname: '/api/status', searchParams: new URLSearchParams() },
    req: { method: 'GET', headers: {}, on() {} },
    res: { on() {} },
    cfg: {
      ownerQQ: '1946431105',
      allow: { private: ['1946431105'], groups: ['123'] },
      deny: { private: [], groups: [] },
      security: { interceptNotify: true },
      socialV2: { paused: false, wait: {}, send: {}, feedback: { maxLength: 20 } },
    },
    social: { enabled: false },
    socialV2: { paused: false, tools: {} },
    currentMode: 'reserved2',
    closedAgentPreset: '',
    dshReady: true,
    ROOT: root,
    STATE_DIR: path.join(root, 'state'),
    FEEDBACK_FILE: path.join(root, 'state', 'feedback.json'),
    PRESET_BACKUP_DIR: path.join(root, 'state', 'preset-backups'),
    PRESET_NAMES: { v1: 'qq-v1', v2: 'qq-v2' },
    ACTIVE_WAIT_LEASE_MS: 15 * 60 * 1000,
    pending: new Map(),
    activeWaits: new Map(),
    feedbackTimes: new Map(),
    initialPrompts: new Map(),
    initialPromptsWritable: true,
    stateDirHardened: true,
    setStateDirHardened: (v) => { env.stateDirHardened = v; },
    getStateDirHardened: () => env.stateDirHardened,
    state: { sessions: { 'private:1946431105': 'session-a' }, sessionPolicies: {} },
    bot: {
      async request(action) {
        env.calls.push(['bot.request', action]);
        return { data: [{ group_id: 123, group_name: '测试群' }, { group_id: 999, group_name: '白名单外' }] };
      },
      async sendPrivateMessage(id, msg) { return { message_id: 42 }; },
      async sendGroupMessage(id, msg) { return { message_id: 43 }; },
    },
    api: {
      agentPresets: {
        async list() {
          return { result: { ok: true, value: { presets: [{ id: 'standard', trust: 'system' }, { id: 'custom' }] } } };
        },
      },
    },
    calls: [],
    sendJson: (payload, status = 200) => sent.push({ payload, status }),
    readBody: async () => env.body,
    log: (m) => logs.push(String(m)),
    readRoleState: () => ({ role: '小鲸鱼', mode: 'active' }),
    snowlumaHealthSnapshot: () => ({ state: 'ok' }),
    readActivityTail: () => [{ text: '活动' }],
    readConfigObject: () => ({}),
    atomicWriteJson: (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); },
    atomicWriteText: (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v); },
    hardenStateDirAcl: () => { env.calls.push(['hardenStateDirAcl']); env.stateDirHardened = true; },
    allowed: (kind, id) => kind === 'group' ? String(id) === '123' : String(id) === '1946431105',
    modeAllowed: () => true,
    normalizeOwnerQQ: (v) => {
      const n = Number(String(v ?? '').trim());
      if (!Number.isFinite(n) || n <= 0) throw new Error('ownerQQ 必须是正整数');
      return n;
    },
    reconcileSessionPolicies: () => { env.calls.push(['reconcileSessionPolicies']); },
    escapeCqText: (s) => s,
    redactKnownTokensOnly: (s) => s,
    mimeFromBuffer: () => 'image/png',
    // initial-prompt
    canonicalV2Key: (key) => {
      const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
      if (!m) return null;
      return m[1] + ':' + String(Number(m[2]));
    },
    initialPromptMaxChars: () => 2000,
    setInitialPrompt: (key, text) => {
      const canonical = env.canonicalV2Key(key);
      if (!canonical) return { ok: false, error: 'key 格式应为 group:群号 或 private:QQ号', statusCode: 400 };
      if (text === '') { env.initialPrompts.delete(canonical); return { ok: true, key: canonical, deleted: true, chars: 0, entry: null }; }
      const entry = { text, createdAt: 1, updatedAt: 2 };
      env.initialPrompts.set(canonical, entry);
      return { ok: true, key: canonical, deleted: false, chars: text.length, entry };
    },
    // 反馈
    readFeedbackEntries: () => [{ id: 'x', message: '反馈' }],
    appendFeedbackEntry: (entry) => { env.calls.push(['appendFeedbackEntry', entry]); },
    appendActivity: () => {},
    // 等待
    getSocialV2State: () => ({ unread: [], readThroughSeq: 7, sendTimes: [], wakeConfig: { noActionCount: 1 } }),
    readThroughSeqV2: (st) => st.readThroughSeq ?? 0,
    suggestQuietMsV2: () => 1000,
    noteModelMessagesV2: () => {},
    computeWakeSafetyV2: () => ({}),
    preSleepWaitBlockedV2: () => false,
    // 发送
    getStickerEntries: () => [],
    getSlangEntries: () => [],
    getCurrentMode: () => env.currentMode,
    getState: () => env.state,
    sendMessagesV2: async (key, messages) => messages.map((m, i) => ({ id: 100 + i, text: m })),
    recordSentMessagesV2: () => { env.calls.push(['recordSentMessagesV2']); },
    saveSocialV2State: () => { env.calls.push(['saveSocialV2State']); },
    scheduleReplyCheckV2: () => { env.calls.push(['scheduleReplyCheckV2']); },
    shouldBlockSilentReply: () => false,
    resolveReplyTargetV2: async () => ({ info: {}, messageId: 300 }),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    agentTokenOk: (key, token) => token === 'good',
    unquoteJsonString: (s) => s,
    sleep: async () => {},
    stickerEnabled: () => true,
    syncStickerLibrary: async () => ({ entries: [] }),
    captureDeviceScreenshotV2: async () => Buffer.from('png'),
    knownPresetName: () => null,
    presetStatus: () => ({}),
    readPresetPromptText: () => ({ text: 'x', prefix: 'x' }),
    listPresetBackups: () => [],
    presetSourceYaml: () => path.join(root, 'preset.yaml'),
    installedPresetYaml: () => path.join(root, 'installed.yaml'),
    backupPresetFile: () => path.join(root, 'backup.yaml'),
  };
  Object.assign(env, opts);
  env.url = { pathname: env.url.pathname, searchParams: env.url.searchParams };
  return env;
}

async function call(env, pathname, method, body, opts = {}) {
  env.url = { pathname, searchParams: new URLSearchParams(opts.query ?? {}) };
  env.req = { method, headers: env.headers ?? {}, on() {} };
  env.body = body ?? {};
  env.sent.length = 0;
  const handled = await handleAdminRoutes(env);
  return { handled, last: env.sent.at(-1) };
}

test('非本域路由返回 false 且不回包', async () => {
  const env = makeEnv();
  const { handled } = await call(env, '/api/socialV2/unread', 'GET');
  assert.equal(handled, false);
  assert.equal(env.sent.length, 0);
});

test('status：操作者视图带 snowluma 与白名单，智能体视图不带', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/status', 'GET');
  assert.equal(r.handled, true);
  assert.equal(r.last.payload.ownerQQ, '1946431105');
  assert.ok(r.last.payload.snowluma);

  env.headers = { 'x-agent-token': 'good' };
  r = await call(env, '/api/status', 'GET');
  assert.equal(r.last.payload.ownerQQ, undefined);
  assert.equal(r.last.payload.snowluma, undefined);
  assert.equal(r.last.payload.mode, 'reserved2');
});

test('presets：unwrap 取列表，失败时回空数组而不 500', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/presets', 'GET');
  assert.deepEqual(r.last.payload.presets, [{ id: 'standard', trust: 'system' }, { id: 'custom', trust: 'system' }]);

  env.api = { agentPresets: { async list() { throw new Error('dsh down'); } } };
  r = await call(env, '/api/presets', 'GET');
  assert.equal(r.last.status, 200);
  assert.deepEqual(r.last.payload.presets, []);
});

test('sessions / pending：读 getState().sessions 与 pending Map', async () => {
  const env = makeEnv();
  env.pending.set('group:123', { kind: 'approval', sessionId: 's1', toolName: 'bash', reason: 'r', approvalId: 'a1', extra: 'x' });
  env.pending.set('group:123', { kind: 'question', sessionId: 's2', questions: [{ id: 'q' }] });
  let r = await call(env, '/api/sessions', 'GET');
  assert.deepEqual(r.last.payload.sessions, [{ key: 'private:1946431105', sessionId: 'session-a', owner: true }]);
  r = await call(env, '/api/pending', 'GET');
  assert.equal(r.last.payload.pending.length, 1);
  assert.equal(r.last.payload.pending[0].questions[0].id, 'q');
});

test('whitelist：写盘时数字归一、去重，非法 ownerQQ 拒绝写入', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/whitelist', 'GET');
  assert.deepEqual(r.last.payload.allow.groups, ['123']);

  r = await call(env, '/api/whitelist', 'POST', { allow: { private: ['1946431105', ' 1946431105 ', 'abc'], groups: [] }, ownerQQ: '1946431105' });
  assert.equal(r.last.payload.ok, true);
  assert.deepEqual(r.last.payload.allow.private, [1946431105]);
  assert.equal(env.cfg.ownerQQ, 1946431105);

  r = await call(env, '/api/whitelist', 'POST', { ownerQQ: 'abc' });
  assert.equal(r.last.status, 400);
  assert.match(r.last.payload.error, /ownerQQ/);
});

test('security：GET 给出可复制的手工 ACL 命令，POST rehardenStateDir 触发重试', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/security', 'GET');
  assert.equal(r.last.payload.stateDir.hardened, true);
  assert.match(r.last.payload.stateDir.manualCommand, /icacls/i);

  r = await call(env, '/api/security', 'POST', { rehardenStateDir: true });
  assert.ok(env.calls.some((c) => c[0] === 'hardenStateDirAcl'));
  assert.equal(r.last.payload.hardened, true);
});

test('test-send：id/空白/白名单/模式四道闸 + 成功回 message_id', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/test-send', 'POST', { id: 0, message: 'hi' });
  assert.equal(r.last.status, 400);
  r = await call(env, '/api/test-send', 'POST', { id: 123, message: '  ' });
  assert.equal(r.last.status, 400);
  r = await call(env, '/api/test-send', 'POST', { kind: 'group', id: 999, message: 'hi' });
  assert.equal(r.last.status, 403);
  assert.match(r.last.payload.error, /白名单/);
  env.modeAllowed = () => false;
  r = await call(env, '/api/test-send', 'POST', { kind: 'group', id: 123, message: 'hi' });
  assert.equal(r.last.status, 403);
  env.modeAllowed = () => true;
  r = await call(env, '/api/test-send', 'POST', { kind: 'group', id: 123, message: 'hi' });
  assert.equal(r.last.payload.message_id, 43);
});

test('initial-prompt：缺 text 不当清空；delete:true 才删；key 非法 400', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/socialV2/initial-prompt', 'POST', { key: 'group:123' });
  assert.equal(r.last.status, 400);
  assert.match(r.last.payload.error, /text 必须是字符串/);

  r = await call(env, '/api/socialV2/initial-prompt', 'POST', { key: 'group:123', text: '你好' });
  assert.equal(r.last.payload.ok, true);
  assert.equal(env.initialPrompts.get('group:123').text, '你好');

  r = await call(env, '/api/socialV2/initial-prompt', 'POST', { key: 'group:123', delete: true });
  assert.equal(r.last.payload.deleted, true);
  assert.equal(env.initialPrompts.has('group:123'), false);

  r = await call(env, '/api/socialV2/initial-prompt', 'GET', null, { query: { key: 'bad' } });
  assert.equal(r.last.status, 400);
});

test('self-image：缺 key 400，存在图时回 base64', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/socialV2/self-image', 'GET');
  assert.equal(r.last.status, 400);
  r = await call(env, '/api/socialV2/self-image', 'GET', null, { query: { key: 'private:1' } });
  assert.equal(r.last.payload.ok, true);
  assert.equal(r.last.payload.image.mimeType, 'image/png');
});

test('groups：非 reserved2、无 token 两道闸，成功后按白名单过滤', async () => {
  const env = makeEnv({ currentMode: 'chat' });
  let r = await call(env, '/api/socialV2/groups', 'POST', { key: 'group:123' });
  assert.equal(r.last.status, 403);
  assert.match(r.last.payload.error, /reserved2/);

  env.currentMode = 'reserved2';
  r = await call(env, '/api/socialV2/groups', 'POST', { key: 'group:123' });
  assert.equal(r.last.status, 403);
  assert.match(r.last.payload.error, /必须携带 agent token/);

  env.headers = { 'x-agent-token': 'good' };
  r = await call(env, '/api/socialV2/groups', 'POST', { key: 'group:123' });
  assert.equal(r.last.payload.total, 1);
  assert.equal(r.last.payload.groups[0].group_id, 123);
});

test('screen：非 reserved2 403，缺 key 400', async () => {
  const env = makeEnv({ currentMode: 'chat' });
  let r = await call(env, '/api/socialV2/screen', 'POST', {});
  assert.equal(r.last.status, 403);
  env.currentMode = 'reserved2';
  r = await call(env, '/api/socialV2/screen', 'POST', {});
  assert.equal(r.last.status, 400);
});

test('feedback：缺参 400、限频 429、成功时按 maxLength 截断', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/socialV2/feedback', 'POST', { key: 'group:123' });
  assert.equal(r.last.status, 400);

  r = await call(env, '/api/socialV2/feedback', 'POST', { key: 'group:123', message: 'x'.repeat(100), level: 'error' });
  assert.equal(r.last.payload.ok, true);
  assert.equal(r.last.payload.message.length, 20);
  assert.equal(r.last.payload.level, 'error');

  env.feedbackTimes.set('group:123', Array.from({ length: 5 }, () => Date.now()));
  r = await call(env, '/api/socialV2/feedback', 'POST', { key: 'group:123', message: '再来一条' });
  assert.equal(r.last.status, 429);
});

test('feedback-clear：带 agent token 只允许控制台调用', async () => {
  const env = makeEnv();
  env.headers = { 'x-agent-token': 'good' };
  const r = await call(env, '/api/socialV2/feedback-clear', 'POST');
  assert.equal(r.last.status, 403);
});

test('authorize/read：key 格式、空 token 两道闸，通过后回 ok', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/authorize/read', 'POST', { key: 'bad', token: 'good' });
  assert.equal(r.last.status, 400);
  r = await call(env, '/api/authorize/read', 'POST', { key: 'group:123', token: '' });
  assert.equal(r.last.status, 403);
  r = await call(env, '/api/authorize/read', 'POST', { key: 'group:123', token: 'good' });
  assert.equal(r.last.payload.ok, true);
  assert.equal(r.last.payload.key, 'group:123');
});

test('send/group：chat 模式 403，paused 403，reserved2 无 token 403，成功走 sendMessagesV2', async () => {
  const env = makeEnv({ currentMode: 'chat' });
  let r = await call(env, '/api/send/group', 'POST', { groupId: '123', message: 'hi' });
  assert.equal(r.last.status, 403);

  env.currentMode = 'reserved2';
  r = await call(env, '/api/send/group', 'POST', { groupId: '123', message: 'hi' });
  assert.equal(r.last.status, 403);
  assert.match(r.last.payload.error, /必须携带 agent token/);

  env.headers = { 'x-agent-token': 'good' };
  env.socialV2.paused = true;
  r = await call(env, '/api/send/group', 'POST', { groupId: '123', message: 'hi', token: 'good' });
  assert.equal(r.last.status, 403);
  assert.match(r.last.payload.error, /已暂停/);

  env.socialV2.paused = false;
  r = await call(env, '/api/send/group', 'POST', { groupId: '123', message: 'hi', token: 'good' });
  assert.equal(r.last.payload.ok, true);
  assert.equal(r.last.payload.sent, 1);
  assert.ok(env.calls.some((c) => c[0] === 'recordSentMessagesV2'));
});

test('send/reply：缺 replyToMessageId 400', async () => {
  const env = makeEnv();
  env.headers = { 'x-agent-token': 'good' };
  const r = await call(env, '/api/send/reply', 'POST', { groupId: '123', message: 'hi' });
  assert.equal(r.last.status, 400);
  assert.match(r.last.payload.error, /replyToMessageId/);
});

test('wait：缺 key 400、purpose 非法 400、工具关闭 403、paused 直接回不等待', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/socialV2/wait', 'POST', {});
  assert.equal(r.last.status, 400);
  r = await call(env, '/api/socialV2/wait', 'POST', { key: 'group:123', purpose: 'x' });
  assert.equal(r.last.status, 400);

  env.headers = { 'x-agent-token': 'good' };
  env.v2ToolEnabled = () => false;
  r = await call(env, '/api/socialV2/wait', 'POST', { key: 'group:123' });
  assert.equal(r.last.status, 403);

  env.v2ToolEnabled = () => true;
  env.socialV2.paused = true;
  r = await call(env, '/api/socialV2/wait', 'POST', { key: 'group:123' });
  assert.equal(r.last.payload.paused, true);
  assert.equal(r.last.payload.waitedMs, 0);
});

test('preset 路由：未知预设 400（不写盘）', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/preset/sim-prompt', 'GET');
  assert.equal(r.last.status, 400);
  assert.match(r.last.payload.error, /未知预设/);
  r = await call(env, '/api/preset/sim-prompt', 'POST', { preset: 'nope', content: 'x' });
  assert.equal(r.last.status, 400);
});
