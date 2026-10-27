// goals-life 数据层回归（2026-10-27 审计 bridge-core P2×2 + P3 同族修复）
// 跑法：node scripts/test-goals-life.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE = path.join(ROOT, 'state');
const GOALS = path.join(STATE, 'goals.json');
const LIFE = path.join(STATE, 'life.json');

// 这两个文件是运行中的真实状态，跑测试前先备份、跑完还原（别把她的目标清了）
const backup = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const goalsBak = backup(GOALS);
const lifeBak = backup(LIFE);
const restore = (f, v) => { if (v === null) { try { fs.unlinkSync(f); } catch {} } else fs.writeFileSync(f, v, 'utf8'); };

const GL = await import('../src/goals-life.js');

test('写目标：落盘完整、不留临时文件', () => {
  fs.mkdirSync(STATE, { recursive: true });
  restore(GOALS, null);
  const g = GL.addGoalV2('把审计报告收敛成处置清单', { want: 0.8 });
  assert.ok(g && g.id);
  const disk = JSON.parse(fs.readFileSync(GOALS, 'utf8'));
  assert.equal(disk.goals.length, 1);
  assert.equal(disk.goals[0].text, '把审计报告收敛成处置清单');
  const leftovers = fs.readdirSync(STATE).filter((n) => n.startsWith('goals.json.tmp'));
  assert.deepEqual(leftovers, [], '不该留下临时文件');
});

test('目标文件损坏：读回空列表但拒绝覆盖（不二次蒸发）', () => {
  fs.writeFileSync(GOALS, '{ "goals": [ 坏掉的 JSON', 'utf8');
  assert.deepEqual(GL.readGoalsV2(), []);
  assert.throws(() => GL.addGoalV2('这条不该写进去'), /只读/);
  assert.match(fs.readFileSync(GOALS, 'utf8'), /坏掉的 JSON/, '坏文件必须原地保留');
});

test('生活线：本地凌晨写的那条当天必须看得到（原来按 UTC 日期比较会漏）', () => {
  fs.mkdirSync(STATE, { recursive: true });
  restore(LIFE, null);
  const d = new Date();
  d.setHours(0, 30, 0, 0);              // 本地 00:30，ISO 里是前一天（+08:00 时区）
  const iso = d.toISOString();
  fs.writeFileSync(LIFE, JSON.stringify({ timeline: [{ t: '00:30', text: '凌晨写的这条', at: iso }] }), 'utf8');
  const line = GL.formatLifeLineV2();
  assert.match(line, /凌晨写的这条/);
});

test('生活线：昨天的条目不进「今天早些时候」', () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  fs.writeFileSync(LIFE, JSON.stringify({ timeline: [{ t: '23:00', text: '昨天半夜的', at: d.toISOString() }] }), 'utf8');
  assert.equal(GL.formatLifeLineV2(), '');
});

test('appendLifeV2：截断到 60 条且原子写', () => {
  restore(LIFE, null);
  for (let i = 0; i < 65; i++) GL.appendLifeV2('第 ' + i + ' 条');
  const disk = JSON.parse(fs.readFileSync(LIFE, 'utf8'));
  assert.equal(disk.timeline.length, 60);
  assert.equal(disk.timeline[59].text, '第 64 条');
  assert.deepEqual(fs.readdirSync(STATE).filter((n) => n.startsWith('life.json.tmp')), []);
});

test.after(() => {
  restore(GOALS, goalsBak);
  restore(LIFE, lifeBak);
});
