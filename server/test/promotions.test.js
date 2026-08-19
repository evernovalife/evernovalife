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
