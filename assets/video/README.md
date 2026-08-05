# Product vial clips

Six-second turntable loops that stand in for the still photo on the **product
card** and the **product detail page**. Cart rows and the mini-cart keep the
still — they're 48–86px tall and a clip there is wasted bandwidth.

**Drop new masters in `_base/`, not here.** `_base/N.mp4` is the render exactly
as exported; everything in this folder is generated from it.

The 2026-08-04 masters arrived named in the order they were shot, which is
**not** product order, so the publish step maps them (masters 5/6/7 are products
6/7/5). The 2026-08-05 re-renders arrived named by PRODUCT id instead, so they
are stored as **`p<id>.mp4`** and never need re-mapping: `p1` Retatrutide,
`p7` KLOW Blend, `p9` HGH 36 IU (which is now product #9 in the catalog). The
old `_base/9.mp4` is the superseded HGH render and nothing maps to it.

Both scripts take product ids, so a re-render only re-publishes its own clip:

```bash
python assets/video/_base/publish_opaque.py 1 7 9
python assets/video/_base/publish_alpha.py  1 7 9
```

## The two builds

| File | What it is | Who gets it |
|------|-----------|-------------|
| `N.webm` | VP9 **with an alpha channel** — the set is matted out, so the vial floats on the card exactly like the cut-out photo it replaced | Chrome, Edge, Firefox, Opera |
| `N-alpha.webp` | its transparent first frame, used as the poster | ” |
| `N.mp4` | H.264, the original opaque frame including its set | browsers with no alpha video (Safari) |
| `N.jpg` | its opaque first frame, used as the poster | ” |

The site decides between them at runtime and styles the box to match — the
matted clip gets the photo's drop-shadow, float and mirror reflection; the
opaque one is presented as a rounded panel instead.

**Safari is the reason there are two.** It plays VP9-in-WebM and then discards
the alpha channel, so `canPlayType` can't be trusted here. `vialAlphaSupported()`
in `js/main.js` decodes a 2-frame transparent 8×8 clip (inlined as a data URI)
into a canvas and reads the pixel back. Because clips are `preload="none"`,
that answer always lands before a single byte of video is fetched.

## Publishing

Run from anywhere; the scripts locate the repo themselves.

```bash
pip install imageio-ffmpeg opencv-python
python assets/video/_base/publish_opaque.py     # N.mp4 + N.jpg
python assets/video/_base/publish_alpha.py      # N.webm + N-alpha.webp
```

Both frame each master to the 280 × 613 bottle crop the photos use and scale it
to 420 × 920. Two framings exist, and `FIT` in `_base/make_matte.py` decides
which a product gets:

- **centred** — full frame height, output aspect, centred. What the 2026-08-04
  masters use, since they were all shot at the same zoom.
- **bottle fit** (`fit_window`, ids 1/7/9) — the crop is sized and positioned
  from the **matte's bounding box** so the vial fills 88% of the height (or 92%
  of the width, whichever binds first). The 2026-08-05 re-renders are at three
  different zooms — one landscape, one with the vial running past the bottom
  edge — and a centred crop either clips them or leaves them small. Where the
  window falls outside the frame it is padded: transparent in the matted build,
  edge-replicated in the opaque one, which is invisible on these flat sets.

The opaque build is H.264 CRF 27
(~0.3–0.7MB); the matted build is VP9 CRF 40 (~0.45–0.75MB, `VP9_CRF=` to
override). Neither has audio, and both start before the file finishes
downloading.

Then bump `VIDEO_V` in `js/main.js` — the filenames never change, so Cloudflare
will otherwise keep serving the old clip for up to four hours.

### How the matte is derived (`_base/make_matte.py`)

There is no alpha in the masters — the vials were rendered against a set — so
the background is removed by **difference matting**:

1. Find the columns the bottle occupies (in-focus detail spanning most of the
   frame height; sparkles and glow fail the height test).
2. Rebuild the background as a plate, two ways — the median frame with that
   column band interpolated across, and a cubic surface fitted to everything
   outside the band. **Whichever leaks less wins**; a bad plate can only add
   area, never remove bottle. (The diagonally-lit sets need the cubic one.)
