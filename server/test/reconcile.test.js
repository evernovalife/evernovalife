/* ============================================================
   EVER NOVA LIFE — rebuilding an order's payment ledger from BTCPay

   The bug this covers, seen in production: an order goes short, the
   shortfall is never written down, and the SECOND invoice raised for
   that order therefore asks for the FULL total instead of the
   difference. Two live invoices, each demanding everything, and the
   buyer has paid part of each. The order's flat `paidAmount` holds
   whichever webhook landed last, so the store believes the buyer sent
   less than they did — and the pay-the-balance link bills them for
   coins already in the wallet.

   POST /api/admin/orders/:orderId/reconcile fixes that by asking the
   payment processor instead of trusting the stored figure: every
   invoice tagged with the order is read, and what settled on each is
   written into `payments` keyed by invoice id, which is the shape
   `paidSoFar` already sums.

   What is pinned here:
     · two partial payments across two invoices ADD UP
     · a dry run reports the correction without making it
     · an invoice whose amount can't be read blocks the commit, because
       understating the total re-bills a paying customer
     · force books the readable floor when the owner accepts that
     · an invoice belonging to another order is never credited here
     · reconciling up to the full total pays the order and credits
       loyalty points exactly once
     · a shipped order has its ledger corrected but not its status
     · this is admin-only

   A stub BTCPay stands in for the real gateway — richer than the one
   in crypto.test.js because this endpoint reads the per-method detail
   (crypto received + the rate it was locked at), which is where the
   authoritative fiat figure actually comes from.

       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- environment BEFORE anything is required ----
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-reconcile-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-reconcile';
process.env.ALLOWED_ORIGINS = '*';
process.env.BTCPAY_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.SUBSCRIPTION_INPROCESS_CRON = '0';
process.env.SITE_URL = 'https://evernovalife.com';
process.env.ADMIN_EMAILS = 'boss-reconcile@example.com';
delete process.env.ADMIN_KEY;

const STORE_ID = 'test-store';
const RATE = 63770.50;                     // USD per BTC, as BTCPay locks it

/* ---- the stub gateway ----
   Holds full invoice records so the endpoint under test can read what it
   reads in production: the store's invoice list, one invoice, and that
   invoice's per-method payment detail. */
const inv = new Map();
let _n = 0;

function addInvoice({ orderId, amount, paidFiat, status = 'Expired', kind = 'order', currency = 'USD', readable = true }) {
  const id = 'inv-' + (++_n);
  inv.set(id, { id, orderId, amount, paidFiat, status, kind, currency, readable });
  return id;
}

const btcpayStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    const reply = obj => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const shape = r => ({
      id: r.id,
      status: r.status,
      amount: String(r.amount),
      currency: r.currency,
      checkoutLink: `https://pay.test/i/${r.id}`,
      metadata: { orderId: r.orderId, kind: r.kind }
    });

    const url = req.url.split('?')[0];

    // per-method detail — matched before the plain invoice route
    const meth = new RegExp(`/stores/${STORE_ID}/invoices/([^/]+)/payment-methods$`).exec(url);
    if (req.method === 'GET' && meth) {
      const r = inv.get(decodeURIComponent(meth[1]));
      if (!r) { res.writeHead(404); return res.end('{}'); }
      /* `readable: false` reproduces the invoice BTCPay says took money but
         reports no rate for — the case that must block a commit. */
      return reply([{
        paymentMethodId: 'BTC-CHAIN',
        rate: r.readable ? String(RATE) : null,
        totalPaid: String(r.paidFiat / RATE),
        amount: String(r.amount / RATE),
        due: String(Math.max(0, r.amount - r.paidFiat) / RATE)
      }]);
    }

    const one = new RegExp(`/stores/${STORE_ID}/invoices/([^/]+)$`).exec(url);
    if (req.method === 'GET' && one) {
      const r = inv.get(decodeURIComponent(one[1]));
      if (!r) { res.writeHead(404); return res.end('{}'); }
      return reply(shape(r));
    }

    if (req.method === 'GET' && url.endsWith(`/stores/${STORE_ID}/invoices`)) {
      return reply([...inv.values()].map(shape));
    }

    // POST /invoices — checkout opening one for real
    const payload = JSON.parse(raw || '{}');
    const meta = payload.metadata || {};
    const id = addInvoice({
      orderId: meta.orderId || '',
      amount: Number(payload.amount) || 0,
      paidFiat: 0,
      status: 'New',
      kind: meta.kind || 'order'
    });
    reply({ id, checkoutLink: `https://pay.test/i/${id}`, status: 'New' });
  });
});

let app, store, loyalty;
let server, base, productId;

