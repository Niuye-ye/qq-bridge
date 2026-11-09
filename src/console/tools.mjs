/**
 * 控制台 —— AI 工具域（tools）
 *
 * 职责
 *   搬出 startConsoleServer 里 5 条「AI 自用工具」路由（全部仅 reserved2 模式、要 agent token）：
 *     POST /api/socialV2/now       活动状态：不带 doing/note/plan = 读，带了 = 写（qq_set_activity）
 *     POST /api/socialV2/goals     想干的事 + 生活时间线：add / list / done / drop / life
 *     POST /api/socialV2/facts     长期记忆：add / remove / list（可 query，含遗忘池）
 *     POST /api/socialV2/kill-link 根除链路进程（qq_kill_link）；脚本路径来自 config.localOps.killLink
 *     POST /api/socialV2/llm-key   模型 API Key 自助写入（qq_set_llm_key），一次写两个键名
 *
 * 明确不做
 *   - 不碰发送 / 收件箱 / 历史查询 / 表情包 / 语音（各自有域模块）；
 *   - 不实现记忆与目标存储，只调用注入的 facts / goals-life 函数与 llm-key 助手；
 *   - 不写死任何本机盘符：kill-link 的脚本路径只从 cfg.localOps.killLink 读，缺省回 501。
 *
 * 状态归属
 *   - 活动状态 / goals / life / facts 的持久化都在各自模块（activity、goals-life、memory-facts）；
 *   - 本模块只在 kill-link 时同步 appendFileSync 到 ROOT/logs/local-ops.log 留痕迹；
 *   - 不缓存任何状态，不注册定时器。
 *
 * 接口契约
 *   export async function handleToolsRoutes(ctx) → boolean   // true = 已处理并已回包
 *   - **必须 async**：五条路由都 await readBody，llm-key 还要 await verifyLlmKey。
 *   - 返回 false 表示「不是本域路由」；不得回包后再返回 false。
 *   - 五条路由在桥里原本是连续一段，主函数一行挂载即可保持顺序。
 *   - kill-link 的「先回包再 spawn」时序原样保留（桥自己会被杀，不能等回调）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { defaultCredentialsPath, maskLlmKey, normalizeLlmKey, verifyLlmKey, writeLlmKey } from '../llm-key.mjs';

export async function handleToolsRoutes(ctx) {
  const {
    req, url, sendJson, readBody, log,
    cfg, currentMode, v2ToolEnabled, ROOT, execFileFn, spawnFn,
    readActivityV2, writeActivityV2, formatActivityLineV2,
    addGoalV2, closeGoalV2, readGoalsV2, appendLifeV2, formatGoalsLineV2, readLifeV2,
    addFactV2, removeFactV2, readFactsV2, readForgottenFactsV2, searchFactsV2, formatFactsLineV2
  } = ctx;
  // 子进程实现：桥不传（用 node:child_process 的导入），测试可注入假实现，避免真的起 PowerShell。
  const runExecFile = execFileFn ?? execFile;
  const runSpawn = spawnFn ?? spawn;

  // ── 「我现在在干嘛」：AI 自己记活动状态，定时自醒时能续上 ────────────────
  // 不带 doing/note/plan 就是读；带了就是写（只写传了的字段）。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/now') {
    const body = await readBody();
    const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!token) { sendJson({ ok: false, error: 'reserved2 模式必须携带 agent token' }, 403); return true; }
    const hasWrite = ['doing', 'note', 'plan'].some((k) => body[k] !== undefined);
    if (hasWrite) {
      const next = writeActivityV2({ doing: body.doing, note: body.note, plan: body.plan });
      log(`[activity] 记为「${next.doing || '空'}」`);
      sendJson({ ok: true, activity: next, line: formatActivityLineV2() });
    } else {
      sendJson({ ok: true, activity: readActivityV2(), line: formatActivityLineV2() });
    }
    return true;
  }

  // ── 想干的事（goals）+ 生活时间线（life）─────────────────────────────
  // action: add(text,want) / list / done(id|text) / drop(id|text) / life(text)
  if (req.method === 'POST' && url.pathname === '/api/socialV2/goals') {
    const body = await readBody();
    const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!token) { sendJson({ ok: false, error: 'reserved2 模式必须携带 agent token' }, 403); return true; }
    const action = String(body.action ?? (body.text ? 'add' : 'list')).trim();
    if (action === 'add') {
      const g = addGoalV2(body.text, { want: body.want });
      if (!g) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return true; }
      log(`[goals] 记下想做的事：${g.text}`);
      sendJson({ ok: true, goal: g, open: readGoalsV2().filter((x) => x.status === 'open').length });
      return true;
    }
    if (action === 'done' || action === 'drop') {
      const n = closeGoalV2(body.id ?? body.remove ?? body.text, action === 'done' ? 'done' : 'dropped');
      sendJson({ ok: true, changed: n, open: readGoalsV2().filter((x) => x.status === 'open').length });
      return true;
    }
    if (action === 'life') {
      const e = appendLifeV2(body.text);
      if (!e) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return true; }
      sendJson({ ok: true, entry: e });
      return true;
    }
    sendJson({ ok: true, goals: readGoalsV2(), line: formatGoalsLineV2(), life: readLifeV2().slice(-10) });
    return true;
  }

  // ── 长期记忆（facts）：会淡忘的「记得的事」─────────────────────────────
  // action: add（带 text）/ remove（带 remove 或 id）/ list（可带 query）
  if (req.method === 'POST' && url.pathname === '/api/socialV2/facts') {
    const body = await readBody();
    const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!token) { sendJson({ ok: false, error: 'reserved2 模式必须携带 agent token' }, 403); return true; }
    const action = String(body.action ?? (body.remove !== undefined ? 'remove' : body.text ? 'add' : 'list')).trim();
    if (action === 'add') {
      const entry = addFactV2(body.text, { kind: body.kind, tier: body.tier, expiresAt: body.expiresAt });
      log(`[facts] 记下：${entry.text.slice(0, 40)}（${entry.tier}/${entry.kind}）`);
      sendJson({ ok: true, entry, total: readFactsV2().length });
      return true;
    }
    if (action === 'remove') {
      const res = removeFactV2(body.remove ?? body.id ?? body.text);
      sendJson({ ok: true, ...res, total: readFactsV2().length, forgotten: readForgottenFactsV2().length });
      return true;
    }
    sendJson({
      ok: true,
      facts: searchFactsV2(body.query, body.limit, body.includeForgotten !== false),
      total: readFactsV2().length,
      forgotten: readForgottenFactsV2().length,
      line: formatFactsLineV2(),
    });
    return true;
  }

  // ── 根除链路进程（qq_kill_link）──────────────────────────────────────
  // 桌宠「一键修复 · 启动」的反面：先把整条链路杀干净，再让主人一键启动。
  // 脚本路径来自 config.localOps.killLink（config.json 不入库，可写本机盘符）；
  // 桥代码里不许写死路径，别人部署时留空即可（本接口会返回 501）。
  // 默认不碰 QQ 本体与 MuMu 模拟器 —— 那两个要显式 includeQQ / includeMuMu。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/kill-link') {
    const body = await readBody();
    if (req.headers['x-agent-token'] && !v2ToolEnabled('killLink')) {
      sendJson({ ok: false, error: '工具未启用：qq_kill_link' }, 403);
      return true;
    }
    // 必须规范化成 Windows 反斜杠绝对路径：PowerShell 的 `-File` 不认 "C:/dsh/xxx.ps1"
    // 这种写法（会静默退出、退出码还是 0，看起来像成功却没做任何事）。
    const rawScript = String(cfg.localOps?.killLink ?? '').trim();
    const script = rawScript ? path.resolve(rawScript) : '';
    if (!script || !fs.existsSync(script)) {
      sendJson({ ok: false, error: '未配置 localOps.killLink（config.json），或脚本不存在' }, 501);
      return true;
    }
    // 解释器按脚本后缀选：PC 部署是 .ps1，手机（Android/Termux）是 .sh。
    // 2026-11-09 迁移：原来写死 powershell.exe，手机上直接 spawn ENOENT、干跑回空清单。
    const ext = path.extname(script).toLowerCase();
    const isPs1 = ext === '.ps1';
    const isSh = ext === '.sh';
    const isCmd = ext === '.bat' || ext === '.cmd';
    const runnerOf = (dryRun) => {
      if (isSh) {
        const a = [script];
        if (dryRun) a.push('--dry-run');
        return { bin: 'bash', args: a };
      }
      if (isCmd) {
        const a = ['/c', script];
        if (body.includeQQ === true) a.push('/IncludeQQ');
        if (body.includeMuMu === true) a.push('/IncludeMuMu');
        if (dryRun) a.push('/DryRun');
        return { bin: 'cmd.exe', args: a };
      }
      // 默认 PowerShell（.ps1）；必须 -NoProfile 且 -File 只认已 resolve 的绝对路径。
      const a = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
      if (body.includeQQ === true) a.push('-IncludeQQ');
      if (body.includeMuMu === true) a.push('-IncludeMuMu');
      if (dryRun) a.push('-DryRun');
      return { bin: 'powershell.exe', args: a };
    };
    if (body.dryRun === true) {
      // 干跑：同步跑一次把清单原样回给模型。
      // PowerShell 5.1 默认按控制台代码页（本机 936/GBK）往管道写，Node 按 UTF-8 读会全是乱码，
      // 所以先把 [Console]::OutputEncoding 设成 UTF8 再执行脚本（.sh 本来就是 UTF-8，直接跑）。
      let out;
      if (isPs1) {
        const flags = [];
        if (body.includeQQ === true) flags.push('-IncludeQQ');
        if (body.includeMuMu === true) flags.push('-IncludeMuMu');
        const quoted = script.replace(/'/g, "''");
        const command = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '${quoted}' -DryRun ${flags.join(' ')}`;
        out = await new Promise((resolve) => {
          runExecFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve(`${stdout ?? ''}${stderr ?? ''}${err ? `\n[exit] ${err.message}` : ''}`.trim());
          });
        });
      } else {
        const runner = runnerOf(true);
        out = await new Promise((resolve) => {
          runExecFile(runner.bin, runner.args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve(`${stdout ?? ''}${stderr ?? ''}${err ? `\n[exit] ${err.message}` : ''}`.trim());
          });
        });
      }
      log('[kill-link] 干跑预览（未杀任何进程）');
      sendJson({ ok: true, dryRun: true, output: out });
      return true;
    }
    log(`[kill-link] 根除链路进程（includeQQ=${body.includeQQ === true} includeMuMu=${body.includeMuMu === true}）`);
    sendJson({
      ok: true,
      dispatched: true,
      // 拉起提示按脚本类型分：PC 是 .ps1（桌宠 / 一键启动.ps1），手机是 .sh（boot.sh + guard）。
      note: isSh
        ? '已在后台执行。桥会在 2~3 秒内断线（它自己也要被杀），属正常现象；之后跑 bash ~/boot.sh 拉起来（guard 最多两分钟也会自己补）。'
        : '已在后台执行。桥会在 2~3 秒内断线（它自己也要被杀），属正常现象；之后用「一键修复 · 启动」或 一键启动.ps1 拉起来。'
    });
    // 先回包再动手：这个脚本会把当前桥进程杀掉。
    // 不能等回调（桥一死回调永远不会来）。
    // ⚠️ 绝不能用 { detached: true }：本机实测 detached 起的 powershell.exe 会在 70~140ms 内
    // exit 0、脚本一行都不执行（看着像成功，其实是空转；stdio 换成 pipe / 文件也一样）。
    // 用普通子进程 + stdio:'ignore'，桥被杀时 Windows 不会连带杀子进程（脚本第 [4/5] 步才杀桥）。
    setTimeout(() => {
      // 桥的 stdout 常被重定向到不可写/被锁的文件，log() 靠不住；
      // 派发失败必须留下**同步落盘**的痕迹，否则只会看到「接口说有杀、实际没动」。
      const tracePath = path.join(ROOT, 'logs', 'local-ops.log');
      const trace = (m) => { try { fs.appendFileSync(tracePath, `[${new Date().toISOString()}] ${m}\n`); } catch {} };
      try {
        const runner = runnerOf(false);
        trace(`[kill-link] spawn ${runner.bin} ${JSON.stringify(runner.args)}`);
        const child = runSpawn(runner.bin, runner.args, { stdio: 'ignore', windowsHide: true });
        child.on('error', (err) => trace(`[kill-link] spawn error: ${err?.message ?? err}`));
        child.on('exit', (code, signal) => trace(`[kill-link] exited code=${code} signal=${signal}`));
        child.unref();
      } catch (err) {
        trace(`[kill-link] throw: ${err?.message ?? err}`);
        log(`[kill-link] 派发失败：${err?.message ?? err}`);
      }
    }, 300).unref?.();
    return true;
  }

  // ── 模型 API Key 自助录入（POST /api/socialV2/llm-key）────────────────
  // 起因：主人换上游 key 时要同时改两个名字 —— web profile 读 OPENCODEGO_API_KEY、
  // desktop profile 读 OPENCODE_GO_API_KEY（差一个下划线）。人工改文件很容易只改一个，
  // 然后 QQ 侧报 MISSING_CREDENTIAL 而桌面端一切正常，极难查。这里一次写两个键。
  // 凭据文件路径：config.localOps.credentialsPath（留空 = ~/.dsh/.credentials.yaml）。
  // 安全：只回 maskLlmKey（前 6 后 3），日志同样只记掩码，不落明文 key。
  if (req.method === 'POST' && url.pathname === '/api/socialV2/llm-key') {
    if (req.headers['x-agent-token'] && !v2ToolEnabled('setLlmKey')) {
      sendJson({ ok: false, error: '工具未启用：qq_set_llm_key' }, 403);
      return true;
    }
    const body = await readBody();
    const norm = normalizeLlmKey(body.key);
    if (!norm.ok) {
      sendJson({ ok: false, error: norm.error }, 400);
      return true;
    }
    const configured = String(cfg.localOps?.credentialsPath ?? '').trim();
    const target = configured ? path.resolve(configured) : defaultCredentialsPath();
    let written;
    try {
      written = writeLlmKey(target, norm.key);
    } catch (err) {
      log('[llm-key] 写入凭据失败：' + String(err?.message ?? err));
      sendJson({ ok: false, error: '写入凭据文件失败：' + String(err?.message ?? err) }, 500);
      return true;
    }
    // 顺手验一次：200=可用，401/403=无效，其它（网络/端点变更）=未知。
    // 验证失败**不**回滚 —— key 已经落盘，结论留给调用方判断。
    let verified = 'skipped';
    let status = null;
    if (body.verify !== false) {
      const verdict = await verifyLlmKey(norm.key);
      verified = verdict.verdict;
      status = verdict.status ?? null;
    }
    log('[llm-key] 已写入 ' + maskLlmKey(norm.key) + '（' + written.keys.join(' / ') + '），verify=' + verified);
    sendJson({
      ok: true,
      path: written.path,
      keys: written.keys,
      updated: written.updated,
      added: written.added,
      verified,
      status,
      note: '凭据是每次请求重新读取的（credentials-local watch），通常立即生效；若 QQ 侧仍报 MISSING_CREDENTIAL，重启 dsh web 即可。'
    });
    return true;
  }

  return false;
}
