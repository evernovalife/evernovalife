# Content Needed — business facts to confirm

This file lists facts the website currently asserts (or should assert) that are **not verifiable from the repository**. Nothing here should be guessed or invented in the code. Fill in a real answer, then the corresponding page can be updated.

Status legend: **NEEDED** = no source found · **VERIFY** = a claim is on the site but unconfirmed.

---

## Company / legal
- **Phone number** — NEEDED. Contact page and footer currently list no phone. Confirm whether one should be published, or state "email only".
- **Legal entity name & registered address** — VERIFY. Footer/About show "Ever Nova Life" and a Boca Raton, FL operating location. Confirm the exact legal name and full address that should appear publicly.
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
- **Lots without a published COA** — RESOLVED 2026-08-09. All eight peptide SKUs now have a report on file; the COA Library documents 8 lots. Bacteriostatic Water is exempt — a reagent, not a peptide, so its page states "Not applicable".
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
