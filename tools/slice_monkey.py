# -*- coding: utf-8 -*-
"""
P1 素材处理 v2：八面图 -> 8 张透明底序列帧
去背策略：边框像素拟合二次渐变曲面 -> 与拟合背景的距离判背景 -> 边缘连通洪泛 -> 羽化
"""
from PIL import Image, ImageFilter
import numpy as np
from collections import deque
import os

SRC = os.path.join("generated-images", "Character_turnaround_model_she_2026-10-26T14-16-37.png")
OUT = os.path.join("monkey-pet", "assets")
COLS, ROWS = 4, 2
LABEL_CUT = 0.13
RING = 8                  # 参与拟合的边框宽度
T = 30.0                  # 与拟合背景的欧氏距离阈值


def fit_bg(arr: np.ndarray):
    """用边框环像素拟合二次曲面 bg(y,x) -> (r,g,b)"""
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w]
    mask = np.zeros((h, w), bool)
    mask[:RING, :] = mask[-RING:, :] = True
    mask[:, :RING] = mask[:, -RING:] = True
    ys, xs = yy[mask], xx[mask]
    A = np.stack([np.ones_like(ys), xs, ys, xs * xs, ys * ys, xs * ys], axis=1).astype(float)
    # 归一化坐标防病态
    A[:, 1] /= w; A[:, 2] /= h; A[:, 3] /= w * w; A[:, 4] /= h * h; A[:, 5] /= (w * h)
    feats = np.stack([np.ones(h * w), (xx / w).ravel(), (yy / h).ravel(),
                      ((xx / w) ** 2).ravel(), ((yy / h) ** 2).ravel(),
                      ((xx / w) * (yy / h)).ravel()], axis=1)
    coef, *_ = np.linalg.lstsq(A, arr[mask].astype(float), rcond=None)
    bg = (feats @ coef).reshape(h, w, 3)
    dist = np.sqrt(((arr.astype(float) - bg) ** 2).sum(axis=2))
    return bg, dist


def flood_from_edges(bg_candidate: np.ndarray) -> np.ndarray:
    """只保留与边缘连通的背景区域"""
    h, w = bg_candidate.shape
    visited = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if bg_candidate[y, x] and not visited[y, x]:
                visited[y, x] = True; q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if bg_candidate[y, x] and not visited[y, x]:
                visited[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and bg_candidate[ny, nx] and not visited[ny, nx]:
                visited[ny, nx] = True
                q.append((ny, nx))
    return visited


def main():
    os.makedirs(OUT, exist_ok=True)
    im = Image.open(SRC).convert("RGB")
    W, H = im.size
    cw, ch = W // COLS, H // ROWS
    cut = int(ch * LABEL_CUT)
    print(f"sheet {W}x{H}, cell {cw}x{ch}, label cut {cut}px")

    frames = []
    for i in range(COLS * ROWS):
        r, c = divmod(i, COLS)
        cell = im.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch - cut))
        arr = np.asarray(cell).astype(float)

        bg, dist = fit_bg(arr)
        if i == 0:
            ring_dist = np.concatenate([dist[:RING, :].ravel(), dist[-RING:, :].ravel(),
                                        dist[:, :RING].ravel(), dist[:, -RING:].ravel()])
            print(f"  bg-fit check cell1: border dist p50={np.percentile(ring_dist,50):.1f} "
                  f"p95={np.percentile(ring_dist,95):.1f} p99={np.percentile(ring_dist,99):.1f}")

        bgc = dist < T
        bgc = flood_from_edges(bgc)
        fg = ~bgc

        mask = Image.fromarray((fg * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))
        alpha = np.asarray(mask)
        rgba = np.dstack([np.asarray(cell), alpha])
        out = Image.fromarray(rgba, "RGBA")
        path = os.path.join(OUT, f"{i + 1:02d}.png")
        out.save(path)
        frames.append(out)
        print(f"  saved {path}  fg%={fg.mean() * 100:.1f}")

    # 检验图：2 行 x 4 列，深/浅底各一张
    for name, bgc_ in (("contact_dark.png", (40, 44, 52)), ("contact_light.png", (240, 240, 240))):
        sheet = Image.new("RGB", (W, (ch - cut) * 2), bgc_)
        for i, f in enumerate(frames):
            r, c = divmod(i, COLS)
            sheet.paste(f, (c * cw, r * (ch - cut)), f)
        sheet.save(os.path.join(OUT, name))
        print(f"  saved {os.path.join(OUT, name)}")


if __name__ == "__main__":
    main()
