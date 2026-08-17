/* ============================================================
   EVER NOVA LIFE — guest order lookup

   POST /api/orders/lookup answers "where is my order?" for someone
   who isn't signed in. The credential is the PAIR: the reference
   and the email address on that order.

   The security property worth testing is the negative one — a
   wrong email must be indistinguishable from a reference that
   doesn't exist. If the two answers differ at all (status, wording,
   any field), the endpoint becomes a way to confirm which order
   references are real.

   What has to hold:

     · the right pair returns the order's status and shipment
     · a wrong email and an unknown reference answer identically
     · nothing private comes back — no address, no account id, no
       payment detail, no other order
     · the lookup is rate limited, so references can't be walked
     · a pay-the-balance link is offered only when there genuinely
       is a balance that can be paid

   Runs with the built-in Node test runner:
       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- environment BEFORE requiring the app ----
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-lookup-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-lookup';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
delete process.env.ADMIN_KEY;

process.env.ZELLE_RECIPIENT = 'pay@evernovalife.com';
process.env.ZELLE_NAME = 'Ever Nova Life LLC';
process.env.ZELLE_MAX_TOTAL = '5000';

process.env.BTCPAY_URL = '';
process.env.BTCPAY_API_KEY = '';
process.env.BTCPAY_STORE_ID = '';

const app = require('../server.js');
const store = require('../store.js');
const ratelimit = require('../ratelimit.js');

let server, base, productId;

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const cat = await api('/api/products');
  const p = (cat.body.products || [])[0];
  assert.ok(p, 'catalog has a product to buy');
  productId = p.id;
});

test.after(async () => {
  if (server) { server.close(); await once(server, 'close'); }
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* The limiter counts per IP, and every test here comes from 127.0.0.1 — so
   without this the later tests would be answered by the limiter instead of the
   endpoint. Cleared before each test; one test then fills it on purpose. */
test.beforeEach(() => ratelimit.reset());

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

const WEB_AUTH = {
  accepted: true, version: '2026-08-14',
  acceptedAt: new Date().toISOString(), text: 'I authorize this order.'
};
const DECLARATIONS = {
  version: '2026-08-14',
  acceptedAt: new Date().toISOString(),
  items: [
    { id: 'terms', accepted: true, text: 'I accept the Terms and Conditions.' },
    { id: 'age-and-use', accepted: true, text: 'I am at least 21 (twenty-one) years of age...' }
  ]
};
const US_SHIPPING = {
  firstName: 'Jane', lastName: 'Doe', address: '123 Science Park Dr',
  city: 'Boston', state: 'MA', postalCode: '02115', country: 'US',
  institution: 'Acme Research Lab', researchField: 'Peptide Chemistry'
};

let seq = 0;
async function placeOrder(email = 'buyer@lab.org') {
  const acct = await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'Test', lastName: 'User', email: `lookup-${++seq}@example.com`, password: 'password123' }
  });
  const order = await api('/api/zelle/checkout', {
    method: 'POST', token: acct.body.token,
    body: {
      items: [{ id: productId, quantity: 1 }],
      shipping: US_SHIPPING, email,
      webAuthorization: WEB_AUTH, declarations: DECLARATIONS
    }
  });
  assert.equal(order.status, 201, 'order placed');
  return { orderId: order.body.orderId, email, total: order.body.total, token: acct.body.token };
}

const lookup = (orderId, email) =>
  api('/api/orders/lookup', { method: 'POST', body: { orderId, email } });

/* ============================================================
   1) The happy path
   ============================================================ */

test('the right reference and email return the order', async () => {
  const o = await placeOrder();
  const { status, body } = await lookup(o.orderId, o.email);
  assert.equal(status, 200);
  assert.equal(body.order.orderId, o.orderId);
  assert.equal(body.order.status, 'awaiting_payment');
  assert.equal(body.order.total, o.total);
  assert.ok(Array.isArray(body.order.items) && body.order.items.length, 'items listed');
});

test('the reference is not case- or space-sensitive', async () => {
  const o = await placeOrder();
  const messy = await lookup('  ' + o.orderId.toLowerCase() + '  ', '  ' + o.email.toUpperCase() + ' ');
  assert.equal(messy.status, 200, 'a reference retyped off a phone still works');
  assert.equal(messy.body.order.orderId, o.orderId);
});

