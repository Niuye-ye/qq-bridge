// state-store.mjs 的单元测试 + 现网数据 round-trip。
//
// 钉住的缺陷：
//   S1 落盘白名单必须覆盖加载分支（B1：turboLast / mcMode 写进去读不回来 → 重启归零）
//   S2 round-trip：读现网 state/social-v2.json → 序列化 → 解析，顶层与每个会话的字段集合必须相等
//   S3 写盘防抖：突发 save() 只落一次盘；内容没变不写；flush() 立即落盘（B6）
//   S4 加载归一化：triggers 只留已知键、speakerIds 只留 QQ 号、私聊清空名单、成本 null 不被写成 0
//   S5 过期清理：已到期的 turbo / mcMode 加载后作废
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SAVE_DEBOUNCE_MS,
  buildSocialV2Payload,
  createSocialV2Store,
  defaultWakeConfigV2,
  normalizeSpeakerIdsV2,
  parseSocialV2State,
  pickWakeTriggersV2,
  refreshDefaultWakeConfigV2,
  serializeSocialV2State
} from '../src/state-store.mjs';
import { sanitizeForwardId } from '../src/forward.js';

const LIVE_FILE = path.resolve(import.meta.dirname, '..', 'state', 'social-v2.json');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-'));
  return path.join(dir, name);
}

