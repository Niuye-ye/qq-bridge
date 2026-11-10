// src/sync-merge.mjs 的离线测试（PC ↔ 手机 记忆/日记 双向同步的合并层）。
// 纯函数，不碰 fs/path/时间：这里一个临时文件都不用建，直接喂对象。
// 覆盖点：并集/取大/取晚/取长/排序对称/入参不可变/坏数据跳过/幂等/遗忘池/diary 行并集与一侧为 null/stats 数字。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeFactsState,
  mergeForgottenState,
  mergeDiaryText,
  mergeDiaryFile,
  newerFactsEntry,
  factsSortCompare,
  stableStringify
} from '../src/sync-merge.mjs';

const fact = (id, patch = {}) => ({ id, text: 'text-' + id, kind: 'fact', tier: 'normal', at: '2026-01-01T00:00:00.000Z', hits: 0, str: 0.5, ...patch });
const forgotten = (id, patch = {}) => ({ id, text: 'text-' + id, kind: 'fact', tier: 'normal', at: '2026-01-01T00:00:00.000Z', hits: 1, str: 0.1, forgotAt: '2026-05-01T00:00:00.000Z', ...patch });
const byId = (list, id) => list.find((x) => x.id === id);
const snapshot = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
    Object.freeze(obj);
  }
  return obj;
}

test('facts 按 id 取并集，stats 数字对得上', () => {
  const a = { facts: [fact('f1'), fact('f2', { text: '旧说法', str: 0.5 })] };
  const b = { facts: [fact('f2', { text: '新说法', str: 0.5 }), fact('f3')] };
  const { merged, stats } = mergeFactsState(a, b);
  assert.deepEqual(merged.map((x) => x.id), ['f1', 'f2', 'f3']);
  assert.deepEqual(stats, { aCount: 2, bCount: 2, mergedCount: 3, onlyA: 1, onlyB: 1, updated: 1, bothSame: 0 });
});

test('同 id：str / hits / rev 取较大值', () => {
  const a = { facts: [fact('f1', { str: 0.3, hits: 1, rev: 0 })] };
  const b = { facts: [fact('f1', { str: 0.7, hits: 3, rev: 2 })] };
  const m = byId(mergeFactsState(a, b).merged, 'f1');
  assert.equal(m.str, 0.7);
  assert.equal(m.hits, 3);
  assert.equal(m.rev, 2);
});

test('同 id：dueAt / reviewedAt 取较晚，空串当"没有"', () => {
  const a = { facts: [fact('f1', { dueAt: '2026-11-05T00:00:00.000Z', reviewedAt: '' })] };
  const b = { facts: [fact('f1', { dueAt: '2026-11-08T00:00:00.000Z', reviewedAt: '2026-11-07T00:00:00.000Z' })] };
  const m = byId(mergeFactsState(a, b).merged, 'f1');
  assert.equal(m.dueAt, '2026-11-08T00:00:00.000Z');
  assert.equal(m.reviewedAt, '2026-11-07T00:00:00.000Z', '空串不能盖掉另一侧的真实时间');

  // 兼容别名（老数据 / 别的端可能写 lastReviewAt / lastRevAt）
  const c = { facts: [fact('f1', { lastReviewAt: '2026-11-01T00:00:00.000Z', lastRevAt: '2026-11-02T00:00:00.000Z' })] };
  const d = { facts: [fact('f1', { lastReviewAt: '2026-11-09T00:00:00.000Z', lastRevAt: '2026-11-03T00:00:00.000Z' })] };
  const m2 = byId(mergeFactsState(c, d).merged, 'f1');
  assert.equal(m2.lastReviewAt, '2026-11-09T00:00:00.000Z');
  assert.equal(m2.lastRevAt, '2026-11-03T00:00:00.000Z');
});

test('同 id：text 取非空且更长的那条（等长时也对称）', () => {
  const a = { facts: [fact('f1', { text: '我喜欢猫' })] };
  const b = { facts: [fact('f1', { text: '我喜欢猫和狗' })] };
  assert.equal(byId(mergeFactsState(a, b).merged, 'f1').text, '我喜欢猫和狗');

  const c = { facts: [fact('f2', { text: '' })] };
  const d = { facts: [fact('f2', { text: '短的' })] };
  assert.equal(byId(mergeFactsState(c, d).merged, 'f2').text, '短的');
});

