import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleToolsRoutes } from '../src/console/tools.mjs';

// ── 假 ctx：只实现被工具域用到的那一小撮 ────────────────────────────────
function makeEnv(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const sent = [];
  const logs = [];
  const env = {
    root,
    sent,
    logs,
    state: { activity: {}, goals: [], life: [], facts: [], forgotten: [], calls: [] },
    req: { method: 'POST', headers: {} },
    url: { pathname: '/api/socialV2/now' },
    body: {},
    cfg: {},
    currentMode: 'reserved2',
    v2ToolEnabled: () => true,
    sendJson: (payload, status = 200) => sent.push({ payload, status }),
    readBody: async () => env.body,
    log: (m) => logs.push(String(m)),
    ROOT: root,
    readActivityV2: () => env.state.activity,
    writeActivityV2: (patch) => {
      env.state.calls.push(['writeActivityV2', patch]);
      env.state.activity = { ...env.state.activity, ...patch };
      return env.state.activity;
    },
    formatActivityLineV2: () => '现在在干嘛：写测试',
    addGoalV2: (text, extra) => {
      if (!text) return null;
      const g = { id: String(env.state.goals.length + 1), text, status: 'open', want: extra?.want };
      env.state.goals.push(g);
      return g;
    },
    closeGoalV2: (needle, status) => {
      env.state.calls.push(['closeGoalV2', needle, status]);
      let n = 0;
      for (const g of env.state.goals) if (g.status === 'open' && (g.id === needle || g.text === needle)) { g.status = status; n++; }
      return n;
    },
    readGoalsV2: () => env.state.goals,
    appendLifeV2: (text) => {
      if (!text) return null;
      const e = { at: new Date().toISOString(), text };
      env.state.life.push(e);
      return e;
    },
    formatGoalsLineV2: () => '想做的事 1 条',
    readLifeV2: () => env.state.life,
    addFactV2: (text, extra) => {
      const e = { id: 'f' + (env.state.facts.length + 1), text, kind: extra?.kind ?? 'fact', tier: extra?.tier ?? 'normal' };
      env.state.facts.push(e);
      return e;
    },
    removeFactV2: (needle) => {
      env.state.calls.push(['removeFactV2', needle]);
      const before = env.state.facts.length;
      env.state.facts = env.state.facts.filter((f) => f.text !== needle && f.id !== needle);
      if (env.state.facts.length !== before) {
        env.state.forgotten.push({ text: needle, soft: true });
        return { removed: 'soft' };
      }
      env.state.forgotten.push({ text: needle });
      return { removed: 'hard' };
    },
    readFactsV2: () => env.state.facts,
    readForgottenFactsV2: () => env.state.forgotten,
    searchFactsV2: (query, limit, includeForgotten) => {
      env.state.calls.push(['searchFactsV2', query, limit, includeForgotten]);
      return env.state.facts.filter((f) => !query || f.text.includes(query));
    },
    formatFactsLineV2: () => '记得 1 条',
  };
  Object.assign(env, opts);
  return env;
}

async function call(env, pathname, method, body) {
  env.url = { pathname };
  env.req = { method, headers: env.headers ?? {} };
  env.body = body ?? {};
  const handled = await handleToolsRoutes(env);
  return { handled, last: env.sent.at(-1) };
}

test('非本域路由返回 false 且不回包', async () => {
  const env = makeEnv();
  const { handled } = await call(env, '/api/socialV2/send-message', 'POST', {});
  assert.equal(handled, false);
  assert.equal(env.sent.length, 0);
});

test('now：模式与 token 两道闸', async () => {
  const env = makeEnv({ currentMode: 'chat' });
  let r = await call(env, '/api/socialV2/now', 'POST', {});
  assert.equal(r.last.status, 403);
  assert.match(r.last.payload.error, /仅 reserved2/);

  env.currentMode = 'reserved2';
  r = await call(env, '/api/socialV2/now', 'POST', {});
  assert.equal(r.last.status, 403);
  assert.match(r.last.payload.error, /必须携带 agent token/);
});

