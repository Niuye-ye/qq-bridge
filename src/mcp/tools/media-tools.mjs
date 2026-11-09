// 媒体工具族：视频（qq_make_video / qq_video_status / qq_push_video）、
// 跑代码（qq_run_code / qq_run_status）、生图（qq_draw_image / qq_animate_image）。
//
// 职责：把「本机 ComfyUI 生图」「ffmpeg 渲染视频」「临时 Python 工作目录」「adb 推视频」这些
// 重活包成工具；每个工具自己落盘到 state/ 下并返回绝对路径。
//
// 明确不做：不直接操作 QQ（发送走桥接 /api/send/*）；不管进程守护（mem-saver 只按脚本调度）。
//
// 状态归属：无模块级可变状态；任务目录在 state/video-jobs、state/code-jobs、state/draw。
// 本文件用到的 __dirname 特意指回 src/（原始语义：VIDEO_SCRIPT = <repo>/scripts/make-video.py），
// 不是本文件所在的 src/mcp/tools/。
//
// 接口约定：registerMediaTools(server, ctx) —— 注册期同步调用一次；ctx = { cfg, ROOT }。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { spawnSafe } from '../safe-spawn.mjs';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function registerMediaTools(server, ctx) {
  const { cfg, ROOT } = ctx;
// ── 视频：让她自己挑内容、自己生成 ───────────────────────────────────────────
// 2026-10-27：这里原来又推了一遍 import.meta.url —— 离线测试把这个文件塞进 vm.Script 执行，
// 那里没有 import.meta（直接语法错误，整个安全套件 8 条全灭）。模块顶部已经有 __dirname，复用它。
const MCP_HERE = __dirname;
const VIDEO_SCRIPT = path.join(MCP_HERE, '..', 'scripts', 'make-video.py');
const VIDEO_DIR = path.join(MCP_HERE, '..', 'videos');
const VIDEO_JOBS = path.join(MCP_HERE, '..', 'state', 'video-jobs');

const BRIDGE_CONFIG_PATH = path.join(ROOT, 'config.json');

/** 读桥的本地 config.json（不进 git），读不到返回 {}。 */
function readBridgeConfig() {
  try { return JSON.parse(fs.readFileSync(BRIDGE_CONFIG_PATH, 'utf8')); } catch { return {}; }
}

/** config.json 里的 video 段（ffmpeg / python / adb 的本机路径都放这儿，不写死在代码里）。 */
function videoConfig() {
  const v = readBridgeConfig()?.video;
  return v && typeof v === 'object' ? v : {};
}

/**
 * 请 mumu-butler（:8790）把 MuMu 拉起来（2026-10-26 起 MuMu 按需，闲置自动关机）。
 * 地址走 config.socialV2.image.wakeUrl（默认 http://127.0.0.1:8790/ensure，空串=禁用）。
 * 管家不在 / 超时 / 报错 一律静默放行 —— 后面的 adb 探测照旧，失败信息照旧。
 */
