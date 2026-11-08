// 控制台「表情包域」路由（从 startConsoleServer 切出，行为逐字搬迁）。
//
// 契约：
//   1) handleStickerRoutes(ctx) → boolean：true = 本请求已被本域应答（含 400/403/404/429/500）；
//      false = 路径不归本域，主函数继续往下匹配。
//   2) 不 import bridge.js：表情库状态与同步/写入函数全部由 consoleCtx 注入，便于离线单测。
//   3) 必须 async —— 收藏/列表/备注都要 await readBody()、拉 OneBot 与落盘。
//   4) 路由在 bridge.js 里是**两段不连续代码**（sticker-image/note/remark 一段，
//      collect-sticker/列表/管理端接口一段，中间夹着 self-image 与语音域），主函数各调一次本 handler，
//      顺序与原文件一致；路径两两不重叠，所以提前匹配不改变语义。
//
// 负责的路由：
//   GET      /api/socialV2/sticker-image   取单张收藏表情图片（base64 + 尺寸/像素上限校验）
//   POST     /api/socialV2/sticker-note    AI 给自己的表情库写本地理解（note/tags/usage）
//   POST     /api/socialV2/sticker-remark  AI 改 QQ 收藏表情的官方备注（默认关闭）
//   POST     /api/socialV2/collect-sticker AI 收藏会话里的一张表情（限频预占/回滚 + 落盘）
//   GET|POST /api/socialV2/sticker-list    表情库列表（GET 不触发强制同步；POST 可 refresh，AI 强制刷新 10s 节流）
//   GET      /api/stickers                 控制台列表（只读，不触发同步）
//   POST     /api/stickers/sync            控制台强制同步 QQ 收藏表情
//   POST     /api/stickers/note            控制台写本地理解
//   POST     /api/stickers/remark          控制台改官方备注
//
// 状态归属：stickerEntries / stickerSyncedAt / stickerStoreWritable 由桥持有（其它域也在读），
// 这里只通过 getStickerEntries() / getStickerSyncedAt() / getStickerStoreWritable() 读；
// lastForcedAgentStickerSync 只服务本域的 AI 强制刷新节流，随路由一起搬到本模块（原先就是 bridge.js 模块级 let）。
let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护（毫秒时间戳）

export async function handleStickerRoutes(ctx) {
  const {
    req, url, sendJson, readBody, log, cfg,
    stickerEnabled, getStickerImageData, applyStickerNoteV2, setStickerRemarkV2, collectStickerV2,
    safeFetchBuffer, MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS, getImageDimensions, mimeFromBuffer, mimeFromUrl,
    checkQuota, reserveQuota, rollbackQuota, syncStickerLibrary, formatStickerList,
    getSocialV2State, saveSocialV2State, appendActivity,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled,
    getStickerEntries, getStickerSyncedAt, getStickerStoreWritable
  } = ctx;

  if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const key = String(url.searchParams.get('key') ?? '').trim();
    const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return true; }
    try {
      const entry = await getStickerImageData(stickerId);
      const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
      const dims = getImageDimensions(fetched.buffer);
      if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
        sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
        return true;
      }
      const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
      sendJson({
        ok: true,
        key,
        sticker: {
          id: entry.id,
          desc: entry.desc || '',
          localNote: entry.localNote || '',
          tags: entry.tags || [],
          url: entry.url,
          md5: entry.md5
        },
        image: { mimeType, data: fetched.buffer.toString('base64') }
      });
    } catch (error) {
      sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const stickerId = String(body.stickerId ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return true; }
    const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
    const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
    const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
    const entry = applyStickerNoteV2(stickerId, note, tags, usage);
    if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; }
    log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
    sendJson({ ok: true, key, sticker: entry });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const stickerId = String(body.stickerId ?? '').trim();
    if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return true; }
    try {
      const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
      log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
      sendJson({ ok: true, key, sticker: entry });
    } catch (error) {
      sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const messageRef = String(body.messageId ?? body.seq ?? '').trim();
    const remark = String(body.remark ?? '').trim();
    if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return true; }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const st = getSocialV2State(key);
    const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
    if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return true; }
    const now = Date.now();
    const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
    const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
    // 额度检查/预占/回滚统一在 src/rate-limit.mjs（原来这里手写 9 份，语义已漂）。
    const quota = checkQuota(st.stickerCollectTimes, { now, need: 1, maxPerMinute, maxPerHour });
    if (!quota.ok) {
      sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
      return true;
    }
    // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
    st.stickerCollectTimes = reserveQuota(st.stickerCollectTimes, 1, now);
    try {
      const result = await collectStickerV2(key, messageRef, remark);
      saveSocialV2State();
      log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
      appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
      sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
    } catch (error) {
      rollbackQuota(st.stickerCollectTimes, 1);
      saveSocialV2State();
      log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const key = String(url.searchParams.get('key') ?? '').trim();
    const query = String(url.searchParams.get('query') ?? '').trim();
    const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
    const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
    // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
    // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
    // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
    const force = false;
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return true; }
    try {
      const synced = await syncStickerLibrary(force);
      const list = formatStickerList(synced?.entries ?? getStickerEntries(), query, count);
      sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? getStickerSyncedAt(), fromCache: synced?.fromCache ?? false });
    } catch (error) {
      sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
    if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const query = String(body.query ?? '').trim();
    const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
    const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
    let force = body.refresh === true;
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return true; }
    // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
    if (req.headers['x-agent-token'] && force) {
      const now = Date.now();
      if (now - lastForcedAgentStickerSync < 10000) force = false;
      else lastForcedAgentStickerSync = now;
    }
    try {
      const synced = await syncStickerLibrary(force);
      const list = formatStickerList(synced?.entries ?? getStickerEntries(), query, count);
      sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? getStickerSyncedAt(), fromCache: synced?.fromCache ?? false });
    } catch (error) {
      sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/stickers') {
    const query = String(url.searchParams.get('query') ?? '').trim();
    const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
    const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
    // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
    try {
      const synced = await syncStickerLibrary(false);
      const list = formatStickerList(synced?.entries ?? getStickerEntries(), query, count);
      sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? getStickerSyncedAt(), fromCache: synced?.fromCache ?? false, writable: getStickerStoreWritable() });
    } catch (error) {
      sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
    try {
      const synced = await syncStickerLibrary(true);
      sendJson({ ok: true, total: synced?.entries?.length ?? getStickerEntries().length, syncedAt: synced?.syncedAt ?? getStickerSyncedAt() });
    } catch (error) {
      sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
    const body = await readBody();
    const stickerId = String(body.stickerId ?? '').trim();
    const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
    const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
    const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
    if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; }
    const entry = applyStickerNoteV2(stickerId, note, tags, usage);
    if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; }
    sendJson({ ok: true, sticker: entry });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
    const body = await readBody();
    const stickerId = String(body.stickerId ?? '').trim();
    if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; }
    try {
      const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
      sendJson({ ok: true, sticker: entry });
    } catch (error) {
      sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  return false;
}
