"""Publish the site's vial stills from the masters in this folder.

Each master is one bottle photographed on a flat near-white set. The site puts
it on a near-black card, so the set has to go: a flat background plate is
subtracted, the difference becomes the alpha, and the result is framed by the
bottle itself (not by a fixed crop) so masters shot at different zooms still
come out matched.

    python assets/vials/_base/publish.py         # all nine
    python assets/vials/_base/publish.py 3 7     # or just these ids

Writes ../N.webp (what the site loads) and ../N.png (the onerror fallback,
quantized), plus a contact sheet at _base/matte_check.png composited on the
site background — check that one before shipping. Bump VIAL_V in js/main.js
afterwards; the filenames never change, so Cloudflare would otherwise keep
serving the old artwork.
"""
import os
import sys

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)

IDS = range(1, 10)
OW, OH = 420, 920
ASPECT = OW / OH
SITE_BG = np.array([0x0f, 0x04, 0x07], np.float32)   # BGR of --dark-bg

# Alpha ramp over the distance from the background plate. Below LO the pixel is
# set, above HI it is bottle; the glass edges live in between.
LO, HI = 6.0, 26.0


def plate(img):
    """The set, as a slow gradient fitted to the border. These are lit flat but
    not perfectly evenly, and a single median colour leaves one corner ~3 levels
    off, which shows up as a haze once alpha is stretched from it."""
    H, W = img.shape[:2]
    band = np.zeros((H, W), bool)
    m = int(round(min(H, W) * 0.06))
    band[:m], band[-m:], band[:, :m], band[:, -m:] = True, True, True, True
    ys, xs = np.mgrid[0:H, 0:W]
    xn, yn = xs / W, ys / H
    terms = [np.ones_like(xn), xn, yn, xn * yn, xn ** 2, yn ** 2]
    A = np.stack([t.ravel() for t in terms], 1).astype(np.float32)
    out = np.zeros_like(img, np.float32)
    for ch in range(3):
        coef, *_ = np.linalg.lstsq(A[band.ravel()], img[..., ch].ravel()[band.ravel()], rcond=None)
        out[..., ch] = (A @ coef).reshape(H, W)
    return out


def matte(img):
    d = np.abs(img.astype(np.float32) - plate(img)).max(2)
    a = np.clip((d - LO) / (HI - LO), 0, 1)
    a = cv2.GaussianBlur(a, (0, 0), 1.0)

    # The bottle is the one big thing in frame; specks of set noise are not.
    core = cv2.morphologyEx((a > 0.45).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    num, lab, st, _ = cv2.connectedComponentsWithStats(core)
    if num > 1:
        core = (lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
    # Fill the interior: clear glass reads as set, so the body of the bottle is
    # a hole in `core`. Flood from outside a 1px border rather than from a
    # corner, so a bottle touching an edge can't split the background in two.
    bordered = cv2.copyMakeBorder(core, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    ff = bordered.copy()
    cv2.floodFill(ff, np.zeros((bordered.shape[0] + 2, bordered.shape[1] + 2), np.uint8), (0, 0), 1)
    solid = (core | (1 - ff)[1:-1, 1:-1]).astype(np.uint8)

    # Drop the cast shadow. It is attached to the base, so it survives as part
    # of the bottle's component and would land on the card as a grey smear.
    # Shadow is set-coloured but darker; glass is not. Only rows below the widest
    # part of the base are eligible, so nothing on the bottle itself is at risk.
    prof = solid.sum(1).astype(np.float32)
    rows = np.where(prof > 0)[0]
    if len(rows):
        base = rows[int(len(rows) * 0.86):]
        for r in base:
            px = solid[r] > 0
            if px.sum() and prof[r] < 0.45 * prof.max():
                solid[r] = 0
                a[r] = 0

    gate = cv2.GaussianBlur(cv2.dilate(solid, np.ones((5, 5), np.uint8)) * 255.0, (0, 0), 2.5) / 255.0
    inner = cv2.GaussianBlur(cv2.erode(solid, np.ones((7, 7), np.uint8)) * 255.0, (0, 0), 1.6) / 255.0
    return np.clip(np.maximum(a * gate, inner), 0, 1)


def fit_window(a, fill_h=0.90, fill_w=0.92):
    """Crop rectangle (x, y, w, h) of the output aspect that frames the bottle:
    its bounding box fills `fill_h` of the height, or `fill_w` of the width when
    the bottle is the wider constraint. May fall outside the frame — take() pads
    whatever is missing, and the pad is transparent."""
    ys, xs = np.where(a > 0.5)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    ch = (y1 - y0) / fill_h
    cw = ch * ASPECT
    if (x1 - x0) / cw > fill_w:
        cw = (x1 - x0) / fill_w
        ch = cw / ASPECT
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    return (int(round(cx - cw / 2)), int(round(cy - ch / 2)),
            int(round(cw)), int(round(ch)))


def take(img, rect):
    x, y, w, h = rect
    H, W = img.shape[:2]
    l, t = max(0, -x), max(0, -y)
    r, b = max(0, x + w - W), max(0, y + h - H)
    if l or t or r or b:
        img = cv2.copyMakeBorder(img, t, b, l, r, cv2.BORDER_CONSTANT, value=0)
        x, y = x + l, y + t
    return img[y:y + h, x:x + w]


def publish(pid):
    img = cv2.imread(os.path.join(HERE, f"{pid}.png"), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"missing master: assets/vials/_base/{pid}.png")
    a = matte(img)
    rect = fit_window(a)
    rgba = np.dstack([img, (a * 255).round().astype(np.uint8)])
    cut = cv2.resize(take(rgba, rect), (OW, OH), interpolation=cv2.INTER_AREA)
    # Premultiplied edges would fringe against the dark card, so keep the colour
    # straight and let the encoder carry alpha beside it.
    cv2.imwrite(os.path.join(OUT, f"{pid}.webp"), cut, [cv2.IMWRITE_WEBP_QUALITY, 82])
    # The fallback only ever loads on a browser too old for WebP, so trade its
    # colour depth for size: 256 colours takes it from ~600KB to ~50KB, and the
    # bottle is mostly greys anyway.
    Image.fromarray(cv2.cvtColor(cut, cv2.COLOR_BGRA2RGBA)) \
        .quantize(colors=256, method=Image.FASTOCTREE) \
        .save(os.path.join(OUT, f"{pid}.png"), 'PNG', optimize=True)
    return cut


def contact(cuts):
    cells = []
    for pid, c in cuts:
        al = c[..., 3:4].astype(np.float32) / 255.0
        flat = (c[..., :3].astype(np.float32) * al + SITE_BG * (1 - al)).astype(np.uint8)
        cell = cv2.resize(flat, (int(OW * 320 / OH), 320))
        cv2.putText(cell, str(pid), (6, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2)
        cells.append(cell)
    cv2.imwrite(os.path.join(HERE, "matte_check.png"), np.hstack(cells))


if __name__ == '__main__':
    ids = [int(x) for x in sys.argv[1:]] or list(IDS)
    cuts = []
    for pid in ids:
        c = publish(pid)
        cuts.append((pid, c))
        op = (c[..., 3] > 240).mean()
        print(f"{pid}: {os.path.getsize(os.path.join(OUT, f'{pid}.webp')) // 1024}KB webp, opaque {100 * op:.1f}%")
    contact(cuts)
