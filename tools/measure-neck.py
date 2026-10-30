#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量出正面帧里"脖子"的位置，生成 character.json 的 headCut / headPivot。

为什么需要这一步：桌宠的素材是单张位图，没有骨骼关节。整只一起平移旋转的时候，
「点头」「摇头」「歪头」在别人眼里全是同一个动作 —— 整只晃了一下。唯一能让人分
得出来的办法，是把头从脖子处单独切一层出来，让它能自己转、自己缩。

切在哪儿？**脖子是轮廓最窄的那一行**。这个方法很朴素但是准：头顶最窄的地方是
耳朵之间（错），胸口最窄的地方是腰（错），而下巴和肩膀之间一定有一个收窄的
"腰"。在合理的纵向范围里找宽度最小的一行就是了。

用法：
    python tools/measure-neck.py assets/01.png
    python tools/measure-neck.py assets/01.png --preview neck.png
    python tools/measure-neck.py assets/01.png --out character.json

输出（窗口比例，直接抄进 character.json）：
    headCut   = 该行的纵向比例
    headPivot = [该行最窄处的横向中心, 该行再往下一小段]
                位移/缩放的支点，放在切线**下方**：这样"头缩一下"是朝脖子压，
                切线上不会有缝。
    headSpin  = 头心的位置（切线以上那半截的包围盒中心）
                旋转支点。必须绕头心转，绕脖子转会让整个头平移出去。
    footRoom  = 最低一行实体像素到图底边的留白
                这个值顺手就量了：脚是地面接触点，留白 0 意味着素材的脚底正好
                压在图片最后一行，任何"往下沉"（走路起伏、落地下压、呼吸位移）
                都会被窗口底边整块切掉 —— 表现出来就是"走路时脚不见了"。