test('同 id：tier 优先 long，kind 跟 long 那侧走（同步不能把 long 降级）', () => {
  const a = { facts: [fact('f1', { tier: 'long', kind: 'promise', touched: '2026-01-01T00:00:00.000Z' })] };
  const b = { facts: [fact('f1', { tier: 'normal', kind: 'event', touched: '2026-06-01T00:00:00.000Z' })] };
  const m = byId(mergeFactsState(a, b).merged, 'f1');
  assert.equal(m.tier, 'long');
  assert.equal(m.kind, 'promise');
});

test('未知字段以较新的一侧为准，只在一侧存在的字段保留（并集）', () => {
  const a = { facts: [fact('f1', { touched: '2026-01-01T00:00:00.000Z', mood: 'sad', aOnly: 1 })] };
  const b = { facts: [fact('f1', { touched: '2026-02-01T00:00:00.000Z', mood: 'happy', bOnly: 2 })] };
  const m = byId(mergeFactsState(a, b).merged, 'f1');
  assert.equal(m.mood, 'happy', '较新侧（touched 更晚）的未知字段胜出');
  assert.equal(m.aOnly, 1, '老侧独有的字段不能丢');
  assert.equal(m.bOnly, 2);
});

test('排序：str 降序 → at 升序 → id 兜底；两侧合并结果字节一致', () => {
  const e1 = fact('f2', { str: 0.5, at: '2026-01-02T00:00:00.000Z' });
  const e2 = fact('f1', { str: 0.9, at: '2026-03-01T00:00:00.000Z' });
  const e3 = fact('f3', { str: 0.5, at: '2026-01-01T00:00:00.000Z' });
  const a = { facts: [e1, e2] };
  const b = { facts: [e3] };
  const ab = mergeFactsState(a, b).merged;
  assert.deepEqual(ab.map((x) => x.id), ['f1', 'f3', 'f2']);
  const ba = mergeFactsState(b, a).merged;
  assert.equal(stableStringify(ab), stableStringify(ba), '参数顺序不同，结果必须完全相同');
  // 同 str 同 at 时靠 id 定序，保证两侧一致
  const x = { facts: [fact('zz', { str: 0.4, at: '2026-01-01T00:00:00.000Z' })] };
  const y = { facts: [fact('aa', { str: 0.4, at: '2026-01-01T00:00:00.000Z' })] };
  assert.deepEqual(mergeFactsState(x, y).merged.map((e) => e.id), ['aa', 'zz']);
  assert.deepEqual(mergeFactsState(y, x).merged.map((e) => e.id), ['aa', 'zz']);
});

test('没有 str 的条目排在最后，不参与 NaN 比较', () => {
  const a = { facts: [{ id: 'nostr', text: 'x', at: '2026-01-01T00:00:00.000Z' }, fact('f1', { str: 0.5 })] };
  const merged = mergeFactsState(a, null).merged;
  assert.equal(merged[0].id, 'f1');
  assert.equal(merged[merged.length - 1].id, 'nostr');
  assert.ok(factsSortCompare(merged[0], merged[1]) < 0);
});

test('两侧都没有时间戳时未知字段也按对称规则定胜负（不依赖参数顺序）', () => {
  const a = { facts: [{ id: 'f1', text: 'abc', note: 'aaa' }] };
  const b = { facts: [{ id: 'f1', text: 'abc', note: 'zzz' }] };
  const ab = mergeFactsState(a, b).merged[0];
  const ba = mergeFactsState(b, a).merged[0];
  assert.equal(ab.note, 'zzz');
  assert.equal(stableStringify(ab), stableStringify(ba));
});

test('不改动入参（深冻结的两侧也能合并）', () => {
  const a = deepFreeze({ facts: [fact('f1', { text: '旧', str: 0.2, extra: { nested: 1 } })] });
  const b = deepFreeze({ facts: [fact('f1', { text: '新的更长的正文', str: 0.8 })] });
  const beforeA = snapshot(a);
  const beforeB = snapshot(b);
  const { merged } = mergeFactsState(a, b);
  assert.equal(snapshot(a), beforeA);
  assert.equal(snapshot(b), beforeB);
  assert.equal(merged[0].text, '新的更长的正文');
  // 合并结果里不能直接暴露入参对象的引用（改结果不该影响入参）
  merged[0].text = '改结果';
  assert.equal(a.facts[0].text, '旧');
});