test('now：只读不写，带 doing 才写', async () => {
  const env = makeEnv();
  env.state.activity = { doing: '刷手机' };
  let r = await call(env, '/api/socialV2/now', 'POST', { token: 't' });
  assert.equal(r.handled, true);
  assert.equal(r.last.payload.activity.doing, '刷手机');
  assert.equal(env.state.calls.length, 0, '只读不该调 writeActivityV2');

  r = await call(env, '/api/socialV2/now', 'POST', { token: 't', doing: '写代码', plan: '继续' });
  assert.equal(r.last.payload.activity.doing, '写代码');
  assert.equal(r.last.payload.line, '现在在干嘛：写测试');
  const write = env.state.calls.find((c) => c[0] === 'writeActivityV2');
  assert.deepEqual(write[1], { doing: '写代码', note: undefined, plan: '继续' });
  assert.ok(env.logs.some((m) => m.includes('[activity]')));
});

test('goals：add 空 text 400，成功回 open 数', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/socialV2/goals', 'POST', { token: 't', action: 'add', text: '' });
  assert.equal(r.last.status, 400);
  assert.match(r.last.payload.error, /text 不能为空/);

  r = await call(env, '/api/socialV2/goals', 'POST', { token: 't', action: 'add', text: '学 rust', want: '想' });
  assert.equal(r.last.status, 200);
  assert.equal(r.last.payload.goal.text, '学 rust');
  assert.equal(r.last.payload.open, 1);
});

test('goals：done 走 closeGoalV2(done)，drop 走 dropped', async () => {
  const env = makeEnv();
  await call(env, '/api/socialV2/goals', 'POST', { token: 't', action: 'add', text: '学 rust' });
  let r = await call(env, '/api/socialV2/goals', 'POST', { token: 't', action: 'done', id: '1' });
  assert.equal(r.last.payload.changed, 1);
  assert.equal(r.last.payload.open, 0);
  assert.deepEqual(env.state.calls.at(-1), ['closeGoalV2', '1', 'done']);

  await call(env, '/api/socialV2/goals', 'POST', { token: 't', action: 'add', text: '学 go' });
  r = await call(env, '/api/socialV2/goals', 'POST', { token: 't', action: 'drop', text: '学 go' });
  assert.deepEqual(env.state.calls.at(-1), ['closeGoalV2', '学 go', 'dropped']);
});

test('goals：life 空 text 400；list 回 goals + line + life 尾 10', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/socialV2/goals', 'POST', { token: 't', action: 'life', text: '' });
  assert.equal(r.last.status, 400);

  await call(env, '/api/socialV2/goals', 'POST', { token: 't', action: 'life', text: '喝了杯水' });
  r = await call(env, '/api/socialV2/goals', 'POST', { token: 't' });
  assert.equal(r.last.payload.line, '想做的事 1 条');
  assert.equal(r.last.payload.life.length, 1);
  assert.equal(r.last.payload.goals.length, 0);
});

test('facts：add 回 total，remove 回 forgotten，list 默认含遗忘池', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/socialV2/facts', 'POST', { token: 't', action: 'add', text: '主人怕冷', kind: 'fact' });
  assert.equal(r.last.payload.total, 1);
  assert.ok(env.logs.some((m) => m.includes('[facts]')));

  r = await call(env, '/api/socialV2/facts', 'POST', { token: 't', remove: '主人怕冷' });
  assert.equal(r.last.payload.total, 0);
  assert.equal(r.last.payload.forgotten, 1);

  await call(env, '/api/socialV2/facts', 'POST', { token: 't', action: 'add', text: '她喜欢猫' });
  r = await call(env, '/api/socialV2/facts', 'POST', { token: 't', query: '猫' });
  assert.equal(r.last.payload.facts.length, 1);
  assert.deepEqual(env.state.calls.filter((c) => c[0] === 'searchFactsV2').at(-1), ['searchFactsV2', '猫', undefined, true]);

  r = await call(env, '/api/socialV2/facts', 'POST', { token: 't', query: '猫', includeForgotten: false, limit: 3 });
  assert.deepEqual(env.state.calls.filter((c) => c[0] === 'searchFactsV2').at(-1), ['searchFactsV2', '猫', 3, false]);
});

test('kill-link：工具关闭 403', async () => {
  const env = makeEnv({ v2ToolEnabled: () => false });
  env.headers = { 'x-agent-token': 'agent' };
  const r = await call(env, '/api/socialV2/kill-link', 'POST', {});
  assert.equal(r.last.status, 403);
  assert.match(r.last.payload.error, /qq_kill_link/);
});

