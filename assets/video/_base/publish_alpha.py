"""Publish the transparent variant: same framing/scale as the opaque mp4, but
with the matte as an alpha channel, encoded VP9-in-WebM (yuva420p).

Fully-transparent pixels are flattened to black first. They are never drawn, but
left as the original set they cost real bits — the sparkle and gradient behind
the bottle was making the WebM twice the size of the opaque mp4. Partially
transparent edge pixels keep their true colour (straight, NOT premultiplied),
or compositing would fringe them dark.

The clip is only ever served to browsers that decode alpha, which the site
feature-detects at runtime — so nothing has to survive an alpha-blind decoder.

    python publish_alpha.py            # every id in MAP
    python publish_alpha.py 1 7 9      # just these product ids
"""
import cv2, numpy as np, os, subprocess, sys, imageio_ffmpeg
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_matte import (read_frames, best_matte, fit_window, centred_window, take,
                        MAP, FIT, OW, OH)

FF = imageio_ffmpeg.get_ffmpeg_exe()
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
BASE = HERE
OUT = os.path.join(ROOT, "assets", "video")

want = {int(a) for a in sys.argv[1:]} or set(MAP)

for pid, src in sorted(MAP.items()):
    if pid not in want:
        continue
    path = os.path.join(BASE, f"{src}.mp4")
    cap = cv2.VideoCapture(path); fps = cap.get(cv2.CAP_PROP_FPS); cap.release()
    fs = read_frames(path)
    a, plate_name, _, _ = best_matte(fs)

    # One matte serves the whole clip, so the framing is cut from it once.
    # Anything past the frame edge pads to alpha 0 — it is never drawn.
    rect = fit_window(a) if pid in FIT else centred_window(fs[0].shape)
    ac = take((a * 255).astype(np.uint8), rect, transparent=True)
    invisible = (ac < 4)[..., None]          # flatten only what is never drawn

    webm = os.path.join(OUT, f"{pid}.webm")
    p = subprocess.Popen(
        [FF, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra",
         "-s", f"{OW}x{OH}", "-r", f"{fps:.5f}", "-i", "-",
         "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0",
         "-crf", os.environ.get("VP9_CRF", "40"), "-row-mt", "1", "-cpu-used", "2", "-auto-alt-ref", "0",
         "-g", "48", webm], stdin=subprocess.PIPE)
    for f in fs:
        bgra = np.dstack([np.where(invisible, 0, take(f, rect, transparent=True)).astype(np.uint8), ac])
        p.stdin.write(np.ascontiguousarray(
            cv2.resize(bgra, (OW, OH), interpolation=cv2.INTER_AREA)).tobytes())
    p.stdin.close(); p.wait()

    # transparent poster = matted first frame, same geometry
    first = cv2.resize(np.dstack([np.where(invisible, 0, take(fs[0], rect, transparent=True)).astype(np.uint8), ac]),
                       (OW, OH), interpolation=cv2.INTER_AREA)
    png = os.path.join(OUT, f"{pid}-alpha.png")
    cv2.imwrite(png, first)
    webp = os.path.join(OUT, f"{pid}-alpha.webp")
    subprocess.run([FF, "-y", "-loglevel", "error", "-i", png,
                    "-c:v", "libwebp", "-lossless", "0", "-q:v", "80", webp], check=True)
    os.remove(png)
    print(f"p{pid} <- {src}.mp4 [{plate_name}] {'fit' if pid in FIT else 'centred'}  "
          f"webm {os.path.getsize(webm)/1024:.0f}KB  poster {os.path.getsize(webp)/1024:.0f}KB")
