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
import re
import sys
import atexit
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

from PIL import Image, ImageDraw, ImageFont, ImageChops, ImageFilter  # noqa: E402

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
        self.f_quote = _font(64)
        self.f_col = _font(52, True)
        self.f_col_s = _font(36)
        self.img_cache = {}

        self.background = self._make_background()
        self.kenburns = job.get("kenburns", True) is not False
        self.motion = job.get("motion", True) is not False
        # Ken Burns 用「放大一圈的背景 + 裁切」实现：每帧只做 crop，零重采样预算
        self.zoom_max = 0.05
        self.bg_big = None
        if self.kenburns:
            zw = int(self.W * (1 + self.zoom_max * 2))
            zh = int(self.H * (1 + self.zoom_max * 2))
            self.bg_big = self.background.resize((zw, zh), Image.BILINEAR)
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
        # 光晕只留在左上角外侧：Ken Burns 推近后不会有一大块蓝弧飘到画面中间
        gd.ellipse([-760, -820, 720, 260], fill=(9, 21, 38))
        img = ImageChops.add(img, glow)
        return img

    # ── 一帧 ──
    def _bg_frame(self, t):
        """背景缓慢推近 + 轻微横移（Ken Burns）。没开或没关系时直接复制。"""
        if not self.bg_big:
            return self.background.copy()
        total = max(0.001, getattr(self, "total", 0) or 0.001)
        p = max(0.0, min(1.0, t / total))
        z = self.zoom_max * (0.30 + 0.70 * p)
        bw, bh = self.bg_big.size
        cw = max(2, int(self.W / (1 + z)))
        ch = max(2, int(self.H / (1 + z)))
        cx = int((bw - cw) / 2 + (p - 0.5) * cw * 0.12)
        cy = int((bh - ch) / 2 + (p - 0.5) * ch * 0.05)
        cx = max(0, min(bw - cw, cx))
        cy = max(0, min(bh - ch, cy))
        return self.bg_big.crop((cx, cy, cx + cw, cy + ch)).resize((self.W, self.H), Image.BILINEAR)

    def frame(self, t):
        img = self._bg_frame(t)
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
            # 章节点：每段起点的位置点一颗小方块
            for start, _dur, _seg in self.timeline[1:]:
                x = int(self.W * min(1.0, start / total))
                d.rectangle([x - 2, self.H - 9, x + 2, self.H - 1], fill=(80, 120, 190))
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
            slide = int((1 - appear) * 36) if self.motion else 0
            y = (self.H - total_h) // 2 - 20 + slide
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
                # 数字从 0 滚到目标值（0.85 秒），除非关闭动效
                shown = _count_up(big, local if self.motion else 9.9)
                bw = d.textlength(shown, font=f)
                uw = d.textlength(unit, font=self.f_body_s) if unit else 0
                total = bw + uw + (12 if unit else 0)
                x = (self.W - total) / 2
                y = self.H * 0.32 + (int((1 - appear) * 24) if self.motion else 0)
                d.text((x, y), shown, font=f, fill=_blend(C_ACCENT, C_BG_TOP, 1 - appear))
                if unit:
                    d.text((x + bw + 12, y + f.size - self.f_body_s.size - 6),
                           unit, font=self.f_body_s, fill=_blend(C_TEXT, C_BG_TOP, 1 - appear))
            if show:
                self._body_text(d, show, top=self.H * 0.60, appear=appear, dim=False,
                                local=local, seg_dur=seg_dur)
            return

        if kind == "image":
            src = seg.get("src") or seg.get("img")
            cap = str(seg.get("caption") or "").strip()
            box_w = int(self.W * 0.78)
            box_h = int(self.H * (0.56 if cap else 0.66))
            cy = self.H * (0.45 if cap else 0.5)
            zoom = 1.0 + 0.035 * min(1.0, local / max(0.6, seg_dur))
            ok = self._paste_image(img, src, box_w, box_h, self.W / 2, cy,
                                   appear, zoom if self.motion else 1.0)
            if cap:
                f = self.f_body_s
                lines = wrap_text(d, cap, f, int(self.W * 0.8))
                y = cy + box_h / 2 + int(self.H * 0.03)
                for ln in lines:
                    w = d.textlength(ln, font=f)
                    d.text(((self.W - w) / 2, y), ln, font=f,
                           fill=_blend(_mix(C_TEXT, C_DIM, 0.35), C_BG_TOP, 1 - appear))
                    y += int(f.size * 1.45)
            if not ok and show:
                # 图取不到就退化成普通正文，别整段空白
                self._body_text(d, show, top=self.H * 0.5, appear=appear,
                                local=local, seg_dur=seg_dur)
            return

        if kind == "compare":
            left = seg.get("left") or {}
            right = seg.get("right") or {}
            if not isinstance(left, dict):
                left = {"text": str(left)}
            if not isinstance(right, dict):
                right = {"text": str(right)}
            portrait = self.H > self.W * 1.1
            gap = int(self.W * 0.07)
            side = int(self.W * 0.05)
            col_w = (self.W - gap - side * 2) // 2
            lx = side + col_w / 2
            rx = side + col_w + gap + col_w / 2
            top = int(self.H * 0.30)
            a_l = _smooth(local / 0.5)
            a_r = _smooth((local - 0.30) / 0.5)
            if show:
                f = self.f_col_s
                w = d.textlength(show, font=f)
                sy = int(self.H * (0.10 if portrait else 0.16))
                d.text(((self.W - w) / 2, sy), show, font=f,
                       fill=_blend(C_DIM, C_BG_TOP, 1 - a_l))
            if portrait:
                # 竖屏两栏并排太挤：改成上下两屏，中间一条横线 + VS 胶囊
                col_w = int(self.W * 0.82)
                self._column(d, img, left, self.W / 2, int(self.H * 0.15),
                             col_w, a_l, C_ACCENT, img_h=0.20)
                self._column(d, img, right, self.W / 2, int(self.H * 0.55),
                             col_w, a_r, C_ACCENT2, img_h=0.20)
                mid = int(self.H * 0.475)
                d.rectangle([int(self.W * 0.14), mid, int(self.W * 0.86), mid + 2],
                            fill=_mix(C_BG_TOP, (52, 70, 96), max(a_l, a_r)))
                vf = _font(34, True)
                vw2 = d.textlength("VS", font=vf)
                d.rounded_rectangle([self.W / 2 - vw2 / 2 - 20, mid - 28,
                                     self.W / 2 + vw2 / 2 + 20, mid + 30],
                                    radius=28, fill=C_BG_TOP)
                d.text((self.W / 2 - vw2 / 2, mid - 24), "VS", font=vf,
                       fill=_blend(_mix(C_TEXT, C_DIM, 0.3), C_BG_TOP, 1 - max(a_l, a_r)))
                return
            self._column(d, img, left, lx, top, col_w, a_l, C_ACCENT)
            self._column(d, img, right, rx, top, col_w, a_r, C_ACCENT2)
            # 中间分隔竖线 + 「VS」
            mid = self.W // 2
            h1, h2 = int(self.H * 0.26), int(self.H * 0.62)
            d.rectangle([mid - 1, h1, mid + 1, h2],
                        fill=_mix(C_BG_TOP, (52, 70, 96), max(a_l, a_r)))
            vf = _font(38, True)
            vw = d.textlength("VS", font=vf)
            d.rounded_rectangle([mid - (vw / 2 + 18), self.H * 0.475 - 4,
                                 mid + (vw / 2 + 18), self.H * 0.475 + 52],
                                radius=28, fill=C_BG_TOP)
            d.text((mid - vw / 2, self.H * 0.48 - 4), "VS", font=vf,
                   fill=_blend(_mix(C_TEXT, C_DIM, 0.3), C_BG_TOP, 1 - max(a_l, a_r)))
            return

        if kind == "quote":
            body = str(seg.get("quote") or show or "").strip()
            by = str(seg.get("by") or seg.get("from") or "").strip()
            f = self.f_quote
            lines = wrap_text(d, body, f, int(self.W * 0.70))
            line_h = int(f.size * 1.55)
            block = line_h * len(lines)
            cy = self.H * (0.43 if by else 0.5)
            y = cy - block / 2
            qf = _font(int(f.size * 1.8), True)
            d.text((self.W * 0.11, y - qf.size * 0.52), "\u201c", font=qf,
                   fill=_blend((40, 74, 104), C_BG_TOP, 1 - appear))
            for i, ln in enumerate(lines):
                a = _smooth(appear * 1.5 - i * 0.15)
                w = d.textlength(ln, font=f)
                d.text(((self.W - w) / 2, y), ln, font=f, fill=_blend(C_TEXT, C_BG_TOP, 1 - a))
                y += line_h
            if by:
                bf = self.f_body_s
                tw = d.textlength("—— " + by, font=bf)
                d.text((self.W * 0.70 - tw, y + int(f.size * 0.4)), "—— " + by,
                       font=bf, fill=_blend(C_ACCENT, C_BG_TOP, 1 - appear))
            return

        if kind == "end":
            f = self.f_title
            lines = wrap_text(d, show, f, int(self.W * 0.8))
            line_h = int(f.size * 1.35)
            y = (self.H - line_h * len(lines)) // 2 + (int((1 - appear) * 30) if self.motion else 0)
            for ln in lines:
                w = d.textlength(ln, font=f)
                d.text(((self.W - w) / 2, y), ln, font=f, fill=_blend(C_ACCENT, C_BG_TOP, 1 - appear))
                y += line_h
            return

        # 默认正文
        self._body_text(d, show, top=self.H * 0.40, appear=appear, dim=False,
                        local=local, seg_dur=seg_dur)

    # ── 图片 / 对比 / 引用 ──
    def _image(self, src):
        if src in self.img_cache:
            return self.img_cache[src]
        p = _resolve_image(src, self.work)
        im = None
        if p:
            try:
                im = Image.open(p).convert("RGB")
            except Exception as e:
                log(f"  图片打不开 {src}: {e}")
        self.img_cache[src] = im
        return im

    def _paste_image(self, img, src, box_w, box_h, cx, cy, appear, zoom=1.0):
        """把图片等比塞进 box，圆角 + 阴影 + 淡入。返回是否画成功。"""
        im = self._image(src)
        if im is None:
            return False
        r = min(box_w / max(1, im.width), box_h / max(1, im.height)) * zoom
        w = max(1, int(im.width * r))
        h = max(1, int(im.height * r))
        im = im.resize((w, h), Image.LANCZOS)
        if appear < 0.999:
            im = Image.blend(Image.new("RGB", (w, h), C_BG_TOP), im, appear)
        rad = max(8, int(min(w, h) * 0.05))
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=rad, fill=255)
        x = int(cx - w / 2)
        y = int(cy - h / 2)
        # 阴影：一圈模糊的深色圆角块
        pad = 60
        sh = Image.new("RGB", (w + pad * 2, h + pad * 2), C_BG_TOP)
        ImageDraw.Draw(sh).rounded_rectangle(
            [pad, pad + 10, pad + w, pad + h + 10], radius=rad, fill=(3, 6, 14))
        sh = sh.filter(ImageFilter.GaussianBlur(18))
        img.paste(sh, (x - pad, y - pad))
        img.paste(im, (x, y), mask)
        return True

    def _column(self, d, img, col, cx, top, box_w, appear, tag_col, img_h=0.42):
        """对比段的一栏：可选图片 + 可选标题/文字。"""
        title = str(col.get("title") or "").strip()
        text = str(col.get("text") or "").strip()
        src = col.get("src") or col.get("img")
        y = top
        if src:
            box_h = int(self.H * img_h)
            self._paste_image(img, src, box_w, box_h, cx, y + box_h / 2, appear)
            y += box_h + int(self.H * 0.03)
        if title:
            f = self.f_col
            w = d.textlength(title, font=f)
            d.text((cx - w / 2, y), title, font=f,
                   fill=_blend(tag_col, C_BG_TOP, 1 - appear))
            y += int(f.size * 1.5)
        if text:
            f = self.f_col_s
            lines = wrap_text(d, text, f, box_w)
            for ln in lines:
                w = d.textlength(ln, font=f)
                d.text((cx - w / 2, y), ln, font=f,
                       fill=_blend(_mix(C_TEXT, C_DIM, 0.25), C_BG_TOP, 1 - appear))
                y += int(f.size * 1.45)

    def _body_text(self, d, text, top, appear, dim=False, local=0.0, seg_dur=1.0):
        f = self.f_body
        lines = wrap_text(d, text, f, int(self.W * 0.74))
        line_h = int(f.size * 1.5)
        block_h = line_h * len(lines)
        slide = int((1 - appear) * 26) if self.motion else 0
        y = top - block_h / 2 + line_h / 2 + slide
        base = C_DIM if dim else C_TEXT
        n = max(1, len(lines))
        # 逐行高亮：把该段时长按行数均分，念到哪行哪行最亮，念过的略暗，没念的暗
        per = max(0.30, (max(0.6, seg_dur) - 0.35) / n)
        active = int((local - 0.28) / per) if local > 0.28 else -1
        if active >= n:
            active = n - 1
        for i, ln in enumerate(lines):
            # 逐行错开一点淡入
            a = max(0.0, min(1.0, appear * 1.6 - i * 0.18))
            a = a * a * (3 - 2 * a)
            if i == active:
                col = base
            elif i < active:
                col = _mix(base, C_DIM, 0.72)
            else:
                col = _mix(base, C_DIM, 0.28)
            w = d.textlength(ln, font=f)
            x = (self.W - w) / 2
            d.text((x, y), ln, font=f, fill=_blend(col, C_BG_TOP, 1 - a))
            if i == active and n > 1:
                d.rectangle([x - 26, y + 8, x - 19, y + f.size + 2], fill=C_ACCENT)
            y += line_h