test.before(async () => {
  btcpayStub.listen(0, '127.0.0.1');
  await once(btcpayStub, 'listening');
  process.env.BTCPAY_URL = `http://127.0.0.1:${btcpayStub.address().port}`;
  process.env.BTCPAY_API_KEY = 'test-key';
  process.env.BTCPAY_STORE_ID = STORE_ID;

  app = require('../server.js');
  store = require('../store.js');
  loyalty = require('../loyalty.js');

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
    method, headers: h,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* no JSON body */ }
  return { status: res.status, body: parsed };
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

let _seq = 0;
async function buyer() {
  const email = `reconcile-buyer-${++_seq}@example.com`;
  const r = await api('/api/auth/register', {
    method: 'POST', body: { firstName: 'Test', lastName: 'User', email, password: 'password123' }
  });
  assert.ok(r.body && r.body.token, 'buyer registered');
  return r.body;
}

let _admin = null;
async function admin() {
  if (_admin) return _admin;
  const creds = { email: 'boss-reconcile@example.com', password: 'password123' };
  const r = await api('/api/auth/register', {
    method: 'POST', body: { firstName: 'Boss', lastName: 'Admin', ...creds }
  });
  const got = r.status === 201 ? r.body : (await api('/api/auth/login', { method: 'POST', body: creds })).body;
  assert.ok(got && got.user && got.user.isAdmin, 'the admin account has admin powers');
  _admin = got;
  return _admin;
}

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* The token on the permanent pay link — an HMAC of the reference, so it can be
   recomputed here without the server handing one out. */
function payToken(orderId) {
  return require('node:crypto')
    .createHmac('sha256', process.env.JWT_SECRET)
    .update('pay:' + orderId).digest('hex').slice(0, 32);
}

/* Reproduce the production shape: one order, TWO invoices each billed the
   full total, part paid on each, and a stored figure that knows about only
   the later one — with no `payments` ledger at all, exactly like an order
   written before the ledger existed. */
async function doubleBilledOrder({ fracA = 0.4, fracB = 0.45, readableB = true } = {}) {
  const b = await buyer();
  const res = await api('/api/crypto/checkout', {
    method: 'POST', token: b.token,
    body: { items: [{ id: productId, quantity: 1 }], shipping: SHIPPING, email: 'buyer@example.com', webAuthorization: WEB_AUTH }
  });
  assert.ok(res.status === 200 || res.status === 201, 'checkout opened');
  const orderId = res.body.orderId;

  const order = store.listAllOrders().find(o => o.orderId === orderId);
  const total = round2(order.total);
  const paidA = round2(total * fracA);
  const paidB = round2(total * fracB);

  // the invoice checkout just opened is the first one; book a partial on it
  const first = [...inv.values()].find(r => r.orderId === orderId);
  first.paidFiat = paidA;
  first.status = 'Expired';

  // the duplicate: billed the FULL total again, part paid
  addInvoice({ orderId, amount: total, paidFiat: paidB, status: 'Expired', readable: readableB });

  // the broken stored state: only the later payment, no ledger
  store.updateOrderStatus(orderId, 'underpaid', {
    payments: null,
    paidAmount: paidB,
    paidAmountUnknown: false,
    underpaidAt: new Date().toISOString()
  });

  return { buyer: b, orderId, total, paidA, paidB, invoiceA: first.id };
}

/* ============================================================
   The core repair
   ============================================================ */

test('two partial payments across two invoices add up', async () => {
  const a = await admin();
  const { orderId, total, paidA, paidB } = await doubleBilledOrder();

  const before = store.listAllOrders().find(o => o.orderId === orderId);
  assert.equal(round2(before.paidAmount), paidB, 'the store starts out knowing only the later payment');

  const r = await api(`/api/admin/orders/${orderId}/reconcile`, { method: 'POST', token: a.token, body: {} });
  assert.equal(r.status, 200, 'reconcile succeeded');

  const expected = round2(paidA + paidB);
  assert.equal(r.body.paid, expected, 'both payments are counted');
  assert.equal(r.body.due, round2(total - expected), 'the balance is what is really left');
  assert.equal(r.body.invoices.length, 2, 'both invoices were found and read');

  const after = store.listAllOrders().find(o => o.orderId === orderId);
  assert.equal(round2(after.paidAmount), expected, 'the corrected total is stored');
  assert.equal(Object.keys(after.payments).length, 2, 'the ledger is keyed per invoice');
  assert.equal(after.status, 'underpaid', 'still short, so still parked');
});

test('the balance link now bills the real remainder, not the last invoice', async () => {
  const a = await admin();
  const { orderId, total, paidA, paidB } = await doubleBilledOrder();
  await api(`/api/admin/orders/${orderId}/reconcile`, { method: 'POST', token: a.token, body: {} });

  const r = await api(`/api/orders/${orderId}/balance?t=${payToken(orderId)}`, { method: 'GET' });
  assert.equal(r.status, 200);
  assert.equal(r.body.due, round2(total - round2(paidA + paidB)),
    'the buyer is asked for the shortfall across BOTH invoices');
});

test('a dry run reports the correction without making it', async () => {
  const a = await admin();
  const { orderId, paidA, paidB } = await doubleBilledOrder();

  const r = await api(`/api/admin/orders/${orderId}/reconcile`, {
    method: 'POST', token: a.token, body: { dryRun: true }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.paid, round2(paidA + paidB), 'it reports what the fix would be');

  const after = store.listAllOrders().find(o => o.orderId === orderId);
  assert.equal(round2(after.paidAmount), paidB, 'but nothing was written');
  assert.ok(!after.payments, 'and no ledger was created');
});

/* ============================================================
   Refusing to understate what a buyer sent
   ============================================================ */

test('an unreadable invoice blocks the commit rather than under-counting', async () => {
  const a = await admin();
  const { orderId, paidB } = await doubleBilledOrder({ readableB: false });

  const r = await api(`/api/admin/orders/${orderId}/reconcile`, { method: 'POST', token: a.token, body: {} });
  assert.equal(r.status, 409, 'a partial read is a conflict, not a silent success');
  assert.equal(r.body.unreadable, 1);
  assert.match(r.body.error, /could not be read/i);

  const after = store.listAllOrders().find(o => o.orderId === orderId);
  assert.equal(round2(after.paidAmount), paidB, 'the order was left exactly as it was');
});

test('force books the readable floor when the owner accepts it', async () => {
  const a = await admin();
  const { orderId, paidA } = await doubleBilledOrder({ readableB: false });

  const r = await api(`/api/admin/orders/${orderId}/reconcile`, {
    method: 'POST', token: a.token, body: { force: true }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.paid, paidA, 'only what could actually be read is booked');

  const after = store.listAllOrders().find(o => o.orderId === orderId);
  assert.equal(round2(after.paidAmount), paidA);
});

test("another order's invoice is never credited here", async () => {
  const a = await admin();
  const mine = await doubleBilledOrder();
  const theirs = await doubleBilledOrder();

  const r = await api(`/api/admin/orders/${mine.orderId}/reconcile`, {
    method: 'POST', token: a.token, body: { invoiceIds: [mine.invoiceA, theirs.invoiceA] }
  });
  assert.equal(r.status, 400, 'refused outright');
  assert.equal(r.body.foreign.length, 1);
  assert.equal(r.body.foreign[0].orderId, theirs.orderId, 'and it names the order the coins belong to');
});

/* ============================================================
   Reaching the total
   ============================================================ */

test('reconciling up to the full total pays the order and credits points once', async () => {
  const a = await admin();
  const { buyer: b, orderId, total, paidA } = await doubleBilledOrder({ fracB: 0.2 });

  // the buyer finishes paying: top the duplicate up to cover the rest
  const dup = [...inv.values()].filter(r => r.orderId === orderId).pop();
  dup.paidFiat = round2(total - paidA);
  dup.status = 'Settled';

  const r = await api(`/api/admin/orders/${orderId}/reconcile`, { method: 'POST', token: a.token, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.due, 0, 'nothing is owed');
  assert.equal(r.body.after.status, 'paid');

  const earned = (await api('/api/loyalty', { token: b.token })).body.balance;

  // running it again must not pay the buyer twice
  const again = await api(`/api/admin/orders/${orderId}/reconcile`, { method: 'POST', token: a.token, body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.body.after.status, 'paid');
  assert.equal((await api('/api/loyalty', { token: b.token })).body.balance, earned,
    'points are credited on the first move to paid only');
});

test('a shipped order has its ledger corrected but not its status', async () => {
  const a = await admin();
  const { orderId, paidA, paidB } = await doubleBilledOrder();
  store.updateOrderStatus(orderId, 'shipped', {});

  const r = await api(`/api/admin/orders/${orderId}/reconcile`, { method: 'POST', token: a.token, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.frozen, true);
  assert.equal(r.body.paid, round2(paidA + paidB), 'the money is still recorded correctly');
  assert.equal(r.body.after.status, 'shipped', 'a parcel already gone is not put back in the queue');
});

/* ============================================================
   Guards
   ============================================================ */

test('an ordinary customer cannot reconcile their own order', async () => {
  const { buyer: b, orderId } = await doubleBilledOrder();
  const r = await api(`/api/admin/orders/${orderId}/reconcile`, { method: 'POST', token: b.token, body: {} });
  assert.ok(r.status === 401 || r.status === 403, 'admin only');
});

test('reconciling an unknown reference is a 404', async () => {
  const a = await admin();
  const r = await api('/api/admin/orders/ENL-NOPE/reconcile', { method: 'POST', token: a.token, body: {} });
  assert.equal(r.status, 404);
});