3. Alpha = how far each pixel departs from the plate, so **glass stays
   semi-transparent**, which is what real glass does.
4. Take the **median alpha across frames**. The vial rotates about its own axis,
   so its outline is identical in every frame; anything that moves — sparkles,
   the laser sweep across the Retatrutide set — fails to survive the median.
   One matte for the whole clip also means it cannot flicker.
5. Gate it to the bottle: largest blob, holes filled, and set dressing above the
   cap trimmed (a cap's dome sits 4–12 rows above the row where it first reaches
   70% of the bottle's width — anything taller is a smoke plume).
6. Drop leading rows that are **grey**. The KLOW set has a wall corner running
   through the bottle's own columns; the plate smears that hard edge across the
   band, so a full-width slab of wall survives step 5's width test. Every vial is
   topped by a saturated violet cap and the set never is, so colour separates
   them — applied only within the top eighth of the bottle.

`make_matte.py` also writes `matte_all2.png` beside the masters: three frames of
every clip composited on the site background. **Look at it after re-publishing** —
that's where a bad matte shows up.

In the alpha build, fully-transparent pixels are flattened to black before
encoding. They're never drawn, but leaving the original set there costs real
bits. Partially-transparent edge pixels keep their true colour (straight alpha,
**not** premultiplied) or compositing would fringe them dark.

## Framing

The masters are shot at different zooms. The 2026-08-04 set keeps the shared
centred crop, so the bottle fills 79–94% of the frame depending on the clip;
the 2026-08-05 re-renders are normalised to 88% by `fit_window`, which is why
clips 1/7/9 sit slightly larger than their neighbours. Shoot new masters at a
**consistent zoom with the bottle centred, fully inside the frame** and the
question disappears — the KLOW re-render (`p7.mp4`) runs past the bottom edge,
so its base is padded rather than filmed.

If you can get the vials re-rendered **with a transparent background**, skip
`make_matte.py` entirely and encode the alpha straight from the source — a
matte recovered from a lit set will never beat one that was never lost.

## Files

| File | Master | Product | Framing |
|------|--------|---------|---------|
| `1.*` | `_base/p1.mp4` | Retatrutide | bottle fit |
| `2.*` | `_base/2.mp4` | Bacteriostatic Water | centred |
| `3.*` | `_base/3.mp4` | GHK-Cu (Copper Peptide) | centred |
| `4.*` | `_base/4.mp4` | Tesamorelin / Ipamorelin Blend | centred |
| `5.*` | `_base/7.mp4` | MOTS-C | centred |
| `6.*` | `_base/5.mp4` | BPC-157 / TB-500 Blend | centred |
| `7.*` | `_base/p7.mp4` | KLOW Blend | bottle fit |
| `8.*` | `_base/8.mp4` | NAD+ | centred |
| `9.*` | `_base/p9.mp4` | HGH 36 IU | bottle fit |
| —     | `_base/1.mp4`, `_base/6.mp4`, `_base/9.mp4` | superseded by the `p*` re-renders | — |

`VIAL_VIDEO_IDS` in `js/main.js` lists the ids that have a clip. A product added
through the admin product manager has no clip and keeps its still photo; so does
any product with an explicit `image:` field. If a clip 404s anyway, the still
photo is swapped back in (`vialVideoFallback`), so nothing renders empty.

## Playback

Clips carry `preload="none"` and only start once they scroll into view, and
pause again when they leave, so a catalog page costs its posters until you
reach a vial. They loop continuously for everyone — reduced-motion is
deliberately **not** honoured here, because the turntable is the product image
rather than decoration, and "Animation effects: off" is a common Windows setting
that would otherwise leave a large share of visitors on a still. Data Saver is
the one setting that keeps the poster and downloads nothing.

## Uploading

`_base/` is local-only — masters and scripts, ~18MB, never upload it. Upload the
generated files in this folder **before** the HTML, or Cloudflare's 4-hour asset
cache will bind the new `?v=` to the old file.
