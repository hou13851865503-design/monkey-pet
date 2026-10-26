# -*- coding: utf-8 -*-
"""
P1 素材处理 v3（rembg/U2Net 版）：八面图 -> 8 张透明底序列帧
1. 4x2 等分切格（相同裁切矩形 -> 天然对齐）
2. 裁掉底部文字标签条
3. rembg 抠图（U2Net 显著性分割，毛发边缘友好）
4. 边缘轻度羽化，输出 RGBA PNG + 深/浅底检验图
"""
from PIL import Image, ImageFilter
import numpy as np
from collections import deque
import os
import sys

from rembg import remove, new_session


def local_bg_model(rgb: np.ndarray, bg_mask: np.ndarray, block: int = 16):
    """用背景像素按块取中位数 -> 双线性放大，得到含暗角的局部背景色模型"""
    h, w, _ = rgb.shape
    gy, gx = max(1, h // block), max(1, w // block)
    grid = np.zeros((gy, gx, 3), np.float32)
    filled = np.zeros((gy, gx), bool)
    for by in range(gy):
        for bx in range(gx):
            sl = (slice(by * block, min((by + 1) * block, h)),
                  slice(bx * block, min((bx + 1) * block, w)))
            m = bg_mask[sl]
            if m.sum() >= 30:
                grid[by, bx] = np.median(rgb[sl][m], axis=0)
                filled[by, bx] = True
    if filled.sum() < 4:
        return None
    while not filled.all():  # 缺失块用邻居均值补
        pad = np.pad(filled, 1, mode="edge")
        grow = pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]
        newly = grow & ~filled
        if not newly.any():
            break
        for by, bx in zip(*np.where(newly)):
            neigh = [grid[by + dy, bx + dx] for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1))
                     if 0 <= by + dy < gy and 0 <= bx + dx < gx and filled[by + dy, bx + dx]]
            grid[by, bx] = np.mean(neigh, axis=0)
        filled |= newly
    img = Image.fromarray(np.clip(grid, 0, 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)
    return np.asarray(img).astype(np.float32)


def recover_missing(alpha: np.ndarray, rgb: np.ndarray,
                    tol: float = 32.0, band_px: int = 80) -> np.ndarray:
    """恢复被误删的前景：贴着主体、且颜色明显不是背景的像素"""
    fg = alpha > 10
    warmth_all = rgb[:, :, 0].astype(np.float32) - rgb[:, :, 2].astype(np.float32)
    # 背景样本只取中性色像素，防止耳朵等被误删的暖色区域污染背景模型
    bg_samples = (~fg) & (warmth_all < 25)
    bgm = local_bg_model(rgb, bg_samples)
    if bgm is None:
        return alpha
    dist = np.sqrt(((rgb.astype(np.float32) - bgm) ** 2).sum(axis=2))
    band = np.asarray(Image.fromarray((fg * 255).astype(np.uint8))
                      .filter(ImageFilter.MaxFilter(band_px * 2 + 1))) > 0
    # 耳朵等皮肤是暖粉色（R-B 大），背景/光晕是中性灰（R-B 小）—— 用暖度区分
    warmth = rgb[:, :, 0].astype(np.float32) - rgb[:, :, 2].astype(np.float32)
    recover = band & (dist > tol) & (warmth > 35) & (alpha < 128)
    out = np.where(recover, 255, alpha)

    # 封闭孔洞填充：背景中不可从边界到达的部分视为前景内部
    h, w = out.shape
    bgm2 = out < 10
    reachable = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if bgm2[y, x] and not reachable[y, x]:
                reachable[y, x] = True; q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if bgm2[y, x] and not reachable[y, x]:
                reachable[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and bgm2[ny, nx] and not reachable[ny, nx]:
                reachable[ny, nx] = True
                q.append((ny, nx))
    holes = bgm2 & ~reachable
    out[holes] = 255
    return out


def keep_largest_component(alpha: np.ndarray) -> np.ndarray:
    """只保留最大连通前景块，清掉悬浮的背景残片"""
    h, w = alpha.shape
    solid = alpha > 10
    labels = np.zeros((h, w), dtype=np.int32)
    cur = 0
    best_id, best_size = 0, 0
    for sy in range(h):
        for sx in range(w):
            if solid[sy, sx] and labels[sy, sx] == 0:
                cur += 1
                size = 0
                stack = [(sy, sx)]
                labels[sy, sx] = cur
                while stack:
                    y, x = stack.pop()
                    size += 1
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and solid[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = cur
                            stack.append((ny, nx))
                if size > best_size:
                    best_id, best_size = cur, size
    keep = labels == best_id
    return np.where(keep, alpha, 0)


SRC = os.path.join("generated-images", "Character_turnaround_model_she_2026-10-26T14-16-37.png")
OUT = os.path.join("monkey-pet", "assets")
COLS, ROWS = 4, 2
LABEL_CUT = 0.13


def main():
    os.makedirs(OUT, exist_ok=True)
    session = new_session("u2net")  # 模型首次运行时自动下载
    im = Image.open(SRC).convert("RGB")
    W, H = im.size
    cw, ch = W // COLS, H // ROWS
    cut = int(ch * LABEL_CUT)
    print(f"sheet {W}x{H}, cell {cw}x{ch}, label cut {cut}px", flush=True)

    frames = []
    for i in range(COLS * ROWS):
        r, c = divmod(i, COLS)
        cell = im.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch - cut))

        cutout = remove(cell, session=session, post_process_mask=True)
        arr = np.asarray(cutout)
        a = recover_missing(arr[:, :, 3].copy(), np.asarray(cell))
        a = keep_largest_component(a)

        # 轻羽化
        a = np.asarray(Image.fromarray(a).filter(ImageFilter.GaussianBlur(0.8)))
        rgba = np.dstack([np.asarray(cell), a])
        out = Image.fromarray(rgba, "RGBA")
        path = os.path.join(OUT, f"{i + 1:02d}.png")
        out.save(path)
        frames.append(out)
        print(f"  saved {path}  fg%={(a > 128).mean() * 100:.1f}", flush=True)

        # 临时调试：背面 05/06 帧，把每帧生成一张浅底特写，验证耳朵是否被恢复
        if i in (4, 5):
            dbg = Image.new("RGBA", out.size, (255, 255, 255, 255))
            dbg.paste(out, (0, 0), out)
            dbg.save(os.path.join(OUT, f"_debug_{i + 1:02d}.png"))
            print(f"  saved debug {os.path.join(OUT, f'_debug_{i + 1:02d}.png')}", flush=True)

    for name, bgc_ in (("contact_dark.png", (40, 44, 52)), ("contact_light.png", (240, 240, 240))):
        sheet = Image.new("RGB", (W, (ch - cut) * 2), bgc_)
        for i, f in enumerate(frames):
            r, c = divmod(i, COLS)
            sheet.paste(f, (c * cw, r * (ch - cut)), f)
        sheet.save(os.path.join(OUT, name))
        print(f"  saved {os.path.join(OUT, name)}", flush=True)


if __name__ == "__main__":
    main()