test('kill-link：未配置或脚本不存在回 501', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/socialV2/kill-link', 'POST', {});
  assert.equal(r.last.status, 501);

  env.cfg = { localOps: { killLink: path.join(env.root, '没有这个.ps1') } };
  r = await call(env, '/api/socialV2/kill-link', 'POST', {});
  assert.equal(r.last.status, 501);
});

test('kill-link：dryRun 同步跑一次并原样回清单', async () => {
  const env = makeEnv();
  const script = path.join(env.root, 'kill-link.ps1');
  fs.writeFileSync(script, '# fake\n', 'utf8');
  env.cfg = { localOps: { killLink: script } };
  const calls = [];
  env.execFileFn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    cb(null, '会杀：bridge-guard / pet-electron\n', '');
  };
  const r = await call(env, '/api/socialV2/kill-link', 'POST', { dryRun: true, includeQQ: true });
  assert.equal(r.last.status, 200);
  assert.equal(r.last.payload.dryRun, true);
  assert.match(r.last.payload.output, /bridge-guard/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.ok(calls[0].args.includes('-Command'));
  const command = calls[0].args.at(-1);
  assert.ok(command.includes('-DryRun'), '命令里要带 -DryRun');
  assert.ok(command.includes('-IncludeQQ'), '命令里要带 -IncludeQQ');
  assert.ok(command.includes(script), '命令里要有脚本绝对路径');
  assert.doesNotMatch(command, /IncludeMuMu/);
});

test('kill-link：非 dryRun 先回包再 spawn，且留同步痕迹', async () => {
  const env = makeEnv();
  const script = path.join(env.root, 'kill-link.ps1');
  fs.writeFileSync(script, '# fake\n', 'utf8');
  env.cfg = { localOps: { killLink: script } };
  const spawned = [];
  env.spawnFn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const { EventEmitter } = require('node:events');
    return { on() {}, unref() {} };
  };
  const r = await call(env, '/api/socialV2/kill-link', 'POST', {});
  assert.equal(r.last.payload.dispatched, true);
  assert.equal(spawned.length, 0, '必须等回包之后才动手');
  await new Promise((res) => setTimeout(res, 450));
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.equal(spawned[0].args[4], script);
  assert.equal(spawned[0].opts.stdio, 'ignore');
  const trace = fs.readFileSync(path.join(env.root, 'logs', 'local-ops.log'), 'utf8');
  assert.match(trace, /\[kill-link\] spawn/);
});

test('llm-key：工具关闭 403', async () => {
  const env = makeEnv({ v2ToolEnabled: () => false });
  env.headers = { 'x-agent-token': 'agent' };
  const r = await call(env, '/api/socialV2/llm-key', 'POST', { key: 'sk-' + 'x'.repeat(40) });
  assert.equal(r.last.status, 403);
  assert.match(r.last.payload.error, /qq_set_llm_key/);
});

test('llm-key：非法 key 400，且不写文件', async () => {
  const env = makeEnv();
  const cred = path.join(env.root, '.credentials.yaml');
  env.cfg = { localOps: { credentialsPath: cred } };
  const r = await call(env, '/api/socialV2/llm-key', 'POST', { key: 'short' });
  assert.equal(r.last.status, 400);
  assert.equal(fs.existsSync(cred), false);
});

test('llm-key：一次写两个键名、回掩码、verify 可跳过', async () => {
  const env = makeEnv();
  const cred = path.join(env.root, '.credentials.yaml');
  env.cfg = { localOps: { credentialsPath: cred } };
  const key = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
  const r = await call(env, '/api/socialV2/llm-key', 'POST', { key, verify: false });
  assert.equal(r.last.status, 200);
  assert.equal(r.last.payload.verified, 'skipped');
  assert.deepEqual(r.last.payload.keys.sort(), ['OPENCODEGO_API_KEY', 'OPENCODE_GO_API_KEY'].sort());
  const text = fs.readFileSync(cred, 'utf8');
  assert.ok(text.includes('OPENCODEGO_API_KEY'));
  assert.ok(text.includes('OPENCODE_GO_API_KEY'));
  assert.ok(text.includes(key), '文件里要落真实 key');
  assert.equal(JSON.stringify(r.last.payload).includes(key), false, '响应里不许回明文 key');
  assert.equal(env.logs.some((m) => m.includes(key)), false, '日志里不许有明文 key');
});
