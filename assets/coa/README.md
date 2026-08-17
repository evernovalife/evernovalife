# Certificate of Analysis (COA) documents

Each product page renders a **Certificate of Analysis** panel from the `coa`
block in `js/products-data.js`. Drop the original laboratory report in this
folder and it is displayed **inline on the product page** — an image renders
directly (click for full size), a PDF gets an embedded viewer. Until the file
exists, nothing is shown and no dead link is offered.

## File names

Name each file by the report's own identifier — the Janoshik task number, or
the verification code for a report from another laboratory. **Any of `.pdf`,
`.png`, `.jpg`, `.webp` works** — the page tries each in turn and uses whichever
it finds, so you do not need to convert anything or edit the catalog.

| Base name         | Product                        | Report          | Batch          |
|-------------------|--------------------------------|-----------------|----------------|
| `ATL-38532`       | Retatrutide                    | ATL-38532       | Lot 1          |
| `122571`          | GHK-Cu (Copper Peptide)        | #122571         | CS-gu50-0309   |
| `147077`          | MOTS-C                         | #147077         | CS-mc10-0408   |
| `ATL-38533`       | BPC-157 / TB-500 Blend         | ATL-38533       | Lot 1          |
| `122606`          | KLOW Blend                     | #122606         | CS-ko80-0309   |
| `136634`          | NAD+                           | #136634         | CS-na500-0403  |
| `87374`           | HGH 36 IU                      | #87374          | CS-h101026     |
| `OZ-HPLCMS-0ASZ`  | Tesamorelin / Ipamorelin Blend | OZ-HPLCMS-0ASZ  | 22/07/2026     |
| `bac`             | Bacteriostatic Water           | ATL-38534       | Lot 1          |

The bacteriostatic-water file is the one exception to naming by report id — it
arrived as `bac.png` and the catalog points straight at it, so it is left alone.
That report is an Accurate Test Labs **solvent panel**, not a peptide assay: it
measures benzyl alcohol (0.70%) and covers neither purity nor sterility, which
is why the listing's `coa.note` says so.

Retatrutide and the BPC-157 / TB-500 blend were re-tested by Accurate Test Labs
on 2026-08-12 (reported 08-17), replacing Janoshik #137638 and #151337. The old
files were renamed to the new report ids rather than kept alongside — one lot,
one current document. The superseded Janoshik reports are still in git history
if a buyer ever asks for the earlier analysis.

So `137638.png` or `137638.pdf` — either is fine.

## Publishing a report reaches the live shop only with a version bump

The storefront prices and describes from the **server** store, which is written
once and then only patched on demand. Editing a `coa` block in
`js/products-data.js` is therefore not enough on its own: bump
`COA_SYNC_VERSION` in `server/products.js` and deploy, or the live product page
keeps showing the old status. (`BACKFILL_FIELDS` only fills a `coa` that is
missing entirely — it will not replace a "pending" one.)

**Images tend to work better than PDFs**: they render inline on mobile without
a download, which is how most peptide suppliers publish COAs.

## Where to get them

The Janoshik and Ozcanium reports are for batches produced by the manufacturing
source (cocerpeptides.com) — request the original documents from them, or scan
the QR code on the report you already hold. The three `ATL-*` reports were
ordered by us directly from Accurate Test Labs on lots received here, which is
the cleaner arrangement: the report names Ever Nova Life as the client, so its
provenance stands on its own.

**Never publish another supplier’s report as documentation for our batch.**
A Janoshik report is tied to the lot AND the client who ordered the test, and
the verification page shows the original client name — so a borrowed report
does not just misdescribe the goods, it fails on the first click.

## Deep verify links (recommended)

`coa.verifyUrl` in `js/products-data.js` should point at the archived report,
not the Janoshik homepage. The format is:

    https://verify.janoshik.com/tests/<task>-<Compound>_<size>_<UNIQUE_KEY>

for example `.../tests/168135-GHKCu_50mg_3M59ETIXMXUG`. The trailing unique key
is printed on the report itself (and in its QR code), so it has to be copied
from each document — it cannot be derived from the task number. Until a deep
link is set, the page links to `janoshik.com/verify` and shows the task number
to enter, which still verifies correctly.

Ozcanium Analytics has no task-number lookup, so its report links to the issuing
lab (`ozcaniumanalytics.com.au`) and shows its verification code instead.

## Where a report does not match its listing, say so

Two reports on file cover something narrower than the listing that carries them,
so each `coa` block has a `note` and the panel prints it above the data table:

- **HGH 36 IU** — #87374 analyzed a *10 IU* vial of lot CS-h101026 (3.86 mg /
  11.58 IU). Identity and purity are covered; the 36 IU listed quantity is not.
- **Tesamorelin / Ipamorelin Blend** — OZ-HPLCMS-0ASZ was issued for an
  *Ipamorelin + CJC-1295 5mg / 5mg* vial. Tesamorelin is not analyzed at all.

Both are published at the owner's direction. The clean fix in each case is a
report for the lot and vial actually shipped — until then, the `note` is what
keeps the page from overstating what the document proves. `quality.html` carries
the same two rows under **Report scope**.
