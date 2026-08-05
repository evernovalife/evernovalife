# Product vial photos

**Drop new masters in `_base/`, not here.** `_base/N.png` holds the render exactly
as exported; `N.webp` + `N.png` in this folder are the published, bottle-cropped
web copies generated from it. The site loads `N.webp`.

Current masters (2026-08-03, black/gold/violet label) are 1440×720 with the
bottle at bbox **580,54 → 860,667**. To republish after replacing a master:

```python
from PIL import Image
BOX = (580, 54, 860, 667)          # re-derive if the render framing changes
for i in range(1, 9):
    im = Image.open(f'_base/{i}.png').convert('RGBA').crop(BOX)
    im.save(f'{i}.webp', 'WEBP', quality=88, method=6)
    im.quantize(colors=256, method=Image.FASTOCTREE).save(f'{i}.png', 'PNG', optimize=True)
```

`9.*` has **no PNG master** — HGH was only ever rendered as video, so its still
is the matted first frame of `assets/video/_base/p9.mp4`, padded out to the
280×613 box so the vial keeps its true proportions:

```python
# from assets/video/_base/
from make_matte import read_frames, best_matte
fs = read_frames('p9.mp4'); a, *_ = best_matte(fs)   # alpha for the whole clip
# crop fs[0]+a to the matte bbox, pad to 280/613, resize, save .webp + quantized .png
```

Then bump `VIAL_V` in `js/main.js` (and the `?v=` in `admin-products.html`) —
the filenames never change, so Cloudflare will otherwise serve the old artwork.
`.vial-photo`'s `aspect-ratio` in `css/styles.css` must match the crop.

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
- **Transparent PNG** works best (the vial gets a soft drop-shadow that follows
  its shape). A solid background also works but the shadow becomes a rectangle.
- Keep the **same framing across all of them** — one shared crop box is applied to
  every master, so a bottle photographed at a different scale will look off.
- Export the bottle at **≥1200px tall** if you can. The current masters put it
  at 606px, which is only ~1.1× the 560px detail-page slot, so it softens on
  high-DPI screens.
- Any product without a file here automatically falls back to the generic vial
  with the generated Aura label, so the site never shows a broken image.

To use a different filename for a product, set an `image:` field on that product
in `js/products-data.js` (e.g. `image: 'assets/vials/retatrutide.png'`).
