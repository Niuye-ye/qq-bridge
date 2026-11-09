/**
 * 控制台 —— 管理端与杂项域（admin）
 *
 * 职责
 *   兜底域：startConsoleServer 里剩下那些「管理端 / 提示词 / 社交杂项」端点，按原顺序整段搬出：
 *     /api/status、/api/presets、/api/preset/sim-prompt（读/写/备份/还原）、/api/sessions、/api/pending、
 *     /api/whitelist（读/写）、/api/security（读/写）、/api/test-send、/api/social（读/写）、/api/console/notify-ai、
 *     /api/socialV2/prompt、/api/socialV2/initial-prompt、/api/socialV2/self-image、/api/socialV2/groups、
 *     /api/socialV2/screen、/api/socialV2/send-qzone、/api/socialV2/qzone-list、/api/socialV2/wait、
 *     /api/socialV2/feedback（读/清/写）、/api/authorize/read、/api/send/group|private|burst|message|poke|image|sticker、
 *   —— 共 29 条路由（原 bridge.js 4100–5391 之间的连续块，被已切域挂载行隔成若干段）。
 *
 * 明确不做
 *   - **不碰会改闭包内标量的 5 条管理端路由**，它们仍留在 bridge.js 里（改标量没法经 ctx 传）：
 *     /api/mode（改 currentMode / lastMode / closedAgentPreset）、/api/console/token（改 consoleToken）、
 *     /api/session/reset、/api/workspace/reset、/api/restart；
 *   - 不实现预设文件读写、白名单校验、长轮询等待这些具体逻辑，只调注入的助手函数；
 *   - 不注册定时器、不缓存状态（回调全部经 ctx）。
 *
 * 状态归属
 *   - 预设 / 白名单 / 安全策略 / qzone / feedback 的持久化都在各自模块或注入的函数里；
 *   - `stickerEntries` / `slangEntries` 是桥里会被整体重绑的 `let`，所以经 `getStickerEntries()` /
 *     `getSlangEntries()` 取值（不按值注入，否则同步后会用到旧快照）；
 *   - 等待类路由（/api/socialV2/wait）用的 `activeWaits` 是桥持有的 Map，按引用注入。
 *
 * 接口契约
 *   export async function handleAdminRoutes(ctx) → boolean   // true = 已处理并已回包
 *   - **必须 async**：几乎所有路由都 await readBody，等待路由还要 await 长轮询。
 *   - 返回 false 表示「不是本域路由」；不得回包后再返回 false。
 *   - 主函数在 consoleCtx 构造完成后挂一次即可（各路由 pathname 互不重叠，顺序无关）。
 */
import fs from 'node:fs';
import { text } from '@snowluma/sdk';
import path from 'node:path';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from '../preset-prompt.js';
import { unwrap } from '../dsh-client.js';
import { looksLikeUnfinished } from '../v2-wait.js';
import { manualDirCommand } from '../state-acl.mjs';
import { buildSlangContext } from '../slang-learner.js';
import { buildStickerContext, buildStickerStrategyHint } from '../sticker-lib.js';
import { SENSITIVE_RE } from '../sensitive.js';
import { truncateText } from '../md-to-plain.js';
import { checkQuota, reserveQuota, rollbackQuota } from '../rate-limit.mjs';

