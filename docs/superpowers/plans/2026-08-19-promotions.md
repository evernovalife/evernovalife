# Promotions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the shop owner an admin screen that runs scheduled deals — a sale price for N days, buy-1-get-1, a cart-wide discount, or free shipping — priced authoritatively on the server.

**Architecture:** A new `server/promotions.js` holds a JSON file store (same shape as `server/shipping.js`) plus a **pure** evaluator, `evaluate(promos, items, opts)`, that takes priced line items and returns them repriced. `server/pricing.js` calls the store-backed wrapper `apply()` inside `buildOrder()`, so every path that charges money — crypto checkout, Zelle, `/api/quote`, the pay-the-balance link — gets promotions for free. The browser mirrors the evaluator in `js/promos.js` for **display only**, decorating `window.PRODUCTS` in place so the existing card/detail/cart render code shows sale prices with almost no markup change.

**Tech Stack:** Node 18+ CommonJS, Express 4, `node:test` (no test deps), vanilla browser JS (no build step, no modules — scripts are plain `<script src>` in load order).

**Spec:** [docs/superpowers/specs/2026-08-19-promotions-design.md](../specs/2026-08-19-promotions-design.md)

## Global Constraints

- **No new dependencies.** `server/package.json` stays as it is.
- **CommonJS only** in `server/` (`"type": "commonjs"`). Browser files are plain scripts attached to `window`, never ES modules.
- **Money is rounded through one helper**: `Math.round((Number(n) + Number.EPSILON) * 100) / 100`. Never compare or store raw floats.
- **The server is authoritative.** The browser may display a promo price; it may never send one. Nothing in `js/promos.js` is trusted by `server/`.
- **Persistence path is `DATA_DIR`**, read as `process.env.DATA_DIR || path.join(__dirname, 'data')` — the same line every other store uses.
- **Never edit HTML files with PowerShell `Get-Content`/`Out-File`.** These files are no-BOM UTF-8 with non-ASCII characters (`—`, `·`, `×`); PowerShell double-encodes them site-wide. Use the Edit tool or Python with `encoding='utf-8', newline=''`.
- **Icons are line-art SVG, never emoji** — both on the storefront (`js/main.js` icon set) and in admin (`A.icon` in `js/admin-core.js`).
- **Existing field meanings do not change.** `order.discount` keeps meaning *loyalty points only*; promotions add `order.promoDiscount` alongside it.
- **Run tests from `server/`**: `npm test` runs every file; `node --test test/promotions.test.js` runs one.

---

### Task 1: The promotions store

**Files:**
- Create: `server/promotions.js`
- Test: `server/test/promotions.test.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `normalise(raw) -> promo | null` — null when `type` is unrecognised
  - `listAll() -> promo[]` sorted by `sort` then `name`
  - `listActive(now?) -> promo[]`
  - `isActive(promo, nowMs) -> boolean`
  - `upsert(input) -> promo` (throws a 400-tagged Error on a blank name)
  - `remove(id) -> promo` (throws a 400-tagged Error when the id is unknown)
  - `money(n) -> number`
  - A promo object: `{ id, name, badge, type, productIds, mode, value, buyQty, freeQty, minSubtotal, startsAt, endsAt, enabled, sort }`

- [ ] **Step 1: Write the failing test**

Create `server/test/promotions.test.js`:

```js
/* ============================================================
   EVER NOVA LIFE — promotions
   The store (normalise / active windows / CRUD) and the pure
   evaluator that decides what a cart actually costs.

   Runs with the built-in Node test runner (no extra deps):
       npm test                            (from server/)
       node --test test/promotions.test.js
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A throwaway DATA_DIR keeps the real store clean. Set before the require.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-promo-'));
process.env.DATA_DIR = TMP_DATA;

const promotions = require('../promotions.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('the store starts empty — a seeded promo would discount real money', () => {
  assert.deepStrictEqual(promotions.listAll(), []);
});

test('normalise clamps a percent above 100 and rejects an unknown type', () => {
  const p = promotions.normalise({ name: 'Half off', type: 'sale', mode: 'percent', value: 250 });
  assert.strictEqual(p.value, 100);
  assert.strictEqual(promotions.normalise({ name: 'Nope', type: 'lottery' }), null);
});

test('normalise floors negative quantities and money to zero', () => {
  const p = promotions.normalise({ name: 'Bad', type: 'bogo', buyQty: -3, freeQty: -1, minSubtotal: -50 });
  assert.strictEqual(p.buyQty, 1);      // you must buy at least one
  assert.strictEqual(p.freeQty, 0);
  assert.strictEqual(p.minSubtotal, 0);
});

test('upsert derives a slug id from the name, and remove takes it back out', () => {
  const saved = promotions.upsert({ name: 'Retatrutide — Buy 1 Get 1', type: 'bogo', buyQty: 1, freeQty: 1 });
  assert.strictEqual(saved.id, 'retatrutide-buy-1-get-1');
  assert.strictEqual(promotions.listAll().length, 1);
  promotions.remove(saved.id);
  assert.deepStrictEqual(promotions.listAll(), []);
});

test('upsert refuses a promotion with no name', () => {
  assert.throws(() => promotions.upsert({ type: 'sale', mode: 'percent', value: 10 }), /name/i);
});

test('remove refuses an id that is not there', () => {
  assert.throws(() => promotions.remove('no-such-promo'), /no promotion/i);
});

test('isActive respects the date window and the enabled switch', () => {
  const now = Date.parse('2026-08-19T12:00:00Z');
  const live = { enabled: true, startsAt: '2026-08-18T00:00:00Z', endsAt: '2026-08-29T00:00:00Z' };
  const early = { enabled: true, startsAt: '2026-09-01T00:00:00Z', endsAt: null };
  const over = { enabled: true, startsAt: null, endsAt: '2026-08-18T00:00:00Z' };
  const off = { enabled: false, startsAt: null, endsAt: null };

  assert.strictEqual(promotions.isActive(live, now), true);
  assert.strictEqual(promotions.isActive(early, now), false);
  assert.strictEqual(promotions.isActive(over, now), false);
  assert.strictEqual(promotions.isActive(off, now), false);
  assert.strictEqual(promotions.isActive({ enabled: true, startsAt: null, endsAt: null }, now), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/promotions.test.js`
Expected: FAIL — `Cannot find module '../promotions.js'`

- [ ] **Step 3: Write minimal implementation**

Create `server/promotions.js`:

```js
/* ============================================================
   EVER NOVA LIFE — promotions (admin-managed)
   Scheduled deals that change what an order costs: a sale price
   for a date range, buy-X-get-Y, a cart-wide discount, or free
   shipping. Same durable-storage pattern as products, orders and
   shipping rates — a JSON file on DATA_DIR, owned by the admin
   at runtime, no deploy needed to start or stop a campaign.

   A promotion is:
     id           stable slug, derived from the name when blank
     name         the admin's label ("Retatrutide — Buy 1 Get 1")
     badge        storefront chip text ("BUY 1 GET 1"), ≤16 chars
     type         'sale' | 'bogo' | 'cart' | 'shipping'
     productIds   sale/bogo: which SKUs. empty = every product
     mode         sale/cart: 'percent' | 'amount' | 'fixed'
     value        25 = 25% off, $25 off, or a $25 replacement price
     buyQty       bogo: units that must be paid for
     freeQty      bogo: units given per buyQty paid
     minSubtotal  cart: the subtotal this promo needs to apply
     startsAt     ISO or null (live immediately)
     endsAt       ISO or null (no end date)
     enabled      off switch that survives the date window
     sort         display order, low first

   The store seeds EMPTY on purpose. A shop with nothing running
   is the normal state, and a seeded promo would discount real
   money the first time the server booted.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'promotions.json');

const TYPES = ['sale', 'bogo', 'cart', 'shipping'];
const MODES = ['percent', 'amount', 'fixed'];

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(FILE)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr.map(normalise).filter(Boolean);
  } catch (e) {
    /* An unreadable promotions file must not take the shop down: the honest
       fallback is "no deals running", never "charge something arbitrary". */
    console.error('[promotions] store unreadable, running no promotions:', e.message);
    return [];
  }
}

function save(list) {
  ensureDir();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);          // atomic on the same filesystem
}

const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 80);
const nonNeg = v => Math.max(0, Number(v) || 0);

/* A stored row, made safe to price from. A row whose type we don't recognise
   is not a promotion we know how to charge for, so it is dropped rather than
   guessed at. */
function normalise(p) {
  const type = str(p && p.type, 20).toLowerCase();
  if (!TYPES.includes(type)) return null;

  const mode = MODES.includes(str(p && p.mode, 20).toLowerCase())
    ? str(p.mode, 20).toLowerCase() : 'percent';
  let value = nonNeg(p && p.value);
  if (mode === 'percent') value = Math.min(100, value);

  return {
    id: str(p && p.id, 40) || slug(p && p.name),
    name: str(p && p.name, 80),
    badge: str(p && p.badge, 16),
    type,
    productIds: Array.isArray(p && p.productIds)
      ? p.productIds.map(Number).filter(Number.isFinite) : [],
    mode,
    value: money(value),
    // You must buy at least one unit to get anything free.
    buyQty: Math.max(1, Math.floor(nonNeg(p && p.buyQty)) || 1),
    freeQty: Math.floor(nonNeg(p && p.freeQty)),
    minSubtotal: money(nonNeg(p && p.minSubtotal)),
    startsAt: isoOrNull(p && p.startsAt),
    endsAt: isoOrNull(p && p.endsAt),
    enabled: !(p && p.enabled === false),
    sort: Number.isFinite(Number(p && p.sort)) ? Number(p.sort) : 50
  };
}

