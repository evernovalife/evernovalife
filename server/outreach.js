/* ============================================================
   EVER NOVA LIFE — outreach state (who has already been emailed)
   Three unrelated reminders share one file because they share one
   question: "have we already said this?"

     · abandoned carts   — a saved cart that sat still and never
                           became an order
     · unpaid orders     — an order that opened and never got paid.
                           This is the leak that mattered: crypto is
                           push-only, so an invoice nobody pays just
                           goes quiet. Two reminders, then we stop.
     · low stock         — the owner is told once per crossing, not
                           once per tick

   DATA_DIR/outreach.json →
     { carts:  { [userId]:    { signature, firstSeenAt, nudgedAt, lastNudgeAt } },
       orders: { [orderId]:   { stage, lastAt } },
       stock:  { [productId]: { level, alertedAt } } }

   This module decides WHO is due and records that it happened. It
   sends nothing — server.js owns the email templates, so the rules
   here stay testable without SMTP.

   No cart timestamps existed to work from (carts.json is a plain
   map of item arrays), so "how long has this cart sat there" is
   measured from the first tick that OBSERVED it rather than from
   the save itself. Worst case a nudge is one tick late, which is
   the right way to be wrong.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'outreach.json');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/* ---- tunables (env-overridable, sane defaults) ---- */
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const CART_NUDGE_HOURS = num(process.env.CART_NUDGE_HOURS, 20);
const CART_COOLDOWN_DAYS = num(process.env.CART_NUDGE_COOLDOWN_DAYS, 7);
const LOW_STOCK_THRESHOLD = num(process.env.LOW_STOCK_THRESHOLD, 5);

/* Two reminders on an unpaid order and then silence. The first is same-day
   ("your invoice may have expired"), the second two days later ("last call").
   A third would be nagging someone who has decided not to buy. */
function nudgeStages() {
  const raw = String(process.env.ORDER_NUDGE_HOURS || '6,48')
    .split(',')
    .map(s => Number(String(s).trim()))
    .filter(n => Number.isFinite(n) && n > 0);
  const stages = raw.length ? raw : [6, 48];
  return stages.sort((a, b) => a - b);
}

/* Orders worth chasing: money is expected and none (or not all) arrived. */
const CHASEABLE = ['pending', 'awaiting_payment', 'underpaid'];

/* ---- state file ---- */
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function load() {
  ensureDir();
  let obj = null;
  try {
    obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    obj = null;   // missing / unreadable → start empty
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  return {
    carts: obj.carts && typeof obj.carts === 'object' ? obj.carts : {},
    orders: obj.orders && typeof obj.orders === 'object' ? obj.orders : {},
    stock: obj.stock && typeof obj.stock === 'object' ? obj.stock : {},
    /* One record, not a map: there is only one disk. `null` = nothing
       outstanding, which is what makes the re-arm below readable. */
    storage: obj.storage && typeof obj.storage === 'object' ? obj.storage : null
  };
}
function save(state) {
  ensureDir();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);      // atomic on the same filesystem
}

/* ---- helpers ---- */
const ms = iso => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
};

/* What the buyer has in the cart, as one comparable string. A changed cart is
   a changed intention, so it earns a fresh reminder. */
function cartSignature(items) {
  return (items || [])
    .filter(i => i && i.id != null)
    .map(i => `${i.id}x${Number(i.quantity) || 0}`)
    .sort()
    .join('|');
}

/* ============================================================
   ABANDONED CARTS
   candidates: [{ userId, email, items, lastOrderAt }]
   Returns the ones due a nudge, newest observation recorded either
   way — seeing a cart is what starts its clock.
   ============================================================ */
function selectCartNudges(candidates, now = Date.now()) {
  const state = load();
  const due = [];

  const seen = new Set();
  for (const c of candidates || []) {
    if (!c || !c.userId) continue;
    seen.add(c.userId);
    const items = Array.isArray(c.items) ? c.items : [];
    const signature = cartSignature(items);

    // An empty cart has nothing to come back to — forget it entirely, so
    // refilling it later starts a clean clock.
    if (!signature) { delete state.carts[c.userId]; continue; }

    let entry = state.carts[c.userId];
    if (!entry || entry.signature !== signature) {
      // First sighting of this cart (or they changed it) → restart the clock,
      // but keep lastNudgeAt so the cooldown survives a cart edit.
      entry = { signature, firstSeenAt: now, nudgedAt: 0, lastNudgeAt: (entry && entry.lastNudgeAt) || 0 };
      state.carts[c.userId] = entry;
    }

    if (entry.nudgedAt) continue;                                  // already said it
    if (!c.email) continue;                                        // nowhere to send
    if (now - entry.firstSeenAt < CART_NUDGE_HOURS * HOUR) continue;
    if (entry.lastNudgeAt && now - entry.lastNudgeAt < CART_COOLDOWN_DAYS * DAY) continue;
    // They ordered after we started watching → the cart did its job.
    if (c.lastOrderAt && ms(c.lastOrderAt) >= entry.firstSeenAt) continue;

    due.push({ userId: c.userId, email: c.email, items, signature, firstSeenAt: entry.firstSeenAt });
  }

  // Drop users we no longer see (account deleted, cart cleared elsewhere).
  for (const uid of Object.keys(state.carts)) {
    if (!seen.has(uid)) delete state.carts[uid];
  }

  save(state);
  return due;
}

function markCartNudged(userId, now = Date.now()) {
  const state = load();
  const entry = state.carts[userId];
  if (!entry) return null;
  entry.nudgedAt = now;
  entry.lastNudgeAt = now;
  save(state);
  return entry;
}

