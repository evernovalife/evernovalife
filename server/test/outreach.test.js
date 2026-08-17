/* ============================================================
   EVER NOVA LIFE — outreach (reminder) rules

   The point of outreach.js is that a reminder is sent ONCE. A tick
   runs hourly, so any rule that can fire twice is a rule that
   emails a customer every hour until they block us. These tests
   are mostly about that: what stops the second send.

   What has to hold:

     · an unpaid order is chased at each stage boundary, once, in
       order — and never a third time
     · an order that gets paid, cancelled or shipped stops being
       chased, and its state is forgotten
     · a cart is only chased after it has genuinely sat still, and
       a cart that turned into an order isn't chased at all
     · a changed cart restarts the clock but still respects the
       cooldown, so editing a cart can't be used to trigger mail
     · low stock alerts once per crossing: again at zero, and only
       re-arms after a restock above the threshold

   Runs with the built-in Node test runner:
       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-outreach-'));
process.env.DATA_DIR = TMP_DATA;
// Pin the tunables so the assertions don't move when a default is retuned.
process.env.ORDER_NUDGE_HOURS = '6,48';
process.env.CART_NUDGE_HOURS = '20';
process.env.CART_NUDGE_COOLDOWN_DAYS = '7';
process.env.LOW_STOCK_THRESHOLD = '5';

const outreach = require('../outreach.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 7, 1, 12, 0, 0);   // a fixed "now" — no wall clock in assertions

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* Each test starts from a clean state file: these rules are ABOUT persistence,
   so leaking state between them would hide exactly the bug they look for. */
function wipe() {
  try { fs.rmSync(outreach.FILE, { force: true }); } catch { /* ignore */ }
}

const order = (over = {}) => ({
  orderId: 'ENL-TEST0001',
  createdAt: new Date(T0).toISOString(),
  status: 'pending',
  email: 'buyer@lab.org',
  total: 120,
  items: [{ id: 1, name: 'Retatrutide', quantity: 1 }],
  ...over
});

/* ============================================================
   UNPAID ORDERS
   ============================================================ */

test('an unpaid order is not chased before the first stage', () => {
  wipe();
  const due = outreach.selectOrderNudges([order()], T0 + 5 * HOUR);
  assert.equal(due.length, 0, 'nothing at 5h when the first stage is 6h');
});

test('the two stages fire in order, once each, and then stop', () => {
  wipe();
  const o = order();

  const first = outreach.selectOrderNudges([o], T0 + 6 * HOUR);
  assert.equal(first.length, 1);
  assert.equal(first[0].stage, 1);
  outreach.markOrderNudged(o.orderId, 1, T0 + 6 * HOUR);

  // An hour later nothing is owed — this is the every-hour-forever bug.
  assert.equal(outreach.selectOrderNudges([o], T0 + 7 * HOUR).length, 0);
  // Still nothing just before the second boundary.
  assert.equal(outreach.selectOrderNudges([o], T0 + 47 * HOUR).length, 0);

  const second = outreach.selectOrderNudges([o], T0 + 48 * HOUR);
  assert.equal(second.length, 1);
  assert.equal(second[0].stage, 2);
  outreach.markOrderNudged(o.orderId, 2, T0 + 48 * HOUR);

  // Both stages spent: silence from here on, however long it sits.
  assert.equal(outreach.selectOrderNudges([o], T0 + 100 * HOUR).length, 0);
  assert.equal(outreach.selectOrderNudges([o], T0 + 365 * 24 * HOUR).length, 0);
});

test('a stage that is skipped past does not fire twice to catch up', () => {
  wipe();
  const o = order();
  // Nothing ran for three days (a sleeping host). The order is owed stage 1,
  // and only stage 1 — two emails landing together reads as a fault.
  const due = outreach.selectOrderNudges([o], T0 + 72 * HOUR);
  assert.equal(due.length, 1);
  assert.equal(due[0].stage, 1);
});

test('only orders still waiting on money are chased', () => {
  wipe();
  for (const status of ['paid', 'shipped', 'delivered', 'cancelled']) {
    const due = outreach.selectOrderNudges([order({ status })], T0 + 72 * HOUR);
    assert.equal(due.length, 0, `${status} orders are nobody's business`);
  }
  for (const status of ['pending', 'awaiting_payment', 'underpaid']) {
    wipe();
    const due = outreach.selectOrderNudges([order({ status })], T0 + 7 * HOUR);
    assert.equal(due.length, 1, `${status} is chaseable`);
  }
});

