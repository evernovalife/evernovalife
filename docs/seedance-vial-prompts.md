# Seedance prompts — vial turntable clips

Generation prompts for the 8 product clips in `assets/video/`. Every clip must be
**interchangeable in look** — same framing, same lighting, same background, same
motion — so the only difference between them is the label.

Consistency comes from three things, in this order of importance:

1. **The start image is our own render**, not a text description of a vial.
2. **One master prompt, byte-identical across all 8**, with a single substituted line.
3. **One fixed seed** reused for all 8.

---

## ⚠️ Read before spending anything

### 1. The label text is currently wrong

The masters in `assets/vials/_base/` are AI renders and the small type is garbled.
Seedance will reproduce whatever is in the start image, and any rotation makes it
*invent* the glyphs that curve out of view. **Fix the label artwork before
generating**, or you are paying to animate typos.

| # | Product | Tagline as printed | Product name |
|---|---------|--------------------|--------------|
| 1 | Retatrutide | `ADVANCING HUMAN PERFORINAIZ` ❌ | tail glyphs mangled |
| 2 | Bacteriostatic Water | `ADVANCING HUMAN PERFORMANCE` ✅ | clean ✅ |
| 3 | GHK-Cu | `ADVANCING HUMAN PERFORNAICS` ❌ | clean |
| 4 | Tesamorelin / Ipamorelin | `ADVANCING HUMAN PERFORMMOS` ❌ | `TESA/IPA` runs off the label ❌ |
| 5 | MOTS-C | `ADVANCING HUMAN PERFORINAIZ` ❌ | clean |
| 6 | BPC-157 / TB-500 | cut off ❌ | `BPC-157/TB-5…` runs off ❌ |
| 7 | KLOW Blend | `ADVANCING MUMAN PERFORMING` ❌ | `KLOW BLEN…` runs off ❌ |
| 8 | NAD+ | `ADVANCING HUMAN PERFORHMASE` ❌ | clean |

The correct tagline is **`ADVANCING HUMAN PERFORMANCE`** on all eight.

### 2. Two label claims sit oddly against the site's compliance posture

The site copy was scrubbed to in-vitro research framing, but the printed labels
still carry human-benefit claims:

- **#3 GHK-Cu** — `SKIN | HAIR | HEALING`
- **#4 Tesa/Ipa** — `HORMONE OPTIMIZATION | RECOVERY | PERFORMANCE`
- **#6 BPC/TB** — `TISSUE REPAIR | RECOVERY | PERFORMANCE`

Worth a decision while the artwork is open anyway. Not a blocker for generation.

### 3. Dose mismatch on #4

Catalog says `10mg / 3mg` (Tesamorelin 10 + Ipamorelin 3); the label pill says
`10 mg` only.

---

## Hard constraints from our own pipeline

`assets/video/_base/make_matte.py` keys the background out by building a plate
from the **median frame** and differencing against it. That dictates the shot:

| Constraint | Why | Consequence for the prompt |
|---|---|---|
| **Camera must be locked off** | A moving camera moves the background; the median plate is then meaningless and the matte collapses | No dolly, push-in, pan, tilt, zoom, or handheld |
| **Flat, static, untextured background** | Sparkle/gradient backgrounds already forced a second `poly` plate fitter as a workaround | Explicitly prompt flat seamless, no particles |
| **Nothing above the cap** | There is dedicated code trimming smoke plumes — past clips had them | Ban smoke, mist, steam, fog, dust |
| **Bottle stays in the same columns** | Alpha is hard-zeroed outside `x0-8 … x1+8` | Vial centred, rotating in place only |
| **Powder must not move** | Motion inside the glass reads as noise against the plate | Prompt the powder as settled and still |

Rotation on the vial's own vertical axis is the **only** safe motion — a cylinder
keeps constant silhouette width, so the matte stays valid.

### Background colour

Do **not** use white (bright fringing when composited onto the near-black site)
and do **not** use near-black (too close to the label substrate; the keyer's
`d > 7` threshold fails along the label edge). Use **flat neutral mid-grey
`#6E6E73`** — maximally distinct from both the black label and the bright
glass/gold, so every edge keys cleanly.

---

## Step 1 — Build the start images

One fixed crop for all eight, so framing is identical by construction.
Masters are 1440×720 with the bottle at bbox `580,54 → 860,667`.

