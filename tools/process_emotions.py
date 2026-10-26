# -*- coding: utf-8 -*-
"""
情绪帧处理：generated-images/emo/named/*.png -> assets/emotion_*.png
1. rembg(U2Net) 抠图 + 复用八面图的误删恢复/连通域清理/羽化
2. 裁非透明包围盒
3. 等比缩放到与 01.png 的小猴包围盒等高（同体型），宽度超限则再缩
4. 底边对齐 01.png 的脚底基线、水平居中，贴到 384x446 透明画布
5. 输出 emotion_<名>.png + 深/浅底检验拼图
"""
import os
import sys
import numpy as np
from PIL import Image, ImageFilter
from rembg import remove, new_session

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slice_monkey_v3 import recover_missing, keep_largest_component  # noqa: E402

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SRC_DIR = os.path.join(ROOT, "generated-images", "emo", "named")
OUT_DIR = os.path.join(ROOT, "monkey-pet", "assets")
REF = os.path.join(OUT_DIR, "01.png")
CANVAS_W, CANVAS_H = 384, 446


def alpha_bbox(alpha):
    ys, xs = np.where(alpha > 10)
    if len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def cutout(img, session):
    """rembg + 误删恢复 + 最大连通域 + 轻羽化，返回 RGBA ndarray"""
    rgba = remove(img, session=session, post_process_mask=True)
    arr = np.asarray(rgba)
    a = recover_missing(arr[:, :, 3].copy(), np.asarray(img.convert("RGB")))
    a = keep_largest_component(a)
    a = np.asarray(Image.fromarray(a).filter(ImageFilter.GaussianBlur(0.8)))
    return np.dstack([np.asarray(img.convert("RGB")), a])


def main():
    session = new_session("u2net")

    # 参考体型：01.png 小猴包围盒
    ref = Image.open(REF)
    ref_a = np.asarray(ref)[:, :, 3]
    rb = alpha_bbox(ref_a)
    ref_h = rb[3] - rb[1]
    ref_bottom = rb[3]  # 脚底基线（画布坐标）
    print(f"ref 01.png bbox={rb}, body height={ref_h}", flush=True)

    os.makedirs(OUT_DIR, exist_ok=True)
    frames = []
    for name in sorted(os.listdir(SRC_DIR)):
        if not name.lower().endswith(".png"):
            continue
        emo = os.path.splitext(name)[0]
        img = Image.open(os.path.join(SRC_DIR, name))
        rgba = cutout(img, session)
        a = rgba[:, :, 3]
        bb = alpha_bbox(a)
        if bb is None:
            print(f"  [skip] {emo}: empty cutout", flush=True)
            continue
        crop = Image.fromarray(rgba[bb[1]:bb[3], bb[0]:bb[2]])
        w, h = crop.size

        # 等比缩放到与参考小猴等高
        f = ref_h / h
        if w * f > CANVAS_W:  # 宽度超限再缩
            f = CANVAS_W / w
        crop = crop.resize((max(1, int(w * f)), max(1, int(h * f))), Image.LANCZOS)
        w, h = crop.size

        canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
        px = (CANVAS_W - w) // 2
        py = ref_bottom - h  # 底边对齐脚底基线
        canvas.paste(crop, (px, py), crop)
        out_path = os.path.join(OUT_DIR, f"emotion_{emo}.png")
        canvas.save(out_path)
        frames.append((emo, canvas))
        print(f"  saved {out_path}  scale={f:.2f} size={w}x{h}", flush=True)

    # 检验拼图：3 列 x 3 行
    cols, rows = 3, 3
    for tag, bg in (("contact_emotions_dark.png", (40, 44, 52)), ("contact_emotions_light.png", (240, 240, 240))):
        sheet = Image.new("RGB", (cols * CANVAS_W, rows * CANVAS_H), bg)
        for i, (_, f) in enumerate(frames):
            r, c = divmod(i, cols)
            sheet.paste(f, (c * CANVAS_W, r * CANVAS_H), f)
        sheet.save(os.path.join(OUT_DIR, tag))
        print(f"  saved {os.path.join(OUT_DIR, tag)}", flush=True)


if __name__ == "__main__":
    main()
