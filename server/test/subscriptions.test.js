/* ============================================================
   EVER NOVA LIFE — auto-ship (recurring order) tests
   Auto-ship charges real cards with nobody watching, so the
   things worth proving here are the ones that cost money when
   they're wrong:

     · one customer can't see or change another's plan
     · a plan can't be claimed (and so charged) twice at once
     · the billing date advances from the DUE date, so a late
       trigger never drifts the schedule
     · a declined card retries a bounded number of times, then
       pauses instead of being hammered
     · the vault token never leaves the server
     · the interval is clamped no matter what's submitted

   Runs with the built-in Node test runner (no extra deps):
       npm test          (from the server/ folder)
       node --test

   The app is require()'d (not spawned) and started on an
   ephemeral port. A throwaway DATA_DIR keeps the real store clean.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- configure the environment BEFORE requiring anything ----
// The stores read DATA_DIR at module load, and auth.js reads JWT_SECRET /
// ADMIN_EMAILS, so these have to be in place first.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-subs-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-subs';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
process.env.CRON_KEY = 'test-cron-key';
delete process.env.ADMIN_KEY;   // exercise account-based admin only

// Blank (but present) Braintree keys: dotenv won't overwrite variables that
// already exist, so this guarantees the suite can never reach the live gateway.
process.env.BRAINTREE_MERCHANT_ID = '';
process.env.BRAINTREE_PUBLIC_KEY = '';
process.env.BRAINTREE_PRIVATE_KEY = '';

const subscriptions = require('../subscriptions.js');
const app = require('../server.js');

const DAY_MS = 24 * 60 * 60 * 1000;

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

/* small fetch helper: returns { status, body } */
async function api(pathname, { method = 'GET', token, headers = {}, body } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined
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

/* A plan created straight through the store — the HTTP path to create one
   needs a live Braintree vault, which these tests deliberately can't reach. */
function makePlan(userId, overrides = {}) {
  return subscriptions.create(userId, {
    items: [{ id: 1, name: 'Test Peptide', price: 59.99, quantity: 2 }],
    intervalDays: 30,
    paymentMethodToken: 'vault-token-' + userId.slice(0, 8),
    paymentLabel: 'Visa ending 1111',
    braintreeCustomerId: userId,
    email: 'test@example.com',
    ...overrides
  });
}

/* ============================================================
   1) Interval validation — the customer types a free-form number
   ============================================================ */
test('the repeat interval is clamped into the allowed range', () => {
  assert.equal(subscriptions.cleanIntervalDays(45), 45, 'a sensible value is kept');
  assert.equal(subscriptions.cleanIntervalDays(0), subscriptions.MIN_DAYS, 'zero floors to the minimum');
  assert.equal(subscriptions.cleanIntervalDays(-90), subscriptions.MIN_DAYS, 'negatives floor to the minimum');
  assert.equal(subscriptions.cleanIntervalDays(9999), subscriptions.MAX_DAYS, 'huge values cap at the maximum');
  assert.equal(subscriptions.cleanIntervalDays('abc'), subscriptions.DEFAULT_DAYS, 'nonsense falls back to the default');
  assert.equal(subscriptions.cleanIntervalDays(30.6), 31, 'fractions round to whole days');
});

test('a plan cannot be created without items or a payment method', () => {
  assert.throws(() => subscriptions.create('u-1', { items: [], paymentMethodToken: 't' }), /at least one product/i);
  assert.throws(() => subscriptions.create('u-1', { items: [{ id: 1, quantity: 1 }] }), /payment method/i);
});

/* ============================================================
   2) The vault token never reaches the browser
   ============================================================ */
test('the public view of a plan hides the payment token', () => {
  const sub = makePlan('u-token-test');
  const pub = subscriptions.publicSubscription(sub);
  assert.equal(sub.paymentMethodToken, 'vault-token-u-token-', 'the record itself holds the token');
  assert.ok(!('paymentMethodToken' in pub), 'the public view has no token field');
  assert.ok(!('braintreeCustomerId' in pub), 'the public view has no gateway customer id');
  assert.equal(pub.paymentLabel, 'Visa ending 1111', 'a human-readable label is shown instead');
  assert.ok(!JSON.stringify(pub).includes('vault-token'), 'the token appears nowhere in the payload');
});

/* ============================================================
   3) Due selection — only active plans, only when the date passed
   ============================================================ */
test('only active, past-due plans are picked up by the scheduler', () => {
  const uid = 'u-due-test';
  const future = makePlan(uid, { nextRunAt: new Date(Date.now() + 5 * DAY_MS).toISOString() });
  const overdue = makePlan(uid, { nextRunAt: new Date(Date.now() - 2 * DAY_MS).toISOString() });
  const paused = makePlan(uid, { nextRunAt: new Date(Date.now() - 2 * DAY_MS).toISOString() });
  subscriptions.update(paused.id, uid, { status: 'paused' });

  const dueIds = subscriptions.listDue().map(s => s.id);
  assert.ok(dueIds.includes(overdue.id), 'the overdue plan is due');
  assert.ok(!dueIds.includes(future.id), 'a future plan is not due');
  assert.ok(!dueIds.includes(paused.id), 'a paused plan is never due, even when overdue');
});

/* ============================================================
   4) Claiming — two overlapping triggers must not both charge
   ============================================================ */
test('a plan can only be claimed once at a time', () => {
  const sub = makePlan('u-claim-test', { nextRunAt: new Date(Date.now() - DAY_MS).toISOString() });

  const first = subscriptions.claim(sub.id);
  assert.ok(first, 'the first trigger takes the plan');

  const second = subscriptions.claim(sub.id);
  assert.equal(second, null, 'a second, overlapping trigger is refused');

  assert.ok(!subscriptions.listDue().some(s => s.id === sub.id), 'a claimed plan drops out of the due list');

  subscriptions.release(sub.id);
  assert.ok(subscriptions.claim(sub.id), 'it can be claimed again once released');
});

/* ============================================================
   5) No schedule drift — advance from the due date, not "now"
   ============================================================ */
test('the next date advances from the due date, so a late run does not drift', () => {
  const dueAt = new Date(Date.now() - 4 * DAY_MS);          // the trigger ran 4 days late
  const sub = makePlan('u-drift-test', { nextRunAt: dueAt.toISOString(), intervalDays: 30 });

  const updated = subscriptions.recordSuccess(sub.id, 'ENL-TEST-1');
  const expected = new Date(dueAt.getTime() + 30 * DAY_MS).getTime();

  assert.equal(new Date(updated.nextRunAt).getTime(), expected,
    'next run is 30 days after the DUE date, not 30 days after the late run');
  assert.equal(updated.runCount, 1, 'the shipment is counted');
  assert.equal(updated.failCount, 0, 'the failure counter is cleared');
  assert.equal(updated.pendingOrderId, '', 'the in-flight order marker is cleared');
  assert.ok(updated.orderIds.includes('ENL-TEST-1'), 'the order is linked to the plan');
});

/* ============================================================
   6) Declines retry a bounded number of times, then pause
   ============================================================ */
test('a declining card retries, then the plan pauses instead of being hammered', () => {
  const sub = makePlan('u-fail-test', { nextRunAt: new Date(Date.now() - DAY_MS).toISOString() });

  for (let attempt = 1; attempt < subscriptions.MAX_FAILS; attempt++) {
    const { sub: s, paused } = subscriptions.recordFailure(sub.id, 'Insufficient funds');
    assert.equal(paused, false, `attempt ${attempt} still retries`);
    assert.equal(s.status, 'active', 'the plan stays active while retrying');
    const gapDays = Math.round((new Date(s.nextRunAt).getTime() - Date.now()) / DAY_MS);
    assert.equal(gapDays, subscriptions.RETRY_DAYS, 'the retry is scheduled a few days out');
  }

  const final = subscriptions.recordFailure(sub.id, 'Insufficient funds');
  assert.equal(final.paused, true, 'the last allowed failure pauses the plan');
  assert.equal(final.sub.status, 'paused', 'the plan is paused');
  assert.equal(final.sub.lastError, 'Insufficient funds', 'the reason is kept for the customer');
  assert.ok(!subscriptions.listDue().some(s => s.id === sub.id), 'a paused plan stops being charged');
});

/* ============================================================
   7) Customer edits — skip, resume, and what's rejected
   ============================================================ */
test('skipping the next shipment pushes it out by one whole interval', () => {
  const next = new Date(Date.now() + 3 * DAY_MS);
  const sub = makePlan('u-skip-test', { nextRunAt: next.toISOString(), intervalDays: 30 });

  const patch = subscriptions.applyCustomerEdits(sub, { skipNext: true });
  const expected = new Date(next.getTime() + 30 * DAY_MS).getTime();
  assert.equal(new Date(patch.nextRunAt).getTime(), expected, 'one interval later');
  assert.equal(patch.reminderSentFor, '', 'the advance-notice email is re-armed for the new date');
});

test('resuming a plan whose date has passed does not charge immediately', () => {
  const uid = 'u-resume-test';
  const sub = makePlan(uid, { nextRunAt: new Date(Date.now() - 40 * DAY_MS).toISOString() });
  subscriptions.update(sub.id, uid, { status: 'paused' });
  const paused = subscriptions.get(sub.id, uid);

  const patch = subscriptions.applyCustomerEdits(paused, { status: 'active' });
  assert.ok(new Date(patch.nextRunAt).getTime() > Date.now(),
    'the next shipment is moved into the future rather than firing at once');
  assert.equal(patch.failCount, 0, 'resuming clears earlier failures');
});

test('invalid edits are rejected', () => {
  const sub = makePlan('u-edit-test');
  assert.throws(() => subscriptions.applyCustomerEdits(sub, { status: 'cancelled' }), /active/i);
  assert.throws(() => subscriptions.applyCustomerEdits(sub, { items: [] }), /at least one product/i);
  assert.throws(() => subscriptions.applyCustomerEdits(sub, { nextRunAt: '2020-01-01' }), /future/i);
  assert.throws(() => subscriptions.applyCustomerEdits(sub, { nextRunAt: 'not-a-date' }), /not valid/i);
});

test('cancelling stops the plan for good', () => {
  const uid = 'u-cancel-test';
  const sub = makePlan(uid, { nextRunAt: new Date(Date.now() - DAY_MS).toISOString() });
  const cancelled = subscriptions.cancel(sub.id, uid);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(!subscriptions.listDue().some(s => s.id === sub.id), 'a cancelled plan is never charged again');
});

/* ============================================================
   8) Store-level ownership — the id alone is not authority
   ============================================================ */
test('a plan cannot be read or written through another account id', () => {
  const mine = makePlan('u-owner-a');
  makePlan('u-owner-b');

  assert.ok(subscriptions.get(mine.id, 'u-owner-a'), 'the owner can read it');
  assert.equal(subscriptions.get(mine.id, 'u-owner-b'), null, 'another account cannot read it');
  assert.equal(subscriptions.update(mine.id, 'u-owner-b', { intervalDays: 7 }), null, 'another account cannot change it');
  assert.equal(subscriptions.cancel(mine.id, 'u-owner-b'), null, 'another account cannot cancel it');
  assert.equal(subscriptions.get(mine.id, 'u-owner-a').intervalDays, 30, 'the plan is untouched');
});

test('deleting an account removes its plans so nothing keeps charging', () => {
  const uid = 'u-delete-test';
  makePlan(uid, { nextRunAt: new Date(Date.now() - DAY_MS).toISOString() });
  assert.equal(subscriptions.listForUser(uid).length, 1);

  subscriptions.deleteUserData(uid);
  assert.equal(subscriptions.listForUser(uid).length, 0, 'the plans are gone');
  assert.ok(!subscriptions.listDue().some(s => s.userId === uid), 'and nothing of theirs is still due');
});

/* ============================================================
   9) HTTP — authentication and cross-account access
   ============================================================ */
test('the subscription endpoints reject anonymous callers', async () => {
  assert.equal((await api('/api/subscriptions')).status, 401);
  assert.equal((await api('/api/subscriptions', { method: 'POST', body: {} })).status, 401);
  assert.equal((await api('/api/subscriptions/SUB-ANY', { method: 'PATCH', body: { status: 'paused' } })).status, 401);
  assert.equal((await api('/api/subscriptions/SUB-ANY', { method: 'DELETE' })).status, 401);
});

test('one signed-in customer cannot touch another customer\'s plan', async () => {
  const alice = await register('alice-subs@example.com');
  const mallory = await register('mallory-subs@example.com');
  const plan = makePlan(alice.user.id);

  // Alice sees her own plan.
  const mine = await api('/api/subscriptions', { token: alice.token });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.subscriptions.some(s => s.id === plan.id), 'the owner sees it');

  // Mallory doesn't — not in her list, and not by guessing the id.
  const hers = await api('/api/subscriptions', { token: mallory.token });
  assert.equal(hers.status, 200);
  assert.equal(hers.body.subscriptions.length, 0, 'another account sees an empty list');

  const patched = await api(`/api/subscriptions/${plan.id}`, {
    method: 'PATCH', token: mallory.token, body: { status: 'paused' }
  });
  assert.equal(patched.status, 404, 'guessing the id does not grant access');

  const deleted = await api(`/api/subscriptions/${plan.id}`, { method: 'DELETE', token: mallory.token });
  assert.equal(deleted.status, 404, 'and it cannot be cancelled either');

  const after = subscriptions.get(plan.id, alice.user.id);
  assert.equal(after.status, 'active', 'the plan is untouched after both attempts');
});