export async function handleAdminRoutes(ctx) {
  const {
    req, res, ACTIVE_WAIT_LEASE_MS, FEEDBACK_FILE, PRESET_BACKUP_DIR, PRESET_NAMES,
    ROOT, STATE_DIR, activeWaits, agentTokenOk, allowed, api,
    appendActivity, appendFeedbackEntry, atomicWriteJson, atomicWriteText, backupPresetFile, bot,
    cancelReplyCheckV2, canonicalV2Key, captureDeviceScreenshotV2, shrinkScreenshotV2, cfg, closedAgentPreset, computeWakeSafetyV2,
    confirmedSlangListV2, currentMode, currentRoleHint, currentRoleHintV2, deliverPrompt, dshReady,
    ensureSession, escapeCqText, feedbackTimes, formatMemoryV2, formatParticipationV2, getSocialV2State,
    hardenStateDirAcl, setStateDirHardened, getStateDirHardened, initialPromptMaxChars, initialPrompts, initialPromptsWritable, installedPresetYaml, knownPresetName,
    listPresetBackups, listQzonePostsV2, loadQzoneState, log, mimeFromBuffer, modeAllowed,
    normalizeOwnerQQ, noteModelMessagesV2, preSleepWaitBlockedV2, presetSourceYaml, presetStatus, qzoneCfg,
    qzoneUsedToday, readActivityTail, readBody, readConfigObject, readFeedbackEntries, readPresetPromptText,
    readRoleState, readThroughSeqV2, reconcileSessionPolicies, recordSentMessagesV2, redactKnownTokensOnly, replyTimingV2,
    resolveReplyTargetV2, saveQzoneState, saveSocialV2State, scheduleReplyCheckV2, selfDisplayName, selfIdentityTextV2,
    selfUserId, sendJson, sendMessagesV2, sendQzonePostV2, setInitialPrompt, shouldBlockSilentReply,
    sleep, snowlumaHealthSnapshot, social, socialV2, stateDirHardened, stickerEnabled,
    suggestQuietMsV2, syncStickerLibrary, unquoteJsonString, url, v2SessionAllowed, v2ToolEnabled,
    voiceCfg, voiceLibrary,
    getStickerEntries, getSlangEntries, getCurrentMode, getState, pending
  } = ctx;

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const rs = readRoleState();
    // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
    // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
    // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
    // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
    // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
    // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
    // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
    if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
      sendJson({
        mode: currentMode,
        role: rs.role ?? null,
        roleMode: rs.mode ?? 'active',
        dshReady,
        socialV2Paused: socialV2.paused,
      });
      return true;
    }
    sendJson({
      mode: currentMode,
      closedAgentPreset,
      role: rs.role ?? null,
      roleMode: rs.mode ?? 'active',
      dshReady,
      ownerQQ: cfg.ownerQQ ?? null,
      allowGroups: cfg.allow?.groups ?? [],
      allowPrivate: cfg.allow?.private ?? [],
      socialV2Paused: socialV2.paused,
      // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
      // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
      snowluma: snowlumaHealthSnapshot(),
      activity: readActivityTail(100)
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/presets') {
    let presets = [];
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
      presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
    } catch {}
    sendJson({ presets });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') {
    const preset = knownPresetName(url.searchParams.get('preset'));
    if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return true; }
    try {
      const { prefix } = readPresetPromptText(preset);
      sendJson({
        ok: true,
        content: prefix,
        chars: prefix.length,
        bytes: Buffer.byteLength(prefix, 'utf8'),
        warnings: presetPromptWarnings(prefix),
        status: presetStatus(preset),
        presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
      });
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') {
    const body = await readBody();
    const preset = knownPresetName(body.preset);
    if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return true; }
    let nextText;
    try {
      const { text, prefix } = readPresetPromptText(preset);
      // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
      // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
      const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
      if (normalized === prefix) {
        sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
        return true;
      }
      nextText = renderPresetPromptYaml(text, body.content, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
      return true;
    }
    const warnings = presetPromptWarnings(body.content);
    let sourceBackup = null;
    try {
      sourceBackup = backupPresetFile(preset);
      atomicWriteText(presetSourceYaml(preset), nextText);
      // 同步到 DSH 实际读取的安装目录。
      // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
      // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
      const installed = installedPresetYaml(preset);
      if (fs.existsSync(installed)) {
        fs.copyFileSync(presetSourceYaml(preset), installed);
      }
    } catch (error) {
      // 尽力回滚源文件，避免留下半截状态
      if (sourceBackup && fs.existsSync(sourceBackup)) {
        try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
      }
      sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
      return true;
    }
    log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
    sendJson({
      ok: true,
      chars: String(body.content ?? '').length,
      warnings,
      synced: fs.existsSync(installedPresetYaml(preset)),
      requiresRestart: true,
      status: presetStatus(preset),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') {
    const preset = knownPresetName(url.searchParams.get('preset'));
    if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return true; }
    try {
      sendJson({ ok: true, backups: listPresetBackups(preset) });
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore') {
    const body = await readBody();
    const preset = knownPresetName(body.preset);
    if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return true; }
    try {
      const requested = String(body.file ?? '').trim();
      const candidates = listPresetBackups(preset).map((b) => b.file);
      const target = requested || candidates[0];
      // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
      if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return true; }
      const backupPath = path.join(PRESET_BACKUP_DIR, target);
      const restored = fs.readFileSync(backupPath, 'utf8');
      const restoredPrefix = extractPresetPrefix(restored);
      if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return true; }
      // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
      // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
      // 不变量清单**按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
      const blockers = presetPromptBlockers(restoredPrefix, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
      if (blockers.length) {
        sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
        return true;
      }
      backupPresetFile(preset);
      atomicWriteText(presetSourceYaml(preset), restored);
      const installed = installedPresetYaml(preset);
      if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
      log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
      sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const list = [];
    for (const [key, sessionId] of Object.entries(getState().sessions)) {
      list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
    }
    sendJson({ sessions: list });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/pending') {
    const list = [];
    for (const [key, p] of pending.entries()) {
      list.push({
        key,
        kind: p.kind,
        sessionId: p.sessionId,
        ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
        ...(p.kind === 'question' ? { questions: p.questions } : {})
      });
    }
    sendJson({ pending: list });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/whitelist') {
    sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/whitelist') {
    const body = await readBody();
    const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
    const configFile = path.join(ROOT, 'config.json');
    // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
    const file = readConfigObject(configFile);
    const allow = {
      private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
      groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
    };
    const deny = {
      private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
      groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
    };
    // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
    let ownerQQ = cfg.ownerQQ ?? null;
    if (body.ownerQQ !== undefined) {
      try {
        ownerQQ = normalizeOwnerQQ(body.ownerQQ);
      } catch (error) {
        sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
        return true;
      }
    }
    file.allow = allow;
    file.deny = deny;
    file.ownerQQ = ownerQQ;
    atomicWriteJson(configFile, file);
    cfg.allow = { private: allow.private, groups: allow.groups };
    cfg.deny = { private: deny.private, groups: deny.groups };
    cfg.ownerQQ = ownerQQ;
    reconcileSessionPolicies();
    log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
    sendJson({ ok: true, allow, deny, ownerQQ });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/security') {
    sendJson({
      security: cfg.security ?? { interceptNotify: true },
      // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
      // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
      // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
      // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
      stateDir: {
        hardened: stateDirHardened,
        path: STATE_DIR,
        manualCommand: process.platform === 'win32'
          ? manualDirCommand(STATE_DIR)
          : `chmod 700 "${STATE_DIR}"`
      }
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/security') {
    const body = await readBody();
    // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
    if (body.rehardenStateDir === true) {
      // stateDirHardened 是桥的模块级 let（会被 ACL 收紧结果重绑），这里只能经 setter 改
      setStateDirHardened(null);
      hardenStateDirAcl();
      const hardenedNow = getStateDirHardened();
      sendJson({ ok: hardenedNow === true, hardened: hardenedNow, path: STATE_DIR });
      return true;
    }
    const configFile = path.join(ROOT, 'config.json');
    const file = readConfigObject(configFile);
    const next = { ...(file.security ?? {}), ...body };
    if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
    else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
    file.security = next;
    atomicWriteJson(configFile, file);
    cfg.security = { ...(cfg.security ?? {}), ...next };
    log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
    sendJson({ ok: true, security: cfg.security });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/test-send') {
    const body = await readBody();
    const kind = body.kind === 'private' ? 'private' : 'group';
    const id = Number(body.id);
    const message = String(body.message ?? '').trim();
    if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return true; }
    if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return true; }
    if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
    if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return true; }
    if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return true; }
    try {
      const safeMessage = escapeCqText(redactKnownTokensOnly(message));
      const result = kind === 'private'
        ? await bot.sendPrivateMessage(id, text(safeMessage))
        : await bot.sendGroupMessage(id, text(safeMessage));
      log(`控制台：测试发送 ${kind}:${id} 成功`);
      sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
    } catch (error) {
      sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/social') {
    const stats = {};
    for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
    const states = {};
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const k of keys) {
      const st = social.states.get(k);
      states[k] = { phase: st?.phase ?? 'idle' };
    }
    sendJson({ config: cfg.social, pendingSummaries: stats, states });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/social') {
    const body = await readBody();
    const configFile = path.join(ROOT, 'config.json');
    // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
    const file = readConfigObject(configFile);
    const merged = { ...(file.social ?? {}), ...body };
    // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
    for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
      delete merged[k];
    }
    for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
      if (merged[k] !== undefined) {
        const n = Number(merged[k]);
        if (Number.isFinite(n) && n >= 0) merged[k] = n;
      }
    }
    // 分条间隔 clamp 到非负
    for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
      if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
    }
    // 概率字段 clamp 到 0~1
    for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
      if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
    }
    // contextWindow 限制 1~100
    if (merged.contextWindow !== undefined) {
      merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
    }
    // 布尔字段
    for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
      if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
    }
    // 范围字段保证 min <= max
    for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
      if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
        [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
      }
    }
    if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
    file.social = merged;
    atomicWriteJson(configFile, file);
    cfg.social = { ...cfg.social, ...merged };
    log('控制台：社交配置已更新');
    sendJson({ ok: true, config: cfg.social });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const message = String(body.message ?? '').trim();
    if (!key || !message) {
      sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
      return true;
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) {
      sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
      return true;
    }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0) {
      sendJson({ ok: false, error: 'id 无效' }, 400);
      return true;
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
      return true;
    }
    if (!getState().sessions[key] && !allowed(kind, id, cfg)) {
      sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
      return true;
    }
    if (!dshReady) {
      sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
      return true;
    }
    const isV2 = currentMode === 'reserved2';
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
    let tokenLine = '';
    if (isV2) {
      const stV2 = getSocialV2State(key);
      tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
    }
    const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
    let sessionId = null;
    let popSilent = null;
    try {
      sessionId = await ensureSession(key);
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const arr = social.silentTurns.get(sessionId) ?? [];
      social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
      popSilent = () => {
        const list = social.silentTurns.get(sessionId) ?? [];
        const next = list.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      const result = await deliverPrompt(key, promptText, { silent: true });
      if (result.ok) {
        log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
        appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
        sendJson({ ok: true, key, sessionId });
      } else {
        popSilent();
        sendJson({ ok: false, error: result.error || '投递失败' }, 500);
      }
    } catch (error) {
      if (popSilent) popSilent();
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return true; }
    const st = getSocialV2State(key);
    // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
    if (cfg.socialV2?.sticker?.enabled !== false) {
      try { await syncStickerLibrary(false); } catch {}
    }
    const roleState = readRoleState();
    const toolMap = {
      getPrompt: 'qq_get_prompt',
      getUnread: 'qq_get_unread_messages',
      getRecent: 'qq_get_recent_messages',
      socialState: 'qq_social_state',
      sendGroup: 'qq_send_group_message',
      sendPrivate: 'qq_send_private_message',
      reply: 'qq_reply',
      sendBurst: 'qq_send_burst',
      sendMessage: 'qq_send_message',
      waitMessages: 'qq_wait_for_messages',
      feedback: 'qq_report_feedback',
      getMyRecent: 'qq_get_my_recent_messages',
      getMessageDetail: 'qq_get_message_detail',
      getActiveMembers: 'qq_get_active_members',
      setWakeConfig: 'qq_set_wake_config',
      markRead: 'qq_mark_read',
      memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
      slangQuery: 'qq_slang_query',
      slangSubmit: 'qq_slang_submit',
      getImages: 'qq_get_message_images',
      getForwardMsg: 'qq_get_forward_msg',
      sendPoke: 'qq_send_poke',
      listStickers: 'qq_list_stickers',
      getStickerImage: 'qq_get_sticker_image',
      sendSticker: 'qq_send_sticker',
      sendImage: 'qq_send_image',
      setStickerRemark: 'qq_set_sticker_remark',
      stickerNote: 'qq_sticker_note',
      collectSticker: 'qq_collect_sticker',
      sendQzone: 'qq_send_mood',
      listQzone: 'qq_list_moods',
      getSelfImage: 'qq_get_self_image',
      setActivity: 'qq_set_activity',
    seeScreen: 'qq_see_screen',
      getActivity: 'qq_get_activity',
      remember: 'qq_remember',
      recall: 'qq_recall',
      forget: 'qq_forget',
      sendVoice: 'qq_send_voice / qq_list_voices'
    };
    const tools = cfg.socialV2?.tools ?? {};
    const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
    const enabledTools = [];
    for (const [flag, name] of Object.entries(toolMap)) {
      if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
    }
    sendJson({
      ok: true,
      key,
      time: new Date().toISOString(),
      // 机器人自己的身份：agent 需要它才能把「@樰」对到自己身上（issue #29）。
      self: {
        nickname: selfDisplayName || null,
        userId: selfUserId || null,
        line: selfIdentityTextV2().trim() || null
      },
      role: { name: roleState.role ?? null, hint: currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
      recommended: cfg.socialV2?.provideRecommendations === false ? null : {
        wake: cfg.socialV2?.wake ?? {},
        send: cfg.socialV2?.send ?? {},
        wait: cfg.socialV2?.wait ?? {},
        proactive: cfg.socialV2?.proactive ?? {}
      },
      enabledTools,
      replyTiming: replyTimingV2(st),
      unreadCount: st.unread.length,
      recentCount: st.recentMessages.length,
      currentWakeConfig: st.wakeConfig,
      wakeSafety: computeWakeSafetyV2(st.wakeConfig),
      memory: formatMemoryV2(st),
      participation: formatParticipationV2(st),
      slang: {
        enabled: cfg.slang?.enabled !== false,
        entries: confirmedSlangListV2(),
        block: buildSlangContext(getSlangEntries(), cfg.slang?.injectMax ?? 8)
      },
      stickers: {
        enabled: cfg.socialV2?.sticker?.enabled !== false,
        total: getStickerEntries().length,
        context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(getStickerEntries(), cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
        strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
      },
      // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
      voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
        enabled: true,
        total: voiceLibrary().length,
        names: voiceLibrary().slice(0, 12).map((v) => v.name),
        maxSeconds: voiceCfg().maxSeconds,
        hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
      }
    });
    return true;
  }

  if (url.pathname === '/api/socialV2/initial-prompt' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'GET') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) {
        const entries = [...initialPrompts.entries()]
          .map(([entryKey, entry]) => ({
            key: entryKey,
            chars: entry.text.length,
            createdAt: entry.createdAt || 0,
            updatedAt: entry.updatedAt || 0,
            preview: entry.text.replace(/\s+/g, ' ').slice(0, 80)
          }))
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        sendJson({ ok: true, entries, maxChars: initialPromptMaxChars(), writable: initialPromptsWritable });
        return true;
      }
      const canonical = canonicalV2Key(key);
      if (!canonical) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const entry = initialPrompts.get(canonical) ?? null;
      sendJson({
        ok: true,
        key: canonical,
        exists: !!entry,
        text: entry?.text ?? '',
        createdAt: entry?.createdAt || 0,
        updatedAt: entry?.updatedAt || 0,
        maxChars: initialPromptMaxChars(),
        writable: initialPromptsWritable
      });
      return true;
    }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const explicitDelete = body.delete === true;
    // 只接受 { key, text: string } 或 { key, delete: true }：
    // 缺 text 时不当作"清空"（否则一次漏字段的调用就把操作者写的内容删了）。
    if (!explicitDelete && typeof body.text !== 'string') {
      sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
      return true;
    }
    const result = setInitialPrompt(key, explicitDelete ? '' : body.text);
    if (!result.ok) { sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return true; }
    log(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
    sendJson({
      ok: true,
      key: result.key,
      deleted: result.deleted,
      chars: result.chars,
      exists: !!result.entry,
      updatedAt: result.entry?.updatedAt || 0,
      maxChars: initialPromptMaxChars()
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return true; }
    const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
    try {
      if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return true; }
      const buf = fs.readFileSync(selfPath);
      const mimeType = mimeFromBuffer(buf) || 'image/png';
      sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
    } catch (error) {
      sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/groups') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式读取必须携带 agent token' }, 403); return true; }
    try {
      const resp = await bot.request('get_group_list', {});
      const list = Array.isArray(resp?.data) ? resp.data : (Array.isArray(resp) ? resp : []);
      const groups = list
        .filter((g) => allowed('group', g.group_id, cfg))
        .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      sendJson({ ok: true, total: groups.length, groups });
    } catch (error) {
      log(`[groups] 拉群列表失败：${error?.message ?? error}`);
      sendJson({ ok: false, error: `拉群列表失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/screen') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    try {
      const shot = await captureDeviceScreenshotV2();
      // 2026-11-09：给模型看的截图先缩图（默认 800 宽 JPEG），否则 1.2MB 原图 base64 后整块进上下文
      const shown = await shrinkScreenshotV2(shot);
      sendJson({ ok: true, key, bytes: shown.buffer.length, rawBytes: shot.length, mimeType: shown.mimeType, data: shown.buffer.toString('base64') });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/send-qzone') {
    const body = await readBody();
    const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
    const content = String(body.content ?? '').trim();
    const conf = qzoneCfg();
    if (!conf.enabled) { sendJson({ ok: false, error: 'QQ 空间已关闭' }, 403); return true; }
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return true; }
    if (shouldBlockSilentReply('qzone')) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
    const state = loadQzoneState();
    const used = qzoneUsedToday(state);
    if (used >= conf.maxPerDay) {
      sendJson({ ok: false, error: `今天已经发过 ${used} 条说说了（上限 ${conf.maxPerDay} 条），明天再说吧` }, 429);
      return true;
    }
    try {
      const data = await sendQzonePostV2(content, {
        images: body.images,
        ugcRight: body.ugc_right ?? body.ugcRight,
        targetUins: body.target_uins ?? body.targetUins
      });
      state.count = used + 1;
      state.items.push({ at: Date.now(), content: content.slice(0, 200), tid: String(data?.tid ?? data?.appid ?? '') });
      if (state.items.length > 100) state.items = state.items.slice(-100);
      saveQzoneState(state);
      log(`[qzone] 已发说说（今天第 ${state.count}/${conf.maxPerDay} 条，${content.length} 字）`);
      appendActivity(`[qzone] 发说说：${content.slice(0, 40)}`);
      sendJson({ ok: true, usedToday: state.count, maxPerDay: conf.maxPerDay, data });
    } catch (error) {
      log(`[qzone] 发说说失败：${error?.message ?? error}`);
      sendJson({ ok: false, error: `发说说失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/qzone-list') {
    const body = await readBody();
    const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
    const conf = qzoneCfg();
    if (!conf.enabled) { sendJson({ ok: false, error: 'QQ 空间已关闭' }, 403); return true; }
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    try {
      const data = await listQzonePostsV2(body.page_num ?? body.pageNum, body.count);
      const state = loadQzoneState();
      sendJson({ ok: true, usedToday: qzoneUsedToday(state), maxPerDay: conf.maxPerDay, data });
    } catch (error) {
      log(`[qzone] 拉说说列表失败：${error?.message ?? error}`);
      sendJson({ ok: false, error: `拉说说列表失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
      sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
      return true;
    }
    const replyWait = body.purpose === 'reply';
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return true; }
    if (socialV2.paused) {
      const st = getSocialV2State(key);
      sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
      return true;
    }
    const waitCfg = cfg.socialV2?.wait ?? {};
    const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
    const defaultMs = Number(waitCfg.defaultMs) || 30000;
    const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
    const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
    const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
    const st = getSocialV2State(key);
    // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
    // 租约按**归一后的** key 记账：`group:0123` 与 `group:123` 是同一个会话，
    // 用原始 key 会给出两个租约槽（同一会话并发多个 5~10 分钟等待、互相踩水位）。
    // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
    const leaseKey = canonicalV2Key(key) ?? key;
    if (activeWaits.has(leaseKey) && Date.now() - activeWaits.get(leaseKey) < ACTIVE_WAIT_LEASE_MS) {
      sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
      return true;
    }
    const leaseStamp = Date.now();
    activeWaits.set(leaseKey, leaseStamp);
    // 只由「自己那一份租约」负责删除：超时接管后，旧等待结束时不能把新租约删掉。
    const finishWait = () => { if (activeWaits.get(leaseKey) === leaseStamp) activeWaits.delete(leaseKey); };
    req.on('close', finishWait);
    // 响应关闭也兜底清租约：handler 中途抛错时由外层 catch 回一个 JSON，
    // 那条路径不会经过下面的 finishWait()，会留下 15 分钟的假 429。
    res.on('close', finishWait);
    const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
    const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
    const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
    // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
    // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
    // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
    const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
    // A reply wait must also include messages received while the model
    // was reading/thinking after its snapshot, before this HTTP request.
    const requestSeq = st.lastUnreadSeq || 0;
    const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
    const start = Date.now();
    let arrived = false;
    let lastNewAt = 0;
    let aborted = false;
    req.on('close', () => { aborted = true; });
    if (replyWait) {
      const incomingAt = () => {
        const value = Number(st.lastIncomingAt);
        return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
      };
      lastNewAt = incomingAt();
      let observedSeq = st.lastUnreadSeq || 0;
      // Batch delay and model reading time already count towards quiet.
      // New arrivals restart quiet, but timeoutMs remains a hard budget.
      while (!aborted && Date.now() - start < timeoutMs) {
        if ((st.lastUnreadSeq || 0) !== observedSeq) {
          observedSeq = st.lastUnreadSeq || 0;
          lastNewAt = incomingAt();
        }
        const remaining = quietMs - (Date.now() - lastNewAt);
        if (remaining <= 0) break;
        await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
      }
      // A message may arrive during the final sleep, exactly at timeout.
      // Its timestamp must still invalidate the previous quiet window.
      lastNewAt = incomingAt();
      arrived = (st.lastUnreadSeq || 0) > baseline;
    } else while (Date.now() - start < timeoutMs && !aborted) {
      let nowSeq = st.lastUnreadSeq || 0;
      if (nowSeq - baseline >= minNew) {
        arrived = true;
        lastNewAt = Date.now();
        // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
        // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
        while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
          if ((st.lastUnreadSeq || 0) > nowSeq) {
            nowSeq = st.lastUnreadSeq || 0;
            lastNewAt = Date.now();
          }
          await sleep(200);
        }
        break;
      }
      await sleep(300);
    }
    const waitedMs = Date.now() - start;
    if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
        (req.headers['x-agent-token'] && (getCurrentMode() !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
          || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
      finishWait();
      sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
      return true;
    }
    const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    const preSleepRemainingMs = preSleepWaitBlockedV2(st)
      ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
      : 0;
    const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
    // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
    // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
    const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
    // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
    // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
    const preSleepSatisfiedNow = !replyWait && (!arrived
      ? waitedMs >= preSleepWaitMs
      : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
    if (preSleepSatisfiedNow) {
      st.preSleepWaitSatisfiedAt = Date.now();
      st.preSleepWaitObservedAt = 0;
      st.preSleepWaitAccumMs = 0;
    } else if (!replyWait && !arrived) {
      // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
      st.preSleepWaitAccumMs = 0;
    } else if (!replyWait) {
      // 等待期间有新消息：
      // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
      // - 否则只清空累计，不算完成沉睡前观察。
      if (preSleepAttempt) {
        st.preSleepWaitObservedAt = Date.now();
      }
      st.preSleepWaitAccumMs = 0;
    }
    if (!replyWait) saveSocialV2State();
    // Each buffer is governed by its own tool switch: the unread buffer by
    // getUnread, the recent buffer by getRecent. A disabled switch must not leak
    // through either newMessages or the watermark, so the buffer is dropped
    // before arrival is judged -- not filtered afterwards.
    const history = replyWait
      ? [...(v2ToolEnabled('getUnread') ? st.unread : []),
        ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])]
      : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
    const pending = [...new Map(history
      .filter((m) => m && !m.isSelf && (m.seq || 0) > baseline)
      .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
    // `arrived` is recomputed against what this request may actually hand over,
    // so a suppressed buffer cannot report an arrival it is not allowed to show.
    const newMessages = replyWait ? pending : (arrived ? pending : []);
    const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
    const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
      : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
    const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
    finishWait();
    sendJson({
      ok: true,
      key,
      purpose: replyWait ? 'reply' : 'messages',
      arrived,
      quiet,
      quietMs,
      suggestedQuietMs,
      speakerLikelyDone: quiet,
      lastMessageUnfinished,
      timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
      waitedMs,
      preSleepWaitSatisfied: preSleepSatisfiedNow,
      preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
      // A reply check has no sleep countdown; showing one here suggests
      // the model should complete sleep observation before its first reply.
      ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
      newMessages,
      readThroughSeq,
      unreadCount: st.unread.length
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
    sendJson({ ok: true, entries: readFeedbackEntries() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
    atomicWriteJson(FEEDBACK_FILE, []);
    log('控制台：清空 AI 反馈');
    sendJson({ ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
    const rawMessage = String(body.message ?? '').trim();
    if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return true; }
    // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
    const fNow = Date.now();
    const fTimes = feedbackTimes.get(key) || [];
    const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
    const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
    if (fRecentMinute >= 5 || fRecentHour >= 20) {
      sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
      return true;
    }
    fTimes.push(fNow);
    feedbackTimes.set(key, fTimes.slice(-100));
    const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
    const message = truncateText(rawMessage, maxLength);
    appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
    log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
    appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
    if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
      log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
    }
    sendJson({ ok: true, key, level, message });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    if (!token || !agentTokenOk(key, token)) {
      // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
      // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
      // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
      sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
      return true;
    }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
      return true;
    }
    sendJson({ ok: true, key });
    return true;
  }

  if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
    const body = await readBody();
    const token = String(body.token ?? '').trim();
    const isPrivate = url.pathname === '/api/send/private';
    const isReply = url.pathname === '/api/send/reply';
    const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
    const message = unquoteJsonString(String(body.message ?? '').trim());
    // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
    // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
    // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
    const replyToMessageId = body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
    // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
    // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
    if (currentMode === 'chat' || currentMode === 'reserved') {
      sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
      return true;
    }
    if (socialV2.paused && token) {
      sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
      return true;
    }
    if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return true; }
    if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
    if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
      sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
      return true;
    }
    if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
    if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return true; }
    if (shouldBlockSilentReply(key)) {
      sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
      return true;
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return true; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
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
    const sendCfg = cfg.socialV2?.send ?? {};
    const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
    if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return true; }
    if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
    // st/now 必须声明在 try **之外**：下面的 catch 要用它们回滚预占的发送额度。
    // 写在 try 里时 catch 拿到的是块作用域外的名字 ⇒ ReferenceError（send-burst
    // 曾整段踩过同型问题，见体检报告 #1 / R2）。后果不是"少一行日志"，而是
    // 失败响应变成「st is not defined」、额度不回滚（接下来一分钟全是假 429），
    // 且部分成功的已发消息不会被记进 recentMessages。
    const st = getSocialV2State(key);
    const now = Date.now();
    try {
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      // 额度检查/预占/回滚统一在 src/rate-limit.mjs（原来这里手写 9 份，语义已漂）。
      const quota = checkQuota(st.sendTimes, { now, need: 1, maxPerMinute, maxPerHour });
      if (!quota.ok) {
        sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return true;
      }
      st.sendTimes = reserveQuota(st.sendTimes, 1, now);
      const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
      recordSentMessagesV2(key, sentMessages);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      saveSocialV2State();
      log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
      appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
      if (sentMessages.length > 0) scheduleReplyCheckV2(key);
      sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
    } catch (error) {
      if (error?.sent?.length) {
        recordSentMessagesV2(key, error.sent);
        log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
      }
      // 失败/未发出的消息回滚预占的发送额度，避免假 429。
      const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
      const failedCount = Math.max(0, 1 - sentCount);
      rollbackQuota(st.sendTimes, failedCount);
      saveSocialV2State();
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return true;
  }

  return false;
}
