/* ============================================================
   EVER NOVA LIFE — the admin sign-in summary
   One small endpoint answering "is anything waiting for me?", so the
   owner learns about a waiting customer at sign-in instead of having
   to open the console and look. Counts only — the storefront page that
   renders this has no business holding order or customer records.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-summary-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-summary';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
delete process.env.ADMIN_KEY;

const app = require('../server.js');
const store = require('../store.js');
const disputes = require('../disputes.js');

let server, base;

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
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
  try { parsed = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

async function signUp(email) {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'T', lastName: 'U', email, password: 'password123' }
  });
  return { token: r.body.token, user: r.body.user };
}
async function adminToken() {
  const r = await api('/api/auth/login', { method: 'POST', body: { email: 'boss@evernovalife.com', password: 'password123' } });
  if (r.body && r.body.token) return r.body.token;
  return (await signUp('boss@evernovalife.com')).token;
}

test('anonymous and non-admin callers are refused', async () => {
  assert.equal((await api('/api/admin/summary')).status, 401);
  const mallory = await signUp('mallory-s@example.com');
  assert.equal((await api('/api/admin/summary', { token: mallory.token })).status, 401);
});

test('a quiet shop reports zeros and says so', async () => {
  const token = await adminToken();
  const { status, body } = await api('/api/admin/summary', { token });
  assert.equal(status, 200);
  assert.equal(body.disputes, 0);
  assert.equal(body.unpaidOrders, 0);
  assert.equal(body.toShip, 0);
  assert.equal(body.lowStock, 0);
  /* The client shows nothing at all when this is false, so it has to be
     computed here rather than inferred from five separate numbers. */
  assert.equal(body.anythingWaiting, false);
});

test('an unpaid order and a paid-but-unshipped one land in different counts', async () => {
  const ida = await signUp('ida-s@example.com');
  store.addOrder(ida.user.id, {
    orderId: 'ENL-S-UNPAID', status: 'awaiting_payment', total: 40, method: 'zelle',
    createdAt: new Date().toISOString(), items: []
  });
  store.addOrder(ida.user.id, {
    orderId: 'ENL-S-PAID', status: 'paid', total: 60, method: 'crypto',
    createdAt: new Date().toISOString(), items: []
  });

  const token = await adminToken();
  const { body } = await api('/api/admin/summary', { token });
  assert.equal(body.unpaidOrders, 1);
  assert.equal(body.toShip, 1);
  assert.equal(body.anythingWaiting, true);
});

test('a sandbox order from the card era is counted in neither', async () => {
  const jon = await signUp('jon-s@example.com');
  // method 'card' means the pre-2026-08 gateway that never took real money.
  store.addOrder(jon.user.id, {
    orderId: 'ENL-S-CARD1', status: 'awaiting_payment', total: 10, method: 'card',
    createdAt: new Date().toISOString(), items: []
  });
  store.addOrder(jon.user.id, {
    orderId: 'ENL-S-CARD2', status: 'paid', total: 10, method: 'card',
    createdAt: new Date().toISOString(), items: []
  });

  const token = await adminToken();
  const { body } = await api('/api/admin/summary', { token });
  assert.equal(body.unpaidOrders, 1, 'still just the one real unpaid order');
  assert.equal(body.toShip, 1, 'still just the one real parcel to pack');
});

test('only threads where the customer spoke last count as waiting on us', async () => {
  const kim = await signUp('kim-s@example.com');
  store.addOrder(kim.user.id, {
    orderId: 'ENL-S-D1', status: 'shipped', total: 20, method: 'crypto',
    createdAt: new Date().toISOString(), items: []
  });
  const opened = await api('/api/disputes', {
    method: 'POST', token: kim.token,
    body: { orderId: 'ENL-S-D1', reason: 'damaged', message: 'Cracked.' }
  });
  const id = opened.body.dispute.id;

  const token = await adminToken();
  assert.equal((await api('/api/admin/summary', { token })).body.disputes, 1);

  // Once we reply, the ball is with them and it stops counting.
  await api(`/api/admin/disputes/${id}/messages`, { method: 'POST', token, body: { message: 'Looking into it.' } });
  assert.equal((await api('/api/admin/summary', { token })).body.disputes, 0);

  // Their answer puts it back on our pile.
  await api(`/api/disputes/${id}/messages`, { method: 'POST', token: kim.token, body: { message: 'Any news?' } });
  assert.equal((await api('/api/admin/summary', { token })).body.disputes, 1);

  // Resolving takes it off for good.
  await api(`/api/admin/disputes/${id}/resolve`, { method: 'POST', token, body: { outcome: 'replaced' } });
  assert.equal((await api('/api/admin/summary', { token })).body.disputes, 0);
});

test('the summary carries the photo-storage percentage and its threshold', async () => {
  const token = await adminToken();
  const { body } = await api('/api/admin/summary', { token });
  assert.equal(typeof body.storagePct, 'number');
  assert.equal(body.storagePct, disputes.storageStatus().pct);

  /* The threshold must come from the server, or the pop-up would decide on its
     own when storage is a problem and drift from the console and the email.
     Asserted against a NON-default value — comparing 80 to a fallback of 80
     could not fail. */
  const prev = process.env.DISPUTE_STORAGE_ALERT_PCT;
  try {
    process.env.DISPUTE_STORAGE_ALERT_PCT = '64';
    const again = await api('/api/admin/summary', { token });
    assert.equal(again.body.storageAlertPct, 64);
  } finally {
    if (prev === undefined) delete process.env.DISPUTE_STORAGE_ALERT_PCT;
    else process.env.DISPUTE_STORAGE_ALERT_PCT = prev;
  }
});

test('the summary carries no customer records', async () => {
  const token = await adminToken();
  const { body } = await api('/api/admin/summary', { token });
  const raw = JSON.stringify(body);
  /* The page rendering this is a shop page. A count is all it may hold —
     an order reference or an address here would put customer data on a
     surface that has no reason for it. */
  assert.ok(!raw.includes('@example.com'), 'no customer address');
  assert.ok(!raw.includes('ENL-'), 'no order references');
  for (const key of Object.keys(body)) {
    if (key === 'success') continue;
    assert.equal(typeof body[key], key === 'anythingWaiting' ? 'boolean' : 'number',
      `${key} should be a plain count, not a record`);
  }
});
