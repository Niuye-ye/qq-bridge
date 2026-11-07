// 控制台「人格管理」域路由（src/console/roles.mjs）离线测试。
// 纯函数直测 handler：构造假 ctx（不启 HTTP 服务），断言状态码、响应体与副作用调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRolesRoutes } from '../src/console/roles.mjs';

function makeEnv(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-test-'));
  fs.mkdirSync(path.join(root, 'roles'), { recursive: true });
  const calls = { sent: [], logs: [], stateWrites: [], atomic: [], contents: [] };
  let roleState = { role: null, mode: 'active' };
  const ctx = {
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/roles'),
    sendJson: (body, status = 200) => { calls.sent.push({ body, status }); },
    readBody: async () => ({}),
    log: (line) => { calls.logs.push(line); },
    fs,
    path,
    ROOT: root,
    readRoleState: () => ({ ...roleState }),
    writeRoleState: (role, mode) => { calls.stateWrites.push({ role, mode }); roleState = { role, mode }; },
    sanitizeRoleName: (n) => String(n).trim(),
    roleSummaries: () => [{ name: '小鲸鱼', chars: 12, bytes: 20 }],
    validateRoleName: (n) => {
      const s = String(n ?? '').trim();
      if (!s) throw new Error('人格名不能为空');
      if (s.length > 40) throw new Error('人格名太长');
      return s;
    },
    validateRoleContent: (c) => {
      const s = String(c ?? '');
      if (!s.trim()) throw new Error('人格内容不能为空');
      if (Buffer.byteLength(s, 'utf8') > 64 * 1024) throw new Error('人格内容太长');
      return s;
    },
    roleFilePath: (n) => path.join(root, 'roles', n + '.md'),
    readRoleContent: (n) => { calls.contents.push(n); return fs.readFileSync(path.join(root, 'roles', n + '.md'), 'utf8'); },
    writeRoleContent: (n, c) => { fs.writeFileSync(path.join(root, 'roles', n + '.md'), c, 'utf8'); },
    roleWarnings: (c) => (String(c).includes('##') ? [] : ['缺少二级标题']),
    applyRoleInjectLimit: (v) => { const n = Number(v); if (!Number.isFinite(n)) return 6000; return Math.min(20000, Math.max(1000, Math.round(n))); },
    readConfigObject: (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}),
    atomicWriteJson: (file, obj) => { calls.atomic.push({ file, obj }); fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8'); },
    ROLE_NAME_MAX: 40,
    ROLE_CONTENT_MAX_BYTES: 64 * 1024,
    cfg: { role: {} },
    getRoleInjectMaxChars: () => 6000,
    setRoleInjectMaxChars: (v) => { calls.setLimit = v; },
    ...overrides,
  };
  return { root, ctx, calls };
}

function req(method, pathname, body) {
  return { method, pathname, body };
}

function run(ctx, { method = 'GET', pathname = '/api/roles', body = {}, rawBody } = {}) {
  ctx.req = { method, headers: {} };
  ctx.url = new URL('http://127.0.0.1' + pathname);
  ctx.readBody = async () => (rawBody !== undefined ? rawBody : body);
  return handleRolesRoutes(ctx);
}

test('不归本域的路径返回 false 且不写响应', async () => {
  const { ctx, calls } = makeEnv();
  assert.equal(await run(ctx, { pathname: '/api/status' }), false);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.logs.length, 0);
});

test('POST /api/role 指定不存在的角色 → 400 且提示 roles/<name>.md', async () => {
  const { ctx, calls } = makeEnv();
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/role', body: { role: '张三' } }), true);
  assert.equal(calls.sent[0].status, 400);
  assert.match(calls.sent[0].body.error, /角色「张三」不存在/);
  assert.equal(calls.stateWrites.length, 0);
});

test('POST /api/role 切到已存在的角色 → 写入 role state 并返回角色名', async () => {
  const { ctx, calls, root } = makeEnv();
  fs.writeFileSync(path.join(root, 'roles', '小鲸鱼.md'), '# 小鲸鱼', 'utf8');
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/role', body: { role: '小鲸鱼' } }), true);
  assert.deepEqual(calls.stateWrites[0], { role: '小鲸鱼', mode: 'active' });
  assert.deepEqual(calls.sent[0], { body: { ok: true, role: '小鲸鱼' }, status: 200 });
  assert.match(calls.logs[0], /角色已设置为 小鲸鱼/);
});