test('an order with no email on it is never chased', () => {
  wipe();
  assert.equal(outreach.selectOrderNudges([order({ email: '' })], T0 + 72 * HOUR).length, 0);
});

test('an order that gets paid is forgotten, so a re-used reference starts clean', () => {
  wipe();
  const o = order();
  outreach.selectOrderNudges([o], T0 + 6 * HOUR);
  outreach.markOrderNudged(o.orderId, 1, T0 + 6 * HOUR);

  // It gets paid — the pass drops the record.
  outreach.selectOrderNudges([order({ status: 'paid' })], T0 + 7 * HOUR);

  // Same reference open again (a rebuilt order): stage 1 is available again.
  const again = outreach.selectOrderNudges([o], T0 + 8 * HOUR);
  assert.equal(again.length, 1);
  assert.equal(again[0].stage, 1);
});

/* ============================================================
   ABANDONED CARTS
   ============================================================ */

const cart = (over = {}) => ({
  userId: 'u1',
  email: 'buyer@lab.org',
  items: [{ id: 1, name: 'Retatrutide', price: 109.99, quantity: 1 }],
  lastOrderAt: '',
  ...over
});

test('a cart is not chased until it has sat still for the full window', () => {
  wipe();
  const c = cart();
  assert.equal(outreach.selectCartNudges([c], T0).length, 0, 'not on first sight');
  assert.equal(outreach.selectCartNudges([c], T0 + 19 * HOUR).length, 0, 'not at 19h');
  assert.equal(outreach.selectCartNudges([c], T0 + 20 * HOUR).length, 1, 'due at 20h');
});

test('a cart is chased once, not every tick after', () => {
  wipe();
  const c = cart();
  outreach.selectCartNudges([c], T0);
  assert.equal(outreach.selectCartNudges([c], T0 + 20 * HOUR).length, 1);
  outreach.markCartNudged(c.userId, T0 + 20 * HOUR);
  assert.equal(outreach.selectCartNudges([c], T0 + 21 * HOUR).length, 0);
  assert.equal(outreach.selectCartNudges([c], T0 + 40 * HOUR).length, 0);
});

test('a cart that became an order is left alone', () => {
  wipe();
  const c = cart();
  outreach.selectCartNudges([c], T0);
  const bought = cart({ lastOrderAt: new Date(T0 + 2 * HOUR).toISOString() });
  assert.equal(outreach.selectCartNudges([bought], T0 + 30 * HOUR).length, 0);
});

test('an order placed BEFORE we saw the cart does not excuse the cart', () => {
  wipe();
  // They bought something last month and have since filled a new cart.
  const c = cart({ lastOrderAt: new Date(T0 - 30 * DAY).toISOString() });
  outreach.selectCartNudges([c], T0);
  assert.equal(outreach.selectCartNudges([c], T0 + 20 * HOUR).length, 1);
});

test('emptying the cart forgets it entirely', () => {
  wipe();
  const c = cart();
  outreach.selectCartNudges([c], T0);
  outreach.selectCartNudges([cart({ items: [] })], T0 + 1 * HOUR);   // cleared
  // Refilled the same cart later — the clock starts from the refill, not from
  // the original sighting, so this is NOT immediately due.
  assert.equal(outreach.selectCartNudges([c], T0 + 2 * HOUR).length, 0);
  assert.equal(outreach.selectCartNudges([c], T0 + 23 * HOUR).length, 1);
});

test('changing the cart restarts the clock but still respects the cooldown', () => {
  wipe();
  const c = cart();
  outreach.selectCartNudges([c], T0);
  assert.equal(outreach.selectCartNudges([c], T0 + 20 * HOUR).length, 1);
  outreach.markCartNudged(c.userId, T0 + 20 * HOUR);

  // They add a second vial the next day. New signature → new clock…
  const changed = cart({ items: [{ id: 1, name: 'Retatrutide', price: 109.99, quantity: 2 }] });
  outreach.selectCartNudges([changed], T0 + 44 * HOUR);
  // …but the cooldown means no second email this week.
  assert.equal(outreach.selectCartNudges([changed], T0 + 70 * HOUR).length, 0);
  // After the cooldown, a still-abandoned cart is fair game again.
  assert.equal(outreach.selectCartNudges([changed], T0 + 8 * DAY).length, 1);
});

