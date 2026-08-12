/* ============================================================
   EVER NOVA LIFE — shipping methods (admin-managed)
   The shipping fee used to be two constants compiled into
   pricing.js, which meant the published rate table, the browser's
   maths and the amount actually charged were three copies of the
   same numbers kept in step by hand. This store makes the rates
   editable at runtime — same durable-storage pattern as products
   and orders — and pricing.js resolves the charge from HERE, so
   what the customer picks is what the invoice asks for.

   A method is:
     id        stable slug ('standard', 'expedited', …)
     name      what the buyer sees ("Expedited")
     price     the fee in dollars
     eta       delivery estimate, free text ("2 business days")
     freeOver  subtotal at which this method costs nothing
               (0 / null = never free)
     enabled   offered at checkout at all
     sort      display order, low first

   Deleting the last enabled method would leave checkout with
   nothing to charge, so that is refused: keep one, or disable it.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'shipping.json');

/* The rates the site has always published (shipping.html) — including the two
   tiers the old checkout could never actually sell. Seeded once; after that the
   admin owns them. Expedited and Overnight start DISABLED: they cost real money
   to honour, so they appear at checkout only once someone has decided the store
   can actually ship that fast. */
const SEED = [
  { id: 'standard',  name: 'Standard',  price: 9.99,  eta: '3–5 business days',  freeOver: 100, enabled: true,  sort: 10 },
  { id: 'expedited', name: 'Expedited', price: 19.99, eta: '2 business days',    freeOver: 0,   enabled: false, sort: 20 },
  { id: 'overnight', name: 'Overnight', price: 34.99, eta: 'Next business day',  freeOver: 0,   enabled: false, sort: 30 }
];

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(FILE)) {
    try { save(SEED); } catch (e) { /* fall through to the in-memory seed */ }
    return SEED.map(m => ({ ...m }));
  }
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(arr) || !arr.length) return SEED.map(m => ({ ...m }));
    return arr.map(normalise);
  } catch (e) {
    console.error('[shipping] store unreadable, using seed:', e.message);
    return SEED.map(m => ({ ...m }));
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

/* A stored row, made safe to price from: a negative fee or a missing name is a
   typo, not a shipping option. */
function normalise(m) {
  const price = Math.max(0, money(Number(m && m.price) || 0));
  return {
    id: str(m && m.id, 40) || 'method',
    name: str(m && m.name, 60) || 'Shipping',
    price,
    eta: str(m && m.eta, 60),
    freeOver: Math.max(0, money(Number(m && m.freeOver) || 0)),
    enabled: m && m.enabled !== false,
    sort: Number.isFinite(Number(m && m.sort)) ? Number(m.sort) : 50
  };
}

const bySort = (a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name);

/** Every method, enabled or not — the admin's view. */
function listAll() {
  return load().sort(bySort);
}

/** What checkout may offer. */
function listEnabled() {
  return load().filter(m => m.enabled).sort(bySort);
}

/* Turn an id into a fee for this subtotal. Falls back to the cheapest enabled
   method rather than throwing: a cart saved before a method was disabled must
   still be able to check out, and the customer is shown the resolved method in
   the totals either way.

   Returns { method, fee } — `method` is null only when the store has no enabled
   method at all, which the admin API prevents. */
function quote(methodId, subtotal) {
  const enabled = listEnabled();
  if (!enabled.length) return { method: null, fee: 0 };
  const wanted = methodId ? enabled.find(m => m.id === String(methodId)) : null;
  const method = wanted || enabled.slice().sort((a, b) => a.price - b.price)[0];
  const free = method.freeOver > 0 && Number(subtotal) >= method.freeOver;
  return { method, fee: free ? 0 : method.price };
}

function upsert(input) {
  const list = load();
  const incoming = normalise({
    ...input,
    // A blank id on a new method is derived from the name, so the admin form
    // never has to think about slugs.
    id: input && input.id ? input.id : slug(input && input.name)
  });
  if (!incoming.name) throw badRequest('A shipping method needs a name.');

  const at = list.findIndex(m => m.id === incoming.id);
  if (at === -1) list.push(incoming);
  else list[at] = { ...list[at], ...incoming };

  assertOneEnabled(list);
  save(list);
  return incoming;
}

function remove(id) {
  const list = load();
  const at = list.findIndex(m => m.id === String(id));
  if (at === -1) throw badRequest('No shipping method with that id.');
  const kept = list.filter((_, i) => i !== at);
  if (!kept.length) throw badRequest('Keep at least one shipping method — checkout has to charge something.');
  assertOneEnabled(kept);
  save(kept);
  return list[at];
}

/* Checkout has to have something to offer. Without this, disabling the last
   method takes the whole shop offline in a way that looks like a payment bug. */
function assertOneEnabled(list) {
  if (!list.some(m => m.enabled)) {
    throw badRequest('At least one shipping method must stay enabled — otherwise checkout has nothing to charge.');
  }
}

function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

module.exports = { listAll, listEnabled, quote, upsert, remove, SEED };
