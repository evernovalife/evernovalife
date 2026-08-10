/* ============================================================
   EVER NOVA LIFE — stock across the order lifecycle (end to end)

   stock.test.js proves the counting rules in products.js. This one drives the
   real HTTP routes, because the part that actually loses money is the WIRING:
   whether an order route takes the units, and whether a cancelled order gives
   them back.

   Zelle is the vehicle — it is the one checkout that completes without an
   external gateway, and it shares reserveOrderStock/releaseOrderStock with the
   crypto path.

   What has to hold:

     · placing an order draws the count down
     · the count is taken when the order OPENS (unpaid), not on confirmation
     · confirming payment does not double-decrement
     · admin-cancelling an unpaid order puts the units back
     · cancelling twice doesn't credit twice
     · the last unit can't be sold to two buyers
     · a product with no count still sells, unchanged

   Runs with the built-in Node test runner:
       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-stockord-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-stock-orders';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
delete process.env.ADMIN_KEY;

process.env.ZELLE_RECIPIENT = 'pay@evernovalife.com';
process.env.ZELLE_NAME = 'Ever Nova Life LLC';
process.env.ZELLE_MAX_TOTAL = '50000';

// blank (but present) BTCPay keys so nothing can reach a live gateway
process.env.BTCPAY_URL = '';
process.env.BTCPAY_API_KEY = '';
process.env.BTCPAY_STORE_ID = '';

const products = require('../products.js');
const app = require('../server.js');

let server, base, trackedId, looseId;

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  // Two products off the seeded catalog: one we start counting, one we leave alone.
  const cat = await api('/api/products');
  const list = cat.body.products || [];
  assert.ok(list.length >= 2, 'catalog has products to buy');
  trackedId = list[0].id;
  looseId = list[1].id;
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
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* no JSON body */ }
  return { status: res.status, body: parsed };
}

let _seq = 0;
async function aBuyer() {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'Test', lastName: 'User', email: `stock-buyer-${++_seq}@example.com`, password: 'password123' }
  });
  return r.body;
}

async function adminSignIn() {
  const email = 'boss@evernovalife.com', password = 'password123';
  const login = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (login.status === 200) return login.body;
  const reg = await api('/api/auth/register', {
    method: 'POST', body: { firstName: 'Boss', lastName: 'Admin', email, password }
  });
  return reg.body;
}

const US_SHIPPING = {
  firstName: 'Jane', lastName: 'Doe', address: '123 Science Park Dr',
  city: 'Boston', state: 'MA', postalCode: '02115', country: 'US',
  institution: 'Acme Research Lab', researchField: 'Peptide Chemistry'
};

function order({ token, id, quantity = 1 }) {
  return api('/api/zelle/checkout', {
    method: 'POST', token,
    body: { items: [{ id, quantity }], shipping: US_SHIPPING, email: 'buyer@example.com' }
  });
}

const countOf = id => products.getProduct(id).stockQty;

/* ============================================================
   the count follows the order
   ============================================================ */

test('placing an order draws the count down while it is still UNPAID', async () => {
  products.setStock(trackedId, 10);
  const buyer = await aBuyer();

  const res = await order({ token: buyer.token, id: trackedId, quantity: 3 });
  assert.equal(res.status, 201);
  assert.equal(countOf(trackedId), 7, '3 units came off the shelf immediately');

  // and the order is genuinely not paid yet
  const mine = await api('/api/orders', { token: buyer.token });
  const placed = (mine.body.orders || []).find(o => o.orderId === res.body.orderId);
  assert.equal(placed.status, 'awaiting_payment');
});

test('confirming the payment does not decrement a second time', async () => {
  products.setStock(trackedId, 5);
  const buyer = await aBuyer();
  const res = await order({ token: buyer.token, id: trackedId, quantity: 2 });
  assert.equal(countOf(trackedId), 3);

  const admin = await adminSignIn();
  const paid = await api(`/api/admin/orders/${res.body.orderId}/paid`, { method: 'POST', token: admin.token });
  assert.equal(paid.status, 200);
  assert.equal(countOf(trackedId), 3, 'still 3 — the units were taken when the order opened');
});

