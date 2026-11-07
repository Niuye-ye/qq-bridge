// 控制台「语音域」路由（从 startConsoleServer 切出，行为逐字搬迁）。
//
// 契约：
//   1) handleVoiceRoutes(ctx) → boolean：true = 本请求已被本域应答（含 400/403/404/500）；
//      false = 路径不归本域，主函数继续往下匹配。
//   2) 不 import bridge.js：状态与函数全部由 consoleCtx 注入，便于离线单测。
//   3) 三条路径是三段独立代码（操作者通道 / AI 通道 / 语音库列表），主函数里各调一次
//      本 handler；不合并成单点分发是为了让路由顺序和原来完全一致。
//
// 负责的路由：
//   POST /api/voice/send | /api/send/voice       操作者通道（consoleToken 鉴权，白名单 + 限流 + 审计）
//   POST /api/socialV2/send-voice                AI 通道（仅 reserved2 + agent token，只能发自己会话）
//   GET  /api/socialV2/voices | /api/voice/list  语音库列表（两条通道共用，返回里不含绝对路径）
export async function handleVoiceRoutes(ctx) {
  const {
    req, url, sendJson, readBody, log, cfg, path, currentMode,
    voiceCfg, modeAllowed, parseTargetKey, resolveVoicePathForOperator, resolveVoicePathForV2,
    resolveAudioProcessing, inspectAudio, describeAudio, sendVoiceV2, sendVoiceForV2,
    verifyVoiceMessageSent, voiceBudgetCheck, voiceBudgetCommit, listAudioFiles,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled, shouldBlockSilentReply, appendActivity
  } = ctx;

  // ── 语音发送（操作者通道：CLI / 控制台，凭 consoleToken） ──────────────
  //
  // 与 /api/send/* 的 agent 通道分开：操作者可能不在任何 QQ 会话里，
  // 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少。
  if (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) {
    const body = await readBody();
    const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
    const voice = voiceCfg();
    // 注意：这里是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
    // socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
    // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
    // AI 通道的开关在 /api/socialV2/send-voice 里单独判定。
    // /api/send/voice 是 AI 工具入口：带 agent token 时一律按 agent 规则走，
    // 避免 AI 借用操作者通道绕过「只能发自己会话」的限制。
    if (url.pathname === '/api/send/voice' && agentToken) {
      sendJson({
        ok: false,
        error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）'
      }, 403);
      return true;
    }
    const key = String(body.target ?? body.key ?? '').trim();
    const parsedTarget = parseTargetKey(key);
    if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
      const a = cfg.allow ?? {};
      sendJson({
        ok: false,
        error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
      }, 403);
      return true;
    }
    let resolved;
    try {
      resolved = resolveVoicePathForOperator(body.file ?? body.path ?? '');
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
      return true;
    }
    // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
    try {
      resolveAudioProcessing({
        volume: body.volume ?? voice.defaultVolume,
        normalize: body.normalize === true,
        loudness: body.loudness ?? voice.loudness
      });
    } catch (error) {
      sendJson({ ok: false, error: error.message }, 400);
      return true;
    }
    const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds, ffmpegPath: voice.ffmpegPath });
    if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return true; }
    const preview = {
      key,
      file: resolved.path,
      via: resolved.via,
      bytes: probe.size,
      duration: probe.duration,
      codec: probe.codec,
      detail: describeAudio(probe),
      warnings: probe.warnings ?? [],
      limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
    };
    if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return true; }
    const now = Date.now();
    try {
      voiceBudgetCheck('operator:cli', voice);
      const sent = await sendVoiceV2(key, resolved.path, {
        guard: false,
        audit: true,
        audio: {
          volume: body.volume ?? voice.defaultVolume,
          normalize: body.normalize === true,
          loudness: body.loudness ?? voice.loudness
        }
      });
      voiceBudgetCommit('operator:cli', now);
      log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
      appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
      // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
      const verification = body.verify === false ? null : await verifyVoiceMessageSent(sent.messageId);
      let readbackText = null;
      if (body.readback === true && sent.messageId) {
        try {
          const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
          const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
            },
            body: JSON.stringify({ message_id: String(sent.messageId) }),
            signal: AbortSignal.timeout(30000)
          });
          const rb = await res.json().catch(() => ({}));
          if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
        } catch (error) {
          log(`[voice] 转写回读失败：${error?.message ?? error}`);
        }
      }
      sendJson({
        ok: true,
        ...preview,
        messageId: sent.messageId,
        verified: verification?.confirmed === true,
        readback: readbackText,
        audioProcessing: sent.audioProcessing,
        volume: sent.volume,
        loudness: sent.loudness
      });
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return true;
  }

  // ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ────
  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
    const body = await readBody();
    const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
    const key = String(body.key ?? body.target ?? '').trim();
    const voice = voiceCfg();
    if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return true; }
    if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return true; }
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return true; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
    let resolved;
    try {
      resolved = resolveVoicePathForV2(body.voice ?? body.file ?? '');
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
      return true;
    }
    try {
      voiceBudgetCheck(key, voice);
      if (body.dryRun === true) {
        const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds, ffmpegPath: voice.ffmpegPath });
        if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return true; }
        sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
        return true;
      }
      const sent = await sendVoiceForV2(key, body.voice ?? body.file, {
        label: body.label ? String(body.label).slice(0, 100) : '',
        verify: body.verify,
        readback: body.readback === true,
        // AI 也可以调音量（默认走 config 的 defaultVolume）
        audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
          ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
          : null
      });
      sendJson({
        ok: true,
        key,
        messageId: sent.messageId,
        file: path.basename(sent.file),
        detail: sent.detail,
        audioProcessing: sent.audioProcessing,
        // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
        verified: sent.verification?.confirmed === true,
        readback: sent.readback,
        warnings: sent.warnings
      });
    } catch (error) {
      // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return true;
  }

  // 语音库列表。两条通道共用：
  //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
  //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
  // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
  if (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const voice = voiceCfg();
    const agentCall = Boolean(req.headers['x-agent-token']);
    // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
    if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return true; }
    if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return true; }
    const wantProbe = url.searchParams.get('probe') !== '0';
    try {
      const files = listAudioFiles(voice.dir);
      const items = [];
      for (const f of files.slice(0, 100)) {
        const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
        if (wantProbe) {
          const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds, ffmpegPath: voice.ffmpegPath });
          entry.ok = info.ok;
          entry.bytes = info.size;
          entry.detail = info.ok ? describeAudio(info) : null;
          entry.seconds = info.duration ?? null;
          if (!info.ok) entry.error = info.error;
        }
        items.push(entry);
      }
      sendJson({
        ok: true,
        key: key || null,
        dir: agentCall ? undefined : voice.dir,
        count: items.length,
        voices: items,
        limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
        // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
        // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
        hint: items.length
          ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
          : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
      });
    } catch (error) {
      sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  return false;
}
