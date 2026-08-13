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
// An admin ACCOUNT (not the key) — the underpaid tests need someone who can
// settle a parked order, and the key path is covered in authz.test.js.
process.env.ADMIN_EMAILS = 'boss-crypto@example.com';
delete process.env.ADMIN_KEY;

/* The stub gateway. Started before the app is required, because btcpay.js
   reads BTCPAY_URL at module load.
   POST … /invoices  → opens one, and is what `invoices` counts.
   GET  … /invoices/:id → reads one back, including how much has been paid
   against it (paidAmounts below). Reads are NOT counted as openings. */
const invoices = [];
const paidAmounts = new Map();          // invoiceId → paidAmount, as BTCPay reports it
const btcpayStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    const reply = obj => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const read = /\/invoices\/([^/?]+)/.exec(req.url);
    if (req.method === 'GET' && read) {
      const id = decodeURIComponent(read[1]);
      return reply({
        id, status: 'Expired', checkoutLink: `https://pay.test/i/${id}`,
        paidAmount: paidAmounts.has(id) ? paidAmounts.get(id) : '0'
      });
    }
    const payload = JSON.parse(raw || '{}');
    invoices.push({ url: req.url, auth: req.headers.authorization, payload });
    const id = 'inv-' + invoices.length;
    reply({ id, checkoutLink: `https://pay.test/i/${id}`, status: 'New' });
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

/* The one account in ADMIN_EMAILS. Registered on first use, signed in after. */
let _admin = null;
async function admin() {
  if (_admin) return _admin;
  const creds = { email: 'boss-crypto@example.com', password: 'password123' };
  const r = await api('/api/auth/register', {
    method: 'POST', body: { firstName: 'Boss', lastName: 'Admin', ...creds }
  });
  const got = r.status === 201 ? r.body : (await api('/api/auth/login', { method: 'POST', body: creds })).body;
  assert.ok(got && got.user && got.user.isAdmin, 'the admin account has admin powers');
  _admin = got;
  return _admin;
}

/* Every order now needs the web order authorization the checkout page collects
   (Terms §12). Tests place real orders, so they carry a real one. */
const WEB_AUTH = {
  accepted: true,
  version: '2026-08-14',
  acceptedAt: new Date().toISOString(),
  text: 'I authorize this order.'
};

const SHIPPING = {
  name: 'Jane Doe', address: '123 Science Park Dr',
  city: 'Boston', state: 'MA', postalCode: '02115', countryCode: 'US',
  institution: 'Acme Research Lab', researchField: 'Peptide Chemistry'
};

/* The token in a pay link, derived the same way the server derives it: an
   HMAC of the order reference under the server secret. Computed here rather
   than read back from the API, so a test can assert that a link the server
   never handed out still opens the right order — and only that order. */
function payTokenOf(orderId) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update('pay:' + orderId).digest('hex').slice(0, 32);
}

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
      webAuthorization: WEB_AUTH,
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

/* ============================================================
   Web order authorization (Terms §12)
   The tick-box above the pay buttons is the buyer's signature for the
   transaction. A form can be bypassed, so the requirement is enforced here —
   and what they agreed to is kept with the order, because that record is the
   whole answer to "I never authorized this".
   ============================================================ */
test('an order cannot be opened without the web order authorization', async () => {
  const b = await buyer();
  const before = invoices.length;

  for (const bad of [undefined, null, {}, { accepted: false }, { accepted: 'yes' }, 'true']) {
    const res = await api('/api/crypto/checkout', {
      method: 'POST', token: b.token,
      body: { items: [{ id: productId, quantity: 1 }], shipping: SHIPPING, webAuthorization: bad }
    });
    assert.equal(res.status, 400, `rejected: ${JSON.stringify(bad)}`);
    assert.match(res.body.error, /authoriz/i, 'and says why');
  }
  assert.equal(invoices.length, before, 'no invoice was opened for an unauthorized order');
});

