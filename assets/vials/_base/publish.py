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
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)

IDS = range(1, 10)
# Two widths of the same crop. The masters carry ~685x1500 of real detail inside
# the crop box, so 630x1380 is as sharp as the artwork gets — no upscaling — and
# covers the product page at 2x. 420x920 covers a card or a cart row at 2x for a
# third of the bytes; main.js offers both through srcset and the browser picks.
OW, OH = 630, 1380
SW, SH = 420, 920
ASPECT = OW / OH
SITE_BG = np.array([0x0f, 0x04, 0x07], np.float32)   # BGR of --dark-bg

# Alpha ramp over the distance from the background plate. Below LO the pixel is
# set, above HI it is bottle; the glass edges live in between.
LO, HI = 6.0, 26.0

# The acquiring bank underwrites this catalogue as research-use-only supply and
# asked for that to be unmissable on the product photo itself — the vial label
# carries the line, but at card size it is a few pixels tall. So the bottle is
# framed into the upper part of the canvas and a stamped band takes the strip
# below it. It is drawn here rather than in CSS on purpose: the requirement is
# about the photo, and the photo travels (cart rows, order emails, screenshots
# a reviewer takes) without the page's markup.
# Set over two lines, not one: the canvas is narrow (630x1380), so a single
# 21-character line can only be about half the size the shorter lines reach —
# and half the size is what the bank objected to in the first place.
RUO_LINES = ["FOR RESEARCH", "USE ONLY"]
BAND_BOT = 0.985                       # the pill's baseline, as a fraction of H
BAND_INSET = 0.035                     # fraction of the canvas width, each side
BAND_FILL = (7, 4, 15, 246)            # RGBA — the site's --dark-bg, near-solid
BAND_EDGE = (212, 175, 55, 255)        # the brand gold
BAND_TEXT = (247, 240, 214, 255)       # warm off-white; gold-on-black type at
                                       # this size reads muddy once WebP is done
TRACK = 0.07                           # letter-spacing, in ems
# The type is set as large as the canvas width allows and the pill is then sized
# to it, rather than the other way round — a fixed band would leave the type
# floating in it, which is exactly the complaint this band answers.
BAND_PAD_X, BAND_PAD_Y = 0.85, 0.40    # padding around the type, in ems
BAND_LEADING = 1.14                    # line height, in ems
BAND_RADIUS = 0.55                     # corner radius, in ems
# Bottle framing. Smaller than a full-bleed crop so the band has its own strip
# and never sits over glass; the bottle is pushed up by the same amount.
FILL_H, FILL_W = 0.78, 0.88
BOTTLE_CENTER = 0.415                  # where the bbox centre lands vertically

FONT_CANDIDATES = [
    "arialbd.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf",
    "LiberationSans-Bold.ttf", "Helvetica-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def _font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    raise SystemExit("no bold TrueType font found — add one to FONT_CANDIDATES")


def _tracked(draw, font, text, track):
    """Width of `text` drawn with `track` px of extra space between glyphs."""
    return sum(draw.textlength(c, font=font) for c in text) + track * (len(text) - 1)


def stamp(bgra):
    """Draw the research-use-only band into the bottom strip of a BGRA cut.

    Done per output size rather than once and resized, so the type is rendered
    at the pixel size it ships at and stays crisp on the small card image."""
    H, W = bgra.shape[:2]
    im = Image.fromarray(cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGBA))
    d = ImageDraw.Draw(im)

    # Largest size whose widest line still fits between the insets, padding
    # included.
    budget = W * (1 - 2 * BAND_INSET)
    size = max(9, int(H * 0.12))
    while size > 9:
        font = _font(size)
        widest = max(_tracked(d, font, ln, size * TRACK) for ln in RUO_LINES)
        if widest + 2 * size * BAND_PAD_X <= budget:
            break
        size -= 1
    font, track = _font(size), size * TRACK
    widths = [_tracked(d, font, ln, track) for ln in RUO_LINES]

    # Cap height of the type, measured off the glyphs actually being set, so the
    # block is optically centred rather than centred on the font's line box.
    boxes = [d.textbbox((0, 0), ln, font=font) for ln in RUO_LINES]
    top, bottom = min(b[1] for b in boxes), max(b[3] for b in boxes)
    leading = size * BAND_LEADING
    block = (bottom - top) + leading * (len(RUO_LINES) - 1)

    bh = block + 2 * size * BAND_PAD_Y
    bw = max(widths) + 2 * size * BAND_PAD_X
    x0, x1 = (W - bw) / 2, (W + bw) / 2
    y1 = H * BAND_BOT
    y0 = y1 - bh
    edge = max(2, int(round(size * 0.06)))
    d.rounded_rectangle([x0, y0, x1, y1], radius=size * BAND_RADIUS,
                        fill=BAND_FILL, outline=BAND_EDGE, width=edge)

    # Draw glyph by glyph: PIL has no letter-spacing, and the tracking is what
    # keeps short shouted lines from reading as dense blocks at card size.
    y = (y0 + y1) / 2 - block / 2 - top
    for ln, tw in zip(RUO_LINES, widths):
        x = (W - tw) / 2
        for c in ln:
            d.text((x, y), c, font=font, fill=BAND_TEXT)
            x += d.textlength(c, font=font) + track
        y += leading

    return cv2.cvtColor(np.array(im), cv2.COLOR_RGBA2BGRA)


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
    x, y, w, h = fit_window(a, FILL_H, FILL_W)
    # fit_window centres the bottle; slide the crop down so it sits high enough
    # for the research-use-only band to have the strip underneath to itself.
    rect = (x, y + int(round((0.5 - BOTTLE_CENTER) * h)), w, h)
    rgba = np.dstack([img, (a * 255).round().astype(np.uint8)])
    full = take(rgba, rect)
    cut = stamp(cv2.resize(full, (OW, OH), interpolation=cv2.INTER_AREA))
    small = stamp(cv2.resize(full, (SW, SH), interpolation=cv2.INTER_AREA))
    # Premultiplied edges would fringe against the dark card, so keep the colour
    # straight and let the encoder carry alpha beside it. Quality 90: the label's
    # fine type and the glass gradients are what this artwork is for, and WebP
    # spends the bytes on exactly those.
    cv2.imwrite(os.path.join(OUT, f"{pid}.webp"), cut, [cv2.IMWRITE_WEBP_QUALITY, 90])
    cv2.imwrite(os.path.join(OUT, f"{pid}-sm.webp"), small, [cv2.IMWRITE_WEBP_QUALITY, 86])
    # The fallback only ever loads on a browser too old for WebP (pre-2020), so
    # trade its colour depth for size: 256 colours takes it from ~600KB to ~60KB,
    # and the bottle is mostly greys anyway.
    Image.fromarray(cv2.cvtColor(small, cv2.COLOR_BGRA2RGBA)) \
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
