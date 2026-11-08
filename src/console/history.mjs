/**
 * 控制台 —— 查询历史域（history）
 *
 * 职责
 *   搬出 startConsoleServer 里的 7 条「查历史 / 查转发 / 查成员 / 查图片」路由：
 *     GET  /api/socialV2/my-recent          最近由「我」发出的消息（带 paused 供桌宠用）
 *     POST /api/socialV2/record-sent        内部接口，恒 403（防伪造历史）
 *     GET  /api/socialV2/message-detail     单条消息详情（本地优先，回落 OneBot）
 *     GET  /api/socialV2/forward-message    合并转发展开（含嵌套预览，1 层最多 5 个 id）
 *     POST /api/socialV2/forward-media      转发里的媒体读取（base64 → images）
 *     GET  /api/socialV2/active-members     按发言数排的活跃成员
 *     GET  /api/images/message              指定消息的图片/表情（MCP qq_get_message_images）
 *
 * 明确不做
 *   - 不碰发送（send.mjs）、不碰表情包库（stickers.mjs）、不碰收件箱/唤醒（inbox.mjs）；
 *   - 不实现鉴权与模式判断，只调用注入的 agentTokenOk / v2SessionAllowed / v2ToolEnabled / modeAllowed；
 *   - 不实现消息存储与 OneBot 访问，只调用注入的 getSocialV2State / resolveReplyInfo / fetchMediaData；
 *   - /api/authorize/read 留在桥里（它是鉴权端点本身，不属于查询语义）。
 *
 * 状态归属
 *   - 会话态一律来自 getSocialV2State(key)（桥持有），模块不缓存；
 *   - seenForwardIds（key → Set<forwardId>，上限 1000）是桥的 Map，按引用注入后由模块读写（不重绑）；
 *   - 只读：不写 state、不发消息、不动定时器。
 *
 * 接口契约
 *   export async function handleHistoryRoutes(ctx) → boolean   // true = 已处理并已回包
 *   - **必须 async**：message-detail / forward-message / forward-media / images 都 await。
 *   - 返回 false 表示「不是本域路由」，调用方继续往下走；不得回包后再返回 false。
 *   - 依赖全部从 ctx 取，模块只 import 纯函数 formatForwardResponse（src/forward.js）。
 *   - 挂载点两处（两段路由在桥里不连续），顺序与搬迁前一致。
 */
import { formatForwardResponse } from '../forward.js';

