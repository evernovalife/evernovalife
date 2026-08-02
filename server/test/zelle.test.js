/* ============================================================
   EVER NOVA LIFE — Zelle (manual bank transfer) tests
   Zelle money moves outside the app entirely, so the things
   worth proving here are the ones that decide whether an order
   ships or a customer is charged twice in effect:

     · the browser never sets the price — the server does
     · checkout requires an ACCOUNT — a guest is turned away
       (2026-08 compliance review)
     · the institution/lab and research field are required, and
       recorded with the order
     · orders open UNPAID; only an admin confirmation pays them
     · confirming twice doesn't credit reward points twice
     · an ordinary customer can't confirm their own payment
     · a paid order can't be quietly cancelled
     · the US-only and send-limit guards refuse up front, rather
       than taking an order that can't be paid

   Runs with the built-in Node test runner (no extra deps):
       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- configure the environment BEFORE requiring anything ----
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-zelle-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-zelle';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
delete process.env.ADMIN_KEY;              // exercise account-based admin only

// Zelle config the module reads at load time.
process.env.ZELLE_RECIPIENT = 'pay@evernovalife.com';
process.env.ZELLE_NAME = 'Ever Nova Life LLC';
process.env.ZELLE_MAX_TOTAL = '5000';

// Blank (but present) Braintree keys so nothing can reach a live gateway.
process.env.BRAINTREE_MERCHANT_ID = '';
process.env.BRAINTREE_PUBLIC_KEY = '';
process.env.BRAINTREE_PRIVATE_KEY = '';

const loyalty = require('../loyalty.js');
const app = require('../server.js');

let server, base, productId, unitPrice;

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const cat = await api('/api/products');
  const p = (cat.body.products || [])[0];
  assert.ok(p, 'catalog has at least one product to buy');
  productId = p.id;
  unitPrice = Number(p.price);
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

async function register(email, password = 'password123') {
  const r = await api('/api/auth/register', {
    method: 'POST', body: { firstName: 'Test', lastName: 'User', email, password }
  });
  return r.body;   // { success, user, token }
}

/* The admin account is registered by whichever test needs it first, so sign in
   rather than assuming — a second register() would just be rejected. */
async function adminSignIn() {
  const email = 'boss@evernovalife.com', password = 'password123';
  const login = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (login.status === 200) return login.body;
  const reg = await register(email, password);
  assert.ok(reg.token, 'admin account created');
  return reg;
}

const US_SHIPPING = {
  firstName: 'Jane', lastName: 'Doe', address: '123 Science Park Dr',
  city: 'Boston', state: 'MA', postalCode: '02115', country: 'US',
  institution: 'Acme Research Lab', researchField: 'Peptide Chemistry'
};

/* Checkout needs an account now, so most tests want a throwaway buyer.
   Emails are unique per caller so registrations never collide. */
let _buyerSeq = 0;
async function aBuyer() {
  return register(`zelle-auto-${++_buyerSeq}@example.com`);
}

function zelleOrder({ token, quantity = 1, shipping = US_SHIPPING, email = 'buyer@example.com' } = {}) {
  return api('/api/zelle/checkout', {
    method: 'POST', token,
    body: { items: [{ id: productId, quantity }], shipping, email }
  });
}

/* ============================================================
   1) The price is the server's, and the order opens unpaid
   ============================================================ */
test('the server prices the order — a total sent by the browser is ignored', async () => {
  const buyer = await aBuyer();
  const { status, body } = await api('/api/zelle/checkout', {
    method: 'POST', token: buyer.token,
    body: {
      items: [{ id: productId, quantity: 2 }],
      shipping: US_SHIPPING,
      email: 'buyer@example.com',
      total: 0.01, amount: 0.01           // hostile input
    }
  });
  assert.equal(status, 201);
  assert.ok(body.total >= unitPrice * 2, `total ${body.total} reflects 2 units at ${unitPrice}`);
  assert.equal(body.instructions.amount, body.total, 'the amount to send IS the priced total');
});

