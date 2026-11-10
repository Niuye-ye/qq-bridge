import { errorText } from '../error-text.mjs';
// 控制台「发送域」路由（从 bridge.js 的 startConsoleServer 切出，2026-11-08，行为逐字搬迁）
//
// 职责：
//   - 批量发送：POST /api/socialV2/send-burst   （多气泡 + 间隔/断句校验 + 静默/额度/守卫）
//   - 单条发送：POST /api/socialV2/send-message （回复引用解析 + 同上各项校验）
//   - 拍一拍：  POST /api/socialV2/send-poke    （群/私聊 + 成员校验 + 额度 + 守卫）
//   - 图片：    POST /api/socialV2/send-image   （本地路径 / URL / 现拍截图 三源）
//   - 表情：    POST /api/socialV2/send-sticker （按 id 或按分类 query 挑一张，禁带文字）
//   - 预检：    POST /api/socialV2/check-send   （agent token + 会话范围 + 工具开关的只读预检）
//
// 明确不做：
//   - 不做 OneBot 发送本身（sendMessagesV2 / sendImageV2 / sendStickerV2 仍在桥里，本模块只调用）；
//   - 不做额度算法（src/rate-limit.mjs 的 checkQuota/reserveQuota/rollbackQuota 由 ctx 注入）；
//   - 不做引用目标解析（resolveReplyTargetV2 在桥里）、不做成员校验（assertGroupMember 在桥里）；
//   - 不做静默/模式判定（shouldBlockSilentReply / modeAllowed / captureSendGuard 由桥提供）；
//   - 不负责语音发送（voice 域）、不负责表情库同步（stickers 域）。
//
// 状态归属：
//   - 会话状态统一经 getSocialV2State / saveSocialV2State 读写，本模块不直接碰 socialV2.conversations；
//   - stickerEntries 是桥里会被整体重绑的 let，经 getStickerEntries() getter 读（不复制快照）；
//   - 额度预占落在 st.sendTimes 上，异常时 rollbackQuota 回滚 —— 与原代码一致。
//
// 对外接口：export async function handleSendRoutes(ctx) → boolean
//   true = 已应答（含 400/401/403/404/429/500）；false = 路径不归本域，主函数继续往下匹配。
//   **必须 async**：六条路由全部 await readBody()，图片还要 await 抓取/截图。
//
// 挂载点（bridge.js 里三段不连续代码，顺序与原文件一致）：
//   1) send-burst / send-message / send-poke 连续一段；
//   2) send-image / send-sticker 连续一段；
//   3) check-send 单独一段（在 my-recent 之前）。

