# Certificate of Analysis (COA) documents

Each product page renders a **Certificate of Analysis** panel from the `coa`
block in `js/products-data.js`. Drop the original laboratory report in this
folder and it is displayed **inline on the product page** — an image renders
directly (click for full size), a PDF gets an embedded viewer. Until the file
exists, nothing is shown and no dead link is offered.

## File names

Name each file by its Janoshik task number. **Any of `.pdf`, `.png`, `.jpg`,
`.webp` works** — the page tries each in turn and uses whichever it finds, so
you do not need to convert anything or edit the catalog.

| Base name  | Product                 | Report   | Batch          |
|------------|-------------------------|----------|----------------|
| `137638`   | Retatrutide             | #137638  | CS-re10-0322   |
| `122571`   | GHK-Cu (Copper Peptide) | #122571  | CS-gu50-0309   |
| `147077`   | MOTS-C                  | #147077  | CS-mc10-0408   |
| `151337`   | BPC-157 / TB-500 Blend  | #151337  | CS-bb1010-0408 |
| `122606`   | KLOW Blend              | #122606  | CS-ko80-0309   |

So `137638.png` or `137638.pdf` — either is fine.

**Images tend to work better than PDFs**: they render inline on mobile without
a download, which is how most peptide suppliers publish COAs.

## Where to get them

These five reports are for batches produced by the manufacturing source
(cocerpeptides.com). Request the original documents from them, or scan the QR
code on the report you already hold.

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

## NAD+ has no report

NAD+ (id 8) has no published report for its current batch, so its page shows a
*Pending* notice. To satisfy “a COA is viewable for every product”, either have
the current NAD+ batch tested and add its `coa` block, or delist NAD+ until a
report exists.
