# Product vial photos

Drop your labelled-vial photos here, named by **product id**, as PNG:

| File           | Product                          |
|----------------|----------------------------------|
| `1.png`        | Retatrutide                      |
| `2.png`        | Bacteriostatic Water             |
| `3.png`        | GHK-Cu (Copper Peptide)          |
| `4.png`        | Tesamorelin / Ipamorelin Blend   |
| `5.png`        | MOTS-C                           |
| `6.png`        | BPC-157 / TB-500 Blend           |
| `7.png`        | KLOW Blend                       |

These photos are used across the whole site — product cards, the product
detail page, cart rows and the mini-cart.

## Tips
- **Transparent PNG** works best (the vial gets a soft drop-shadow that follows
  its shape). A solid background also works but the shadow becomes a rectangle.
- Roughly **tall / portrait** framing matches the layout (the slot is about
  256 × 595). Other ratios are centred and fit-to-contain (no cropping).
- Any product without a file here automatically falls back to the generic vial
  with the generated Aura label, so the site never shows a broken image.

To use a different filename for a product, set an `image:` field on that product
in `js/products-data.js` (e.g. `image: 'assets/vials/retatrutide.png'`).
