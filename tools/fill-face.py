#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把侧脸的"扁"补回来：轮廓推出去 + 造型光。

为什么要改像素：桌宠的"模型"就是这 8 张位图，没有骨骼也没有网格。想让侧脸丰润，
能动的只有像素。纯 CSS 做不到 —— 整只放大只是"脸变大"，轮廓上不会有起伏。

**上一版的教训**（值得留着，以后别再犯）：一开始用的是"在脸颊/口鼻中心放一个
圆形权重，把像素往外推"，结果轮廓一个像素都没动。因为径向权重在离圆心 0.9R 的
地方已经衰减到 0.01 量级，而轮廓永远在脸的外缘 —— 也就是权重的边缘。于是只把
皮肤表面揉花了，边还在原处。想动轮廓，权重就必须在**轮廓上等于 1**、往里才衰减：

    对每一行 y，取这一行最右的实体像素 x_edge(y)
    x 在 [x_edge - band, x_edge] 内时，向右推 delta(y) * smoothstep(...)
    delta(y) 由几个控制点插值出来（吻部最大、眉弓最小、眼睛那一行给 0）

这样"推多少"逐行可读、可量（--measure），也才真的会出现在轮廓上。

用法：
    python tools/fill-face.py assets/03.png --measure              # 看轮廓改了多少
    python tools/fill-face.py assets/03.png --debug dbg.png        # 看配方落在哪
    python tools/fill-face.py assets/03.png --preview p.png        # 三联对比图
    python tools/fill-face.py assets/03.png assets/07.png --write
