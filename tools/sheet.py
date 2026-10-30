# -*- coding: utf-8 -*-
"""把 _shots 里的连续截图拼成一张对比表，方便一眼看出"这些动作到底一样不一样"。

用法：python tools/sheet.py out.png nod shakeHead curious ...
      每行一个动作，按文件名 <prefix>_<id>_<n>.png 排序。
背景用浅灰棋盘：桌宠是透明底，直接叠在纯色上看不出边缘。
"""
import os
import sys
from PIL import Image

SHOTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '_shots')
SCALE = 1.0


def checker(w, h, step=16):
    im = Image.new('RGB', (w, h), (232, 232, 232))
    px = im.load()
    for y in range(h):
        for x in range(w):
            if ((x // step) + (y // step)) % 2:
                px[x, y] = (206, 206, 206)
    return im


def main():
    out = sys.argv[1]
    ids = sys.argv[2:]
    prefix = os.environ.get('SHEET_PREFIX', 'a')
    rows = []
    for cid in ids:
        files = sorted(
            [f for f in os.listdir(SHOTS) if f.startswith(prefix + '_' + cid + '_')],
            key=lambda f: int(f.rsplit('_', 1)[1].split('.')[0]),
        )
        if files:
            rows.append((cid, [Image.open(os.path.join(SHOTS, f)).convert('RGBA') for f in files]))
    if not rows:
        print('no shots')
        return
    cw, ch = rows[0][1][0].size
    cols = max(len(r[1]) for r in rows)
    pad = 6
    sheet = Image.new('RGB', (cols * (cw + pad) + pad, len(rows) * (ch + pad + 18) + pad), (250, 250, 250))
    for ri, (cid, imgs) in enumerate(rows):
        top = pad + ri * (ch + pad + 18) + 18
        for ci, im in enumerate(imgs):
            bg = checker(cw, ch)
            bg.paste(im, (0, 0), im)
            sheet.paste(bg, (pad + ci * (cw + pad), top))
    sheet.save(out)
    print(out, sheet.size)


main()
