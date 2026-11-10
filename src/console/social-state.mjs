// 控制台「二代仿真会话状态域」路由（从 startConsoleServer 切出，行为逐字搬迁）。
//
// 契约：
//   1) handleSocialStateRoutes(ctx) → boolean：true = 本请求已被本域应答（含 400/403/500）；
//      false = 路径不归本域，主函数继续往下匹配。
//   2) 不 import bridge.js：会话状态与定时器一律由 consoleCtx 注入，便于离线单测。
//   3) 必须 async —— config/activity/turbo/level 的 POST 都要 await readBody()。
//
// 负责的路由（/api/socialV2/*）：
//   GET/POST config     仿真配置读写（归一化 + 只在影响默认唤醒配置时刷新会话）
//                       memory（记忆容量/注入条数）与 proactive 的 minGapMs/maxPerDay 也在这里夹取
//   GET      self       「她在干嘛」聚合（活动/心情/想干的事/时间线/在玩什么/暂停/档位）
//   GET      mood       心情/好感度只读快照（state/mood.json；桌宠与手机端共用这一个口径）
//   GET/POST activity   暂停/恢复（暂停会顺带关掉超活跃模式并清定时器）
//   GET/POST turbo      超活跃模式开关（时长 / 间隔 / 主题）
//   GET      mc-mode    Minecraft 模式与队列
//   GET/POST level      活跃度档位（写进每个会话的 everyMinutes 并重建定时器）
//   POST     reset      清空二代状态（本体在桥里，见 resetSocialV2AllStateV2 注释）
//   GET      state      会话级状态（agent token 鉴权 + 模式/工具开关校验）
import { readGoalsV2, readLifeV2 } from '../goals-life.js';
import { mcAlive, mcBusyMs, mcQueueSize, mcStatus } from '../mc-companion.js';