function isoOrNull(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const bySort = (a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name);

/** Every promotion, live or not — the admin's view. */
function listAll() {
  return load().sort(bySort);
}

/** Is this promotion running right now? */
function isActive(p, nowMs) {
  if (!p || p.enabled === false) return false;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (p.startsAt && Date.parse(p.startsAt) > now) return false;
  if (p.endsAt && Date.parse(p.endsAt) <= now) return false;
  return true;
}

/** What the storefront and the pricing engine may see. */
function listActive(nowMs) {
  return load().filter(p => isActive(p, nowMs)).sort(bySort);
}

function upsert(input) {
  const incoming = normalise({
    ...input,
    // A blank id on a new promotion is derived from its name, so the admin
    // form never has to think about slugs.
    id: input && input.id ? input.id : slug(input && input.name)
  });
  if (!incoming) throw badRequest('Pick a promotion type: sale, bogo, cart or shipping.');
  if (!incoming.name) throw badRequest('A promotion needs a name.');
  if (!incoming.id) throw badRequest('A promotion needs a name we can turn into an id.');

  const list = load();
  const at = list.findIndex(p => p.id === incoming.id);
  if (at === -1) list.push(incoming);
  else list[at] = { ...list[at], ...incoming };

  save(list);
  return incoming;
}

function remove(id) {
  const list = load();
  const at = list.findIndex(p => p.id === String(id));
  if (at === -1) throw badRequest('No promotion with that id.');
  const kept = list.filter((_, i) => i !== at);
  save(kept);
  return list[at];
}

function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

module.exports = { listAll, listActive, isActive, normalise, upsert, remove, money };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/promotions.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/promotions.js server/test/promotions.test.js
git commit -m "feat(promotions): admin-managed promotion store"
```

---

### Task 2: Sale pricing and best-of selection

**Files:**
- Modify: `server/promotions.js` (add `evaluate`)
- Test: `server/test/promotions.test.js` (append)

**Interfaces:**
- Consumes: `normalise`, `isActive`, `money` from Task 1
- Produces:
  - `evaluate(promos, items, opts) -> { items, promoDiscount, promos, freeShipping }`
  - Input item: `{ id, name, unitPrice, quantity, stockLeft }` — `stockLeft` is `null` for untracked stock
  - Output item: `{ id, name, unitPrice, quantity, paidQuantity, lineTotal, listUnitPrice, promoId }` — `promoId` is `''` when nothing applied
  - Applied-promo entry: `{ id, name, badge, type, saving }`
  - `opts`: `{ now?: number }`

`evaluate` is **pure** — it takes the promotion array rather than reading the store, so tests construct exactly the scenario they mean.

- [ ] **Step 1: Write the failing test**

Append to `server/test/promotions.test.js`:

```js
/* ---- the evaluator ----
   Pure: hand it promotions and lines, get repriced lines back.
   `line()` builds an untracked-stock item, which is the common case. */
const line = (id, unitPrice, quantity, stockLeft = null) =>
  ({ id, name: 'P' + id, unitPrice, quantity, stockLeft });

const NOW = Date.parse('2026-08-19T12:00:00Z');
const ev = (promos, items) =>
  promotions.evaluate(promos.map(promotions.normalise), items, { now: NOW });

test('a percent sale lowers the unit price and reports the saving', () => {
  const r = ev([{ name: '20% off', type: 'sale', productIds: [7], mode: 'percent', value: 20 }],
    [line(7, 100, 2)]);
  assert.strictEqual(r.items[0].unitPrice, 80);
  assert.strictEqual(r.items[0].listUnitPrice, 100);
  assert.strictEqual(r.items[0].lineTotal, 160);
  assert.strictEqual(r.promos[0].saving, 40);
});

test('an amount sale takes dollars off, a fixed sale replaces the price', () => {
  const amt = ev([{ name: '$15 off', type: 'sale', productIds: [7], mode: 'amount', value: 15 }],
    [line(7, 100, 1)]);
  assert.strictEqual(amt.items[0].unitPrice, 85);

  const fixed = ev([{ name: 'Now $89', type: 'sale', productIds: [7], mode: 'fixed', value: 89 }],
    [line(7, 100, 1)]);
  assert.strictEqual(fixed.items[0].unitPrice, 89);
});

test('a fixed sale above the catalog price is ignored — the catalog moved, not the deal', () => {
  const r = ev([{ name: 'Now $150', type: 'sale', productIds: [7], mode: 'fixed', value: 150 }],
    [line(7, 100, 1)]);
  assert.strictEqual(r.items[0].unitPrice, 100);
  assert.deepStrictEqual(r.promos, []);
});

test('an empty productIds list means every product', () => {
  const r = ev([{ name: 'Everything 10% off', type: 'sale', mode: 'percent', value: 10 }],
    [line(7, 100, 1), line(8, 50, 1)]);
  assert.strictEqual(r.items[0].unitPrice, 90);
  assert.strictEqual(r.items[1].unitPrice, 45);
});

test('two sales on one product: only the bigger one applies, never both', () => {
  const r = ev([
    { name: 'Small', type: 'sale', productIds: [7], mode: 'percent', value: 10 },
    { name: 'Big', type: 'sale', productIds: [7], mode: 'percent', value: 30 }
  ], [line(7, 100, 1)]);
  assert.strictEqual(r.items[0].unitPrice, 70);
  assert.strictEqual(r.promos.length, 1);
  assert.strictEqual(r.promos[0].name, 'Big');
});

test('a promotion outside its window does not apply', () => {
  const r = ev([{
    name: 'Ended', type: 'sale', productIds: [7], mode: 'percent', value: 50,
    startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-08-10T00:00:00Z'
  }], [line(7, 100, 1)]);
  assert.strictEqual(r.items[0].unitPrice, 100);
  assert.deepStrictEqual(r.promos, []);
});

test('an untouched line still carries paidQuantity, so callers never branch', () => {
  const r = ev([], [line(7, 100, 3)]);
  assert.strictEqual(r.items[0].paidQuantity, 3);
  assert.strictEqual(r.items[0].quantity, 3);
  assert.strictEqual(r.items[0].lineTotal, 300);
  assert.strictEqual(r.items[0].promoId, '');
  assert.strictEqual(r.promoDiscount, 0);
  assert.strictEqual(r.freeShipping, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/promotions.test.js`
Expected: FAIL — `promotions.evaluate is not a function`

- [ ] **Step 3: Write minimal implementation**

In `server/promotions.js`, add above `module.exports`:

```js
/* ============================================================
   THE EVALUATOR
   Pure by design: it takes the promotions and the priced lines and
   returns repriced lines. It reads no store and no catalog, so the
   whole rule set can be tested without a server, and pricing.js
   stays the only place that decides what a line costs to begin with.

   Three phases, in order:
     1. per line   — the single best-value sale OR bogo. Never both:
                     an evergreen bogo and a short sale on the same
                     product is a normal thing to have running, and
                     the buyer should get whichever is worth more.
     2. cart       — the single best cart-wide promo whose minimum
                     the (already discounted) subtotal covers.
     3. shipping   — any active shipping promo zeroes the fee.
   ============================================================ */

/** Does this promotion name this product? An empty list means all of them. */
function coversProduct(promo, id) {
  return !promo.productIds.length || promo.productIds.includes(Number(id));
}

/* What one unit costs under a sale, or null when the sale does nothing.
   A `fixed` price above the catalog price is ignored rather than rejected at
   save time: the catalog can move after the promotion was written, and a deal
   that would RAISE the price is a stale row, not a charge. */
function salePrice(promo, unitPrice) {
  let next;
  if (promo.mode === 'percent') next = unitPrice * (1 - promo.value / 100);
  else if (promo.mode === 'amount') next = unitPrice - promo.value;
  else next = promo.value;                     // 'fixed'
  next = money(Math.max(0, next));
  return next < unitPrice ? next : null;
}

/* Free units this bogo hands out, capped by what is actually on the shelf.
   `stockLeft` is what the catalog says is available (null = untracked); the
   paid units come out of the same count, so the free ones can only use what
   is left over. When nothing is left the promo yields 0 and simply doesn't
   apply — the checkout is never refused over a free extra. */
function bogoFreeUnits(promo, quantity, stockLeft) {
  if (promo.freeQty <= 0) return 0;
  let free = Math.floor(quantity / promo.buyQty) * promo.freeQty;
  if (stockLeft !== null && stockLeft !== undefined) {
    free = Math.min(free, Math.max(0, Number(stockLeft) - quantity));
  }
  return Math.max(0, free);
}

function evaluate(promos, items, opts) {
  opts = opts || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const live = (promos || []).filter(Boolean).filter(p => isActive(p, now));
  const applied = new Map();          // id -> { id, name, badge, type, saving }

  const noteSaving = (promo, saving) => {
    const prev = applied.get(promo.id);
    if (prev) prev.saving = money(prev.saving + saving);
    else applied.set(promo.id, {
      id: promo.id, name: promo.name, badge: promo.badge, type: promo.type, saving: money(saving)
    });
  };

  /* ---- phase 1: per line ---- */
  const priced = (items || []).map(item => {
    const listUnitPrice = money(item.unitPrice);
    const quantity = Math.max(0, Math.floor(Number(item.quantity) || 0));

    let best = null;                  // { saving, apply(line) }

    live.forEach(promo => {
      if (!coversProduct(promo, item.id)) return;

      if (promo.type === 'sale') {
        const unit = salePrice(promo, listUnitPrice);
        if (unit === null) return;
        const saving = money((listUnitPrice - unit) * quantity);
        if (saving > 0 && (!best || saving > best.saving)) {
          best = { promo, saving, unitPrice: unit, freeUnits: 0 };
        }
      } else if (promo.type === 'bogo') {
        const freeUnits = bogoFreeUnits(promo, quantity, item.stockLeft);
        const saving = money(freeUnits * listUnitPrice);
        if (saving > 0 && (!best || saving > best.saving)) {
          best = { promo, saving, unitPrice: listUnitPrice, freeUnits };
        }
      }
    });

    if (best) noteSaving(best.promo, best.saving);

    const unitPrice = best ? best.unitPrice : listUnitPrice;
    const freeUnits = best ? best.freeUnits : 0;

    /* `quantity` keeps its existing meaning — how many units go in the box —
       so the packing slip, the shipping label and the stock reservation are
       right without knowing promotions exist. Only the money reads
       `paidQuantity`. */
    return {
      id: item.id,
      name: item.name,
      unitPrice,
      listUnitPrice,
      quantity: quantity + freeUnits,
      paidQuantity: quantity,
      lineTotal: money(unitPrice * quantity),
      promoId: best ? best.promo.id : ''
    };
  });

  const subtotal = money(priced.reduce((sum, i) => sum + i.lineTotal, 0));

  /* ---- phase 2: cart-wide ---- */
  let promoDiscount = 0;
  let bestCart = null;
  live.filter(p => p.type === 'cart').forEach(promo => {
    if (subtotal < promo.minSubtotal) return;
    const raw = promo.mode === 'percent' ? subtotal * (promo.value / 100) : promo.value;
    const saving = money(Math.min(Math.max(0, raw), subtotal));
    if (saving > 0 && (!bestCart || saving > bestCart.saving)) bestCart = { promo, saving };
  });
  if (bestCart) {
    promoDiscount = bestCart.saving;
    noteSaving(bestCart.promo, bestCart.saving);
  }

  /* ---- phase 3: shipping ---- */
  const shipPromo = live.find(p => p.type === 'shipping') || null;
  if (shipPromo) noteSaving(shipPromo, 0);   // the fee isn't known here; record that it applied

  return {
    items: priced,
    promoDiscount,
    promos: Array.from(applied.values()),
    freeShipping: !!shipPromo
  };
}
```

Then extend the export line:

```js
module.exports = { listAll, listActive, isActive, normalise, upsert, remove, money, evaluate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/promotions.test.js`
Expected: PASS — 14 tests

- [ ] **Step 5: Commit**

```bash
git add server/promotions.js server/test/promotions.test.js
git commit -m "feat(promotions): sale pricing with best-of-one selection per line"
```

---

### Task 3: BOGO units, stock limits, and cart/shipping promos

**Files:**
- Modify: `server/promotions.js` (add the store-backed `apply` wrapper)
- Test: `server/test/promotions.test.js` (append)

**Interfaces:**
- Consumes: `evaluate`, `listActive` from Tasks 1–2
- Produces: `apply(items, opts) -> same shape as evaluate` — reads live promotions from the store. `opts.now` is forwarded.

The bogo and cart/shipping code already shipped in Task 2's `evaluate`; this task proves it and adds the thin store-backed wrapper `pricing.js` will call.

- [ ] **Step 1: Write the failing test**

Append to `server/test/promotions.test.js`:

```js
const BOGO = { name: 'Buy 1 get 1', badge: 'BUY 1 GET 1', type: 'bogo', productIds: [7], buyQty: 1, freeQty: 1 };

test('buy 1 get 1 doubles the units shipped but not the units billed', () => {
  const r = ev([BOGO], [line(7, 100, 2)]);
  assert.strictEqual(r.items[0].quantity, 4);        // four vials leave the building
  assert.strictEqual(r.items[0].paidQuantity, 2);    // two are charged for
  assert.strictEqual(r.items[0].lineTotal, 200);
  assert.strictEqual(r.promos[0].saving, 200);
});

test('buy 2 get 1 rounds down on a quantity that is not a multiple', () => {
  const r = ev([{ name: 'B2G1', type: 'bogo', productIds: [7], buyQty: 2, freeQty: 1 }],
    [line(7, 30, 5)]);
  assert.strictEqual(r.items[0].quantity, 7);        // 5 paid + 2 free
  assert.strictEqual(r.items[0].paidQuantity, 5);
});

test('bogo degrades to nothing when stock cannot cover the free units', () => {
  // 2 wanted, only 2 on the shelf — there is no third vial to give away.
  const r = ev([BOGO], [line(7, 100, 2, 2)]);
  assert.strictEqual(r.items[0].quantity, 2);
  assert.strictEqual(r.items[0].lineTotal, 200);
  assert.deepStrictEqual(r.promos, []);
});

test('bogo gives away only as many free units as the shelf allows', () => {
  // 2 wanted, 3 on the shelf — one free unit fits, the second does not.
  const r = ev([BOGO], [line(7, 100, 2, 3)]);
  assert.strictEqual(r.items[0].quantity, 3);
  assert.strictEqual(r.items[0].paidQuantity, 2);
  assert.strictEqual(r.promos[0].saving, 100);
});

test('sale and bogo on one product: the bigger saving wins, and only one is recorded', () => {
  // bogo saves $100 (one free unit); the 20% sale saves $20 on one unit.
  const r = ev([BOGO, { name: '20% off', type: 'sale', productIds: [7], mode: 'percent', value: 20 }],
    [line(7, 100, 1)]);
  assert.strictEqual(r.items[0].unitPrice, 100);
  assert.strictEqual(r.items[0].quantity, 2);
  assert.strictEqual(r.promos.length, 1);
  assert.strictEqual(r.promos[0].type, 'bogo');
});

test('a cart promo applies only once its minimum is covered', () => {
  const promo = { name: '10% over $200', type: 'cart', mode: 'percent', value: 10, minSubtotal: 200 };
  assert.strictEqual(ev([promo], [line(7, 100, 1)]).promoDiscount, 0);
  assert.strictEqual(ev([promo], [line(7, 100, 3)]).promoDiscount, 30);
});

test('the cart minimum is measured after line discounts, not on the list price', () => {
  // $220 of goods, 20% off each line -> $176 subtotal, which misses a $200 minimum.
  const r = ev([
    { name: '20% off', type: 'sale', productIds: [7], mode: 'percent', value: 20 },
    { name: '$25 over $200', type: 'cart', mode: 'amount', value: 25, minSubtotal: 200 }
  ], [line(7, 110, 2)]);
  assert.strictEqual(r.items[0].lineTotal, 176);
  assert.strictEqual(r.promoDiscount, 0);
});

test('only the best cart promo applies', () => {
  const r = ev([
    { name: 'Five off', type: 'cart', mode: 'amount', value: 5 },
    { name: 'Ten percent', type: 'cart', mode: 'percent', value: 10 }
  ], [line(7, 100, 1)]);
  assert.strictEqual(r.promoDiscount, 10);
  assert.strictEqual(r.promos.length, 1);
});

test('a cart discount can never exceed the subtotal', () => {
  const r = ev([{ name: 'Too much', type: 'cart', mode: 'amount', value: 500 }], [line(7, 100, 1)]);
  assert.strictEqual(r.promoDiscount, 100);
});

test('a shipping promo raises the free-shipping flag', () => {
  const r = ev([{ name: 'Free delivery week', type: 'shipping' }], [line(7, 100, 1)]);
  assert.strictEqual(r.freeShipping, true);
  assert.strictEqual(r.promos[0].type, 'shipping');
});

test('apply() reads live promotions from the store', () => {
  const saved = promotions.upsert({ name: 'Store-wide 10', type: 'sale', mode: 'percent', value: 10 });
  const r = promotions.apply([line(7, 100, 1)]);
  assert.strictEqual(r.items[0].unitPrice, 90);
  promotions.remove(saved.id);
  assert.strictEqual(promotions.apply([line(7, 100, 1)]).items[0].unitPrice, 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/promotions.test.js`
Expected: FAIL — `promotions.apply is not a function` (the earlier evaluate-based tests in this block pass already)

- [ ] **Step 3: Write minimal implementation**

In `server/promotions.js`, add after `evaluate`:

```js
/** The store-backed evaluator — what pricing.js calls. */
function apply(items, opts) {
  opts = opts || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  return evaluate(listActive(now), items, { now });
}
```

Extend the export line:

```js
module.exports = { listAll, listActive, isActive, normalise, upsert, remove, money, evaluate, apply };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/promotions.test.js`
Expected: PASS — 25 tests

- [ ] **Step 5: Commit**

```bash
git add server/promotions.js server/test/promotions.test.js
git commit -m "feat(promotions): bogo unit maths, stock ceiling, cart and shipping promos"
```

---

### Task 4: Wire promotions into server pricing

**Files:**
- Modify: `server/pricing.js`
- Test: Create `server/test/pricing-promotions.test.js`

**Interfaces:**
- Consumes: `promotions.apply(items, opts)` from Task 3
- Produces: `buildOrder(rawItems, opts)` gains
  - `opts.noPromos: boolean` — skip promotions entirely (auto-ship uses it)
  - returned `order.promoDiscount: number`
  - returned `order.promos: Array<{id, name, badge, type, saving}>`
  - returned `order.items[]` each carry `paidQuantity` and `listUnitPrice`

Order of operations, unchanged from the spec:

```
subtotal        = sum of lineTotal (already at promo prices)
loyaltyDiscount = clamp(opts.discount, 0, subtotal - promoDiscount)
taxable         = subtotal - promoDiscount - loyaltyDiscount
shipping        = freeShipping ? 0 : resolveShipping(method, subtotal)
tax             = taxable * TAX_RATE
total           = taxable + shipping + tax
```

- [ ] **Step 1: Write the failing test**

Create `server/test/pricing-promotions.test.js`:

```js
/* ============================================================
   EVER NOVA LIFE — promotions, as they reach the invoice
   buildOrder() is what every payment path prices from, so this is
   the test that actually protects the money. It writes promotions
   and products into a throwaway DATA_DIR, then asks buildOrder
   what the cart costs.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-pricing-promo-'));
process.env.DATA_DIR = TMP_DATA;

const promotions = require('../promotions.js');
const products = require('../products.js');
const { buildOrder } = require('../pricing.js');

/* The first product in the seeded catalog — the seed is the site's real
   8-SKU catalog, so we price against whatever it actually says rather than
   hard-coding a figure that a catalog edit would break. */
const SKU = products.listProducts()[0];

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

function clearPromos() {
  promotions.listAll().forEach(p => promotions.remove(p.id));
}

test('with no promotions running, nothing about the order changes', () => {
  clearPromos();
  const order = buildOrder([{ id: SKU.id, quantity: 1 }]);
  assert.strictEqual(order.promoDiscount, 0);
  assert.deepStrictEqual(order.promos, []);
  assert.strictEqual(order.items[0].paidQuantity, 1);
  assert.strictEqual(order.subtotal, order.items[0].lineTotal);
});

test('a sale lowers the subtotal, the tax and the total', () => {
  clearPromos();
  promotions.upsert({ name: 'Half off', type: 'sale', productIds: [SKU.id], mode: 'percent', value: 50 });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }]);
  clearPromos();

  assert.strictEqual(order.subtotal, promotions.money(SKU.price * 0.5));
  assert.strictEqual(order.items[0].listUnitPrice, promotions.money(SKU.price));
  assert.strictEqual(order.tax, promotions.money(order.subtotal * 0.08));
  assert.strictEqual(order.promos[0].name, 'Half off');
});

test('a cart promo lands in promoDiscount, and tax is charged on what is left', () => {
  clearPromos();
  promotions.upsert({ name: 'Ten off', type: 'cart', mode: 'amount', value: 10, minSubtotal: 0 });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }]);
  clearPromos();

  assert.strictEqual(order.promoDiscount, 10);
  assert.strictEqual(order.tax, promotions.money((order.subtotal - 10) * 0.08));
});

test('loyalty points clamp to what is left after the promotion', () => {
  clearPromos();
  promotions.upsert({ name: 'Almost free', type: 'cart', mode: 'percent', value: 90, minSubtotal: 0 });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }], { discount: 9999 });
  clearPromos();

  assert.strictEqual(order.discount, promotions.money(order.subtotal - order.promoDiscount));
  assert.strictEqual(order.tax, 0);
  assert.strictEqual(order.total, promotions.money(order.shipping));
});

