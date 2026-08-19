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