test('畸形输入：缺 id / 非对象条目跳过，不抛错', () => {
  const a = { facts: [null, 'x', 42, { text: '没有 id' }, { id: '   ' }, { id: {}, text: 'id 是对象' }, fact('ok')] };
  const { merged, stats } = mergeFactsState(a, undefined);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'ok');
  assert.equal(stats.aCount, 1);
  assert.equal(stats.bCount, 0);
});

test('空数组 / null / 非数组容器都不抛错', () => {
  for (const input of [null, undefined, {}, { facts: null }, { facts: 'nope' }, [], 'x', 0]) {
    const r = mergeFactsState(input, input);
    assert.deepEqual(r.merged, []);
    assert.deepEqual(r.stats, { aCount: 0, bCount: 0, mergedCount: 0, onlyA: 0, onlyB: 0, updated: 0, bothSame: 0 });
  }
});

test('幂等：merge(merge(a,b),a) 与 merge(merge(a,b),b) 都不再新增', () => {
  const a = { facts: [fact('f1', { str: 0.4, text: 'a 的说法', dueAt: '2026-11-01T00:00:00.000Z' }), fact('f2')] };
  const b = { facts: [fact('f1', { str: 0.8, text: 'b 说的更长的说法', dueAt: '2026-11-09T00:00:00.000Z' }), fact('f3')] };
  const m1 = mergeFactsState(a, b);
  for (const again of [a, b]) {
    // 注意：mergeFactsState 收的是 {facts:[...]}，不是它自己的返回值 {merged,...}。
    const m2 = mergeFactsState({ facts: m1.merged }, again);
    assert.equal(m2.merged.length, m1.merged.length);
    assert.equal(stableStringify(m2.merged), stableStringify(m1.merged), '再来一次不该改变任何字段');
    assert.equal(m2.stats.onlyB, 0);
    assert.equal(m2.stats.aCount, m1.merged.length);
  }
});

test('遗忘池：按 id 并集，str 取大、forgotAt 取晚；{items} 与 {facts} 两种容器都认', () => {
  const a = { items: [forgotten('x1', { str: 0.1, forgotAt: '2026-05-01T00:00:00.000Z' }), forgotten('x2')] };
  const b = { facts: [forgotten('x1', { str: 0.09, forgotAt: '2026-05-10T00:00:00.000Z', text: '更长的遗忘正文' }), forgotten('x3')] };
  const { merged, stats } = mergeForgottenState(a, b);
  assert.deepEqual(merged.map((x) => x.id), ['x1', 'x2', 'x3']);
  const x1 = byId(merged, 'x1');
  assert.equal(x1.str, 0.1);
  assert.equal(x1.forgotAt, '2026-05-10T00:00:00.000Z');
  assert.equal(x1.text, '更长的遗忘正文');
  assert.deepEqual(stats, { aCount: 2, bCount: 2, mergedCount: 3, onlyA: 1, onlyB: 1, updated: 1, bothSame: 0 });
});

