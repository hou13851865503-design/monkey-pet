# -*- coding: utf-8 -*-
"""生成 character.json 的 clips 段。

为什么用脚本而不是手写：16 个动作 x 5~9 个关键帧，手写很容易漏逗号、把键写错，
而 clips 是唯一"错了就整只宠物不动"的地方。数据集中在这里，输出格式和文件里
原来的手写风格一致（一个关键帧一行），读起来和手写没区别。

设计约束（单张位图没有关节，只有这几样能用来区分动作）：
  1. 切帧    front / side / turnA / 9 张情绪脸 —— 情绪脸里有**不同姿势**
             （e_cheer 双臂上举、e_thinking 手托下巴、e_shy 手掩嘴），这是最强的线索
  2. 整只     dx dy rot sx sy —— 平移缩放，只适合表达"重心移动 / 挤压拉伸"
  3. 只动头   headRot headDx headDy headSx headSy —— 点头/摇头/歪头/低头必须靠这个
每个动作至少占住一种**只有它在用**的手法，否则看起来就是"整只猴子晃了一下"。
"""
import io
import json

# 通道顺序固定，方便肉眼比对
ORDER = ["t", "frame", "dx", "dy", "rot", "sx", "sy",
         "headRot", "headDx", "headDy", "headSx", "headSy"]