test('the authorization is stored with the order, with the wording that was shown', async () => {
  const b = await buyer();
  const res = await openOrder(b.token);
  const mine = store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId);

  const wa = mine.webAuthorization;
  assert.ok(wa, 'the order carries an authorization record');
  assert.equal(wa.accepted, true);
  assert.equal(wa.version, WEB_AUTH.version, 'the version of the wording is kept');
  assert.equal(wa.text, WEB_AUTH.text, 'so is the wording itself');
  assert.ok(!isNaN(new Date(wa.acceptedAt).getTime()), 'agreed at a real time');
  assert.ok(!isNaN(new Date(wa.recordedAt).getTime()), 'and our own arrival stamp');
});

/* A timestamp is the buyer's word; ours is the one we can stand behind. A
   nonsense acceptedAt must not put a junk date in the audit trail. */
test('a bogus acceptance timestamp is replaced, not stored', async () => {
  const b = await buyer();
  const res = await openOrder(b.token, { webAuthorization: { ...WEB_AUTH, acceptedAt: 'whenever' } });
  assert.equal(res.status, 201);
  const mine = store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId);
  assert.ok(!isNaN(new Date(mine.webAuthorization.acceptedAt).getTime()), 'a real date was stored instead');
});

/* Every message after checkout — receipt, expiry notice, "you paid short" — is
   addressed from the stored order, so a blank email there is a buyer who can
   never be contacted again about their own order. */
test('the order always carries an address to write to, even with no email at checkout', async () => {
  const b = await buyer();
  const res = await api('/api/crypto/checkout', {
    method: 'POST', token: b.token,
    body: { items: [{ id: productId, quantity: 1 }], shipping: SHIPPING, webAuthorization: WEB_AUTH }   // no email field
  });
  assert.equal(res.status, 201);
  const mine = store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId);
  assert.equal(mine.email, b.user.email, 'it falls back to the account address');
  assert.equal(invoices[invoices.length - 1].payload.metadata.buyerEmail, b.user.email,
    'and BTCPay is told the same address');
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
   2b) An expired invoice with money against it is NOT a write-off
   BTCPay expires an underpaid (or late-paid) invoice, and those coins
   are already in the wallet. Cancelling that silently is how a paying
   customer ends up with nothing and nobody is told, so the order is
   parked as `underpaid` with its stock and points still held.
   ============================================================ */
test('an underpaid expiry parks the order instead of cancelling it', async () => {
  const b = await buyer();
  loyalty.earn(b.user.id, 1000, 'test seed', {});
  const res = await openOrder(b.token, { pointsToRedeem: 500 });
  const held = res.body.pointsRedeemed;
  assert.ok(held > 0, 'points were held against the invoice');
  const afterHold = loyalty.getBalance(b.user.id);

  // The stub answers getInvoice with a partial paidAmount for this id.
  paidAmounts.set(res.body.invoiceId, '12.34');
  const evt = JSON.stringify({
    type: 'InvoiceExpired', invoiceId: res.body.invoiceId,
    partiallyPaid: true, metadata: { orderId: res.body.orderId }
  });

  const ok = await webhook(evt);
  assert.equal(ok.status, 200);

  const mine = store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId);
  assert.equal(mine.status, 'underpaid', 'money arrived, so the order is not written off');
  assert.equal(mine.paidAmount, 12.34, 'what actually landed is recorded on the order');
  assert.equal(loyalty.getBalance(b.user.id), afterHold,
    'the points stay held — releasing them would let the buyer spend a discount we already gave');

  // A redelivery must not turn the parked order into a cancellation.
  await webhook(evt);
  assert.equal(
    store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId).status, 'underpaid',
    'a repeat delivery leaves the decision with the human'
  );

  // …and admin can still settle it either way. Marking it paid is the "buyer
  // sent the rest / we accept the shortfall" route out.
  const boss = await admin();
  const paidRes = await api('/api/admin/orders/' + res.body.orderId + '/paid', {
    method: 'POST', token: boss.token, body: { paymentRef: 'topped up' }
  });
  assert.equal(paidRes.status, 200);
  assert.equal(
    store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId).status, 'paid',
    'an underpaid order can still be released by hand'
  );
});