依赖：Pillow（pip install pillow）
"""
import argparse
import json
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit('需要 Pillow：pip install pillow')

# 只在"下巴到胸口"这段里找脖子。范围取宽一点没关系，宽度最小本身就排除了
# 头顶（耳朵之间不窄）和脚（脚更窄但被下界挡住）。
SEARCH_TOP = 0.45
SEARCH_BOTTOM = 0.85

# 支点比切线再往下多少（窗高比例）。0.05 大约是一个下巴的厚度：
# 缩放到 0.91 时，切线上只移动 0.05 * 0.09 = 0.45% 窗高（约 1 个像素）。
PIVOT_DROP = 0.055

# 抗锯齿边缘：alpha 低于这个值不算实体，不然毛发会虚出一圈把宽度算大
ALPHA_ON = 128

# footRoom 的下限。这个量是"脚还有多少下沉空间"，不是"图上有多少空白"：素材
# 多半是贴底裁的（留白 0），照实写成 0 就等于没给，走路一起伏脚就出界。
# 取 0.032 是按真机量出来的：最深的下沉动作是蹲下 0.021，加上旋转时最低那个角
# 还会再往下两三个像素，余量 0.011 ≈ 2.5px 才是"贴着地但不压线"。
# `npm test` 里有断言卡这条（每个动作的下沉 ≤ footRoom）。
MIN_FOOT_ROOM = 0.032


def row_extent(alpha, w, y):
    xs = [x for x in range(w) if alpha[x, y] > ALPHA_ON]
    if not xs:
        return None
    return min(xs), max(xs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--preview', help='把切线画在图上另存一份')
    ap.add_argument('--out', help='直接写回 character.json')
    args = ap.parse_args()

    im = Image.open(args.image).convert('RGBA')
    w, h = im.size
    alpha = im.getchannel('A').load()

    rows = []
    for y in range(h):
        e = row_extent(alpha, w, y)
        if e:
            rows.append((y, e[0], e[1]))
    if not rows:
        sys.exit('这张图是全透明的？')

    y0 = int(h * SEARCH_TOP)
    y1 = int(h * SEARCH_BOTTOM)
    band = [r for r in rows if y0 <= r[0] <= y1]
    if not band:
        sys.exit('在 %.0f%%~%.0f%% 这段里找不到轮廓' % (SEARCH_TOP * 100, SEARCH_BOTTOM * 100))

    # 宽度最小的一行 = 脖子。取连续几行的中点，避免正好卡在一根毛上。
    width = lambda r: r[2] - r[1]
    best_w = min(width(r) for r in band)
    picked = [r for r in band if width(r) <= best_w * 1.03]
    cut_y = sum(r[0] for r in picked) / len(picked)
    cx = sum((r[1] + r[2]) / 2.0 for r in picked) / len(picked) / w

    cut = cut_y / h
    pivot_y = min(0.98, cut + PIVOT_DROP)

    # 旋转支点 = 头心的包围盒中心。为什么不用脖子做旋转支点：绕脖子转会让整个
    # 头的轮廓平移出去，转过的和没转过的两条轮廓叠起来，看着像"头变宽了"。
    head_rows = [r for r in rows if r[0] <= cut_y]
    hy0, hy1 = head_rows[0][0], head_rows[-1][0]
    hx0 = min(r[1] for r in head_rows)
    hx1 = max(r[2] for r in head_rows)
    spin = ((hx0 + hx1) / 2.0 / w, (hy0 + hy1) / 2.0 / h)

    # 底部安全余量：最低一行实体像素到图底边的距离，就是 footRoom。
    # 顺手量是因为矩阵这里已经算完了，而且这个值**不量就会出事**：留白 0 意味着
    # 脚底正好压在图最后一行，走路起伏一旦往正方向（下沉）走，整只脚就会被窗口
    # 底边切平。渲染层按这个值把整只上抬，引擎再把 dy 钳在它以内。
    # 注意它不是单纯的"图上有多少空白"，而是"脚还有多少下沉空间"，所以留白再小
    # 也要补到 MIN_FOOT_ROOM：素材很可能就是贴底裁的，那时空白是 0。
    pad = h - 1 - rows[-1][0]
    foot_room = max(pad / float(h), MIN_FOOT_ROOM)

    print('图        %dx%d' % (w, h))
    print('脖子那一行 y=%.0f (~%.3f)，宽 %d px = %.3f 窗宽' % (cut_y, cut, best_w, best_w / w))
    print('支点横向 x=%.3f（脖子中线）' % cx)
    print('底部留白 %d px (~%.4f 窗高)，footRoom 取 %.3f' % (pad, pad / float(h), foot_room))
    print()
    print('抄进 character.json 的 anchors：')
    print('  "headCut": %.3f,' % cut)
    print('  "headPivot": [%.3f, %.3f],' % (cx, pivot_y))
    print('  "headSpin": [%.3f, %.3f],' % spin)
    print('  "footRoom": %.3f,' % foot_room)

    if pad <= 1:
        print('\n⚠️ 这张图底部留白 %d px —— 脚底正好压在图最后一行。footRoom 已经按'
              '下限 %.3f 补上了；不补的话走路时脚会被窗口底边整块裁掉。'
              % (pad, MIN_FOOT_ROOM), file=sys.stderr)

    # 合理性检查：脖子必须明显窄于头顶最宽处，否则说明这张图没有脖子
    widest = max(width(r) for r in rows)
    if best_w > widest * 0.75:
        print('\n⚠️ 最窄处是最宽处的 %.0f%% —— 这张图可能没有明显的脖子，'
              '头层切出来会比较钝。' % (best_w / widest * 100), file=sys.stderr)

    if args.preview:
        from PIL import ImageDraw
        dst = im.copy()
        d = ImageDraw.Draw(dst)
        d.line([(0, cut_y), (w, cut_y)], fill=(255, 0, 140, 255), width=max(1, h // 200))
        d.ellipse([cx * w - 3, pivot_y * h - 3, cx * w + 3, pivot_y * h + 3],
                  outline=(0, 180, 255, 255), width=2)
        bg = Image.new('RGBA', dst.size, (240, 240, 240, 255))
        bg.alpha_composite(dst)
        bg.convert('RGB').save(args.preview)
        print('预览写到了 %s' % args.preview)

    if args.out:
        with open(args.out, encoding='utf-8') as f:
            doc = json.load(f)
        doc.setdefault('anchors', {})['headCut'] = round(cut, 4)
        doc['anchors']['headPivot'] = [round(cx, 4), round(pivot_y, 4)]
        doc['anchors']['headSpin'] = [round(spin[0], 4), round(spin[1], 4)]
        doc['anchors']['footRoom'] = round(foot_room, 4)
        with open(args.out, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
            f.write('\n')
        print('已写回 %s（注意：json.dump 会把文件重新排版一遍）' % args.out)


main()