CLIPS = [
    # ---- 1. 东张西望：头转过去 + 头横移，身子只跟着偏一点点 ----
    dict(id="lookAround", label="东张西望", tags=["quiet"], weight=4, dur=2600, keys=[
        dict(t=0, frame="front"),
        dict(t=0.12, frame="side", headRot=-6, headDx=-0.026, headDy=0.002, dx=-0.006),
        dict(t=0.32, frame="side", headRot=-5.4, headDx=-0.024, dx=-0.006),
        dict(t=0.44, frame="front", headRot=0, headDx=0),
        dict(t=0.56, frame="side", headRot=6.2, headDx=0.028, dx=0.007),
        dict(t=0.76, frame="side", headRot=5.6, headDx=0.026, dx=0.007),
        dict(t=0.9, frame="front", headRot=0.8, headDx=0.004),
        dict(t=1.0),
    ]),

    # ---- 2. 歪头看你：只有头歪，而且歪得很明显（11°） ----
    dict(id="curious", label="歪头看你", tags=["quiet"], weight=3, dur=2200, keys=[
        dict(t=0),
        dict(t=0.18, headRot=9.5, headSy=0.986, dx=0.007, rot=1.1),
        dict(t=0.34, headRot=11, headDy=0.003),
        dict(t=0.64, headRot=10.6, headDy=0.003),
        dict(t=0.86, headRot=-1.4),
        dict(t=1.0),
    ]),

    # ---- 3. 伸懒腰：双臂上举那张脸（e_cheer）+ 全身拉长 ----
    dict(id="stretch", label="伸懒腰", tags=["quiet"], weight=3, dur=3200, keys=[
        dict(t=0, frame="front"),
        dict(t=0.1, frame="front", dy=0.012, sy=0.968, sx=1.02, headSy=0.985),
        dict(t=0.32, frame="cheer", dy=-0.026, sy=1.055, sx=0.962, headSy=1.035, headRot=-2.4),
        dict(t=0.62, frame="cheer", dy=-0.029, sy=1.062, sx=0.958, headSy=1.045, headRot=-2.8),
        dict(t=0.8, frame="front", dy=0.011, sy=0.972, sx=1.018, headSy=0.99, headRot=1.2),
        dict(t=1.0),
    ]),

    # ---- 4. 蹦两下：两段完整的抛物线（不是一次弹跳）----
    dict(id="hop", label="蹦两下", tags=["lively"], weight=3, dur=1500, keys=[
        dict(t=0, frame="front"),
        dict(t=0.07, frame="front", dy=0.019, sy=0.932, sx=1.052),
        dict(t=0.2, frame="cheer", dy=-0.052, sy=1.05, sx=0.958, headSy=1.02),
        dict(t=0.31, frame="cheer", dy=-0.03, sy=1.022, sx=0.982, headSy=1.01),
        dict(t=0.4, frame="front", dy=0.017, sy=0.922, sx=1.062, headSy=0.955),
        dict(t=0.49, frame="front", dy=0.006, sy=0.955, sx=1.032, headSy=0.985),
        dict(t=0.6, frame="cheer", dy=-0.037, sy=1.036, sx=0.97, headSy=1.016),
        dict(t=0.72, frame="front", dy=0.013, sy=0.945, sx=1.042, headSy=0.965),
        dict(t=0.86, frame="front", dy=-0.004, sy=1.005, sx=0.997),
        dict(t=1.0),
    ]),

    # ---- 5. 点头：身体几乎不动，只有头在往下点三次 ----
    # headSy 压缩 + 支点在脖子上 = 头朝脖子压下去，正是点头的样子。
    # 身体也要跟着沉一点点（dy 0.008）：真人点头时上半身会带一点，全靠头会显得僵。
    dict(id="nod", label="点头", tags=["quiet"], weight=2, dur=1200, keys=[
        dict(t=0),
        dict(t=0.14, headSy=0.912, headRot=3.4, headDy=0.005, dy=0.008, sy=0.99),
        dict(t=0.3, headSy=0.996, headRot=0, headDy=0, dy=0, sy=1),
        dict(t=0.44, headSy=0.912, headRot=3.4, headDy=0.005, dy=0.008, sy=0.99),
        dict(t=0.6, headSy=0.996, headRot=0, headDy=0, dy=0, sy=1),
        dict(t=0.72, headSy=0.938, headRot=2.6, headDy=0.004, dy=0.006, sy=0.993),
        dict(t=0.88, headSy=1, headRot=0, headDy=0, dy=0, sy=1),
        dict(t=1.0),
    ]),

    # ---- 6. 摇头：头左右转四次，身子只反向带一点点 ----
    dict(id="shakeHead", label="摇头", tags=["quiet"], weight=2, dur=1300, keys=[
        dict(t=0),
        dict(t=0.13, headRot=-9.5, headDx=-0.019, headSy=0.985, dx=0.004, rot=0.9),
        dict(t=0.28, headRot=9.5, headDx=0.019, dx=-0.004, rot=-0.9),
        dict(t=0.43, headRot=-7.6, headDx=-0.015, dx=0.003, rot=0.7),
        dict(t=0.58, headRot=6.4, headDx=0.013, dx=-0.003, rot=-0.6),
        dict(t=0.72, headRot=-3.6, headDx=-0.007, dx=0.001, rot=0.3),
        dict(t=0.86, headRot=1.6, headDx=0.003),
        dict(t=1.0),
    ]),

    # ---- 7. 蹲一蹲：全身下沉压扁，头跟着缩进去 ----
    dict(id="crouch", label="蹲一蹲", tags=["quiet"], weight=2, dur=2000, keys=[
        dict(t=0),
        # 下沉量不是随手写的：它和 anchors.footRoom 是一对。footRoom 是"脚还能往下
        # 沉多少"，渲染层按它把整只抬起来，所以动作下沉一旦逼近 footRoom，脚就正好
        # 压到窗口底边。这里留 0.011 = 约 2.5px 的呼吸空间（真机量过：0.024 时余量为 0）。
        dict(t=0.16, dy=0.017, sy=0.918, sx=1.046, headSy=0.975, headDy=0.004),
        dict(t=0.26, dy=0.021, sy=0.908, sx=1.052, headSy=0.968, headDy=0.005),
        dict(t=0.64, dy=0.020, sy=0.912, sx=1.05, headSy=0.97, headDy=0.005),
        dict(t=0.82, dy=-0.007, sy=1.018, sx=0.988, headSy=1.008),
        dict(t=1.0),
    ]),

    # ---- 8. 抖一抖：高频小幅，头和身子一起哆嗦（900ms 跑完 7 个来回）----
    # 它的辨识点不是幅度大，而是**快**：同样左右摆，摇头是 1.3 秒 4 次，这个是 0.9 秒 7 次
    dict(id="shiver", label="抖一抖", tags=["lively"], weight=2, dur=900, keys=[
        dict(t=0),
        dict(t=0.08, dx=0.015, rot=2.6, headRot=-4, headDx=0.009, sy=1.006),
        dict(t=0.18, dx=-0.015, rot=-2.6, headRot=4, headDx=-0.009, sy=0.994),
        dict(t=0.28, dx=0.013, rot=2.2, headRot=-3.2, headDx=0.007),
        dict(t=0.38, dx=-0.013, rot=-2.2, headRot=3.2, headDx=-0.007),
        dict(t=0.5, dx=0.009, rot=1.6, headRot=-2.2, headDx=0.005),
        dict(t=0.62, dx=-0.007, rot=-1, headRot=1.3, headDx=-0.003),
        dict(t=1.0),
    ]),

    # ---- 9. 打盹：头一点点垂到底 → 猛地惊醒 → 再慢慢垂 ----
    dict(id="doze", label="打盹", tags=["quiet"], weight=2, dur=3600, keys=[
        dict(t=0, frame="front"),
        dict(t=0.16, frame="front", headRot=3.4, headSy=0.984, headDy=0.004, dy=0.006, rot=1.2),
        dict(t=0.4, frame="sleepy", headRot=8.6, headSy=0.948, headDy=0.009, dy=0.016, rot=2.6, sy=0.988),
        dict(t=0.54, frame="sleepy", headRot=9.2, headSy=0.942, headDy=0.01, dy=0.018, rot=2.9, sy=0.986),
        dict(t=0.62, frame="front", headRot=-3.2, headSy=1.018, headDy=-0.004, dy=-0.004, rot=-0.8, sy=1.006),
        dict(t=0.74, frame="front", headRot=1.6, headSy=0.996, headDy=0.001, dy=0.002, rot=0.4),
        dict(t=0.88, frame="sleepy", headRot=5.4, headSy=0.968, headDy=0.006, dy=0.01, rot=1.6),
        dict(t=0.96, frame="front", headRot=1.2, headSy=0.992),
        dict(t=1.0),
    ]),

    # ---- 10. 挥挥手：双臂上举那张脸 + 举起来之后原地摇三下（挥手的节奏）----
    # 手是不可能真挥的（单张图），但"双臂高举 + 身体左右摇"就是打招呼最省事的写法，
    # 而且 e_cheer 这张脸本身就是双臂上举的姿势，躺赢。
    dict(id="waveHand", label="挥挥手", tags=["lively"], weight=3, dur=1800, keys=[
        dict(t=0, frame="front"),
        dict(t=0.12, frame="cheer", dy=-0.013, sy=1.032, rot=-2.6, headSy=1.02, headRot=2.2),
        dict(t=0.26, frame="cheer", dy=-0.005, sy=1.014, rot=3.9, dx=0.011, headRot=-2.6),
        dict(t=0.42, frame="cheer", dy=-0.014, sy=1.034, rot=-3.4, dx=-0.011, headRot=2),
        dict(t=0.58, frame="cheer", dy=-0.005, sy=1.014, rot=3.6, dx=0.009, headRot=-2),
        dict(t=0.72, frame="cheer", dy=-0.011, sy=1.026, rot=-1.8, dx=-0.004, headRot=1.2),
        dict(t=0.88, frame="front", rot=0, dx=0, dy=0, sy=1, headSy=1, headRot=0),
        dict(t=1.0),
    ]),

    # ---- 11. 打哈欠：张嘴那张脸 + 头后仰 + 全身拉长 + 松下来 ----
    dict(id="yawn", label="打哈欠", tags=["quiet"], weight=2, dur=2800, keys=[
        dict(t=0, frame="front"),
        dict(t=0.16, frame="sleepy", dy=-0.012, sy=1.026, sx=0.99, headSy=1.03, headDy=-0.006, headRot=-1.6),
        dict(t=0.44, frame="sleepy", dy=-0.017, sy=1.042, sx=0.982, headSy=1.05, headDy=-0.009, headRot=-2.6),
        dict(t=0.6, frame="sleepy", dy=-0.015, sy=1.036, sx=0.985, headSy=1.045, headDy=-0.008, headRot=-2.2),
        dict(t=0.78, frame="front", dy=0.014, sy=0.962, sx=1.024, headSy=0.968, headDy=0.006, headRot=1.6),
        dict(t=1.0),
    ]),

    # ---- 12. 探头看：头**先**探出去，身子后跟上（头领着身子）----
    dict(id="peek", label="探头看", tags=["quiet"], weight=2, dur=2000, keys=[
        dict(t=0, frame="front"),
        dict(t=0.14, frame="side", headDx=0.03, headRot=4.2, headDy=-0.004, dy=0.008, sx=0.982),
        dict(t=0.34, frame="side", headDx=0.031, headRot=4.4, dx=0.012, dy=0.002, sx=0.99),
        dict(t=0.56, frame="side", headDx=0.03, headRot=3.8, dx=0.013),
        dict(t=0.74, frame="front", headDx=0.012, headRot=1.4, dx=0.005, sx=0.998),
        dict(t=0.9, frame="front", headDx=0.003, headRot=0.3, dx=0.001),
        dict(t=1.0),
    ]),

    # ---- 13. 摸头（点脑袋）：头被按下去 + 害羞脸 ----
    dict(id="headTap", label="摸头", tags=["reaction"], dur=1300, keys=[
        dict(t=0, frame="front"),
        dict(t=0.12, frame="shy", headSy=0.9, headDy=0.008, dy=0.012, sy=0.968, sx=1.026),
        dict(t=0.34, frame="shy", headSy=0.912, headDy=0.006, dy=0.01, sy=0.972, sx=1.022, headRot=-2),
        dict(t=0.52, frame="shy", headSy=0.926, headDy=0.004, dy=0.006, sy=0.984, headRot=-1.2),
        dict(t=0.74, frame="shy", headSy=1.012, headDy=-0.002, dy=-0.004, sy=1.01, headRot=0.8),
        dict(t=1.0, frame="front"),
    ]),

    # ---- 14. 被戳一下：吓一跳 → 往回缩 → 陪着笑一下 → 眨眼 ----
    dict(id="bodyTap", label="被戳一下", tags=["reaction"], dur=1000, keys=[
        dict(t=0, frame="front"),
        dict(t=0.1, frame="surprised", dy=0.009, sy=0.965, sx=1.03, headSy=0.94, headDy=0.006),
        dict(t=0.28, frame="surprised", dy=-0.026, sy=1.038, sx=0.972, headSy=1.03, headDy=-0.008, headRot=-2.6),
        dict(t=0.5, frame="cheer", dy=0.005, sy=0.988, sx=1.008, headSy=1.004),
        dict(t=0.72, frame="wink", dy=-0.003, sy=1.006, sx=0.996, headRot=1.6),
        dict(t=0.9, frame="front"),
        dict(t=1.0),
    ]),

    # ---- 15. 落地：压缩 → 回弹（时长本来就短，只表达那一下冲击）----
    dict(id="land", label="落地", tags=["reaction"], dur=620, keys=[
        dict(t=0, dy=-0.01, sy=1.06, sx=0.955),
        dict(t=0.16, dy=0.019, sy=0.898, sx=1.075, headSy=0.94, headDy=0.006),
        dict(t=0.42, dy=-0.008, sy=1.026, sx=0.985, headSy=1.014),
        dict(t=0.66, dy=0.006, sy=0.99, sx=1.008),
        dict(t=1.0),
    ]),

    # ---- 16. 转身：用那张"侧 3/4"的转向帧（d1），横向压扁再弹开 ----
    # 这个是全表唯一**完全不用头通道**的动作：300ms 的动作头来不及转，
    # 而且它顺便证明"没有头层这套也能照常播"（万一哪天头层初始化失败）。
    dict(id="turn", label="转身", tags=["reaction"], dur=300, keys=[
        dict(t=0, frame="front"),
        dict(t=0.3, frame="turnA", sx=0.83, dy=0.014, sy=0.972),
        dict(t=0.68, frame="turnA", sx=1.075, dy=-0.006, sy=1.014),
        dict(t=1.0, sx=1),
    ]),
]


