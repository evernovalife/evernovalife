# Ever Nova Life — Printable Vial Labels (PNG)

Seven print-ready label PNGs, transparent background, **600 DPI**.

| File | Product | Pixels | Physical size |
|------|---------|--------|---------------|
| `retatrutide.png` | Retatrutide 10mg | 945×472 | 40 × 20 mm |
| `ghk-cu.png` | GHK-Cu | 945×472 | 40 × 20 mm |
| `tesamorelin-ipamorelin.png` | Tesamorelin / Ipamorelin | 945×472 | 40 × 20 mm |
| `mots-c.png` | MOTS-C | 945×472 | 40 × 20 mm |
| `bpc-tb500.png` | BPC-157 / TB-500 | 945×472 | 40 × 20 mm |
| `klow.png` | KLOW Blend | 945×472 | 40 × 20 mm |
| `bacteriostatic-water.png` | Bacteriostatic Water 30mL | 1417×591 | 60 × 25 mm |

The six peptide labels are 40 × 20 mm (the vial size). The BAC water label is
60 × 25 mm (BAC10ML recommended size). All scale without distortion.

## Printing so the size is correct (critical)
The pixels only print at the right physical size if your software respects DPI.
- The six peptide labels are **40 mm wide × 20 mm tall**.
- The water label is **60 mm wide × 25 mm tall**.

**In any print/photo app:** set the image size to those millimeters (or DPI = 600),
**margins = None**, **scaling = 100% / Actual size** — never "Fit to page", which
rescales and breaks the dimensions.

### Recommended label stock
- Use **40 × 20 mm** label stock for the peptide vials and **60 × 25 mm** for the
  BAC water vial (label rolls in these metric sizes are widely available).
- For sticking directly to vials, any glossy/matte sticker sheet works —
  print, then cut along the rounded frame (it doubles as the cut guide).

## Tips
- Background is transparent, so it prints clean on white label paper.
- For waterproofing, laminate or use weatherproof vinyl sticker sheet.
- Need a different size or DPI? Edit `DPI` (or the `SIZE` map) in
  `../build-pngs.js` and re-run `node build-pngs.js`.

## Rebuilding
From `print-labels/`:
```bash
node build-pngs.js
```
Regenerates every PNG from the source SVG labels using headless Chrome.
