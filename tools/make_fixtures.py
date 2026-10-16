"""exe 版（../saikobo）の色調補正・フィルターで期待値の PNG を作る（Web 版の移植が同じ結果か確かめる用）。
python tools/make_fixtures.py → tools/fixtures/（git には入れない）。selftest.js の「exe と同じ結果」が使う。"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "saikobo" / "src"))
from saikobo.core import adjust  # noqa: E402

OUT = HERE / "fixtures"
OUT.mkdir(exist_ok=True)

# 64x48: 色相の横グラデーション×明るさの縦グラデーション＋縞、右下は半透明
h, w = 48, 64
y, x = np.mgrid[0:h, 0:w].astype(np.float32)
hue = x / w * 6
r = np.clip(np.abs(hue - 3) - 1, 0, 1)
g = np.clip(2 - np.abs(hue - 2), 0, 1)
b = np.clip(2 - np.abs(hue - 4), 0, 1)
v = 0.25 + 0.75 * (y / h)
img = np.dstack([r * v, g * v, b * v]) * 255
img[(x.astype(int) // 6) % 2 == 0] *= 0.85
alpha = np.full((h, w), 255, np.float32)
alpha[30:, 40:] = 140
src = np.dstack([img, alpha]).round().clip(0, 255).astype(np.uint8)
Image.fromarray(src, "RGBA").save(OUT / "input.png")

CASES = [
    ("brightness_contrast", {"brightness": 40, "contrast": 30}),
    ("levels", {"in_black": 20, "in_white": 220, "gamma": 1.4, "out_black": 10, "out_white": 240, "channel": "rgb"}),
    ("levels", {"in_black": 0, "in_white": 200, "gamma": 0.8, "out_black": 0, "out_white": 255, "channel": "green"}),
    ("curves", {"points": [[0, 0], [70, 40], [180, 210], [255, 255]], "channel": "rgb"}),
    ("exposure", {"exposure": 0.7, "offset": 0.01, "gamma": 1.1}),
    ("vibrance", {"vibrance": 50, "saturation": -10}),
    ("hue_saturation", {"hue": 40, "saturation": 30, "lightness": -15, "colorize": False}),
    ("hue_saturation", {"hue": 200, "saturation": 50, "lightness": 10, "colorize": True}),
    ("color_balance", {"cyan_red": 30, "magenta_green": -20, "yellow_blue": 15, "preserve_luminosity": True}),
    ("black_white", {"reds": 40, "yellows": 60, "greens": 40, "cyans": 60, "blues": 20, "magentas": 80}),
    ("photo_filter", {"color": "#ec8a00", "density": 40, "preserve_luminosity": True}),
    ("invert", {}),
    ("desaturate", {}),
    ("posterize", {"levels": 5}),
    ("threshold", {"level": 110}),
    ("auto_contrast", {"clip": 0.5}),
    ("gaussian_blur", {"radius": 3.0}),
    ("unsharp_mask", {"amount": 120, "radius": 1.5, "threshold": 0}),
    ("high_pass", {"radius": 4.0}),
    ("mosaic", {"cell": 8}),
    ("vignette", {"amount": -60, "midpoint": 40, "feather": 50}),
    ("emboss", {"angle": 135, "height": 3, "amount": 100}),
    ("find_edges", {}),
]
index = []
for i, (key, params) in enumerate(CASES):
    spec = adjust.find_spec(key)
    out = spec.fn(src.copy(), **params)
    name = f"{i:02d}_{key}.png"
    Image.fromarray(out, "RGBA").save(OUT / name)
    index.append({"key": key, "params": params, "file": name})
(OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
print(len(index), "cases ->", OUT)
