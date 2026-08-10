/* ============================================================
   EVER NOVA LIFE — stock count tests

   Products may carry a live unit count (`stockQty`) that the admin sets and
   every order draws down. The count is taken when an order is OPENED, not when
   it is paid, because every payment method here confirms later — see the note
   on reserveStock in products.js.

   What has to hold:

     · a product with no count behaves exactly as before (unlimited)
     · a count of 0 is unsellable, and `inStock:false` overrides any count
     · pricing rejects a line bigger than the count
     · reserving is ALL-OR-NOTHING — a basket with one bad line takes nothing
     · releasing puts back exactly what was taken
     · an edit that doesn't mention stockQty leaves the count alone
     · concurrent-ish reservations can't oversell the last unit

   Runs with the built-in Node test runner:
       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-stock-'));
process.env.DATA_DIR = TMP_DATA;

const PRODUCTS_FILE = path.join(TMP_DATA, 'products.json');
const SYNC_FILE = path.join(TMP_DATA, 'products.sync.json');

/* A small hand-written store rather than the real seed: these tests are about
   the counting rules, and pinning them to real SKUs would make them fail every
   time the catalog changes. */
const TRACKED = 101;      // 3 units, counted
const UNTRACKED = 102;    // no count at all — the pre-existing behaviour
const ZERO = 103;         // counted, sold out
const SWITCHED_OFF = 104; // units on the shelf, but withdrawn from sale

fs.writeFileSync(PRODUCTS_FILE, JSON.stringify([
  { id: TRACKED,      name: 'Tracked Vial',   category: 'growth',   price: 50, inStock: true, stockQty: 3 },
  { id: UNTRACKED,    name: 'Untracked Vial', category: 'growth',   price: 60, inStock: true },
  { id: ZERO,         name: 'Sold Out Vial',  category: 'growth',   price: 70, inStock: true, stockQty: 0 },
  { id: SWITCHED_OFF, name: 'Withdrawn Vial', category: 'growth',   price: 80, inStock: false, stockQty: 9 }
], null, 2));
// versions already current, so no seed fix-up rewrites the file underneath us
fs.writeFileSync(SYNC_FILE, JSON.stringify({ version: 99, addVersion: 99, coaVersion: 99 }));

const products = require('../products.js');
const { buildOrder } = require('../pricing.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

const qtyOf = id => products.getProduct(id).stockQty;
const reset = () => {
  products.setStock(TRACKED, 3);
  products.setStock(ZERO, 0);
};

/* ---------- availability ---------- */

test('a product with no count is unlimited, not zero', () => {
  assert.equal(products.availableQty(products.getProduct(UNTRACKED)), null);
  assert.equal(products.isAvailable(products.getProduct(UNTRACKED)), true);
  // and a big order of it prices fine
  const order = buildOrder([{ id: UNTRACKED, quantity: 500 }]);
  assert.equal(order.items[0].quantity, 500);
});

test('a count of 0 is out of stock', () => {
  assert.equal(products.availableQty(products.getProduct(ZERO)), 0);
  assert.equal(products.isAvailable(products.getProduct(ZERO)), false);
  assert.throws(() => buildOrder([{ id: ZERO, quantity: 1 }]), /Out of stock/);
});

test('the in-stock switch overrides a count that still has units', () => {
  const p = products.getProduct(SWITCHED_OFF);
  assert.equal(p.stockQty, 9, 'the units are still recorded');
  assert.equal(products.availableQty(p), 0, 'but none are available');
  assert.throws(() => buildOrder([{ id: SWITCHED_OFF, quantity: 1 }]), /Out of stock/);
});

/* ---------- pricing guard ---------- */

test('pricing rejects a line larger than the count, and names the number', () => {
  reset();
  assert.throws(() => buildOrder([{ id: TRACKED, quantity: 4 }]), /Only 3 left/);
  const ok = buildOrder([{ id: TRACKED, quantity: 3 }]);
  assert.equal(ok.items[0].quantity, 3, 'exactly the count is allowed');
});

/* ---------- reserve / release ---------- */

test('reserving takes the units', () => {
  reset();
  const held = products.reserveStock([{ id: TRACKED, quantity: 2 }]);
  assert.deepEqual(held, [{ id: TRACKED, quantity: 2 }]);
  assert.equal(qtyOf(TRACKED), 1);
});

test('reserving an untracked product records nothing to give back', () => {
  const held = products.reserveStock([{ id: UNTRACKED, quantity: 7 }]);
  assert.deepEqual(held, [], 'no count to move');
});

test('a basket with one unfillable line takes NOTHING', () => {
  reset();
  assert.throws(
    () => products.reserveStock([
      { id: TRACKED, quantity: 3 },     // fine on its own
      { id: ZERO, quantity: 1 }         // …but this one cannot be filled
    ]),
    /out of stock/i
  );
  assert.equal(qtyOf(TRACKED), 3, 'the good line was not decremented');
});

test('releasing puts back exactly what was taken', () => {
  reset();
  const held = products.reserveStock([{ id: TRACKED, quantity: 2 }]);
  assert.equal(qtyOf(TRACKED), 1);
  products.releaseStock(held);
  assert.equal(qtyOf(TRACKED), 3);
});

test('releasing a product that is no longer counted is a no-op, not a resurrection', () => {
  reset();
  const held = products.reserveStock([{ id: TRACKED, quantity: 1 }]);
  products.setStock(TRACKED, null);                 // admin stopped counting it
  products.releaseStock(held);
  assert.equal(products.getProduct(TRACKED).stockQty, undefined, 'still untracked');
  reset();
});

test('two reservations cannot oversell the last unit', () => {
  products.setStock(TRACKED, 1);
  products.reserveStock([{ id: TRACKED, quantity: 1 }]);
  assert.equal(qtyOf(TRACKED), 0);
  assert.throws(() => products.reserveStock([{ id: TRACKED, quantity: 1 }]), /out of stock/i);
  reset();
});

test('a shortfall is a 409, so the route can tell it from bad input', () => {
  reset();
  try {
    products.reserveStock([{ id: TRACKED, quantity: 99 }]);
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.status, 409);
  }
});

/* ---------- editing ---------- */

test('an edit that never mentions stockQty leaves the count alone', () => {
  reset();
  products.updateProduct(TRACKED, { name: 'Tracked Vial', category: 'growth', price: 55 });
  assert.equal(qtyOf(TRACKED), 3, 'still 3');
  assert.equal(products.getProduct(TRACKED).price, 55, 'and the edit applied');
});

test('setStock(null) stops counting; setStock(n) starts again', () => {
  products.setStock(TRACKED, null);
  assert.equal(products.getProduct(TRACKED).stockQty, undefined);
  assert.equal(products.availableQty(products.getProduct(TRACKED)), null, 'unlimited again');
  products.setStock(TRACKED, 4);
  assert.equal(qtyOf(TRACKED), 4);
  reset();
});

test('a count is stored as a whole number, never negative', () => {
  products.setStock(TRACKED, '7.9');
  assert.equal(qtyOf(TRACKED), 7);
  products.setStock(TRACKED, -5);
  assert.equal(qtyOf(TRACKED), 0);
  reset();
});

test('a new product can be created with a count', () => {
  const p = products.addProduct({ name: 'Fresh Vial', category: 'growth', price: 12, stockQty: 6 });
  assert.equal(p.stockQty, 6);
  assert.equal(products.availableQty(products.getProduct(p.id)), 6);
  products.deleteProduct(p.id);
});
