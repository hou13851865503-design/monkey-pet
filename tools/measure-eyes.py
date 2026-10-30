#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量出正面帧里两只眼睛的位置和大小，直接生成 character.json 的 eyes 段。

为什么需要这一步：眩晕时要在眼睛上盖两个卡通眼球 + 螺旋。位置和大小写在
character.json 里（不是 CSS），换形象就得重新量一次。量小了/量偏了，原来的
虹膜会从边缘露出来，看着就像多长了一只眼 —— 这个坑已经踩过一次。

用法：
    python tools/measure-eyes.py assets/01.png
    python tools/measure-eyes.py assets/01.png --out character.json   # 直接改档案

原理：先找瞳孔（很暗的连通域，比毛发和眼睑都暗一个量级）拿到两个眼球中心，
再以中心为基准给一个留足余量的椭圆。不用眼白/虹膜的颜色分割 —— 猕猴的毛发
和虹膜都是暖棕色，颜色阈值分不开，试过，不可靠。

依赖：Pillow（pip install pillow）
"""
import argparse
import json
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit('需要 Pillow：pip install pillow')

# 椭圆尺寸相对"暗块宽度"的倍数。1.0 = 正好贴住虹膜，留边是为了让眼白也跟着
# 被盖住 —— 否则边缘会露出一圈灰白色，看着像眼球里还套着一个小眼球。
# 这两个数是拿 assets/01.png 调出来的：再小就会露棕色，再大就压到眉毛。
WIDTH_MUL = 1.62
HEIGHT_RATIO = 0.86          # 椭圆高宽比：眼裂本来就比它高更宽

# 纵向中心不能直接用暗块的上下中点 —— 暗块下缘会把下眼睑的阴影一起算进去，
# 导致椭圆整体偏低、像眼皮耷拉着。取靠上 35% 处更接近真实眼球中心。
CY_FRAC = 0.35

DARK_SUM = 210      # r+g+b 低于这个值才算瞳孔（比眼睑阴影更暗）


def comps_of_dark(px, w, h, y0, y1, min_size=60):
    """找暗色连通域（4 邻域），返回按面积降序的包围盒列表。"""
    def is_dark(x, y):
        r, g, b, a = px[x, y]
        return a > 200 and (r + g + b) < DARK_SUM

    seen = set()
    out = []
    for y in range(y0, min(y1, h)):
        for x in range(0, w):
            if (x, y) in seen or not is_dark(x, y):
                continue
            stack = [(x, y)]
            seen.add((x, y))
            pts = []
            while stack:
                cx, cy = stack.pop()
                pts.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if (nx, ny) in seen or not (0 <= nx < w and y0 <= ny < min(y1, h)):
                        continue
                    if is_dark(nx, ny):
                        seen.add((nx, ny))
                        stack.append((nx, ny))
            if len(pts) >= min_size:
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]
                out.append({
                    'n': len(pts),
                    'x0': min(xs), 'x1': max(xs),
                    'y0': min(ys), 'y1': max(ys),
                })
    out.sort(key=lambda c: -c['n'])
    return out


def measure(path):
    im = Image.open(path).convert('RGBA')
    w, h = im.size
    px = im.load()
    comps = comps_of_dark(px, w, h, int(h * 0.30), int(h * 0.65))
    if len(comps) < 2:
        raise SystemExit('只找到 %d 个暗块，找不到两只眼睛。确认这是正面帧、且眼睛是睁开的。'
                         % len(comps))

    eyes = comps[:2]
    eyes.sort(key=lambda c: c['x0'])       # 按横坐标排：左眼在前

    # 两只眼睛在同一水平线上，但单只的暗块下缘常被下眼睑的高光截断（右眼尤其明显）。
    # 所以纵向信息合并起来算一次，横向各算各的 —— 不然会得到一只高一只低。
    top = min(c['y0'] for c in eyes)
    bottom = max(c['y1'] for c in eyes)
    cy = top + (bottom - top) * CY_FRAC

    pts = []
    for c in eyes:
        cx = (c['x0'] + c['x1']) / 2
        bw = c['x1'] - c['x0'] + 1
        ew = bw * WIDTH_MUL
        pts.append({
            'x': round(cx / w, 5),
            'y': round(cy / h, 5),
            'w': round(ew / w, 5),
            'h': round(ew * HEIGHT_RATIO / h, 5),
        })
    return {'ink': '#2f2116', 'points': pts}, w, h, eyes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('frame', help='正面帧图片，通常是 assets/01.png')
    ap.add_argument('--out', help='把结果写回 character.json（会保留其它字段）')
    ap.add_argument('--preview', help='同时输出一张预览图，检查有没有露出原来的眼睛')
    args = ap.parse_args()

    eyes, w, h, comps = measure(args.frame)
    print('图片 %dx%d，找到 %d 个暗块（瞳孔）：' % (w, h, len(comps)))
    for i, c in enumerate(comps[:4]):
        print('  #%d 面积=%d  x[%d,%d] y[%d,%d]' % (i, c['n'], c['x0'], c['x1'], c['y0'], c['y1']))
    print('\ncharacter.json 的 eyes 段：')
    print(json.dumps(eyes, ensure_ascii=False, indent=2))

    if args.preview:
        from PIL import ImageDraw
        im = Image.open(args.frame).convert('RGBA')
        d = ImageDraw.Draw(im)
        for p in eyes['points']:
            cx, cy = p['x'] * w, p['y'] * h
            hw, hh = p['w'] * w / 2, p['h'] * h / 2
            d.ellipse([cx - hw, cy - hh, cx + hw, cy + hh], fill=(251, 247, 239, 255))
        bg = Image.new('RGBA', im.size, (255, 0, 255, 255))
        bg.alpha_composite(im)
        bg.save(args.preview)
        print('\n预览已写：%s（背景品红=透明；检查眼球边缘外还有没有棕色或灰白露出）'
              % args.preview)

    if args.out:
        with open(args.out, encoding='utf-8') as f:
            doc = json.load(f)
        doc['eyes'] = eyes
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
            f.write('\n')
        print('\n已写入 %s' % args.out)


if __name__ == '__main__':
    main()