export async function handleSendRoutes(ctx) {
  const {
    req, url, sendJson, readBody, log, fs, cfg, socialV2,
    currentMode, modeAllowed, shouldBlockSilentReply,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled,
    getSocialV2State, saveSocialV2State, appendActivity,
    bot, truncateText, SENSITIVE_RE, looksLikeImageBuffer, formatBytes,
    safeFetchBuffer, MAX_MEDIA_BYTES,
    checkQuota, reserveQuota, rollbackQuota,
    computeGapsV2, sendMessagesV2, recordSentMessagesV2, scheduleReplyCheckV2,
    findCjkSpaceWarning, findSplitBoundaryWarning, resolveReplyTargetV2,
    captureSendGuard, assertGroupMember,
    captureDeviceScreenshotV2, shrinkScreenshotV2, resolveImageSourcePath, sendImageV2,
    stickerEnabled, syncStickerLibrary, pickStickerByQuery, getStickerEntries, sendStickerV2
  } = ctx;

  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    let rawMessages = body.messages;
    if (typeof rawMessages === 'string') {
      const trimmed = rawMessages.trim();
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) rawMessages = parsed.map(String);
        } catch {}
      } else if (trimmed.startsWith('"')) {
        // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === 'string') rawMessages = parsed;
          else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
        } catch {}
      }
    }
    const messages = Array.isArray(rawMessages)
      ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
      : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
    const replyToMessageId = body.replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
      return true;
    }
    if (!key || !messages.length) {
      sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
      return true;
    }
    const sendCfgBurst = cfg.socialV2?.send ?? {};
    if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
      sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
      return true;
    }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return true; }
    if (currentMode !== 'reserved2') {
      sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
      return true;
    }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) {
      sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
      return true;
    }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    if (shouldBlockSilentReply(key)) {
      sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
      return true;
    }
    const sendCfg = cfg.socialV2?.send ?? {};
    const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
    const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
    if (messages.length > maxMsgs) {
      sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
      return true;
    }
    for (const msg of messages) {
      if (msg.length > maxChars) {
        sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
        return true;
      }
      if (SENSITIVE_RE.test(msg)) {
        sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
        return true;
      }
    }
    const st = getSocialV2State(key);
    const now = Date.now();
    try {
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      // 额度检查/预占/回滚统一在 src/rate-limit.mjs（原来这里手写 9 份，语义已漂）。
      const quota = checkQuota(st.sendTimes, { now, need: messages.length, maxPerMinute, maxPerHour });
      if (!quota.ok) {
        sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return true;
      }
      // 先预占发送额度，避免并发绕过限频
      st.sendTimes = reserveQuota(st.sendTimes, messages.length, now);
      const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
      const sentMessages = await sendMessagesV2(key, messages, delays);
      recordSentMessagesV2(key, sentMessages);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      saveSocialV2State();
      log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
      appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
      if (sentMessages.length > 0) scheduleReplyCheckV2(key);
      const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
      const spaceWarn = findCjkSpaceWarning(messages);
      const splitWarn = findSplitBoundaryWarning(messages);
      sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
    } catch (error) {
      if (error?.sent?.length) {
        recordSentMessagesV2(key, error.sent);
        log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
      }
      // 失败/未发出的消息回滚预占的发送额度，避免假 429。
      const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
      const failedCount = Math.max(0, messages.length - sentCount);
      rollbackQuota(st.sendTimes, failedCount);
      saveSocialV2State();
      sendJson({ ok: false, error: errorText(error) }, 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    let rawMessages = body.messages;
    if (typeof rawMessages === 'string') {
      const trimmed = rawMessages.trim();
      // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) rawMessages = parsed.map(String);
        } catch {}
      } else if (trimmed.startsWith('"')) {
        // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === 'string') rawMessages = parsed;
          else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
        } catch {}
      }
    }
    const isRawString = typeof rawMessages === 'string';
    const messages = Array.isArray(rawMessages)
      ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
      : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
    const replyToMessageId = body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
    // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
    // "字符串多段时有特殊间隔策略"。
    const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
    const gapMs = Number(body.gapMs);
    const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
    if (!key || !messages.length) {
      sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
      return true;
    }
    const sendCfgBurst = cfg.socialV2?.send ?? {};
    if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
      sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
      return true;
    }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return true; }
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    if (kind === 'private' && atUserId) {
      sendJson({ ok: false, error: '私聊不需要 @' }, 400);
      return true;
    }
    if (shouldBlockSilentReply(key)) {
      sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
      return true;
    }
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
      sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
      return true;
    }
    const sendCfg = cfg.socialV2?.send ?? {};
    const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
    const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
    if (messages.length > maxMsgs) {
      sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
      return true;
    }
    for (const msg of messages) {
      if (msg.length > maxChars) {
        sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
        return true;
      }
      if (SENSITIVE_RE.test(msg)) {
        sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
        return true;
      }
    }
    const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
    // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
    const st = getSocialV2State(key);
    const now = Date.now();
    const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
    const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
    // 额度检查/预占/回滚统一在 src/rate-limit.mjs（原来这里手写 9 份，语义已漂）。
    const quota = checkQuota(st.sendTimes, { now, need: messages.length, maxPerMinute, maxPerHour });
    if (!quota.ok) {
      sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
      return true;
    }
    // 先预占发送额度，避免并发绕过限频
    st.sendTimes = reserveQuota(st.sendTimes, messages.length, now);
    let quotedInfo = null;
    let actualReplyToMessageId = replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
      if (!resolved) {
        // 引用解析失败：回滚已预占的发送额度（删尾巴，不再逐条 indexOf）
        rollbackQuota(st.sendTimes, messages.length);
        saveSocialV2State();
        sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
        return true;
      }
      quotedInfo = resolved.info;
      actualReplyToMessageId = resolved.messageId;
    }
    try {
      const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
      recordSentMessagesV2(key, sentMessages);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      saveSocialV2State();
      log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
      appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
      if (sentMessages.length > 0) scheduleReplyCheckV2(key);
      const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
      const spaceWarn = findCjkSpaceWarning(messages);
      const splitWarn = findSplitBoundaryWarning(messages);
      sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
    } catch (error) {
      if (error?.sent?.length) {
        recordSentMessagesV2(key, error.sent);
        log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
      }
      // 失败/未发出的消息回滚预占的发送额度，避免假 429。
      const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
      const failedCount = Math.max(0, messages.length - sentCount);
      rollbackQuota(st.sendTimes, failedCount);
      saveSocialV2State();
      sendJson({ ok: false, error: errorText(error) }, 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return true; }
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return true; }
    if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return true; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
      return true;
    }
    if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return true; }
    if (kind === 'group' && !targetUserId) {
      sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
      return true;
    }
    if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
      sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
      return true;
    }
    // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
    if (kind === 'group') {
      const memberError = await assertGroupMember(id, targetUserId);
      if (memberError) { sendJson({ ok: false, error: memberError }, 403); return true; }
    }
    const st = getSocialV2State(key);
    const sendCfg = cfg.socialV2?.send ?? {};
    const now = Date.now();
    const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
    const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
    // 额度检查/预占/回滚统一在 src/rate-limit.mjs（原来这里手写 9 份，语义已漂）。
    const quota = checkQuota(st.sendTimes, { now, need: 1, maxPerMinute, maxPerHour });
    if (!quota.ok) {
      sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
      return true;
    }
    st.sendTimes = reserveQuota(st.sendTimes, 1, now);
    // 成员校验是异步的（要问 OneBot）；期间操作者可能切模式/改白名单/开静默。
    // 拍一拍此前完全没有发送守卫，这里补上：真正发之前再确认一次。
    const sendGuard = captureSendGuard(key);
    try {
      sendGuard();
      if (shouldBlockSilentReply(key)) {
        const blocked = new Error('静默模式已开启，当前不允许拍一拍');
        blocked.statusCode = 403;
        throw blocked;
      }
      if (kind === 'group') {
        await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
      } else {
        // 私聊拍一拍：send_poke 自动路由到当前私聊对象
        await bot.raw('send_poke', { user_id: id });
      }
      st.lastActionAt = now;
      st.lastAiReplyAt = now;
      st.wakeConfig.noActionCount = 0;
      const pokeText = kind === 'group'
        ? `[拍一拍] 我拍了拍 ${targetUserId}`
        : '[拍一拍] 我拍了拍你';
      st.recentMessages.push({
        messageId: null,
        sender: '我',
        text: pokeText,
        plain: pokeText,
        tail: pokeText,
        kind: 'poke',
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        media: [],
        hasMedia: false,
        forwardIds: [],
        hasForward: false,
        poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
        time: Date.now()
      });
      const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
      if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
      st.preSleepWaitSatisfiedAt = 0;
      st.preSleepWaitObservedAt = 0;
      st.preSleepWaitAccumMs = 0;
      saveSocialV2State();
      log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
      appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
      sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
    } catch (error) {
      rollbackQuota(st.sendTimes, 1);
      log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
      sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-image') {
    const imgCfg = cfg.socialV2?.image ?? {};
    if (imgCfg.enabled === false) { sendJson({ ok: false, error: '发图片能力已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const replyToMessageId = body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    const rawPath = String(body.path ?? '').trim();
    const rawUrl = String(body.url ?? '').trim();
    const wantShot = body.screenshot === true || String(body.screenshot ?? '').toLowerCase() === 'true';
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (!rawPath && !rawUrl && !wantShot) {
      sendJson({ ok: false, error: 'path（D:/qq-bridge 下的图片）/ url（网络图片）/ screenshot:true（现拍模拟器）至少要给一个' }, 400);
      return true;
    }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return true; }
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
    if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
      sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
      return true;
    }
    let quotedInfo = null;
    let actualReplyToMessageId = replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const stForReply = getSocialV2State(key);
      const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
      if (!resolved) {
        sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
        return true;
      }
      quotedInfo = resolved.info;
      actualReplyToMessageId = resolved.messageId;
    }
    let buffer = null;
    let sourceLabel = '';
    try {
      if (rawPath) {
        const res = resolveImageSourcePath(rawPath);
        buffer = fs.readFileSync(res.abs);
        sourceLabel = res.label;
      } else if (rawUrl) {
        const fetched = await safeFetchBuffer(rawUrl, MAX_MEDIA_BYTES);
        if (!looksLikeImageBuffer(fetched.buffer)) throw new Error('这个 URL 返回的不是图片');
        buffer = fetched.buffer;
        sourceLabel = String(rawUrl).slice(0, 120);
      } else if (wantShot) {
        const shot = await captureDeviceScreenshotV2();
        // 手机上原图 1220x2712 / 1.2~3MB，发 QQ 前缩到 1080 宽 JPEG（约 200~400KB）：
        // 字仍看得清，少传几 MB 流量；缩图失败会原样返回 PNG。
        const shown = await shrinkScreenshotV2(shot, { width: 1080, qscale: 4, force: true });
        buffer = shown.buffer || shot;
        sourceLabel = (process.platform === 'android' ? '手机截图' : '模拟器截图')
          + (buffer.length < shot.length ? `（已压缩 ${formatBytes(shot.length)} → ${formatBytes(buffer.length)}）` : '');
      }
    } catch (error) {
      sendJson({ ok: false, error: `图片读取失败：${error?.message ?? error}` }, 400);
      return true;
    }
    if (!buffer || !buffer.length) { sendJson({ ok: false, error: '图片是空的' }, 400); return true; }
    const sendCfg = cfg.socialV2?.send ?? {};
    const now = Date.now();
    try {
      const st = getSocialV2State(key);
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      // 额度检查/预占/回滚统一在 src/rate-limit.mjs（原来这里手写 9 份，语义已漂）。
      const quota = checkQuota(st.sendTimes, { now, need: 1, maxPerMinute, maxPerHour });
      if (!quota.ok) {
        sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return true;
      }
      st.sendTimes = reserveQuota(st.sendTimes, 1, now);
      const sent = await sendImageV2(key, buffer, {
        replyToMessageId: actualReplyToMessageId,
        atUserId
      });
      st.recentMessages.push({
        messageId: sent.messageId ? String(sent.messageId) : null,
        sender: '我',
        text: '[图片]',
        plain: '[图片]',
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        media: [{ type: 'image', desc: sourceLabel }],
        hasMedia: true,
        forwardIds: [],
        hasForward: false,
        time: Date.now()
      });
      const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
      if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      st.preSleepWaitSatisfiedAt = 0;
      st.preSleepWaitObservedAt = 0;
      st.preSleepWaitAccumMs = 0;
      saveSocialV2State();
      scheduleReplyCheckV2(key);
      log(`[image] 工具发送图片 ${key}: ${sourceLabel} (${formatBytes(buffer.length)}, messageId=${sent.messageId ?? '?'})`);
      appendActivity(`${key} [image] 工具发送图片：${sourceLabel}`);
      sendJson({ ok: true, key, source: sourceLabel, bytes: buffer.length, sent: 1, failed: 0, quoted: quotedInfo });
    } catch (error) {
      const st = getSocialV2State(key);
      rollbackQuota(st.sendTimes, 1);
      saveSocialV2State();
      log(`[image] 工具发送图片失败 ${key}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `发送图片失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    let stickerId = String(body.stickerId ?? '').trim();
    const stickerQuery = String(body.query ?? body.category ?? '').trim();
    const caption = String(body.message ?? body.caption ?? '').trim();
    const replyToMessageId = body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    if (!key || (!stickerId && !stickerQuery)) { sendJson({ ok: false, error: 'key 不能为空，且 stickerId / query 至少要给一个' }, 400); return true; }
    // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
    if (caption) {
      sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
      return true;
    }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return true; }
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
    if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
      sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
      return true;
    }
    let quotedInfo = null;
    let actualReplyToMessageId = replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const stForReply = getSocialV2State(key);
      const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
      if (!resolved) {
        sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
        return true;
      }
      quotedInfo = resolved.info;
      actualReplyToMessageId = resolved.messageId;
    }
    // 只给分类（例如"笑死""阴阳怪气"）时，按 desc/localNote/tags/usage 挑一张。
    if (!stickerId && stickerQuery) {
      const pickSynced = await syncStickerLibrary(false);
      const picked = pickStickerByQuery(pickSynced?.entries ?? getStickerEntries(), stickerQuery);
      if (!picked) {
        sendJson({ ok: false, error: `没有找到和「${stickerQuery}」对得上的表情；可用 qq_list_stickers 看看现有表情的备注和标签` }, 404);
        return true;
      }
      stickerId = String(picked.id || picked.md5 || '').trim();
      log(`[sticker] 按分类「${stickerQuery}」挑中表情 ${stickerId}（${picked.desc || picked.localNote || ''}）`);
    }
    const sendCfg = cfg.socialV2?.send ?? {};
    const now = Date.now();
    try {
      const st = getSocialV2State(key);
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      // 额度检查/预占/回滚统一在 src/rate-limit.mjs（原来这里手写 9 份，语义已漂）。
      const quota = checkQuota(st.sendTimes, { now, need: 1, maxPerMinute, maxPerHour });
      if (!quota.ok) {
        sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return true;
      }
      st.sendTimes = reserveQuota(st.sendTimes, 1, now);
      const sent = await sendStickerV2(key, stickerId, {
        replyToMessageId: actualReplyToMessageId,
        atUserId
      });
      // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
      const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
      const text = `[表情包:${label}]`;
      st.recentMessages.push({
        messageId: sent.messageId ? String(sent.messageId) : null,
        sender: '我',
        text: truncateText(text, 200),
        plain: truncateText(text, 200),
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        media: [],
        hasMedia: false,
        forwardIds: [],
        hasForward: false,
        sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
        time: Date.now()
      });
      const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
      if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      st.preSleepWaitSatisfiedAt = 0;
      st.preSleepWaitObservedAt = 0;
      st.preSleepWaitAccumMs = 0;
      saveSocialV2State();
      scheduleReplyCheckV2(key);
      log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
      appendActivity(`${key} [sticker] 工具发送表情：${label}`);
      sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
    } catch (error) {
      const st = getSocialV2State(key);
      rollbackQuota(st.sendTimes, 1);
      saveSocialV2State();
      log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const tool = String(body.tool ?? '').trim();
    const token = String(body.token ?? '').trim();
    if (!key || !tool || !token) {
      sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
      return true;
    }
    if (!agentTokenOk(key, token)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return true;
    }
    if (!v2SessionAllowed(key)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
    const flag = flagMap[tool];
    if (!flag) {
      sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
      return true;
    }
    if (!v2ToolEnabled(flag)) {
      sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
      return true;
    }
    sendJson({ ok: true, key, tool });
    return true;
  }

  return false;
}