test('the instructions name the memo, recipient and hold window', async () => {
  const buyer = await aBuyer();
  const { body } = await zelleOrder({ token: buyer.token });
  const i = body.instructions;
  assert.equal(i.memo, body.orderId, 'the memo is the order reference — that is how it gets matched');
  assert.equal(i.recipient, 'pay@evernovalife.com');
  assert.equal(i.recipientName, 'Ever Nova Life LLC');
  assert.ok(Number(i.windowHours) > 0);
  assert.ok(Date.parse(i.expiresAt) > Date.now(), 'the hold window is in the future');
});

test('a signed-in order is recorded as awaiting_payment, not paid', async () => {
  const buyer = await register('zelle-buyer@example.com');
  const { body } = await zelleOrder({ token: buyer.token });

  const orders = await api('/api/orders', { token: buyer.token });
  const mine = (orders.body.orders || []).find(o => o.orderId === body.orderId);
  assert.ok(mine, 'the order shows up on the account');
  assert.equal(mine.status, 'awaiting_payment', 'nothing is paid until the money is confirmed');
  assert.equal(mine.method, 'zelle');
});

test('placing a Zelle order empties the saved cart', async () => {
  const buyer = await register('zelle-cart@example.com');
  await api('/api/cart', { method: 'PUT', token: buyer.token, body: { items: [{ id: productId, name: 'x', price: 1, quantity: 1 }] } });
  await zelleOrder({ token: buyer.token });
  const cart = await api('/api/cart', { token: buyer.token });
  assert.deepEqual(cart.body.items, [], 'the cart is cleared once they commit to buying');
});

/* ============================================================
   2) An account is required — guests cannot order at all
   ============================================================ */
test('a guest cannot place an order', async () => {
  const { status } = await zelleOrder();                 // no token = guest
  assert.equal(status, 401, 'checkout is account-only');
});

test('an order is visible in the admin queue', async () => {
  const boss = await adminSignIn();
  const buyer = await aBuyer();
  const { body } = await zelleOrder({ token: buyer.token });

  const pending = await api('/api/admin/orders?status=awaiting_payment', { token: boss.token });
  const found = (pending.body.orders || []).find(o => o.orderId === body.orderId);
  assert.ok(found, 'the order is in the admin queue');
  assert.equal(found.status, 'awaiting_payment');
});

/* ============================================================
   2b) Research qualification is required and recorded
   ============================================================ */
test('an order without an institution / lab is refused', async () => {
  const buyer = await aBuyer();
  const { institution, ...noInstitution } = US_SHIPPING;
  const { status, body } = await zelleOrder({ token: buyer.token, shipping: noInstitution });
  assert.equal(status, 400);
  assert.match(body.error, /institution or lab/i);
});

test('an order without a research field is refused', async () => {
  const buyer = await aBuyer();
  const { researchField, ...noField } = US_SHIPPING;
  const { status, body } = await zelleOrder({ token: buyer.token, shipping: noField });
  assert.equal(status, 400);
  assert.match(body.error, /research field/i);
});

test('a research field outside the published list is refused', async () => {
  const buyer = await aBuyer();
  const { status, body } = await zelleOrder({
    token: buyer.token,
    shipping: { ...US_SHIPPING, researchField: 'Personal Use' }
  });
  assert.equal(status, 400);
  assert.match(body.error, /research field/i);
});

test('the institution and research field are stored on the order', async () => {
  const buyer = await aBuyer();
  const { body } = await zelleOrder({ token: buyer.token });
  const orders = await api('/api/orders', { token: buyer.token });
  const mine = (orders.body.orders || []).find(o => o.orderId === body.orderId);
  assert.equal(mine.shippingAddress.institution, 'Acme Research Lab');
  assert.equal(mine.shippingAddress.researchField, 'Peptide Chemistry');
});

/* ============================================================
   3) Only an admin confirms payment — and only once
   ============================================================ */
