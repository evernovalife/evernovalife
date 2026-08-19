/* ============================================================
   EVER NOVA LIFE — loyalty earn vs. live promotions
   The pricing-promotions test file pins the arithmetic that
   `markOrderPaid` is SUPPOSED to use, but it never calls that
   function — it computes `loyalty.earnForAmount` locally from
   values `buildOrder` hands back. A regression that reverted the
   earn line in server.js back to `(subtotal - discount)` (dropping
   the `promoDiscount` term) would slip past every other test in
   the suite, and it would mint loyalty points against money the
   customer never actually paid.

   This file drives the real HTTP chain — register, run a live cart
   promo, place a Zelle order, have admin confirm payment, read the
   credited balance — so the earn line in `markOrderPaid` actually
   executes.

   Runs with the built-in Node test runner (no extra deps):
       npm test          (from the server/ folder)
       node --test test/loyalty-promotions.test.js
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- configure the environment BEFORE requiring the app ----
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-loyalty-promo-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-loyalty-promo';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
delete process.env.ADMIN_KEY;              // exercise account-based admin only

// Zelle config the module reads at load time — this is the only payment
// path that reaches `markOrderPaid` without a live BTCPay network call.
process.env.ZELLE_RECIPIENT = 'pay@evernovalife.com';
process.env.ZELLE_NAME = 'Ever Nova Life LLC';
process.env.ZELLE_MAX_TOTAL = '5000';

// Blank (but present) BTCPay keys so nothing can reach a live gateway.
process.env.BTCPAY_URL = '';
process.env.BTCPAY_API_KEY = '';
process.env.BTCPAY_STORE_ID = '';

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

/* small fetch helper: returns { status, body } */
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

/* The admin account is registered by whichever test needs it first, so sign
   in rather than assuming — a second register() would just be rejected. */
async function adminSignIn() {
  const email = 'boss@evernovalife.com', password = 'password123';
  const login = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (login.status === 200) return login.body;
  const reg = await register(email, password);
  assert.ok(reg.token, 'admin account created');
  return reg;
}

let _buyerSeq = 0;
async function aBuyer() {
  return register(`loyalty-promo-buyer-${++_buyerSeq}@example.com`);
}

/* Every order needs the web order authorization the checkout page collects
   (Terms §12), and the buyer declarations (Terms acceptance + age/use). Both
   are conditions of sale, refused server-side when absent — see zelle.test.js. */
const WEB_AUTH = {
  accepted: true,
  version: '2026-08-14',
  acceptedAt: new Date().toISOString(),
  text: 'I authorize this order.'
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

function zelleOrder({ token, quantity = 1 }) {
  return api('/api/zelle/checkout', {
    method: 'POST', token,
    body: {
      items: [{ id: productId, quantity }],
      shipping: US_SHIPPING,
      email: 'buyer@example.com',
      webAuthorization: WEB_AUTH,
      declarations: DECLARATIONS
    }
  });
}

async function clearPromos(boss) {
  const list = await api('/api/admin/promotions', { token: boss.token });
  for (const p of (list.body.promotions || [])) {
    await api(`/api/admin/promotions/${p.id}`, { method: 'DELETE', token: boss.token });
  }
}

/* ============================================================
   Points earned on payment must reflect a live cart promo — the
   whole point of the fix under test.
   ============================================================ */
test('a live cart promo lowers the points credited when payment is confirmed', async () => {
  const boss = await adminSignIn();
  await clearPromos(boss);
  await api('/api/admin/promotions', {
    method: 'POST', token: boss.token,
    body: { name: 'Ten off', type: 'cart', mode: 'amount', value: 10, minSubtotal: 0 }
  });

  const buyer = await aBuyer();
  const placed = await zelleOrder({ token: buyer.token });
  assert.equal(placed.status, 201, 'the order is placed with the promo running');
  assert.ok(placed.body.orderId, 'order id present');

  await clearPromos(boss);   // the promo must not affect anything AFTER checkout

  const before = await api('/api/loyalty', { token: buyer.token });
  const confirm = await api(`/api/admin/orders/${placed.body.orderId}/paid`, { method: 'POST', token: boss.token });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.order.status, 'paid');

  const promoDiscount = confirm.body.order.promoDiscount;
  assert.ok(promoDiscount > 0, 'the order record carries the promo savings');
  const subtotal = confirm.body.order.subtotal;

  const after = await api('/api/loyalty', { token: buyer.token });
  const earned = after.body.balance - before.body.balance;

  const expectedOnPaid = loyalty.earnForAmount(subtotal - promoDiscount);
  const expectedOnFullPrice = loyalty.earnForAmount(subtotal);

  // The assertion that matters: points match what was actually paid...
  assert.strictEqual(earned, expectedOnPaid,
    'points credited equal earnForAmount(subtotal - promoDiscount)');
  // ...and are STRICTLY FEWER than what the full list price would have earned —
  // this is what goes red if the `promoDiscount` term is ever dropped from the
  // earn line in markOrderPaid.
  assert.ok(earned < expectedOnFullPrice,
    'points credited are strictly fewer than earning on the undiscounted subtotal');
});
