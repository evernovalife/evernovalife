/* ============================================================
   EVER NOVA LIFE — auto-ship (recurring order) store
   A signed-in customer can turn any checkout into a repeating
   shipment: the same items, re-invoiced every N days. This module
   owns the records; server.js owns the routes and the scheduler
   that acts on them.

     · DATA_DIR/subscriptions.json → { [userId]: [ subscription, … ] }

   Same isolated JSON-file pattern as store.js / loyalty.js, so it
   can be swapped for a real database later without touching the
   routes.

   Crypto has no stored credential — nobody can debit a wallet on a
   schedule — so a plan holds no payment token. When one comes due
   the scheduler opens a fresh BTCPay invoice and emails the pay
   link; the webhook settles it like any other crypto order. If a
   pull-based processor (card/ACH) is added later, give the record a
   `method` of its own and branch in the scheduler — nothing else
   here has to change.

   A subscription record:
     { id, userId, status, method, items[], intervalDays, nextRunAt,
       paymentLabel, email, shippingAddress, createdAt, lastRunAt,
       runCount, failCount, lastError, reminderSentFor, claimedAt,
       pendingOrderId, pendingInvoiceId, orderIds[] }

   Tunables (env-overridable):
     · SUBSCRIPTION_MIN_DAYS / SUBSCRIPTION_MAX_DAYS  allowed interval range
     · SUBSCRIPTION_RETRY_DAYS   wait before retrying a declined charge
     · SUBSCRIPTION_MAX_FAILS    declines before the plan auto-pauses
     · SUBSCRIPTION_REMINDER_DAYS  days ahead to email "shipping soon"
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

function envNum(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

/* The customer picks any number of days in this range. */
const MIN_DAYS = Math.max(1, Math.round(envNum(process.env.SUBSCRIPTION_MIN_DAYS, 7)));
const MAX_DAYS = Math.max(MIN_DAYS, Math.round(envNum(process.env.SUBSCRIPTION_MAX_DAYS, 180)));
const DEFAULT_DAYS = Math.min(MAX_DAYS, Math.max(MIN_DAYS, 30));

const RETRY_DAYS = Math.max(1, Math.round(envNum(process.env.SUBSCRIPTION_RETRY_DAYS, 3)));
const MAX_FAILS = Math.max(1, Math.round(envNum(process.env.SUBSCRIPTION_MAX_FAILS, 3)));
const REMINDER_DAYS = Math.max(0, Math.round(envNum(process.env.SUBSCRIPTION_REMINDER_DAYS, 3)));

const MAX_SUBS_PER_USER = 20;    // a sane ceiling; nobody legitimately needs more
const MAX_ITEMS = 50;
const MAX_ORDER_IDS_KEPT = 50;
const CLAIM_STALE_MS = 15 * 60 * 1000;   // a run that never finished is retryable after this

const DAY_MS = 24 * 60 * 60 * 1000;

/* ---- tiny JSON-map store (read-through + atomic write) — mirrors store.js ---- */
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadMap() {
  ensureDir();
  try {
    const obj = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (e) {
    return {};   // missing / unreadable → start empty
  }
}
function saveMap(obj) {
  ensureDir();
  const tmp = SUBS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, SUBS_FILE);   // atomic on the same filesystem
}

/* ============================================================
   VALIDATION HELPERS
   ============================================================ */

/* Clamp a requested interval into the allowed range. The customer types a
   free-form number of days, so this is the only thing standing between a
   typo (or a tampered request) and a plan that charges daily. */
function cleanIntervalDays(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, n));
}

/* Items are stored in the same shape as the cart, but only `id` + `quantity`
   are ever trusted — every run re-prices against the live catalog, so a stale
   stored price can never be charged. The name/price we keep are for display. */
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(i => i && i.id != null)
    .slice(0, MAX_ITEMS)
    .map(i => ({
      id: i.id,
      name: String(i.name == null ? '' : i.name).slice(0, 200),
      price: Number(i.price) || 0,
      quantity: Math.max(1, Math.min(999, parseInt(i.quantity, 10) || 1))
    }));
}

