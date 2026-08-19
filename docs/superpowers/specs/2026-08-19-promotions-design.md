# Promotions — design

Date: 2026-08-19
Status: approved, not yet implemented

## Problem

The shop has no way to run a deal. Prices are whatever the product record says, and the only discount in the system is loyalty-points redemption — an order-level dollar figure clamped to the subtotal in `server/pricing.js`. Running "Retatrutide buy 1 get 1" or "20% off for ten days" today means hand-editing the product price in the admin, remembering to put it back, and losing the original price in the process.

This design adds admin-managed promotions: scheduled campaigns that change what an order costs, priced on the server, displayed in the browser.

## Scope

Four promotion types:

- **sale** — a product's price drops for a date range (percent off, dollars off, or a fixed replacement price)
- **bogo** — buy X units of a product, get Y free
- **cart** — percent or dollars off the whole order once the subtotal clears a threshold
- **shipping** — the shipping fee is waived while the promo runs

Promotions apply **automatically**. There are no promo codes: the checkout code field was deliberately removed in the 2026-08-09 UX pass, and adding it back would bring code validation, enumeration rate-limiting and a support burden that a store this size does not need.

Out of scope: per-customer promos, first-order-only promos, promo codes, and promotions on auto-ship invoices (see Decisions).

## Data model

Promotions live in `DATA_DIR/promotions.json`, managed by a new `server/promotions.js`. The module follows the same shape as `server/shipping.js`: a JSON file store with atomic `save()` via a temp file and rename, a `normalise()` that makes any stored row safe to price from, and `listAll` / `upsert` / `remove` for the admin.

The store seeds **empty**. A shop with no promotions running is the normal state, and an accidental seed promo would discount real money.

A promotion record:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | stable slug, derived from `name` when the admin leaves it blank |
| `name` | string | the admin's label, e.g. "Retatrutide — Buy 1 Get 1" |
| `badge` | string | storefront chip text, max 16 chars, e.g. "BUY 1 GET 1" |
| `type` | one of sale, bogo, cart, shipping | which rule applies |
| `productIds` | number[] | sale / bogo only; empty means every product |
| `mode` | one of percent, amount, fixed | sale / cart only |
| `value` | number | 25 means 25% off, $25 off, or a $25 replacement price |
| `buyQty` | number | bogo only; units that must be paid for |
| `freeQty` | number | bogo only; units given per `buyQty` paid |
| `minSubtotal` | number | cart only; 0 means no minimum |
| `startsAt` | ISO string or null | null means live immediately |
| `endsAt` | ISO string or null | null means no end date |
| `enabled` | boolean | off switch that survives the date range |
| `sort` | number | display order, low first |

`normalise()` clamps `value`, `buyQty`, `freeQty` and `minSubtotal` to non-negative numbers, caps a `percent` value at 100, and drops a row whose `type` is unrecognised. A `fixed` sale that resolves above the product's own price is ignored at apply time rather than rejected at save time — the catalog price can change after the promo was written.

The two motivating examples:

```js
// Retatrutide, buy 1 get 1
{ type: 'bogo', productIds: [7], buyQty: 1, freeQty: 1, badge: 'BUY 1 GET 1' }

// 20% off for ten days
{ type: 'sale', productIds: [7], mode: 'percent', value: 20,
  startsAt: '2026-08-19T00:00:00Z', endsAt: '2026-08-29T00:00:00Z',
  badge: 'SAVE 20%' }
```

## The engine

`promotions.apply(items, opts)` is the whole rule set, in one pure function that takes priced line items and returns priced line items. It reads the store but touches nothing else, so it can be unit-tested without a server.

A promotion is **active** when `enabled` is true, `startsAt` is null or in the past, and `endsAt` is null or in the future. `opts.now` defaults to the current time and exists so tests can pin a date.

Three phases, in order:

**Phase 1 — per line.** For each line item, gather every active sale and bogo promo that names its product (or names no product at all). Score each candidate by the dollars it would save on that line. The single highest-saving candidate applies; the rest do not. A sale lowers `unitPrice`. A bogo leaves `unitPrice` alone and adds `floor(paidQty / buyQty) * freeQty` free units.

Sale and bogo never both apply to the same line. Two campaigns on one product is a normal thing to have running — an evergreen bogo and a short sale — and the buyer gets whichever is worth more that day.

**Phase 2 — cart.** Of the active cart promos whose `minSubtotal` is covered by the phase-1 subtotal, the single highest-saving one applies. Its saving is returned as `promoDiscount`, an order-level dollar figure.

**Phase 3 — shipping.** If any active shipping promo exists, the shipping fee is zero.

Return shape:

```js
{
  items,           // line items, repriced; each carries paidQuantity + quantity
  promoDiscount,   // cart-level dollars
  promos: [ { id, name, badge, saving } ],   // what applied, for the record
  freeShipping     // boolean
}
```

### Line item shape

A bogo line ships more units than it bills, so the line carries both counts:

- `quantity` — total units to ship (paid + free)
- `paidQuantity` — units actually billed
- `lineTotal` — `unitPrice * paidQuantity`

`quantity` keeps its existing meaning of "how many go in the box", so the packing slip, the shipping label and stock reservation are correct with no change. Only the pricing path reads `paidQuantity`. This is the safer default: a missed edit shows a wrong number on a screen, not a short shipment.

Lines untouched by any promo get `paidQuantity === quantity`.

## Integration with pricing

`buildOrder()` in `server/pricing.js` calls the engine after building line items and before summing:

