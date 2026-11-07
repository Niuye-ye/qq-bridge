// src/llm-key.mjs 的离线单测（node:test）。不联网、不碰真实凭据文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LLM_KEY_NAMES, defaultCredentialsPath, maskLlmKey, normalizeLlmKey, upsertCredentialRefs, verifyLlmKey, writeLlmKey } from '../src/llm-key.mjs';

const KEY = 'oc_sk_79c5a62f08d5_V4T7cl4dXx5DaAlfk8jLcvgoe_5K1A7G';

const SAMPLE = [
  'version: 1',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-aaa',
  '  OPENCODE_GO_API_KEY: oc_old_should_be_replaced',
  '  DSH_QQBOT_APP_SECRET_ABCDEF: secret-value',
  'records:',
  '  client-connection/browser-session:',
  '    value: xyz',
  ''
].join('\n');

test('normalizeLlmKey：空/过短/含空格都拒绝，正常 key 通过', () => {
  assert.equal(normalizeLlmKey('').ok, false);
  assert.equal(normalizeLlmKey('   ').ok, false);
  assert.equal(normalizeLlmKey('short').ok, false);
  assert.equal(normalizeLlmKey('oc_sk_aaa bbb ccc ddd').ok, false);
  assert.equal(normalizeLlmKey('oc_sk_has' + '\n' + 'injection').ok, false);
  const ok = normalizeLlmKey('  ' + KEY + '  ');
  assert.equal(ok.ok, true);
  assert.equal(ok.key, KEY);
});

test('maskLlmKey：日志里不回显完整 key', () => {
  const m = maskLlmKey(KEY);
  assert.ok(!m.includes(KEY));
  assert.ok(m.startsWith('oc_sk_'));
  assert.ok(m.includes('(' + KEY.length + ')'));
  assert.equal(maskLlmKey(''), '(空)');
});

test('upsertCredentialRefs：命中已有键就替换值，其余字节原样保留', () => {
  const out = upsertCredentialRefs(SAMPLE, [{ name: 'OPENCODE_GO_API_KEY', value: KEY }]);
  assert.deepEqual(out.updated, ['OPENCODE_GO_API_KEY']);
  assert.deepEqual(out.added, []);
  assert.ok(out.text.includes('  OPENCODE_GO_API_KEY: ' + KEY));
  assert.ok(!out.text.includes('oc_old_should_be_replaced'));
  // 其它键与 records 段一字未动
  assert.ok(out.text.includes('  DEEPSEEK_API_KEY: sk-aaa'));
  assert.ok(out.text.includes('  DSH_QQBOT_APP_SECRET_ABCDEF: secret-value'));
  assert.ok(out.text.includes('records:'));
  assert.ok(out.text.includes('    value: xyz'));
});

test('upsertCredentialRefs：缺失的键插在 refs 段末尾（records 之前）', () => {
  const out = upsertCredentialRefs(SAMPLE, [{ name: 'OPENCODEGO_API_KEY', value: KEY }]);
  assert.deepEqual(out.updated, []);
  assert.deepEqual(out.added, ['OPENCODEGO_API_KEY']);
  const lines = out.text.split('\n');
  const idx = lines.indexOf('  OPENCODEGO_API_KEY: ' + KEY);
  assert.ok(idx > 0);
  assert.ok(idx < lines.indexOf('records:'), '必须落在 records 之前');
  assert.ok(out.text.includes('  DEEPSEEK_API_KEY: sk-aaa'));
});

test('upsertCredentialRefs：两个键一起写（一个更新一个新增）', () => {
  const out = upsertCredentialRefs(SAMPLE, LLM_KEY_NAMES.map((name) => ({ name, value: KEY })));
  assert.deepEqual(out.updated, ['OPENCODE_GO_API_KEY']);
  assert.deepEqual(out.added, ['OPENCODEGO_API_KEY']);
  assert.equal(out.text.split(KEY).length - 1, 2);
});