test('遗忘池：不截断、不改入参', () => {
  const a = deepFreeze({ items: [forgotten('x1'), forgotten('x2'), forgotten('x3')] });
  const b = deepFreeze({ items: [forgotten('x4'), forgotten('x5'), forgotten('x6')] });
  const beforeA = snapshot(a);
  const { merged } = mergeForgottenState(a, b);
  assert.equal(merged.length, 6);
  assert.equal(snapshot(a), beforeA);
  assert.deepEqual(merged.map((x) => x.id), ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'], '保留 a 的顺序，b 的新增接在后面');
});

test('diary：A 原样保留（含空行/标题/行尾），B 独有行按顺序追加', () => {
  const A = '# 日记\n\n## 11-09\n今天下雨\n';
  const B = '# 日记\n\n## 11-09\n今天下雨\n\n## 11-10\n今天晴\n';
  const out = mergeDiaryText(A, B);
  assert.equal(out, '# 日记\n\n## 11-09\n今天下雨\n## 11-10\n今天晴\n');
  assert.ok(out.startsWith(A), 'A 的每个字节都要在前缀里原样保留');
});

test('diary：B 里已有的行不重复加，B 内部重复行也只加一次', () => {
  assert.equal(mergeDiaryText('a\nb', 'b\nc\nc\nd'), 'a\nb\nc\nd');
  assert.equal(mergeDiaryText('a\n', 'a\nb\na\n'), 'a\nb\n');
});

test('diary：CRLF 的行尾 \r 不算"不同的行"，不会被重复追加', () => {
  const A = 'a\r\nb\r\n';
  const out = mergeDiaryText(A, 'a\nb\nc\n');
  assert.equal(out, 'a\r\nb\r\nc\n');
  assert.equal(out.split('a').length - 1, 1);
});

test('diary：一侧为 null 时直接用另一侧原文（mergeDiaryFile）', () => {
  const left = { a: null, b: 'x\ny\n' };
  const r1 = mergeDiaryFile(left);
  assert.equal(r1.text, 'x\ny\n');
  assert.deepEqual(r1.stats, { linesA: 0, linesB: 2, linesMerged: 2, addedFromB: 2 });

  const r2 = mergeDiaryFile({ a: 'x\ny\n', b: null });
  assert.equal(r2.text, 'x\ny\n');
  assert.deepEqual(r2.stats, { linesA: 2, linesB: 0, linesMerged: 2, addedFromB: 0 });

  const r3 = mergeDiaryFile({ a: null, b: null });
  assert.equal(r3.text, '');
  assert.deepEqual(r3.stats, { linesA: 0, linesB: 0, linesMerged: 0, addedFromB: 0 });

  const r4 = mergeDiaryFile();
  assert.equal(r4.text, '');
});

test('diary 全等时幂等：mergeDiaryText(x,x) === x，mergeDiaryFile 同理', () => {
  const x = '# 标题\n\n正文一\n\n正文二';   // 无结尾换行
  assert.equal(mergeDiaryText(x, x), x);
  assert.equal(mergeDiaryFile({ a: x, b: x }).text, x);
  const y = '# 标题\n\n正文一\n\n正文二\n'; // 有结尾换行
  assert.equal(mergeDiaryText(y, y), y);
  assert.equal(mergeDiaryFile({ a: y, b: y }).text, y);
});

test('diary 合并 stats 数字正确', () => {
  const r = mergeDiaryFile({ a: 'l1\nl2\nl3\n', b: 'l2\nl4\nl5\n' });
  assert.equal(r.text, 'l1\nl2\nl3\nl4\nl5\n');
  assert.deepEqual(r.stats, { linesA: 3, linesB: 3, linesMerged: 5, addedFromB: 2 });
});

test('newerFactsEntry 导出可用：时间晚者胜，全同给 tie', () => {
  const older = fact('f1', { touched: '2026-01-01T00:00:00.000Z' });
  const newer = fact('f1', { touched: '2026-02-01T00:00:00.000Z' });
  assert.equal(newerFactsEntry(older, newer), 'b');
  assert.equal(newerFactsEntry(newer, older), 'a');
  assert.equal(newerFactsEntry(older, clone(older)), 'tie');
  // 对称性：无时间戳且内容不同时，倒过来问是相反的答案（同一个逻辑侧总是胜出）
  const p = { id: 'f1', text: 'abc' };
  const q = { id: 'f1', text: 'xyz' };
  assert.equal(newerFactsEntry(p, q), 'b');
  assert.equal(newerFactsEntry(q, p), 'a');
});

test('裸数组也当条目列表认（不要求包在 {facts} 里）', () => {
  const { merged } = mergeFactsState([fact('f1')], [fact('f2')]);
  assert.deepEqual(merged.map((x) => x.id), ['f1', 'f2']);
});

test('合并结果与 input 对象不共享引用（数组和条目都是新的）', () => {
  const a = { facts: [fact('f1')] };
  const { merged } = mergeFactsState(a, null);
  assert.notEqual(merged, a.facts);
  assert.notEqual(merged[0], a.facts[0]);
});
