"""Publish the still vial photos from the same masters as the clips.

`assets/vials/N.webp` used to come from a separate 1440x720 render whose label
artwork no longer matches the turntable footage, so the still and the clip
showed two different bottles. Both now come from the same master: the still is
the matted first frame, framed by exactly the rectangle `publish_alpha.py` uses,
scaled to the 280x613 box the site's `.vial-photo` aspect-ratio expects.

    python publish_still.py            # every id in MAP
    python publish_still.py 3 7        # just these product ids

Then bump `VIAL_V` in js/main.js and the `?v=` in admin-products.html.
"""
import cv2, numpy as np, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_matte import read_frames, best_matte, fit_window, centred_window, take, MAP, FIT

SW, SH = 280, 613
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = os.path.join(ROOT, "assets", "vials")

want = {int(a) for a in sys.argv[1:]} or set(MAP)

for pid, src in sorted(MAP.items()):
    if pid not in want:
        continue
    fs = read_frames(os.path.join(HERE, f"{src}.mp4"))
    a, plate, _, _ = best_matte(fs)
    rect = fit_window(a) if pid in FIT else centred_window(fs[0].shape)

    ac = take((a * 255).astype(np.uint8), rect, transparent=True)
    rgb = take(fs[0], rect, transparent=True)
    # Straight alpha, not premultiplied — the site composites these over a dark
    # page and premultiplied edges would fringe black.
    bgra = cv2.resize(np.dstack([np.where((ac < 4)[..., None], 0, rgb).astype(np.uint8), ac]),
                      (SW, SH), interpolation=cv2.INTER_AREA)

    webp = os.path.join(OUT, f"{pid}.webp")
    cv2.imwrite(webp, bgra, [cv2.IMWRITE_WEBP_QUALITY, 88])
    # A quantized PNG of the same crop sits beside it for the onerror fallback.
    png = os.path.join(OUT, f"{pid}.png")
    cv2.imwrite(png, bgra, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    print(f"p{pid} <- {src}.mp4 [{plate}]  webp {os.path.getsize(webp)/1024:.0f}KB  "
          f"png {os.path.getsize(png)/1024:.0f}KB")