test('an ordinary customer cannot mark their own order paid', async () => {
  const buyer = await register('zelle-sneaky@example.com');
  const { body } = await zelleOrder({ token: buyer.token });

  const attempt = await api(`/api/admin/orders/${body.orderId}/paid`, { method: 'POST', token: buyer.token });
  assert.equal(attempt.status, 401);

  const orders = await api('/api/orders', { token: buyer.token });
  const mine = (orders.body.orders || []).find(o => o.orderId === body.orderId);
  assert.equal(mine.status, 'awaiting_payment', 'still unpaid');
});

test('admin confirmation pays the order and credits points exactly once', async () => {
  const boss = await adminSignIn();
  const buyer = await register('zelle-paid@example.com');
  const placed = await zelleOrder({ token: buyer.token, quantity: 2 });

  const before = await api('/api/loyalty', { token: buyer.token });
  const first = await api(`/api/admin/orders/${placed.body.orderId}/paid`, { method: 'POST', token: boss.token });
  assert.equal(first.status, 200);
  assert.equal(first.body.order.status, 'paid');
  assert.ok(first.body.order.paidAt, 'the time it was confirmed is stamped');

  const after = await api('/api/loyalty', { token: buyer.token });
  const earned = after.body.balance - before.body.balance;
  assert.ok(earned > 0, 'points are credited when the money is confirmed, not when the order is placed');

  // Confirming again (double click, or a second look at the bank) must not re-credit.
  const second = await api(`/api/admin/orders/${placed.body.orderId}/paid`, { method: 'POST', token: boss.token });
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyPaid, true);
  const twice = await api('/api/loyalty', { token: buyer.token });
  assert.equal(twice.body.balance, after.body.balance, 'no second credit');
});

test('confirming an unknown reference is a 404, not a silent success', async () => {
  const boss = await adminSignIn();
  const r = await api('/api/admin/orders/ENL-DOES-NOT-EXIST/paid', { method: 'POST', token: boss.token });
  assert.equal(r.status, 404);
});

/* ============================================================
   4) Cancelling
   ============================================================ */
test('an unpaid order can be cancelled; a paid one cannot', async () => {
  const boss = await adminSignIn();
  const buyer = await register('zelle-cancel@example.com');

  const unpaid = await zelleOrder({ token: buyer.token });
  const cancelled = await api(`/api/admin/orders/${unpaid.body.orderId}/cancel`, { method: 'POST', token: boss.token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.order.status, 'cancelled');

  const paid = await zelleOrder({ token: buyer.token });
  await api(`/api/admin/orders/${paid.body.orderId}/paid`, { method: 'POST', token: boss.token });
  const refused = await api(`/api/admin/orders/${paid.body.orderId}/cancel`, { method: 'POST', token: boss.token });
  assert.equal(refused.status, 400, 'a paid order is a refund, not a cancellation');
});

/* ============================================================
   5) Guards — refuse orders that can't actually be paid this way
   ============================================================ */
test('non-US shipping is refused up front', async () => {
  const buyer = await aBuyer();
  const { status, body } = await zelleOrder({
    token: buyer.token,
    shipping: { ...US_SHIPPING, country: 'CA' }
  });
  assert.equal(status, 400);
  assert.match(body.error, /United States only/i);
});

test('a missing shipping country is refused', async () => {
  const buyer = await aBuyer();
  const { country, ...noCountry } = US_SHIPPING;
  const { status, body } = await zelleOrder({ token: buyer.token, shipping: noCountry });
  assert.equal(status, 400);
  assert.match(body.error, /United States only/i);
});

test('an order over ZELLE_MAX_TOTAL is refused', async () => {
  const buyer = await aBuyer();
  const qty = Math.ceil(5000 / unitPrice) + 1;
  const { status, body } = await zelleOrder({ token: buyer.token, quantity: qty });
  assert.equal(status, 400);
  assert.match(body.error, /Zelle is available on orders up to/i);
});

/* ============================================================
   6) Health advertises the method, so the checkout page can hide it
   ============================================================ */
test('/api/health reports zelle availability', async () => {
  const { body } = await api('/api/health');
  assert.equal(body.zelle, true, 'configured here, so the option should be offered');
});

/* Keep the loyalty module referenced — the points assertions above depend on
   its config being loaded from the same process as the server. */
assert.ok(typeof loyalty.earnForAmount === 'function');