export async function handleHistoryRoutes(ctx) {
  const {
    req, url, sendJson, readBody, log, bot,
    cfg, currentMode,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled, modeAllowed,
    getSocialV2State, readThroughSeqV2,
    resolveReplyInfo, fetchMediaData, findMessageMedia, seenForwardIds
  } = ctx;

  if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return true; }
    const st = getSocialV2State(key);
    const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
    // 2026-10-27 修：桌宠一直在等这个字段（pet-electron/main.js:801），但这里从来没返回过 →
    // s.paused 恒 null → 菜单永远显示「暂停」、点了只能暂停不能恢复。补上。
    sendJson({ ok: true, key, paused: !!st.paused, messages: mine, readThroughSeq: readThroughSeqV2(st) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
    // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
    sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const messageId = String(url.searchParams.get('messageId') ?? '').trim();
    if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return true; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    try {
      const st = getSocialV2State(key);
      const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
      const forwardFields = found ? {
        forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
        hasForward: !!found.hasForward
      } : {};
      let info = null;
      // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
      if (found && found.messageId && String(found.messageId) !== messageId) {
        info = {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: found.userId ? String(found.userId) : null,
          messageId: String(found.messageId),
          seq: found.seq
        };
      } else {
        info = await resolveReplyInfo(kind, id, messageId);
        if (!info && found) {
          info = {
            sender: String(found.sender || ''),
            text: String(found.text || found.plain || '').slice(0, 200),
            userId: found.userId ? String(found.userId) : null,
            messageId: found.messageId ? String(found.messageId) : null,
            seq: found.seq
          };
        }
      }
      // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
      if (info && found) Object.assign(info, forwardFields);
      // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
      if (info) info.textTruncated = String(info.text ?? '').length >= 200;
      sendJson({ ok: true, key, messageId, info });
    } catch (error) {
      sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const id = String(url.searchParams.get('id') ?? '').trim();
    const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return true; }
    if (currentMode !== 'reserved2') {
      sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
      return true;
    }
    if (!agentToken) {
      sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
      return true;
    }
    if (!agentTokenOk(key, agentToken)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return true;
    }
    const kind = keyMatch[1];
    const num = Number(keyMatch[2]);
    if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
      return true;
    }
    if (!v2ToolEnabled('getForwardMsg')) {
      sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
      return true;
    }
    // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
    const st = getSocialV2State(key);
    const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
    const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
    const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
    if (!seenInRecent && !seenInUnread && !seenInMemory) {
      sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
      return true;
    }
    try {
      const data = await bot.raw('get_forward_msg', { id });
      const formatted = formatForwardResponse(data);
      const remember = (fid) => {
        if (!fid) return true;
        let set = seenForwardIds.get(key);
        if (!set) {
          set = new Set();
          seenForwardIds.set(key, set);
        }
        set.add(fid);
        if (set.size > 1000) {
          for (const old of set) {
            set.delete(old);
            if (set.size <= 1000) break;
          }
        }
      };
      // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
      for (const m of formatted.messages || []) {
        for (const fid of m.nestedForwardIds || []) remember(fid);
      }
      // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
      const nestedPreviews = [];
      const nestedIds = [];
      const seenNested = new Set();
      for (const m of formatted.messages || []) {
        for (const fid of m.nestedForwardIds || []) {
          if (!seenNested.has(fid) && nestedIds.length < 5) {
            seenNested.add(fid);
            nestedIds.push(fid);
          }
        }
      }
      for (const fid of nestedIds) {
        try {
          const ndata = await bot.raw('get_forward_msg', { id: fid });
          const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
          for (const nm of nfmt.messages || []) {
            for (const nfid of nm.nestedForwardIds || []) remember(nfid);
          }
          nestedPreviews.push({ id: fid, ...nfmt });
        } catch (error) {
          log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
          nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
        }
      }
      sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
    } catch (error) {
      log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const media = Array.isArray(body.media) ? body.media : [];
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return true; }
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return true; }
    if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return true; }
    try {
      const images = await fetchMediaData(media);
      sendJson({ ok: true, key, media, images });
    } catch (error) {
      log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
      sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return true; }
    const st = getSocialV2State(key);
    const map = new Map();
    for (const m of st.recentMessages) {
      if (!m || m.isSelf) continue;
      const uid = m.userId ? String(m.userId) : '';
      const key2 = uid || String(m.sender || '未知');
      const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
      if (!cur.userId && uid) cur.userId = uid;
      cur.count += 1;
      if (m.time > cur.lastTime) cur.lastTime = m.time;
      if (m.isOwner) cur.isOwner = true;
      map.set(key2, cur);
    }
    const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
    sendJson({ ok: true, key, members });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/images/message') {
    const key = String(url.searchParams.get('key') ?? '').trim();
    const messageId = String(url.searchParams.get('messageId') ?? '').trim();
    const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return true; }
    if (currentMode === 'reserved2' && !agentToken) {
      sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
      return true;
    }
    if (currentMode === 'chat' || currentMode === 'reserved') {
      sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
      return true;
    }
    if (agentToken && !agentTokenOk(key, agentToken)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return true;
    }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
      return true;
    }
    if (agentToken && !v2ToolEnabled('getImages')) {
      sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
      return true;
    }
    if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
      sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
      return true;
    }
    const media = findMessageMedia(key, messageId);
    if (!media.length) {
      sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
      return true;
    }
    try {
      const images = await fetchMediaData(media);
      sendJson({ ok: true, messageId, media, images });
    } catch (error) {
      log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  return false;
}
