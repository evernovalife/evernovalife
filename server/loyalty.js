/* ============================================================
   EVER NOVA LIFE — loyalty points store
   A per-account points balance + an append-only ledger of every
   change (earned on paid orders, redeemed at checkout, referral
   rewards). Same isolated JSON-file pattern as store.js/auth.js,
   so it can be swapped for a real database later without touching
   the routes.

     · DATA_DIR/loyalty.json → { [userId]: { balance, ledger:[…] } }

   Tunables (all env-overridable, so the numbers aren't baked in):
     · POINTS_PER_DOLLAR      points earned per $1 of product spend   (default 1)
     · POINTS_VALUE_CENTS     cash value of ONE point, in cents        (default 1 → 100 pts = $1)
     · REFERRAL_REWARD_POINTS points granted to BOTH sides of a referral (default 500)
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOYALTY_FILE = path.join(DATA_DIR, 'loyalty.json');

const MAX_LEDGER_KEPT = 200;   // per user, newest kept

function envNum(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

const POINTS_PER_DOLLAR = Math.max(0, envNum(process.env.POINTS_PER_DOLLAR, 1));
const POINTS_VALUE_CENTS = Math.max(0, envNum(process.env.POINTS_VALUE_CENTS, 1));
const REFERRAL_REWARD_POINTS = Math.max(0, Math.round(envNum(process.env.REFERRAL_REWARD_POINTS, 500)));

/* ---- tiny JSON-map store (read-through + atomic write) — mirrors store.js ---- */
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadMap() {
  ensureDir();
  try {
    const obj = JSON.parse(fs.readFileSync(LOYALTY_FILE, 'utf8'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (e) {
    return {};   // missing / unreadable → start empty
  }
}
function saveMap(obj) {
  ensureDir();
  const tmp = LOYALTY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, LOYALTY_FILE);   // atomic on the same filesystem
}

/* balance is always a non-negative integer */
function cleanBalance(v) { return Math.max(0, Math.floor(Number(v) || 0)); }

/* ============================================================
   BALANCE + LEDGER
   ============================================================ */
function getAccount(userId) {
  const map = loadMap();
  const a = map[userId];
  if (a && typeof a === 'object') {
    return { balance: cleanBalance(a.balance), ledger: Array.isArray(a.ledger) ? a.ledger : [] };
  }
  return { balance: 0, ledger: [] };
}
function getBalance(userId) { return getAccount(userId).balance; }

/* Apply a signed delta and append a ledger entry. Balance floors at 0. */
function post(userId, delta, reason, meta) {
  delta = Math.round(Number(delta) || 0);
  if (!userId || !delta) return getBalance(userId);
  const map = loadMap();
  const a = (map[userId] && typeof map[userId] === 'object') ? map[userId] : { balance: 0, ledger: [] };
  const balance = cleanBalance(cleanBalance(a.balance) + delta);
  const entry = {
    ts: new Date().toISOString(),
    delta,
    reason: String(reason || '').slice(0, 80),
    balance
  };
  if (meta && meta.orderId) entry.orderId = String(meta.orderId).slice(0, 60);
  const ledger = [entry, ...(Array.isArray(a.ledger) ? a.ledger : [])].slice(0, MAX_LEDGER_KEPT);
  map[userId] = { balance, ledger };
  saveMap(map);
  return balance;
}

/* Grant points (earning). Non-positive amounts are a no-op. */
function earn(userId, points, reason, meta) {
  points = Math.max(0, Math.floor(Number(points) || 0));
  if (!points) return getBalance(userId);
  return post(userId, +points, reason || 'Points earned', meta);
}

/* Spend points (redeeming). Never spends more than the balance; returns the
   new balance. The caller should size the request to the discount actually
   applied (see centsToPoints), so points and dollars stay in lock-step. */
function redeem(userId, points, reason, meta) {
  points = Math.max(0, Math.floor(Number(points) || 0));
  const take = Math.min(points, getBalance(userId));
  if (!take) return getBalance(userId);
  return post(userId, -take, reason || 'Points redeemed', meta);
}

/* Remove a user's points entirely — used when an admin deletes the account. */
function deleteUser(userId) {
  const map = loadMap();
  if (Object.prototype.hasOwnProperty.call(map, userId)) {
    delete map[userId];
    saveMap(map);
  }
}

/* ============================================================
   CONVERSIONS (points ⇄ money) + earn rule
   Keeping these in one place means the client and server agree on
   exactly what a point is worth.
   ============================================================ */
function pointsToCents(points) { return Math.floor(Math.max(0, Number(points) || 0) * POINTS_VALUE_CENTS); }
function pointsToDollars(points) { return pointsToCents(points) / 100; }
function centsToPoints(cents) {
  cents = Math.max(0, Math.round(Number(cents) || 0));
  return POINTS_VALUE_CENTS > 0 ? Math.round(cents / POINTS_VALUE_CENTS) : 0;
}
/* points earned for a dollar amount of product spend (floored — no fractions) */
function earnForAmount(dollars) { return Math.floor(Math.max(0, Number(dollars) || 0) * POINTS_PER_DOLLAR); }

module.exports = {
  getAccount,
  getBalance,
  earn,
  redeem,
  deleteUser,
  pointsToCents,
  pointsToDollars,
  centsToPoints,
  earnForAmount,
  POINTS_PER_DOLLAR,
  POINTS_VALUE_CENTS,
  REFERRAL_REWARD_POINTS
};
