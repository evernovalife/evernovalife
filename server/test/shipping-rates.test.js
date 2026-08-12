/* ============================================================
   EVER NOVA LIFE — shipping rate table tests
   The shipping fee is owner-editable data now, which means the
   amount charged is decided at runtime from a JSON file. Two
   things must hold whatever is in that file:

     · the BROWSER never sets the fee. It sends a method id; the
       server looks up what that method costs.
     · checkout always has something to charge. The last enabled
       method cannot be disabled or deleted, because a store with
       no shipping option is a store that cannot sell.

   Runs with the built-in Node test runner:
       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-rates-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-rates';
process.env.ALLOWED_ORIGINS = '*';
process.env.ADMIN_EMAILS = 'boss-rates@example.com';
process.env.SUBSCRIPTION_INPROCESS_CRON = '0';
delete process.env.ADMIN_KEY;

const app = require('../server.js');
const rates = require('../shipping.js');
const { buildOrder } = require('../pricing.js');

let server, base, productId, boss, customer;

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  const cat = await api('/api/products');
  productId = (cat.body.products || [])[0].id;

  boss = (await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'Boss', lastName: 'Rates', email: 'boss-rates@example.com', password: 'password123' }
  })).body;
  customer = (await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'Cust', lastName: 'Omer', email: 'cust-rates@example.com', password: 'password123' }
  })).body;
});

test.after(async () => {
  if (server) { server.close(); await once(server, 'close'); }
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: parsed };
}

/* ============================================================
   1) What checkout is allowed to see
   ============================================================ */
test('the public list is only the enabled methods; an admin sees all of them', async () => {
  const pub = await api('/api/shipping');
  assert.equal(pub.status, 200);
  assert.ok(pub.body.methods.length >= 1);
  assert.ok(pub.body.methods.every(m => m.enabled), 'a disabled method is never offered');
  assert.ok(pub.body.defaultMethod, 'the server names which one is preselected');

  const asAdmin = await api('/api/shipping', { token: boss.token });
  assert.ok(asAdmin.body.methods.length > pub.body.methods.length,
    'the admin also sees the ones that are turned off — those are what they are about to enable');
});

/* ============================================================
   2) The browser picks the service, never the price
   ============================================================ */
test('the fee comes from the rate table, not from the request', async () => {
  // Turn Overnight on so there is a real choice to make.
  const on = await api('/api/shipping', {
    method: 'POST', token: boss.token,
    body: { id: 'overnight', name: 'Overnight', eta: 'Next business day', price: 34.99, freeOver: 0, enabled: true, sort: 30 }
  });
  assert.equal(on.status, 200);

  const std = await api('/api/quote', { method: 'POST', body: { items: [{ id: productId, quantity: 1 }] } });
  const fast = await api('/api/quote', {
    method: 'POST', body: { items: [{ id: productId, quantity: 1 }], shippingMethod: 'overnight' }
  });
  assert.equal(fast.body.shipping, 34.99, 'the chosen method sets the fee');
  assert.equal(fast.body.shippingLabel, 'Overnight', 'and the quote says which service that is');
  assert.ok(fast.body.total > std.body.total, 'the faster service costs more');

  // A price sent by the caller is ignored outright.
  const tampered = await api('/api/quote', {
    method: 'POST',
    body: { items: [{ id: productId, quantity: 1 }], shippingMethod: 'overnight', shipping: 0, shippingFee: 0 }
  });
  assert.equal(tampered.body.shipping, 34.99, 'the browser cannot name its own shipping fee');
});

test('an unknown or disabled method falls back to the cheapest offered one', async () => {
  const bogus = await api('/api/quote', {
    method: 'POST', body: { items: [{ id: productId, quantity: 1 }], shippingMethod: 'teleport' }
  });
  assert.equal(bogus.status, 200, 'a stale method id must not fail the checkout');
  assert.equal(bogus.body.shippingLabel, 'Standard');

  // Expedited ships in the seed DISABLED, so asking for it is the same case.
  const off = await api('/api/quote', {
    method: 'POST', body: { items: [{ id: productId, quantity: 1 }], shippingMethod: 'expedited' }
  });
  assert.equal(off.body.shippingLabel, 'Standard', 'a method that is not offered cannot be bought');
});

