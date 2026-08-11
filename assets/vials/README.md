# Product vial photos

Every surface — product card, product page, cart row, mini-cart thumb — shows
the same cut-out: the bottle with its studio set removed, so it floats on the
dark card instead of sitting in a light panel. Two widths ship, offered through
`srcset`, and the browser picks by how big the bottle is actually drawn:

| File          | Size     | Who gets it                                   |
|---------------|----------|-----------------------------------------------|
| `N.webp`      | 630×1380 | the product page, and any surface at 2×+       |
| `N-sm.webp`   | 420×920  | cards, cart rows, mini-cart thumbs             |
| `N.png`       | 420×920  | `onerror` fallback, browsers too old for WebP  |

630×1380 is as sharp as the artwork gets — the masters hold ~685×1500 of real
detail inside the crop box, so nothing here is upscaled.

Turntable video clips used to play on the card and the product page. They were
dropped on 2026-08-07 — iOS Safari decodes no alpha video, and every way of
cutting the set out of the opaque build failed there too (WebKit drops a CSS
mask on a `<video>`, and the canvas composite that replaced it was one more
moving part for a thing that only ever spun). One still now serves every
surface. `assets/video/` is dead weight; nothing reads it.

## Republishing after new artwork

Drop the new full-frame renders in `_base/` named by **product id**, then:

```bash
python assets/vials/_base/publish.py        # all nine
python assets/vials/_base/publish.py 3 7    # or just these ids
```

It mattes each master (flat background plate subtracted, cast shadow dropped),
frames the crop on the bottle itself so masters shot at different zooms come out
matched, and writes both widths plus a quantized `../N.png`. It also writes
`_base/matte_check.png`, the nine cut-outs composited on the site background —
**look at that before shipping**, it is where a leaked set edge or a clipped cap
shows up.

Then bump `VIAL_V` in `js/main.js` (and the `?v=` in `admin-products.html`) —
the filenames never change, so Cloudflare will otherwise serve the old artwork.
`.vial-photo`'s `aspect-ratio` in `css/styles.css` must match the script's
`OW`/`OH`.

Proofread the label on every new master against `js/products-data.js` before
publishing: the name and the mg/IU pill are baked into the artwork, and a wrong
dose on a bottle is the kind of thing nobody notices until a customer does.

## Files

Named by **product id**:

| File           | Product                          |
|----------------|----------------------------------|
| `1.png`        | Retatrutide                      |
| `3.png`        | GHK-Cu (Copper Peptide)          |
| `4.png`        | Tesamorelin / Ipamorelin Blend   |
| `5.png`        | MOTS-C                           |
| `6.png`        | BPC-157 / TB-500 Blend           |
| `7.png`        | KLOW Blend                       |
| `8.png`        | NAD+                             |
| `9.png`        | HGH 36 IU                        |

`_base/` holds the masters `publish.py` reads. `_superseded/` is local-only
history; nothing reads it.

## Tips
- Framing is not a shared crop box — `fit_window()` sizes each one from its own
  matte, so masters at different zooms still come out matched.
- The glass body keeps the set's own light tone showing through it. That is
  correct — it reads as clear glass. Only what is *outside* the bottle is cut.
- The cast shadow is removed on purpose: the card draws its own float and mirror
  reflection, and a baked-in shadow fights both.