test('a shipping promo zeroes the fee whatever the method costs', () => {
  clearPromos();
  promotions.upsert({ name: 'Free delivery', type: 'shipping' });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }]);
  clearPromos();

  assert.strictEqual(order.shipping, 0);
});

/* The free-shipping THRESHOLD (shipping.js `freeOver`, $100 on Standard) is a
   separate mechanism from a free-shipping promo, and it is measured on what the
   store actually took. A cart worth $120 at list, discounted to $60, has not
   earned free postage. */
test('the free-shipping threshold is measured on the post-promotion subtotal', () => {
  clearPromos();
  const qty = Math.ceil(101 / SKU.price);            // enough to clear $100 at list price
  const full = buildOrder([{ id: SKU.id, quantity: qty }]);
  assert.ok(full.subtotal >= 100, 'the fixture must clear the threshold at list price');
  assert.strictEqual(full.shipping, 0);

  promotions.upsert({ name: 'Half off', type: 'sale', productIds: [SKU.id], mode: 'percent', value: 50 });
  const discounted = buildOrder([{ id: SKU.id, quantity: qty }]);
  clearPromos();

  assert.ok(discounted.subtotal < 100, 'the discount must drop it back under the threshold');
  assert.ok(discounted.shipping > 0, 'postage is charged once the paid subtotal falls short');
});