```python
# tools/prep_seedance_frames.py
from PIL import Image
import os

BOX  = (523, 10, 917, 710)     # 394×700, 9:16, bottle centred, ~88% frame height
GREY = (0x6E, 0x6E, 0x73, 255)
SRC  = 'assets/vials/_base'
OUT  = 'assets/video/_seed'

os.makedirs(OUT, exist_ok=True)
for i in range(1, 9):
    im = Image.open(f'{SRC}/{i}.png').convert('RGBA')

    # Masters are on white. Key it to transparent if there's no alpha already.
    if im.getchannel('A').getextrema()[0] == 255:
        px = im.load()
        for y in range(im.height):
            for x in range(im.width):
                r, g, b, a = px[x, y]
                if r > 244 and g > 244 and b > 244:
                    px[x, y] = (r, g, b, 0)

    plate = Image.new('RGBA', im.size, GREY)
    plate.alpha_composite(im)
    plate.convert('RGB').crop(BOX).resize((720, 1280), Image.LANCZOS) \
         .save(f'{OUT}/{i}.png')
    print(f'{i}.png')
```

**Eyeball every output before generating.** The white-key is crude; if it eats
into the glass highlights or leaves a halo, hand-mask instead. A bad start image
guarantees a bad clip.

Geometry check: bottle ends up 613/700 ≈ **88% of frame height** and 280/394 ≈
**71% of frame width**, which sits comfortably inside the 81% centre band that
`publish_alpha.py` later crops at `ASPECT = 280/613`.

---

## Step 2 — Seedance 2 web UI settings

Identical for all eight. **Do not vary any of these between products.**

| Control | Set to | Why |
|---|---|---|
| Tab | **Image to Video** | Not Multi Reference — we have exactly one reference per clip |
| AI Model | **Seedance 2.0** | |
| Images | upload `assets/video/_seed/{id}.png` | The label anchor — non-negotiable |
| **Add end frame** | **OFF** | ⚠️ See below — turning this on freezes the clip |
| Return Last Frame | OFF | Only useful for chaining shots |
| Resolution | highest offered (1080p) | |
| Aspect ratio | **9:16** | Native portrait, no crop loss into the 420×920 publish |
| Duration | shortest offered (5s) | Enough for a ±12° arc; current clips are 6s |
| Audio | OFF if there's a toggle | `publish_alpha.py` encodes `-an` anyway, so audio is wasted spend |

### ⚠️ Do not turn on "Add end frame"

An earlier version of this doc said to upload the same image as both the start
and the end frame, to force a seamless loop. **That produces a completely static
clip** — confirmed on a real generation. If the first and last frames are
identical, the cheapest way for the model to satisfy both constraints is to move
nothing at all, so it holds the vial still for the full duration.

Leave the end frame off and let the rotation run in one direction. Looping is
solved in post instead — see *Seamless looping without an end frame* below.

### Two things this UI does *not* give you

**No negative-prompt box.** Every exclusion has to live inside the single prompt
field. The prompts in Step 3 already have them folded in as explicit "no / do
not" sentences — that is why they read longer than a typical prompt. Don't trim
them; the bans on smoke, particles and camera movement are what keep
`make_matte.py` working.

**No seed field.** So cross-clip consistency rests entirely on (a) the start
images all being cut with the same crop box, and (b) the prompt text being
byte-identical apart from the label line. Both are handled above. Expect a
little more variance between clips than a locked seed would give, and lean on
the contact-sheet check in Step 5 to catch it.

The prompt box caps at **5000 characters**. Each prompt below is ~2,300, so
there's room — but don't paste two products' label lines into one prompt.

---

## Step 3 — The prompt

Goes in the single **Prompt** box. Paste **verbatim** — including the "no /
do not" sentences, which stand in for the missing negative-prompt field. The
only edit per product is the one line marked `THE LABEL READS:`, taken from the
table in Step 4.

```
A single laboratory vial stands upright and centred, filling the frame
vertically, and it is turning. Throughout the entire clip the vial rotates
steadily on its own vertical axis, spinning from right to left in one smooth
continuous movement. The rotation starts on the very first frame and continues
without stopping, without pausing and without reversing all the way to the last
frame, at a slow, even, mechanical speed - like a vial standing on a motorised
jewellery display turntable. Across the clip it turns through roughly 40
degrees, far enough that the curved glass clearly sweeps around and the gold
border visibly travels across the front of the bottle. This rotation is the
main action of the shot and it must be plainly visible.

The camera stays still on a tripod while the vial turns. The vial moves, the
camera does not - no zoom, no push-in, no dolly, no pan, no tilt, no orbit, no
handheld shake.

The vial is clear borosilicate glass holding a settled bed of pale lyophilised
powder at the bottom, which turns with the bottle. A brushed gold crimp collar
and a matte violet flip-top cap sit above it. The wrap-around label has a deep
black substrate, a thin double gold pinstripe border, a glowing violet
four-point star emblem, gold serif type reading "Ever Nova Life", and large
brushed-chrome product lettering. As the vial rotates, a soft studio highlight
travels across the curved glass and glints along the gold collar and the gold
border.

Lighting is constant: clean, even, high-end pharmaceutical studio lighting,
soft key from the upper left, gentle rim light down both edges of the glass.

Background: a completely flat, empty, seamless neutral mid-grey backdrop,
perfectly even from edge to edge and identical in every frame. No gradient, no
texture, no pattern, no vignette, no floor line, no horizon, no reflections, no
surface, no table, no props, no lab equipment. Do not add smoke, mist, fog,
steam, dust, particles, sparkles, bokeh or lens flare. Do not add hands,
people, a second vial, a syringe or a needle. Do not open, lift or remove the
cap. No watermark, no caption, no text overlay.

THE LABEL TEXT IS FIXED. Every word, letter, number and symbol printed on the
label must stay exactly as it appears in the uploaded image. Do not redraw,
re-letter, re-spell, re-typeset, straighten or translate any text. Do not
change the dosage number. Do not invent new text.

THE LABEL READS: <<<paste the line from the Step 4 table here>>>

Photoreal 8K product photography, razor-sharp focus on the label, calm,
premium, clinical. Silent - no music, no sound effects, no voiceover.
```