test('POST /api/role 不带 role → 清除当前角色', async () => {
  const { ctx, calls } = makeEnv();
  assert.equal(await run(ctx, { method: 'POST', pathname: '/api/role', body: {} }), true);
  assert.deepEqual(calls.stateWrites[0], { role: null, mode: 'active' });
  assert.deepEqual(calls.sent[0].body, { ok: true, role: null });
  assert.match(calls.logs[0], /角色已清除/);
});

test('POST /api/role-mode 只认 silent，其余一律 active', async () => {
  const { ctx, calls } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/role-mode', body: { mode: 'silent' } });
  assert.deepEqual(calls.stateWrites[0], { role: null, mode: 'silent' });
  assert.equal(calls.sent[0].body.roleMode, 'silent');
  const second = makeEnv();
  await run(second.ctx, { method: 'POST', pathname: '/api/role-mode', body: { mode: 'whatever' } });
  assert.equal(second.calls.sent[0].body.roleMode, 'active');
  assert.match(second.calls.logs[0], /静默模式 关闭/);
});

test('GET /api/roles 保持 roles 为字符串数组的契约，上限取自 getter', async () => {
  const { ctx, calls } = makeEnv({ getRoleInjectMaxChars: () => 4321 });
  assert.equal(await run(ctx, { pathname: '/api/roles' }), true);
  const body = calls.sent[0].body;
  assert.deepEqual(body.roles, ['小鲸鱼']);
  assert.equal(body.current, null);
  assert.equal(body.limits.injectMaxChars, 4321);
  assert.equal(body.limits.nameMax, 40);
  assert.equal(body.limits.contentMaxBytes, 65536);
  assert.deepEqual(body.summaries, [{ name: '小鲸鱼', chars: 12, bytes: 20 }]);
});

test('GET /api/roles/content：非法名 400、不存在 404、存在则带统计', async () => {
  const { ctx, calls, root } = makeEnv();
  await run(ctx, { pathname: '/api/roles/content' });
  assert.equal(calls.sent[0].status, 400);
  assert.match(calls.sent[0].body.error, /人格名不能为空/);

  const miss = makeEnv();
  await run(miss.ctx, { pathname: '/api/roles/content?name=没有这个' });
  assert.equal(miss.calls.sent[0].status, 404);

  fs.writeFileSync(path.join(root, 'roles', '小鲸鱼.md'), '## 一\n正文', 'utf8');
  await run(ctx, { pathname: '/api/roles/content?name=小鲸鱼' });
  const body = calls.sent[calls.sent.length - 1].body;
  assert.equal(body.ok, true);
  assert.equal(body.name, '小鲸鱼');
  assert.equal(body.content, '## 一\n正文');
  assert.equal(body.chars, 7);
  assert.equal(body.bytes, 13);
  assert.deepEqual(body.warnings, []);
  assert.equal(body.limits.injectMaxChars, 6000);
  assert.ok(body.sections.v1 && body.sections.v2);
});

test('POST /api/roles/limit 夹紧后落到 config.json + cfg + setter', async () => {
  const { ctx, calls, root } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/roles/limit', body: { maxInjectChars: 50 } });
  assert.equal(calls.setLimit, 1000);
  assert.equal(ctx.cfg.role.maxInjectChars, 1000);
  const written = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(written.role.maxInjectChars, 1000);
  assert.deepEqual(calls.sent[0].body, { ok: true, maxInjectChars: 1000, limits: { injectMaxChars: 1000 } });
  assert.match(calls.logs[0], /人格注入上限已设为 1000 字符/);
});

