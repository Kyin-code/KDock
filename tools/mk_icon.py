# -*- coding: utf-8 -*-
"""KDock 图标（定稿版）：回到"圆角方块 + 一圈留白"的做法，但把白边收窄；不透明、四角是图里自带的浅色底。

- 上一版为了去白边做成"四角透明"，结果抠轮廓时把方块内部的白色（K、卡片）也当成背景挖掉了 —— 整个图标炸了。
  这版不做透明：按行把方块内部填实（K/卡片都是"洞"），只裁方块本身 + 2% 留白。
- 依据：Microsoft 图标规范说 shape 要尽量占满 48x48 网格、不要自己加大留白，所以留白只留一点点。
"""
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'assets', 'kdock-logo.png')
OUT = os.path.join(ROOT, 'src-tauri', 'icons')
MARGIN = 0.02

img = Image.open(SRC).convert('RGB')
A = np.asarray(img).astype(np.float32)
L = A.mean(axis=2)
H, W = L.shape
ring = np.concatenate([L[0:16, :].ravel(), L[-16:, :].ravel(), L[:, 0:16].ravel(), L[:, -16:].ravel()])
cream = float(np.median(ring))
sil = L < cream - 25

# 1) 去掉下方那行字：只保留"整行里有一段很长连续暗区"的行，并按行把这一段的中间填实
keep = np.zeros(H, bool)
runs_of_row = []
for y in range(H):
    idx = np.nonzero(sil[y])[0]
    if len(idx) == 0:
        runs_of_row.append(None); continue
    runs = np.split(idx, np.nonzero(np.diff(idx) > 1)[0] + 1)
    longest = max(runs, key=len)
    if len(longest) > 0.25 * W:
        keep[y] = True
        runs_of_row.append((int(longest[0]), int(longest[-1])))
    else:
        runs_of_row.append(None)
for y in range(H):
    if keep[y] and runs_of_row[y]:
        x0, x1 = runs_of_row[y]
        sil[y, x0:x1 + 1] = True
sil[~keep] = False

ys, xs = np.nonzero(sil)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
w, h = x1 - x0 + 1, y1 - y0 + 1
m = int(round(MARGIN * min(w, h)))
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
half = max(w, h) / 2 + m
bx0, by0 = int(round(cx - half)), int(round(cy - half))
side = int(round(2 * half))
bx0 = max(0, min(bx0, W - side)); by0 = max(0, min(by0, H - side))
crop = img.crop((bx0, by0, bx0 + side, by0 + side))
print('方块 %dx%d  (留白 %dpx, 共 %d)  cream=%.0f' % (w, h, m, side, cream))
print('四角（应仍是浅色底，不透明）:', [tuple(int(v) for v in crop.getpixel(p)) for p in
      [(0, 0), (side - 1, 0), (0, side - 1), (side - 1, side - 1)]])

big = crop.resize((1024, 1024), Image.LANCZOS)
os.makedirs(OUT, exist_ok=True)
big.save(os.path.join(OUT, 'icon.ico'), format='ICO',
         sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
big.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, 'icon.png'))
sm = np.asarray(big.resize((16, 16), Image.LANCZOS).convert('L')).astype(int)
print('16x16 亮度 %d..%d' % (sm.min(), sm.max()))
for r in sm:
    print('   ' + ''.join('#' if v > 170 else ('+' if v > 110 else ('.' if v > 60 else ' ')) for v in r))
print('ico bytes', os.path.getsize(os.path.join(OUT, 'icon.ico')))