### Why this version moves and the first one didn't

The first draft came back as a **completely still clip**. Three things caused
it, all fixed above:

1. **Identical start and end frame** (the "Add end frame" toggle). The model can
   satisfy both endpoints most cheaply by never moving. This was the main cause
   — fix it in the UI, not the prompt.
2. **Opening on "Static locked-off … the camera never moves."** Leading with a
   stillness instruction sets the tone for the whole clip; the model applied it
   to the subject as well as the camera. The rotation now comes first, and the
   camera lock is phrased as a contrast — *"the vial moves, the camera does
   not"* — so the two can't be conflated.
3. **A stack of motion negatives** — *no jitter, no wobble, no bouncing, no
   spin, the powder never moves, the background is identical in every frame*.
   Individually reasonable, collectively they read as "nothing in this shot
   moves." The ones that suppress subject motion are gone; only the ones
   protecting the matte (flat background, no particles, locked camera) remain.

Also changed: the arc went from **±12° and back** to **~40° continuous in one
direction**. A 12° there-and-back is barely perceptible even when executed
correctly, and "returns to its starting position" is itself an invitation to do
nothing.

Two other deliberate choices:

- **Hyphens, not em-dashes, and no accented characters.** Prompt parsers
  occasionally mangle non-ASCII. Keep it plain.
- **The audio ban is in the text** because the model is the "With Audio"
  variant. `publish_alpha.py` strips audio with `-an` regardless, but there's no
  reason to spend generation on a soundtrack we throw away.

### Seamless looping without an end frame

The site plays these clips on `loop`, so a one-direction 40° rotation would
snap back visibly at the loop point. Fix it in the encoder rather than the
generator: **ping-pong the frames** so the clip plays forward then backward.

In `assets/video/_base/publish_alpha.py` and `publish_opaque.py`, after
`fs = read_frames(path)`:

```python
fs = fs + fs[-2:0:-1]      # ping-pong: forward, then back, no duplicate ends
```

This gives a mathematically perfect loop, doubles the apparent clip length for
free, and reads as a gentle oscillating turntable — the look the ±12° prompt was
reaching for, but achieved in post where it costs nothing and can't fail.
Because the frame set is mirrored, the matte stays valid.

---

## Step 4 — Per-product `THE LABEL READS:` line

Substitute one line into the prompt. Everything else stays identical.

| # | Product | `LABEL CONTENT` line |
|---|---------|----------------------|
| 1 | Retatrutide | `The chrome lettering reads "RETATRUTIDE". The violet band beneath reads "NEXT GEN METABOLIC PEPTIDE". The gold dose pill reads "10 mg". The bottom line reads "FOR RESEARCH USE ONLY".` |
| 2 | Bacteriostatic Water | `The chrome lettering reads "BAC WATER". The violet band beneath reads "STERILE \| MULTIPLE USE". Below it a gold-outlined badge reads "BACTERIOSTATIC WATER". The bottom line reads "FOR RECONSTITUTION USE ONLY". The vial holds clear liquid, not powder.` |
| 3 | GHK-Cu | `The chrome lettering reads "GHK-Cu". The violet band beneath reads "SKIN \| HAIR \| HEALING". The gold dose pill reads "50 mg". The bottom line reads "FOR RESEARCH USE ONLY".` |
| 4 | Tesamorelin / Ipamorelin | `The chrome lettering reads "TESA/IPA". Beneath it a line reads "TESAMORELIN / IPAMORELIN", then a violet band reads "HORMONE OPTIMIZATION \| RECOVERY \| PERFORMANCE". The gold dose pill reads "10 mg". The bottom line reads "FOR RESEARCH USE ONLY".` |
| 5 | MOTS-C | `The chrome lettering reads "MOTS-C". The violet band beneath reads "MITOCHONDRIAL ACTIVATOR". The gold dose pill reads "10 mg". The bottom line reads "FOR RESEARCH USE ONLY".` |
| 6 | BPC-157 / TB-500 | `The chrome lettering reads "BPC-157 / TB-500" with "BLEND" letterspaced beneath it. The violet band reads "TISSUE REPAIR \| RECOVERY \| PERFORMANCE". The gold dose pill reads "20 mg". The bottom line reads "FOR RESEARCH USE ONLY".` |
| 7 | KLOW Blend | `The chrome lettering reads "KLOW BLEND". The violet band beneath reads "CELLULAR REPAIR + RECOVERY". The gold dose pill reads "80 mg". The bottom line reads "FOR RESEARCH USE ONLY".` |
| 8 | NAD+ | `The chrome lettering reads "NAD+". The violet band beneath reads "NICOTINAMIDE ADENINE DINUCLEOTIDE". The gold dose pill reads "500 mg". A small gold badge reads "LAB TESTED". The bottom line reads "FOR RESEARCH USE ONLY".` |

