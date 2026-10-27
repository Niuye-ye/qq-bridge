// social-v2.json 的「序列化 / 反序列化」数据层。
//
// 从 bridge.js 的 :8925-9398 整块搬出来的**纯数据**部分：字段白名单、加载归一化、
// 原子写盘与去重。刻意**不含**任何副作用 —— 唤醒定时器、令牌账本、主动检查排程、
// 会话状态机都留在 bridge.js，通过 load() 的 onConversation 回调挂回去。
//
// 为什么值得单独成模块：bridge.js 13510 行且零 export，测试只能对抽出去的模块开刀；
// 这份读写是最容易「静默丢字段」的地方（B1：turboLast/mcMode 曾因不在白名单里，
// 重启即归零），拆出来就能拿现网 state/social-v2.json 做 round-trip 断言。
import fs from 'node:fs';
import crypto from 'node:crypto';

// triggers 的**唯一**合法字段集合。写入与加载都按它过滤：
// 旧写法 `{...current.triggers, ...inputTriggers}` 会把模型传来的任意键原样并入、
// 持久化、再由 qq_get_prompt 原样回给模型（每次请求都带着），等于给了一个
// 「用 1MB 垃圾键把状态文件与每轮 prompt 撑大」的入口。
export const WAKE_TRIGGER_KEYS = Object.freeze(['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability']);