// 与 bridge.js 的 readJsonSafe/atomicWriteJson 同语义的最小实现（模块只依赖注入）。
function readJsonSafe(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function makeStore(file, state, opts = {}) {
  return createSocialV2Store({
    file,
    readJsonSafe,
    atomicWriteJson,
    getState: () => state,
    getWakeConfig: () => opts.wakeCfg ?? {},
    sanitizeForwardId,
    debounceMs: opts.debounceMs ?? 20,
    log: () => {}
  });
}

function convState(over = {}) {
  return {
    wakeConfig: { ...defaultWakeConfigV2({}), ...(over.wakeConfig || {}) },
    recentMessages: [], unread: [], lastWakeReason: '', lastAiReplyAt: 1, lastActionAt: 2,
    agentToken: 'tok-' + Math.random().toString(16).slice(2), bootstrapSent: false,
    wakeTimes: [], sendTimes: [], stickerCollectTimes: [], lastIncomingAt: 3,
    preSleepWaitSatisfiedAt: 0, preSleepWaitObservedAt: 0, preSleepWaitAccumMs: 0,
    lastUnreadSeq: 7, lastReadThroughSeq: 5, activeTopics: [], pendingThoughts: [],
    memberImpressions: {}, deskMessages: [], ...over
  };
}

test('S1 落盘白名单覆盖 turboLast / mcMode（B1 回归）', () => {
  const state = {
    paused: false,
    turbo: null,
    level: { id: 'normal', label: '正常', minutes: 10 },
    turboLast: { since: 1, until: 2, hours: 1.5, everyMinutes: 10, costCny: 0.37, endedAt: 3, endedBy: 'expired' },
    mcMode: { on: true, since: 10, until: Date.now() + 60000 },
    conversations: new Map([['private:1', convState()]]),
    seenForwardIds: new Map()
  };
  const payload = buildSocialV2Payload(state);
  for (const key of ['paused', 'turbo', 'turboLast', 'level', 'mcMode', 'conversations']) {
    assert.ok(key in payload, `落盘缺字段：${key}`);
  }
  // 每个落盘字段都必须能被加载回来（否则就是重启归零）
  const back = parseSocialV2State(payload, { sanitizeForwardId });
  assert.equal(back.turboLast.hours, 1.5);
  assert.equal(back.turboLast.costCny, 0.37);
  assert.equal(back.turboLast.endedBy, 'expired');
  assert.deepEqual(back.mcMode, { on: true, since: 10, until: state.mcMode.until });
  assert.deepEqual(back.level, state.level);
});

test('S1b turboLast 为空时保持 null（不写成 0，桌宠显示「上次没数据」）', () => {
  const back = parseSocialV2State({ turboLast: { costCny: null } }, { sanitizeForwardId });
  assert.equal(back.turboLast.costCny, null);
});

test('S2 现网 social-v2.json round-trip：字段集合相等', { skip: !fs.existsSync(LIVE_FILE) }, () => {
  const raw = readJsonSafe(LIVE_FILE, null);
  assert.ok(raw, '现网状态文件读不出来');
  const parsed = parseSocialV2State(raw, { getWakeConfig: () => ({}), sanitizeForwardId });
  const payload = buildSocialV2Payload({
    paused: parsed.paused,
    turbo: parsed.turbo,
    turboLast: parsed.turboLast,
    level: parsed.level,
    mcMode: parsed.mcMode,
    conversations: parsed.conversations,
    seenForwardIds: parsed.seenForwardIds
  });
  assert.deepEqual(Object.keys(payload).sort(), ['conversations', 'level', 'mcMode', 'paused', 'turbo', 'turboLast']);
  const keysOf = (o) => Object.keys(o || {}).sort();
  assert.deepEqual(keysOf(payload.conversations), keysOf(raw.conversations), '会话集合不相等');
  for (const key of Object.keys(raw.conversations)) {
    // 现网文件里已有的字段必须一个不少地写回去
    for (const field of Object.keys(raw.conversations[key])) {
      assert.ok(field in payload.conversations[key], `会话 ${key} 丢了字段：${field}`);
    }
  }
  // 写→读→写必须稳定（幂等），否则每次启动都会改动文件
  const text1 = serializeSocialV2State({
    paused: parsed.paused, turbo: parsed.turbo, turboLast: parsed.turboLast, level: parsed.level,
    mcMode: parsed.mcMode, conversations: parsed.conversations, seenForwardIds: parsed.seenForwardIds
  });
  const parsed2 = parseSocialV2State(JSON.parse(text1), { getWakeConfig: () => ({}), sanitizeForwardId });
  const text2 = serializeSocialV2State({
    paused: parsed2.paused, turbo: parsed2.turbo, turboLast: parsed2.turboLast, level: parsed2.level,
    mcMode: parsed2.mcMode, conversations: parsed2.conversations, seenForwardIds: parsed2.seenForwardIds
  });
  assert.equal(text2, text1, 'round-trip 不幂等');
});

test('S3 防抖：突发 save() 只落一次盘，flush() 立即落盘，内容没变不写（B6）', async () => {
  const file = tmpFile('social-v2.json');
  const state = { paused: false, turbo: null, level: null, turboLast: null, mcMode: null, conversations: new Map(), seenForwardIds: new Map() };
  const store = makeStore(file, state, { debounceMs: 20 });
  for (let i = 0; i < 20; i += 1) {
    state.lastActionAt = i;
    state.conversations.set('private:1', convState({ lastActionAt: i }));
    store.save();
  }
  assert.equal(fs.existsSync(file), false, '防抖期间不该有落盘');
  assert.ok(SAVE_DEBOUNCE_MS >= 100);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(store.writes, 1, `20 次 save 应合并成 1 次写盘，实际 ${store.writes}`);
  // 状态没变的 save 不再写盘
  store.save();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(store.writes, 1, '内容未变时不应落盘');
  // flush 立刻写
  state.turboLast = { since: 1, until: 2, hours: 1, everyMinutes: 5, costCny: 1, endedAt: 3, endedBy: 'manual' };
  store.save();
  assert.equal(store.flush(), true);
  const written = readJsonSafe(file, null);
  assert.equal(written.turboLast.hours, 1, 'flush 后磁盘上没有最新的 turboLast');
});

test('S4 加载归一化：triggers 白名单 / speakerIds / 私聊 / 原型链', () => {
  const raw = {
    conversations: {
      'group:42': {
        wakeConfig: { triggers: { atMention: false, speakerIds: ['123', 'null', 123, '0', 'abc'], keywords: ['x'], evil: 'junk' } },
        memberImpressions: { __proto__: { polluted: 1 }, alice: 'nice' }
      },
      'private:9': { wakeConfig: { triggers: { speakerIds: ['555'] } } }
    }
  };
  const parsed = parseSocialV2State(raw, { sanitizeForwardId });
  const grp = parsed.conversations.get('group:42');
  assert.deepEqual(Object.keys(grp.wakeConfig.triggers).sort(), ['anyMessage', 'atMention', 'keywords', 'nameMention', 'poke', 'probability', 'question', 'speakerIds'].sort());
  // 显式设过配置的会话才保留触发值（默认配置会被推荐值整体刷新，这是既有行为）
  const kept = parseSocialV2State({
    conversations: { 'group:42': { wakeConfig: { confirmedBy: 'agent', triggers: { atMention: false, junk: 1, speakerIds: ['123', 'null', 123, '0', 'abc'] } } } }
  }, { sanitizeForwardId }).conversations.get('group:42');
  assert.equal(kept.wakeConfig.triggers.atMention, false);
  assert.equal('junk' in kept.wakeConfig.triggers, false);
  assert.deepEqual(kept.wakeConfig.triggers.speakerIds, ['123']);
  assert.deepEqual(parseSocialV2State({
    conversations: { 'private:9': { wakeConfig: { confirmedBy: 'agent', triggers: { speakerIds: ['555'] } } } }
  }, { sanitizeForwardId }).conversations.get('private:9').wakeConfig.triggers.speakerIds, []);
  assert.equal(grp.memberImpressions.alice, 'nice');
  assert.equal(Object.prototype.hasOwnProperty.call(grp.memberImpressions, '__proto__'), false);
  assert.deepEqual(parsed.conversations.get('private:9').wakeConfig.triggers.speakerIds, []);
  // 非法会话 key 直接丢弃
  assert.equal(parseSocialV2State({ conversations: { 'weird:1': {} } }, {}).conversations.size, 0);
});

test('S5 过期清理与默认配置刷新', () => {
  const now = Date.now();
  const parsed = parseSocialV2State({
    turbo: { on: true, since: 1, until: now - 1000 },
    mcMode: { on: true, since: 1, until: now - 1000 },
    level: { minutes: 9999, label: 'x' }
  }, { sanitizeForwardId });
  assert.equal(parsed.turbo, null);
  assert.equal(parsed.mcMode, null);
  assert.equal(parsed.level.minutes, 720, '档位分钟数必须夹在 1~720');

  // confirmedBy === 'default' 的会话跟着新推荐值走；显式设过的不动
  const st = { wakeConfig: { ...defaultWakeConfigV2({}), batchWindowMs: 9999 } };
  assert.equal(refreshDefaultWakeConfigV2(st, { batchWindowMs: 5000 }), true);
  assert.equal(st.wakeConfig.batchWindowMs, 5000);
  const fixed = { wakeConfig: { ...defaultWakeConfigV2({}), confirmedBy: 'agent', batchWindowMs: 7000 } };
  assert.equal(refreshDefaultWakeConfigV2(fixed, { batchWindowMs: 5000 }), false);
  assert.equal(fixed.wakeConfig.batchWindowMs, 7000);

  assert.deepEqual(normalizeSpeakerIdsV2('1,2,,x,2'), ['1', '2']);
  assert.deepEqual(pickWakeTriggersV2({ atMention: 1, junk: 2 }, { question: 3 }), { atMention: 1, question: 3 });
});

test('S6 load()：文件被别的进程改写时不回写', () => {
  const file = tmpFile('social-v2.json');
  const raw = { paused: false, conversations: { 'group:1': { wakeConfig: { ...defaultWakeConfigV2({}) } } } };
  fs.writeFileSync(file, JSON.stringify(raw));
  const state = { paused: false, turbo: null, level: null, turboLast: null, mcMode: null, conversations: new Map(), seenForwardIds: new Map() };
  const store = createSocialV2Store({
    file,
    readJsonSafe,
    atomicWriteJson,
    getState: () => state,
    getWakeConfig: () => ({}),
    sanitizeForwardId,
    statStamp: (() => { let n = 0; return () => `stamp-${n += 1}`; })(), // 读前后指纹不同 = 期间被改写
    log: () => {}
  });
  const parsed = store.load({ onConversation: () => {} });
  assert.ok(parsed);
  assert.equal(store.writes, 0, '文件被改写时不得回写');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('S8 磁盘文件被外部删掉/改坏后，内容没变也要重写自愈', () => {
  // 2026-10-28 审计 A-P2：原来 writeNow 只比内存文本，文本一样就跳过写盘。
  // 文件被外部删掉或写坏时，内存里一切正常、磁盘上已经废了，跳过写入 = 坏文件留在原地，
  // 下次启动 load() 只能把它改名成 .corrupt 再空跑。这里用真 stat 指纹测自愈。
  const file = tmpFile('social-v2.json');
  const state = { paused: false, turbo: null, level: null, turboLast: null, mcMode: null, conversations: new Map([['group:2', convState()]]), seenForwardIds: new Map() };
  const store = makeStore(file, state);
  assert.equal(store.flush(), true, '首次落盘');
  assert.equal(store.flush(), false, '内容没变且磁盘没被动过 → 不写');
  fs.writeFileSync(file, '{ 这不是 JSON');
  assert.equal(store.flush(), true, '磁盘被改坏 → 必须重写覆盖');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).conversations['group:2']);
  fs.rmSync(file, { force: true });
  assert.equal(store.flush(), true, '磁盘文件不见了 → 必须重写回来');
  assert.ok(fs.existsSync(file));
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('S7 deskMessages 写得出就读得回（B1 同族最后缺口）', () => {
  // 桥的 /api/socialV2/desk-message 会把主人当面说的话 push 进 st.deskMessages（{at, text}），
  // 但 parseSocialV2State 曾经根本没有这个字段 —— 桥一重启，reason='desk' 的唤醒提示词
  // 就变成「（没留下记录）」。这里钉住写→读的往返。
  const conversations = new Map([
    ['private:1946431105', convState({
      deskMessages: [
        { at: 1700000000000, text: '帮我看看桌面这个报错' },
        { at: 1700000001000, text: '在吗' },
        { text: '缺 at 也要留着' },
        { at: 1, text: 123 },
        null,
        'junk'
      ]
    })]
  ]);
  const text = serializeSocialV2State({ paused: false, conversations, seenForwardIds: new Map() });
  const back = parseSocialV2State(JSON.parse(text), { sanitizeForwardId });
  const dm = back.conversations.get('private:1946431105').deskMessages;
  assert.equal(dm.length, 3, '非对象/非字符串条目必须被剔掉');
  assert.equal(dm[0].text, '帮我看看桌面这个报错');
  assert.equal(dm[0].at, 1700000000000);
  assert.equal(dm[2].at, 0, '缺 at 的条目 at 归一成 0，不许丢');
  // 超长文本按写入口的 2000 字符上限截断，防止状态文件被一条长文撑爆
  const long = parseSocialV2State({
    conversations: { 'private:1': { deskMessages: [{ at: 1, text: 'x'.repeat(5000) }] } }
  }, { sanitizeForwardId }).conversations.get('private:1').deskMessages;
  assert.equal(long[0].text.length, 2000);
  // 只要最后 20 条
  const many = parseSocialV2State({
    conversations: { 'private:1': { deskMessages: Array.from({ length: 40 }, (_, i) => ({ at: i, text: 'm' + i })) } }
  }, { sanitizeForwardId }).conversations.get('private:1').deskMessages;
  assert.equal(many.length, 20);
  assert.equal(many[19].text, 'm39');
});