export async function handleSocialStateRoutes(ctx) {
  const {
    req, url, sendJson, readBody, log, path, ROOT, cfg,
    readConfigObject, atomicWriteJson, refreshAllDefaultWakeConfigsV2,
    socialV2, saveSocialV2State, clearAllSocialV2Timers,
    setupSleepTimerV2, scheduleProactiveCheckV2, setupIntervalTimerV2,
    turboStatusV2, setTurboV2, turboActiveV2, turboFocusV2, mcModeActiveV2,
    ACTIVE_LEVELS, readActivityV2, readFeelV2, isConversationBusyV2,
    getSocialV2State, computeWakeSafetyV2, agentTokenOk, v2SessionAllowed, v2ToolEnabled,
    resetSocialV2AllStateV2, applyFactsOpts
  } = ctx;

  if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
    sendJson({ ok: true, config: cfg.socialV2 ?? {} });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
    const body = await readBody();
    const configFile = path.join(ROOT, 'config.json');
    const file = readConfigObject(configFile);
    // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
    //
    // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
    // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
    // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
    // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
    // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
    // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
    // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
    const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
      ? file.socialV2
      : null;
    const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
    const merged = { ...current, ...body };
    // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
    for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context', 'memory']) {
      if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
        merged[sub] = current[sub] ?? {};
      }
    }
    if (merged.autoReplyCheckMs !== undefined) {
      const n = Number(merged.autoReplyCheckMs);
      merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
    }
    // tools：只接受布尔开关
    const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice'];
    if (body.tools && typeof body.tools === 'object') {
      merged.tools = { ...(current.tools ?? {}), ...body.tools };
      for (const k of toolFlags) {
        if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
      }
    }
    // wake：数值与字符串数组归一化
    if (body.wake && typeof body.wake === 'object') {
      merged.wake = { ...(current.wake ?? {}), ...body.wake };
      for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
        if (merged.wake[k] !== undefined) {
          const n = Number(merged.wake[k]);
          merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
          // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
          if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
        }
      }
      if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
      if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
      if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
      if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
      if (merged.wake.recommendedKeywords !== undefined) {
        merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
      }
      if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
      if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
    }
    // send：数值归一化
    if (body.send && typeof body.send === 'object') {
      merged.send = { ...(current.send ?? {}), ...body.send };
      for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
        if (merged.send[k] !== undefined) {
          const n = Number(merged.send[k]);
          merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
          // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
          if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
        }
      }
      if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
      if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
      if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
    }
    // wait：数值归一化
    if (body.wait && typeof body.wait === 'object') {
      merged.wait = { ...(current.wait ?? {}), ...body.wait };
      for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
        if (merged.wait[k] !== undefined) {
          const n = Number(merged.wait[k]);
          merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
        }
      }
    }
    // proactive：主动机会参数
    if (body.proactive && typeof body.proactive === 'object') {
      merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
      for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
        if (merged.proactive[k] !== undefined) {
          const n = Number(merged.proactive[k]);
          merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
          // 毫秒类字段统一非负取整；概率字段单独 clamp。
          if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
        }
      }
      if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
      if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
      // 2026-11-10：全局节流（最小间隔 1 分钟~24 小时 / 每天 1~100 次）。非法或缺失回落当前值/默认。
      // 注意 null / '' 要当「非法」处理：Number(null) === 0 会被当成 0 再夹到下限，
      // 而调用方传 null 的意图通常是「清掉这个字段、回默认」。
      const throttleNum = (raw) => (raw === null || raw === undefined || raw === '') ? Number.NaN : Number(raw);
      if (merged.proactive.minGapMs !== undefined) {
        const n = throttleNum(merged.proactive.minGapMs);
        merged.proactive.minGapMs = Number.isFinite(n)
          ? Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, Math.round(n)))
          : (Number(current.proactive?.minGapMs) || 30 * 60 * 1000);
      }
      if (merged.proactive.maxPerDay !== undefined) {
        const n = throttleNum(merged.proactive.maxPerDay);
        merged.proactive.maxPerDay = Number.isFinite(n)
          ? Math.min(100, Math.max(1, Math.round(n)))
          : (Number(current.proactive?.maxPerDay) || 12);
      }
    }
    // memory：长期记忆的容量与每轮注入条数。applyFactsOpts 一边夹取一边改到运行中的 store
    // （不用重启桥），返回的就是生效值，落盘也写它，保证「文件里看到的就是真在用的」。
    if (body.memory && typeof body.memory === 'object') {
      merged.memory = { ...(current.memory ?? {}), ...body.memory };
      if (typeof applyFactsOpts === 'function') merged.memory = applyFactsOpts(merged.memory);
    }
    // sticker：表情包体系参数归一化
    if (body.sticker && typeof body.sticker === 'object') {
      merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
      if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
      for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
        if (merged.sticker[k] !== undefined) {
          const n = Number(merged.sticker[k]);
          merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
        }
      }
      if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
      if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
      if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
      if (body.sticker.collect && typeof body.sticker.collect === 'object') {
        merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
        if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
        for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
          if (merged.sticker.collect[k] !== undefined) {
            const n = Number(merged.sticker.collect[k]);
            merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
          }
        }
      }
    }
    // feedback：数值/布尔归一化
    if (body.feedback && typeof body.feedback === 'object') {
      merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
      if (merged.feedback.maxLength !== undefined) {
        const n = Number(merged.feedback.maxLength);
        merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
      }
      if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
    }
    // context：数值归一化
    if (body.context && typeof body.context === 'object') {
      merged.context = { ...(current.context ?? {}), ...body.context };
      for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
        if (merged.context[k] !== undefined) {
          const n = Number(merged.context[k]);
          merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
        }
      }
      for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
        const n = Number(merged.context[name] ?? fallback);
        merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
      }
      if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
    }
    if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
    if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
    if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
    file.socialV2 = merged;
    atomicWriteJson(configFile, file);
    cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
    // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
    // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
    const WAKE_DEFAULT_KEYS = [
      'defaultMode', 'recommendedDefaultInfinite',
      'recommendedSleepMinMs', 'recommendedSleepMaxMs',
      'recommendedProbability', 'recommendedKeywords',
      'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
      'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
    ];
    const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
      WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
    if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
    log('控制台：二代仿真配置已更新');
    sendJson({ ok: true, config: cfg.socialV2 });
    return true;
  }
  // 「她在干嘛」详情：活动 / 心情好感 / 想干的事 / 今天的时间线 / 正在玩什么，一次取全
  if (req.method === 'GET' && url.pathname === '/api/socialV2/self') {
    const selfKey = `private:${String(cfg.ownerQQ ?? '')}`;
    const selfSt = socialV2.conversations.get(selfKey) || {};
    let goalsList = [];
    let lifeList = [];
    try { goalsList = readGoalsV2() || []; } catch { /* ignore */ }
    try { lifeList = readLifeV2() || []; } catch { /* ignore */ }
    let alive = false;
    try { alive = mcAlive(); } catch { /* ignore */ }
    const t = turboStatusV2();
    sendJson({
      ok: true,
      activity: readActivityV2(),
      feel: readFeelV2(),
      goals: goalsList.slice(-6).map((g) => String(g?.text ?? '').slice(0, 80)).filter(Boolean),
      life: lifeList.slice(-4).map((l) => String(l?.text ?? l ?? '').slice(0, 80)).filter(Boolean),
      busy: isConversationBusyV2(selfKey, selfSt),
      lastAiReplyAt: selfSt.lastAiReplyAt || 0,
      unread: Array.isArray(selfSt.unread) ? selfSt.unread.length : 0,
      playing: t.on ? { focus: t.focus, focusLabel: t.focusLabel, remainMinutes: t.remainMinutes, everyMinutes: t.everyMinutes, costCny: t.costTurboCny, level: t.level } : null,
      mc: {
        alive,
        queue: (() => { try { return mcQueueSize(); } catch { return 0; } })(),
        mode: mcModeActiveV2(),
        // 身体此刻在哪、血多少（90 秒抓一次的快照，给桌宠和她自己的提示词用）
        status: (() => { try { return mcStatus(); } catch { return null; } })(),
        // 身体被上一条没跑完的程序锁了多久（>10 分钟就该在游戏里点「停止」了）
        busyMs: (() => { try { return mcBusyMs(); } catch { return 0; } })(),
      },
      paused: !!socialV2.paused,
      level: socialV2.level ? { ...socialV2.level } : null,
    });
    return true;
  }
  // 心情/好感度只读：桌宠、手机端、控制台都走这一个口径，别各自去读 state/mood.json。
  // 只读不写 —— 心情是她自己的，控制台不代写。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/mood') {
    const feel = readFeelV2();
    sendJson({
      ok: true,
      mood: feel?.mood ?? '',
      moodLabel: feel?.moodLabel ?? '',
      affinity: Number.isFinite(Number(feel?.affinity)) ? Number(feel.affinity) : null,
      note: feel?.note ?? '',
      lastTalkAt: feel?.lastTalkAt ?? '',
      lastDiaryAt: feel?.lastDiaryAt ?? '',
    });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
    sendJson({ ok: true, paused: socialV2.paused });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
    const body = await readBody();
    const paused = body.paused === true;
    socialV2.paused = paused;
    if (paused) {
      // 暂停 = 她要停工，超活跃模式一并关掉，否则恢复时又整夜跑起来
      if (socialV2.turbo) {
        socialV2.turbo = null;
        log('[turbo] 控制台暂停，超活跃模式自动关闭');
      }
      clearAllSocialV2Timers();
      log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
    } else {
      log('控制台：二代 AI 已恢复');
      for (const key of socialV2.conversations.keys()) {
      setupSleepTimerV2(key);
      scheduleProactiveCheckV2(key);
    }
    }
    saveSocialV2State();
    sendJson({ ok: true, paused: socialV2.paused });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/turbo') {
    sendJson({ ok: true, ...turboStatusV2() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/turbo') {
    const body = await readBody();
    const on = body.on === true;
    // hours = 这一段玩多久；intervalMinutes = 多久醒一轮（桌宠的活跃度档位就靠它传下来，不写回 level）
    const status = setTurboV2(on, Number(body.hours) || 0, body.by ? String(body.by) : 'console', Number(body.intervalMinutes) || 0, body.focus ? String(body.focus) : '');
    sendJson({ ok: true, ...status });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/mc-mode') {
    sendJson({ ok: true, on: mcModeActiveV2(), mcMode: socialV2.mcMode ? { ...socialV2.mcMode } : null,
      focus: turboActiveV2() ? turboFocusV2() : '',
      queue: (typeof mcQueueSize === 'function' ? mcQueueSize() : 0) });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/level') {
    sendJson({ ok: true, level: socialV2.level ? { ...socialV2.level } : null, levels: ACTIVE_LEVELS });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/level') {
    const body = await readBody();
    const wantId = body.level ? String(body.level) : '';
    const wantMinutes = Number(body.minutes) || 0;
    const found = ACTIVE_LEVELS.find((l) => l.id === wantId);
    const minutes = found ? found.minutes : (wantMinutes >= 1 ? Math.min(720, Math.round(wantMinutes)) : 0);
    if (!(minutes > 0)) {
      // 0 / 缺省 = 关掉档位，她回到各会话自己的 everyMinutes
      socialV2.level = null;
      saveSocialV2State();
      for (const key of socialV2.conversations.keys()) setupIntervalTimerV2(key);
      sendJson({ ok: true, level: null });
      return true;
    }
    socialV2.level = { id: found ? found.id : 'custom', label: found ? found.label : '自定义', minutes };
    // 档位要真的生效：写进每个会话的 everyMinutes 并重建定时器
    for (const [key, st] of socialV2.conversations) {
      if (!st.wakeConfig) st.wakeConfig = {};
      st.wakeConfig.everyMinutes = minutes;
      setupIntervalTimerV2(key);
    }
    saveSocialV2State();
    log('[level] 活跃度 → ' + socialV2.level.label + '（每 ' + minutes + ' 分钟醒一轮）');
    const status0 = turboStatusV2();
    sendJson({ ok: true, level: socialV2.level, ...status0 });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
    // 路由体只保留应答；清空动作在桥里的 resetSocialV2AllStateV2()（会话生命周期编排）
    resetSocialV2AllStateV2();
    sendJson({ ok: true });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return true; }
    const st = getSocialV2State(key);
    sendJson({
      ok: true,
      key,
      wakeConfig: st.wakeConfig,
      wakeSafety: computeWakeSafetyV2(st.wakeConfig),
      unreadCount: st.unread.length,
      recentCount: st.recentMessages.length,
      lastWakeReason: st.lastWakeReason,
      lastAiReplyAt: st.lastAiReplyAt
    });
    return true;
  }

  return false;
}