/* ============================================================
   2b) …and the buyer can settle it themselves
   A short payment used to be a dead end: the invoice they underpaid is
   expired, BTCPay won't reopen it, and the only way out was an email
   thread with a human. The order now carries a signed link that raises a
   fresh invoice for exactly the difference, and a payment against that
   link finishes the order without anyone touching admin.
   ============================================================ */
async function shortPay(amountPaid) {
  const b = await buyer();
  const res = await openOrder(b.token);
  paidAmounts.set(res.body.invoiceId, String(amountPaid));
  await webhook(JSON.stringify({
    type: 'InvoiceExpired', invoiceId: res.body.invoiceId,
    partiallyPaid: true, metadata: { orderId: res.body.orderId }
  }));
  const order = store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId);
  assert.equal(order.status, 'underpaid');
  return { b, res, order };
}

/* The pay link is the credential. It has to work for someone who isn't signed
   in — and it must not work for someone holding a different order's link. */
test('the short-paid order carries a pay link, and only its own token opens it', async () => {
  const { b, res, order } = await shortPay('30.00');

  const mine = (await api('/api/orders', { token: b.token })).body.orders
    .find(o => o.orderId === res.body.orderId);
  assert.ok(mine.payUrl, 'the account page is handed a link to finish paying');
  assert.equal(mine.amountDue, Number((order.total - 30).toFixed(2)), 'and the amount still owed');

  const t = new URL(mine.payUrl).searchParams.get('t');
  const bal = await api(`/api/orders/${res.body.orderId}/balance?t=${t}`);
  assert.equal(bal.status, 200);
  assert.equal(bal.body.paid, 30, 'what they already sent is counted, not forgotten');
  assert.equal(bal.body.due, mine.amountDue);
  assert.equal(bal.body.payable, true);

  // Signed for THIS order only.
  const forged = await api(`/api/orders/${res.body.orderId}/balance?t=${'0'.repeat(32)}`);
  assert.equal(forged.status, 404, 'a made-up token opens nothing');

  const other = await shortPay('10.00');
  const otherUrl = (await api('/api/orders', { token: other.b.token })).body.orders
    .find(o => o.orderId === other.res.body.orderId).payUrl;
  const crossed = await api(`/api/orders/${res.body.orderId}/balance?t=` +
    new URL(otherUrl).searchParams.get('t'));
  assert.equal(crossed.status, 404, "another order's token doesn't unlock this one");
});

test('the balance invoice is raised for the shortfall, not the whole order again', async () => {
  const { res, order } = await shortPay('40.00');
  const due = Number((order.total - 40).toFixed(2));

  const before = invoices.length;
  const made = await api(`/api/orders/${res.body.orderId}/balance/invoice`, {
    method: 'POST', body: { t: payTokenOf(res.body.orderId) }
  });
  assert.equal(made.status, 200);
  assert.equal(made.body.due, due);
  assert.equal(invoices.length, before + 1, 'exactly one new invoice');
  const raised = invoices[invoices.length - 1].payload;
  assert.equal(raised.amount, due.toFixed(2), 'billed for the difference only');
  assert.equal(raised.metadata.kind, 'balance', 'tagged so the webhook can tell it apart');
  assert.equal(raised.metadata.orderId, res.body.orderId);

  // A second press inside the reuse window returns the same invoice rather
  // than littering BTCPay with abandoned ones.
  const again = await api(`/api/orders/${res.body.orderId}/balance/invoice`, {
    method: 'POST', body: { t: payTokenOf(res.body.orderId) }
  });
  assert.equal(again.body.checkoutLink, made.body.checkoutLink);
  assert.equal(invoices.length, before + 1, 'no second invoice for a double-tap');
});

