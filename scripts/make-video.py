#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小鲸鱼的视频渲染器 —— 脚本 JSON -> 带配音和字幕的 mp4。

用法:
    python make-video.py job.json
    python make-video.py job.json --out F:/xx/yy.mp4
    python make-video.py --sample          # 生成一个示例 job.json 打印出来

job.json:
{
  "title":  "为什么大模型按 token 收费",
  "voice":  "zh-CN-XiaoxiaoNeural",
  "width":  1920, "height": 1080, "fps": 30,
  "segments": [
    {"say": "旁白文字（给 TTS 念）", "show": "画面文字（可省，默认同 say）", "kind": "title"},
    {"say": "...", "kind": "text"},
    {"say": "一个字幕", "kind": "number", "big": "0.03", "unit": "元"},
    {"say": "", "show": "小鲸鱼：下期见", "dur": 2.5, "kind": "end"}
  ]
}

kind: title(大标题开场) / text(正文) / number(数字强调) / end(结尾)
say 为空时用 dur 当段时长（纯画面段）。

依赖: edge-tts, Pillow；ffmpeg 用 PET_FFMPEG 环境变量、PATH、或本机 tools 目录里的。
"""

import os
import sys
import json
import shutil
import asyncio
import subprocess
import tempfile
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

from PIL import Image, ImageDraw, ImageFont, ImageChops  # noqa: E402

W_DEFAULT, H_DEFAULT, FPS_DEFAULT = 1920, 1080, 30
FONT_PATHS = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]

# 配色（跟桌宠一套）
C_BG_TOP = (13, 20, 36)
C_BG_BOT = (7, 11, 22)
C_ACCENT = (34, 211, 238)      # 青
C_ACCENT2 = (59, 130, 246)     # 蓝
C_TEXT = (241, 245, 249)
C_DIM = (148, 163, 184)


# ── 小工具 ────────────────────────────────────────────────────────────────────

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _local_config():
    """读桥根目录的 config.json（本地配置，不进 git）。读不到就当空字典。"""
    for name in ("config.json", "config.example.json"):
        p = Path(__file__).resolve().parent.parent / name
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
    return {}


def _search_tools_dir(base):
    """在 base/tools 下找 ffmpeg.exe（含 tools/ffmpeg-path.txt 指路）。"""
    if not base:
        return None
    base = Path(base)
    hit = base / "tools" / "ffmpeg-path.txt"
    if hit.exists():
        try:
            p = hit.read_text(encoding="utf-8").strip()
            if p and Path(p).exists():
                return p
        except Exception:
            pass
    for cand in base.glob("tools/ffmpeg/**/ffmpeg.exe"):
        return str(cand)
    return None


def find_ffmpeg():
    """找 ffmpeg.exe，顺序：
       环境变量 PET_FFMPEG -> PATH -> config.json 的 video.ffmpeg
       -> 脚本上级目录的 tools（桥自带） -> PET_PROJECT_DIR / DSH_PROJECT_DIR 下的 tools
       -> 常见安装位置。
    仓库分家后 ffmpeg 常驻在运维项目目录里，所以不能只往脚本自身上级找。
    """
    env = os.environ.get("PET_FFMPEG")
    if env and Path(env).exists():
        return env
    for name in ("ffmpeg", "ffmpeg.exe"):
        p = shutil.which(name)
        if p:
            return p

    cfg = _local_config()
    video = cfg.get("video") if isinstance(cfg.get("video"), dict) else {}
    for key in ("ffmpeg", "ffmpegPath"):
        p = video.get(key)
        if p:
            p = Path(p)
            if not p.is_absolute():
                p = Path(__file__).resolve().parent.parent / p
            if p.exists():
                return str(p)

    here = Path(__file__).resolve().parent
    dirs = [here.parent, here.parent.parent]
    for key in ("PET_PROJECT_DIR", "DSH_PROJECT_DIR", "PET_HOME"):
        d = os.environ.get(key)
        if d:
            dirs.append(Path(d))
            dirs.append(Path(d).parent)
    for base in dirs:
        hit = _search_tools_dir(base)
        if hit:
            return hit

    for cand in (r"C:\ffmpeg\bin\ffmpeg.exe", r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"):
        if Path(cand).exists():
            return cand
    raise SystemExit("找不到 ffmpeg.exe：设环境变量 PET_FFMPEG 指向它，或写进 config.json 的 video.ffmpeg")


def load_font(size, bold=False):
    order = FONT_PATHS if bold else FONT_PATHS[1:] + FONT_PATHS[:1]
    for p in order:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def probe_duration(ffprobe, path):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="ignore",
    )
    try:
        return float((out.stdout or "0").strip())
    except Exception:
        return 0.0


# ── 文字排版 ──────────────────────────────────────────────────────────────────

def wrap_text(draw, text, font, max_w):
    """按像素宽度折行，中英混排都吃。"""
    lines = []
    for para in str(text).split("\n"):
        if not para:
            lines.append("")
            continue
        cur = ""
        for ch in para:
            trial = cur + ch
            if draw.textlength(trial, font=font) <= max_w or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = ch
        lines.append(cur)
    return lines


# ── 渲染器 ────────────────────────────────────────────────────────────────────

class Renderer:
    def __init__(self, job, ffmpeg, ffprobe, workdir):
        self.job = job
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.work = workdir
        self.W = int(job.get("width") or W_DEFAULT)
        self.H = int(job.get("height") or H_DEFAULT)
        self.fps = int(job.get("fps") or FPS_DEFAULT)
        self.segments = job.get("segments") or []
        if not self.segments:
            raise SystemExit("job.json 里没有 segments")

        self.f_title = _font(96, True)
        self.f_body = _font(58)
        self.f_body_s = _font(44)
        self.f_big = _font(150, True)
        self.f_meta = _font(30)

        self.background = self._make_background()
        self.timeline = []      # [(start, dur, seg)]

    # ── 背景只画一次 ──
    def _make_background(self):
        img = Image.new("RGB", (self.W, self.H), C_BG_TOP)
        d = ImageDraw.Draw(img)
        for y in range(self.H):
            r = y / max(1, self.H - 1)
            col = tuple(int(C_BG_TOP[i] + (C_BG_BOT[i] - C_BG_TOP[i]) * r) for i in range(3))
            d.line([(0, y), (self.W, y)], fill=col)
        # 细网格
        step = 80
        grid = (255, 255, 255, 8)
        for x in range(0, self.W, step):
            d.line([(x, 0), (x, self.H)], fill=(18, 26, 44))
        for y in range(0, self.H, step):
            d.line([(0, y), (self.W, y)], fill=(18, 26, 44))
        # 左上角光晕
        glow = Image.new("RGB", (self.W, self.H), (0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([-400, -500, 900, 500], fill=(10, 26, 46))
        img = ImageChops.add(img, glow)
        return img

    # ── 一帧 ──
    def frame(self, t):
        img = self.background.copy()
        d = ImageDraw.Draw(img)

        seg, local, seg_dur = self._which(t)
        appear = min(1.0, local / 0.45) if seg else 0.0           # 淡入
        appear = appear * appear * (3 - 2 * appear)               # smoothstep

        if seg:
            kind = seg.get("kind") or "text"
            self._draw_segment(d, img, seg, kind, appear, local, seg_dur)

        # 左上角标题（小字常驻）
        title = self.job.get("title") or ""
        if title:
            d.text((70, 48), title, font=self.f_meta, fill=C_DIM)

        # 右下角水印
        wm = self.job.get("watermark", "小鲸鱼")
        if wm:
            tw = d.textlength(wm, font=self.f_meta)
            d.text((self.W - 70 - tw, self.H - 78), wm, font=self.f_meta, fill=(90, 105, 125))

        # 底部进度条
        total = self.total
        if total > 0:
            p = min(1.0, t / total)
            d.rectangle([0, self.H - 5, self.W, self.H], fill=(18, 26, 44))
            d.rectangle([0, self.H - 5, int(self.W * p), self.H], fill=C_ACCENT2)
        return img

    def _which(self, t):
        for start, dur, seg in self.timeline:
            if t < start + dur:
                return seg, t - start, dur
        if self.timeline:
            start, dur, seg = self.timeline[-1]
            return seg, dur, dur
        return None, 0, 1

    def _draw_segment(self, d, img, seg, kind, appear, local, seg_dur):
        show = str(seg.get("show") or seg.get("say") or "").strip()
        if kind == "title":
            # 居中的大标题 + 强调横线
            f = self.f_title
            lines = wrap_text(d, show, f, int(self.W * 0.78))
            line_h = int(f.size * 1.35)
            total_h = line_h * len(lines)
            y = (self.H - total_h) // 2 - 20
            for ln in lines:
                w = d.textlength(ln, font=f)
                col = _blend(C_TEXT, C_BG_TOP, 1 - appear)
                d.text(((self.W - w) / 2, y), ln, font=f, fill=col)
                y += line_h
            # 横线
            lw = int(self.W * 0.18 * appear)
            if lw > 2:
                cy = y + 26
                d.rectangle([(self.W - lw) // 2, cy, (self.W + lw) // 2, cy + 5], fill=C_ACCENT)
            return

        if kind == "number":
            big = str(seg.get("big") or "")
            unit = str(seg.get("unit") or "")
            if big:
                f = self.f_big
                bw = d.textlength(big, font=f)
                uw = d.textlength(unit, font=self.f_body_s) if unit else 0
                total = bw + uw + (12 if unit else 0)
                x = (self.W - total) / 2
                y = self.H * 0.32
                d.text((x, y), big, font=f, fill=_blend(C_ACCENT, C_BG_TOP, 1 - appear))
                if unit:
                    d.text((x + bw + 12, y + f.size - self.f_body_s.size - 6),
                           unit, font=self.f_body_s, fill=_blend(C_TEXT, C_BG_TOP, 1 - appear))
            if show:
                self._body_text(d, show, top=self.H * 0.60, appear=appear, dim=False)
            return

        if kind == "end":
            f = self.f_title
            lines = wrap_text(d, show, f, int(self.W * 0.8))
            line_h = int(f.size * 1.35)
            y = (self.H - line_h * len(lines)) // 2
            for ln in lines:
                w = d.textlength(ln, font=f)
                d.text(((self.W - w) / 2, y), ln, font=f, fill=_blend(C_ACCENT, C_BG_TOP, 1 - appear))
                y += line_h
            return

        # 默认正文
        self._body_text(d, show, top=self.H * 0.40, appear=appear, dim=False)

    def _body_text(self, d, text, top, appear, dim=False):
        f = self.f_body
        lines = wrap_text(d, text, f, int(self.W * 0.74))
        line_h = int(f.size * 1.5)
        block_h = line_h * len(lines)
        y = top - block_h / 2 + line_h / 2
        base = C_DIM if dim else C_TEXT
        for i, ln in enumerate(lines):
            # 逐行错开一点淡入
            a = max(0.0, min(1.0, appear * 1.6 - i * 0.18))
            a = a * a * (3 - 2 * a)
            w = d.textlength(ln, font=f)
            d.text(((self.W - w) / 2, y), ln, font=f, fill=_blend(base, C_BG_TOP, 1 - a))
            y += line_h


def _font(size, bold=False):
    return load_font(size, bold)


def _blend(fg, bg, k):
    """k=0 用 fg，k=1 全 bg。表现淡入淡出。"""
    k = max(0.0, min(1.0, k))
    return tuple(int(fg[i] * (1 - k) + bg[i] * k) for i in range(3))


# ── 音频 ──────────────────────────────────────────────────────────────────────

async def _tts_one(text, voice, out_path, rate="+0%"):
    import edge_tts
    comm = edge_tts.Communicate(text, voice, rate=rate)
    await comm.save(str(out_path))


def build_audio(job, ffmpeg, ffprobe, workdir):
    """逐段 TTS，拼成一条音频，返回 [(段时长)]。"""
    voice = job.get("voice") or "zh-CN-XiaoxiaoNeural"
    rate = job.get("rate") or "+0%"
    segs = job["segments"]
    durs = []
    parts = []
    gap = float(job.get("gap") or 0.42)

    for i, seg in enumerate(segs):
        say = str(seg.get("say") or "").strip()
        if say:
            mp3 = workdir / f"seg{i:03d}.mp3"
            for attempt in range(3):
                try:
                    asyncio.run(_tts_one(say, voice, mp3, rate))
                    break
                except Exception as e:
                    log(f"  TTS 第{i+1}段失败({attempt+1}/3): {e}")
                    time.sleep(1.5)
            if mp3.exists() and mp3.stat().st_size > 0:
                d = probe_duration(ffprobe, mp3)
                durs.append(d + gap)
                parts.append(str(mp3))
                parts.append(str(workdir / "_gap.mp3"))
                continue
        # 没有配音（或用 dur 指定）
        d = float(seg.get("dur") or 3.0)
        durs.append(d)
        parts.append(str(workdir / f"_sil{i:03d}.mp3"))
        _silence(ffmpeg, workdir / f"_sil{i:03d}.mp3", d)

    # 统一补一个 gap 静音文件
    _silence(ffmpeg, workdir / "_gap.mp3", gap)

    list_file = workdir / "list.txt"
    list_file.write_text(
        "\n".join(f"file '{Path(p).as_posix()}'" for p in parts),
        encoding="utf-8",
    )
    audio = workdir / "audio.m4a"
    r = subprocess.run(
        [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
         "-c:a", "aac", "-b:a", "160k", str(audio)],
        capture_output=True, text=True, encoding="utf-8", errors="ignore",
    )
    if not audio.exists():
        raise SystemExit("音频拼接失败: " + (r.stderr or "")[-800:])
    return durs, audio


def _silence(ffmpeg, out, seconds):
    if Path(out).exists():
        return
    subprocess.run(
        [ffmpeg, "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
         "-t", f"{seconds:.3f}", "-c:a", "libmp3lame", "-q:a", "9", str(out)],
        capture_output=True,
    )


# ── 主流程 ────────────────────────────────────────────────────────────────────

def render(job_path, out_path=None):
    job_path = Path(job_path).resolve()
    job = json.loads(job_path.read_text(encoding="utf-8"))
    ffmpeg = find_ffmpeg()
    ffprobe = str(Path(ffmpeg).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe"))
    log(f"ffmpeg: {ffmpeg}")

    workdir = Path(tempfile.mkdtemp(prefix="petvideo_"))
    log(f"临时目录: {workdir}")

    durs, audio = build_audio(job, ffmpeg, ffprobe, workdir)
    log(f"音频好了，共 {len(durs)} 段，总 {sum(durs):.1f} 秒")

    r = Renderer(job, ffmpeg, ffprobe, workdir)
    t0 = 0.0
    for seg, d in zip(job["segments"], durs):
        r.timeline.append((t0, d, seg))
        t0 += d
    r.total = t0

    if not out_path:
        slug = "".join(c for c in (job.get("title") or "video") if c not in '\\/:*?"<>|')[:40] or "video"
        out_dir = Path(job.get("outDir") or (job_path.parent / "videos"))
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{slug}-{time.strftime('%H%M%S')}.mp4"
    out_path = Path(out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    total_frames = int(r.total * r.fps) + 1
    log(f"开始渲染 {total_frames} 帧 -> {out_path}")

    cmd = [
        ffmpeg, "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{r.W}x{r.H}", "-r", str(r.fps), "-i", "pipe:0",
        "-i", str(audio),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-b:a", "160k",
        "-shortest", "-movflags", "+faststart",
        str(out_path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE)
    t_start = time.time()
    try:
        for i in range(total_frames):
            t = i / r.fps
            img = r.frame(t)
            proc.stdin.write(img.tobytes())
            if i % 60 == 0:
                el = time.time() - t_start
                pct = 100 * i / max(1, total_frames)
                log(f"  {pct:5.1f}%  帧 {i}/{total_frames}  已用 {el:.0f}s")
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        err = proc.stderr.read().decode("utf-8", "ignore")
        proc.wait()

    if not out_path.exists() or out_path.stat().st_size < 1024:
        raise SystemExit("渲染失败:\n" + err[-1500:])

    size_mb = out_path.stat().st_size / 1024 / 1024
    dur = probe_duration(ffprobe, out_path)
    log(f"完成: {out_path}  {size_mb:.1f} MB  {dur:.1f} 秒")
    shutil.rmtree(workdir, ignore_errors=True)
    return str(out_path), dur, size_mb


SAMPLE = {
    "title": "示例：一段 15 秒的片子",
    "voice": "zh-CN-XiaoxiaoNeural",
    "segments": [
        {"say": "先给一个开场的大标题。", "show": "一段话\n讲清一件事", "kind": "title"},
        {"say": "正文用白字慢慢淡进来，一行一行出来。", "show": "正文用白字慢慢淡进来", "kind": "text"},
        {"say": "数字可以单独放大。", "show": "大模型每百万 token 的价钱", "big": "0.03", "unit": "元", "kind": "number"},
        {"say": "", "show": "就这样，下期见", "dur": 2.0, "kind": "end"},
    ],
}


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return
    if args[0] == "--sample":
        print(json.dumps(SAMPLE, ensure_ascii=False, indent=2))
        return
    job = args[0]
    out = None
    if "--out" in args:
        out = args[args.index("--out") + 1]
    path, dur, size = render(job, out)
    print(json.dumps({"ok": True, "path": path, "duration": round(dur, 2),
                      "sizeMb": round(size, 2)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
