/**
 * 控制台「群聊黑话 / 网络用语」域路由（原 bridge.js startConsoleServer 内联代码 4214–4468 行搬出）。
 *
 * 契约（与 console/roles.mjs 保持一致）：
 * - 入口 handleSlangRoutes(ctx) → boolean：true = 已应答（含 400/404 收尾），false = 路径不归本域；
 * - 本模块不 import bridge.js（防循环依赖），依赖全部由 ctx 注入；主函数只留
 *   `if (await handleSlangRoutes(consoleCtx)) return;` 一行，路由判断顺序保持不变；
 * - 行为逐字搬迁：状态码、错误文案、日志文案都不改（控制台页面与 tests 按这些字符串断言）；
 * - slangEntries / slangStoreWritable 是 bridge.js 的模块级 let，这里用 getter / 快照读，不自己缓存副本；
 *   Map / Set（slangWindows 等）是 const 引用，直接注入。
 */
import { buildSlangContext, createSlangEntry, mergeEvidence, SLANG_STATUS } from '../slang-learner.js';

export async function handleSlangRoutes(ctx) {
  const {
    req, url, sendJson, readBody, log, path, ROOT, cfg, readConfigObject, atomicWriteJson,
    slangStoreWritable,
    getSlangEntries, setSlangEntries,
    slangWindows, slangExtractionCooldowns, slangSubmitTimes, slangResearchingIds,
    saveSlangStore, queueSlangTask, runSlangExtraction, runSlangResearch, invalidateSlangLearnerSession,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled, confirmedSlangListV2, redactKnownTokensOnly,
    allowSlangSubmit, publicSlangEntry, appendActivity
  } = ctx;
  // slangEntries 在桥里是 let（清空 / 批量删除会整体重绑），每次读写都走 getter，避免拿到旧数组
  const entries = () => getSlangEntries();

  if (req.method === 'GET' && url.pathname === '/api/slang') {
    const status = url.searchParams.get('status') || '';
    const list = status ? entries().filter((e) => e.status === status) : entries();
    sendJson({ entries: list, config: cfg.slang, writable: slangStoreWritable });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang') {
    const body = await readBody();
    const content = String(body.content ?? '').trim();
    if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return true; }
    if (entries().some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return true; }
    const entry = createSlangEntry({
      content,
      meaning: String(body.meaning ?? '').trim(),
      usage: String(body.usage ?? '').trim(),
      example: String(body.example ?? '').trim(),
      risk: String(body.risk ?? '').trim(),
      sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
      status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
      source: 'manual',
      evidence: Array.isArray(body.evidence) ? body.evidence : []
    });
    entries().push(entry);
    saveSlangStore();
    log(`控制台：新增黑话「${content}」`);
    sendJson({ ok: true, entry });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
    const body = await readBody();
    const status = String(body.status ?? '').trim();
    if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
      sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
      return true;
    }
    let removedCount = 0;
    if (status) {
      removedCount = entries().filter((e) => e.status === status).length;
      setSlangEntries(entries().filter((e) => e.status !== status));
    } else {
      removedCount = entries().length;
      setSlangEntries([]);
      // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
      slangWindows.clear();
      slangExtractionCooldowns.clear();
      slangSubmitTimes.clear();
      slangResearchingIds.clear();
    }
    saveSlangStore();
    log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
    sendJson({ ok: true, removedCount });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
    const body = await readBody();
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    const status = String(body.status ?? '').trim();
    if (ids.length) {
      const idSet = new Set(ids);
      const before = entries().length;
      setSlangEntries(entries().filter((e) => !idSet.has(e.id)));
      const removedCount = before - entries().length;
      if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return true; }
      saveSlangStore();
      log(`控制台：批量删除黑话 ${removedCount} 条`);
      sendJson({ ok: true, removedCount });
      return true;
    }
    if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
      sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
      return true;
    }
    if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return true; }
    const removedCount = entries().filter((e) => e.status === status).length;
    setSlangEntries(entries().filter((e) => e.status !== status));
    saveSlangStore();
    log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
    sendJson({ ok: true, removedCount });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
    const body = await readBody();
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return true; }
    let confirmedCount = 0;
    let skippedCount = 0;
    const skipped = [];
    for (const id of ids) {
      const idx = entries().findIndex((e) => e.id === id);
      if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
      const entry = entries()[idx];
      if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
      if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
      entry.status = SLANG_STATUS.CONFIRMED;
      entry.updatedAt = new Date().toISOString();
      confirmedCount++;
    }
    if (confirmedCount) saveSlangStore();
    log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
    sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
    const body = await readBody();
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return true; }
    let rejectedCount = 0;
    for (const id of ids) {
      const idx = entries().findIndex((e) => e.id === id);
      if (idx < 0) continue;
      const entry = entries()[idx];
      if (entry.status === SLANG_STATUS.REJECTED) continue;
      entry.status = SLANG_STATUS.REJECTED;
      entry.updatedAt = new Date().toISOString();
      rejectedCount++;
    }
    if (rejectedCount) saveSlangStore();
    log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
    sendJson({ ok: true, rejectedCount });
    return true;
  }
  const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
  if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
    const id = slangMatch[1];
    const idx = entries().findIndex((e) => e.id === id);
    if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
    const body = await readBody();
    const entry = { ...entries()[idx] };
    if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
    if (body.content !== undefined && entries().some((e) => e.id !== id && e.content === entry.content)) {
      sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
      return true;
    }
    if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
    if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
    if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
    if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
    if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
    if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
    if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return true; }
    entry.updatedAt = new Date().toISOString();
    entries()[idx] = entry;
    saveSlangStore();
    log(`控制台：更新黑话「${entry.content}」`);
    sendJson({ ok: true, entry });
    return true;
  }
  if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
    const id = slangMatch[1];
    const idx = entries().findIndex((e) => e.id === id);
    if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
    const body = await readBody();
    const entry = entries()[idx];
    if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
    if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
    if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
    if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
    if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
    if (!entry.meaning) {
      sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
      return true;
    }
    entry.status = SLANG_STATUS.CONFIRMED;
    entry.updatedAt = new Date().toISOString();
    saveSlangStore();
    log(`控制台：确认黑话「${entry.content}」`);
    sendJson({ ok: true, entry });
    return true;
  }
  if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
    const id = slangMatch[1];
    const idx = entries().findIndex((e) => e.id === id);
    if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
    const entry = entries()[idx];
    entry.status = SLANG_STATUS.REJECTED;
    entry.updatedAt = new Date().toISOString();
    saveSlangStore();
    log(`控制台：拒绝黑话「${entry.content}」`);
    sendJson({ ok: true, entry });
    return true;
  }
  if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
    const id = slangMatch[1];
    const idx = entries().findIndex((e) => e.id === id);
    if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
    const [removed] = entries().splice(idx, 1);
    saveSlangStore();
    log(`控制台：删除黑话「${removed.content}」`);
    sendJson({ ok: true, removed });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
    if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (key && slangWindows.has(key)) {
      queueSlangTask(() => runSlangExtraction(key));
      sendJson({ ok: true, key });
    } else {
      const firstKey = slangWindows.keys().next().value;
      if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return true; }
      queueSlangTask(() => runSlangExtraction(firstKey));
      sendJson({ ok: true, key: firstKey });
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/research') {
    if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return true; }
    const body = await readBody();
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const candidates = ids.length
      ? entries().filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
      : entries().filter((e) => e.status === SLANG_STATUS.CANDIDATE);
    if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return true; }
    queueSlangTask(() => runSlangResearch(candidates));
    sendJson({ ok: true, count: candidates.length });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/slang/config') {
    const body = await readBody();
    const oldPreset = cfg.slang?.learnerPreset;
    const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
    const configFile = path.join(ROOT, 'config.json');
    const file = readConfigObject(configFile);
    const merged = { ...(file.slang ?? {}), ...body };
    if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
    else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
    if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
    if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
    if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
    if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
    if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
    if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
    if (body.inferenceThresholds !== undefined) {
      const raw = Array.isArray(body.inferenceThresholds)
        ? body.inferenceThresholds
        : String(body.inferenceThresholds).split(/[,，\s]+/);
      merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
      if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
    }
    file.slang = merged;
    atomicWriteJson(configFile, file);
    cfg.slang = { ...cfg.slang, ...merged };
    if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
      invalidateSlangLearnerSession();
      log('黑话学习 preset 已变更，已重置学习会话');
    } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
      invalidateSlangLearnerSession();
      log('黑话学习工作区名已变更，已重置学习会话');
    }
    log('控制台：黑话系统配置已更新');
    sendJson({ ok: true, config: cfg.slang });
    return true;
  }
  // ── 二代黑话学习（reserved2）：AI 查询 / 提交黑话候选 ─────────────────
  // 原在 bridge.js 的 /api/socialV2/slang/*；与 /api/slang* 同属黑话域（第 4 域切分时漏搬，这里补齐）。
  if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return true; }
    const list = confirmedSlangListV2().filter((e) => {
      if (!q) return true;
      return e.content.toLowerCase().includes(q)
        || e.meaning.toLowerCase().includes(q)
        || e.usage.toLowerCase().includes(q)
        || e.example.toLowerCase().includes(q);
    });
    sendJson({
      ok: true,
      key,
      total: list.length,
      entries: list,
      block: buildSlangContext(entries(), cfg.slang?.injectMax ?? 8)
    });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
    const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return true; }
    if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return true; }
    if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return true; }
    if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return true; }
    if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return true; }
    const existing = entries().find((e) => e.content === content);
    if (existing) {
      if (existing.status === SLANG_STATUS.CONFIRMED) {
        sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
        return true;
      }
      if (existing.status === SLANG_STATUS.REJECTED) {
        sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
        return true;
      }
      // candidate：累计出现次数并追加语境证据
      existing.count = (Number(existing.count) || 0) + 1;
      if (context) {
        existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
      }
      existing.updatedAt = new Date().toISOString();
      saveSlangStore();
      if (cfg.slang?.autoResearch !== false) {
        const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
        if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
          queueSlangTask(() => runSlangResearch([existing]));
        }
      }
      log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
      sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
      return true;
    }
    const entry = createSlangEntry({
      content,
      source: 'ai',
      status: SLANG_STATUS.CANDIDATE,
      evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
    });
    entries().push(entry);
    saveSlangStore();
    if (cfg.slang?.autoResearch !== false) {
      queueSlangTask(() => runSlangResearch([entry]));
    }
    log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
    appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
    sendJson({ ok: true, entry: publicSlangEntry(entry) });
    return true;
  }
  return false;
}
