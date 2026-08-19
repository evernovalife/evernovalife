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
