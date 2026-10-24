# -*- coding: utf-8 -*-
"""给 Coopanion 的 rig 贴图生成配色方案（scheme）。

figure.js 的规则：第一个 scheme 直接从 tex/ + feat/ 取图，其它 scheme 从
schemes/<id>/tex/<name>.png 与 schemes/<id>/feat/<name>.png 取图。
所以我们只要把 tex/ 和 feat/ 复制一份、把蓝色系像素的色相改掉即可。

只改蓝色系（H 196~262, S>=0.13），肤色 / 白围裙 / 腮红 / 嘴 一律保留。
"""
import os
import sys
import numpy as np
from PIL import Image

# 仓库根 = 本脚本所在目录（scripts/）的上一级，不写死盘符。
# 换机器 / 换目录只要保证脚本还在 <repo>/scripts/ 下就能跑；也支持环境变量覆盖。
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WHALE = os.environ.get('PET_WHALE_DIR') or os.path.join(REPO, 'assets', 'pet', 'whale')
SCHEMES_DIR = os.path.join(WHALE, 'schemes')

# id: (目标色相, 饱和度倍率, 明度倍率)
TARGETS = {
    'sakura': (335.0, 1.15, 1.06),   # 樱粉
    'mint':   (162.0, 1.10, 1.06),   # 薄荷青
    'night':  (268.0, 1.05, 0.82),   # 夜紫（压暗）
}

H0, H1, S_MIN = 196.0, 262.0, 0.13
SRC_H, SPREAD = 230.0, 32.0
OFF_DEG = 14.0


def recolor(src_path, dst_path, tgt_h, smul, vmul):
    im = Image.open(src_path).convert('RGBA')
    arr = np.array(im)
    if arr.ndim != 3 or arr.shape[2] != 4:
        return 0
    rgb = np.ascontiguousarray(arr[..., :3])
    alpha = arr[..., 3]
    hsv = np.array(Image.fromarray(rgb, 'RGB').convert('HSV'))
    H = hsv[..., 0].astype(np.float32) * (360.0 / 255.0)
    S = hsv[..., 1].astype(np.float32) / 255.0
    V = hsv[..., 2].astype(np.float32) / 255.0

    mask = (H >= H0) & (H <= H1) & (S >= S_MIN) & (alpha > 0)
    n = int(mask.sum())
    if n == 0:
        out = Image.fromarray(arr, 'RGBA')
        out.save(dst_path)
        return 0

    # 保留原色相内部的层次（相对 230° 偏移多少，按 14/32 缩一缩）
    off = (H - SRC_H) / SPREAD * OFF_DEG
    H2 = np.mod(tgt_h + off, 360.0)
    S2 = np.clip(S * smul, 0.0, 1.0)
    V2 = np.clip(V * vmul, 0.0, 1.0)

    rep = np.stack([H2 * (255.0 / 360.0), S2 * 255.0, V2 * 255.0], axis=-1)
    rep = np.clip(rep, 0, 255).astype(np.uint8)
    rgb2 = np.array(Image.fromarray(rep, 'HSV').convert('RGB'))

    out = arr.copy()
    for c in range(3):
        ch = out[..., c]
        ch[mask] = rgb2[..., c][mask]
    Image.fromarray(out, 'RGBA').save(dst_path)
    return n


def main():
    tex_dir = os.path.join(WHALE, 'tex')
    feat_dir = os.path.join(WHALE, 'feat')
    if not os.path.isdir(tex_dir):
        print('找不到', tex_dir)
        return 1
    texs = sorted(f for f in os.listdir(tex_dir) if f.lower().endswith('.png'))
    feats = sorted(f for f in os.listdir(feat_dir) if f.lower().endswith('.png')) if os.path.isdir(feat_dir) else []
    print('tex %d 张 / feat %d 张' % (len(texs), len(feats)))

    for sid, (th, sm, vm) in TARGETS.items():
        base = os.path.join(SCHEMES_DIR, sid)
        os.makedirs(os.path.join(base, 'tex'), exist_ok=True)
        os.makedirs(os.path.join(base, 'feat'), exist_ok=True)
        px = 0
        for f in texs:
            px += recolor(os.path.join(tex_dir, f), os.path.join(base, 'tex', f), th, sm, vm)
        for f in feats:
            px += recolor(os.path.join(feat_dir, f), os.path.join(base, 'feat', f), th, sm, vm)
        print('%-8s 换色 %8d 像素 -> %s' % (sid, px, base))
    return 0


if __name__ == '__main__':
    sys.exit(main())