def _font(size, bold=False):
    return load_font(size, bold)


def _blend(fg, bg, k):
    """k=0 用 fg，k=1 全 bg。表现淡入淡出。"""
    k = max(0.0, min(1.0, k))
    return tuple(int(fg[i] * (1 - k) + bg[i] * k) for i in range(3))


def _mix(a, b, k):
    """k=0 用 a，k=1 用 b。用来在同色系里压暗/提亮。"""
    k = max(0.0, min(1.0, k))
    return tuple(int(a[i] * (1 - k) + b[i] * k) for i in range(3))


def _smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def _count_up(text, t, span=0.85):
    """把 '0.03' / '12.1' / '45%' 里的数字按进度滚出来（easeOutCubic）。"""
    s = str(text)
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    if not m:
        return s
    raw = m.group(0)
    val = float(raw)
    dec = len(raw.split(".")[1]) if "." in raw else 0
    p = max(0.0, min(1.0, t / span)) if span > 0 else 1.0
    p = 1 - (1 - p) ** 3
    shown = f"{val * p:.{dec}f}"
    return s[:m.start()] + shown + s[m.end():]


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


def _resolve_image(src, workdir):
    """src 支持本地绝对/相对路径、file:// 和 http(s) URL。返回本地 Path 或 None。
    URL 会被下载到 workdir 缓存，同一地址只下一次。"""
    s = str(src or "").strip()
    if not s:
        return None
    if s.startswith("file://"):
        s = s[7:]
    p = Path(s)
    if p.exists():
        return p
    if s.startswith("http://") or s.startswith("https://"):
        import hashlib
        import urllib.request
        key = hashlib.md5(s.encode("utf-8")).hexdigest()[:16]
        ext = os.path.splitext(s.split("?")[0])[1].lower() or ".img"
        out = Path(workdir) / ("img_" + key + ext)
        if out.exists() and out.stat().st_size > 512:
            return out
        try:
            req = urllib.request.Request(s, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
            if data and len(data) > 512:
                out.write_bytes(data)
                return out
        except Exception as e:
            log(f"  图片下载失败 {s}: {e}")
        return None
    return None


def build_bgm(ffmpeg, out, seconds):
    """用 lavfi 现场合成一段氛围垫音（A 大三和弦 + 呼吸颤音 + 低通）。
    不依赖任何素材文件，换机器也能跑。返回路径或 None。"""
    out = Path(out)
    if out.exists():
        return str(out)
    dur = max(3.0, float(seconds) + 1.0)
    inputs = []
    for fr in (220.0, 277.18, 329.63):
        inputs += ["-f", "lavfi", "-i", f"sine=frequency={fr}:sample_rate=44100:duration={dur:.2f}"]
    fc = ("[0:a][1:a][2:a]amix=inputs=3:normalize=1,"
          "tremolo=f=0.14:d=0.35,lowpass=f=900,"
          f"afade=t=in:st=0:d=2.0,afade=t=out:st={max(0.0, dur - 3.0):.2f}:d=3.0[bg]")
    r = subprocess.run([ffmpeg, "-y", *inputs, "-filter_complex", fc, "-map", "[bg]",
                        "-c:a", "libmp3lame", "-q:a", "4", str(out)],
                       capture_output=True, text=True, encoding="utf-8", errors="ignore")
    if out.exists() and out.stat().st_size > 512:
        return str(out)
    log("  BGM 合成失败（不影响出片）: " + (r.stderr or "")[-300:])
    return None


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
    # 2026-10-27 修（审计 P2）：原来只在成功路径 rmtree，渲染一失败就在 %TEMP% 里
    # 留一份几百 MB 的 petvideo_*（有人连做几个坏片子能吃掉好几个 G）。
    # 改成注册 atexit：正常结束、异常、SystemExit 都会清；下面那行 rmtree 保留无妨（幂等）。
    atexit.register(shutil.rmtree, workdir, ignore_errors=True)
    log(f"临时目录: {workdir}")

    durs, audio = build_audio(job, ffmpeg, ffprobe, workdir)
    log(f"音频好了，共 {len(durs)} 段，总 {sum(durs):.1f} 秒")

    r = Renderer(job, ffmpeg, ffprobe, workdir)
    t0 = 0.0
    for seg, d in zip(job["segments"], durs):
        r.timeline.append((t0, d, seg))
        t0 += d
    r.total = t0

    # 背景乐：默认开，job 里写 "bgm": false 可关
    bgm = None
    if job.get("bgm", True) is not False:
        bgm = build_bgm(ffmpeg, workdir / "bgm.mp3", r.total)
        log(f"BGM: {'已合成（旁白时压到 0.22）' if bgm else '没有'}")

    if not out_path:
        slug = "".join(c for c in (job.get("title") or "video") if c not in '\\/:*?"<>|')[:40] or "video"
        out_dir = Path(job.get("outDir") or (job_path.parent / "videos"))
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{slug}-{time.strftime('%H%M%S')}.mp4"
    out_path = Path(out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    total_frames = int(r.total * r.fps) + 1
    log(f"开始渲染 {total_frames} 帧 -> {out_path}")

    head = [
        ffmpeg, "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{r.W}x{r.H}", "-r", str(r.fps), "-i", "pipe:0",
        "-i", str(audio),
    ]
    tail = [
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-b:a", "160k",
        "-shortest", "-movflags", "+faststart",
        str(out_path),
    ]
    if bgm:
        cmd = head + [
            "-i", str(bgm),
            "-filter_complex",
            "[1:a]volume=1.0[v];[2:a]volume=0.22[b];"
            "[v][b]amix=inputs=2:duration=first:normalize=0[aout]",
            "-map", "0:v:0", "-map", "[aout]",
        ] + tail
    else:
        cmd = head + tail
    # stderr 必须落文件：ffmpeg 的日志写满 64KB 管道后会让它停读 stdin，
    # 这边再 write 就死锁（2026-10-25 加了 -filter_complex 之后踩到）。
    fflog = workdir / "ffmpeg.log"
    fh = open(fflog, "wb")
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                            stderr=fh)
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
        try:
            fh.close()
        except Exception:
            pass
        err = fflog.read_text(encoding="utf-8", errors="ignore") if fflog.exists() else ""
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
