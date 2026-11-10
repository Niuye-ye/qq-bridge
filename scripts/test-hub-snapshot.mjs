// hub 快照的离线测试：全部依赖注入，不碰真端口、不碰真 state。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectSnapshot, moodView, factsView, diaryView, goalsView, lifeView, activityView,
  MOOD_LABELS, HUB_PORTS,
} from '../src/hub/snapshot.mjs';

function mkRoot(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-snap-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'diary'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  }
  return root;
}

const PORT_OF = { napcat: 6099, onebot: 3000, onebotWs: 3001, dsh: 3080, bridge: 3100, cap: 8791 };

test('满血：五个灯 + 她的四份数据 + 桥状态', async () => {
  const root = mkRoot({
    'state/activity.json': { doing: '在刷小黑盒', note: '看到个帖子', plan: '等会儿去玩', updatedAt: '2026-11-10T15:00:00.000Z' },
    'state/mood.json': { mood: 'happy', affinity: 8.4, note: '今天不错' },
    'state/facts.json': { facts: [{ tier: 'long' }, { tier: 'long' }, { tier: 'normal' }, { tier: 'normal' }, { tier: 'normal' }] },
    'diary/2026-11-09.md': '昨天写了三百字'.repeat(10),
    'diary/2026-11-10.md': '今天写了十四个字'.repeat(2),
    'state/goals.json': { goals: [{ id: 'g1', text: '学吉他', want: 3 }, { id: 'g2', text: '减肥', want: 9 }, { id: 'g3', text: '已做完', want: 100, status: 'done' }] },
    'state/life.json': { timeline: [{ t: '09:00', text: '起床' }, { t: '12:00', text: '吃饭' }, { t: '15:00', text: '刷手机' }] },
  });
  const now = Date.parse('2026-11-10T16:00:00.000Z');
  const snap = await collectSnapshot({
    root,
    probePort: async () => true,
    bridgeStatus: async () => ({ mode: 'reserved2', dshReady: true, socialV2Paused: false, ownerQQ: '1946431105', snowluma: { connected: true, accountOnline: true, lastPacketAgoMs: 1200 } }),
    now,
  });
  assert.equal(snap.upCount, HUB_PORTS.length);
  assert.equal(snap.total, HUB_PORTS.length);
  assert.deepEqual(snap.services.map((s) => s.key), HUB_PORTS.map((p) => p.key));
  assert.equal(snap.her.activity.doing, '在刷小黑盒');
  assert.equal(snap.her.mood.label, '开心');
  assert.equal(snap.her.mood.percent, 84);
  assert.deepEqual(snap.her.facts, { total: 5, long: 2, normal: 3 });
  assert.equal(snap.her.diary.days, 2);
  assert.equal(snap.her.diary.lastDate, '2026-11-10');
  assert.deepEqual(snap.her.goals.map((g) => g.id), ['g2', 'g1']);
  assert.equal(snap.her.life.length, 3);
  assert.equal(snap.bridge.mode, 'reserved2');
  assert.equal(snap.bridge.snow.accountOnline, true);
  assert.equal(snap.bridge.snow.lastPacketAgoMs, 1200);
  assert.equal(snap.host.pid, process.pid);
});

test('空目录：不抛错，各字段给空值', async () => {
  const root = mkRoot();
  const snap = await collectSnapshot({ root, probePort: async () => false, bridgeStatus: async () => null });
  assert.equal(snap.ok, true);
  assert.equal(snap.upCount, 0);
  assert.equal(snap.bridge, null);
  assert.equal(snap.her.facts.total, 0);
  assert.equal(snap.her.diary.days, 0);
  assert.deepEqual(snap.her.goals, []);
  assert.deepEqual(snap.her.life, []);
  assert.equal(snap.her.activity.doing, '');
});

