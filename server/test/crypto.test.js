/* ============================================================
   EVER NOVA LIFE — crypto checkout + invoice scheduler tests
   Crypto is the store's primary (and only automatic) payment
   method, and every order it creates is confirmed LATER by a
   webhook. That gap is where the money bugs live, so this suite
   pins the behaviour around it:

     · the invoice amount is the SERVER's total, discount included
     · loyalty points are HELD when the invoice opens, and handed
       back if it expires — exactly once, however many times the
       webhook fires
     · an unsigned webhook can't move an order to paid
     · a due auto-ship plan is INVOICED, not charged: the order
       lands pending and the customer is emailed a pay link
     · re-running the scheduler can't bill the same shipment twice

   A stub BTCPay stands in for the real gateway, so nothing here
   can reach a live instance or move coin.

   Runs with the built-in Node test runner (no extra deps):
       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- configure the environment BEFORE requiring anything ----
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-crypto-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-crypto';
process.env.ALLOWED_ORIGINS = '*';
process.env.CRON_KEY = 'test-cron-crypto';
process.env.BTCPAY_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.SUBSCRIPTION_INPROCESS_CRON = '0';   // no background timer during tests
process.env.SITE_URL = 'https://evernovalife.com';
delete process.env.ADMIN_KEY;

/* The stub gateway. Started before the app is required, because btcpay.js
   reads BTCPAY_URL at module load. */
const invoices = [];
const btcpayStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    const payload = JSON.parse(raw || '{}');
    invoices.push({ url: req.url, auth: req.headers.authorization, payload });
    const id = 'inv-' + invoices.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, checkoutLink: `https://pay.test/i/${id}`, status: 'New' }));
  });
});

let app, loyalty, subscriptions, store;
let server, base, productId;

test.before(async () => {
  btcpayStub.listen(0, '127.0.0.1');
  await once(btcpayStub, 'listening');
  process.env.BTCPAY_URL = `http://127.0.0.1:${btcpayStub.address().port}`;
  process.env.BTCPAY_API_KEY = 'test-key';
  process.env.BTCPAY_STORE_ID = 'test-store';

  app = require('../server.js');
  loyalty = require('../loyalty.js');
  subscriptions = require('../subscriptions.js');
  store = require('../store.js');

  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  const cat = await api('/api/products');
  const p = (cat.body.products || [])[0];
  assert.ok(p, 'catalog has at least one product to buy');
  productId = p.id;
});

test.after(async () => {
  if (server) { server.close(); await once(server, 'close'); }
  btcpayStub.close();
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function api(pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* no JSON body */ }
  return { status: res.status, body: parsed };
}

let _seq = 0;
async function buyer() {
  const email = `crypto-buyer-${++_seq}@example.com`;
  const r = await api('/api/auth/register', {
    method: 'POST', body: { firstName: 'Test', lastName: 'User', email, password: 'password123' }
  });
  assert.ok(r.body && r.body.token, 'buyer registered');
  return r.body;
}

const SHIPPING = {
  name: 'Jane Doe', address: '123 Science Park Dr',
  city: 'Boston', state: 'MA', postalCode: '02115', countryCode: 'US',
  institution: 'Acme Research Lab', researchField: 'Peptide Chemistry'
};

/* BTCPay signs the RAW body; the server must verify against it. */
function sign(rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', 'test-webhook-secret').update(rawBody).digest('hex');
}
async function webhook(rawBody, sig) {
  return api('/api/crypto/webhook', {
    method: 'POST', body: rawBody, headers: { 'BTCPay-Sig': sig === undefined ? sign(rawBody) : sig }
  });
}

async function openOrder(token, extra = {}) {
  return api('/api/crypto/checkout', {
    method: 'POST', token,
    body: {
      items: [{ id: productId, quantity: 1 }],
      shipping: SHIPPING,
      email: 'buyer@example.com',
      ...extra
    }
  });
}

/* ============================================================
   1) The invoice is priced by us, not by the browser
   ============================================================ */
test('the BTCPay invoice is opened for the server-priced total', async () => {
  const b = await buyer();
  const before = invoices.length;
  const res = await openOrder(b.token);

  assert.equal(res.status, 201, 'order opened');
  assert.ok(res.body.checkoutLink, 'the browser gets a hosted checkout link');
  assert.equal(invoices.length, before + 1, 'exactly one invoice was opened');

  const sent = invoices[invoices.length - 1];
  assert.match(sent.auth, /^token test-key$/, 'Greenfield API-key auth scheme');
  assert.equal(Number(sent.payload.amount), res.body.total, 'invoice amount = the total we priced');
  assert.equal(sent.payload.metadata.orderId, res.body.orderId, 'our order id rides on the invoice');
});

test('the order opens as pending and only the webhook can pay it', async () => {
  const b = await buyer();
  const res = await openOrder(b.token);
  const mine = store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId);
  assert.equal(mine.status, 'pending', 'nothing is paid just because an invoice exists');
  assert.equal(mine.method, 'crypto');

  const evt = JSON.stringify({ type: 'InvoiceSettled', metadata: { orderId: res.body.orderId } });

  const forged = await webhook(evt, 'sha256=' + 'f'.repeat(64));
  assert.equal(forged.status, 400, 'a bad signature is rejected');
  assert.equal(
    store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId).status, 'pending',
    'the forged call changed nothing'
  );

  const ok = await webhook(evt);
  assert.equal(ok.status, 200, 'a correctly signed webhook is accepted');
  assert.equal(
    store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId).status, 'paid',
    'the order is now paid'
  );
});

