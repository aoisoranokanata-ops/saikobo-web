"""exe 版（../saikobo）のコードで「いろいろ入った作品」を作って .sko に保存し、exe の合成結果も PNG にする。
Web 版で開いて合成し、同じ絵になるかを比べる用。  python tools/make_sko_fixture.py → tools/fixtures/exe_sample.sko と exe_sample.png

逆向き（Web で書き出した .sko を exe で開いて合成）: python tools/make_sko_fixture.py --check <web.sko> <web の合成.png>
"""

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "saikobo" / "src"))
from saikobo.core import fileio  # noqa: E402
from saikobo.core.adjust import ADJUSTMENTS  # noqa: E402
from saikobo.core.document import Document, Layer, empty_view  # noqa: E402
from saikobo.core import styles as st  # noqa: E402

OUT = HERE / "fixtures"
W, H = 240, 180


def rgba(fill=(0, 0, 0, 0)):
    a = np.zeros((H, W, 4), np.uint8)
    a[:] = fill
    return a


def circle(cx, cy, r, color):
    y, x = np.mgrid[0:H, 0:W]
    d = np.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2)
    a = np.clip(r - d + 0.5, 0, 1)
    px = rgba()
    px[..., :3] = color
    px[..., 3] = (a * 255).round().astype(np.uint8)
    return px


def build() -> Document:
    doc = Document(W, H, name="exe_sample")
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    grad = rgba((0, 0, 0, 255))
    grad[..., 0] = (x / W * 255).astype(np.uint8)
    grad[..., 1] = (y / H * 200).astype(np.uint8)
    grad[..., 2] = 160
    A = Layer("グラデ", grad)
    A.mask = np.clip(x / W * 255 * 1.4, 0, 255).astype(np.uint8)              # 左ほど隠れる
    doc.layers.append(A)

    G = Layer("グループ", empty_view(W, H))
    G.group = {"collapsed": False}
    G.blend = "normal"
    G.opacity = 0.85
    doc.layers.append(G)
    C = Layer("円", circle(80, 90, 45, (250, 190, 40)))
    C.parent = G.id
    C.styles = st.normalize({"stroke": {"size": 4, "color": "#20c060", "position": "outside"},
                             "drop_shadow": {"distance": 8, "size": 6, "angle": 120, "opacity": 70}})
    S = Layer("しま", rgba())
    S.pixels[:, ::12, :] = (255, 255, 255, 120)
    S.pixels[:, 1::12, :] = (255, 255, 255, 120)
    S.parent = G.id
    S.clip = True
    HS = Layer("色相", empty_view(W, H))
    HS.adjustment = {"key": "hue_saturation", "params": {"hue": 30, "saturation": 20, "lightness": 0, "colorize": False}}
    HS.parent = G.id
    # グループの中身はグループ本体の真下に並ぶ: [C, S, HS, G]
    doc.layers.remove(G)
    doc.layers += [C, S, HS, G]

    P = Layer("通過", empty_view(W, H))
    P.group = {"collapsed": False}
    P.blend = "pass_through"
    CV = Layer("カーブ", empty_view(W, H))
    CV.adjustment = {"key": "curves", "params": {"channel": "rgb", "points": [[0, 0], [90, 60], [190, 220], [255, 255]]}}
    CV.parent = P.id
    M = Layer("乗算", circle(170, 70, 40, (60, 120, 255)))
    M.blend = "multiply"
    M.opacity = 0.7
    M.parent = P.id
    doc.layers += [CV, M, P]

    T = Layer("文字", rgba())
    T.pixels[140:160, 120:220] = (255, 255, 255, 255)                          # 文字の代わりの画素（exe は保存した画素を使う）
    T.text = {"text": "Saikobo", "font": "", "size": 24.0, "color": "#ffffff", "bold": True, "italic": False,
              "align": "left", "line_spacing": 1.2, "matrix": [1.0, 0.0, 0.0, 1.0, 120.0, 136.0]}
    T.styles = st.normalize({"outer_glow": {"size": 6, "color": "#ffd27f", "opacity": 80}})
    doc.layers.append(T)

    LV = Layer("レベル", empty_view(W, H))
    LV.adjustment = {"key": "levels", "params": {"channel": "rgb", "in_black": 20, "in_white": 235, "gamma": 1.1,
                                                  "out_black": 0, "out_white": 255}}
    LV.mask = np.zeros((H, W), np.uint8)
    LV.mask[:, W // 2:] = 255                                                  # 右半分だけ
    doc.layers.append(LV)
    doc.active_id = T.id
    return doc


def main():
    OUT.mkdir(exist_ok=True)
    if len(sys.argv) >= 4 and sys.argv[1] == "--check":
        doc = fileio.load_native(sys.argv[2])
        exe = doc.composite().astype(np.int16)
        web = np.array(Image.open(sys.argv[3]).convert("RGBA")).astype(np.int16)
        d = np.abs(exe - web)
        print(f"web→exe: レイヤー {len(doc.layers)} 枚, 平均差 {d.mean():.2f}, 最大差 {d.max()}, "
              f"8 を超える画素 {(d.max(axis=2) > 8).mean() * 100:.2f}%")
        Image.fromarray(exe.astype(np.uint8), "RGBA").save(OUT / "web_sample_exe_composite.png")
        names = [(l.name, l.kind, l.parent is not None, l.clip, l.mask is not None, bool(l.styles)) for l in doc.layers]
        print(names)
        return
    doc = build()
    fileio.save_native(doc, OUT / "exe_sample.sko")
    Image.fromarray(doc.composite(), "RGBA").save(OUT / "exe_sample.png")
    print("saved", OUT / "exe_sample.sko", [l.name for l in doc.layers])


if __name__ == "__main__":
    main()
