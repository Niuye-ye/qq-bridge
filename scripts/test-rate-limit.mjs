// src/rate-limit.mjs 的单元测试：窗口计数、预占、回滚、retryAfter。
import assert from 'node:assert/strict';
import test from 'node:test';
import { QUOTA_CAP, checkQuota, countQuota, reserveQuota, rollbackQuota } from '../src/rate-limit.mjs';

const T0 = 1_700_000_000_000;

test('countQuota 只数窗口内、忽略脏值', () => {
  const times = [T0 - 1000, T0 - 61_000, T0 - 3_600_001, 'x', null, undefined];
  const r = countQuota(times, T0);
  assert.equal(r.minute, 1);
  assert.equal(r.hour, 2);
});

test('checkQuota：need 影响判定，max<=0 表示不限', () => {
  const times = [T0 - 1000, T0 - 2000];
  assert.equal(checkQuota(times, { now: T0, need: 1, maxPerMinute: 2 }).ok, false);
  assert.equal(checkQuota(times, { now: T0, need: 1, maxPerMinute: 3 }).ok, true);
  assert.equal(checkQuota(times, { now: T0, need: 2, maxPerMinute: 0 }).ok, true);
});

test('checkQuota 的 retryAfterMs 指向最早一条滑出窗口', () => {
  const times = [T0 - 30_000, T0 - 10_000];
  const r = checkQuota(times, { now: T0, need: 1, maxPerMinute: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.retryAfterMs, 30_000);
  const hour = checkQuota([T0 - 3_000_000], { now: T0, need: 1, maxPerHour: 1 });
  assert.equal(hour.retryAfterMs, 600_000);
});

test('reserveQuota 返回新数组并封顶', () => {
  const src = [];
  const out = reserveQuota(src, 3, T0);
  assert.equal(src.length, 0);            // 原数组没被改（返回新数组）
  assert.deepEqual(out, [T0, T0, T0]);
  const capped = reserveQuota(new Array(QUOTA_CAP).fill(T0 - 1), 2, T0);
  assert.equal(capped.length, QUOTA_CAP);
  assert.equal(capped[capped.length - 1], T0);
});

test('rollbackQuota 删的是刚预占的尾巴，且能连删多条', () => {
  const arr = [T0 - 5000, T0, T0, T0];
  rollbackQuota(arr, 2);
  assert.deepEqual(arr, [T0 - 5000, T0]);
  rollbackQuota(arr, 99);
  assert.deepEqual(arr, []);
});