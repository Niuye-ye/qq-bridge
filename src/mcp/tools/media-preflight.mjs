// 媒体任务运行环境预检 —— 做视频 / 跑代码这类「重活」在派发前先看机器到底能不能干。
//
// 为什么要有它（2026-11-10）：qq_make_video 以前不预检，手机上缺 Pillow / edge-tts 也照样
// spawn 渲染脚本，白跑几分钟、日志里只有一句「渲染那步很可能失败」，她只能反复重试烧 token。
// 现在先在几十毫秒内探一遍，缺什么就直说缺什么，让她换一种表达方式而不是死磕。
//
// 分工：本文件只有「探测 + 拼文案」；进程怎么起（ffmpeg / python 从哪来）由 media-tools.mjs 注入。
// 明确不做：不装依赖、不自动 fallback 到别的渲染器。
//
// 契约：
//   probeVideoEnv({ whichFfmpeg, python, scriptPath, runPython, exists }) -> { ok, missing[], reason }
//   - 任何一处探测「自己出错」都按 ok:true 放行（fail-open），只在**确证缺失**时才拦。
//   - missing 里给的是人能看懂的名字：ffmpeg / python / 渲染脚本 / Pillow / edge-tts。

/** 把 python -c "import ..." 的失败输出解析成模块名列表。 */
export function modulesFromPythonError(stderr) {
  const out = [];
  const re = /No module named '?([A-Za-z0-9_.]+)'?/g;
  let m;
  while ((m = re.exec(String(stderr || '')))) {
    const mod = m[1].split('.')[0];
    if (mod && !out.includes(mod)) out.push(mod);
  }
  return out;
}

const MODULE_LABEL = { PIL: 'Pillow', edge_tts: 'edge-tts', numpy: 'numpy' };

/** 内部名 -> 给人看的名字（她看到的是「Pillow」而不是「PIL」）。 */
export function prettyModule(name) {
  return MODULE_LABEL[name] || name;
}

/**
 * 拼一句她能直接照着说的话。空空如也时返回空串。
 * style：'phone'（手机版缺能力，别再重试）/ 'pc'（本机缺依赖，可以提示主人装）
 */
export function videoUnavailableText(missing, { style = 'pc' } = {}) {
  const list = (missing || []).filter(Boolean);
  if (!list.length) return '';
  const head = `这台${style === 'phone' ? '手机' : '机器'}做不了视频：缺 ${list.join('、')}。`;
  const tail = style === 'phone'
    ? '别硬做、也别反复重试（每次都白跑几分钟）。想表达就用文字或表情，或者跟主人说「手机版还缺' + list[0] + '」。'
    : '别反复重试。可以跟主人说一句缺什么；要画面就先用 qq_draw_image 画一张，或者直接用文字说。';
  return head + tail;
}

/**
 * 探测视频渲染环境。
 * deps：
 *   whichFfmpeg() -> string|null   ffmpeg 可执行（绝对路径或 PATH 里的名字）
 *   python        -> string        python 可执行
 *   scriptPath    -> string        渲染脚本绝对路径
 *   runPython(script) -> { status, stderr }   runPython('import PIL, edge_tts')
 *   exists(p)     -> boolean
 */
export function probeVideoEnv({ whichFfmpeg, python, scriptPath, runPython, exists = (p) => p }) {
  const missing = [];
  let ffmpeg = '';
  try { ffmpeg = whichFfmpeg() || ''; } catch { missing.length = 0; return { ok: true, missing: [], reason: 'probe-failed' }; }
  if (!ffmpeg) missing.push('ffmpeg');

  let scriptOk = false;
  try { scriptOk = !!scriptPath && !!exists(scriptPath); } catch { scriptOk = true; }
  if (!scriptOk) missing.push('渲染脚本');

  let pyOk = false;
  try { pyOk = !!python; } catch { pyOk = true; }
  if (!pyOk) missing.push('python');

  if (ffmpeg && scriptOk && pyOk) {
    // 只探脚本真正 import 的两个第三方包：少了哪个，渲染到一半才炸
    let res;
    try { res = runPython('import PIL, edge_tts'); } catch { return { ok: true, missing: [], reason: 'probe-failed' }; }
    if (res && typeof res.status === 'number' && res.status !== 0) {
      const mods = modulesFromPythonError(res.stderr);
      if (mods.length) { for (const m of mods) missing.push(prettyModule(m)); }
      else missing.push('python 依赖（Pillow / edge-tts）');
    }
  }
  return { ok: missing.length === 0, missing, reason: missing.length ? 'missing' : 'ok' };
}