/* ============================================================
   UNPAID ORDERS
   orders: the store's records (any status; non-chaseable ones are
   filtered here and their state forgotten).
   Returns [{ order, stage }] where stage is 1-based.
   ============================================================ */
function selectOrderNudges(orders, now = Date.now()) {
  const state = load();
  const stages = nudgeStages();
  const due = [];
  const open = new Set();

  for (const o of orders || []) {
    if (!o || !o.orderId) continue;
    const status = String(o.status || '').toLowerCase();
    if (CHASEABLE.indexOf(status) === -1) continue;
    open.add(o.orderId);
    if (!o.email) continue;                       // no address on the order

    const age = now - ms(o.createdAt);
    if (!(age > 0)) continue;                     // clock skew / unparsable date

    const sent = (state.orders[o.orderId] && state.orders[o.orderId].stage) || 0;
    if (sent >= stages.length) continue;          // said everything we're going to say

    const nextStage = sent + 1;
    if (age < stages[nextStage - 1] * HOUR) continue;

    due.push({ order: o, stage: nextStage, ageHours: Math.floor(age / HOUR) });
  }

  // An order that got paid, cancelled or shipped is no longer our business.
  for (const id of Object.keys(state.orders)) {
    if (!open.has(id)) delete state.orders[id];
  }

  save(state);
  return due;
}

function markOrderNudged(orderId, stage, now = Date.now()) {
  const state = load();
  state.orders[orderId] = { stage: Number(stage) || 1, lastAt: now };
  save(state);
  return state.orders[orderId];
}

/* ============================================================
   LOW STOCK
   products: [{ id, name, stockQty, … }] — stockQty null/undefined
   means the SKU isn't counted, so it can't run out.

   One email per crossing: alert when it falls to the threshold,
   stay quiet while it sits there, alert again if it later hits
   zero, and re-arm once it is restocked above the threshold.
   ============================================================ */
function selectStockAlerts(products, now = Date.now()) {
  const state = load();
  const due = [];
  const known = new Set();

  for (const p of products || []) {
    if (!p || p.id == null) continue;
    const id = String(p.id);
    const qty = p.stockQty;
    if (qty === null || qty === undefined || !Number.isFinite(Number(qty))) {
      delete state.stock[id];                       // untracked → nothing to watch
      continue;
    }
    known.add(id);
    const n = Number(qty);
    const prev = state.stock[id];

    if (n > LOW_STOCK_THRESHOLD) { delete state.stock[id]; continue; }   // restocked → re-arm

    // Not yet alerted, or it has fallen further to nothing since we did.
    const firstCrossing = !prev;
    const hitZero = prev && n === 0 && Number(prev.level) > 0;
    if (firstCrossing || hitZero) {
      due.push({ product: p, level: n, previousLevel: prev ? Number(prev.level) : null, threshold: LOW_STOCK_THRESHOLD });
    }
  }

  for (const id of Object.keys(state.stock)) {
    if (!known.has(id)) delete state.stock[id];     // product deleted / retired
  }

  save(state);
  return due;
}

function markStockAlerted(productId, level, now = Date.now()) {
  const state = load();
  state.stock[String(productId)] = { level: Number(level) || 0, alertedAt: now };
  save(state);
  return state.stock[String(productId)];
}

/* ============================================================
   DISPUTE PHOTO STORAGE
   Dispute photos share the disk with every other JSON store here, so the
   allowance filling up is worth an email before it stops accepting them.
   Same shape as the stock alert: due once on the crossing, silent while it
   stays there, and the mark is DELETED when usage falls back under — so a
   sweep re-arms the warning for next time. The exception mirrors the
   run-to-zero rule: reaching 100% says something the 80% email did not,
   namely that photos are being refused right now.
   ============================================================ */
function storageAlertPct() {
  return num(process.env.DISPUTE_STORAGE_ALERT_PCT, 80);
}

function selectStorageAlert(status, now = Date.now()) {
  const pct = Number(status && status.pct);
  if (!Number.isFinite(pct)) return null;

  const threshold = storageAlertPct();
  const state = load();

  if (pct < threshold) {
    if (state.storage) { state.storage = null; save(state); }   // re-arm
    return null;
  }

  const prev = state.storage;
  const firstCrossing = !prev;
  const hitFull = prev && pct >= 100 && Number(prev.pct) < 100;
  if (!firstCrossing && !hitFull) return null;

  return {
    pct,
    usedBytes: Number(status.usedBytes) || 0,
    ceilingBytes: Number(status.ceilingBytes) || 0,
    threshold,
    previousPct: prev ? Number(prev.pct) : null
  };
}

function markStorageAlerted(pct, now = Date.now()) {
  const state = load();
  state.storage = { pct: Number(pct) || 0, alertedAt: now };
  save(state);
  return state.storage;
}

/* Non-secret summary for the admin diagnostics panel. */
function config() {
  return {
    cartNudgeHours: CART_NUDGE_HOURS,
    cartCooldownDays: CART_COOLDOWN_DAYS,
    orderNudgeHours: nudgeStages(),
    lowStockThreshold: LOW_STOCK_THRESHOLD,
    storageAlertPct: storageAlertPct()
  };
}

module.exports = {
  cartSignature,
  selectCartNudges,
  markCartNudged,
  selectOrderNudges,
  markOrderNudged,
  selectStockAlerts,
  markStockAlerted,
  selectStorageAlert,
  markStorageAlerted,
  config,
  CHASEABLE,
  LOW_STOCK_THRESHOLD,
  FILE
};