async function wakeMuMu(reason) {
  const ic = readBridgeConfig()?.socialV2?.image ?? {};
  if (ic.wake === false) return { ok: false, skipped: true };
  const url = String(ic.wakeUrl ?? 'http://127.0.0.1:8790/ensure').trim();
  if (!url) return { ok: false, skipped: true };
  const timeoutMs = Number(ic.wakeTimeoutMs) > 0 ? Number(ic.wakeTimeoutMs) : 90000;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    return data && typeof data === 'object' ? data : { ok: false };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function resolveLocal(p) {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(ROOT, p);
  try { return fs.existsSync(abs) ? abs : null; } catch { return null; }
}

function pickPython() {
  const fromEnv = resolveLocal(process.env.PET_PYTHON) || resolveLocal(videoConfig().python);
  if (fromEnv) return fromEnv;
  for (const p of ['D:\\Python\\python.exe', 'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe', '/usr/bin/python3']) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return 'python';
}

/** ffmpeg.exe：环境变量 -> config.json video.ffmpeg -> 桥内 tools -> PATH。渲染脚本自己也有一套同级查找，这里显式传过去更稳。 */
function pickFfmpeg() {
  const fromEnv = resolveLocal(process.env.PET_FFMPEG);
  if (fromEnv) return fromEnv;
  const fromCfg = resolveLocal(videoConfig().ffmpeg);
  if (fromCfg) return fromCfg;
  try {
    for (const cand of fs.readdirSync(path.join(ROOT, 'tools', 'ffmpeg'))) {
      const exe = path.join(ROOT, 'tools', 'ffmpeg', cand, 'bin', 'ffmpeg.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* ignore */ }
  return null;
}

// 读日志尾巴时最多读这么多字节（ffmpeg 的输出几分钟就能到几 MB）。
const TAIL_BYTES = 64 * 1024;

function readTailLines(file, n = 8) {
  // 2026-10-28 审计 D-P3：原来整份 readFileSync 再 split —— video/run 日志是 ffmpeg 输出，
  // 几分钟的片子能到几 MB，而 qq_video_status / qq_run_status 每次都调这个函数。
  // 现在只从文件尾部读 64KB（够 10~15 行还富余），读失败再退回整读。
  let text = '';
  let fromStart = true;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const take = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, size - take);
      text = buf.toString('utf8');
      fromStart = take >= size;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  let lines = text.split(/\r?\n/).filter((l) => l.trim());
  // 不是从文件头读的，第一行可能是被切断的半截（还可能是半个中文字符）。
  if (!fromStart) lines = lines.slice(1);
  return lines.slice(-n);
}

/** 清掉旧视频任务的残留（json/log/pid），只留最近 keep 个。 */
function pruneVideoJobs(keep = 30) {
  try {
    const ids = fs.readdirSync(VIDEO_JOBS)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, m: (() => { try { return fs.statSync(path.join(VIDEO_JOBS, f)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.m - a.m)
      .slice(keep)
      .map((x) => x.f.slice(0, -5));
    for (const id of ids) {
      for (const ext of ['.json', '.log', '.pid']) {
        try { fs.rmSync(path.join(VIDEO_JOBS, id + ext), { force: true }); } catch { /* 删不掉就算了 */ }
      }
    }
  } catch { /* 目录还不存在 */ }
}

server.tool(
  'qq_make_video',
  '自己做一个科普短视频（旁白配音 + 字幕动效，输出 mp4）。传标题和分段，后台开始渲染，一分钟左右的片子要几十秒到几分钟。做完用 qq_video_status 查，拿到路径可以发给主人。选题规矩：一个视频只讲一个具体的小问题，要有能画出来的对比或数字，别做「AI 是什么」这种大而空的题。',
  {
    title: z.string().describe('视频标题（左上角常驻小字）'),
    segments: z.array(
      z.object({
        say: z.string().optional().describe('给配音念的旁白；不填就是纯画面段'),
        show: z.string().optional().describe('画面上的大字；不填就用 say'),
        kind: z.enum(['title', 'text', 'number', 'end', 'image', 'compare', 'quote'])
          .optional().describe('title=开场大标题 text=正文 number=数字放大 image=配图 compare=左右对比 quote=引用 end=结尾'),
        big: z.string().optional().describe('kind=number 时的大数字，例如 0.03'),
        unit: z.string().optional().describe('数字后面的单位，例如 元 / 倍 / 秒'),
        dur: z.number().optional().describe('没有 say 时这一段的秒数，默认 3'),
        src: z.string().optional().describe('kind=image 的图片地址：本地路径或 https 链接'),
        caption: z.string().optional().describe('kind=image 下面的一行说明'),
        quote: z.string().optional().describe('kind=quote 的引文正文'),
        by: z.string().optional().describe('kind=quote 的出处/说话人'),
        left: z.object({ title: z.string().optional(), text: z.string().optional(), src: z.string().optional() })
          .optional().describe('kind=compare 左边一栏'),
        right: z.object({ title: z.string().optional(), text: z.string().optional(), src: z.string().optional() })
          .optional().describe('kind=compare 右边一栏'),
      })
    ).describe('分段，按顺序播'),
    voice: z.string().optional().describe('音色，默认 zh-CN-XiaoxiaoNeural（女声）；男声可用 zh-CN-YunxiNeural'),
    size: z.enum(['720p', '1080p', '1080p-portrait', '720p-portrait'])
      .optional().describe('分辨率，默认 1080p；赶时间用 720p；竖屏用 1080p-portrait（抖音/快手）'),
    bgm: z.boolean().optional().describe('背景乐，默认开（现场合成的氛围垫音，旁白时自动压低）；想要纯人声就传 false'),
  },
  async ({ title, segments, voice, size, bgm }) => {
    try {
      if (!Array.isArray(segments) || segments.length === 0) {
        return { content: [{ type: 'text', text: 'segments 是空的，至少给一段' }], isError: true };
      }
      if (segments.length > 30) {
        return { content: [{ type: 'text', text: `分段太多（${segments.length}），最多 30 段` }], isError: true };
      }
      if (!fs.existsSync(VIDEO_SCRIPT)) {
        return { content: [{ type: 'text', text: `找不到渲染脚本：${VIDEO_SCRIPT}` }], isError: true };
      }
      fs.mkdirSync(VIDEO_JOBS, { recursive: true });
      fs.mkdirSync(VIDEO_DIR, { recursive: true });
      // 2026-10-28 审计 D-P3：state/video-jobs 原来只增不减（json + log，log 还是 ffmpeg 全文），
      // 每做一次视频就多几百 KB 到几 MB，永远没人清。留最近 30 个够翻。
      pruneVideoJobs(30);
      // 做视频比画图重（ffmpeg 多遍编码），2026-10-27 起也走内存守护；
      // 因为子进程是 detached 的，恢复交给 watchPidThenRestore 盯 pid，不用 finally。
      const guard = await startMemGuard(memMinGB('video', 1.5), '做视频');
      const memFreed = guard.freed;

      const id = 'v' + Date.now().toString(36);
      const mode = String(size || '1080p');
      const portrait = mode.includes('portrait');
      const small = mode.includes('720');
      const longSide = small ? 1280 : 1920;
      const shortSide = small ? 720 : 1080;
      const job = {
        title: String(title || '一个视频'),
        voice: voice || 'zh-CN-XiaoxiaoNeural',
        width: portrait ? shortSide : longSide,
        height: portrait ? longSide : shortSide,
        fps: 30,
        bgm: bgm !== false,
        segments,
      };
      const jobPath = path.join(VIDEO_JOBS, `${id}.json`);
      fs.writeFileSync(jobPath, JSON.stringify(job, null, 2), 'utf8');
      const outPath = path.join(VIDEO_DIR, `${id}.mp4`);
      const logPath = path.join(VIDEO_JOBS, `${id}.log`);
      // 2026-10-27 修（审计 P2）：原来父进程 open 出来的 fd 从不 close，每做一个视频泄漏一个句柄，
      // 挂一整天就 EBADF/EMFILE。子进程 spawn 时已经 dup 过去，这里必须立刻关掉自己那份。
      const fd = fs.openSync(logPath, 'a');
      const ffmpeg = pickFfmpeg();
      const childEnv = { ...process.env, PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8' };
      if (ffmpeg) childEnv.PET_FFMPEG = ffmpeg;
      const child = spawnSafe(pickPython(), [VIDEO_SCRIPT, jobPath, '--out', outPath], {
        cwd: path.dirname(VIDEO_SCRIPT),
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        env: childEnv,
      });
      child.unref();
      try { fs.closeSync(fd); } catch (e) { console.error('[video] 关闭日志句柄失败: ' + (e?.message ?? e)); }
      if (memFreed) watchPidThenRestore(child.pid);
      fs.writeFileSync(path.join(VIDEO_JOBS, `${id}.pid`), String(child.pid ?? ''), 'utf8');

      const est = Math.round(segments.length * 9 + 15);
      return {
        content: [{
          type: 'text',
          text: [
            `开始做了：《${job.title}》`,
            `id=${id}，${segments.length} 段，${job.width}x${job.height}，预计 ${est} 秒左右出片。`,
            `文件会出在 videos/${id}.mp4。`,
            ffmpeg ? '' : '⚠️ 没定位到 ffmpeg.exe（config.json 的 video.ffmpeg 没配、PATH 里也没有），渲染那步很可能失败。',
            `过一会儿用 qq_video_status 传 id=${id} 看做好了没（做完了会把路径给你，可以直接发给主人）。`,
          ].join('\n'),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `没能开始：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_video_status',
  '查自己做过的视频：进行中显示渲染进度，做好给文件路径（可以发给主人），失败给报错。不传 id 就列最近几个。',
  { id: z.string().optional().describe('qq_make_video 返回的 id，例如 vk3f9a；留空列最近 5 个') },
  async ({ id }) => {
    try {
      if (!fs.existsSync(VIDEO_JOBS)) {
        return { content: [{ type: 'text', text: '还没做过视频' }] };
      }
      const allIds = fs.readdirSync(VIDEO_JOBS)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .sort((a, b) => {
          try { return fs.statSync(path.join(VIDEO_JOBS, b + '.json')).mtimeMs - fs.statSync(path.join(VIDEO_JOBS, a + '.json')).mtimeMs; }
          catch { return 0; }
        });

      const describeOne = (vid) => {
        const out = path.join(VIDEO_DIR, `${vid}.mp4`);
        const tail = readTailLines(path.join(VIDEO_JOBS, `${vid}.log`), 10);
        const joined = tail.join('\n');
        let hasOut = false;
        let bytes = 0;
        try { bytes = fs.statSync(out).size; hasOut = bytes > 1024; } catch { /* ignore */ }
        const done = hasOut && /完成:/.test(joined);
        const failed = !done && /Traceback|渲染失败|找不到 ffmpeg|没能开始/.test(joined);
        let titleNow = '';
        try { titleNow = JSON.parse(fs.readFileSync(path.join(VIDEO_JOBS, `${vid}.json`), 'utf8')).title || ''; } catch { /* ignore */ }
        return {
          vid,
          title: titleNow,
          done,
          failed,
          out,
          mb: hasOut ? (bytes / 1048576).toFixed(1) : '0',
          last: tail.filter((l) => l.trim()).pop() || '（还没输出）',
        };
      };

      if (!id) {
        const rows = allIds.slice(0, 5).map(describeOne);
        if (!rows.length) return { content: [{ type: 'text', text: '还没做过视频' }] };
        const text = rows.map((r) => {
          const st = r.done ? '✅ 做好了' : r.failed ? '❌ 失败' : '⏳ 进行中';
          return `${st}  ${r.vid}  《${r.title}》${r.done ? `  ${r.mb}MB  ${r.out}` : `  — ${r.last}`}`;
        }).join('\n');
        return { content: [{ type: 'text', text: `最近做的视频：\n${text}\n\n要看详情就传 id。` }] };
      }

      const r = describeOne(String(id).trim());
      if (!fs.existsSync(path.join(VIDEO_JOBS, `${r.vid}.json`))) {
        return { content: [{ type: 'text', text: `没有 id=${r.vid} 这个任务。现有的：${allIds.slice(0, 5).join(', ') || '（无）'}` }], isError: true };
      }
      if (r.done) {
        return { content: [{ type: 'text', text: `✅ 《${r.title}》做好了\n路径：${r.out}\n大小：${r.mb} MB\n想在手机上发就先调 qq_push_video 推到模拟器（相册/文件选择器才翻得到），再跟主人说一声。` }] };
      }
      if (r.failed) {
        return { content: [{ type: 'text', text: `❌ 《${r.title}》失败了\n最后的输出：\n${r.last}\n\n要重做就再调一次 qq_make_video（改改分段）。` }], isError: true };
      }
      return { content: [{ type: 'text', text: `⏳ 《${r.title}》还在做\n进度：${r.last}\n再过半分钟问一次。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 视频推到模拟器：出片以后 B 站上传才翻得到 ─────────────────────────────────
function adbBin() {
  const cands = [process.env.PET_ADB, videoConfig().adb, readBridgeConfig()?.socialV2?.image?.adbPath];
  for (const c of cands) {
    const p = resolveLocal(c);
    if (p) return p;
  }
  return 'adb';
}

function runAdb(adb, args, timeout = 15000) {
  return execFileSync(adb, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

function adbSerials(adb) {
  try {
    return runAdb(adb, ['devices'], 8000)
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => /^(.*)\tdevice$/.test(l))
      .map((l) => l.split(/\s+/)[0]);
  } catch {
    return [];
  }
}

/** MuMu 的 adb 端口会从 16384 漂到 16385，所以先信 adb devices，再按常见的几个端口补 connect。 */
function pickSerial(adb) {
  const preferred = readBridgeConfig()?.socialV2?.image?.serial;
  let list = adbSerials(adb);
  if (preferred && list.includes(preferred)) return preferred;
  if (list.length) return list.find((s) => s.startsWith('127.0.0.1:')) || list[0];
  for (let port = 16384; port <= 16392; port += 1) {
    try { runAdb(adb, ['connect', '127.0.0.1:' + port], 4000); } catch { /* ignore */ }
    list = adbSerials(adb);
    if (list.length) return list[0];
  }
  return null;
}

server.tool(
  'qq_push_video',
  '把做好的视频推进 MuMu 模拟器（/sdcard/Movies/qq/），推完系统相册就会索引到，B 站「上传」能翻到。传 id（qq_make_video / qq_video_status 给的）或 path（桥的 videos 目录里的文件）；都不传就推最新的那个。',
  {
    id: z.string().optional().describe('视频任务 id，例如 vk3f9a'),
    path: z.string().optional().describe('或者给视频文件路径（在桥的 videos 目录里）'),
    name: z.string().optional().describe('手机上显示的文件名，默认沿用原名'),
  },
  async ({ id, path: givenPath, name }) => {
    try {
      let localPath = null;
      if (givenPath) {
        const resolved = resolvePushPath(givenPath);
        if (resolved.error) return { content: [{ type: 'text', text: resolved.error }], isError: true };
        localPath = resolved.path;
      } else if (id) {
        // 2026-10-27 修：id 分支原来直接 path.join，`id: "../../state/xxx"` 能越过 videos 目录；
        // 现在和 path 分支走同一道校验（resolvePushPath 会 realpath 后比前缀）
        const byId = resolvePushPath(path.join(VIDEO_DIR, String(id).trim() + '.mp4'));
        if (byId.error) return { content: [{ type: 'text', text: byId.error }], isError: true };
        localPath = byId.path;
      } else if (fs.existsSync(VIDEO_DIR)) {
        const files = fs.readdirSync(VIDEO_DIR).filter((f) => f.toLowerCase().endsWith('.mp4'));
        if (!files.length) return { content: [{ type: 'text', text: 'videos 目录里还没有 mp4，先用 qq_make_video 做一个。' }], isError: true };
        files.sort((a, b) => fs.statSync(path.join(VIDEO_DIR, b)).mtimeMs - fs.statSync(path.join(VIDEO_DIR, a)).mtimeMs);
        localPath = path.join(VIDEO_DIR, files[0]);
      } else {
        return { content: [{ type: 'text', text: 'videos 目录不存在，先用 qq_make_video 做一个。' }], isError: true };
      }

      if (!fs.existsSync(localPath)) {
        return { content: [{ type: 'text', text: '找不到这个视频文件：' + localPath }], isError: true };
      }
      const sizeMb = (fs.statSync(localPath).size / 1048576).toFixed(1);
      const wake = await wakeMuMu('push-video');
      const adb = adbBin();
      const serial = pickSerial(adb);
      if (!serial) {
        const hint = wake?.ok ? '' : `（按需唤醒未成功：${wake?.error || wake?.skipped ? '管家没应答' : '状态不明'}）`;
        return { content: [{ type: 'text', text: `模拟器没连上（adb devices 是空的）${hint}。再试一次，或者让主人跑一次一键启动。` }], isError: true };
      }

      const remoteDir = '/sdcard/Movies/qq/';
      const remoteName = String(name || path.basename(localPath)).replace(/[^\w.\-]/g, '_').replace(/^_+/, '') || 'video.mp4';
      const remotePath = remoteDir + remoteName;
      runAdb(adb, ['-s', serial, 'shell', 'mkdir', '-p', remoteDir], 15000);
      runAdb(adb, ['-s', serial, 'push', localPath, remotePath], 300000);
      // 让媒体库收录。Android 12 上 MEDIA_SCANNER_SCAN_FILE 这个广播已经不好使了
      // （广播能发出去，但 MediaProvider 不理会，相册里始终看不到），
      // 实测有效的是 content call scan_volume —— 会全盘扫一遍，慢几秒但一定能进 media store。
      let indexed = false;
      try {
        runAdb(adb, ['-s', serial, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', 'file://' + remotePath], 20000);
      } catch { /* ignore */ }
      try {
        const scan = runAdb(adb, ['-s', serial, 'shell', 'content', 'call', '--uri', 'content://media', '--method', 'scan_volume', '--arg', 'external_primary'], 90000);
        indexed = /Result:\s*Bundle/.test(scan || '');
      } catch {
        try { runAdb(adb, ['-s', serial, 'shell', 'content', 'call', '--uri', 'content://media/external/file', '--method', 'scan_file', '--arg', remotePath], 40000); } catch { /* ignore */ }
      }

      return {
        content: [{
          type: 'text',
          text: [
            '✅ 视频已经放进模拟器了',
            '本机：' + localPath + '（' + sizeMb + ' MB）',
            '手机：' + remotePath,
            '设备：' + serial,
            indexed ? '媒体库已收录，相册的「视频」分类里能看到。' : '媒体库扫描没确认成功，文件在手机里，但相册可能还看不到（用文件选择器进 Movies/qq 也行）。',
            'B 站上传时用「本地视频 / 相册」入口，在 电影(Movies) → qq 目录里翻它。',
          ].join('\n'),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: '推送失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 自由执行：她写代码自己画（qq_run_code / qq_run_status）─────────────────
// 她只会调 MCP 工具，没有 shell。想「自己用代码画视频」就需要一个能跑代码的地方：
// 每次调用给她一个专属工作目录（state/code-jobs/<id>/），cwd 就在里面，
// 能 import PIL / numpy / edge-tts，能直接调 ffmpeg（PET_FFMPEG 已设好、也塞进了 PATH）。
const CODE_JOBS = path.join(MCP_HERE, '..', 'state', 'code-jobs');
const CODE_TIMEOUT_DEFAULT = 240;
const CODE_TIMEOUT_MAX = 900;
const CODE_SRC_MAX = 200000;

// 2026-10-28 审计 P1：原来直接 path.join(CODE_JOBS, id)，id 零校验 ——
// qq_run_status 传 id="../../.." 就能把任意目录当任务目录读（还会递归列出文件）。
// 这里改成只认「单段安全名」，并且再用 path.relative 复核一次落在 CODE_JOBS 里面。
function codeJobDir(id) {
  const raw = String(id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return null;
  const dir = path.join(CODE_JOBS, raw);
  const rel = path.relative(CODE_JOBS, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return dir;
}

function readCodeStatus(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')); } catch { return null; }
}

// 2026-10-28 审计 P2：原来是直接 writeFileSync，进程被强杀时会留半截 JSON，
// 之后 readCodeStatus 解析失败返回 null，调用方又当 running，永远不结束。改成 tmp+rename。
function writeCodeStatus(dir, obj) {
  const p = path.join(dir, 'status.json');
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/**
 * 目录里她的产出（跳过 run.log / status.json / main.py），新的在前。
 * 2026-10-28 复审 R7（P3）：writeCodeStatus 的临时文件是固定名 status.json.tmp，进程被强杀在
 * write 与 rename 之间就会留下一个 —— 原来只按文件名跳过三个固定项，于是 .tmp 会出现在
 * qq_run_status 的产出清单里，看起来像「她多产出了一个文件」。这里一并过滤掉临时产物。
 */
function listCodeOutputs(dir, limit = 40) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3 || out.length >= limit) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= limit) return;
      if (depth === 0 && (e.name === 'run.log' || e.name === 'status.json' || e.name === 'main.py')) continue;
      if (/\.tmp$/i.test(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      let bytes = 0;
      let mtime = 0;
      try { const st = fs.statSync(p); bytes = st.size; mtime = st.mtimeMs; } catch { /* ignore */ }
      out.push({ rel: path.relative(dir, p).split(path.sep).join('/'), abs: p, bytes, mtime });
    }
  };
  walk(dir, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 只允许相对路径、不许 .. 逃出去。 */
function safeRelName(name) {
  const s = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s || s.includes('..')) return null;
  const parts = s.split('/').filter(Boolean);
  if (!parts.length) return null;
  return parts.join('/');
}

/**
 * qq_push_video 的路径夹取（2026-10-26）。
 * 以前 `path` 零校验：任意本机文本/密钥文件（config.json 的 token、state\console-token、
 * .credentials.yaml）都能被 push 进模拟器 /sdcard/Movies/qq/，再由相册或文件管理器读出来 ——
 * 等于把 MCP 变成一条任意文件外带通道。只放行我们自己产出的那三个目录。
 */
function pushRoots() {
  return [VIDEO_DIR, path.join(ROOT, 'state', 'code-jobs'), path.join(ROOT, 'state', 'draw')];
}
function resolvePushPath(rawPath) {
  const raw = String(rawPath || '').trim();
  if (!raw) return { error: '路径是空的' };
  const abs = path.resolve(path.isAbsolute(raw) ? raw : path.join(ROOT, raw));
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { error: '文件不存在：' + abs };
  }
  const ok = pushRoots().some((root) => {
    let r = root;
    try { r = fs.realpathSync(root); } catch { /* 目录还没建也算它的前缀 */ }
    const withSep = r.endsWith(path.sep) ? r : r + path.sep;
    return real === r || real.startsWith(withSep);
  });
  if (!ok) return { error: '只允许推 videos、state\\code-jobs、state\\draw 下的文件：' + real };
  if (!/\.(mp4|mov|m4v|mkv|webm|png|jpg|jpeg|gif)$/i.test(real)) {
    return { error: '只允许视频/图片文件：' + path.basename(real) };
  }
  return { path: real };
}

server.tool(
  'qq_run_code',
  '自己写 Python 代码去做东西——画视频、合成图片、做图表、算数据都行，不用只套现成模板。每次调用给你一个专属工作目录（cwd 就是它），能直接 import PIL / numpy / edge-tts，能直接跑 ffmpeg（PET_FFMPEG 已设好，也进了 PATH）。把产出写到当前目录，比如 out.mp4 / out.png。后台执行、不占这一轮，过一会儿用 qq_run_status 查结果和文件清单；mp4 想进手机再调 qq_push_video（传绝对路径）。',
  {
    code: z.string().describe('完整的 Python 源码（单文件，会写进工作目录的 main.py，用 __file__ 定位自己）'),
    files: z.record(z.string(), z.string()).optional().describe('额外的辅助文件：文件名 -> 文本内容（如 data.json、字幕.csv、配色.json），都写在工作目录下'),
    name: z.string().optional().describe('这次任务叫什么（只进日志，方便事后认）'),
    timeoutSec: z.number().optional().describe('最长运行秒数，默认 240，最大 900；超了会被杀掉'),
  },
  async ({ code, files, name, timeoutSec }) => {
    try {
      const src = String(code || '');
      if (!src.trim()) return { content: [{ type: 'text', text: 'code 是空的' }], isError: true };
      if (src.length > CODE_SRC_MAX) return { content: [{ type: 'text', text: '代码太长了（' + src.length + ' 字符，上限 ' + CODE_SRC_MAX + '）' }], isError: true };
      const tmo = Math.max(10, Math.min(CODE_TIMEOUT_MAX, Number(timeoutSec) || CODE_TIMEOUT_DEFAULT));
      fs.mkdirSync(CODE_JOBS, { recursive: true });
      const id = 'r' + Date.now().toString(36);
      const dir = codeJobDir(id);
      if (!dir) return { content: [{ type: 'text', text: '任务目录不合法：' + id }], isError: true };
      fs.mkdirSync(dir, { recursive: true });
      const mainPy = path.join(dir, 'main.py');
      fs.writeFileSync(mainPy, src, 'utf8');
      const badFiles = [];
      if (files && typeof files === 'object') {
        for (const [rawName, content] of Object.entries(files)) {
          const rel = safeRelName(rawName);
          if (!rel) { badFiles.push(rawName); continue; }
          const target = path.join(dir, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, String(content ?? ''), 'utf8');
        }
      }
      const logPath = path.join(dir, 'run.log');
      const fd = fs.openSync(logPath, 'a');
      fs.writeSync(fd, '[task] ' + (name ? String(name) : '(未命名)') + '  起于 ' + new Date().toISOString() + '\r\n');
      const ffmpeg = pickFfmpeg();
      const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PET_JOB_DIR: dir };
      if (ffmpeg) {
        childEnv.PET_FFMPEG = ffmpeg;
        childEnv.PATH = path.dirname(ffmpeg) + path.delimiter + (process.env.PATH || '');
      }
      const child = spawnSafe(pickPython(), ['-u', mainPy], {
        cwd: dir,
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        env: childEnv,
      });
      const startedAt = Date.now();
      // 2026-10-28 审计 P2：父进程这份 fd 立刻关掉（子进程 spawn 时已经 dup 过去）。
      // 原来只在 exit 回调里 closeSync，spawn 抛错或子进程长期不退出就一直占着句柄。
      try { fs.closeSync(fd); } catch { /* ignore */ }
      writeCodeStatus(dir, { id, name: name || '', status: 'running', pid: child.pid ?? 0, startedAt, timeoutSec: tmo, dir });
      // 2026-10-28 审计 P2：timeoutSec 原来只是写进 status、要等她下次 qq_run_status 查询才判，
      // 她不查就永远跑。改成真的挂一个定时器到点就杀。
      const killTimer = setTimeout(() => {
        try {
          const cur = readCodeStatus(dir) || {};
          if (cur.status && cur.status !== 'running') return;
          try { process.kill(Number(child.pid)); } catch { /* ignore */ }
          writeCodeStatus(dir, {
            ...cur, id, name: name || '', status: 'failed', pid: child.pid ?? 0,
            startedAt, timeoutSec: tmo, dir, endedAt: Date.now(),
            note: '超过 ' + tmo + ' 秒还没跑完，已杀掉',
          });
          try { fs.appendFileSync(logPath, '\r\n[task] 超时 ' + tmo + ' 秒，已杀掉\r\n', 'utf8'); } catch { /* ignore */ }
        } catch { /* ignore */ }
      }, tmo * 1000);
      if (killTimer.unref) killTimer.unref();
      child.on('exit', (exitCode, signal) => {
        clearTimeout(killTimer);
        const st = readCodeStatus(dir) || {};
        const ok = exitCode === 0;
        writeCodeStatus(dir, {
          ...st,
          status: ok ? 'done' : 'failed',
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          signal: signal || null,
          endedAt: Date.now(),
          elapsedSec: Math.round((Date.now() - startedAt) / 100) / 10,
        });
        try { fs.appendFileSync(logPath, '\r\n[task] 结束 exit=' + String(exitCode) + (signal ? ' signal=' + signal : '') + '\r\n', 'utf8'); } catch { /* ignore */ }
      });
      child.unref();
      return {
        content: [{
          type: 'text',
          text: [
            '✅ 已经在跑了：' + id + (name ? '（' + name + '）' : ''),
            '工作目录：' + dir,
            '代码就是那个目录里的 main.py，cwd 也在那儿 —— 产出直接写相对路径，例如 out.mp4、frames/x.png。',
            ffmpeg ? 'ffmpeg：' + ffmpeg : '⚠️ 没定位到 ffmpeg.exe（config.json 的 video.ffmpeg 没配、PATH 也没有），要编码视频可能失败。',
            badFiles.length ? '⚠️ 这些辅助文件名不合法（不许绝对路径或 ..）：' + badFiles.join(', ') : '',
            '最长跑 ' + tmo + ' 秒。过一会儿用 qq_run_status 传 id=' + id + ' 看结果、拿文件清单。',
          ].filter(Boolean).join('\n'),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: '没能开始：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_run_status',
  '查 qq_run_code 的进度：还在跑 / 成功 / 失败，附日志尾巴和这个工作目录里所有产出（路径 + 大小）。不传 id 就列最近几个任务。',
  {
    id: z.string().optional().describe('qq_run_code 返回的 id，例如 rk3f9a；留空列最近 5 个'),
  },
  async ({ id }) => {
    try {
      if (!fs.existsSync(CODE_JOBS)) return { content: [{ type: 'text', text: '还没跑过代码任务。' }] };
      if (!id) {
        const dirs = fs.readdirSync(CODE_JOBS, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => ({ id: e.name, mtime: (() => { try { return fs.statSync(path.join(CODE_JOBS, e.name)).mtimeMs; } catch { return 0; } })() }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 5);
        if (!dirs.length) return { content: [{ type: 'text', text: '还没跑过代码任务。' }] };
        return { content: [{ type: 'text', text: '最近的任务：\n' + dirs.map((d) => {
          const dd = codeJobDir(d.id);
          if (!dd) return d.id + '  |  目录名不合法，跳过';
          const st = readCodeStatus(dd) || {};
          const outs = listCodeOutputs(dd, 40);
          return [d.id, (st.name || '(未命名)'), (st.status || '?'), outs.length + ' 个文件'].join('  |  ');
        }).join('\n') }] };
      }
      const dir = codeJobDir(id);
      // 2026-10-28 审计 P1：id 不是单段安全名（例如 "../../.."）一律当非法，别去碰文件系统。
      if (!dir) return { content: [{ type: 'text', text: '任务 id 不合法：' + id + '（只认 qq_run_code 返回的那种，比如 rk3f9a）' }], isError: true };
      if (!fs.existsSync(dir)) return { content: [{ type: 'text', text: '没有这个任务：' + id }], isError: true };
      let st = readCodeStatus(dir) || { id, status: 'running' };
      if (st.status === 'running') {
        if (!pidAlive(st.pid)) {
          st = { ...st, status: 'failed', note: '进程已经不在了（被杀或崩了），看日志尾巴' };
          writeCodeStatus(dir, st);
        } else if (st.startedAt && Date.now() - st.startedAt > (Number(st.timeoutSec) || CODE_TIMEOUT_DEFAULT) * 1000) {
          try { process.kill(Number(st.pid)); } catch { /* ignore */ }
          st = { ...st, status: 'failed', note: '超过 ' + (st.timeoutSec || CODE_TIMEOUT_DEFAULT) + ' 秒还没跑完，已杀掉' };
          writeCodeStatus(dir, st);
        }
      }
      const tail = readTailLines(path.join(dir, 'run.log'), 15);
      const outs = listCodeOutputs(dir, 40);
      const show = outs.slice(0, 12);
      const media = /^(mp4|mov|webm|mkv|png|jpg|jpeg|gif|webp|wav|mp3|flac)$/i;
      const lines = [
        (st.status === 'done' ? '✅ 跑完了' : st.status === 'failed' ? '❌ 失败了' : '⏳ 还在跑') + '：' + id + (st.name ? '（' + st.name + '）' : ''),
        st.startedAt ? ('起于 ' + new Date(st.startedAt).toLocaleTimeString() + (st.elapsedSec ? '，用了 ' + st.elapsedSec + ' 秒' : '')) : '',
        st.note ? ('备注：' + st.note) : '',
        '工作目录：' + dir,
        outs.length ? ('产出 ' + outs.length + ' 个文件：') : '还没有产出文件',
        ...show.map((o) => '  ' + o.rel + '  ' + (o.bytes >= 1048576 ? (o.bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(o.bytes / 1024)) + ' KB') + '\n    ' + o.abs),
        outs.length > show.length ? '  …还有 ' + (outs.length - show.length) + ' 个' : '',
        tail.length ? ('日志尾巴：\n' + tail.join('\n')) : '',
      ].filter(Boolean);
      const mp4 = outs.find((o) => /\.(mp4|mov|webm|mkv)$/i.test(o.rel));
      if (st.status === 'done' && mp4 && media.test(mp4.rel.split('.').pop())) {
        lines.push('想进手机就 qq_push_video 传 path=' + mp4.abs + '（会进 /sdcard/Movies/qq/ 并扫进相册）。');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '查不了：' + (error?.message ?? error) }], isError: true };
    }
  }
);


// ---------- 生图（ComfyUI，2026-10-25） ----------
// 她做视频需要配图，但 ComfyUI 那套节点她既看不见也没法调。这里把"一句提示词 -> 一张 png"
// 包成工具，直接落到 state/draw/<id>/，返回绝对路径，qq_make_video 的 image 段直接引用。

// ---------- 内存守护（画图/做视频前腾内存，完事再恢复链路，2026-10-25） ----------
// 本机 15.6GB 内存，Wan 那次就是内存吃满卡死。脚本在运维项目 bin/mem-saver.ps1：
//   check  -> 读可用物理内存；free -> 关掉 pet-guard/桌宠/MuMu/哔哩哔哩并写清单；restore -> 按清单起回来。
const MEM_TIMEOUT_MS = 120000;

function memSaverScript() {
  try {
    const p = String(readBridgeConfig()?.memory?.saver || "").trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  const alt = [
    path.join(ROOT, "..", "bin", "mem-saver.ps1"),
    "F:/项目/手机上使用dsh/bin/mem-saver.ps1",
    "C:/dsh/bin/mem-saver.ps1",
  ];
  for (const cand of alt) { if (cand && fs.existsSync(cand)) return cand; }
  return "";
}

function runMemSaver(action) {
  const script = memSaverScript();
  if (!script) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action],
      { windowsHide: true, timeout: MEM_TIMEOUT_MS, encoding: "buffer" },
      (err, stdout) => {
        if (err) { console.error("[mem] " + action + " 失败: " + (err.message || err)); resolve(null); return; }
        const s = String(stdout ?? "").trim();
        const i = s.indexOf("{");
        if (i < 0) { resolve(null); return; }
        try { resolve(JSON.parse(s.slice(i))); } catch { resolve(null); }
      }
    );
  });
}

function memRestoreLater() {
  const script = memSaverScript();
  if (!script) return;
  try {
    const child = spawnSafe(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "restore"],
      // 别加 detached：powershell + detached + stdio ignore 会静默退出（见 AGENTS 17.15 实测）
      { windowsHide: true, stdio: "ignore" }
    );
    child.unref();
    console.error("[mem] 生成完成，已派发恢复链路");
  } catch (e) {
    console.error("[mem] 恢复派发失败: " + (e?.message ?? e));
  }
}

// 阈值可按机器调：config.json 的 memory.minFreeDraw / minFreeAnimate（单位 GB）。
function memMinGB(kind, dflt) {
  try {
    const c = readBridgeConfig()?.memory || {};
    // video 没单独配就退回画图那个阈值：两者都是 ffmpeg/ComfyUI 吃内存的活
    const key = kind === 'animate' ? c.minFreeAnimate : kind === 'video' ? (c.minFreeVideo ?? c.minFreeDraw) : c.minFreeDraw;
    const v = Number(key);
    if (Number.isFinite(v) && v > 0) return v;
  } catch {}
  return dflt;
}
// 用前检查；不够就腾。返回的 finish() 在 finally 里调，负责把链路起回来。
async function startMemGuard(minFreeGB, tag) {
  let freed = false;
  try {
    const st = await runMemSaver("check");
    if (st && typeof st.freeGB === "number" && st.freeGB < minFreeGB) {
      console.error("[mem] " + tag + " 前可用 " + st.freeGB + "GB，低于 " + minFreeGB + "GB，先腾内存");
      const r = await runMemSaver("free");
      if (r && r.action === "free") {
        freed = true;
        console.error("[mem] 腾出 " + r.freedGB + "GB（现 " + r.afterGB + "GB）");
      }
    }
  } catch {}
  return {
    freed,
    finish() { if (freed) memRestoreLater(); },
  };
}
// 做视频是 detached 后台跑，拿不到 finish：pid 还在就每 5 秒看一眼，消失后再把链路起回来。
// （最多盯 30 分钟；MCP 进程重启就放弃——那种情况下次 mem-saver restore 也会兜回来）
function watchPidThenRestore(pid) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    if (!alive || Date.now() - startedAt > 30 * 60 * 1000) {
      clearInterval(timer);
      if (alive) console.error('[mem] 视频跑了 30 分钟还没结束，先恢复链路');
      memRestoreLater();
    }
  }, 5000);
  if (timer.unref) timer.unref();
}

const DRAW_ROOT = path.join(ROOT, 'state', 'draw');
const DRAW_TIMEOUT_DEFAULT = 180;
const DRAW_TIMEOUT_MAX = 600;
const DRAW_NEG_DEFAULT = 'blurry, lowres, bad anatomy, watermark, signature, text, jpeg artifacts, extra fingers';

function comfyBase() {
  let u = '';
  try {
    const c = readBridgeConfig()?.comfyui;
    if (c && typeof c.url === 'string') u = c.url.trim();
  } catch { /* ignore */ }
  if (!u) u = process.env.PET_COMFYUI || 'http://127.0.0.1:8188';
  return u.replace(/\/+$/, '');
}

const drawSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DRAW_AUTOSTART_WAIT_MS = 120000;
let comfyStarting = null;

// ComfyUI 不常驻（空载也要占 1GB 内存，这台机器本来就紧），她要用的时候没开就替她拉起来。
function comfyStartBat() {
  try {
    const c = readBridgeConfig()?.comfyui || {};
    let p = typeof c.startBat === 'string' ? c.startBat.trim() : '';
    if (!p && typeof c.dir === 'string' && c.dir.trim()) {
      p = path.join(path.dirname(path.resolve(c.dir.trim())), 'start-comfyui.bat');
    }
    if (!p) return '';
    const abs = path.resolve(p);
    return fs.existsSync(abs) ? abs : '';
  } catch { return ''; }
}

async function comfyEnsureUp() {
  if (comfyStarting) return comfyStarting;
  const bat = comfyStartBat();
  if (!bat) return false;
  // 2026-10-28 审计 D-P3：原来 finally 无条件把 comfyStarting 置 null —— 两个并发调用里
  // 后完成的那次会把「别人的」在途 promise 也当自己的清掉，第三次调用于是又去 spawn 一个
  // start-comfyui.bat（双开 ComfyUI，端口打架）。现在只清自己那份。
  const mine = (async () => {
    try {
      const child = spawnSafe('cmd.exe', ['/c', bat], {
        cwd: path.dirname(bat), detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
    } catch { return false; }
    const t0 = Date.now();
    while (Date.now() - t0 < DRAW_AUTOSTART_WAIT_MS) {
      await drawSleep(3000);
      try {
        const r = await fetch(comfyBase() + '/system_stats');
        if (r.ok) return true;
      } catch { /* 还没起来，接着等 */ }
    }
    return false;
  })();
  comfyStarting = mine;
  try { return await mine; } finally { if (comfyStarting === mine) comfyStarting = null; }
}

async function comfyFetch(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    const up = await comfyEnsureUp();
    try {
      res = await fetch(url, opts);
    } catch (e2) {
      throw new Error('连不上 ComfyUI（' + comfyBase() + '）：' + (e2?.message ?? e2) +
        (up ? '。已经试着拉起来了，等半分钟再画一张。' : '。ComfyUI 没在跑，自动拉起也没成功，喊主人开一下。'));
    }
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

async function comfyJson(url, opts) {
  const { res, buf } = await comfyFetch(url, opts);
  const txt = buf.toString('utf8');
  let j = null;
  try { j = JSON.parse(txt); } catch { /* ignore */ }
  if (!res.ok) {
    const msg = j?.error?.message || j?.error || txt.slice(0, 200) || ('HTTP ' + res.status);
    throw new Error('ComfyUI 说：' + (typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 240)));
  }
  return j;
}

async function comfyPickCheckpoint(want) {
  const info = await comfyJson(comfyBase() + '/object_info/CheckpointLoaderSimple');
  const raw = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name;
  const list = Array.isArray(raw) ? raw[0] : (Array.isArray(raw?.options) ? raw.options : []);
  const names = (list || []).filter((x) => typeof x === 'string' && x);
  if (!names.length) throw new Error('ComfyUI 的 models/checkpoints 是空的，先往里放一个 checkpoint。');
  if (want && names.includes(want)) return want;
  try {
    const ck = readBridgeConfig()?.comfyui?.checkpoint;
    if (ck && names.includes(ck)) return ck;
  } catch { /* ignore */ }
  return names.find((n) => /xl/i.test(n)) || names[0];
}

function roundTo64(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(1536, Math.max(384, Math.round(v / 64) * 64));
}

function buildSdxlWorkflow(o) {
  const wf = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.ckpt } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: o.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: o.negative, clip: ['4', 1] } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: o.width, height: o.height, batch_size: o.count } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: o.seed, steps: o.steps, cfg: o.cfg,
        sampler_name: o.sampler, scheduler: o.scheduler, denoise: 1,
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: o.prefix, images: ['8', 0] } },
  };
  return wf;
}

function buildZImageWorkflow(o) {
  // Z-Image Turbo：Qwen3-4B 文本编码 + ae VAE + 8 步 cfg1（蒸馏模型，步数别乱加）
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: o.unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: o.clip, type: 'qwen_image' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: o.vae } },
    '4': { class_type: 'TextEncodeZImageOmni', inputs: { clip: ['2', 0], prompt: o.prompt, auto_resize_images: true } },
    '5': { class_type: 'TextEncodeZImageOmni', inputs: { clip: ['2', 0], prompt: o.negative, auto_resize_images: true } },
    '6': { class_type: 'EmptySD3LatentImage', inputs: { width: o.width, height: o.height, batch_size: o.count } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], seed: o.seed, steps: o.steps, cfg: o.cfg,
        sampler_name: 'euler', scheduler: 'simple',
        positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], denoise: 1,
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: o.prefix, images: ['8', 0] } },
  };
}

const ZIMAGE_DEFAULTS = {
  unet: 'z_image_turbo_bf16.safetensors',
  clip: 'qwen_3_4b.safetensors',
  vae: 'ae.safetensors',
};

async function comfySubmit(workflow) {
  const j = await comfyJson(comfyBase() + '/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!j?.prompt_id) throw new Error('ComfyUI 没给 prompt_id：' + JSON.stringify(j).slice(0, 200));
  return j.prompt_id;
}

async function comfyWaitDone(promptId, timeoutSec) {
  const started = Date.now();
  while (Date.now() - started < timeoutSec * 1000) {
    await drawSleep(1500);
    const h = await comfyJson(comfyBase() + '/history/' + promptId);
    const entry = h?.[promptId];
    if (!entry) continue;
    const st = entry.status || {};
    if (st.status_str === 'error') {
      const msgs = JSON.stringify(st.messages ?? '').slice(0, 400);
      throw new Error('ComfyUI 执行失败：' + msgs);
    }
    if (st.completed || entry.outputs) return entry;
  }
  throw new Error('等了 ' + timeoutSec + ' 秒还没出图。可能显存/内存吃紧在换页，试试把尺寸降到 768 或步数降到 20。');
}

async function comfyCollectImages(entry) {
  const files = [];
  for (const nodeOut of Object.values(entry.outputs || {})) {
    for (const img of nodeOut?.images || []) {
      if (!img?.filename) continue;
      files.push({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
    }
  }
  return files;
}

async function comfyDownload(img) {
  const qs = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
  const { res, buf } = await comfyFetch(comfyBase() + '/view?' + qs.toString());
  if (!res.ok) throw new Error('取图失败 HTTP ' + res.status);
  return buf;
}

server.tool(
  'qq_draw_image',
  '用本机 ComfyUI 画图（一句提示词 -> png）。做视频要配图、封面、插图时用它，产出落在 state/draw/<id>/ 下并返回绝对路径，可以直接填进 qq_make_video 的 image 段 src，或用 qq_send_image path=<绝对路径> 发到 QQ。默认模型 Z-Image Turbo：8 步，1024x1024 约 20~40 秒一张，插画/角色/场景都画得干净，写中文主体也认得。本机现在只有 Z-Image 这一个生图模型（SDXL 与 Wan 视频模型已于 2026-10-25 卸载腾空间）。',
  {
    prompt: z.string().describe('想要什么画面。写具体：主体 + 场景 + 风格 + 光线，例如 a cute cartoon whale mascot girl sitting on a desk at night, cozy room, soft rim light, illustration, clean lines'),
    model: z.enum(['zimage']).optional().describe('画图模型，目前只有 zimage（Z-Image Turbo，8 步、更懂提示词）'),
    negative: z.string().optional().describe('不想要的东西，默认已经排掉糊图/水印/文字/畸形手'),
    width: z.number().optional().describe('宽，默认 1024，会按 64 对齐，范围 384~1536'),
    height: z.number().optional().describe('高，默认 1024'),
    steps: z.number().optional().describe('采样步数，默认 8。Z-Image 是蒸馏模型，加到 12 以上基本没用'),
    cfg: z.number().optional().describe('提示词强度，默认 1。Z-Image 固定 1 附近，别调高'),
    seed: z.number().optional().describe('种子；不填随机。想微调同一张就带上上一次的 seed 再改提示词'),
    count: z.number().optional().describe('一次画几张，1~4，默认 1'),
    checkpoint: z.string().optional().describe('（已废弃，SDXL 模型已卸载，传了也不生效）'),
    sampler: z.string().optional().describe('采样器，默认 dpmpp_2m（zimage 固定用 euler）'),
    scheduler: z.string().optional().describe('调度器，默认 karras（zimage 固定用 simple）'),
    timeoutSec: z.number().optional().describe('最多等多少秒，默认 180，上限 600'),
  },
  async ({ prompt, model, negative, width, height, steps, cfg, seed, count, checkpoint, sampler, scheduler, timeoutSec }) => {
    // 2026-11-09：手机版（Android）没有 ComfyUI，也跑不动扩散模型。别让她以为"喊主人开一下"就能画。
    const cc = (() => { try { return readBridgeConfig()?.comfyui || {}; } catch { return {}; } })();
    if (!String(cc.url || '').trim() && !String(cc.dir || '').trim() && !String(cc.zimage?.dir || '').trim()) {
      return { content: [{ type: 'text', text: '这台机器没配 ComfyUI，画不了图（手机版没有生图能力）。要画面就用 qq_make_video 的 image 段，或者别自己做图，直接跟主人说。' }], isError: true };
    }
    const guard = await startMemGuard(memMinGB('draw', 1.0), '画图');
    try {
      const text = String(prompt ?? '').trim();
      if (!text) return { content: [{ type: 'text', text: '得给个 prompt，不然不知道画什么。' }], isError: true };
      const isZ = String(model ?? '').trim().toLowerCase() !== 'sdxl';
      const t0 = Date.now();
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const dir = path.join(DRAW_ROOT, id);
      fs.mkdirSync(dir, { recursive: true });
      const wait = Math.min(DRAW_TIMEOUT_MAX, Math.max(20, Number(timeoutSec) || DRAW_TIMEOUT_DEFAULT));
      const stNum = Math.round(Number(steps));
      const cfNum = Number(cfg);
      const o = {
        prompt: text,
        negative: String(negative ?? '').trim() || DRAW_NEG_DEFAULT,
        width: roundTo64(width, 1024),
        height: roundTo64(height, 1024),
        steps: isZ
          ? Math.min(20, Math.max(4, Number.isFinite(stNum) && stNum > 0 ? stNum : 8))
          : Math.min(60, Math.max(4, Number.isFinite(stNum) && stNum > 0 ? stNum : 25)),
        cfg: isZ
          ? Math.min(4, Math.max(1, Number.isFinite(cfNum) && cfNum > 0 ? cfNum : 1))
          : Math.min(20, Math.max(1, Number.isFinite(cfNum) && cfNum > 0 ? cfNum : 7)),
        seed: Number.isFinite(Number(seed)) && Number(seed) > 0 ? Math.floor(Number(seed)) : Math.floor(Math.random() * 1e12),
        count: Math.min(4, Math.max(1, Math.round(Number(count) || 1))),
        sampler: String(sampler ?? '').trim() || 'dpmpp_2m',
        scheduler: String(scheduler ?? '').trim() || 'karras',
        prefix: 'draw_' + id,
      };
      let wf;
      let modelName;
      if (isZ) {
        const cfgZ = (() => {
          try { return readBridgeConfig()?.comfyui?.zimage || {}; } catch { return {}; }
        })();
        o.unet = String(cfgZ.unet || '').trim() || ZIMAGE_DEFAULTS.unet;
        o.clip = String(cfgZ.clip || '').trim() || ZIMAGE_DEFAULTS.clip;
        o.vae = String(cfgZ.vae || '').trim() || ZIMAGE_DEFAULTS.vae;
        wf = buildZImageWorkflow(o);
        modelName = 'Z-Image Turbo（' + o.unet + '）';
      } else {
        o.ckpt = await comfyPickCheckpoint(checkpoint);
        wf = buildSdxlWorkflow(o);
        modelName = 'SDXL（' + o.ckpt + '）';
      }
      const promptId = await comfySubmit(wf);
      const entry = await comfyWaitDone(promptId, wait);
      const files = await comfyCollectImages(entry);
      if (!files.length) throw new Error('跑完了但没拿到图（workflow 里没有输出节点？）');
      const saved = [];
      for (const f of files) {
        const buf = await comfyDownload(f);
        const name = path.basename(f.filename) || (id + '.png');
        const abs = path.join(dir, name);
        fs.writeFileSync(abs, buf);
        saved.push({ abs, bytes: buf.length });
      }
      const secs = Math.round((Date.now() - t0) / 1000);
      const lines = [
        '画好了：' + saved.length + ' 张，' + o.width + 'x' + o.height + '，' + o.steps + ' 步，用了 ' + secs + ' 秒。',
        '模型 ' + modelName + '，seed ' + o.seed + '（想在同一张上微调就用这个 seed）。',
        '目录 ' + dir,
        ...saved.map((s) => '  ' + s.abs),
        '',
        '怎么用：',
        '- 视频配图：qq_make_video 的 segments 里写 { kind:"image", src:"<上面那个绝对路径>", caption:"说明" }',
        '- 想做片子：把它填进 qq_make_video 的 image 段，成片会自动缓慢推近、淡入，比硬让它动起来干净',
        '- 发到 QQ 看效果：qq_send_image path=<上面那个绝对路径>',
        '- 不满意就改 prompt 再画一张（Z-Image 一张 20~40 秒，别一次画太多）',
      ];
      return { content: [{ type: 'text', text: lines.join(String.fromCharCode(10)) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '画不出来：' + (error?.message ?? error) }], isError: true };
    } finally {
      guard.finish();
    }
  }
);

// ---------- 图生视频（2026-10-26 瘦身：模型已卸载，只留一个回执桩） ----------
// 2026-10-25 主人删掉 Wan2.2 三件套腾空间，只留 Z-Image 生图。原来这里的 170 行
// （workflow 组装 / 上传起始图 / 轮询 / 下载）永远不会被执行，但那段超长 schema 每轮都会
// 随工具清单发给模型 —— 白烧 token。这里只留工具名（她的提示词里还写着它）+ 一句可操作的回执。
server.tool(
  'qq_animate_image',
  '（当前不可用）本机已卸载图生视频模型；调用只会收到替代方案：用 qq_make_video 的 image 段做动态画面。',
  {
    image: z.string().optional().describe('起始图绝对路径（本机没装模型，此参数现在不起作用）'),
    prompt: z.string().optional().describe('动作描述（本机没装模型，此参数现在不起作用）'),
  },
  async () => ({
    content: [{
      type: 'text',
      text: '本机没装图生视频模型（Wan2.2 三件套 2026-10-25 已删，只留 Z-Image 生图），这条跑不了。要做动态画面：① 用 qq_make_video 的 { kind:"image", src:"<绝对路径>" } 段，静态图会自动缓慢推近 + 淡入，做成片比微动视频干净；② 用 qq_draw_image 多画几张同风格图，再用 image 段串起来。',
    }],
    isError: true,
  })
);
}
