/**
 * 控制台「轻量记忆」域路由（原 bridge.js startConsoleServer 内联代码 7137–7289 行搬出）。
 *
 * 契约（与 console/roles.mjs、console/slang.mjs 保持一致）：
 * - 入口 handleMemoryRoutes(ctx) → boolean：true = 已应答（含 400/404 收尾），false = 路径不归本域；
 * - 本模块不 import bridge.js（防循环依赖），依赖全部由 ctx 注入；主函数只留
 *   `if (await handleMemoryRoutes(consoleCtx)) return true;` 一行，路由判断顺序保持不变；
 * - 行为逐字搬迁：状态码、错误文案、工具开关文案（qq_memory_append / qq_memory_* /
 *   qq_memory_query / qq_memory_remove / qq_memory_clear）都不改，MCP 工具与测试按这些字符串断言；
 * - getSocialV2State / appendMemoryV2 / formatMemoryV2 / saveSocialV2State 是桥里的状态入口，
 *   一律注入（本模块不碰社交状态文件、不自己缓存副本）。
 *
 * 五条路由：POST /api/socialV2/memory-append | memory-update | memory-remove | memory-clear，
 * GET /api/socialV2/memory。memberImpression 的键名走 __proto__ 黑名单（原型链污染防护），
 * 条目上限 50 条按 lastSeenAt 淘汰最旧 —— 这两条是安全边界，搬迁时不许简化。
 */
export async function handleMemoryRoutes(ctx) {
  const {
    req, url, sendJson, readBody,
    getSocialV2State, appendMemoryV2, formatMemoryV2, saveSocialV2State,
    redactKnownTokensOnly, agentTokenOk, v2SessionAllowed, v2ToolEnabled
  } = ctx;

  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    const content = String(body.content ?? '').trim();
    const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
    if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return true; }
    if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
    if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return true; }
    const st = getSocialV2State(key);
    appendMemoryV2(st, category, content, extra);
    sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    const oldContent = String(body.oldContent ?? '').trim();
    const target = redactKnownTokensOnly(String(body.target ?? '').trim());
    const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
    const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
    const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
    const cleanNewExtra = {
      ...newExtra,
      pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
      participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
      motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
      target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
    };
    if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; }
    if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
    if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return true; }
    if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return true; }
    const st = getSocialV2State(key);
    if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
      const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
      if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return true; }
      if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
      if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
      if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
    } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
      const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
      if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return true; }
      if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
      if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
      if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
    } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
      const oldTarget = target;
      if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
      // 必须命中**已有**条目（own property）：否则任意 target 都能凭空建一条，
      // 而 'toString'/'valueOf' 这类名字会从 Object.prototype 上取到继承来的函数，
      // 往函数对象上写 traits —— JSON.stringify 又会把它整个丢掉（静默数据丢失）。
      if (!Object.prototype.hasOwnProperty.call(st.memberImpressions, oldTarget)) {
        sendJson({ ok: false, error: '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）' }, 404);
        return true;
      }
      const im = st.memberImpressions[oldTarget];
      const newTarget = String(cleanNewExtra.target || oldTarget).trim().slice(0, 64);
      if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
      if (newContent !== undefined) {
        im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
      }
      if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
      if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
      st.memberImpressions[newTarget] = im;
      // 与控制台/AI 的 append 路径保持一致：条目数上限 50，超了按 lastSeenAt 淘汰最旧，
      // 否则 memory-update 能无限塞名字（每次 1MB 请求 → 状态文件与每轮 prompt 一起膨胀）。
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i += 1) delete st.memberImpressions[impressionEntries[i][0]];
      }
    }
    saveSocialV2State();
    sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const category = String(url.searchParams.get('category') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return true; }
    const st = getSocialV2State(key);
    const raw = {
      activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
      pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
      memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
    };
    if (category === 'activeTopic') {
      raw.pendingThoughts = [];
      raw.memberImpressions = {};
    } else if (category === 'pendingThought') {
      raw.activeTopics = [];
      raw.memberImpressions = {};
    } else if (category === 'memberImpression') {
      raw.activeTopics = [];
      raw.pendingThoughts = [];
    }
    sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    const content = String(body.content ?? '').trim();
    const target = String(body.target ?? '').trim();
    if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; }
    if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
    if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return true; }
    if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
    if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return true; }
    const st = getSocialV2State(key);
    if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
    } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
    } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
      delete st.memberImpressions[target];
    }
    saveSocialV2State();
    sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const category = String(body.category ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return true; }
    const st = getSocialV2State(key);
    if (!category || category === 'activeTopic') st.activeTopics = [];
    if (!category || category === 'pendingThought') st.pendingThoughts = [];
    if (!category || category === 'memberImpression') st.memberImpressions = {};
    saveSocialV2State();
    sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
    return true;
  }
  return false;
}