test('the owner can change frequency, skip, pause and cancel over HTTP', async () => {
  const bob = await register('bob-subs@example.com');
  const plan = makePlan(bob.user.id);

  const freq = await api(`/api/subscriptions/${plan.id}`, {
    method: 'PATCH', token: bob.token, body: { intervalDays: 45 }
  });
  assert.equal(freq.status, 200);
  assert.equal(freq.body.subscription.intervalDays, 45);

  // A tampered interval is clamped, never honoured as sent.
  const silly = await api(`/api/subscriptions/${plan.id}`, {
    method: 'PATCH', token: bob.token, body: { intervalDays: 100000 }
  });
  assert.equal(silly.body.subscription.intervalDays, subscriptions.MAX_DAYS);

  const paused = await api(`/api/subscriptions/${plan.id}`, {
    method: 'PATCH', token: bob.token, body: { status: 'paused' }
  });
  assert.equal(paused.body.subscription.status, 'paused');

  const cancelled = await api(`/api/subscriptions/${plan.id}`, { method: 'DELETE', token: bob.token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.subscription.status, 'cancelled');
});

test('the browser can never point a plan at an unowned payment token', async () => {
  const carol = await register('carol-subs@example.com');
  // No nonce and no token at all → refused before anything is created.
  const res = await api('/api/subscriptions', {
    method: 'POST', token: carol.token,
    body: { items: [{ id: 1, quantity: 1 }], intervalDays: 30 }
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /payment method/i);
});

/* ============================================================
   10) HTTP — the scheduler trigger is not open to the public
   ============================================================ */
test('the run-due trigger requires the cron key or an admin', async () => {
  const dave = await register('dave-subs@example.com');

  assert.equal((await api('/api/subscriptions/run-due', { method: 'POST' })).status, 401,
    'anonymous callers are refused');
  assert.equal((await api('/api/subscriptions/run-due', { method: 'POST', token: dave.token })).status, 401,
    'an ordinary signed-in customer cannot trigger billing');
  assert.equal((await api('/api/subscriptions/run-due', {
    method: 'POST', headers: { 'x-cron-key': 'wrong-key' }
  })).status, 401, 'a wrong key is refused');

  const ok = await api('/api/subscriptions/run-due', {
    method: 'POST', headers: { 'x-cron-key': 'test-cron-key' }
  });
  assert.equal(ok.status, 200, 'the real cron key is accepted');
  assert.equal(ok.body.success, true);
  assert.equal(typeof ok.body.due, 'number', 'it reports how many plans were due');
});

test('an admin account can trigger a run (the "run due now" button)', async () => {
  const admin = await register('boss@evernovalife.com');
  const res = await api('/api/subscriptions/run-due', { method: 'POST', token: admin.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('the admin plan list is admin-only and shows who each plan belongs to', async () => {
  const admin = await register('boss2@evernovalife.com');   // not in ADMIN_EMAILS
  assert.equal((await api('/api/admin/subscriptions')).status, 401, 'anonymous is refused');
  assert.equal((await api('/api/admin/subscriptions', { token: admin.token })).status, 401,
    'an ordinary account is refused');

  const boss = await api('/api/auth/login', {
    method: 'POST', body: { email: 'boss@evernovalife.com', password: 'password123' }
  });
  const list = await api('/api/admin/subscriptions', { token: boss.body.token });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.subscriptions));
  assert.ok(!JSON.stringify(list.body).includes('vault-token'),
    'even the admin view never exposes vault tokens');
});
