#!/usr/bin/env python3
"""生成应用图标 assets/icon.png (256) 与托盘图标 assets/tray.png (32)。

设计语义：圆环代表窗口，左半填充代表"半透明"，
中心亮点代表"阅读/注视"。纯几何绘制，无外部素材依赖。
"""
import os
from PIL import Image, ImageDraw

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'assets'))

BG = (28, 32, 42, 255)          # 深灰蓝底
RING = (120, 168, 255, 255)     # 圆环
HALF = (120, 168, 255, 205)     # 左半透明填充
DOT = (232, 238, 250, 255)      # 中心亮点


def make(size: int) -> Image.Image:
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    m = max(1, size // 16)  # 外边距
    # 圆角背景
    d.rounded_rectangle(
        [m, m, size - m, size - m],
        radius=max(2, size // 5),
        fill=BG,
        outline=(90, 130, 220, 255),
        width=max(1, size // 72),
    )

    cx = cy = size // 2
    r = size // 3
    lw = max(2, size // 28)
    # 圆环（窗口）
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=RING, width=lw)
    # 左半填充（透明度隐喻）
    d.pieslice([cx - r + lw, cy - r + lw, cx + r - lw, cy + r - lw], 90, 270, fill=HALF)
    # 中心亮点
    pr = max(2, size // 11)
    d.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=DOT)
    return img


if __name__ == '__main__':
    os.makedirs(BASE, exist_ok=True)
    make(256).save(os.path.join(BASE, 'icon.png'))
    make(32).save(os.path.join(BASE, 'tray.png'))
    print('icons written to', BASE)