test('POST /api/roles/create：已存在 400，新建成功带 warnings', async () => {
  const { ctx, calls, root } = makeEnv();
  fs.writeFileSync(path.join(root, 'roles', '小鲸鱼.md'), '# 旧', 'utf8');
  await run(ctx, { method: 'POST', pathname: '/api/roles/create', body: { name: '小鲸鱼', content: '## 新' } });
  assert.equal(calls.sent[0].status, 400);
  assert.match(calls.sent[0].body.error, /已存在/);
  assert.equal(fs.readFileSync(path.join(root, 'roles', '小鲸鱼.md'), 'utf8'), '# 旧');

  const fresh = makeEnv();
  await run(fresh.ctx, { method: 'POST', pathname: '/api/roles/create', body: { name: '新角色', content: '没有标题的正文' } });
  assert.equal(fresh.calls.sent[0].body.ok, true);
  assert.deepEqual(fresh.calls.sent[0].body.warnings, ['缺少二级标题']);
  assert.equal(fs.readFileSync(path.join(fresh.root, 'roles', '新角色.md'), 'utf8'), '没有标题的正文');
});

test('POST /api/roles/update：不存在 404，存在则覆盖并回报字符数', async () => {
  const { ctx, calls, root } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/roles/update', body: { name: '没有', content: '## x' } });
  assert.equal(calls.sent[0].status, 404);
  fs.writeFileSync(path.join(root, 'roles', '小鲸鱼.md'), '旧内容', 'utf8');
  await run(ctx, { method: 'POST', pathname: '/api/roles/update', body: { name: '小鲸鱼', content: '## 新内容' } });
  assert.deepEqual(calls.sent[calls.sent.length - 1].body, { ok: true, role: '小鲸鱼', chars: 6, warnings: [] });
  assert.equal(fs.readFileSync(path.join(root, 'roles', '小鲸鱼.md'), 'utf8'), '## 新内容');
});

test('POST /api/roles/rename：同名不动、缺失 404、撞名 400、成功且跟随当前角色', async () => {
  const { ctx, calls, root } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/roles/rename', body: { from: '甲', to: '甲' } });
  assert.deepEqual(calls.sent[0].body, { ok: true, role: '甲', renamed: false });
  await run(ctx, { method: 'POST', pathname: '/api/roles/rename', body: { from: '无', to: '乙' } });
  assert.equal(calls.sent[1].status, 404);
  fs.writeFileSync(path.join(root, 'roles', '甲.md'), 'A', 'utf8');
  fs.writeFileSync(path.join(root, 'roles', '乙.md'), 'B', 'utf8');
  await run(ctx, { method: 'POST', pathname: '/api/roles/rename', body: { from: '甲', to: '乙' } });
  assert.equal(calls.sent[2].status, 400);

  fs.rmSync(path.join(root, 'roles', '乙.md'));
  ctx.writeRoleState('甲', 'silent');
  await run(ctx, { method: 'POST', pathname: '/api/roles/rename', body: { from: '甲', to: '丙' } });
  assert.deepEqual(calls.sent[3].body, { ok: true, role: '丙', renamed: true, currentFollowed: true });
  assert.equal(fs.existsSync(path.join(root, 'roles', '丙.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'roles', '甲.md')), false);
  assert.deepEqual(calls.stateWrites[calls.stateWrites.length - 1], { role: '丙', mode: 'silent' });
});

test('POST /api/roles/delete：删除当前启用的人格时同时清除', async () => {
  const { ctx, calls, root } = makeEnv();
  await run(ctx, { method: 'POST', pathname: '/api/roles/delete', body: { name: '没有' } });
  assert.equal(calls.sent[0].status, 404);
  fs.writeFileSync(path.join(root, 'roles', '小鲸鱼.md'), 'x', 'utf8');
  ctx.writeRoleState('小鲸鱼', 'active');
  await run(ctx, { method: 'POST', pathname: '/api/roles/delete', body: { name: '小鲸鱼' } });
  assert.deepEqual(calls.sent[1].body, { ok: true, deleted: '小鲸鱼', clearedCurrent: true });
  assert.equal(fs.existsSync(path.join(root, 'roles', '小鲸鱼.md')), false);
  assert.deepEqual(calls.stateWrites[calls.stateWrites.length - 1], { role: null, mode: 'active' });
  assert.match(calls.logs[calls.logs.length - 1], /已同时清除当前人格/);
});