test('noPromos prices at catalog — this is what auto-ship invoices use', () => {
  clearPromos();
  promotions.upsert({ name: 'Half off', type: 'sale', productIds: [SKU.id], mode: 'percent', value: 50 });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }], { noPromos: true });
  clearPromos();

  assert.strictEqual(order.subtotal, promotions.money(SKU.price));
  assert.strictEqual(order.promoDiscount, 0);
  assert.deepStrictEqual(order.promos, []);
});

test('a bogo line ships more units than it bills', () => {
  clearPromos();
  promotions.upsert({ name: 'B1G1', badge: 'BUY 1 GET 1', type: 'bogo', productIds: [SKU.id], buyQty: 1, freeQty: 1 });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }]);
  clearPromos();

  assert.strictEqual(order.items[0].quantity, 2);
  assert.strictEqual(order.items[0].paidQuantity, 1);
  assert.strictEqual(order.subtotal, promotions.money(SKU.price));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/pricing-promotions.test.js`
Expected: FAIL — `order.promoDiscount` is `undefined` (7 of 8 tests fail; the no-promotions one passes because there is nothing to apply yet)

- [ ] **Step 3: Write minimal implementation**

In `server/pricing.js`, add the require beside the existing two:

```js
const promotions = require('./promotions.js');
```

Then replace the block from `const unitPrice = money(product.price);` through the `return { items, subtotal, discount, ... }` at the end of `buildOrder` with:

```js
    const unitPrice = money(product.price);
    return {
      id: product.id,
      name: product.name,
      unitPrice,
      quantity,
      lineTotal: money(unitPrice * quantity),
      /* Carried for the promotion engine only: a bogo can hand out a free unit
         only if there is one on the shelf after the paid units are taken.
         null = untracked, which is unlimited. */
      stockLeft: left
    };
  });

  /* Promotions reprice the lines before anything is summed, so every payment
     path — crypto, Zelle, the balance link, /api/quote — charges the same
     figure without any of them knowing promotions exist. `noPromos` is for
     auto-ship: a repeating plan bills at catalog price, because a ten-day sale
     must not follow a subscriber around for the life of their plan. */
  const promo = opts.noPromos
    ? { items: items.map(i => ({ ...i, paidQuantity: i.quantity, listUnitPrice: i.unitPrice, promoId: '' })),
        promoDiscount: 0, promos: [], freeShipping: false }
    : promotions.apply(items);

  const priced = promo.items.map(({ stockLeft, ...line }) => line);   // stockLeft was input-only
  const subtotal = money(priced.reduce((sum, i) => sum + i.lineTotal, 0));

  /* The browser sends a shipping METHOD, never a fee. The rate table decides
     what that method costs and whether this subtotal clears its free-shipping
     threshold, so a tampered client can at worst pick a cheaper service that
     the store is already offering. An unknown or disabled id resolves to the
     cheapest enabled method rather than failing the checkout.

     The threshold is measured on the POST-promotion subtotal — what the store
     actually took, not what the goods list for. */
  const ship = promo.freeShipping
    ? { id: 'promo', label: 'Free shipping', fee: 0 }
    : resolveShipping(opts.shippingMethod, subtotal);

  /* Two discounts, kept apart on purpose. `promoDiscount` is the shop's own
     cart-wide deal; `discount` is loyalty points and keeps the meaning every
     existing caller already reads. Points can only be spent against what the
     promotion left behind. */
  const promoDiscount = money(Math.max(0, Math.min(promo.promoDiscount, subtotal)));
  const discount = money(Math.max(0, Math.min(Number(opts.discount) || 0, subtotal - promoDiscount)));
  const taxable = money(subtotal - promoDiscount - discount);
  const tax = money(taxable * TAX_RATE);
  const total = money(taxable + ship.fee + tax);

  return {
    items: priced, subtotal, discount,
    promoDiscount,
    promos: promo.promos,
    shipping: money(ship.fee),
    // Carried through so the invoice, the order record and the packing queue
    // all say which service was bought — "shipping $19.99" alone doesn't.
    shippingMethod: ship.id,
    shippingLabel: ship.label,
    tax, total
  };
}
```

Also, inside the `items.map` above, the existing `const left = availableQty(product);` stays exactly where it is — the new `stockLeft: left` just reuses it.

Finally, one line in the same file: a bogo line ships more units than were asked for, and `quantity` is what stock reserves, so the early per-line stock check must still allow it. It already does — `quantity` there is the requested count, and the free unit is capped by `stockLeft` in the engine.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/pricing-promotions.test.js`
Expected: PASS — 7 tests

Then run everything, to prove the existing suite still holds:

Run: `cd server && npm test`
Expected: PASS — all files, 0 fail

- [ ] **Step 5: Commit**

```bash
git add server/pricing.js server/test/pricing-promotions.test.js
git commit -m "feat(promotions): price every checkout through the promotion engine"
```

---

### Task 5: API routes

**Files:**
- Modify: `server/server.js`
- Test: `server/test/authz.test.js` (append)

**Interfaces:**
- Consumes: `promotions.listAll / listActive / upsert / remove` from Tasks 1–3
- Produces:
  - `GET /api/promotions` → `{ success: true, promotions: [...] }` (public, active only)
  - `GET /api/admin/promotions` → `{ success: true, promotions: [...] }` (admin, all)
  - `POST /api/admin/promotions` → `{ success: true, promotion, promotions }` (admin)
  - `DELETE /api/admin/promotions/:id` → `{ success: true, removed, promotions }` (admin)

- [ ] **Step 1: Write the failing test**

Append to `server/test/authz.test.js`, at the end of the file:

```js
/* ---- promotions ----
   Reading which deals are running is public (the storefront needs it to badge
   a product). Writing one changes what every customer is charged, so it is
   admin-only — and a scheduled campaign must not leak before it starts. */
test('anyone may read the running promotions', async () => {
  const res = await api('/api/promotions');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.promotions));
});

test('an ordinary user cannot create, list-all or delete a promotion', async () => {
  const user = await register('promo-user@example.com');

  const create = await api('/api/admin/promotions', {
    method: 'POST', token: user.token,
    body: { name: 'Free money', type: 'cart', mode: 'percent', value: 100 }
  });
  assert.strictEqual(create.status, 403);

  const listAll = await api('/api/admin/promotions', { token: user.token });
  assert.strictEqual(listAll.status, 403);

  const del = await api('/api/admin/promotions/free-money', { method: 'DELETE', token: user.token });
  assert.strictEqual(del.status, 403);
});

test('an anonymous caller cannot create a promotion', async () => {
  const res = await api('/api/admin/promotions', {
    method: 'POST',
    body: { name: 'Free money', type: 'cart', mode: 'percent', value: 100 }
  });
  assert.ok(res.status === 401 || res.status === 403);
});
```

If `register()` in that file returns something other than `{ token }`, read its definition at the top of the file and use whatever it does return — the helper already exists and other tests in the file show the shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/authz.test.js`
Expected: FAIL — `GET /api/promotions` answers 404

- [ ] **Step 3: Write minimal implementation**

In `server/server.js`, add the require beside the other store requires near the top (next to `const { buildOrder } = require('./pricing.js');`):

```js
const promotions = require('./promotions.js');
```

Then add this block immediately after the `app.delete('/api/shipping/:id', ...)` handler:

```js
/* ============================================================
   PROMOTIONS
   Scheduled deals — a sale price for a date range, buy-X-get-Y, a
   cart-wide discount, free shipping. pricing.js applies them, so
   these routes only manage the list.

   The public GET returns the ACTIVE ones only. A campaign that
   starts on Friday is not something a visitor should be able to
   read on Tuesday, and an expired one is noise.
   ============================================================ */
app.get('/api/promotions', (req, res) => {
  res.json({ success: true, promotions: promotions.listActive() });
});

app.get('/api/admin/promotions', requireAdmin, (req, res) => {
  res.json({ success: true, promotions: promotions.listAll() });
});

/* Add or edit one. Same route for both: the id is the key, and a blank id on a
   new promotion is derived from its name. */
