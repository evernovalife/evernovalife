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