test('upsertCredentialRefs：CRLF 文件保持 CRLF', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const out = upsertCredentialRefs(crlf, [{ name: 'OPENCODE_GO_API_KEY', value: KEY }]);
  assert.ok(out.text.includes('  OPENCODE_GO_API_KEY: ' + KEY + '\r\n'));
  assert.ok(out.text.includes('\r\n  DEEPSEEK_API_KEY: sk-aaa\r\n'));
});

test('upsertCredentialRefs：没有 refs 段直接抛错，不猜结构', () => {
  assert.throws(() => upsertCredentialRefs('version: 1\nrecords: {}\n', [{ name: 'X', value: 'y' }]), /refs/);
  assert.throws(() => upsertCredentialRefs('', [{ name: 'X', value: 'y' }]), /refs/);
});

test('writeLlmKey：原子写、保留权限、不留 .tmp、可重复写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-key-'));
  const file = path.join(dir, '.credentials.yaml');
  fs.writeFileSync(file, SAMPLE, 'utf8');
  try { fs.chmodSync(file, 0o600); } catch {}
  const r1 = writeLlmKey(file, KEY);
  assert.equal(r1.path, file);
  assert.equal(r1.existed, true);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.includes('  OPENCODEGO_API_KEY: ' + KEY));
  assert.ok(after.includes('  OPENCODE_GO_API_KEY: ' + KEY));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // 再写一次不同 key：两个键都跟着变，不重复插入
  const KEY2 = 'oc_sk_second_write_should_replace_old_one_1234';
  writeLlmKey(file, KEY2);
  const again = fs.readFileSync(file, 'utf8');
  assert.equal(again.split('OPENCODEGO_API_KEY').length - 1, 1);
  assert.ok(again.includes('  OPENCODEGO_API_KEY: ' + KEY2));
  assert.ok(!again.includes(KEY));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeLlmKey：文件不存在时新建最小结构；非 .credentials.yaml 拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-key-new-'));
  const file = path.join(dir, 'sub', '.credentials.yaml');
  const r = writeLlmKey(file, KEY);
  assert.equal(r.existed, false);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('version: 1'));
  assert.ok(text.includes('  OPENCODEGO_API_KEY: ' + KEY));
  assert.ok(text.includes('records:'));
  assert.throws(() => writeLlmKey(path.join(dir, 'config.json'), KEY), /credentials\.yaml/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('defaultCredentialsPath：落在 ~/.dsh/.credentials.yaml', () => {
  const p2 = defaultCredentialsPath();
  assert.equal(path.basename(p2), '.credentials.yaml');
  assert.equal(path.basename(path.dirname(p2)), '.dsh');
});

test('verifyLlmKey：200=valid，401=invalid，网络错=unknown 且不抛', async () => {
  const ok = await verifyLlmKey(KEY, { fetchImpl: async () => ({ status: 200 }) });
  assert.deepEqual([ok.ok, ok.status, ok.verdict], [true, 200, 'valid']);
  const bad = await verifyLlmKey(KEY, { fetchImpl: async () => ({ status: 401 }) });
  assert.deepEqual([bad.ok, bad.verdict], [false, 'invalid']);
  const unknown = await verifyLlmKey(KEY, { fetchImpl: async () => ({ status: 500 }) });
  assert.equal(unknown.verdict, 'unknown');
  const boom = await verifyLlmKey(KEY, { fetchImpl: async () => { throw new Error('socket hang up'); } });
  assert.equal(boom.verdict, 'unknown');
  assert.match(boom.error, /socket hang up/);
});

test('verifyLlmKey：请求带 Bearer 认证头、超时中断', async () => {
  let seen = null;
  await verifyLlmKey(KEY, { fetchImpl: async (url, init) => { seen = { url, init }; return { status: 200 }; } });
  assert.equal(seen.url, 'https://opencode.ai/zen/go/v1/models');
  assert.equal(seen.init.headers.authorization, 'Bearer ' + KEY);
  const slow = await verifyLlmKey(KEY, {
    timeoutMs: 30,
    fetchImpl: (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })
  });
  assert.equal(slow.verdict, 'unknown');
});