"""
import argparse
import math
import os
import sys

try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    sys.exit('需要 Pillow 与 numpy：pip install pillow numpy')


# ---------------------------------------------------------------- 基础

def _grid(w, h):
    yy, xx = np.mgrid[0:h, 0:w]
    return xx.astype(np.float32) + 0.5, yy.astype(np.float32) + 0.5


def _ellipse_w(xx, yy, c, rx, ry, rot=0.0, p=2.0):
    """椭圆权重：中心 1、边缘 0，边缘处导数也是 0（不会有折线接缝）。"""
    a = math.radians(rot)
    ca, sa = math.cos(a), math.sin(a)
    dx, dy = xx - c[0], yy - c[1]
    u = (dx * ca + dy * sa) / max(1e-6, rx)
    v = (-dx * sa + dy * ca) / max(1e-6, ry)
    return np.clip(1.0 - np.sqrt(u * u + v * v), 0.0, 1.0) ** p


def _remap(premul, sx, sy):
    """双线性采样，输入输出都是预乘 alpha 的 float32（否则边缘会发黑）。"""
    h, w = premul.shape[:2]
    x0 = np.clip(np.floor(sx - 0.5), 0, w - 1).astype(np.int32)
    y0 = np.clip(np.floor(sy - 0.5), 0, h - 1).astype(np.int32)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = np.clip(sx - 0.5 - x0, 0, 1)[..., None]
    fy = np.clip(sy - 0.5 - y0, 0, 1)[..., None]
    out = np.zeros_like(premul)
    for xi, yi, ww in ((x0, y0, (1 - fx) * (1 - fy)), (x1, y0, fx * (1 - fy)),
                       (x0, y1, (1 - fx) * fy), (x1, y1, fx * fy)):
        out += premul[yi, xi] * ww
    return out


def profile(alpha):
    """逐行最右实体像素。侧脸的"轮廓"就是这条线。"""
    solid = alpha > 0.5
    out = np.full(alpha.shape[0], -1, np.float32)
    for y in range(alpha.shape[0]):
        xs = np.where(solid[y])[0]
        if len(xs):
            out[y] = xs.max()
    return out


# ---------------------------------------------------------------- 轮廓推移

def push_shell(premul, alpha, spec, band, anchor, s):
    """把每一行的外缘按 delta(y) 往外推；权重在轮廓上=1，往里 band 处=0。

    spec 是控制点 [(dy, delta), ...]，dy/delta 都以"脸长 s"为单位、相对眼球 E。
    控点之间用余弦插值（两端导数为 0，位移曲线不会有尖角）。
    """
    h, w = alpha.shape
    E = anchor
    prof = profile(alpha)
    xx, yy = _grid(w, h)

    dyf = (yy[:, 0] - E[1]) / s
    ctrl = sorted(spec, key=lambda t: t[0])
    delta = np.zeros(h, np.float32)
    for i in range(len(ctrl) - 1):
        y0, d0 = ctrl[i]
        y1, d1 = ctrl[i + 1]
        m = (dyf >= y0) & (dyf < y1)
        if not m.any():
            continue
        t = (dyf[m] - y0) / max(1e-6, y1 - y0)
        delta[m] = d0 + (d1 - d0) * (0.5 - 0.5 * np.cos(np.pi * t))
    delta = delta * s

    b = max(4.0, band * s)
    edge = np.maximum(prof, 0)
    # smoothstep：轮廓上严格等于 1，往里 b 像素降到 0
    t = np.clip((xx - (edge[:, None] - b)) / b, 0, 1)
    wt = t * t * (3.0 - 2.0 * t)
    wt[prof < 0] = 0.0

    sx = xx - delta[:, None] * wt
    return _remap(premul, sx, yy)


# ---------------------------------------------------------------- 明暗

def shade(rgb, alpha, blobs):
    """shadow 用乘法、highlight 用 screen。

    不用 overlay / soft-light：那两种会把色相拧走，暖棕色的毛发一变就发灰。
    乘法只会更暗、screen 只会更亮，色相保住，叠几层也不会脏。
    """
    out = rgb.copy()
    h, w = alpha.shape
    xx, yy = _grid(w, h)
    for b in blobs:
        wt = _ellipse_w(xx, yy, b['c'], b['rx'], b['ry'], b.get('rot', 0.0), b.get('p', 2.0))
        a = (wt * b['strength'] * alpha)[..., None]
        col = np.array(b['color'], dtype=np.float32)
        if b['mode'] == 'shadow':
            out = out * (1.0 - a) + (out * col / 255.0) * a
        else:
            out = out * (1.0 - a) + (255.0 - (255.0 - out) * (255.0 - col) / 255.0) * a
    return np.clip(out, 0, 255)


# ---------------------------------------------------------------- 配方
#
# 坐标系：E = 眼球高光（自动量），s = |吻部尖 - E| ≈ 54px（这张脸的"脸长"）。
# 所有位置写成相对 E 的偏移、单位 s；x 正方向 = 脸朝的方向（本素材向右）。
#
# **轮廓推移**（PROFILE）：dy 是相对 E 的纵向位置，d 是这一行外缘要推出去多少。
# 读法：眉弓 +0.02 基本不动（眉骨靠阴影立）；眼睛那一行也只能 +0.02 —— 远眼就
# 贴在轮廓边上，推多了会把远眼挤歪；眼下面颊 +0.10，吻部峰值 +0.17（≈9px）。
PROFILE = [
    (-0.80, 0.018),   # 眉弓
    (-0.35, 0.008),   # 眼睛那一行：远眼贴在轮廓边上，这里必须近乎不动
    (0.10, 0.040),    # 颧骨上缘：开始往外鼓
    (0.35, 0.080),    # 脸颊：这一段的轮廓外扩就是"腮帮子鼓起来"
    (0.62, 0.165),    # 吻部峰值
    (0.90, 0.090),    # 上唇
    (1.15, 0.030),    # 下巴
    (1.45, 0.000),    # 下颌收住
]
BAND = 1.05           # 推移的羽化宽度（单位 s）：越大越柔，纹理压缩也越小
SHARPEN = 70          # 形变后补的锐化强度（unsharp percent），0 = 不锐化

# 明暗：c/rx/ry 同单位；strength 是 0~1 的混合量。
SHADING = [
    # 眉骨下缘的眼窝阴影 —— 眉骨"凸"不凸，大半靠这道。落在上眼睑那道褶上，
    # 别压到眼球（压了就显眼睛小、像脏了）。
    dict(mode='shadow', c=(-0.04, -0.30), rx=0.44, ry=0.09, rot=-10,
         color=(122, 90, 76), strength=0.26),
    # 鼻梁侧面（吻部顶面的转折）：把"吻部"和"脸颊"分成两个体积
    dict(mode='shadow', c=(0.56, 0.44), rx=0.10, ry=0.20, rot=-18,
         color=(120, 88, 74), strength=0.14),
    # 鼻唇沟：吻部后缘的一道纵向软阴影，沟越清楚，面颊越像个球
    dict(mode='shadow', c=(0.40, 0.86), rx=0.09, ry=0.22, rot=-4,
         color=(116, 84, 70), strength=0.18),
    # 腮帮子后下方：让脸颊有个"收下去"的底，不然鼓起来也读不出球面。
    # 这道很轻 —— 一开始给到 0.14 时，下颌会浮出一条明显的暗带（像双下巴）。
    dict(mode='shadow', c=(-0.38, 1.04), rx=0.26, ry=0.15, rot=8,
         color=(120, 88, 74), strength=0.09),
    # 下巴与脖子之间：不加这道，头像是"贴"在脖子上
    dict(mode='shadow', c=(0.52, 1.46), rx=0.45, ry=0.13, rot=12,
         color=(108, 78, 66), strength=0.24),
    # 颧骨高光：光从右上打来，颧骨最鼓处要亮，球感才成立
    dict(mode='light', c=(0.02, 0.52), rx=0.26, ry=0.18, rot=-20,
         color=(255, 240, 222), strength=0.28),
    # 吻部顶面高光：与颧骨高光一前一后，两块亮面把脸撑开
    dict(mode='light', c=(0.59, 0.59), rx=0.16, ry=0.10, rot=-30,
         color=(255, 246, 234), strength=0.22),
    # 眉弓高光：很轻，只求一条亮边
    dict(mode='light', c=(-0.02, -0.50), rx=0.34, ry=0.07, rot=-6,
         color=(255, 243, 228), strength=0.16),
]


# ---------------------------------------------------------------- 锚点

def anchors(im, eye_hint=None, tip_hint=None):
    """量出 E（眼球高光）、T（吻部尖）、s = |T - E|。

    为什么不用包围盒：侧脸的轮廓和身体连在一起，量到脚上去了；按行取最右像素
    找"眉弓/吻部"又会把额头的毛发算进去（那一段比眉骨还靠前，实测偏 30px）。
    改用两个局部特征：

    - T：逐行最右像素在下半段的最大值 —— 吻部最前沿那一点，很稳。
    - E：眼白上的镜面高光（全图最亮、G 接近 R 的中性小块）。比虹膜中心稳：
      虹膜是暖棕，和毛发、腮红都混在一起切不开；高光只有一处。

    03/07 两张侧脸算出来的 s 都是 54，所以同一套配方两端通用。
    """
    if eye_hint and tip_hint:
        E, T = tuple(eye_hint), tuple(tip_hint)
        return E, T, max(8.0, math.hypot(T[0] - E[0], T[1] - E[1]))

    a = np.array(im.convert('RGBA')).astype(np.int16)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    solid = al > 200
    ys, xs = np.where(solid)
    y_top, y_bot = int(ys.min()), int(ys.max())
    band = solid[y_top:y_top + int((y_bot - y_top) * 0.62)]
    prof = np.array([np.where(rw)[0].max() if rw.any() else -1 for rw in band])
    h = len(prof)
    if tip_hint:
        T = tuple(tip_hint)
    else:
        i = h // 2 + int(np.argmax(prof[h // 2:]))
        T = (float(prof[i]), float(y_top + i))

    spec = (al > 230) & (r > 205) & (g > 195) & (b > 180) & \
           (np.abs(r - g) < 22) & (np.abs(g - b) < 40)
    spec[:, :int(T[0] - 1.1 * (T[1] - y_top))] = False    # 只留脸那一侧，别扫到耳朵
    spec[:y_top, :] = False
    spec[int(T[1]):, :] = False                            # 吻部尖以下不要
    ys2, xs2 = np.where(spec)
    if len(xs2) < 20:
        raise SystemExit('没找到眼球高光，用 --eye x,y 手动给一个')
    E = (float(np.median(xs2)), float(np.median(ys2)))
    return E, T, max(8.0, math.hypot(T[0] - E[0], T[1] - E[1]))


def _px(E, s, c, rx, ry):
    return ((E[0] + c[0] * s, E[1] + c[1] * s), rx * s, ry * s)


def fill_face(im, eye_hint=None, tip_hint=None, strength=1.0):
    E, T, s = anchors(im, eye_hint, tip_hint)
    arr = np.array(im.convert('RGBA'), dtype=np.float32)
    alpha = arr[..., 3] / 255.0
    premul = arr.copy()
    premul[..., :3] *= alpha[..., None]

    # 1) 轮廓：逐行把外缘推出去（真正改变"侧脸轮廓"的一步）
    prof = [(dy, d * strength) for dy, d in PROFILE]
    warped = push_shell(premul, alpha, prof, BAND, E, s)

    # 曾试过"在脸颊中心放一个局部放大（bulge）"来补球面，最后删了：它把整片
    # 毛发一起重采样，观感是"腮帮子被吹鼓了而且糊了"，反而不如把体积交给明暗。
    # 现在脸颊的体积 = 轮廓外扩（这一步）+ 颧骨高光 / 鼻唇沟（下面那组）。

    a2 = np.clip(warped[..., 3], 0, 255)
    rgb = np.clip(warped[..., :3] / np.maximum(a2[..., None] / 255.0, 1e-6), 0, 255)

    # 3) 锐化：形变必然要重新采样，横向压缩还会把毛发"抹平"一点。
    #    毛发是这张图的主要质感，糊了整只都会显得假，所以补一道小半径的
    #    unsharp（半径 1px，不产生明显白边），并按 alpha 羽化，边缘不留光晕。
    if SHARPEN:
        im_rgb = Image.fromarray(rgb.astype(np.uint8), 'RGB')
        sharp = np.array(im_rgb.filter(
            ImageFilter.UnsharpMask(radius=1.1, percent=SHARPEN, threshold=2)), dtype=np.float32)
        k = np.clip(a2 / 255.0, 0, 1)[..., None]
        rgb = rgb * (1.0 - k) + sharp * k

    blobs = []
    for b in SHADING:
        bb = dict(b)
        bb['strength'] = b['strength'] * strength
        bb['c'], bb['rx'], bb['ry'] = _px(E, s, b['c'], b['rx'], b['ry'])
        blobs.append(bb)
    rgb = shade(rgb, np.clip(a2 / 255.0, 0, 1), blobs)

    return Image.fromarray(np.dstack([rgb, a2]).astype(np.uint8), 'RGBA'), (E, T, s)


# ---------------------------------------------------------------- 出图

def measure(before, after, an):
    """量轮廓到底改了多少 —— 这张表才是"有没有变丰润"的客观证据。"""
    E, T, s = an
    pa, pb = profile(np.array(before.split()[-1])), profile(np.array(after.split()[-1]))
    y0, y1 = int(E[1] - 0.9 * s), int(E[1] + 1.7 * s)
    print('  轮廓位移（正数 = 往外凸）：')
    for y in range(y0, y1, 4):
        if pa[y] < 0 or pb[y] < 0:
            continue
        print('    y=%3d (%+.2fs)  %5.1f -> %5.1f  %+.1f'
              % (y, (y - E[1]) / s, pa[y], pb[y], pb[y] - pa[y]))
    seg = pb[y0:y1] - pa[y0:y1]
    print('  最大外凸 %+.1f px；眼睛那一行 %+.1f px'
          % (seg.max(), pb[int(E[1])] - pa[int(E[1])]))


def check(im):
    """回归检查：这张侧脸的吻部到底有没有"鼓出来"。

    量三个点（都以脸长 s 为单位，避开毛发和耳朵）：
      眉弓   E.y - 0.62s .. -0.25s  这一段轮廓的最右
      眼窝   E.y - 0.18s .. +0.22s  这一段的最右（侧脸在这里应该有凹陷）
      吻部   E.y + 0.38s .. +0.95s  这一段的最右
    一个"不扁"的侧脸必须满足：吻部明显领先眉弓、更明显领先眼窝。原始素材是
    吻部只领先眉弓 4px（384 宽下），几乎就是一条直线 —— 那正是"扁平"的来源。
    补完之后 03 是 11/14，07 是 10/13。阈值取 8/10，留一点余量。
    """
    E, T, s = anchors(im)
    prof = profile(np.array(im.split()[-1]))
    band = lambda a, b: float(prof[int(E[1] + a * s):int(E[1] + b * s)].max())
    brow = band(-0.62, -0.25)
    eye = band(-0.18, 0.22)
    muz = band(0.38, 0.95)
    print('  眉弓 %.0f / 眼窝 %.0f / 吻部 %.0f  →  吻部领先眉弓 %+.0f，领先眼窝 %+.0f'
          % (brow, eye, muz, muz - brow, muz - eye))
    ok = (muz - brow) >= 8 and (muz - eye) >= 10
    print('  %s' % ('OK 侧脸有起伏' if ok else
                    'FAIL 侧脸还是扁的（吻部没顶出来）：先跑 fill-face 再检查'))
    return ok


def debug_overlay(im, an, path):
    """把配方画在脸上：绿=轮廓推移的控制点，红=鼓包，蓝=阴影，黄=高光。"""
    E, T, s = an
    bg = Image.new('RGBA', im.size, (246, 246, 246, 255))
    bg.alpha_composite(im)
    d = ImageDraw.Draw(bg, 'RGBA')
    prof = profile(np.array(im.split()[-1]))
    d.line([E, T], fill=(0, 150, 0, 170), width=1)
    for dy, dd in PROFILE:
        y = int(round(E[1] + dy * s))
        x = prof[y]
        if x < 0:
            continue
        d.line([x, y, x + dd * s, y], fill=(0, 170, 0, 255), width=1)
        d.ellipse([x + dd * s - 1, y - 1, x + dd * s + 1, y + 1], fill=(0, 170, 0, 255))
    for i, b in enumerate(SHADING):
        c, rx, ry = _px(E, s, b['c'], b['rx'], b['ry'])
        col = (0, 90, 220, 215) if b['mode'] == 'shadow' else (205, 150, 0, 225)
        d.ellipse([c[0] - rx, c[1] - ry, c[0] + rx, c[1] + ry], outline=col, width=1)
        d.text((c[0] + 2, c[1] + 1), '%s%d' % (b['mode'][0], i), fill=col)
    bg.convert('RGB').resize((im.size[0] * 2, im.size[1] * 2), Image.LANCZOS).save(path)


def preview(im, res, an, path):
    """三联图：原图 / 改后 / 轮廓叠加（青=改前，洋红=改后）。"""
    w, h = im.size
    pad = 12
    sheet = Image.new('RGBA', (w * 3 + pad * 4, h + pad * 2 + 24), (246, 246, 246, 255))
    for i, x in enumerate((im, res)):
        bg = Image.new('RGBA', im.size, (246, 246, 246, 255))
        bg.alpha_composite(x)
        sheet.paste(bg, (pad + i * (w + pad), pad + 24))

    def edge(al):
        e = np.zeros_like(al)
        e[:, :-1] = np.abs(np.diff(al, axis=1))
        e[:-1, :] = np.maximum(e[:-1, :], np.abs(np.diff(al, axis=0)))
        return np.clip(e * 3.0, 0, 1)
    e0 = edge(np.array(im.split()[-1]).astype(np.float32) / 255.0)
    e1 = edge(np.array(res.split()[-1]).astype(np.float32) / 255.0)
    ov = np.zeros((h, w, 4), np.float32)
    ov[..., 0] = 255 * e1
    ov[..., 1] = 255 * e0 * 0.9
    ov[..., 2] = 255 * e0
    ov[..., 3] = 255 * np.clip(e0 + e1, 0, 1)
    bg = Image.new('RGBA', im.size, (246, 246, 246, 255))
    bg.alpha_composite(Image.fromarray(ov.astype(np.uint8), 'RGBA'))
    sheet.paste(bg, (pad + 2 * (w + pad), pad + 24))

    d = ImageDraw.Draw(sheet)
    for i, t in enumerate(('before', 'after', 'silhouette: cyan=before  magenta=after')):
        d.text((pad + i * (w + pad), 6), t, fill=(70, 70, 70, 255))
    sheet.convert('RGB').save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('images', nargs='+')
    ap.add_argument('--preview')
    ap.add_argument('--debug')
    ap.add_argument('--write', action='store_true', help='直接写回素材')
    ap.add_argument('--out-dir', help='不写回，另存到这个目录')
    ap.add_argument('--measure', action='store_true', help='打印轮廓改了多少')
    ap.add_argument('--check', action='store_true', help='回归检查：吻部有没有顶出来')
    ap.add_argument('--eye', help='手动指定眼球位置 x,y（自动量失败时用）')
    ap.add_argument('--tip', help='手动指定吻部尖 x,y')
    ap.add_argument('--strength', type=float, default=1.0,
                    help='整体强度倍数（07 这种脸更侧、离镜头更近的帧用 0.8）')
    args = ap.parse_args()

    for path in args.images:
        im = Image.open(path).convert('RGBA')
        eye = [float(v) for v in args.eye.split(',')] if args.eye else None
        tip = [float(v) for v in args.tip.split(',')] if args.tip else None
        res, an = fill_face(im, eye, tip, args.strength)
        print('%s  E=(%.0f,%.0f) T=(%.0f,%.0f) 脸长 s=%.0f'
              % (path, an[0][0], an[0][1], an[1][0], an[1][1], an[2]))
        tag = os.path.basename(path).split('.')[0]
        if args.measure:
            measure(im, res, an)
        if args.check and not check(im):
            sys.exit(1)
        if args.debug:
            p = args.debug if len(args.images) == 1 else \
                args.debug.replace('.png', '_%s.png' % tag)
            debug_overlay(im, an, p)
            print('  调试图 %s' % p)
        if args.preview:
            p = args.preview if len(args.images) == 1 else \
                args.preview.replace('.png', '_%s.png' % tag)
            preview(im, res, an, p)
            print('  三联图 %s' % p)
        if args.write:
            res.save(path, optimize=True)
            print('  已写回 %s' % path)
        elif args.out_dir:
            dst = os.path.join(args.out_dir, os.path.basename(path))
            res.save(dst, optimize=True)
            print('  已写出 %s' % dst)


main()