test('a cart with no email address is never chased', () => {
  wipe();
  const c = cart({ email: '' });
  outreach.selectCartNudges([c], T0);
  assert.equal(outreach.selectCartNudges([c], T0 + 30 * HOUR).length, 0);
});

/* ============================================================
   LOW STOCK
   ============================================================ */

const sku = (over = {}) => ({ id: 7, name: 'MOTS-C', price: 90, stockQty: 3, ...over });

test('an untracked product can never be low', () => {
  wipe();
  assert.equal(outreach.selectStockAlerts([sku({ stockQty: null })], T0).length, 0);
  assert.equal(outreach.selectStockAlerts([sku({ stockQty: undefined })], T0).length, 0);
});

test('a healthy count is quiet', () => {
  wipe();
  assert.equal(outreach.selectStockAlerts([sku({ stockQty: 6 })], T0).length, 0);
});

test('crossing the threshold alerts exactly once', () => {
  wipe();
  const p = sku({ stockQty: 5 });
  const first = outreach.selectStockAlerts([p], T0);
  assert.equal(first.length, 1);
  assert.equal(first[0].level, 5);
  outreach.markStockAlerted(p.id, 5, T0);

  // Sitting at 5, then dropping to 4 and 3: still the same crossing.
  assert.equal(outreach.selectStockAlerts([p], T0 + HOUR).length, 0);
  assert.equal(outreach.selectStockAlerts([sku({ stockQty: 4 })], T0 + 2 * HOUR).length, 0);
  assert.equal(outreach.selectStockAlerts([sku({ stockQty: 3 })], T0 + 3 * HOUR).length, 0);
});

test('running out is worth a second alert', () => {
  wipe();
  const p = sku({ stockQty: 4 });
  outreach.selectStockAlerts([p], T0);
  outreach.markStockAlerted(p.id, 4, T0);

  const out = outreach.selectStockAlerts([sku({ stockQty: 0 })], T0 + 5 * HOUR);
  assert.equal(out.length, 1, 'zero is news even after a low warning');
  assert.equal(out[0].level, 0);
  outreach.markStockAlerted(p.id, 0, T0 + 5 * HOUR);

  // …but only once. Staying at zero is not news.
  assert.equal(outreach.selectStockAlerts([sku({ stockQty: 0 })], T0 + 9 * HOUR).length, 0);
});

test('a restock above the threshold re-arms the alert', () => {
  wipe();
  const p = sku({ stockQty: 2 });
  outreach.selectStockAlerts([p], T0);
  outreach.markStockAlerted(p.id, 2, T0);

  outreach.selectStockAlerts([sku({ stockQty: 40 })], T0 + DAY);        // restocked
  const again = outreach.selectStockAlerts([sku({ stockQty: 5 })], T0 + 30 * DAY);
  assert.equal(again.length, 1, 'the next time it runs down, we hear about it');
});

test('a deleted product stops being watched', () => {
  wipe();
  const p = sku({ stockQty: 1 });
  outreach.selectStockAlerts([p], T0);
  outreach.markStockAlerted(p.id, 1, T0);
  outreach.selectStockAlerts([], T0 + HOUR);                  // retired from the catalog
  const back = outreach.selectStockAlerts([p], T0 + 2 * HOUR);
  assert.equal(back.length, 1, 'a re-added SKU is a fresh crossing');
});

/* ============================================================
   STATE FILE
   ============================================================ */

test('an unreadable state file does not stop the run', () => {
  wipe();
  fs.writeFileSync(outreach.FILE, '{ this is not json');
  assert.doesNotThrow(() => outreach.selectOrderNudges([order()], T0 + 7 * HOUR));
});

test('cart signature ignores order and is stable', () => {
  const a = outreach.cartSignature([{ id: 1, quantity: 2 }, { id: 5, quantity: 1 }]);
  const b = outreach.cartSignature([{ id: 5, quantity: 1 }, { id: 1, quantity: 2 }]);
  assert.equal(a, b);
  assert.notEqual(a, outreach.cartSignature([{ id: 1, quantity: 3 }, { id: 5, quantity: 1 }]));
});