test('shipment details appear once the order has shipped', async () => {
  const o = await placeOrder();
  store.updateOrderStatus(o.orderId, 'shipped', {
    carrier: 'USPS', tracking: '9400100000000000000000', shippedAt: new Date().toISOString()
  });
  const { body } = await lookup(o.orderId, o.email);
  assert.equal(body.order.status, 'shipped');
  assert.equal(body.order.carrier, 'USPS');
  assert.equal(body.order.tracking, '9400100000000000000000');
});

/* ============================================================
   2) The negative case — the whole point
   ============================================================ */

test('a wrong email is answered exactly like an unknown reference', async () => {
  const o = await placeOrder();
  const wrongEmail = await lookup(o.orderId, 'someone-else@example.com');
  const unknownRef = await lookup('ENL-DOESNOTEXIST', 'someone-else@example.com');

  assert.equal(wrongEmail.status, 404);
  assert.equal(unknownRef.status, 404);
  // Identical bodies: no wording, field or hint separates "real reference,
  // wrong person" from "no such reference".
  assert.deepEqual(wrongEmail.body, unknownRef.body);
});

test('a miss never leaks that the reference exists', async () => {
  const o = await placeOrder();
  const { body } = await lookup(o.orderId, 'attacker@example.com');
  const text = JSON.stringify(body);
  assert.ok(!text.includes(o.orderId), 'the reference is not echoed back');
  assert.ok(!text.includes(o.email), 'the real address is not echoed back');
});

test('a missing field is refused before any lookup happens', async () => {
  const o = await placeOrder();
  const noEmail = await lookup(o.orderId, '');
  const noRef = await lookup('', o.email);
  assert.equal(noEmail.status, 400);
  assert.equal(noRef.status, 400);
});

/* ============================================================
   3) What comes back is thin on purpose
   ============================================================ */

test('nothing private is returned with the order', async () => {
  const o = await placeOrder();
  const { body } = await lookup(o.orderId, o.email);
  const fields = Object.keys(body.order);

  for (const leak of ['shippingAddress', 'userId', 'webAuthorization', 'declarations',
                      'payments', 'invoiceId', 'transactionId', 'pointsEarned', 'email']) {
    assert.ok(!fields.includes(leak), `${leak} is not exposed`);
  }
  // And the stored record really does hold those, so the filter is doing work
  // rather than describing an order that never had them.
  const stored = store.listAllOrders().find(r => r.orderId === o.orderId);
  assert.ok(stored.shippingAddress, 'the stored order does carry an address');
  assert.ok(stored.webAuthorization, 'the stored order does carry the authorization');
});

test('an unpaid order offers no balance link', async () => {
  const o = await placeOrder();
  const { body } = await lookup(o.orderId, o.email);
  /* A Zelle order that hasn't been paid owes its full total, but there is no
     second bill to raise — the buyer has the transfer details already, and a
     crypto invoice for the same goods would be billing it twice. */
  assert.equal(body.order.payUrl, '');
});

test('a short-paid order offers the pay-the-balance link', async () => {
  const o = await placeOrder();
  store.updateOrderStatus(o.orderId, 'underpaid', {
    paidAmount: 10, payments: { 'inv-1': 10 }, paidAmountUnknown: false
  });
  const { body } = await lookup(o.orderId, o.email);
  assert.ok(body.order.due > 0, 'a balance is outstanding');
  assert.match(body.order.payUrl, /pay\.html\?order=/, 'the self-serve fix is offered');
});

/* ============================================================
   4) Rate limiting
   ============================================================ */

test('repeated guesses are rate limited, with a Retry-After', async () => {
  // 12 per 10 minutes per IP. Walk past it with misses.
  let last = null;
  for (let i = 0; i < 14; i++) {
    last = await fetch(base + '/api/orders/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: `ENL-GUESS${i}`, email: 'attacker@example.com' })
    });
  }
  assert.equal(last.status, 429, 'the walk is stopped');
  assert.ok(Number(last.headers.get('retry-after')) > 0, 'told when to come back');
});

test('the limit is lifted once the window resets', async () => {
  const o = await placeOrder();
  for (let i = 0; i < 14; i++) await lookup(`ENL-GUESS${i}`, 'attacker@example.com');
  assert.equal((await lookup(o.orderId, o.email)).status, 429, 'blocked while the window is open');

  ratelimit.reset();                                   // stands in for the window expiring
  assert.equal((await lookup(o.orderId, o.email)).status, 200, 'served again afterwards');
});
