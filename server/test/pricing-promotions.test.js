/* ============================================================
   EVER NOVA LIFE — promotions, as they reach the invoice
   buildOrder() is what every payment path prices from, so this is
   the test that actually protects the money. It writes promotions
   and products into a throwaway DATA_DIR, then asks buildOrder
   what the cart costs.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-pricing-promo-'));
process.env.DATA_DIR = TMP_DATA;

const promotions = require('../promotions.js');
const products = require('../products.js');
const { buildOrder } = require('../pricing.js');

/* The first product in the seeded catalog — the seed is the site's real
   8-SKU catalog, so we price against whatever it actually says rather than
   hard-coding a figure that a catalog edit would break. */
const SKU = products.listProducts()[0];

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

function clearPromos() {
  promotions.listAll().forEach(p => promotions.remove(p.id));
}

test('with no promotions running, nothing about the order changes', () => {
  clearPromos();
  const order = buildOrder([{ id: SKU.id, quantity: 1 }]);
  assert.strictEqual(order.promoDiscount, 0);
  assert.deepStrictEqual(order.promos, []);
  assert.strictEqual(order.items[0].paidQuantity, 1);
  assert.strictEqual(order.subtotal, order.items[0].lineTotal);
});

test('a sale lowers the subtotal, the tax and the total', () => {
  clearPromos();
  promotions.upsert({ name: 'Half off', type: 'sale', productIds: [SKU.id], mode: 'percent', value: 50 });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }]);
  clearPromos();

  assert.strictEqual(order.subtotal, promotions.money(SKU.price * 0.5));
  assert.strictEqual(order.items[0].listUnitPrice, promotions.money(SKU.price));
  assert.strictEqual(order.tax, promotions.money(order.subtotal * 0.08));
  assert.strictEqual(order.promos[0].name, 'Half off');
});

test('a cart promo lands in promoDiscount, and tax is charged on what is left', () => {
  clearPromos();
  promotions.upsert({ name: 'Ten off', type: 'cart', mode: 'amount', value: 10, minSubtotal: 0 });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }]);
  clearPromos();

  assert.strictEqual(order.promoDiscount, 10);
  assert.strictEqual(order.tax, promotions.money((order.subtotal - 10) * 0.08));
});

test('loyalty points clamp to what is left after the promotion', () => {
  clearPromos();
  promotions.upsert({ name: 'Almost free', type: 'cart', mode: 'percent', value: 90, minSubtotal: 0 });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }], { discount: 9999 });
  clearPromos();

  assert.strictEqual(order.discount, promotions.money(order.subtotal - order.promoDiscount));
  assert.strictEqual(order.tax, 0);
  assert.strictEqual(order.total, promotions.money(order.shipping));
});

/* A one-unit cart of SKU already clears the $100 free-shipping THRESHOLD on
   its own (see the threshold test below), so that cart proves nothing about
   the shipping-promo mechanism — it would ship free with no promotion at
   all. Pairing the promo with a 50%-off sale drops the post-promotion
   subtotal to $55, under the threshold, so the fee is zero only because the
   promo zeroed it. The chosen service must still survive: a shipping promo
   zeroes the FEE, it does not fabricate a different "service". */
test('a shipping promo zeroes the fee whatever the method costs, without discarding the service', () => {
  clearPromos();
  promotions.upsert({ name: 'Half off', type: 'sale', productIds: [SKU.id], mode: 'percent', value: 50 });
  promotions.upsert({ name: 'Free delivery', type: 'shipping' });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }]);
  clearPromos();

  assert.ok(order.subtotal < 100, 'the fixture must fall under the threshold post-promotion');
  assert.strictEqual(order.shipping, 0);
  assert.strictEqual(order.shippingMethod, 'standard');
  assert.strictEqual(order.shippingLabel, 'Standard');
});

/* The free-shipping THRESHOLD (shipping.js `freeOver`, $100 on Standard) is a
   separate mechanism from a free-shipping promo, and it is measured on what the
   store actually took. A cart worth $120 at list, discounted to $60, has not
   earned free postage. */
test('the free-shipping threshold is measured on the post-promotion subtotal', () => {
  clearPromos();
  const qty = Math.ceil(101 / SKU.price);            // enough to clear $100 at list price
  const full = buildOrder([{ id: SKU.id, quantity: qty }]);
  assert.ok(full.subtotal >= 100, 'the fixture must clear the threshold at list price');
  assert.strictEqual(full.shipping, 0);

  promotions.upsert({ name: 'Half off', type: 'sale', productIds: [SKU.id], mode: 'percent', value: 50 });
  const discounted = buildOrder([{ id: SKU.id, quantity: qty }]);
  clearPromos();

  assert.ok(discounted.subtotal < 100, 'the discount must drop it back under the threshold');
  assert.ok(discounted.shipping > 0, 'postage is charged once the paid subtotal falls short');
});

test('noPromos prices at catalog — this is what auto-ship invoices use', () => {
  clearPromos();
  promotions.upsert({ name: 'Half off', type: 'sale', productIds: [SKU.id], mode: 'percent', value: 50 });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }], { noPromos: true });
  clearPromos();

  assert.strictEqual(order.subtotal, promotions.money(SKU.price));
  assert.strictEqual(order.promoDiscount, 0);
  assert.deepStrictEqual(order.promos, []);
});

test('a bogo line ships more units than it bills', () => {
  clearPromos();
  promotions.upsert({ name: 'B1G1', badge: 'BUY 1 GET 1', type: 'bogo', productIds: [SKU.id], buyQty: 1, freeQty: 1 });
  const order = buildOrder([{ id: SKU.id, quantity: 1 }]);
  clearPromos();

  assert.strictEqual(order.items[0].quantity, 2);
  assert.strictEqual(order.items[0].paidQuantity, 1);
  assert.strictEqual(order.subtotal, promotions.money(SKU.price));
});
