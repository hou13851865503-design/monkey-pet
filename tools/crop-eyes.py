"""从真机截图里自动框住两只"眩晕眼"再放大，用于对比不同画法。

为什么要自动找：眩晕时 #breath 上挂着 dizzyWobble（±5° 旋转 + 横移），
每次截图整只猴子的位置都不一样，写死裁切框会把眼睛切歪 —— 那样对比出来的
"哪个好看"其实是"哪个没被切歪"。
"""
import sys
from PIL import Image


def find_eyes(im):
    w, h = im.size
    px = im.load()
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            if r > 225 and g > 218 and b > 200 and max(r, g, b) - min(r, g, b) < 28:
                xs.append(x); ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def main(src, out, zoom=8, pad=6):
    im = Image.open(src).convert('RGB')
    box = find_eyes(im)
    if not box:
        raise SystemExit('没找到眼白（截图里是不是没有眩晕？）')
    x0, y0, x1, y1 = box
    x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
    x1 = min(im.width - 1, x1 + pad); y1 = min(im.height - 1, y1 + pad)
    c = im.crop((x0, y0, x1 + 1, y1 + 1))
    c = c.resize((c.width * zoom, c.height * zoom), Image.NEAREST)
    c.save(out)
    print('%s 眼睛 bbox=%s → %s %s' % (src, (x0, y0, x1, y1), out, c.size))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2],
         zoom=int(sys.argv[3]) if len(sys.argv) > 3 else 8)