```
lines            -> promotions.apply()  -> repriced lines, promoDiscount, freeShipping
subtotal         =  sum of lineTotal (already at promo prices)
loyaltyDiscount  =  clamp(opts.discount, 0, subtotal - promoDiscount)
taxable          =  subtotal - promoDiscount - loyaltyDiscount
shipping         =  freeShipping ? 0 : resolveShipping(method, subtotal)
tax              =  taxable * TAX_RATE
total            =  taxable + shipping + tax
```

The returned order gains two fields: `promoDiscount` and `promos[]`. The existing `discount` field keeps meaning loyalty points only, so nothing reading it today changes meaning.

`buildOrder` accepts `opts.noPromos` to skip the engine entirely. Auto-ship uses it.

### Stock and bogo

`availableQty()` and `reserveStock()` both see `quantity`, so a buy-1-get-1 on a product with `stockQty: 10` reserves 2 units per order and runs out after 5. That is physically correct: two vials leave the building.

When stock cannot cover the free units, the bogo applies only as far as stock allows, and the remainder is billed normally. The promo degrades rather than failing the checkout.

## Loyalty

Points stay redeemable on a discounted order, and are clamped to the post-promo subtotal — a buyer cannot redeem against money the promo already took off.

Points **earned** move from `subtotal - discount` to `subtotal - promoDiscount - discount` at the earn site in `server/server.js`, so points are earned on what was actually paid.

## Storefront

A new public `GET /api/promotions` returns the active promotions only — never the scheduled or expired ones, which would leak an unannounced campaign.

A new `js/promos.js` mirrors the engine **for display only**: the badge chip and struck-through price on product cards and `product.html`, a countdown ("ends in 3 days") on the product page, and a savings line in the cart. The server remains authoritative; `POST /api/quote` already returns the real figures at checkout, and the invoice is built from the server's own arithmetic. A stale or tampered browser copy changes what is displayed, never what is charged.

## Admin

A new **Promotions** entry in the left rail of `admin.html`, built in `js/admin-console.js` alongside the existing views. An eighth read in `loadAll()` fetches the admin list.

The view shows three tabs — Live, Scheduled, Expired — derived from the same array, plus a create/edit form, an enable toggle and delete. The form shows only the fields the chosen type uses.

Routes, matching the existing shipping-rate routes:

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/promotions` | public | active promotions, for the storefront |
| `GET /api/admin/promotions` | `requireAdmin` | every promotion |
| `POST /api/admin/promotions` | `requireAdmin` | create or update |
| `DELETE /api/admin/promotions/:id` | `requireAdmin` | remove |

## Decisions

**Free-shipping threshold is tested against the post-promo subtotal.** A $110 cart discounted to $88 does not clear a $100 `freeOver`. The threshold is about what the store actually took, not what the goods list for.

**Auto-ship invoices ignore promotions.** Repeating orders bill at catalog price. A ten-day sale must not lock a recurring plan into a discount for the life of the plan, and the alternative — re-evaluating promos at each invoice — means a subscriber's charge changes without warning. `server.js` passes `{ noPromos: true }` when it prices a due plan.

**One promo per line, one per cart.** Full stacking makes it easy to sell below cost by accident; one-promo-per-order means a free-shipping campaign would block a sale price. This sits between them.

**No promo codes.** See Scope.

## Testing

`server/test/promotions.test.js`, using `node:test` like the existing `authz.test.js`, run by `npm test` in `server/`:

- best-of selection: sale beats bogo when it saves more, and the reverse
- no stacking: a product with both a sale and a bogo is charged one of them
- date windows: not-yet-started and just-expired promos do not apply
- `enabled: false` overrides a live date range
- bogo unit maths, including a quantity that is not a multiple of `buyQty`
- bogo degrades when `stockQty` cannot cover the free units
- cart promo requires `minSubtotal`, measured post-line-discount
- free-shipping promo zeroes the fee; `freeOver` uses the post-promo subtotal
- loyalty redemption clamps to the post-promo subtotal
- a fixed sale above the catalog price is ignored

Plus an addition to `authz.test.js`: promotion writes reject a non-admin.

## Files

New:

- `server/promotions.js`
- `server/test/promotions.test.js`
- `js/promos.js`

Edited:

- `server/pricing.js` — call the engine, new order fields, `noPromos`
- `server/server.js` — four routes, order record fields, loyalty earn base, `noPromos` on the auto-ship path, `promoDiscount` on the `/api/quote` response
- `js/admin-console.js`, `js/admin-core.js` — the Promotions view and its rail entry
- `js/main.js` — apply the decoration on catalog load; promo chip, countdown, free-unit line, summary rows
- `css/styles.css`, `css/admin.css` — promo chip, countdown, admin form
- 24 HTML pages — the `js/promos.js` script tag and a cache-buster bump to `?v=66`

`js/cart.js` needs no change. Because `js/promos.js` decorates `window.PRODUCTS`
in place, `cart.syncPrices()` copies the promo price into the cart by itself —
the mechanism that used to correct a stale price now also applies the deal.

## Deployment

Backend (Render): push to git; Render redeploys. No new env vars, no new dependency. Promotions persist to `DATA_DIR/promotions.json`, so the Render Disk must be mounted and `DATA_DIR` set — the same requirement products and orders already have.

Static (GoDaddy): two passes, assets before HTML. Cloudflare caches css and js for four hours, so uploading the HTML first binds the old asset to the new `?v=66` name. Pass 1 is `js/promos.js`, `js/main.js`, `js/admin-console.js`, `js/admin-core.js`, `css/styles.css`, `css/admin.css`; wait, then pass 2 is the 24 HTML pages. Nothing under `server/`, `docs/` or `tools/` goes to GoDaddy.

Verify: `GET /api/promotions` answers on the Render host, the Promotions entry appears in the admin rail, and a test promo on one SKU shows a struck-through price on `products.html`.