test('paying the balance settles the order, with both payments counted', async () => {
  const { b, res, order } = await shortPay('50.00');
  const made = await api(`/api/orders/${res.body.orderId}/balance/invoice`, {
    method: 'POST', body: { t: payTokenOf(res.body.orderId) }
  });

  const ok = await webhook(JSON.stringify({
    type: 'InvoiceSettled', invoiceId: made.body.invoiceId,
    metadata: { orderId: res.body.orderId, kind: 'balance' }
  }));
  assert.equal(ok.status, 200);

  const done = store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId);
  assert.equal(done.status, 'paid', 'the top-up finishes the order with no admin involved');
  assert.equal(done.paidAmount, order.total, 'both payments add up to the total');
  assert.equal(done.invoiceId, res.body.invoiceId, 'the original invoice reference survives');
  assert.equal(done.balanceInvoiceId, made.body.invoiceId, 'and the top-up is recorded alongside it');
});

test('a balance invoice that is itself underpaid adds up instead of overwriting', async () => {
  const { b, res, order } = await shortPay('20.00');
  const made = await api(`/api/orders/${res.body.orderId}/balance/invoice`, {
    method: 'POST', body: { t: payTokenOf(res.body.orderId) }
  });
  paidAmounts.set(made.body.invoiceId, '15.00');          // short again

  await webhook(JSON.stringify({
    type: 'InvoiceExpired', invoiceId: made.body.invoiceId,
    partiallyPaid: true, metadata: { orderId: res.body.orderId, kind: 'balance' }
  }));

  const after = store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId);
  assert.equal(after.status, 'underpaid', 'still short, so still parked');
  assert.equal(after.paidAmount, 35, 'the second partial is ADDED to the first, not swapped for it');
  const bal = await api(`/api/orders/${res.body.orderId}/balance?t=${payTokenOf(res.body.orderId)}`);
  assert.equal(bal.body.due, Number((order.total - 35).toFixed(2)));
});

test('nothing can be billed twice: a paid or cancelled order refuses a balance invoice', async () => {
  const { res } = await shortPay('25.00');
  const boss = await admin();
  await api('/api/admin/orders/' + res.body.orderId + '/paid', { method: 'POST', token: boss.token });

  const nope = await api(`/api/orders/${res.body.orderId}/balance/invoice`, {
    method: 'POST', body: { t: payTokenOf(res.body.orderId) }
  });
  assert.equal(nope.status, 409, 'an order that is paid owes nothing');

  const bal = await api(`/api/orders/${res.body.orderId}/balance?t=${payTokenOf(res.body.orderId)}`);
  assert.equal(bal.body.payable, false, 'and the pay page says so rather than offering a button');
});

test('an unreadable partial payment is never turned into a bill', async () => {
  const b = await buyer();
  const res = await openOrder(b.token);
  // No invoiceId → the amount cannot be looked up. Billing the full total here
  // would charge them a second time for money already sent.
  await webhook(JSON.stringify({
    type: 'InvoiceExpired', partiallyPaid: true, metadata: { orderId: res.body.orderId }
  }));

  const mine = (await api('/api/orders', { token: b.token })).body.orders
    .find(o => o.orderId === res.body.orderId);
  assert.equal(mine.status, 'underpaid');
  assert.equal(mine.payUrl, undefined, 'no self-serve link when the balance is unknowable');

  const bal = await api(`/api/orders/${res.body.orderId}/balance?t=${payTokenOf(res.body.orderId)}`);
  assert.equal(bal.body.payable, false);
  const nope = await api(`/api/orders/${res.body.orderId}/balance/invoice`, {
    method: 'POST', body: { t: payTokenOf(res.body.orderId) }
  });
  assert.equal(nope.status, 409);
});

test('only an admin can email a pay link, and only for a collectable balance', async () => {
  const { b, res } = await shortPay('60.00');
  const boss = await admin();

  const asBuyer = await api('/api/admin/orders/' + res.body.orderId + '/pay-link', {
    method: 'POST', token: b.token
  });
  assert.equal(asBuyer.status, 401, 'a customer cannot drive the admin endpoint');

  const sent = await api('/api/admin/orders/' + res.body.orderId + '/pay-link', {
    method: 'POST', token: boss.token
  });
  assert.equal(sent.status, 200);
  assert.ok(sent.body.payUrl.includes(res.body.orderId), 'the link names the order it settles');
  assert.equal(sent.body.due, sent.body.due);

  // …and refuses an order with nothing outstanding.
  const clean = await openOrder(b.token);
  const refused = await api('/api/admin/orders/' + clean.body.orderId + '/pay-link', {
    method: 'POST', token: boss.token
  });
  assert.equal(refused.status, 400);
});

