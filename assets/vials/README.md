# Product vial photos

**These are generated from the video masters — there is no separate photo
render any more.** As of 2026-08-06 every `N.webp` + `N.png` here is the matted
first frame of `assets/video/_base/p<id>.mp4`, cut with exactly the rectangle the
clip uses and scaled to 280×613. The site loads `N.webp`; the quantized `N.png`
beside it is the `onerror` fallback.

That is deliberate. The old stills came from their own 1440×720 render (`_base/`,
2026-08-03) whose label artwork drifted from the footage — gold caps against the
clip's violet ones, and a tight crop that ran the product name off the label —
so a cart row showed a visibly different bottle than the card above it.

To republish after replacing a master (which now means replacing the **video**
master):

```bash
python assets/video/_base/publish_still.py        # all nine
python assets/video/_base/publish_still.py 3 7    # or just these ids
```

then quantize the fallback PNGs, which the script writes full-colour:

```python
from PIL import Image
for i in range(1, 10):
    Image.open(f'{i}.png').convert('RGBA') \
        .quantize(colors=256, method=Image.FASTOCTREE) \
        .save(f'{i}.png', 'PNG', optimize=True)     # ~155KB -> ~34KB
```

Then bump `VIAL_V` in `js/main.js` (and the `?v=` in `admin-products.html`) —
the filenames never change, so Cloudflare will otherwise serve the old artwork.
`.vial-photo`'s `aspect-ratio` in `css/styles.css` must match the 280×613 crop.

`_base/` (the superseded 2026-08-03 photo render) and `_superseded/` (the stills
published from it) are local-only history; nothing reads them.

Files are named by **product id**:

| File           | Product                          |
|----------------|----------------------------------|
| `1.png`        | Retatrutide                      |
| `2.png`        | Bacteriostatic Water             |
| `3.png`        | GHK-Cu (Copper Peptide)          |
| `4.png`        | Tesamorelin / Ipamorelin Blend   |
| `5.png`        | MOTS-C                           |
| `6.png`        | BPC-157 / TB-500 Blend           |
| `7.png`        | KLOW Blend                       |
| `8.png`        | NAD+                             |
| `9.png`        | HGH 36 IU                        |

These photos are used across the whole site — cart rows, the mini-cart, the
detail-page thumbnail, and as the fallback wherever a product has no clip. On
the product card and the product detail page the turntable clip in
`assets/video/` now plays in their place (see that folder's README).

## Tips
- Framing is no longer a shared crop box — `fit_window` sizes each one from its
  own matte, so masters at different zooms still come out matched.
- Export the bottle at **≥1200px tall** if you can. The 2026-08-06 video masters
  put it at ~860px, still short of 2× the 560px detail-page slot, so it softens
  a little on high-DPI screens.
- Any product without a file here automatically falls back to the generic vial
  with the generated Aura label, so the site never shows a broken image.

To use a different filename for a product, set an `image:` field on that product
in `js/products-data.js` (e.g. `image: 'assets/vials/retatrutide.png'`).
