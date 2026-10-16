"""アイコン PNG を作る（exe 版 saikobo/ui/icons.py の app_icon と同じ絵: 紺の地に虹色の輪）。
iOS は角を自分で丸めるので、地は四角いまま塗りつぶす。  python tools/make_icons.py"""

from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "icons"
COLORS = ["#ff5a5f", "#ffb347", "#ffe066", "#7bd389", "#4cc9f0", "#7b6cf6", "#f15bb5", "#ff5a5f"]


def hexrgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float64)


def render(size, ss=4):
    n = size * ss
    y, x = np.mgrid[0:n, 0:n] + 0.5
    c = n / 2
    dx, dy = x - c, y - c
    r = np.hypot(dx, dy) / n * 64          # 64 単位の座標系での半径
    # Qt の円錐グラデーション: 90°（上）から反時計回り
    ang = (np.degrees(np.arctan2(-dy, dx)) - 90) % 360 / 360
    stops = np.linspace(0, 1, len(COLORS))
    cols = np.stack([hexrgb(h) for h in COLORS])
    rgb = np.stack([np.interp(ang, stops, cols[:, k]) for k in range(3)], axis=-1)
    bg = hexrgb("#1f2430")
    img = np.empty((n, n, 3))
    img[:] = bg
    ring = (r <= 22 * 1.08) & (r >= 10 * 1.08)        # 少し大きめ（ホーム画面で見やすく）
    img[ring] = rgb[ring]
    small = img.reshape(size, ss, size, ss, 3).mean(axis=(1, 3))
    return Image.fromarray(small.round().astype(np.uint8), "RGB")


OUT.mkdir(exist_ok=True)
for name, size in [("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180)]:
    render(size).save(OUT / name, optimize=True)
    print(OUT / name)