app.post('/api/admin/promotions', requireAdmin, (req, res) => {
  try {
    const promotion = promotions.upsert(req.body || {});
    res.json({ success: true, promotion, promotions: promotions.listAll() });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.delete('/api/admin/promotions/:id', requireAdmin, (req, res) => {
  try {
    const removed = promotions.remove(req.params.id);
    res.json({ success: true, removed, promotions: promotions.listAll() });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/authz.test.js`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add server/server.js server/test/authz.test.js
git commit -m "feat(promotions): public and admin promotion routes"
```

---

### Task 6: Order records, loyalty earn, and the auto-ship opt-out

**Files:**
- Modify: `server/server.js` (three sites: `buildOrderRecord`, `markOrderPaid`, the auto-ship `buildOrder` call)
- Test: `server/test/pricing-promotions.test.js` (append)

**Interfaces:**
- Consumes: `order.promoDiscount`, `order.promos`, `order.items[].paidQuantity` from Task 4
- Produces: order records carrying `promoDiscount` and `promos`; loyalty earned on `subtotal − promoDiscount − discount`

- [ ] **Step 1: Write the failing test**

Append to `server/test/pricing-promotions.test.js`:

```js
/* Points are earned on what the customer actually paid. Before promotions
   existed that was `subtotal - discount`; a promo-discounted order must not
   earn points against money nobody paid. */
const loyalty = require('../loyalty.js');

test('points are earned on the amount actually paid, not the list price', () => {
  clearPromos();
  promotions.upsert({ name: 'Ten off', type: 'cart', mode: 'amount', value: 10, minSubtotal: 0 });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }]);
  clearPromos();

  const paid = promotions.money(order.subtotal - order.promoDiscount - (order.discount || 0));
  assert.strictEqual(loyalty.earnForAmount(paid), loyalty.earnForAmount(order.subtotal - 10));
  assert.notStrictEqual(loyalty.earnForAmount(paid), loyalty.earnForAmount(order.subtotal));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/pricing-promotions.test.js`
Expected: PASS — this test pins the arithmetic (`loyalty.earnForAmount` is already exported from `server/loyalty.js`). It is the three edits in Step 3 that make the *server* use that arithmetic, and the grep in Step 4 is what verifies them.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `buildOrderRecord` (around [server/server.js:1033](../../../server/server.js#L1033)), after the `discount: order.discount || 0,` line, add:

```js
    // What the shop's own deals took off, kept apart from the loyalty
    // `discount` above so a refund or a reconcile can tell them apart.
    ...(order.promoDiscount ? { promoDiscount: order.promoDiscount } : {}),
    ...(order.promos && order.promos.length ? { promos: order.promos } : {}),
```

**3b.** In `markOrderPaid` (around [server/server.js:1391](../../../server/server.js#L1391)), change:

```js
    const earned = loyalty.earnForAmount((o.subtotal || 0) - (o.discount || 0));
```

to:

```js
    /* Points are earned on the money that actually arrived: promotions and a
       points redemption both come off before this. */
    const earned = loyalty.earnForAmount((o.subtotal || 0) - (o.promoDiscount || 0) - (o.discount || 0));
```

**3c.** In the auto-ship runner (around [server/server.js:2890](../../../server/server.js#L2890)), change:

```js
    const order = buildOrder(claimed.items);            // authoritative, re-priced now
```

to:

```js
    /* Priced at CATALOG, never on promotion: a ten-day sale must not lock a
       repeating plan into that price for the life of the plan, and re-reading
       promotions at every invoice would change a subscriber's charge without
       warning. Terms §6 — nothing is ever charged automatically. */
    const order = buildOrder(claimed.items, { noPromos: true });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS — every file, 0 fail

Then confirm the three edits landed:

Run: `cd server && grep -n "promoDiscount\|noPromos" server.js`
Expected: three hits — one in `buildOrderRecord`, one in `markOrderPaid`, one in the auto-ship runner

- [ ] **Step 5: Commit**

```bash
git add server/server.js server/test/pricing-promotions.test.js
git commit -m "feat(promotions): record promo savings on orders, earn points on what was paid"
```

---

### Task 7: The browser mirror

**Files:**
- Create: `js/promos.js`
- Modify: `js/main.js` (the `loadProducts` fetch chain)

**Interfaces:**
- Consumes: `GET /api/promotions` from Task 5; `window.PRODUCTS` and `API_BASE` from `js/products-data.js` / `js/config.js`
- Produces on `window.Promos`:
  - `load() -> Promise<promo[]>` — fetches and caches the active list
  - `decorate(products) -> products` — mutates each product in place: sets `price` to the promo price, `originalPrice` to the list price, and `promo` to `{ id, badge, type, endsAt, freeQty, buyQty }`; clears a stale `promo` when nothing applies
  - `list() -> promo[]` — the cached active list
  - `cartPromo(subtotal) -> { name, saving } | null` — the best cart-wide promo for this subtotal
  - `freeShipping() -> boolean`
  - `freeUnitsFor(productId, quantity) -> number`

This file is **display only**. It never sends a price. `POST /api/quote` and `buildOrder` remain the only things that decide what is charged.

- [ ] **Step 1: Write the file**

There is no browser test harness in this repo, so this task's verification is the manual check in Step 3. Create `js/promos.js`:

```js
/* ============================================================
   EVER NOVA LIFE — promotions, in the browser
   A DISPLAY mirror of server/promotions.js. It decorates the live
   catalog in place — product.price becomes the promo price and
   product.originalPrice keeps the list price — so the existing
   card, detail and cart code shows the deal without knowing
   promotions exist (createProductCard already renders
   `product-price-old` whenever originalPrice is higher).

   Nothing here is trusted by the server. POST /api/quote re-prices
   every checkout from the catalog and the promotion store, and the
   invoice is built from the server's own arithmetic — a stale or
   tampered copy of this file changes what is DISPLAYED, never what
   is charged.
   ============================================================ */
(function (window) {
  'use strict';

  var ACTIVE = [];          // the active promotions, as the server reported them
  var loaded = false;

  var money = function (n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; };

  function apiBase() {
    return (window.ENL_CONFIG && window.ENL_CONFIG.API_BASE) || window.API_BASE || '';
  }

  /** Fetch the running promotions. Resolves to [] on any failure — no deals
      showing is always better than a wrong price on a card. */
  function load() {
    if (typeof fetch === 'undefined') return Promise.resolve([]);
    return fetch(apiBase() + '/api/promotions')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        ACTIVE = (data && Array.isArray(data.promotions)) ? data.promotions : [];
        loaded = true;
        return ACTIVE;
      })
      .catch(function () { ACTIVE = []; loaded = true; return ACTIVE; });
  }

  function list() { return ACTIVE; }
  function isLoaded() { return loaded; }

  function covers(promo, id) {
    var ids = promo.productIds || [];
    return !ids.length || ids.map(Number).indexOf(Number(id)) !== -1;
  }

  /* Mirrors salePrice() in server/promotions.js. Returns null when the deal
     would not actually lower the price. */
  function salePrice(promo, unitPrice) {
    var next;
    if (promo.mode === 'percent') next = unitPrice * (1 - promo.value / 100);
    else if (promo.mode === 'amount') next = unitPrice - promo.value;
    else next = promo.value;
    next = money(Math.max(0, next));
    return next < unitPrice ? next : null;
  }

  /** Free units a bogo would hand out for this quantity, ignoring stock —
      the browser does not know the shelf, and the server caps it anyway. */
  function freeUnitsFor(productId, quantity) {
    var best = 0;
    ACTIVE.forEach(function (p) {
      if (p.type !== 'bogo' || !covers(p, productId)) return;
      var free = Math.floor(quantity / (p.buyQty || 1)) * (p.freeQty || 0);
      if (free > best) best = free;
    });
    return best;
  }

  /* Decorate the catalog in place. `list` is window.PRODUCTS, mutated by
     loadProducts() — the same array getProductById() closes over, so every
     page that renders from it picks the promo price up automatically,
     including cart.syncPrices(). */
  function decorate(products) {
    if (!Array.isArray(products)) return products;

    products.forEach(function (p) {
      // The list price is whatever the catalog said BEFORE we touched it.
      var listPrice = money(p.originalPrice && p.promo ? p.originalPrice : p.price);
      var bestSale = null;      // { promo, unit, saving }
      var bestBogo = null;      // { promo, saving }

      ACTIVE.forEach(function (promo) {
        if (!covers(promo, p.id)) return;
        if (promo.type === 'sale') {
          var unit = salePrice(promo, listPrice);
          if (unit === null) return;
          var saving = money(listPrice - unit);
          if (!bestSale || saving > bestSale.saving) bestSale = { promo: promo, unit: unit, saving: saving };
        } else if (promo.type === 'bogo' && promo.freeQty > 0) {
          // Saving on ONE buyQty-sized set, which is what a card can honestly show.
          var per = money((promo.freeQty / promo.buyQty) * listPrice);
          if (!bestBogo || per > bestBogo.saving) bestBogo = { promo: promo, saving: per };
        }
      });

      var winner = null;
      if (bestSale && bestBogo) winner = bestSale.saving >= bestBogo.saving ? bestSale : bestBogo;
      else winner = bestSale || bestBogo;

      if (!winner) {
        // A promotion that ended between two page loads must not leave a
        // struck-through price behind.
        if (p.promo) { p.price = listPrice; delete p.originalPrice; delete p.promo; }
        return;
      }

      p.price = winner.unit !== undefined ? winner.unit : listPrice;
      p.originalPrice = listPrice;
      p.promo = {
        id: winner.promo.id,
        badge: winner.promo.badge || (winner.promo.type === 'bogo' ? 'BUY 1 GET 1' : 'SALE'),
        type: winner.promo.type,
        endsAt: winner.promo.endsAt || null,
        buyQty: winner.promo.buyQty || 1,
        freeQty: winner.promo.freeQty || 0
      };
    });

    return products;
  }

  /** The best cart-wide promo for this subtotal, or null. */
  function cartPromo(subtotal) {
    var best = null;
    ACTIVE.forEach(function (p) {
      if (p.type !== 'cart') return;
      if (Number(subtotal) < Number(p.minSubtotal || 0)) return;
      var raw = p.mode === 'percent' ? subtotal * (p.value / 100) : p.value;
      var saving = money(Math.min(Math.max(0, raw), subtotal));
      if (saving > 0 && (!best || saving > best.saving)) best = { name: p.name, saving: saving };
    });
    return best;
  }

  function freeShipping() {
    return ACTIVE.some(function (p) { return p.type === 'shipping'; });
  }

  window.Promos = {
    load: load, list: list, isLoaded: isLoaded, decorate: decorate,
    cartPromo: cartPromo, freeShipping: freeShipping, freeUnitsFor: freeUnitsFor
  };
})(window);
```

- [ ] **Step 2: Hook it into the catalog load**

In [js/main.js](../../../js/main.js), replace the body of `loadProducts()` (around line 885) with:

```js
function loadProducts() {
  if (typeof fetch === 'undefined' || !Array.isArray(window.PRODUCTS)) return;
  /* Promotions and the catalog are fetched together and applied together: a
     repaint that lands between them would flash the list price. */
  Promise.all([
    fetch(API_BASE + '/api/products').then(res => (res.ok ? res.json() : null)).catch(() => null),
    window.Promos ? window.Promos.load() : Promise.resolve([])
  ])
    .then(([data]) => {
      if (data && Array.isArray(data.products) && data.products.length) {
        // Mutate the SAME array in place so the getProductById/getFeatured…
        // helpers (which close over it) see the live data.
        window.PRODUCTS.length = 0;
        window.PRODUCTS.push(...data.products);
      }
      /* Deals are applied to the catalog itself — product.price becomes the
         promo price and originalPrice keeps the list price — so cards, the
         detail page and the cart all show the deal without a special case. */
      if (window.Promos) window.Promos.decorate(window.PRODUCTS);
      /* The cart caches the price each item was added at. Now that the live
         (and discounted) catalog is here, correct those caches BEFORE anything
         repaints — an old cart otherwise shows a total the server will not
         honour. */
      if (window.cart && typeof window.cart.syncPrices === 'function') {
        window.cart.syncPrices(window.PRODUCTS);
      }
      rerenderProducts();
    })
    .catch(() => { /* offline / cold start → keep the static catalog */ });
}
```

- [ ] **Step 3: Verify by hand**

Start the backend and open the store:

```bash
cd server && npm start
```

In another shell, create a test promotion (replace `<ADMIN_KEY>` with the value in `server/.env`, or use an admin bearer token):

```bash
curl -s -X POST http://localhost:3000/api/admin/promotions \
  -H "Content-Type: application/json" -H "x-admin-key: <ADMIN_KEY>" \
  -d '{"name":"Test 20 off","badge":"SAVE 20%","type":"sale","productIds":[1],"mode":"percent","value":20}'
```

Open `products.html` in a browser pointed at that backend. Expected: product 1 shows a struck-through old price beside a lower price. The struck-through element already exists — `createProductCard` renders `product-price-old` whenever `originalPrice > price` — so no markup change is needed for this to appear.

Then remove it:

```bash
curl -s -X DELETE http://localhost:3000/api/admin/promotions/test-20-off -H "x-admin-key: <ADMIN_KEY>"
```

Reload. Expected: the struck-through price is gone.

- [ ] **Step 4: Commit**

```bash
git add js/promos.js js/main.js
git commit -m "feat(promotions): decorate the live catalog with running deals"
```

---

### Task 8: Storefront display — chip, countdown, free units, summary rows

**Files:**
- Modify: `js/main.js` (`createProductCard`, `productDetailMarkup`, `cartRowMarkup`, `renderOrderSummary`, `checkoutTotals`, the checkout summary renderer)
- Modify: `css/styles.css`

**Interfaces:**
- Consumes: `window.Promos.cartPromo / freeShipping / freeUnitsFor` and the `product.promo` decoration from Task 7
- Produces: no new exports — this is presentation

- [ ] **Step 1: Add the promo chip to the product card**

In [js/main.js](../../../js/main.js), inside `createProductCard`, immediately after the existing `oldPrice` line, add:

```js
  /* The deal's own chip, separate from product.badge — that one says
     "Best Seller" and is not ours to overwrite. */
  const promoChip = product.promo
    ? `<span class="promo-chip">${escapeHtml(product.promo.badge)}</span>` : '';
```

Then in the returned markup, change the price row from:

```js
      <div class="product-price-row">
        <span class="product-price gradient-text">${formatPrice(product.price)}</span>
        ${oldPrice}
      </div>
```

to:

```js
      <div class="product-price-row">
        <span class="product-price gradient-text">${formatPrice(product.price)}</span>
        ${oldPrice}
        ${promoChip}
      </div>
```

- [ ] **Step 2: Add the chip and countdown to the product detail**

In `productDetailMarkup`, after the existing `oldPrice` line, add:

```js
  const promoChip = product.promo
    ? `<span class="promo-chip">${escapeHtml(product.promo.badge)}</span>` : '';
  /* A deal with an end date says so. Rounded UP, because "ends in 0 days"
     on the last day reads as "already over". */
  const daysLeft = product.promo && product.promo.endsAt
    ? Math.ceil((Date.parse(product.promo.endsAt) - Date.now()) / 86400000) : 0;
  const promoEnds = daysLeft > 0
    ? `<p class="promo-ends">${iconAlert()} Ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}</p>` : '';
```

Then change the detail price row from:

```js
      <div class="detail-price-row">
        <span class="detail-price gradient-text">${formatPrice(product.price)}</span>
        ${oldPrice}
        <span class="stock-pill ${st.cls}">${st.label}</span>
      </div>
```

to:

```js
      <div class="detail-price-row">
        <span class="detail-price gradient-text">${formatPrice(product.price)}</span>
        ${oldPrice}
        ${promoChip}
        <span class="stock-pill ${st.cls}">${st.label}</span>
      </div>
      ${promoEnds}
```

- [ ] **Step 3: Show the free units on the cart line**

In the cart row markup (the function around [js/main.js:1680](../../../js/main.js#L1680) that returns `<div class="cart-row ...">`), after the existing `warn` block, add:

```js
  /* A bogo line ships more than it bills. Say so on the line — the summary
     total alone makes it look like the free vial was forgotten. */
  const freeUnits = window.Promos ? window.Promos.freeUnitsFor(item.id, item.quantity) : 0;
  const freeNote = freeUnits > 0
    ? `<p class="cart-row-free">${iconCheckCircle()} +${freeUnits} free with this deal</p>` : '';
```

and insert `${freeNote}` immediately after `${warn}` inside `<div class="cart-row-info">`.

- [ ] **Step 4: Add the promo rows to both order summaries**

In `renderOrderSummary` (around [js/main.js:1818](../../../js/main.js#L1818)), replace the function body's `const ship = ...` line and the `el.innerHTML = ...` template with:

```js
  const ship = cart.getShipping();
  const remaining = FREE_SHIP_THRESHOLD - cart.getSubtotal();
  const deal = window.Promos ? window.Promos.cartPromo(cart.getSubtotal()) : null;
  const freeShip = window.Promos && window.Promos.freeShipping();
  const shipCost = freeShip ? 0 : ship;
  const total = cart.getSubtotal() - (deal ? deal.saving : 0) + shipCost + cart.getTax();
  el.innerHTML = `
    <h3>Order Summary</h3>
    <div class="summary-row"><span>Subtotal (${cart.getItemCount()} items)</span><span>${formatPrice(cart.getSubtotal())}</span></div>
    ${deal ? `<div class="summary-row discount"><span>${escapeHtml(deal.name)}</span><span>−${formatPrice(deal.saving)}</span></div>` : ''}
    <div class="summary-row"><span>Shipping</span><span>${shipCost === 0 ? 'FREE' : formatPrice(shipCost)}</span></div>
    <div class="summary-row"><span>Tax (${taxRateLabel()})</span><span>${formatPrice(cart.getTax())}</span></div>
    <div class="summary-row total"><span>Total</span><span>${formatPrice(total)}</span></div>
    ${freeShip
      ? `<p class="summary-note"><span class="summary-note-ic">${iconTruckLine()}</span>Free shipping on every order right now</p>`
      : remaining > 0
        ? `<p class="summary-note"><span class="summary-note-ic">${iconTruckLine()}</span>Add ${formatPrice(remaining)} more for free shipping</p>`
        : `<p class="summary-note"><span class="summary-note-ic">${iconCheckCircle()}</span>Free shipping unlocked</p>`}
    ${withCheckoutBtn ? `<a class="btn btn-primary btn-block" href="${checkoutHref()}">Proceed to Checkout</a>` : ''}
    ${withCheckoutBtn && !isSignedIn()
      ? `<p class="summary-note">An account is required to check out — you'll be asked to sign in or register next.</p>` : ''}
    <p class="summary-note"><span class="summary-note-ic">${iconLock()}</span>Secure checkout · Research use only</p>`;
```

The checkout page's own summary (`checkoutTotals` around [js/main.js:1996](../../../js/main.js#L1996) and its renderer around line 2196) is **already server-backed** — it shows whatever `POST /api/quote` returned. Add `promoDiscount` to what it displays: in the renderer, immediately before the existing points-discount row, insert:

```js
    ${t.promoDiscount > 0 ? `<div class="summary-row discount"><span>Promotion</span><span>−${formatPrice(t.promoDiscount)}</span></div>` : ''}
```

and in `checkoutTotals`, carry the field through by adding `promoDiscount` to the returned object, reading it from the quote response the same way `shipping` and `shippingLabel` are read. Then extend the `/api/quote` response in `server/server.js` to include it — in the `app.post('/api/quote', ...)` handler, add two lines beside `subtotal`:

```js
      promoDiscount: order.promoDiscount,
      promos: order.promos,
```

- [ ] **Step 5: Add the CSS**

Append to [css/styles.css](../../../css/styles.css):

```css
/* ---- promotions ----
   The deal's own chip, distinct from .product-badge (which says
   "Best Seller" and belongs to the product, not the campaign). */
.promo-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #07040f;
  background: linear-gradient(135deg, #f5d982, #d4af37);
  white-space: nowrap;
}

.promo-ends {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
  color: #d4af37;
}
.promo-ends svg { width: 1em; height: 1em; flex: none; }

.cart-row-free {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  color: #7bd88f;
}
.cart-row-free svg { width: 1em; height: 1em; flex: none; }
```

- [ ] **Step 6: Verify by hand**

With the backend running and a test promotion created as in Task 7:

1. `products.html` — the SKU shows a struck price and a gold chip.
2. `product.html?id=1` — chip and "Ends in N days" (create the promo with an `endsAt` ten days out to see it).
3. Create a bogo promo, add the SKU to the cart — the cart line reads "+1 free with this deal".
4. Create a cart promo with `minSubtotal: 0` — the cart summary shows its name and a negative amount, and the total drops by it.
5. Go to checkout — the summary shows a "Promotion" row, and the figure matches what the cart said.

- [ ] **Step 7: Commit**

```bash
git add js/main.js css/styles.css server/server.js
git commit -m "feat(promotions): show deals on cards, product pages, cart and checkout"
```

---

### Task 9: The admin Promotions view

**Files:**
- Modify: `js/admin-core.js` (NAV entry + one icon)
- Modify: `js/admin-console.js` (state, load, titles, router, view, handlers)
- Modify: `css/admin.css`

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/admin/promotions` from Task 5
- Produces: no new exports — this is the admin UI

- [ ] **Step 1: Add the rail entry and its icon**

In [js/admin-core.js](../../../js/admin-core.js), add to the `ICONS` object (beside `tag`):

```js
    percent: '<path d="M19 5 5 19"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>',
```

and add to the `NAV` array, immediately after the `rates` entry:

```js
    { key: 'promos', href: 'admin.html#promos', label: 'Promotions', icon: 'percent' },
```

- [ ] **Step 2: Load the promotions with everything else**

In [js/admin-console.js](../../../js/admin-console.js):

**2a.** In the `state` object, beside `rates: null,`, add:

```js
    promos: null,         // promotions (what the shop is discounting right now)
```

**2b.** In `loadAll`, add an eighth read to the `Promise.allSettled` array, after `A.api('/api/admin/label-design')`:

```js
      A.api('/api/admin/promotions')
```

**2c.** After the `state.design = ...` assignment, add:

```js
    state.promos = results[7].status === 'fulfilled' ? (results[7].value.promotions || []) : (state.promos || null);
```

**2d.** In the `results.forEach` error reporter, add the same 404-is-fine guard the other two have, before the `A.toast(...)`:

```js
        // Promotions: a 404 means the backend predates them; the view says so.
        if (i === 7 && r.reason.status === 404) return;
```

and extend the label array at the end of that `A.toast` call to `['Orders', 'Users', 'Auto-ship plans', 'Products', 'Health', 'Shipping rates', 'Label design', 'Promotions']`.

**2e.** In `TITLES`, after the `rates` entry:

```js
    promos: ['Promotions', 'Deals the shop is running — they apply to the next checkout immediately'],
```

**2f.** In `render()`, after `else if (state.view === 'rates') renderRates();`:

```js
    else if (state.view === 'promos') renderPromos();
```

- [ ] **Step 3: Write the view**

In `js/admin-console.js`, add this block immediately after `renderRates` and its helpers (after `saveRate`):

```js
  /* ============================================================
     PROMOTIONS
     Scheduled deals, as editable data. Saving here changes what the
     NEXT customer is charged — pricing.js reads the same list, so
     there is nothing to deploy and nothing to keep in step by hand.

     Three tabs off one array: what is running, what is waiting for
     its start date, and what is over. An expired promotion is kept
     rather than deleted, because "run last month's deal again" is
     the most common next thing anyone wants.
     ============================================================ */
  var PROMO_TYPES = [
    ['sale', 'Sale price', 'A product costs less for a while'],
    ['bogo', 'Buy X get Y', 'Buy 1 get 1, buy 2 get 1 — the free units ship free'],
    ['cart', 'Cart discount', 'Money off the whole order over a minimum'],
    ['shipping', 'Free shipping', 'Delivery is free while this runs']
  ];
  var promoTab = 'live';

  function promoState(p) {
    var now = Date.now();
    if (p.enabled === false) return 'off';
    if (p.startsAt && Date.parse(p.startsAt) > now) return 'scheduled';
    if (p.endsAt && Date.parse(p.endsAt) <= now) return 'expired';
    return 'live';
  }

  /* What this promotion actually does, in one line, so the table can be read
     without opening every row. */
  function promoRule(p) {
    if (p.type === 'shipping') return 'Free shipping on every order';
    if (p.type === 'bogo') return 'Buy ' + p.buyQty + ', get ' + p.freeQty + ' free';
    var off = p.mode === 'percent' ? p.value + '% off'
      : p.mode === 'amount' ? money(p.value) + ' off'
      : 'price set to ' + money(p.value);
    if (p.type === 'cart') return off + ' the order' + (p.minSubtotal > 0 ? ' over ' + money(p.minSubtotal) : '');
    return off;
  }

  function promoScope(p) {
    if (p.type === 'cart' || p.type === 'shipping') return 'Whole order';
    if (!p.productIds || !p.productIds.length) return 'Every product';
    var names = p.productIds.map(function (id) {
      var hit = (state.products || []).find(function (pr) { return Number(pr.id) === Number(id); });
      return hit ? hit.name : '#' + id;
    });
    return names.join(', ');
  }

  function promoWindow(p) {
    if (!p.startsAt && !p.endsAt) return 'No end date';
    var from = p.startsAt ? A.date(p.startsAt) : 'now';
    var to = p.endsAt ? A.date(p.endsAt) : 'no end';
    return from + ' → ' + to;
  }

  function renderPromos() {
    var promos = state.promos;

    if (!promos) {
      body.innerHTML = '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Promotions are not available</h3></div>' +
        '<p class="adm-note" style="margin:0">This backend does not have promotions yet — deploy the ' +
        'current <code>server/</code> to Render. Until then every order is charged at catalog price.</p></div>';
      return;
    }

    var groups = { live: [], scheduled: [], expired: [], off: [] };
    promos.forEach(function (p) { groups[promoState(p)].push(p); });
    // The off-switch list belongs with whatever else isn't charging anyone.
    groups.expired = groups.expired.concat(groups.off);

    var shown = groups[promoTab] || [];

    body.innerHTML =
      '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Deals</h3>' +
          '<span class="hint">saving one changes what the next customer pays</span></div>' +
        '<div class="seg" id="promoTabs" role="group" aria-label="Promotion state">' +
          [['live', 'Live', groups.live.length],
           ['scheduled', 'Scheduled', groups.scheduled.length],
           ['expired', 'Finished', groups.expired.length]].map(function (t) {
            return '<button type="button" data-ptab="' + t[0] + '" aria-pressed="' + (promoTab === t[0]) + '">' +
              t[1] + ' (' + t[2] + ')</button>';
          }).join('') +
        '</div>' +
        (shown.length
          ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
              '<th>Promotion</th><th>What it does</th><th>Applies to</th><th>When</th><th></th>' +
            '</tr></thead><tbody>' + shown.map(promoRow).join('') + '</tbody></table></div>'
          : '<p class="adm-note" style="margin:0">Nothing here yet.</p>') +
      '</div>' +

      '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Create a promotion</h3>' +
          '<span class="hint">e.g. buy 1 get 1, or 20% off for ten days</span></div>' +
        promoForm('new', { id: '', name: '', badge: '', type: 'sale', productIds: [], mode: 'percent',
                           value: '', buyQty: 1, freeQty: 1, minSubtotal: 0,
                           startsAt: '', endsAt: '', enabled: true, sort: 50 }) +
      '</div>' +

      '<p class="adm-note">Only the <strong>best</strong> deal applies to any one product — a sale and a ' +
        'buy-one-get-one on the same product will not stack, the customer gets whichever is worth more. ' +
        'One cart-wide discount applies on top of that. Repeating <a href="admin.html#autoship">auto-ship</a> ' +
        'invoices are always charged at catalog price.</p>';
  }

  function promoRow(p) {
    var st = promoState(p);
    var pill = st === 'live' ? 'paid' : st === 'scheduled' ? 'pending' : 'cancelled';
    return '<tr>' +
      '<td><strong>' + esc(p.name) + '</strong>' +
        (p.badge ? ' <span class="pill ' + pill + '">' + esc(p.badge) + '</span>' : '') +
        '<span class="muted">' + esc(p.id) + '</span></td>' +
      '<td>' + esc(promoRule(p)) + '</td>' +
      '<td>' + esc(promoScope(p)) + '</td>' +
      '<td>' + esc(promoWindow(p)) + (p.enabled === false ? ' <span class="muted">(switched off)</span>' : '') + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-ghost btn-sm act-promo-edit" data-id="' + esc(p.id) + '">Edit</button> ' +
        '<button class="btn btn-ghost btn-sm act-promo-del" data-id="' + esc(p.id) +
          '" data-name="' + esc(p.name) + '">Delete</button>' +
      '</td>' +
    '</tr>' +
    '<tr class="promo-edit-row" id="promo-edit-' + esc(p.id) + '" hidden>' +
      '<td colspan="5">' + promoForm(p.id, p) + '</td>' +
    '</tr>';
  }

  /* A datetime-local input wants 'YYYY-MM-DDTHH:mm' in LOCAL time; the store
     holds UTC ISO. Convert both ways or the owner sets a start date and the
     form shows a different one back. */
  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fromLocalInput(v) {
    if (!v) return null;
    var t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }

  function promoForm(key, p) {
    var pre = 'promo-' + key + '-';
    var ids = (p.productIds || []).join(',');
    var opts = (state.products || []).map(function (pr) {
      return '<label class="form-check"><input type="checkbox" class="' + pre + 'sku" value="' + esc(pr.id) + '"' +
        ((p.productIds || []).map(Number).indexOf(Number(pr.id)) !== -1 ? ' checked' : '') + '> ' +
        esc(pr.name) + '</label>';
    }).join('');

    return '<div class="promo-form" data-key="' + esc(key) + '">' +
      '<div class="form-field"><label for="' + pre + 'name">Name</label>' +
        '<input id="' + pre + 'name" type="text" value="' + esc(p.name || '') + '" placeholder="Retatrutide — Buy 1 Get 1"></div>' +
      '<div class="form-field"><label for="' + pre + 'badge">Badge on the shop</label>' +
        '<input id="' + pre + 'badge" type="text" maxlength="16" value="' + esc(p.badge || '') + '" placeholder="BUY 1 GET 1"></div>' +
      '<div class="form-field"><label for="' + pre + 'type">Type</label>' +
        '<select id="' + pre + 'type" class="promo-type">' +
          PROMO_TYPES.map(function (t) {
            return '<option value="' + t[0] + '"' + (p.type === t[0] ? ' selected' : '') + '>' + esc(t[1]) + '</option>';
          }).join('') +
        '</select></div>' +

      '<div class="form-field promo-if-sale promo-if-cart"><label for="' + pre + 'mode">Discount</label>' +
        '<select id="' + pre + 'mode">' +
          [['percent', '% off'], ['amount', '$ off'], ['fixed', 'set the price to']].map(function (m) {
            return '<option value="' + m[0] + '"' + (p.mode === m[0] ? ' selected' : '') + '>' + esc(m[1]) + '</option>';
          }).join('') +
        '</select></div>' +
      '<div class="form-field promo-if-sale promo-if-cart"><label for="' + pre + 'value">Amount</label>' +
        '<input id="' + pre + 'value" type="number" min="0" step="0.01" value="' + esc(p.value === '' ? '' : p.value) + '" placeholder="20"></div>' +

      '<div class="form-field promo-if-bogo"><label for="' + pre + 'buy">Buy</label>' +
        '<input id="' + pre + 'buy" type="number" min="1" step="1" value="' + esc(p.buyQty || 1) + '"></div>' +
      '<div class="form-field promo-if-bogo"><label for="' + pre + 'free">Get free</label>' +
        '<input id="' + pre + 'free" type="number" min="0" step="1" value="' + esc(p.freeQty == null ? 1 : p.freeQty) + '"></div>' +

      '<div class="form-field promo-if-cart"><label for="' + pre + 'min">Order must be over ($)</label>' +
        '<input id="' + pre + 'min" type="number" min="0" step="1" value="' + esc(p.minSubtotal || 0) + '"></div>' +

      '<div class="form-field"><label for="' + pre + 'starts">Starts</label>' +
        '<input id="' + pre + 'starts" type="datetime-local" value="' + esc(toLocalInput(p.startsAt)) + '"></div>' +
      '<div class="form-field"><label for="' + pre + 'ends">Ends</label>' +
        '<input id="' + pre + 'ends" type="datetime-local" value="' + esc(toLocalInput(p.endsAt)) + '"></div>' +

      '<div class="form-field promo-if-sale promo-if-bogo promo-skus"><label>Products <span class="hint">none ticked = every product</span></label>' +
        '<div class="promo-sku-list" data-ids="' + esc(ids) + '">' + (opts || '<span class="muted">No products loaded</span>') + '</div></div>' +

      '<label class="form-check"><input id="' + pre + 'enabled" type="checkbox" ' +
        (p.enabled !== false ? 'checked' : '') + '> Running (untick to switch it off without deleting it)</label>' +
      '<button class="btn btn-primary act-promo-save" data-key="' + esc(key) + '" data-id="' + esc(p.id || '') + '">' +
        (key === 'new' ? 'Create promotion' : 'Save') + '</button>' +
    '</div>';
  }

  function togglePromoEdit(id) {
    var row = document.getElementById('promo-edit-' + id);
    if (row) row.hidden = !row.hidden;
  }

  /* Only show the fields the chosen type actually uses — a bogo has no
     percentage and a free-shipping promo has neither. */
  function syncPromoFields(form) {
    var sel = form.querySelector('.promo-type');
    if (!sel) return;
    var type = sel.value;
    form.querySelectorAll('[class*="promo-if-"]').forEach(function (el) {
      el.hidden = !el.classList.contains('promo-if-' + type);
    });
  }

  async function savePromo(key, id, btn) {
    var pre = 'promo-' + key + '-';
    var val = function (s) { var el = document.getElementById(pre + s); return el ? el.value : ''; };
    var checked = function (s) { var el = document.getElementById(pre + s); return !!(el && el.checked); };
    var skus = Array.prototype.slice.call(document.querySelectorAll('.' + pre + 'sku'))
      .filter(function (c) { return c.checked; })
      .map(function (c) { return Number(c.value); });

    var payload = {
      id: id || '',
      name: val('name'),
      badge: val('badge'),
      type: val('type'),
      productIds: skus,
      mode: val('mode'),
      value: Number(val('value')) || 0,
      buyQty: Number(val('buy')) || 1,
      freeQty: Number(val('free')) || 0,
      minSubtotal: Number(val('min')) || 0,
      startsAt: fromLocalInput(val('starts')),
      endsAt: fromLocalInput(val('ends')),
      enabled: checked('enabled')
    };

    btn.disabled = true;
    try {
      var out = await A.api('/api/admin/promotions', { method: 'POST', body: payload });
      state.promos = out.promotions || [];
      A.toast('Saved — it applies to the next checkout', 'ok');
      render();
    } catch (e) {
      A.toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function deletePromo(id, name) {
    if (!confirm('Delete "' + name + '"? Orders already placed keep the price they were charged.')) return;
    try {
      var out = await A.api('/api/admin/promotions/' + encodeURIComponent(id), { method: 'DELETE' });
      state.promos = out.promotions || [];
      A.toast('Deleted', 'ok');
      render();
    } catch (e) {
      A.toast(e.message, 'error');
    }
  }
```

- [ ] **Step 4: Wire the click and change handlers**

In `js/admin-console.js`, in the delegated click handler (the block containing `act-rate-save` around line 2145), add beside it:

```js
      else if (t.classList.contains('act-promo-save')) savePromo(t.getAttribute('data-key'), t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-promo-edit')) togglePromoEdit(t.getAttribute('data-id'));
      else if (t.classList.contains('act-promo-del')) deletePromo(t.getAttribute('data-id'), t.getAttribute('data-name'));
      else if (t.hasAttribute('data-ptab')) { promoTab = t.getAttribute('data-ptab'); render(); }
```

In the delegated `change` handler (the one that contains `if (state.view === 'labeldesign') updateLabelPreview();`), add at the top of the callback:

```js
    var typeSel = e.target.closest('.promo-type');
    if (typeSel) { syncPromoFields(typeSel.closest('.promo-form')); return; }
```

And so the form opens with the right fields showing, call `syncPromoFields` on every form once the view paints — at the end of `renderPromos`, add:

```js
    body.querySelectorAll('.promo-form').forEach(syncPromoFields);
```

- [ ] **Step 5: Add the CSS**

Append to [css/admin.css](../../../css/admin.css):

```css
/* ---- promotions ----
   Same grid as .rate-form: label-over-input fields that wrap, so the
   form reads as one row of settings rather than a column of questions. */
.promo-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1rem;
  align-items: flex-end;
  padding: 0.75rem 0;
}
.promo-form .form-field { min-width: 10rem; }
.promo-form .promo-skus { flex: 1 1 100%; min-width: 0; }

.promo-sku-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1rem;
  max-height: 9rem;
  overflow-y: auto;
  padding: 0.5rem 0.65rem;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
}
.promo-sku-list .form-check { margin: 0; white-space: nowrap; }
```

- [ ] **Step 6: Verify by hand**

With the backend running, open `admin.html#promos` signed in as an admin:

1. The rail shows **Promotions** under Shipping rates.
2. Create "Retatrutide — Buy 1 Get 1": type **Buy X get Y**, buy 1, get 1, tick Retatrutide. It appears under **Live**.
3. Change the type dropdown to **Sale price** — the buy/get fields disappear and the discount fields appear.
4. Create a sale with a start date next week — it lands under **Scheduled**, and `GET /api/promotions` (unauthenticated) does **not** list it.
5. Delete both. The tables empty.

- [ ] **Step 7: Commit**

```bash
git add js/admin-core.js js/admin-console.js css/admin.css
git commit -m "feat(promotions): admin console view for creating and scheduling deals"
```

---

### Task 10: Ship it — script tag, cache-busters, docs

**Files:**
- Modify: all 23 HTML pages that load `js/main.js` (add the `promos.js` tag, bump busters)
- Modify: `admin.html` (bump busters)
- Modify: `server/README.md`, `docs/content-needed.md` if it mentions promotions

**Interfaces:**
- Consumes: everything above
- Produces: a deployable tree

The current busters are inconsistent (`styles.css?v=62`, `main.js?v=65`, admin at `?v=64`). Every asset **changed by this feature** goes to a single new value: **`?v=66`**. Files this feature did not touch keep their current value — bumping an unchanged file just re-downloads it for nothing.

Changed assets: `css/styles.css`, `css/admin.css`, `js/main.js`, `js/cart.js` (unchanged by this plan — **do not bump**), `js/admin-console.js`, `js/admin-core.js`, and the new `js/promos.js`.

- [ ] **Step 1: Add the script tag to every storefront page**

`js/promos.js` must load **after** `js/config.js` (it reads `API_BASE`) and **before** `js/main.js` (which calls `window.Promos`). The 23 pages are:

`404.html about.html account.html cart.html checkout.html contact.html faq.html forgot-password.html index.html login.html order-status.html pay.html privacy.html product.html products.html quality.html register.html reset-password.html research-accounts.html returns.html shipping.html terms.html wishlist.html`

In each, insert a new line immediately before the `<script src="js/main.js?v=...">` line:

```html
  <script src="js/promos.js?v=66"></script>
```

Do this with the Edit tool or Python (`encoding='utf-8', newline=''`) — **never** PowerShell `Get-Content`/`Out-File`, which double-encodes the non-ASCII characters these pages contain.

A Python helper that does all 23 at once:

```python
import re, pathlib

PAGES = """404 about account cart checkout contact faq forgot-password index login
order-status pay privacy product products quality register reset-password
research-accounts returns shipping terms wishlist""".split()

TAG = '  <script src="js/promos.js?v=66"></script>\n'

for name in PAGES:
    p = pathlib.Path(name + '.html')
    text = p.read_text(encoding='utf-8')
    if 'js/promos.js' in text:
        continue
    m = re.search(r'^.*<script src="js/main\.js\?v=\d+"></script>\s*$', text, re.M)
    assert m, name
    text = text[:m.start()] + TAG + text[m.start():]
    p.write_text(text, encoding='utf-8', newline='')
    print('added to', name)
```

- [ ] **Step 2: Bump the busters on the changed assets**

Run from the project root:

```python
import re, pathlib

CHANGED = ['css/styles.css', 'css/admin.css', 'js/main.js', 'js/admin-console.js', 'js/admin-core.js']

for p in pathlib.Path('.').glob('*.html'):
    text = p.read_text(encoding='utf-8')
    out = text
    for asset in CHANGED:
        out = re.sub(re.escape(asset) + r'\?v=\d+', asset + '?v=66', out)
    if out != text:
        p.write_text(out, encoding='utf-8', newline='')
        print('bumped', p.name)
```

- [ ] **Step 3: Verify no page is missing the tag and no buster was missed**

```bash
grep -L 'js/promos.js' $(grep -l 'js/main.js' *.html)
```
Expected: no output

```bash
grep -oh 'styles\.css?v=[0-9]*\|admin\.css?v=[0-9]*\|main\.js?v=[0-9]*\|admin-console\.js?v=[0-9]*\|admin-core\.js?v=[0-9]*\|promos\.js?v=[0-9]*' *.html | sort -u
```
Expected: every line ends in `?v=66`

- [ ] **Step 4: Document it**

Append to [server/README.md](../../../server/README.md), in the same style as the shipping-rates section:

```markdown
### Promotions

Scheduled deals, stored in `promotions.json` on `DATA_DIR` and managed at
`admin.html#promos`. Four types: a **sale** price on a product for a date
range, **bogo** (buy X get Y — the free units ship free and come off stock),
a **cart** discount over a minimum subtotal, and free **shipping**.

`pricing.js` applies them inside `buildOrder()`, so every payment path is
covered by one call and none of them needs to know promotions exist. The
rules: the single best sale-or-bogo per line (they never stack), plus at most
one cart-wide promo, plus free shipping. `order.promoDiscount` holds the
cart-level saving and `order.promos` records what applied;
`order.discount` still means loyalty points only.

Two things deliberately opt out. **Auto-ship** invoices pass
`{ noPromos: true }` and always bill at catalog price — a ten-day sale must
not follow a subscriber around for the life of their plan. And a **bogo
degrades** rather than failing when `stockQty` cannot cover the free unit:
the customer is charged normally instead of being refused at checkout.

`GET /api/promotions` is public but returns only what is running — a campaign
scheduled for Friday is not readable on Tuesday.
```

- [ ] **Step 5: Run the whole suite one last time**

```bash
cd server && npm test
```
Expected: PASS — 0 fail

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(promotions): load the promo mirror site-wide, bump cache-busters to v66"
```

---

## Deployment

Not a task — the checklist to hand the owner once the plan is done.

**Backend (Render).** Push to git; Render redeploys. New file `server/promotions.js`; changed `server/pricing.js` and `server/server.js`. No new env vars, no new dependency. Promotions persist to `DATA_DIR/promotions.json`, so the Render Disk must be mounted with `DATA_DIR` set — the same requirement products and orders already have. Confirm this before creating a real promotion, or a redeploy wipes it.

**Static (GoDaddy), two passes.** Cloudflare caches css and js for four hours, so uploading the HTML first would bind the *old* asset to the new `?v=66` name.

Pass 1 — upload, then wait ~30 seconds:
`js/promos.js`, `js/main.js`, `js/admin-console.js`, `js/admin-core.js`, `css/styles.css`, `css/admin.css`

Pass 2 — the 24 HTML pages (23 storefront pages plus `admin.html`).

Nothing under `server/`, `docs/` or `tools/` goes to GoDaddy.

**Verify live:**
1. `GET https://<render-host>/api/promotions` answers `{"success":true,"promotions":[]}`
2. `admin.html#promos` shows the Promotions rail entry and an empty Live tab
3. Create a 10% sale on one SKU → `products.html` shows a struck-through price and a gold chip
4. Add that SKU to the cart, go to checkout → the summary total matches the cart total
5. Delete the test promotion → the struck price disappears on reload
