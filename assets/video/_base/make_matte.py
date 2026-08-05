"""Matte generator, v2.

Two background plates are built and the one that leaks least is kept:
 · lerp  — median frame with the bottle band interpolated across. Right for a
           flat or vertically-graded set (most clips).
 · poly  — a cubic surface fitted to everything outside the band. Right for the
           clips lit with a diagonal sweep, where lerp leaves half the floor
           behind.
A bad plate can only ADD area (background leaking in), never remove bottle, so
"smaller opaque area wins" is a safe selector.
"""
import cv2, numpy as np, os

HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = HERE   # previews land beside the masters
SITE_BG = np.array([0x0f, 0x04, 0x07], np.float32)

# product id -> master file stem. The 2026-08-04 masters arrived named in shoot
# order (5/6/7 are products 6/7/5); the 2026-08-05 re-renders arrived named by
# PRODUCT id instead, so they are stored as `p<id>.mp4` and no longer shuffle.
MAP = {1: 'p1', 2: '2', 3: '3', 4: '4', 5: '7', 6: '5', 7: 'p7', 8: '8', 9: 'p9'}

# Ids whose master is framed by the BOTTLE (see fit_window) rather than by the
# shared centred crop. The 2026-08-05 re-renders sit at three different zooms —
# one is landscape, one has the bottle running past the frame edge — so a fixed
# centre crop either clips them or leaves them tiny.
FIT = {1, 7, 9}

OW, OH = 420, 920
ASPECT = 280 / 613


def fit_window(a, fill_h=0.88, fill_w=0.92):
    """Crop rectangle (x, y, w, h) of the output aspect that frames the bottle:
    the matte's bounding box fills `fill_h` of the height, or `fill_w` of the
    width if the bottle is the wider constraint. The rectangle MAY fall outside
    the frame — `take()` pads whatever is missing."""
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


