/* ============================================================
   EVER NOVA LIFE — per-user cart + order store
   Ties a saved cart and a list of orders to each account, so a
   signed-in user sees the same cart on any device and can review
   their past orders. Same JSON-file approach as auth.js: state is
   isolated behind load/save helpers so it can be swapped for a
   real database later without touching the routes.

     · DATA_DIR/carts.json   → { [userId]: [ cartItem, … ] }
     · DATA_DIR/orders.json  → { [userId]: [ order, … ] }  (newest first)

   DATA_DIR is the same env var auth.js uses, so on Render it lands
   on the persistent disk and survives redeploys.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CARTS_FILE = path.join(DATA_DIR, 'carts.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
/* Orders taken out of the books, kept so a removed figure can still be
   explained. Written to, never read by the app. */
const VOIDED_FILE = path.join(DATA_DIR, 'voided-orders.json');
const MAX_VOIDED_KEPT = 500;

const MAX_CART_ITEMS = 100;      // guard against a runaway / tampered cart
const MAX_ORDERS_KEPT = 200;     // per user, newest kept

/* Guest orders have no account to hang off, but a manual payment (Zelle) has
   to be reconcilable by the store owner whether or not the buyer signed in —
   otherwise money arrives with a reference that matches nothing. They're
   collected under one reserved key, kept out of every per-user path, and
   allowed a bigger backlog because they're shared by every guest. */
const GUEST_KEY = '__guest__';
const MAX_GUEST_ORDERS = 2000;

/* ---- tiny JSON-map store (read-through + atomic write) ---- */
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadMap(file) {
  ensureDir();
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (e) {
    return {};   // missing / unreadable → start empty
  }
}
function saveMap(file, obj) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);   // atomic on the same filesystem
}

/* ---- cart items are shaped like the client's cart.js entries ---- */
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(i => i && i.id != null)
    .slice(0, MAX_CART_ITEMS)
    .map(i => ({
      id: i.id,
      name: String(i.name == null ? '' : i.name).slice(0, 200),
      price: Number(i.price) || 0,
      category: i.category == null ? '' : String(i.category).slice(0, 100),
      quantity: Math.max(1, Math.min(999, parseInt(i.quantity, 10) || 1))
    }));
}

/* ============================================================
   CART
   ============================================================ */
function getCart(userId) {
  const carts = loadMap(CARTS_FILE);
  return Array.isArray(carts[userId]) ? carts[userId] : [];
}
function saveCart(userId, items) {
  const carts = loadMap(CARTS_FILE);
  carts[userId] = sanitizeItems(items);
  saveMap(CARTS_FILE, carts);
  return carts[userId];
}
function clearCart(userId) {
  return saveCart(userId, []);
}

/* Remove a user's cart AND orders entirely — used when an admin deletes the
   account, so no orphaned data lingers under a deleted user id. */
function deleteUserData(userId) {
  const carts = loadMap(CARTS_FILE);
  if (Object.prototype.hasOwnProperty.call(carts, userId)) {
    delete carts[userId];
    saveMap(CARTS_FILE, carts);
  }
  const orders = loadMap(ORDERS_FILE);
  if (Object.prototype.hasOwnProperty.call(orders, userId)) {
    delete orders[userId];
    saveMap(ORDERS_FILE, orders);
  }
}

/* ============================================================
   ORDERS
   ============================================================ */
function listOrders(userId) {
  const orders = loadMap(ORDERS_FILE);
  return Array.isArray(orders[userId]) ? orders[userId] : [];
}
function addOrder(userId, order) {
  const orders = loadMap(ORDERS_FILE);
  const list = Array.isArray(orders[userId]) ? orders[userId] : [];
  list.unshift(order);                       // newest first
  const cap = userId === GUEST_KEY ? MAX_GUEST_ORDERS : MAX_ORDERS_KEPT;
  orders[userId] = list.slice(0, cap);
  saveMap(ORDERS_FILE, orders);
  return order;
}

/* Every order in the store, newest first, each stamped with the account it
   belongs to (GUEST_KEY for guest checkouts). Admin-only — this is what the
   owner works from when confirming manual payments. */
function listAllOrders() {
  const orders = loadMap(ORDERS_FILE);
  const all = [];
  for (const uid of Object.keys(orders)) {
    const list = orders[uid];
    if (!Array.isArray(list)) continue;
    for (const o of list) if (o) all.push({ ...o, userId: uid });
  }
  return all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/* Update an order's status by orderId, searching across all users.
   The crypto webhook only knows the orderId (not who placed it), so we
   scan every user's list. Returns { userId, order, previousStatus } for the
   updated order, or null if not found (e.g. a guest order that was never
   stored). The previousStatus lets the caller act only on a real state change
   — e.g. award loyalty points the first time an order becomes paid, so a
   repeated webhook delivery can't double-credit. Pass status === null to patch
   fields without changing the status. */
function updateOrderStatus(orderId, status, patch) {
  if (!orderId) return null;
  const orders = loadMap(ORDERS_FILE);
  for (const uid of Object.keys(orders)) {
    const list = orders[uid];
    if (!Array.isArray(list)) continue;
    const found = list.find(o => o && o.orderId === orderId);
    if (found) {
      const previousStatus = found.status;
      if (status) found.status = status;
      if (patch) Object.assign(found, patch);
      saveMap(ORDERS_FILE, orders);
      return { userId: uid, order: found, previousStatus };
    }
  }
  return null;
}

/* Take an order out of the books entirely — the duplicate case: one purchase
   that ended up recorded twice, where leaving both in place double-counts the
   revenue and puts a second parcel in the packing queue.

   It is NOT deleted quietly. The record is copied to DATA_DIR/voided-orders.json
   first, with who removed it and why, so a figure that used to be in the books
   can still be explained months later. Returns the removed order (stamped with
   its userId) or null if there was nothing by that reference. */
function removeOrder(orderId, meta) {
  if (!orderId) return null;
  const orders = loadMap(ORDERS_FILE);
  for (const uid of Object.keys(orders)) {
    const list = orders[uid];
    if (!Array.isArray(list)) continue;
    const at = list.findIndex(o => o && o.orderId === orderId);
    if (at === -1) continue;

    const removed = { ...list[at], userId: uid };
    archiveOrder(removed, meta);
    list.splice(at, 1);
    orders[uid] = list;
    saveMap(ORDERS_FILE, orders);
    return removed;
  }
  return null;
}

/* The archive is append-only and never read by the app — it exists for the
   question "what happened to that order?", which is asked by a human, later. */
function archiveOrder(order, meta) {
  try {
    ensureDir();
    let all = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(VOIDED_FILE, 'utf8'));
      if (Array.isArray(parsed)) all = parsed;
    } catch (e) { /* first void, or unreadable — start a fresh list */ }
    all.unshift({
      voidedAt: new Date().toISOString(),
      voidedBy: (meta && meta.by) || 'admin',
      reason: (meta && meta.reason) || '',
      duplicateOf: (meta && meta.duplicateOf) || '',
      order
    });
    saveMap(VOIDED_FILE, all.slice(0, MAX_VOIDED_KEPT));
  } catch (e) {
    console.error('[store] could not archive the voided order:', e.message);
  }
}

module.exports = {
  getCart,
  saveCart,
  clearCart,
  deleteUserData,
  listOrders,
  listAllOrders,
  addOrder,
  updateOrderStatus,
  removeOrder,
  sanitizeItems,
  GUEST_KEY
};
