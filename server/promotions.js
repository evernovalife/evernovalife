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

module.exports = { listAll, listActive, isActive, normalise, upsert, remove, money, evaluate };