/* ============================================================
   2) Loyalty points are held, not spent-on-hope
   ============================================================ */
test('redeemed points are held when the invoice opens', async () => {
  const b = await buyer();
  loyalty.earn(b.user.id, 1000, 'test seed', {});
  const before = loyalty.getBalance(b.user.id);

  const res = await openOrder(b.token, { pointsToRedeem: 1000 });
  assert.ok(res.body.discount > 0, 'the discount reached the invoice');
  assert.ok(res.body.pointsRedeemed > 0, 'points were taken');
  assert.equal(loyalty.getBalance(b.user.id), before - res.body.pointsRedeemed,
    'the balance is debited immediately, so it cannot fund a second open invoice');

  const sent = invoices[invoices.length - 1];
  assert.equal(Number(sent.payload.amount), res.body.total, 'the buyer is billed the discounted amount');
});

test('held points come back when the invoice expires — exactly once', async () => {
  const b = await buyer();
  loyalty.earn(b.user.id, 1000, 'test seed', {});
  const res = await openOrder(b.token, { pointsToRedeem: 500 });
  const held = res.body.pointsRedeemed;
  assert.ok(held > 0, 'points were held');

  const afterHold = loyalty.getBalance(b.user.id);
  const evt = JSON.stringify({ type: 'InvoiceExpired', metadata: { orderId: res.body.orderId } });

  await webhook(evt);
  assert.equal(loyalty.getBalance(b.user.id), afterHold + held, 'the points were returned');
  assert.equal(
    store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId).status, 'cancelled',
    'the order is cancelled'
  );

  // BTCPay retries deliveries; a repeat must not mint points.
  await webhook(evt);
  await webhook(evt);
  assert.equal(loyalty.getBalance(b.user.id), afterHold + held, 'repeat deliveries do not double-refund');
});

/* ============================================================
   3) Auto-ship: a due plan is INVOICED, never charged
   ============================================================ */
test('a due plan is invoiced, and the shipment stays unpaid until settled', async () => {
  const b = await buyer();
  const res = await openOrder(b.token, { autoship: { enabled: true, intervalDays: 7 } });
  assert.ok(res.body.subscription, 'the plan was created alongside the order');
  const planId = res.body.subscription.id;
  assert.equal(res.body.subscription.paymentLabel, 'Bitcoin / Lightning invoice');

  subscriptions.update(planId, null, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
  const before = invoices.length;

  const run = await api('/api/subscriptions/run-due', {
    method: 'POST', headers: { 'x-cron-key': 'test-cron-crypto' }
  });
  assert.equal(run.status, 200, 'the cron key authorises the run');
  assert.equal(run.body.invoiced, 1, 'the plan was invoiced: ' + JSON.stringify(run.body.results));
  assert.equal(invoices.length, before + 1, 'one new BTCPay invoice');

  const shipment = store.listOrders(b.user.id)
    .find(o => o.subscriptionId === planId && o.orderId !== res.body.orderId);
  assert.ok(shipment, 'the shipment was recorded as an order');
  assert.equal(shipment.status, 'pending',
    'an auto-ship order is a BILL, not a payment — it must not be marked paid');

  // The scheduled run must be safe to repeat: the date has advanced, and even a
  // forced re-run finds the existing order rather than issuing a second bill.
  const again = await api('/api/subscriptions/run-due', {
    method: 'POST', headers: { 'x-cron-key': 'test-cron-crypto' }
  });
  assert.equal(again.body.due, 0, 'the schedule advanced past today');
  assert.equal(invoices.length, before + 1, 'no duplicate invoice');
});

test('an interrupted run reuses its order instead of billing twice', async () => {
  const b = await buyer();
  const res = await openOrder(b.token, { autoship: { enabled: true, intervalDays: 7 } });
  const planId = res.body.subscription.id;

  // Simulate a run that recorded its order reference and then died: the plan is
  // due again with a pendingOrderId pointing at an order that already exists.
  subscriptions.update(planId, null, {
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
    pendingOrderId: res.body.orderId          // an order that IS in the store
  });
  const before = invoices.length;

  const run = await api('/api/subscriptions/run-due', {
    method: 'POST', headers: { 'x-cron-key': 'test-cron-crypto' }
  });
  assert.equal(invoices.length, before, 'no second invoice was opened for that shipment');
  assert.equal(run.body.results[0].status, 'recovered', 'the run recognised the completed work');
});

/* ============================================================
   4) The trigger is not open to the public
   ============================================================ */
test('run-due rejects a caller with no cron key and no admin account', async () => {
  const res = await api('/api/subscriptions/run-due', { method: 'POST' });
  assert.equal(res.status, 401, 'anonymous callers cannot fire the billing run');

  // A signed-in customer is not an admin, so requireAdmin turns them away too.
  const b = await buyer();
  const asCustomer = await api('/api/subscriptions/run-due', { method: 'POST', token: b.token });
  assert.equal(asCustomer.status, 401, 'an ordinary customer cannot fire it either');
});