def emit_key(k):
    parts = []
    for name in ORDER:
        if name not in k:
            continue
        v = k[name]
        if name == "frame":
            parts.append('"frame": %s' % json.dumps(v, ensure_ascii=False))
        elif isinstance(v, float):
            s = ('%.4f' % v).rstrip('0').rstrip('.')
            parts.append('"%s": %s' % (name, s if s not in ('', '-0') else '0'))
        else:
            parts.append('"%s": %d' % (name, v))
    if not parts:
        return '{ "t": 0 }'
    return '{ ' + ', '.join(parts) + ' }'


def emit_clip(c):
    out = []
    out.append('    {')
    out.append('      "id": %s,' % json.dumps(c["id"], ensure_ascii=False))
    out.append('      "label": %s,' % json.dumps(c["label"], ensure_ascii=False))
    out.append('      "tags": [%s],' % ', '.join(json.dumps(t) for t in c["tags"]))
    if "weight" in c:
        out.append('      "weight": %d,' % c["weight"])
    out.append('      "dur": %d,' % c["dur"])
    out.append('      "keys": [')
    out.append(',\n'.join('        ' + emit_key(k) for k in c["keys"]))
    out.append('      ]')
    out.append('    }')
    return '\n'.join(out)


if __name__ == "__main__":
    body = '  "clips": [\n' + ',\n'.join(emit_clip(c) for c in CLIPS) + '\n  ]\n}\n'
    src = io.open('character.json', encoding='utf-8').read()
    i = src.index('  "clips": [')
    io.open('character.json', 'w', encoding='utf-8', newline='\n').write(src[:i] + body)
    json.loads(io.open('character.json', encoding='utf-8').read())
    print('ok, %d clips' % len(CLIPS))
