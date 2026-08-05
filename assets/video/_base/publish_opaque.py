"""Publish the vial clips: frame each master to the 280x613 bottle crop the
still photos use, scale to 420x920, and encode a small, autoplay-friendly mp4
plus a first-frame poster.  Output is keyed by PRODUCT id, not master filename.

Two framings exist.  Masters shot at the original zoom keep the shared centred
crop (`centred_window`).  Masters listed in `FIT` are framed by the bottle
itself (`fit_window`), which needs the matte, so those go through numpy instead
of a single ffmpeg filter — the bottle in them runs past the frame edge, and the
rows that are missing are padded by replicating the set.

    python publish_opaque.py            # every id in MAP
    python publish_opaque.py 1 7 9      # just these product ids
"""
import os, subprocess, sys, cv2, numpy as np, imageio_ffmpeg
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
    mp4 = os.path.join(OUT, f"{pid}.mp4")
    jpg = os.path.join(OUT, f"{pid}.jpg")

    if pid not in FIT:
        c = cv2.VideoCapture(path)
        W = int(c.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(c.get(cv2.CAP_PROP_FRAME_HEIGHT))
        c.release()
        x, y, cw, ch = centred_window((H, W))
        vf = f"crop={cw}:{ch}:{x}:{y},scale={OW}:{OH}:flags=lanczos"
        subprocess.run([FF, "-y", "-loglevel", "error", "-i", path, "-vf", vf,
                        "-an", "-c:v", "libx264", "-profile:v", "main", "-preset", "slow",
                        "-crf", "27", "-pix_fmt", "yuv420p", "-g", "48",
                        "-movflags", "+faststart", mp4], check=True)
        subprocess.run([FF, "-y", "-loglevel", "error", "-i", path, "-vf", vf,
                        "-frames:v", "1", "-q:v", "6", jpg], check=True)
        print(f"p{pid} <- {src}.mp4  centred crop {cw}x{ch}@{x},{y}  "
              f"mp4 {os.path.getsize(mp4)/1024:.0f}KB  poster {os.path.getsize(jpg)/1024:.0f}KB")
        continue

    cap = cv2.VideoCapture(path); fps = cap.get(cv2.CAP_PROP_FPS); cap.release()
    fs = read_frames(path)
    a, _, _, _ = best_matte(fs)
    rect = fit_window(a)

    p = subprocess.Popen(
        [FF, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
         "-s", f"{OW}x{OH}", "-r", f"{fps:.5f}", "-i", "-",
         "-an", "-c:v", "libx264", "-profile:v", "main", "-preset", "slow",
         "-crf", "27", "-pix_fmt", "yuv420p", "-g", "48",
         "-movflags", "+faststart", mp4], stdin=subprocess.PIPE)
    first = None
    for f in fs:
        out = cv2.resize(take(f, rect), (OW, OH), interpolation=cv2.INTER_AREA)
        if first is None: first = out
        p.stdin.write(np.ascontiguousarray(out).tobytes())
    p.stdin.close(); p.wait()
    cv2.imwrite(jpg, first, [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(f"p{pid} <- {src}.mp4  bottle fit {rect[2]}x{rect[3]}@{rect[0]},{rect[1]}  "
          f"mp4 {os.path.getsize(mp4)/1024:.0f}KB  poster {os.path.getsize(jpg)/1024:.0f}KB")
