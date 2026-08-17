# Content Needed — business facts to confirm

This file lists facts the website currently asserts (or should assert) that are **not verifiable from the repository**. Nothing here should be guessed or invented in the code. Fill in a real answer, then the corresponding page can be updated.

Status legend: **NEEDED** = no source found · **VERIFY** = a claim is on the site but unconfirmed.

---

## Company / legal
- **Customer service phone number** — NEEDED (BLOCKING, 2026-08-14). The payment reviewer requires a published customer-service phone number. The plumbing is in place: set `window.ENL_SUPPORT_PHONE` (and optionally `window.ENL_SUPPORT_PHONE_HOURS`) at the top of `js/config.js` and the Contact + About phone blocks reveal themselves. Until it is set, no phone is shown anywhere. Also add `"telephone"` to the Organization JSON-LD in `index.html` once known.
- **Legal entity name & registered address** — RESOLVED 2026-08-14. The published street address was a shipping store's, so it was removed site-wide (contact.html, about.html, index.html JSON-LD) per the payment reviewer. The site now states "United States" only. Confirm the exact legal entity name if it differs from "Ever Nova Life"; do NOT republish a street address unless it is a real place of business.
- **Business hours / support response window** — VERIFY. Copy claims replies "within 24 hours". Confirm the real committed response time.

## Shipping & fulfillment (shipping.html, index.html)
- **Same-day / same-business-day dispatch + order cutoff time** — VERIFY. Copy claims "orders before 2pm ship the same day" and "same-day dispatch". Confirm the real cutoff and whether it is same-day or same-business-day.
- **Carriers & tracked service level** — NEEDED. Confirm carrier(s) and whether all orders are tracked.
- **Shipping origin / facilities** — NEEDED. Confirm the location(s) orders ship from (needed for accurate transit-time and temperature claims).
- **Temperature / cold-chain handling** — VERIFY. Copy claims "temperature-aware, temperature-controlled" packaging. Confirm whether cold packs / insulated packaging are actually used, and for which products.
- **International shipping** — RESOLVED 2026-08-01. Domestic (U.S.) only; international shipping was removed from the site per compliance review.

## Returns (returns.html, index.html)
- **Returns policy** — VERIFY. Copy claims "30-day returns on unopened vials". Confirm the real window, conditions, and restocking terms.

## Quality / documentation (quality.html)
- **Lots without a published COA** — RESOLVED 2026-08-09. All eight peptide SKUs now have a report on file; the COA Library documents 8 lots. Bacteriostatic Water, relisted 2026-08-18, adds a ninth: Accurate Test Labs ATL-38534, a solvent panel rather than a peptide assay.
- **Bacteriostatic Water sterility** — NEEDED. ATL-38534 measures benzyl-alcohol content (0.70%) and nothing else. The vial art says `STERILE FILTERED` and the listing calls it sterile water, neither of which the report supports. Get a sterility (and ideally endotoxin) result for the lot, or drop the sterility wording from the listing and the label.
- **BPC-157 / TB-500 blend is under its stated content** — NEEDED. Accurate Test Labs ATL-38533 (2026-08-12) measures **8.93 mg** of BPC-157 against the 10mg the listing states for that component; thymosin beta 4 came in at 10.59 mg against its 10mg, so the vial holds 19.52 mg of a stated 20mg. Stated in the `coa.note` and under **Report scope** for now. Either relist the blend at what the lot actually contains, or take it up with the manufacturing source.
- **Three reports supersede earlier ones** — no action, recorded for provenance. Retatrutide (was Janoshik #137638, now ATL-38532) and the BPC-157 / TB-500 blend (was #151337, now ATL-38533) were re-tested by Accurate Test Labs on 2026-08-12. Unlike the Janoshik reports, these name **Ever Nova Life** as the client, so they answer the provenance question below for those two lots.
- **Two reports do not match the listing they document** — NEEDED. Published as-is at the owner's direction, with the mismatch stated in the `coa.note` on the product page and under **Report scope** in quality.html. Both need a replacement report for the lot and vial actually shipped:
  - **HGH 36 IU** — Janoshik #87374 analyzed a **10 IU** vial of lot CS-h101026 (3.86 mg / 11.58 IU, purity 97.090%). The listing states 36 IU. Either get the 36 IU vial tested, or change the listing to what the report covers.
  - **Tesamorelin / Ipamorelin Blend** — Ozcanium OZ-HPLCMS-0ASZ was issued for an **Ipamorelin + CJC-1295 5mg / 5mg** vial and never analyzes Tesamorelin. Either get the Tesamorelin/Ipamorelin 10mg/3mg blend tested, or relist the product as the Ipamorelin/CJC-1295 blend the report describes.
- **NAD+ purity claim** — VERIFY. The product spec sheet claims `Purity (HPLC) 99.0%`, but report #136634 ordered identity + amount only and reports **no purity figure** (529.47 mg NAD+). Either get a purity assay, or drop the 99.0% from the spec sheet.
- **Ozcanium Analytics report provenance** — VERIFY. Unlike the Janoshik reports (client: Cocer Peptides, our manufacturing source), OZ-HPLCMS-0ASZ names a different client and Ozcanium has no task-number lookup, so it cannot be verified by a buyer the way the Janoshik reports can. Confirm the lot is ours before leaning on it.
- **SDS (Safety Data Sheets)** — NEEDED. The footer links "Safety Data Sheets" to quality.html#sds, but no SDS documents exist on the site. Provide real SDS files or relabel the link.
- **Purity for blends** — Confirmed N/A. Blend lots report identity + measured content only (no single %). This is already reflected in the COA Library.

## Catalog
- **HGH 36 IU (product #9) price** — NEEDED. Added to the catalog 2026-08-05 with a **placeholder $189.99**. Set the real price in admin-products.html (or edit `js/products-data.js` and bump `SEED_SYNC_VERSION` in `server/products.js`) before promoting the product.
- **HGH 36 IU lot number** — NEEDED. Listed as `ENL-24009`, following the numbering of the other eight; confirm the real lot printed on the vials.

## Certifications / standards
- **Any facility certifications or standards** (e.g. ISO, cGMP) — NEEDED only if you want to claim them. Do **not** publish any certification that cannot be evidenced.

## Research-account approval
- **Approval criteria & turnaround** — VERIFY. research-accounts.html describes an application. Confirm what documentation is required and the review turnaround to state publicly.