/* An order released by hand before anyone noticed the payment was short is the
   worst version of this bug: the store and BTCPay stop disagreeing, so nothing
   automatic will ever look at it again, and the goods ship for part of the
   price. The correction has to be able to reverse a `paid`. */
test('an order wrongly marked paid on a partial payment can be re-opened and collected', async () => {
  const { b, res, order } = await shortPay('36.80');
  const boss = await admin();
  await api('/api/admin/orders/' + res.body.orderId + '/paid', { method: 'POST', token: boss.token });
  const find = () => store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId);
  assert.equal(find().status, 'paid', 'released by hand, shortfall unnoticed');

  const due = Number((order.total - 36.8).toFixed(2));
  const fix = await api('/api/admin/orders/' + res.body.orderId + '/collect-balance', {
    method: 'POST', token: boss.token, body: { received: 36.8 }
  });
  assert.equal(fix.status, 200);
  assert.equal(fix.body.due, due);
  assert.equal(find().status, 'underpaid', 'a paid order that was never paid goes back to short');

  // The buyer's own page now offers the way out…
  const mine = (await api('/api/orders', { token: b.token })).body.orders
    .find(o => o.orderId === res.body.orderId);
  assert.equal(mine.amountDue, due);

  // …and paying it finishes the order for good.
  const made = await api(`/api/orders/${res.body.orderId}/balance/invoice`, {
    method: 'POST', body: { t: payTokenOf(res.body.orderId) }
  });
  assert.equal(made.body.due, due);
  await webhook(JSON.stringify({
    type: 'InvoiceSettled', invoiceId: made.body.invoiceId,
    metadata: { orderId: res.body.orderId, kind: 'balance' }
  }));
  assert.equal(find().status, 'paid');
  assert.equal(find().paidAmount, order.total);
});

test('a shipped order is never re-opened, and a full payment is not "short"', async () => {
  const { res, order } = await shortPay('12.00');
  const boss = await admin();
  const collect = (body) => api('/api/admin/orders/' + res.body.orderId + '/collect-balance', {
    method: 'POST', token: boss.token, body
  });

  assert.equal((await collect({ received: order.total })).status, 400,
    'nothing outstanding is not a balance to collect');
  assert.equal((await collect({ received: 'lots' })).status, 400, 'an unreadable amount is refused');

  await api('/api/admin/orders/' + res.body.orderId + '/paid', { method: 'POST', token: boss.token });
  await api('/api/admin/orders/' + res.body.orderId + '/shipped', {
    method: 'POST', token: boss.token, body: { carrier: 'USPS', tracking: '94001' }
  });
  assert.equal((await collect({ received: 12 })).status, 400,
    'a parcel that has already gone does not go back in the queue');
});

/* ============================================================
   2c) The invoice window itself
   Every dead order in the store's first month died the same way: BTCPay's
   default 15-minute window closed while the buyer was still moving coin,
   and whatever had arrived was banked as a partial. The window and the
   dust tolerance are set on every invoice we raise, so they can't be lost
   to someone forgetting a store setting.
   ============================================================ */
test('invoices are raised with a real payment window and a dust tolerance', async () => {
  const b = await buyer();
  await openOrder(b.token);
  const checkout = invoices[invoices.length - 1].payload.checkout;
  assert.ok(checkout.expirationMinutes >= 30, 'a buyer gets long enough to actually pay');
  assert.ok(checkout.monitoringMinutes >= checkout.expirationMinutes,
    'a late payment is still seen after the window closes');
  assert.ok(checkout.paymentTolerance > 0 && checkout.paymentTolerance <= 5,
    'wallet-fee dust settles instead of parking a real order');
});