// 归一化「指定群友发言唤醒」名单：
// - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/"null"/非法字符等脏数据；
// - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
// - undefined/null 都视为「不启用」（空数组）。
export function normalizeSpeakerIdsV2(value) {
  if (value === undefined || value === null) return [];
  const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
  const seen = new Set();
  const clean = [];
  for (const v of rawList) {
    const s = String(v ?? '').trim();
    if (!/^[1-9]\d*$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    clean.push(s);
    if (clean.length >= 20) break;
  }
  return clean;
}

export function pickWakeTriggersV2(source, fallback = {}) {
  const out = {};
  const src = source && typeof source === 'object' ? source : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  for (const name of WAKE_TRIGGER_KEYS) {
    const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export function defaultWakeConfigV2(wakeCfg = {}) {
  const w = wakeCfg && typeof wakeCfg === 'object' ? wakeCfg : {};
  const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
  const defaultInfinite = w.recommendedDefaultInfinite !== false;
  const recMin = Number(w.recommendedSleepMinMs) || 300000;
  const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
  let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
  const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
  const hardMax = Number(w.sleepMaxMs) || 0;
  if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
  if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
  return {
    mode: defaultMode,
    infinite: defaultInfinite,
    sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
    triggers: {
      atMention: w.recommendedAtMention !== false,
      nameMention: w.recommendedNameMention !== false,
      speakerIds: [],
      keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
      question: w.recommendedQuestion !== false,
      poke: w.recommendedPoke !== false,
      anyMessage: defaultMode === 'active',
      probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
    },
    batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
    lastWakeAt: 0,
    wakeCount: 0,
    noActionCount: 0,
    confirmedAt: 0,
    confirmedBy: 'default'
  };
}

// 把"仍使用默认唤醒配置"的会话刷新为当前推荐/默认参数。
// 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
export function refreshDefaultWakeConfigV2(st, wakeCfg) {
  if (!st || !st.wakeConfig) return false;
  if (st.wakeConfig.confirmedBy !== 'default') return false;
  const def = defaultWakeConfigV2(wakeCfg);
  const old = st.wakeConfig;
  st.wakeConfig = {
    ...def,
    lastWakeAt: old.lastWakeAt || 0,
    wakeCount: old.wakeCount || 0,
    noActionCount: old.noActionCount || 0,
    confirmedAt: old.confirmedAt || 0,
    confirmedBy: 'default'
  };
  return true;
}

const CONV_KEY_RE = /^(group|private):\d+$/;
const PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const num = (v) => Number(v) || 0;
const list = (v) => (Array.isArray(v) ? v : []);

/**
 * 落盘白名单（**唯一**一份）。
 *
 * 这里的每个字段都必须有对应的加载分支（见 normalizeConversation / loadSocialV2Meta），
 * 否则就是「写了读不回来」= 重启归零。B1 就是这么发生的：turboLast 在
 * bridge.js:12130 被写入、:9240 被读取，却从来没进这份白名单。
 */
/**
 * Map 判定不能写 instanceof：桥在 vm 上下文里跑自测（scripts/audit-bridge-harness.mjs），
 * 那个 realm 的 Map 和这里的 Map 不是同一个构造函数 —— 用 instanceof 会把真实 Map 判成
 * 普通对象，Object.entries(Map) 恒为 []，于是"落盘文件里 conversations 全是空的"，
 * 而且不报错。鸭子类型判定跨 realm 一样成立。
 */
function isMapLike(value) {
  return !!value && typeof value.get === 'function' && typeof value.set === 'function' && typeof value.entries === 'function';
}

export function buildSocialV2Payload(state) {
  const seenForwardIds = state.seenForwardIds;
  const convSource = isMapLike(state.conversations) ? state.conversations : new Map(Object.entries(state.conversations || {}));
  const obj = {
    paused: state.paused === true,
    turbo: state.turbo || null,
    // 上一次「去玩会儿」的结算（桌宠关掉后还要显示玩了多久、花了多少）
    turboLast: state.turboLast || null,
    level: state.level || null,
    // 玩游戏模式（玩 MC 时不被打断）。目前桥只赋 null，但仍然持久化：
    // 它曾在 :8963 被声明、:12062 被读取，却不在白名单里 → 一旦有人开始写它，
    // 重启就会静默失效。
    mcMode: state.mcMode || null,
    conversations: Object.create(null)
  };
  for (const [key, st] of convSource) {
    if (!st) continue;
    const seen = isMapLike(seenForwardIds) ? seenForwardIds.get(key) : seenForwardIds?.[key];
    obj.conversations[key] = {
      wakeConfig: st.wakeConfig,
      recentMessages: list(st.recentMessages).slice(-200),
      unread: list(st.unread).slice(-100),
      lastWakeReason: st.lastWakeReason,
      lastAiReplyAt: st.lastAiReplyAt,
      lastActionAt: st.lastActionAt,
      agentToken: st.agentToken,
      bootstrapSent: st.bootstrapSent,
      wakeTimes: list(st.wakeTimes).slice(-200),
      sendTimes: list(st.sendTimes).slice(-500),
      stickerCollectTimes: list(st.stickerCollectTimes).slice(-500),
      lastIncomingAt: st.lastIncomingAt || 0,
      preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
      preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
      preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
      lastUnreadSeq: st.lastUnreadSeq || 0,
      lastReadThroughSeq: st.lastReadThroughSeq || 0,
      activeTopics: list(st.activeTopics).slice(-50),
      pendingThoughts: list(st.pendingThoughts).slice(-50),
      memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
      seenForwardIds: Array.from(seen || []).slice(-1000),
      deskMessages: list(st.deskMessages).slice(-20)
    };
  }
  return obj;
}

export function serializeSocialV2State(state) {
  return JSON.stringify(buildSocialV2Payload(state), null, 2) + '\n';
}

function normalizeTurboLast(rawLast) {
  if (!rawLast || typeof rawLast !== 'object') return null;
  return {
    since: num(rawLast.since),
    until: num(rawLast.until),
    hours: num(rawLast.hours),
    everyMinutes: num(rawLast.everyMinutes),
    costCny: Number.isFinite(Number(rawLast.costCny)) && rawLast.costCny !== null ? Number(rawLast.costCny) : null,
    endedAt: num(rawLast.endedAt),
    endedBy: String(rawLast.endedBy || '')
  };
}

/** 玩游戏模式：{on, since, until}；已到期直接作废（与 turbo 的加载口径一致）。 */
function normalizeMcMode(rawMode, now) {
  if (!rawMode || rawMode.on !== true) return null;
  const until = num(rawMode.until);
  if (until && now >= until) return null;
  return { on: true, since: num(rawMode.since) || now, until };
}

function normalizeLevel(rawLevel) {
  if (rawLevel && Number(rawLevel.minutes) >= 1) {
    return {
      id: String(rawLevel.id || 'custom'),
      label: String(rawLevel.label || '自定义'),
      minutes: Math.min(720, Math.max(1, Number(rawLevel.minutes)))
    };
  }
  return null;
}

function normalizeTurbo(rawTurbo, now) {
  if (!rawTurbo || rawTurbo.on !== true) return null;
  const until = num(rawTurbo.until);
  if (until && now >= until) return null;
  return {
    on: true,
    since: num(rawTurbo.since) || now,
    until,
    by: String(rawTurbo.by || 'manual'),
    costAtStart: num(rawTurbo.costAtStart)
  };
}

function newAgentToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 把一份已解析的 social-v2.json 还原成运行时状态（**纯函数**，不装配定时器）。
 * 返回 { paused, turbo, turboLast, level, mcMode, conversations: Map, seenForwardIds: Map }。
 */
export function parseSocialV2State(raw, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const wakeCfg = typeof opts.getWakeConfig === 'function' ? opts.getWakeConfig() : opts.getWakeConfig;
  const sanitizeForwardId = opts.sanitizeForwardId || ((v) => String(v ?? ''));
  const out = {
    paused: raw?.paused === true,
    turbo: normalizeTurbo(raw?.turbo, now),
    turboLast: normalizeTurboLast(raw?.turboLast),
    level: normalizeLevel(raw?.level),
    mcMode: normalizeMcMode(raw?.mcMode, now),
    conversations: new Map(),
    seenForwardIds: new Map()
  };
  if (!raw || typeof raw?.conversations !== 'object' || raw.conversations === null) return out;
  const seenTokens = new Set();
  for (const [key, val] of Object.entries(raw.conversations)) {
    if (!val || typeof val !== 'object') continue;
    if (!CONV_KEY_RE.test(key)) continue;
    const defaultWc = defaultWakeConfigV2(wakeCfg);
    let agentToken = String(val.agentToken || newAgentToken());
    if (!agentToken || seenTokens.has(agentToken)) agentToken = newAgentToken();
    seenTokens.add(agentToken);
    const st = {
      wakeConfig: {
        ...defaultWc,
        ...(val.wakeConfig ?? {}),
        // 加载时也按已知字段过滤：旧状态文件里可能残留任意键（见 WAKE_TRIGGER_KEYS）。
        triggers: pickWakeTriggersV2(val.wakeConfig?.triggers ?? {}, defaultWc.triggers)
      },
      recentMessages: list(val.recentMessages),
      unread: list(val.unread),
      lastWakeReason: String(val.lastWakeReason ?? ''),
      lastAiReplyAt: num(val.lastAiReplyAt),
      lastActionAt: num(val.lastActionAt),
      agentToken,
      bootstrapSent: !!val.bootstrapSent,
      wakeTimes: list(val.wakeTimes),
      sendTimes: list(val.sendTimes),
      stickerCollectTimes: list(val.stickerCollectTimes),
      pendingWakeTimer: null,
      sleepTimer: null,
      replyCheckTimer: null,
      proactiveTimer: null,
      lastIncomingAt: num(val.lastIncomingAt),
      preSleepWaitSatisfiedAt: num(val.preSleepWaitSatisfiedAt),
      preSleepWaitObservedAt: num(val.preSleepWaitObservedAt),
      preSleepWaitAccumMs: num(val.preSleepWaitAccumMs),
      lastUnreadSeq: num(val.lastUnreadSeq),
      lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
        ? Math.min(val.lastReadThroughSeq, num(val.lastUnreadSeq))
        : 0,
      modelSeenSeqs: new Set(),
      activeTopics: list(val.activeTopics),
      pendingThoughts: list(val.pendingThoughts),
      // 2026-10-27：deskMessages 原来只写不读（B1 同族缺口）—— 桥一重启，reason='desk' 的唤醒提示词
      // 就变成「（没留下记录）」，主人在桌宠窗口当面说的话全丢。这里补上读回，形状与写入口一致：{at, text}。
      deskMessages: list(val.deskMessages)
        .filter((m) => m && typeof m === 'object' && typeof m.text === 'string')
        .map((m) => ({ at: num(m.at), text: String(m.text).slice(0, 2000) }))
        .slice(-20),
      memberImpressions: (() => {
        const rawImp = val.memberImpressions && typeof val.memberImpressions === 'object' ? val.memberImpressions : {};
        const clean = {};
        for (const [k, v] of Object.entries(rawImp)) {
          if (PROTO_KEYS.includes(k)) continue;
          clean[k] = v;
        }
        return clean;
      })()
    };
    // 旧状态/异常状态里的指定成员名单也统一归一化，防止"null"/非法值污染。
    if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
      st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
      if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
    }
    // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
    refreshDefaultWakeConfigV2(st, wakeCfg);
    out.conversations.set(key, st);
    // 重启后从已持久化的消息与 seenForwardIds 字段重建"本会话见过的 forward id"
    const rebuilt = new Set();
    for (const fid of list(val.seenForwardIds)) {
      const safe = sanitizeForwardId(fid);
      if (safe) rebuilt.add(safe);
    }
    for (const m of [...st.recentMessages, ...st.unread]) {
      if (Array.isArray(m?.forwardIds)) {
        for (const fid of m.forwardIds) {
          const safe = sanitizeForwardId(fid);
          if (safe) rebuilt.add(safe);
        }
      }
    }
    if (rebuilt.size) out.seenForwardIds.set(key, rebuilt);
  }
  return out;
}

export const SAVE_DEBOUNCE_MS = 400;

/**
 * social-v2.json 的读写器。
 *
 * 与旧实现的两点差别（就是审计里的 B6）：
 *  · 写盘防抖：54 个调用点里有大量「顺手存一下」（定时器、轮询、GET 读取都会触发），
 *    以前每次都要 JSON.stringify(63KB) + 写临时文件 + rename。现在只是标脏，400ms 内
 *    合并成一次真正落盘；
 *  · 落盘时再序列化（不是标脏时序列化），所以突发期间只有最后一次状态被写出去。
 *  · 依旧保留"文本一模一样就不写"的去重，GET 触发的空写依然为 0 次。
 *
 * 依赖全部注入（readJsonSafe / atomicWriteJson），方便单测脱离 bridge.js 跑。
 */
export function createSocialV2Store(deps) {
  const {
    file,
    log = () => {},
    readJsonSafe,
    atomicWriteJson,
    statStamp = defaultStatStamp,
    getState,
    getWakeConfig = () => ({}),
    sanitizeForwardId,
    debounceMs = SAVE_DEBOUNCE_MS,
    now = () => Date.now()
  } = deps;
  let lastSavedText = '';
  let dirty = false;
  let timer = null;
  let writes = 0;

  function defaultStatStamp() {
    try {
      const s = fs.statSync(file);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }

  function writeNow() {
    const state = getState();
    const text = serializeSocialV2State(state);
    if (text === lastSavedText) return false; // 内容没变，省掉一次 63KB 写盘
    atomicWriteJson(file, buildSocialV2Payload(state));
    lastSavedText = text;
    writes += 1;
    return true;
  }

  function cancelTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    /** 标记有改动；debounceMs 内合并成一次落盘。 */
    save() {
      dirty = true;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!dirty) return;
        dirty = false;
        try {
          writeNow();
        } catch (error) {
          log('保存 socialV2 状态失败:', error?.message ?? error);
        }
      }, debounceMs);
      timer.unref?.();
    },
    /** 立刻落盘（退出、重启前、写完就要读回来的地方）。 */
    flush() {
      cancelTimer();
      if (!dirty && lastSavedText) return false;
      dirty = false;
      try {
        return writeNow();
      } catch (error) {
        log('保存 socialV2 状态失败:', error?.message ?? error);
        return false;
      }
    },
    /**
     * 加载：读文件 → parseSocialV2State → 逐个会话回调装配 → 文件未被他人改写才回写一次。
     * 返回 null 表示读失败（保持调用方原行为：只记日志，继续跑）。
     */
    load({ onConversation, onMeta } = {}) {
      const stampBefore = statStamp();
      const raw = readJsonSafe(file, null);
      if (raw === null) return null;
      const parsed = parseSocialV2State(raw, { getWakeConfig, sanitizeForwardId, now: now() });
      // 元信息（paused / turbo / turboLast / level / mcMode）必须先就位：
      // 下面装配每个会话时会读 socialV2.paused 决定要不要起定时器。
      if (onMeta) onMeta(parsed);
      for (const [key, st] of parsed.conversations) {
        try {
          if (onConversation) onConversation(key, st, parsed);
        } catch (error) {
          log(`[reserved2] 加载会话状态失败 ${key}:`, error?.message ?? error);
        }
      }
      // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途的改动丢失；
      // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
      // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
      const stampAfter = statStamp();
      if (stampBefore !== null && stampAfter !== null && stampBefore !== stampAfter) {
        log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
      } else {
        dirty = true;
        try {
          writeNow();
        } catch (error) {
          log('保存 socialV2 状态失败:', error?.message ?? error);
        }
        dirty = false;
      }
      return parsed;
    },
    get dirty() { return dirty; },
    get writes() { return writes; },
    get lastText() { return lastSavedText; }
  };
}
