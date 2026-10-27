// src/memory-facts.mjs 的离线测试（架构第二步搬迁后的守门测试）。
// 全部在临时目录里跑：createFactsStore({ root }) 只认入参，不认仓库位置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFactsStore } from '../src/memory-facts.mjs';

const atomicWriteJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
};

function fresh({ files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-test-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  const logs = [];
  const store = createFactsStore({ root, log: (m) => logs.push(String(m)), atomicWriteJson });
  return { root, store, logs };
}

test('写读 round-trip，且不留 .tmp', () => {
  const { root, store } = fresh();
  const f = store.addFactV2('他喜欢在深夜写代码', { kind: 'pref' });
  assert.equal(f.text, '他喜欢在深夜写代码');
  const back = store.readFactsV2();
  assert.equal(back.length, 1);
  assert.equal(back[0].text, '他喜欢在深夜写代码');
  const stray = fs.readdirSync(path.join(root, 'state')).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(stray, []);
});

test('facts.json 解析失败 → 切只读、拒覆盖，原文一个字不动', () => {
  const broken = '{"facts": [ 这不是 JSON';
  const { root, store, logs } = fresh({ files: { 'state/facts.json': broken } });
  assert.deepEqual(store.readFactsV2(), []);
  assert.match(logs.join('\n'), /解析失败，已切成只读/);
  assert.throws(() => store.addFactV2('随便记一条'), /只读/);
  assert.equal(fs.readFileSync(path.join(root, 'state/facts.json'), 'utf8'), broken);
});

test('只差虚词的两句算同一条，只算一次复习', () => {
  const { store } = fresh();
  store.addFactV2('她喜欢在晚上写代码', { kind: 'fact' });
  store.addFactV2('她喜欢晚上写代码', { kind: 'fact' });
  const facts = store.readFactsV2();
  assert.equal(facts.length, 1);
  assert.equal(Number(facts[0].hits) || 0, 1);
});

test('软删 → 遗忘池翻得到；对同一条再删一次才彻底抹掉', () => {
  const { store } = fresh();
  store.addFactV2('他怕打雷', { kind: 'fact' });
  const r1 = store.removeFactV2('打雷');
  assert.equal(r1.soft, 1);
  assert.equal(store.readFactsV2().length, 0);
  assert.equal(store.searchFactsV2('打雷').length, 1);
  const r2 = store.removeFactV2('打雷');
  assert.equal(r2.hard, 1);
  assert.equal(store.searchFactsV2('打雷').length, 0);
});

test('衰减归档：老见闻进遗忘池，long 永远留着', () => {
  const { store } = fresh();
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  store.writeFactsV2([
    { id: 'a', text: '去年冬天下过一场很大的雪', kind: 'event', tier: 'normal', at: old, str: 0.4 },
    { id: 'b', text: '他叫主人', kind: 'fact', tier: 'long', at: old, str: 0.4 },
  ]);
  const r = store.archiveFactsV2(true);
  assert.equal(r.archived, 1);
  assert.deepEqual(store.readFactsV2().map((f) => f.id), ['b']);
  assert.equal(store.readForgottenFactsV2().length, 1);
});

test('超过上限淘汰最弱的，刚写入的那条一定留下', () => {
  const { store } = fresh();
  const now = new Date().toISOString();
  const seed = [];
  for (let i = 0; i < 80; i += 1) {
    seed.push({ id: 'old' + i, text: '旧事第 ' + i + ' 条', kind: 'fact', tier: 'normal', at: now, str: 0.9, hits: 1 });
  }
  // 把其中一条做得极弱，淘汰时必须先挑它。
  seed[7].str = 0.05;
  store.writeFactsV2(seed);
  store.addFactV2('今天记住的一件新事', { kind: 'fact' });
  const facts = store.readFactsV2();
  assert.equal(facts.length, 80);
  assert.ok(facts.some((f) => f.text === '今天记住的一件新事'));
  assert.ok(!facts.some((f) => f.id === 'old7'));
});

test('过期约定：宽限期一过就归档，不再当约定', () => {
  const { store } = fresh();
  const exp = new Date(Date.now() - 5 * 86400000).toISOString();
  store.writeFactsV2([{ id: 'p', text: '周六一起看电影', kind: 'promise', tier: 'normal', at: exp, expiresAt: exp, str: 0.9 }]);
  store.archiveFactsV2(true);
  assert.equal(store.readFactsV2().length, 0);
  assert.equal(store.readForgottenFactsV2().length, 1);
});