test('free-shipping applies per method, on the pre-discount subtotal', async () => {
  // Standard is free over $100 in the seed; Overnight never is.
  const bigStd = buildOrder([{ id: productId, quantity: 3 }], { shippingMethod: 'standard' });
  assert.ok(bigStd.subtotal >= 100);
  assert.equal(bigStd.shipping, 0, 'Standard is free once the threshold is cleared');

  const bigFast = buildOrder([{ id: productId, quantity: 3 }], { shippingMethod: 'overnight' });
  assert.equal(bigFast.shipping, 34.99, 'Overnight has no free threshold, so a big order still pays');
});

/* ============================================================
   3) Editing is admin-only, and cannot break checkout
   ============================================================ */
test('a customer can neither edit nor delete a shipping method', async () => {
  // Compare against what the table charged BEFORE the attempt: the catalog's
  // first product may or may not clear a free-shipping threshold on its own,
  // and the point here is only that nothing moved.
  const before = buildOrder([{ id: productId, quantity: 1 }]).shipping;

  const write = await api('/api/shipping', {
    method: 'POST', token: customer.token, body: { id: 'standard', name: 'Free for me', price: 0 }
  });
  assert.equal(write.status, 401);

  const del = await api('/api/shipping/standard', { method: 'DELETE', token: customer.token });
  assert.equal(del.status, 401);

  assert.equal(buildOrder([{ id: productId, quantity: 1 }]).shipping, before, 'nothing changed');
  assert.equal(rates.quote('standard', 50).fee, 9.99, 'the seeded rate is untouched');
});

test('the last enabled method cannot be disabled or deleted', async () => {
  // Leave exactly one enabled: Standard.
  await api('/api/shipping', {
    method: 'POST', token: boss.token,
    body: { id: 'overnight', name: 'Overnight', price: 34.99, enabled: false, sort: 30 }
  });
  const list = (await api('/api/shipping', { token: boss.token })).body.methods;
  assert.equal(list.filter(m => m.enabled).length, 1, 'one method left at checkout');

  const disable = await api('/api/shipping', {
    method: 'POST', token: boss.token,
    body: { id: 'standard', name: 'Standard', price: 9.99, freeOver: 100, enabled: false, sort: 10 }
  });
  assert.equal(disable.status, 400, 'turning the last one off would take the shop offline');
  assert.match(disable.body.error, /at least one/i);

  const remove = await api('/api/shipping/standard', { method: 'DELETE', token: boss.token });
  assert.equal(remove.status, 400, 'and neither can it be deleted');

  // Checkout still resolves to a real, charged method — 50 is a subtotal below
  // every seeded free-shipping threshold, so the fee is unambiguous.
  const still = rates.quote(null, 50);
  assert.equal(still.method.id, 'standard');
  assert.equal(still.fee, 9.99, 'checkout still charges');
});

test('a new method is given a slug from its name and is sellable at once', async () => {
  const added = await api('/api/shipping', {
    method: 'POST', token: boss.token,
    body: { name: 'Saturday delivery', eta: 'This Saturday', price: 24.5, freeOver: 0, enabled: true, sort: 40 }
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.method.id, 'saturday-delivery', 'the id is derived — the admin never types a slug');

  const q = await api('/api/quote', {
    method: 'POST', body: { items: [{ id: productId, quantity: 1 }], shippingMethod: 'saturday-delivery' }
  });
  assert.equal(q.body.shipping, 24.5);
  assert.equal(q.body.shippingLabel, 'Saturday delivery');
});

test('a negative fee is refused as the typo it is', async () => {
  await api('/api/shipping', {
    method: 'POST', token: boss.token,
    body: { name: 'Broken', price: -50, enabled: true, sort: 90 }
  });
  const stored = rates.listAll().find(m => m.id === 'broken');
  assert.equal(stored.price, 0, 'a negative fee is clamped to zero, never charged as a credit');
});