def centred_window(shape):
    """The original framing: full frame height, output aspect, centred."""
    H, W = shape[:2]
    cw = int(round(H * ASPECT / 2) * 2)
    return ((W - cw) // 2, 0, cw, H)


def take(img, rect, transparent=False):
    """Cut `rect` out of `img`, padding past the frame edge — with zeros when
    the result carries alpha (the pad is never drawn), otherwise by replicating
    the edge, which is invisible on these near-flat sets."""
    x, y, w, h = rect
    H, W = img.shape[:2]
    l, t = max(0, -x), max(0, -y)
    r, b = max(0, x + w - W), max(0, y + h - H)
    if l or t or r or b:
        img = cv2.copyMakeBorder(img, t, b, l, r,
                                 cv2.BORDER_CONSTANT if transparent else cv2.BORDER_REPLICATE,
                                 value=0)
        x, y = x + l, y + t
    return img[y:y + h, x:x + w]


def read_frames(path):
    c = cv2.VideoCapture(path); fs = []
    while True:
        ok, im = c.read()
        if not ok: break
        fs.append(im)
    c.release(); return fs


def bottle_span(fs):
    xs0, xs1 = [], []
    for f in fs[::max(1, len(fs) // 12)]:
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        lap = np.abs(cv2.Laplacian(g.astype(np.float32), cv2.CV_32F, 3))
        m = (cv2.boxFilter(lap, -1, (15, 15)) > np.percentile(lap, 88)).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
        col = m.sum(0) / m.shape[0]
        on = col > 0.35
        best, run = (0, 0, 0), None
        for x, v in enumerate(on):
            if v and run is None: run = x
            if (not v or x == len(on) - 1) and run is not None:
                if x - run > best[0]: best = (x - run, run, x)
                run = None
        xs0.append(best[1]); xs1.append(best[2])
    return min(xs0), max(xs1)


def median_frame(fs):
    return np.median(np.stack(fs[::max(1, len(fs) // 24)]), 0).astype(np.float32)


def plate_lerp(med, x0, x1):
    p = med.copy(); pad = 14
    L = p[:, max(0, x0 - pad):x0].mean(1); R = p[:, x1:x1 + pad].mean(1)
    w = np.linspace(0, 1, x1 - x0, dtype=np.float32)[None, :, None]
    p[:, x0:x1] = L[:, None, :] * (1 - w) + R[:, None, :] * w
    return cv2.GaussianBlur(p, (0, 0), 7)


def plate_poly(med, x0, x1, deg=3):
    H, W, _ = med.shape
    ys, xs = np.mgrid[0:H, 0:W]
    xn, yn = xs / W, ys / H
    terms = [xn ** i * yn ** j for i in range(deg + 1) for j in range(deg + 1 - i)]
    A = np.stack([t.ravel() for t in terms], 1).astype(np.float32)
    keep = np.ones((H, W), bool); keep[:, max(0, x0 - 10):min(W, x1 + 10)] = False
    out = np.zeros_like(med)
    for ch in range(3):
        coef, *_ = np.linalg.lstsq(A[keep.ravel()], med[..., ch].ravel()[keep.ravel()], rcond=None)
        out[..., ch] = (A @ coef).reshape(H, W)
    return out


def matte_from(fs, pl, x0, x1):
    alphas = []
    for f in fs[::max(1, len(fs) // 20)]:
        d = np.abs(f.astype(np.float32) - pl).max(2)
        alphas.append(np.clip((d - 7) / 24.0, 0, 1))
    a = cv2.GaussianBlur(np.median(np.stack(alphas), 0), (0, 0), 1.1)
    a[:, :max(0, x0 - 8)] = 0                       # nothing lives outside the
    a[:, min(a.shape[1], x1 + 8):] = 0              # bottle's own columns

    core = cv2.morphologyEx((a > 0.4).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8))
    num, lab, st, _ = cv2.connectedComponentsWithStats(core)
    if num > 1:
        core = (lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
    # Flood the background from OUTSIDE a 1px border: a bottle whose glow
    # reaches both the top and bottom edge would otherwise cut the frame in two
    # and the whole far side would be counted as an interior hole.
    bordered = cv2.copyMakeBorder(core, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    ff = bordered.copy()
    cv2.floodFill(ff, np.zeros((bordered.shape[0] + 2, bordered.shape[1] + 2), np.uint8), (0, 0), 1)
    solid = (core | (1 - ff)[1:-1, 1:-1]).astype(np.uint8)
    # Trim set dressing above the cap (light wisps/smoke on some sets): the
    # bottle's own rows are wide, a wisp's are not. Only the top is trimmed —
    # the narrow rows below the base are its reflection, which we keep.
    prof = solid.sum(1).astype(np.float32)
    if prof.max() > 0:
        nz = np.where(prof > 0)[0]
        wide = np.where(prof > 0.70 * prof.max())[0]
        if len(nz) and len(wide):
            # A cap's dome sits 4–12 rows above the row where it first reaches
            # 70% of the bottle's width. Anything taller than that is a plume.
            if wide.min() - nz.min() > 20:
                cut = max(0, wide.min() - 3)
                solid[:cut] = 0
                a[:cut] = 0
        # Trim a leaked slab of SET above the cap. The 2026-08-05 KLOW set has a
        # wall corner running through the bottle's columns: the plate smears that
        # hard edge across the band, so the frame departs from it and a full-width
        # block of grey wall survives the width test above. Colour separates them —
        # every vial is topped by a saturated violet cap, and the set never is —
        # so leading rows that are grey are dropped, but only within the top
        # eighth of the bottle, where a leak can plausibly sit.
        sat = cv2.cvtColor(fs[len(fs) // 2], cv2.COLOR_BGR2HSV)[..., 1]
        rows = np.where(solid.sum(1) > 0)[0]
        if len(rows):
            for r in rows[:max(1, len(rows) // 8)]:
                px = sat[r][solid[r] > 0]
                if len(px) and (px > 60).mean() >= 0.15:
                    break
                solid[r] = 0
                a[r] = 0

    gate = cv2.GaussianBlur(cv2.dilate(solid, np.ones((5, 5), np.uint8)) * 255.0, (0, 0), 2.5) / 255.0
    inner = cv2.GaussianBlur(cv2.erode(solid, np.ones((5, 5), np.uint8)) * 255.0, (0, 0), 1.6) / 255.0
    return np.clip(np.maximum(a * gate, inner), 0, 1)


def best_matte(fs):
    x0, x1 = bottle_span(fs)
    med = median_frame(fs)
    cands = [('lerp', matte_from(fs, plate_lerp(med, x0, x1), x0, x1)),
             ('poly', matte_from(fs, plate_poly(med, x0, x1), x0, x1))]
    name, a = min(cands, key=lambda c: (c[1] > 0.9).mean())
    return a, name, x0, x1


if __name__ == '__main__':
    strips = []
    for pid, src in sorted(MAP.items()):
        fs = read_frames(os.path.join(HERE, f"{src}.mp4"))
        a, name, x0, x1 = best_matte(fs)
        np.save(os.path.join(SCRATCH, f"alpha{pid}.npy"), a.astype(np.float32))
        cells = []
        for f in (fs[1], fs[len(fs) // 2], fs[-2]):
            cells.append((f.astype(np.float32) * a[..., None] + SITE_BG * (1 - a[..., None])).astype(np.uint8))
        s = 300 / fs[0].shape[0]
        strip = np.hstack([cv2.resize(c, (int(fs[0].shape[1] * s), 300)) for c in cells])
        cv2.putText(strip, f"p{pid}/{name}", (8, 34), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 3)
        strips.append(strip)
        print(f"p{pid} master {src}: plate={name} span {x0}-{x1} opaque {100*(a>0.9).mean():.1f}%")
    w = max(s.shape[1] for s in strips)
    cv2.imwrite(os.path.join(SCRATCH, "matte_all2.png"),
                np.vstack([np.pad(s, ((0, 0), (0, w - s.shape[1]), (0, 0))) for s in strips]))