Note `#2` is the only one that is liquid rather than lyophilised powder, and the
only one whose bottom line differs.

### Emit all eight, assembled

Hand-splicing the label line eight times is how a Retatrutide prompt ends up on
the NAD+ vial. This writes each finished prompt to its own file so you paste one
whole file per generation and never edit inside the box:

```python
# tools/emit_seedance_prompts.py  — run from the repo root
import os, re, pathlib

DOC = pathlib.Path('docs/seedance-vial-prompts.md').read_text(encoding='utf-8')
OUT = pathlib.Path('assets/video/_seed'); OUT.mkdir(parents=True, exist_ok=True)

# the prompt body is the fenced block containing the fixed-label clause.
# Anchor the fences to line starts and allow a language tag, or the opening and
# closing fences interleave and every capture comes out shifted by one block.
body = next(b.strip('\n') for b in re.findall(r'^```[a-z]*\n(.*?)^```', DOC, re.S | re.M)
            if 'THE LABEL TEXT IS FIXED' in b)

# the label lines are the backticked cells of the Step 4 table
rows = re.findall(r'^\|\s*(\d)\s*\|[^|]+\|\s*`(.+?)`\s*\|\s*$', DOC, re.M)
assert len(rows) == 8, f'expected 8 label lines, found {len(rows)}'

for pid, label in rows:
    text = body.replace('<<<paste the line from the Step 4 table here>>>',
                        label.replace(r'\|', '|'))
    assert '<<<' not in text
    (OUT / f'prompt-{pid}.txt').write_text(text, encoding='utf-8')
    print(f'prompt-{pid}.txt  {len(text)} chars')
```

Every file must come out **under 5000 characters** — the script prints each
length so you can see it. Then, per product: upload `_seed/{id}.png` as both the
start frame and the end frame, and paste `_seed/prompt-{id}.txt` into the prompt
box.

---

## Step 5 — QA before publishing

Run on every clip. Any failure = re-roll that vial, do not "fix in post".

1. **Text integrity** — pull frames at 0%, 25%, 50%, 75%, 100% and read the label
   in each. Brand wordmark, product name, dose number and the research-use line
   must be identical in all five. A single changed glyph fails the clip.
2. **Dose number** — check `10 / 50 / 20 / 80 / 500 mg` specifically. This is the
   one error with real consequences.
3. **Camera lock** — diff frame 1 against the last frame *outside* the bottle
   columns. It must be near-zero. If the background moved, the matte will fail.
4. **Background cleanliness** — no particles, no plume above the cap.
5. **Loop seam** — last frame should return to the start frame.
6. **Cross-clip consistency** — build a contact sheet of frame 1 from all eight
   side by side. Cap height, collar, lighting angle and background tone should be
   indistinguishable.

Then run the existing pipeline:

```bash
python assets/video/_base/make_matte.py      # check the printed opaque %
python assets/video/_base/publish_alpha.py
python assets/video/_base/publish_opaque.py
```

⚠️ `make_matte.py` has `MAP = {1:1, 2:2, 3:3, 4:4, 5:7, 6:5, 7:6, 8:8}` because
the last master set arrived in shoot order, not product order. **If you name the
new masters by product id, reset `MAP` to identity** or you will publish the
wrong clip against the wrong product.

Finally bump `VIDEO_V` in [js/main.js](../js/main.js) — filenames don't change,
so Cloudflare will otherwise keep serving the old clips. Upload the video assets
to GoDaddy **before** the HTML, per the asset-cache ordering rule.

---

## Cost

At ~$2.99 per 5s 1080p clip: **~$24** for one clean pass over all eight.
Budget 2–3 rolls per vial realistically → **$50–75**.

Burn **one vial first** (suggest #2 Bacteriostatic Water — it's the only master
with clean type, so it isolates video quality from the label problem). Inspect it
end to end through `make_matte.py` before committing to the other seven.
