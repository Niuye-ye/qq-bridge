/**
 * 控制台「DSH 模型与思考强度」域路由（原 bridge.js startConsoleServer 内联代码 4546–4610 行搬出）。
 *
 * 契约（与 console/telemetry.mjs、console/roles.mjs 保持一致）：
 * - 工厂 createDshModelRoutes({ callUnary }) → async handleDshModelRoutes(ctx) → boolean：
 *   true = 已应答，false = 路径不归本域；
 * - 本模块不 import bridge.js（防循环依赖），依赖全部由 ctx 注入；
 * - 行为逐字搬迁：状态码、错误文案、日志文案不变；
 * - 模型目录缓存（inFlight / errorLogged）原本是 bridge.js 的模块级状态，只服务这两个接口，
 *   现在收进工厂闭包（同一份实例语义，且离线测试之间互不污染）；
 * - modelSelectionEpoch 是 bridge.js 的模块级 let，只通过 getter/bump 读写，不缓存副本。
 */

export function createDshModelRoutes({ callUnary }) {
  // 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
  // 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
  let inFlight = null;
  const errorLogged = new Set();       // 同一条失败原因只记一次（控制台每次刷新都会打这个接口）

  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 "api.sessions.modelCatalog is not a function"，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。

  async function fetchModelCatalog() {
    try {
      return await callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return callUnary('session.models', {});
    }
  }

  return async function handleDshModelRoutes(ctx) {
    const {
      req, url, sendJson, readBody, log,
      path, ROOT, cfg, readConfigObject, atomicWriteJson,
      withTimeout, unwrap, normalizeReasoningEffort,
      REASONING_EFFORT_OPTIONS, REASONING_EFFORT_DEFAULT,
      bumpModelSelectionEpoch,
    } = ctx;

    // ── DSH 模型与思考强度 ───────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
      const provider = String(cfg.dsh?.provider || 'deepseek-official');
      const model = String(cfg.dsh?.model || 'deepseek-flash');
      // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
      let options = REASONING_EFFORT_OPTIONS.slice();
      let labels = {};
      let providerDefault = null;
      let catalogSource = 'fallback';
      try {
        if (!inFlight) {
          inFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
            .finally(() => { inFlight = null; });
        }
        const catalog = unwrap(await inFlight, 'session.modelCatalog');
        const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
        const entry = (group?.models ?? []).find((m) => m?.id === model);
        const efforts = entry?.reasoning?.efforts ?? [];
        const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
        if (advertised.length) {
          options = advertised;
          labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
          providerDefault = entry.reasoning.defaultEffort ?? null;
          catalogSource = 'dsh';
        }
      } catch (error) {
        // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
        const reason = String(error?.message ?? error);
        if (!errorLogged.has(reason)) {
          errorLogged.add(reason);
          log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
        }
      }
      sendJson({
        provider,
        model,
        reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
        options,
        labels,
        default: REASONING_EFFORT_DEFAULT,
        providerDefault,
        catalogSource,
        // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
        // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
        globalSideEffect: true,
      });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
      const body = await readBody();
      let effort;
      try { effort = normalizeReasoningEffort(body.reasoningEffort); }
      catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return true; }
      const configFile = path.join(ROOT, 'config.json');
      // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
      const file = readConfigObject(configFile);
      file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
      atomicWriteJson(configFile, file);
      cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
      // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
      bumpModelSelectionEpoch();
      log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
      sendJson({ ok: true, reasoningEffort: effort });
      return true;
    }

    return false;
  };
}