test('坏 JSON / 坏文件：只让对应字段空，不整份失败', async () => {
  const root = mkRoot({
    'state/activity.json': '{ 这不是 json',
    'state/mood.json': 'null',
    'state/facts.json': '',
    'state/goals.json': '[]',
  });
  const snap = await collectSnapshot({ root, probePort: async () => true, bridgeStatus: async () => { throw new Error('bridge down'); } });
  assert.equal(snap.bridge, null);
  assert.equal(snap.her.activity.doing, '');
  assert.equal(snap.her.mood, null);
  assert.equal(snap.her.facts.total, 0);
  assert.equal(snap.upCount, HUB_PORTS.length);
});

test('probePort 抛错 = 当成 down，不中断其他灯', async () => {
  const root = mkRoot();
  const snap = await collectSnapshot({
    root,
    probePort: async (port) => { if (port === 3100) throw new Error('boom'); return port !== 8791; },
    bridgeStatus: async () => null,
  });
  const by = Object.fromEntries(snap.services.map((s) => [s.key, s.up]));
  assert.equal(by.bridge, false);
  assert.equal(by.cap, false);
  assert.equal(by.dsh, true);
  assert.equal(snap.upCount, HUB_PORTS.length - 2);
});

test('moodView：未知心情用原文，缺 affinity 给 null', () => {
  assert.equal(moodView({ mood: 'grumpy' }).label, 'grumpy');
  assert.equal(moodView({}).label, '说不清');
  assert.equal(moodView({ mood: 'low' }).percent, null);
  assert.equal(moodView({ affinity: 10 }).percent, 100);
  assert.equal(moodView({ affinity: 0 }).percent, 0);
  assert.equal(moodView(null), null);
  assert.equal(Object.keys(MOOD_LABELS).length >= 5, true);
});

test('factsView：坏条目跳过，tier 缺失算 normal', () => {
  assert.deepEqual(factsView({ facts: [null, 1, {}, { tier: 'long' }, { tier: 'weird' }] }), { total: 5, long: 1, normal: 2 });
  assert.deepEqual(factsView({}), { total: 0, long: 0, normal: 0 });
});

test('diaryView：只数 .md，今天按传入时间算', () => {
  const root = mkRoot({ 'diary/2026-11-10.md': 'abcd', 'diary/2026-11-08.md': 'ab', 'diary/notes.txt': 'xxxxxx' });
  const v = diaryView(path.join(root, 'diary'), new Date(2026, 10, 10, 20, 0, 0).getTime());
  assert.equal(v.days, 2);
  assert.equal(v.todayChars, 4);
  assert.equal(v.totalChars, 6);
  assert.equal(v.lastDate, '2026-11-10');
  assert.equal(diaryView(path.join(root, 'nope'), Date.now()).days, 0);
});

test('goalsView / lifeView：排序、截断、字段兜底', () => {
  const g = goalsView({ goals: [
    { id: 'a', text: '低', want: 1 }, { id: 'b', text: '高', want: 5 }, { id: 'c', text: '中', want: 3 },
    { id: 'd', text: '关的', want: 9, status: 'done' }, null,
  ] }, 2);
  assert.deepEqual(g.map((x) => x.id), ['b', 'c']);
  const l = lifeView({ timeline: [{ t: '1', text: 'a' }, { t: '2', text: 'b' }, { t: '3', text: 'c' }] }, 2);
  assert.deepEqual(l.map((x) => x.text), ['b', 'c']);
  assert.deepEqual(lifeView({}), []);
  assert.equal(activityView(null).doing, '');
});

test('桥返回缺字段：全部兜成 false/null，不猜', async () => {
  const root = mkRoot();
  const snap = await collectSnapshot({ root, probePort: async () => true, bridgeStatus: async () => ({}) });
  assert.equal(snap.bridge.mode, null);
  assert.equal(snap.bridge.dshReady, false);
  assert.equal(snap.bridge.paused, false);
  assert.equal(snap.bridge.snow.connected, false);
  assert.equal(snap.bridge.snow.lastPacketAgoMs, null);
});