function cleanAddress(a) {
  if (!a || typeof a !== 'object') return null;
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  return {
    name: s(a.name, 200),
    address: s(a.address, 255),
    city: s(a.city, 255),
    state: s(a.state, 255),
    postalCode: s(a.postalCode, 30),
    countryCode: /^[A-Za-z]{2}$/.test(a.countryCode || '') ? String(a.countryCode).toUpperCase() : ''
  };
}

/* A short, human-friendly plan reference (mirrors the ENL- order ids). */
function newSubscriptionId() {
  return 'SUB-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

/* Add whole days to an ISO timestamp / Date, returning ISO. */
function addDays(from, days) {
  const base = from instanceof Date ? from.getTime() : new Date(from).getTime();
  const start = Number.isFinite(base) ? base : Date.now();
  return new Date(start + days * DAY_MS).toISOString();
}

/* ============================================================
   READS
   ============================================================ */

/* One user's plans, newest first. Cancelled ones are kept (they're history)
   but the caller can filter. */
function listForUser(userId) {
  const map = loadMap();
  const list = Array.isArray(map[userId]) ? map[userId] : [];
  return list.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/* Every plan across every account — for the scheduler and the admin view. */
function listAll() {
  const map = loadMap();
  const out = [];
  for (const uid of Object.keys(map)) {
    const list = map[uid];
    if (Array.isArray(list)) out.push(...list);
  }
  return out;
}

/* Find one plan by id. `userId` (optional) scopes the lookup to that account —
   pass it on every user-facing route so one customer can never read or change
   another customer's plan by guessing an id. */
function get(id, userId) {
  if (!id) return null;
  const map = loadMap();
  const uids = userId ? [userId] : Object.keys(map);
  for (const uid of uids) {
    const list = map[uid];
    if (!Array.isArray(list)) continue;
    const found = list.find(s => s && s.id === id);
    if (found) return found;
  }
  return null;
}

/* Active plans whose next run is due at `now`, skipping any that another
   run is already working on (see claim()). Stale claims — a process that
   died mid-run — become eligible again after CLAIM_STALE_MS. */
function listDue(now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  return listAll().filter(s => {
    if (!s || s.status !== 'active' || !s.nextRunAt) return false;
    if (new Date(s.nextRunAt).getTime() > t) return false;
    if (s.claimedAt && (t - new Date(s.claimedAt).getTime()) < CLAIM_STALE_MS) return false;
    return true;
  });
}

/* Active plans due to ship within REMINDER_DAYS that haven't been reminded
   about this cycle yet. `reminderSentFor` stores the nextRunAt we warned
   about, so changing the date re-arms the reminder and a repeated cron ping
   never sends twice. */
function listNeedingReminder(now = Date.now()) {
  if (REMINDER_DAYS <= 0) return [];
  const t = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const horizon = t + REMINDER_DAYS * DAY_MS;
  return listAll().filter(s => {
    if (!s || s.status !== 'active' || !s.nextRunAt) return false;
    const due = new Date(s.nextRunAt).getTime();
    if (!Number.isFinite(due) || due > horizon || due <= t) return false;
    return s.reminderSentFor !== s.nextRunAt;
  });
}

/* ============================================================
   WRITES
   ============================================================ */

function create(userId, data = {}) {
  if (!userId) throw new Error('A subscription needs an account.');
  const items = sanitizeItems(data.items);
  if (!items.length) throw new Error('An auto-ship plan needs at least one product.');

  const map = loadMap();
  const list = Array.isArray(map[userId]) ? map[userId] : [];
  if (list.filter(s => s && s.status !== 'cancelled').length >= MAX_SUBS_PER_USER) {
    throw new Error(`You can have at most ${MAX_SUBS_PER_USER} auto-ship plans.`);
  }

  const intervalDays = cleanIntervalDays(data.intervalDays);
  const now = new Date().toISOString();
  const sub = {
    id: newSubscriptionId(),
    userId,
    status: 'active',
    method: String(data.method || 'crypto').slice(0, 20),
    items,
    intervalDays,
    // The first shipment is the order they just placed, so the plan's first
    // recurring invoice lands one full interval from now.
    nextRunAt: data.nextRunAt || addDays(now, intervalDays),
    paymentLabel: String(data.paymentLabel || 'Bitcoin / Lightning invoice').slice(0, 120),
    email: String(data.email || '').slice(0, 255),
    shippingAddress: cleanAddress(data.shippingAddress),
    createdAt: now,
    lastRunAt: '',
    runCount: 0,
    failCount: 0,
    lastError: '',
    reminderSentFor: '',
    claimedAt: '',
    pendingOrderId: '',
    pendingInvoiceId: '',
    orderIds: data.firstOrderId ? [String(data.firstOrderId)] : []
  };

  list.unshift(sub);
  map[userId] = list;
  saveMap(map);
  return sub;
}

/* Apply a patch to one plan and persist it. `userId` scopes the lookup (pass
   null only from trusted server-side code such as the scheduler). Returns the
   updated record, or null when there's no such plan for that account. */
function update(id, userId, patch) {
  if (!id) return null;
  const map = loadMap();
  const uids = userId ? [userId] : Object.keys(map);
  for (const uid of uids) {
    const list = map[uid];
    if (!Array.isArray(list)) continue;
    const found = list.find(s => s && s.id === id);
    if (found) {
      Object.assign(found, patch || {});
      saveMap(map);
      return found;
    }
  }
  return null;
}

/* The customer-editable fields, validated. Anything not listed here (the
   payment method, run counters, the owning account) can't be reached from a
   request body. */
function applyCustomerEdits(sub, body = {}) {
  const patch = {};

  if (body.intervalDays != null) {
    patch.intervalDays = cleanIntervalDays(body.intervalDays);
  }

  if (body.status != null) {
    const wanted = String(body.status).toLowerCase();
    if (!['active', 'paused'].includes(wanted)) {
      throw new Error('Status must be "active" or "paused".');   // cancel uses DELETE
    }
    if (sub.status === 'cancelled') throw new Error('This plan was cancelled and can no longer be changed.');
    patch.status = wanted;
    // Resuming a plan whose date has already passed would charge instantly —
    // give them a full interval from today instead.
    if (wanted === 'active' && sub.status === 'paused') {
      const due = new Date(sub.nextRunAt).getTime();
      if (!Number.isFinite(due) || due <= Date.now()) {
        patch.nextRunAt = addDays(new Date(), patch.intervalDays || sub.intervalDays);
      }
      patch.failCount = 0;
      patch.lastError = '';
    }
  }

  if (body.items != null) {
    const items = sanitizeItems(body.items);
    if (!items.length) throw new Error('An auto-ship plan needs at least one product.');
    patch.items = items;
  }

  if (body.shippingAddress != null) patch.shippingAddress = cleanAddress(body.shippingAddress);

  if (body.email != null) patch.email = String(body.email).slice(0, 255);

  // "Skip the next shipment" — push the date out by one whole interval.
  if (body.skipNext) {
    const interval = patch.intervalDays || sub.intervalDays;
    const from = new Date(sub.nextRunAt).getTime() > Date.now() ? sub.nextRunAt : new Date().toISOString();
    patch.nextRunAt = addDays(from, interval);
  }

  // Explicit reschedule (the date picker on the account page).
  if (body.nextRunAt) {
    const when = new Date(body.nextRunAt).getTime();
    if (!Number.isFinite(when)) throw new Error('That next-shipment date is not valid.');
    if (when < Date.now()) throw new Error('The next shipment date has to be in the future.');
    patch.nextRunAt = new Date(when).toISOString();
  }

  // Any date change re-arms the "shipping soon" reminder for the new date.
  if (patch.nextRunAt) patch.reminderSentFor = '';

  return patch;
}

/* Cancel (soft delete) — the record stays so past shipments keep their link,
   but it never runs again. */
function cancel(id, userId) {
  const sub = get(id, userId);
  if (!sub) return null;
  if (sub.status === 'cancelled') return sub;
  return update(id, userId, {
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
    claimedAt: ''
  });
}

/* Take ownership of a plan for one run, so two overlapping cron pings can't
   both charge it. Returns the claimed record, or null if someone else holds a
   fresh claim. */
function claim(id) {
  const map = loadMap();
  for (const uid of Object.keys(map)) {
    const list = map[uid];
    if (!Array.isArray(list)) continue;
    const found = list.find(s => s && s.id === id);
    if (!found) continue;
    const held = found.claimedAt && (Date.now() - new Date(found.claimedAt).getTime()) < CLAIM_STALE_MS;
    if (held) return null;
    found.claimedAt = new Date().toISOString();
    saveMap(map);
    return found;
  }
  return null;
}

function release(id) {
  return update(id, null, { claimedAt: '' });
}

/* Record a successful run — for crypto that means the invoice was ISSUED and
   emailed, not that the coins have landed; the BTCPay webhook settles the
   order separately. Stamp the order, advance the schedule, clear the failure
   state. */
function recordSuccess(id, orderId) {
  const sub = get(id);
  if (!sub) return null;
  const orderIds = [String(orderId), ...(Array.isArray(sub.orderIds) ? sub.orderIds : [])]
    .slice(0, MAX_ORDER_IDS_KEPT);
  const now = new Date().toISOString();
  return update(id, null, {
    lastRunAt: now,
    // Advance from the date it was DUE, not from now — a cron ping that lands
    // late (or a Render instance that was asleep) must not drift the schedule.
    nextRunAt: addDays(new Date(sub.nextRunAt).getTime() > 0 ? sub.nextRunAt : now, sub.intervalDays),
    runCount: (Number(sub.runCount) || 0) + 1,
    failCount: 0,
    lastError: '',
    reminderSentFor: '',
    pendingOrderId: '',
    pendingInvoiceId: '',
    claimedAt: '',
    orderIds
  });
}

/* Record a failed run — an invoice we could not open (BTCPay unreachable, the
   catalog no longer prices the items). Retries a few times, then pauses the
   plan so we stop retrying something broken. Returns { sub, paused }. */
function recordFailure(id, message) {
  const sub = get(id);
  if (!sub) return { sub: null, paused: false };
  const failCount = (Number(sub.failCount) || 0) + 1;
  const paused = failCount >= MAX_FAILS;
  const updated = update(id, null, {
    failCount,
    lastError: String(message || 'Payment failed').slice(0, 300),
    lastFailedAt: new Date().toISOString(),
    status: paused ? 'paused' : sub.status,
    nextRunAt: paused ? sub.nextRunAt : addDays(new Date(), RETRY_DAYS),
    reminderSentFor: '',
    pendingOrderId: '',
    pendingInvoiceId: '',
    claimedAt: ''
  });
  return { sub: updated, paused };
}

/* Remove every plan belonging to an account — used when an admin deletes it,
   so nothing keeps invoicing a customer who no longer exists. */
function deleteUserData(userId) {
  const map = loadMap();
  if (Object.prototype.hasOwnProperty.call(map, userId)) {
    delete map[userId];
    saveMap(map);
  }
}

/* What the browser is allowed to see. Internal run bookkeeping (claims,
   pending invoice ids) stays on the server; the UI shows `paymentLabel`. */
function publicSubscription(s) {
  if (!s) return null;
  return {
    id: s.id,
    status: s.status,
    method: s.method || 'crypto',
    items: s.items,
    intervalDays: s.intervalDays,
    nextRunAt: s.status === 'active' ? s.nextRunAt : '',
    scheduledFor: s.nextRunAt,
    paymentLabel: s.paymentLabel,
    email: s.email,
    shippingAddress: s.shippingAddress,
    createdAt: s.createdAt,
    lastRunAt: s.lastRunAt,
    runCount: Number(s.runCount) || 0,
    failCount: Number(s.failCount) || 0,
    lastError: s.lastError || '',
    orderIds: Array.isArray(s.orderIds) ? s.orderIds : []
  };
}

module.exports = {
  listForUser,
  listAll,
  get,
  listDue,
  listNeedingReminder,
  create,
  update,
  applyCustomerEdits,
  cancel,
  claim,
  release,
  recordSuccess,
  recordFailure,
  deleteUserData,
  publicSubscription,
  sanitizeItems,
  cleanIntervalDays,
  addDays,
  MIN_DAYS,
  MAX_DAYS,
  DEFAULT_DAYS,
  RETRY_DAYS,
  MAX_FAILS,
  REMINDER_DAYS
};
