// 控制台「诊断」域路由：Token 用量 / 花费 + 工具调用日志。
//
// 从 bridge.js startConsoleServer（原 7180–7231 行）整块搬出，逻辑一字未改。
// 调用方只判断返回值：true = 本模块已应答（含 404 收尾），false = 路径不归本模块。
//
// 契约：
// - 不 import bridge.js（避免循环依赖），所有依赖由 ctx 注入；
// - 不读全局 cfg / socialV2（本域不需要）；
// - 只做「读统计 + 清空日志」这两类动作，不碰会话状态机；
// - ctx 形状：{ req, url, sendJson, log, fs, tokenLedger, priceTable, readToolLog, toolLogFile }

export function handleTelemetryRoutes(ctx) {
  const { req, url, sendJson, log, fs, tokenLedger, priceTable, readToolLog, toolLogFile } = ctx;

  // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
  // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
  // QQ 侧 AI 是放行的（见 bridge.js 的 agentAllowed 白名单），而跨群花费属于管理信息，
  // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
  if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
    if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
      const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
      sendJson(tokenLedger.series({ hours, maxBuckets }));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const detail = tokenLedger.conversation(key, { turnLimit: limit });
      if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return true; }
      sendJson(detail);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
      tokenLedger.reset();
      log('控制台：token 用量账本已重置');
      sendJson({ ok: true });
      return true;
    }
    sendJson({ ok: false, error: 'not found' }, 404);
    return true;
  }

  // ── 工具调用日志 ─────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    sendJson({ ok: true, entries: readToolLog(limit) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
    if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
    try { fs.writeFileSync(toolLogFile, '', 'utf8'); } catch {}
    log('控制台：工具调用日志已清空');
    sendJson({ ok: true });
    return true;
  }

  return false;
}