test('cancelling an unpaid order puts the units back', async () => {
  products.setStock(trackedId, 6);
  const buyer = await aBuyer();
  const res = await order({ token: buyer.token, id: trackedId, quantity: 4 });
  assert.equal(countOf(trackedId), 2);

  const admin = await adminSignIn();
  const cancel = await api(`/api/admin/orders/${res.body.orderId}/cancel`, { method: 'POST', token: admin.token });
  assert.equal(cancel.status, 200);
  assert.equal(countOf(trackedId), 6, 'back on the shelf');
});

test('cancelling twice does not credit the units twice', async () => {
  products.setStock(trackedId, 6);
  const buyer = await aBuyer();
  const res = await order({ token: buyer.token, id: trackedId, quantity: 2 });
  const admin = await adminSignIn();

  await api(`/api/admin/orders/${res.body.orderId}/cancel`, { method: 'POST', token: admin.token });
  assert.equal(countOf(trackedId), 6);
  await api(`/api/admin/orders/${res.body.orderId}/cancel`, { method: 'POST', token: admin.token });
  assert.equal(countOf(trackedId), 6, 'still 6, not 8');
});

/* ============================================================
   overselling
   ============================================================ */

test('the last unit cannot be sold to two buyers', async () => {
  products.setStock(trackedId, 1);
  const first = await aBuyer();
  const second = await aBuyer();

  const a = await order({ token: first.token, id: trackedId, quantity: 1 });
  assert.equal(a.status, 201);
  assert.equal(countOf(trackedId), 0);

  const b = await order({ token: second.token, id: trackedId, quantity: 1 });
  assert.equal(b.status, 400, 'refused — pricing catches it before the reservation');
  assert.match(b.body.error, /out of stock/i);
  assert.equal(countOf(trackedId), 0, 'and nothing went negative');
});

test('an order larger than the count is refused and names the number', async () => {
  products.setStock(trackedId, 2);
  const buyer = await aBuyer();
  const res = await order({ token: buyer.token, id: trackedId, quantity: 5 });
  assert.ok(res.status >= 400, 'refused');
  assert.match(res.body.error, /Only 2 left/);
  assert.equal(countOf(trackedId), 2, 'untouched');
});

/* ============================================================
   untracked products are unaffected
   ============================================================ */

test('a product with no count still sells, and gains no count by being bought', async () => {
  const before = products.getProduct(looseId);
  assert.equal(before.stockQty, undefined, 'starts untracked');

  const buyer = await aBuyer();
  const res = await order({ token: buyer.token, id: looseId, quantity: 25 });
  assert.equal(res.status, 201, 'no ceiling applies');
  assert.equal(products.getProduct(looseId).stockQty, undefined, 'still untracked');
});

/* ============================================================
   the admin route that sets it
   ============================================================ */

test('only an admin can set a stock count', async () => {
  const buyer = await aBuyer();
  const res = await api(`/api/products/${trackedId}/stock`, {
    method: 'PATCH', token: buyer.token, body: { stockQty: 999 }
  });
  assert.equal(res.status, 401);

  const anon = await api(`/api/products/${trackedId}/stock`, { method: 'PATCH', body: { stockQty: 999 } });
  assert.equal(anon.status, 401);
});

test('an admin can set a count, and clear it back to untracked', async () => {
  const admin = await adminSignIn();

  const set = await api(`/api/products/${trackedId}/stock`, {
    method: 'PATCH', token: admin.token, body: { stockQty: 12 }
  });
  assert.equal(set.status, 200);
  assert.equal(set.body.product.stockQty, 12);
  assert.equal(countOf(trackedId), 12);

  const clear = await api(`/api/products/${trackedId}/stock`, {
    method: 'PATCH', token: admin.token, body: { stockQty: null }
  });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.product.stockQty, undefined, 'no longer counted');
});

test('the storefront catalog carries the count, so the shop can show it', async () => {
  const admin = await adminSignIn();
  await api(`/api/products/${trackedId}/stock`, { method: 'PATCH', token: admin.token, body: { stockQty: 4 } });

  const cat = await api('/api/products');
  const p = (cat.body.products || []).find(x => Number(x.id) === Number(trackedId));
  assert.equal(p.stockQty, 4);
});