test('an expiry with nothing paid still cancels, and the paid amount is read from BTCPay', async () => {
  const b = await buyer();
  const res = await openOrder(b.token);
  paidAmounts.set(res.body.invoiceId, '0');       // BTCPay says: nothing landed

  const ok = await webhook(JSON.stringify({
    type: 'InvoiceExpired', invoiceId: res.body.invoiceId, metadata: { orderId: res.body.orderId }
  }));
  assert.equal(ok.status, 200);
  assert.equal(
    store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId).status, 'cancelled',
    'an abandoned checkout is still released'
  );
});

test('a partial-payment flag with no readable amount is parked, not cancelled', async () => {
  const b = await buyer();
  const res = await openOrder(b.token);
  // No invoiceId on the event → the amount cannot be looked up. The flag alone
  // has to be enough, because writing off a paid order is the costly mistake.
  const ok = await webhook(JSON.stringify({
    type: 'InvoiceExpired', partiallyPaid: true, metadata: { orderId: res.body.orderId }
  }));
  assert.equal(ok.status, 200);
  const mine = store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId);
  assert.equal(mine.status, 'underpaid', 'unknown-but-partial is still a human decision');
  assert.equal(mine.paidAmount, undefined, 'no amount is invented');
});

/* ============================================================
   2c) Fulfilment — only a paid order ships
   The last step of a sale, and the only one with no automation behind it.
   Shipping goods against an order that isn't paid is the expensive
   mistake, so the endpoint refuses everything except `paid`.
   ============================================================ */
test('only a paid order can be marked shipped', async () => {
  const b = await buyer();
  const boss = await admin();
  const res = await openOrder(b.token);
  const ship = () => api('/api/admin/orders/' + res.body.orderId + '/shipped', {
    method: 'POST', token: boss.token, body: { carrier: 'USPS', tracking: '9400111' }
  });

  const tooEarly = await ship();
  assert.equal(tooEarly.status, 400, 'a pending order cannot ship');
  assert.match(tooEarly.body.error, /not paid/i);

  // Underpaid is refused with its own reason: the house rule is full payment.
  paidAmounts.set(res.body.invoiceId, '5.00');
  await webhook(JSON.stringify({
    type: 'InvoiceExpired', invoiceId: res.body.invoiceId,
    partiallyPaid: true, metadata: { orderId: res.body.orderId }
  }));
  const shortPaid = await ship();
  assert.equal(shortPaid.status, 400, 'a short-paid order cannot ship either');
  assert.match(shortPaid.body.error, /full amount/i);

  // Pay it in full, and it goes out.
  await api('/api/admin/orders/' + res.body.orderId + '/paid', { method: 'POST', token: boss.token });
  const ok = await ship();
  assert.equal(ok.status, 200);
  assert.equal(ok.body.alreadyShipped, false);

  const mine = store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId);
  assert.equal(mine.status, 'shipped');
  assert.equal(mine.carrier, 'USPS');
  assert.equal(mine.tracking, '9400111');
  assert.ok(mine.shippedAt, 'the send date is recorded');

  // Re-posting corrects a mistyped number without re-announcing the shipment.
  const again = await api('/api/admin/orders/' + res.body.orderId + '/shipped', {
    method: 'POST', token: boss.token, body: { carrier: 'USPS', tracking: '9400222' }
  });
  assert.equal(again.body.alreadyShipped, true, 'a second post is an edit, not a new shipment');
  assert.equal(
    store.listOrders(b.user.id).find(o => o.orderId === res.body.orderId).tracking, '9400222',
    'the tracking number was corrected'
  );
});

test('an ordinary customer cannot mark their own order shipped', async () => {
  const b = await buyer();
  const res = await openOrder(b.token);
  const mine = await api('/api/admin/orders/' + res.body.orderId + '/shipped', {
    method: 'POST', token: b.token, body: {}
  });
  assert.equal(mine.status, 401, 'fulfilment is an admin action');
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
