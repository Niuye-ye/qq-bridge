// src/error-text.mjs 的单测：确保任何形态的错误都不会退化成「[object Object]」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { errorText } from '../src/error-text.mjs';

test('Error 实例取 message', () => {
  assert.equal(errorText(new Error('炸了')), '炸了');
});

test('带 message 的普通对象也取 message', () => {
  assert.equal(errorText({ message: '配额不足', code: 429 }), '配额不足');
});

test('字符串原样返回，空串走兜底', () => {
  assert.equal(errorText('网络不通'), '网络不通');
  assert.equal(errorText(''), '未知错误');
});

test('无 message 的对象 JSON 化，而不是 [object Object]', () => {
  assert.equal(errorText({ code: 'ECONNRESET' }), '{"code":"ECONNRESET"}');
  assert.equal(errorText({ statusCode: 403, body: { ok: false } }), '{"statusCode":403,"body":{"ok":false}}');
});

test('超长对象截断到 400 字', () => {
  const out = errorText({ text: 'x'.repeat(1000) });
  assert.ok(out.length <= 401, out.length);
  assert.ok(out.endsWith('…'));
});

test('空对象 / 循环引用 / null 都给兜底文案', () => {
  assert.equal(errorText({}), '未知错误（对象无 message）');
  const cyc = {}; cyc.self = cyc;
  assert.equal(errorText(cyc), '未知错误（对象无 message）');
  assert.equal(errorText(null), '未知错误');
  assert.equal(errorText(undefined, '缺参数'), '缺参数');
  assert.equal(errorText(500), '500');
});

test('永远不会返回 [object Object]', () => {
  const samples = [new Error('a'), { message: 'b' }, {}, { a: 1 }, null, undefined, 0, false, ''];
  for (const s of samples) assert.notEqual(errorText(s), '[object Object]');
});
