/* ============================================================
   EVER NOVA LIFE — dispute API tests
   Ownership is the whole point of this file: one account must not
   be able to read, answer or download another account's report,
   and the refusal must not tell them whether it exists.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-disp-api-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-disputes';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
delete process.env.ADMIN_KEY;

const app = require('../server.js');
const store = require('../store.js');
const ratelimit = require('../ratelimit.js');

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

/* disputeOpenLimiter counts per IP, and every request in this file comes
   from 127.0.0.1 in one process — so without a reset, this file's own
   volume of "open a report" calls would trip a control aimed at someone
   scripting a mailbox full of images, not at a legitimate test run. */
test.beforeEach(() => ratelimit.reset());

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, res };
}

async function signUp(email) {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'T', lastName: 'U', email, password: 'password123' }
  });
  return { token: r.body.token, user: r.body.user };
}

/* An order has to exist for a report to hang off. The checkout path needs a
   payment gateway; the store module is what checkout writes through, so we
   write through it directly and keep this test about disputes. */
function placeOrder(userId, orderId, over = {}) {
  return store.addOrder(userId, {
    orderId, status: 'shipped', total: 96.39, method: 'crypto',
    createdAt: new Date().toISOString(),
    items: [{ id: 7, name: 'Test peptide', price: 96.39, quantity: 1 }],
    ...over
  });
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]).toString('base64');

test('anonymous callers get 401 on every dispute route', async () => {
  const cases = [
    ['GET', '/api/disputes'],
    ['POST', '/api/disputes'],
    ['GET', '/api/disputes/DSP-NOPE'],
    ['POST', '/api/disputes/DSP-NOPE/messages'],
    ['POST', '/api/disputes/DSP-NOPE/read'],
    ['GET', '/api/disputes/DSP-NOPE/files/f1']
  ];
  for (const [method, pathname] of cases) {
    const { status } = await api(pathname, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(status, 401, `${method} ${pathname} should be 401, got ${status}`);
  }
});

test('a customer opens a report on their own order', async () => {
  const alice = await signUp('alice-d@example.com');
  placeOrder(alice.user.id, 'ENL-OWN1');
  const { status, body } = await api('/api/disputes', {
    method: 'POST', token: alice.token,
    body: { orderId: 'ENL-OWN1', reason: 'damaged', message: 'A vial arrived cracked.', attachments: [{ name: 'v.png', data: PNG }] }
  });
  assert.equal(status, 201);
  assert.equal(body.dispute.orderId, 'ENL-OWN1');
  assert.equal(body.dispute.status, 'awaiting_us');
  assert.equal(body.dispute.messages[0].attachments.length, 1);
});

test('opening a report on an order that is not yours is a 404', async () => {
  const bob = await signUp('bob-d@example.com');
  const { status } = await api('/api/disputes', {
    method: 'POST', token: bob.token,
    body: { orderId: 'ENL-OWN1', reason: 'damaged', message: 'Not mine.' }
  });
  assert.equal(status, 404);
});

test('a second report on the same order is a 409 that names the first', async () => {
  const carol = await signUp('carol-d@example.com');
  placeOrder(carol.user.id, 'ENL-DUP1');
  const first = await api('/api/disputes', {
    method: 'POST', token: carol.token,
    body: { orderId: 'ENL-DUP1', reason: 'not_delivered', message: 'Nothing arrived.' }
  });
  assert.equal(first.status, 201);
  const second = await api('/api/disputes', {
    method: 'POST', token: carol.token,
    body: { orderId: 'ENL-DUP1', reason: 'not_delivered', message: 'Still nothing.' }
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.disputeId, first.body.dispute.id);
});

test('a report cannot be opened on a cancelled order', async () => {
  const dave = await signUp('dave-d@example.com');
  placeOrder(dave.user.id, 'ENL-CANC', { status: 'cancelled' });
  const { status } = await api('/api/disputes', {
    method: 'POST', token: dave.token,
    body: { orderId: 'ENL-CANC', reason: 'other', message: 'Hello?' }
  });
  assert.equal(status, 400);
});

/* No test anywhere drives disputeOpenLimiter to an actual 429 — it is
   wired to POST /api/disputes but nothing proves that. 6 opens/hour is
   the deliberate cap (a disk-abuse control), so this account needs 7
   requests, each against its own order to get past the one-open-per-
   order rule, and the rate limiter runs before the route handler, so
   the 7th is refused before it ever looks at order state. */
test('the open-a-report limiter answers 429 once its per-hour budget is spent', async () => {
  const nolan = await signUp('nolan-d@example.com');
  const orderIds = [];
  for (let i = 1; i <= 7; i++) {
    const orderId = `ENL-LIMIT${i}`;
    placeOrder(nolan.user.id, orderId);
    orderIds.push(orderId);
  }
  let last;
  for (const orderId of orderIds) {
    last = await api('/api/disputes', {
      method: 'POST', token: nolan.token,
      body: { orderId, reason: 'other', message: 'Testing the limiter.' }
    });
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.error, 'That is a lot of reports in an hour. Reply on one of the open ones, or email support@evernovalife.com.');
});

test("another account gets 404 — not 403 — on someone else's thread", async () => {
  const erin = await signUp('erin-d@example.com');
  placeOrder(erin.user.id, 'ENL-PRIV');
  const mine = await api('/api/disputes', {
    method: 'POST', token: erin.token,
    body: { orderId: 'ENL-PRIV', reason: 'billing', message: 'The total looks wrong.', attachments: [{ name: 'r.png', data: PNG }] }
  });
  const id = mine.body.dispute.id;
  const fileId = mine.body.dispute.messages[0].attachments[0].id;

  const frank = await signUp('frank-d@example.com');
  assert.equal((await api(`/api/disputes/${id}`, { token: frank.token })).status, 404);
  assert.equal((await api(`/api/disputes/${id}/messages`, { method: 'POST', token: frank.token, body: { message: 'hi' } })).status, 404);
  assert.equal((await api(`/api/disputes/${id}/files/${fileId}`, { token: frank.token })).status, 404);
  assert.equal((await api(`/api/disputes/${id}/read`, { method: 'POST', token: frank.token, body: {} })).status, 404);

  // …and the owner can still do all four.
  assert.equal((await api(`/api/disputes/${id}`, { token: erin.token })).status, 200);
  const img = await api(`/api/disputes/${id}/files/${fileId}`, { token: erin.token });
  assert.equal(img.res.status, 200);
  assert.equal(img.res.headers.get('content-type'), 'image/png');
});

test('GET /api/disputes lists only my threads, and carries the reason list', async () => {
  const gina = await signUp('gina-d@example.com');
  placeOrder(gina.user.id, 'ENL-LIST1');
  await api('/api/disputes', { method: 'POST', token: gina.token, body: { orderId: 'ENL-LIST1', reason: 'other', message: 'A question.' } });
  const { status, body } = await api('/api/disputes', { token: gina.token });
  assert.equal(status, 200);
  assert.equal(body.disputes.length, 1);
  assert.ok(body.reasons.some(r => r.code === 'damaged'));
  assert.ok(!('messages' in body.disputes[0]), 'the list is summaries only');
});

test('the thread comes back with its order summary attached', async () => {
  const hana = await signUp('hana-d@example.com');
  placeOrder(hana.user.id, 'ENL-WITHORD');
  const made = await api('/api/disputes', { method: 'POST', token: hana.token, body: { orderId: 'ENL-WITHORD', reason: 'wrong_item', message: 'Wrong vial.' } });
  const { body } = await api(`/api/disputes/${made.body.dispute.id}`, { token: hana.token });
  assert.equal(body.order.orderId, 'ENL-WITHORD');
  assert.equal(body.order.total, 96.39);
  assert.ok(Array.isArray(body.order.items));
});

test('read stamps the thread so it stops counting as unread for the customer', async () => {
  const ivan = await signUp('ivan-d@example.com');
  placeOrder(ivan.user.id, 'ENL-READ');
  const made = await api('/api/disputes', { method: 'POST', token: ivan.token, body: { orderId: 'ENL-READ', reason: 'other', message: 'Hello.' } });
  const r = await api(`/api/disputes/${made.body.dispute.id}/read`, { method: 'POST', token: ivan.token });
  assert.equal(r.status, 200);
});

test('deleting the account takes the threads with it', async () => {
  const jack = await signUp('jack-d@example.com');
  placeOrder(jack.user.id, 'ENL-DEL');
  const made = await api('/api/disputes', { method: 'POST', token: jack.token, body: { orderId: 'ENL-DEL', reason: 'other', message: 'Bye.' } });
  const boss = await signUp('boss@evernovalife.com');
  const del = await api(`/api/admin/users/${jack.user.id}`, { method: 'DELETE', token: boss.token });
  assert.equal(del.status, 200);
  const disputes = require('../disputes.js');
  assert.equal(disputes.get(made.body.dispute.id), null);
});

/* ============================================================
   ADMIN SIDE
   ============================================================ */

async function adminToken() {
  const r = await api('/api/auth/login', { method: 'POST', body: { email: 'boss@evernovalife.com', password: 'password123' } });
  if (r.body && r.body.token) return r.body.token;
  const reg = await signUp('boss@evernovalife.com');
  return reg.token;
}

test('an ordinary account is refused every admin dispute route', async () => {
  const mallory = await signUp('mallory-d@example.com');
  const cases = [
    ['GET', '/api/admin/disputes'],
    ['GET', '/api/admin/disputes/DSP-NOPE'],
    ['POST', '/api/admin/disputes/DSP-NOPE/messages'],
    ['POST', '/api/admin/disputes/DSP-NOPE/resolve'],
    ['POST', '/api/admin/disputes/DSP-NOPE/reopen'],
    ['POST', '/api/admin/disputes/DSP-NOPE/read']
  ];
  for (const [method, pathname] of cases) {
    const { status } = await api(pathname, { method, token: mallory.token, body: method === 'GET' ? undefined : {} });
    assert.equal(status, 401, `${method} ${pathname} should be 401 for a non-admin, got ${status}`);
  }
});

test('the admin list stitches the customer and the order onto each thread', async () => {
  const nina = await signUp('nina-d@example.com');
  placeOrder(nina.user.id, 'ENL-ADM1');
  await api('/api/disputes', { method: 'POST', token: nina.token, body: { orderId: 'ENL-ADM1', reason: 'damaged', message: 'Cracked.' } });

  const token = await adminToken();
  const { status, body } = await api('/api/admin/disputes', { token });
  assert.equal(status, 200);
  const row = body.disputes.find(d => d.orderId === 'ENL-ADM1');
  assert.ok(row, 'the new thread is in the list');
  assert.equal(row.customerEmail, 'nina-d@example.com');
  assert.equal(row.order.total, 96.39);
  assert.equal(row.unreadForAdmin, true);
  assert.ok(body.outcomes.some(o => o.code === 'refunded'));
});

test('the store replies, the thread flips, and the customer sees it', async () => {
  const omar = await signUp('omar-d@example.com');
  placeOrder(omar.user.id, 'ENL-ADM2');
  const made = await api('/api/disputes', { method: 'POST', token: omar.token, body: { orderId: 'ENL-ADM2', reason: 'not_delivered', message: 'Nothing came.' } });
  const id = made.body.dispute.id;

  const token = await adminToken();
  const reply = await api(`/api/admin/disputes/${id}/messages`, { method: 'POST', token, body: { message: 'We have opened a claim with the courier.' } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.dispute.status, 'awaiting_customer');

  const seen = await api(`/api/disputes/${id}`, { token: omar.token });
  assert.equal(seen.body.dispute.messages.length, 2);
  assert.equal(seen.body.dispute.messages[1].from, 'admin');
});

test('resolving records the outcome and closes the thread to replies', async () => {
  const pia = await signUp('pia-d@example.com');
  placeOrder(pia.user.id, 'ENL-ADM3');
  const made = await api('/api/disputes', { method: 'POST', token: pia.token, body: { orderId: 'ENL-ADM3', reason: 'damaged', message: 'Broken.' } });
  const id = made.body.dispute.id;
  const token = await adminToken();

  const done = await api(`/api/admin/disputes/${id}/resolve`, { method: 'POST', token, body: { outcome: 'replaced', note: 'Reshipped.' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.dispute.status, 'resolved');
  assert.equal(done.body.dispute.outcome, 'replaced');

  const blocked = await api(`/api/disputes/${id}/messages`, { method: 'POST', token: pia.token, body: { message: 'Thanks!' } });
  assert.equal(blocked.status, 409);

  const back = await api(`/api/admin/disputes/${id}/reopen`, { method: 'POST', token });
  // Ruling (matches Task 1's identical correction, same reason): deriveStatus
  // ignores `system` lines, and this thread's only real message is the
  // customer's opening one — the store resolved it without ever replying.
  // A thread the store reopens with no reply of its own is waiting on the
  // store, i.e. 'awaiting_us', not 'awaiting_customer'.
  assert.equal(back.body.dispute.status, 'awaiting_us');
  const allowed = await api(`/api/disputes/${id}/messages`, { method: 'POST', token: pia.token, body: { message: 'Thanks!' } });
  assert.equal(allowed.status, 200);
});

test('an unknown outcome is refused', async () => {
  const quinn = await signUp('quinn-d@example.com');
  placeOrder(quinn.user.id, 'ENL-ADM4');
  const made = await api('/api/disputes', { method: 'POST', token: quinn.token, body: { orderId: 'ENL-ADM4', reason: 'other', message: 'Hm.' } });
  const token = await adminToken();
  const bad = await api(`/api/admin/disputes/${made.body.dispute.id}/resolve`, { method: 'POST', token, body: { outcome: 'whatever' } });
  assert.equal(bad.status, 400);
});

test('an admin can download an attachment on any thread', async () => {
  const rosa = await signUp('rosa-d@example.com');
  placeOrder(rosa.user.id, 'ENL-ADM5');
  const made = await api('/api/disputes', {
    method: 'POST', token: rosa.token,
    body: { orderId: 'ENL-ADM5', reason: 'damaged', message: 'See photo.', attachments: [{ name: 'p.png', data: PNG }] }
  });
  const id = made.body.dispute.id;
  const fileId = made.body.dispute.messages[0].attachments[0].id;
  const token = await adminToken();
  const img = await api(`/api/admin/disputes/${id}/files/${fileId}`, { token });
  assert.equal(img.res.status, 200);
  assert.equal(img.res.headers.get('content-type'), 'image/png');
});

/* ============================================================
   WHAT THE CUSTOMER IS ALLOWED TO SEE
   ============================================================ */

/* The owner's own address is stamped on every admin reply (authorEmail) and
   on every resolution (resolvedBy). Neither UI renders either field — which
   is precisely why this has to be asserted on the SERIALIZED response and
   not field by field: what catches a route added later and not redacted is
   "the address appears nowhere in the bytes", not a list of the three fields
   we happen to know about today. */
test("the admin's own email address never reaches the customer", async () => {
  const sam = await signUp('sam-d@example.com');
  placeOrder(sam.user.id, 'ENL-REDACT');
  const made = await api('/api/disputes', {
    method: 'POST', token: sam.token,
    body: { orderId: 'ENL-REDACT', reason: 'billing', message: 'The total looks wrong.' }
  });
  const id = made.body.dispute.id;

  const token = await adminToken();
  await api(`/api/admin/disputes/${id}/messages`, { method: 'POST', token, body: { message: 'Looking into it.' } });
  await api(`/api/admin/disputes/${id}/resolve`, { method: 'POST', token, body: { outcome: 'refunded', note: 'Refunded the difference.' } });

  const ADMIN = 'boss@evernovalife.com';

  // The detail route, the list, and the create/reply responses — every
  // customer-facing shape that carries a thread.
  const detail = await api(`/api/disputes/${id}`, { token: sam.token });
  assert.equal(detail.status, 200);
  assert.ok(!JSON.stringify(detail.body).includes(ADMIN),
    "the customer's own view of the thread must not carry the admin's address");
  assert.equal(detail.body.dispute.resolvedBy, '');
  assert.equal(detail.body.dispute.messages[1].authorEmail, '');
  // …and their own message still names them, or the thread has lost something real.
  assert.equal(detail.body.dispute.messages[0].authorEmail, 'sam-d@example.com');

  const listed = await api('/api/disputes', { token: sam.token });
  assert.ok(!JSON.stringify(listed.body).includes(ADMIN), 'nor the summary list');

  // A reopen writes a `system` line stamped with the admin who reopened it.
  await api(`/api/admin/disputes/${id}/reopen`, { method: 'POST', token });
  const replied = await api(`/api/disputes/${id}/messages`, {
    method: 'POST', token: sam.token, body: { message: 'It is still wrong.' }
  });
  assert.equal(replied.status, 200);
  assert.ok(!JSON.stringify(replied.body).includes(ADMIN),
    'nor the reply response, including the system line the reopen left behind');

  // The owner, meanwhile, legitimately sees who on their side acted.
  const asAdmin = await api(`/api/admin/disputes/${id}`, { token });
  assert.ok(JSON.stringify(asAdmin.body).includes(ADMIN),
    'the admin view is NOT redacted — the owner has to see who replied');
});

/* disputeOpenLimiter and disputePostLimiter used to key on req.ip. Nothing
   here calls app.set('trust proxy'), so on Render req.ip is the proxy's
   address and every customer shared one bucket: the seventh person to report
   a lost batch was refused because six strangers had already reported it. */
test('the open-a-report limiter budgets per account, not site-wide', async () => {
  const tara = await signUp('tara-d@example.com');
  const uma = await signUp('uma-d@example.com');

  // Tara spends her whole hourly budget (6) and is refused on the 7th.
  let last;
  for (let i = 1; i <= 7; i++) {
    const orderId = `ENL-TARA${i}`;
    placeOrder(tara.user.id, orderId);
    last = await api('/api/disputes', {
      method: 'POST', token: tara.token,
      body: { orderId, reason: 'other', message: 'Testing the limiter.' }
    });
  }
  assert.equal(last.status, 429);

  // Uma, from the same address, still has her own untouched budget.
  placeOrder(uma.user.id, 'ENL-UMA1');
  const hers = await api('/api/disputes', {
    method: 'POST', token: uma.token,
    body: { orderId: 'ENL-UMA1', reason: 'other', message: 'Mine is a different problem.' }
  });
  assert.equal(hers.status, 201, "one account's spent budget must not refuse another's first report");
});

/* Express's own 413 is an HTML page carrying the error name and the absolute
   node_modules path of every frame. Every client here parses JSON, so that
   page reaches the customer as "Something went wrong. Try again." — with the
   photos they just attached gone. */
test('a body over the limit answers JSON, with no stack and no filesystem path', async () => {
  const vic = await signUp('vic-d@example.com');
  placeOrder(vic.user.id, 'ENL-TOOBIG');
  const res = await fetch(base + '/api/disputes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vic.token}` },
    // Comfortably past the 12mb limit, and cheap to build.
    body: JSON.stringify({ orderId: 'ENL-TOOBIG', reason: 'other', message: 'x'.repeat(13 * 1024 * 1024) })
  });
  assert.equal(res.status, 413);
  const raw = await res.text();
  assert.ok(!raw.includes('node_modules'), 'no filesystem path in the response');
  assert.ok(!raw.includes('PayloadTooLargeError'), 'no error class name in the response');
  assert.ok(!/\bat\s+\w+\s+\(/.test(raw), 'no stack frames in the response');
  const parsed = JSON.parse(raw);
  assert.ok(/photo/i.test(parsed.error), 'and a sentence the customer can act on');
});

/* The advertised allowance has to actually work: three 2 MB images are
   8,388,612 characters of base64 — over the old 8mb body limit before the
   message, the filenames or the JSON around them were counted at all. */
test('the three 2 MB photos support.html advertises fit inside the body limit', async () => {
  const wes = await signUp('wes-d@example.com');
  placeOrder(wes.user.id, 'ENL-THREEBIG');
  // A real PNG header padded out to exactly 2 MB, three times over.
  const big = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(2 * 1024 * 1024 - 8, 7)
  ]).toString('base64');
  const { status, body } = await api('/api/disputes', {
    method: 'POST', token: wes.token,
    body: {
      orderId: 'ENL-THREEBIG', reason: 'damaged', message: 'Three photos of the same crack.',
      attachments: [1, 2, 3].map(n => ({ name: `p${n}.png`, data: big }))
    }
  });
  assert.equal(status, 201);
  assert.equal(body.dispute.messages[0].attachments.length, 3);
});

/* ============================================================
   STORAGE — the figure, the sweep, the strip
   ============================================================ */

test('the admin queue carries the storage figure', async () => {
  const token = await adminToken();
  const { status, body } = await api('/api/admin/disputes', { token });
  assert.equal(status, 200);
  assert.ok(body.storage, 'storage rides on the existing response');
  assert.equal(typeof body.storage.usedBytes, 'number');
  assert.equal(typeof body.storage.ceilingBytes, 'number');
  assert.equal(typeof body.storage.pct, 'number');
});

test('an ordinary account is refused the storage controls', async () => {
  const mal = await signUp('mal-storage@example.com');
  for (const [method, pathname] of [
    ['POST', '/api/admin/disputes/sweep'],
    ['DELETE', '/api/admin/disputes/DSP-NOPE/attachments']
  ]) {
    const { status } = await api(pathname, { method, token: mal.token, body: method === 'POST' ? {} : undefined });
    assert.equal(status, 401, `${method} ${pathname} should be 401, got ${status}`);
  }
});

test('stripping a thread frees its photos and reports what went', async () => {
  const vera = await signUp('vera-d@example.com');
  placeOrder(vera.user.id, 'ENL-STRIP');
  const made = await api('/api/disputes', {
    method: 'POST', token: vera.token,
    body: { orderId: 'ENL-STRIP', reason: 'damaged', message: 'See photo.', attachments: [{ name: 'p.png', data: PNG }] }
  });
  const id = made.body.dispute.id;
  const fileId = made.body.dispute.messages[0].attachments[0].id;
  const token = await adminToken();

  const before = (await api('/api/admin/disputes', { token })).body.storage.usedBytes;
  const out = await api(`/api/admin/disputes/${id}/attachments`, { method: 'DELETE', token });
  assert.equal(out.status, 200);
  assert.equal(out.body.files, 1);
  assert.ok(out.body.bytes > 0);
  assert.equal(out.body.storage.usedBytes, before - out.body.bytes);

  // The bytes are gone for both sides; the conversation is not.
  assert.equal((await api(`/api/disputes/${id}/files/${fileId}`, { token: vera.token })).status, 404);
  assert.equal((await api(`/api/admin/disputes/${id}/files/${fileId}`, { token })).status, 404);
  const seen = await api(`/api/disputes/${id}`, { token: vera.token });
  assert.equal(seen.body.dispute.messages[0].body, 'See photo.');
  assert.ok(seen.body.dispute.messages[0].attachments[0].expiredAt);
});

test('stripping an unknown thread is a 404', async () => {
  const token = await adminToken();
  assert.equal((await api('/api/admin/disputes/DSP-NOPE/attachments', { method: 'DELETE', token })).status, 404);
});

test('the sweep runs on demand and reports zeros when nothing is due', async () => {
  const token = await adminToken();
  const { status, body } = await api('/api/admin/disputes/sweep', { method: 'POST', token });
  assert.equal(status, 200);
  assert.equal(typeof body.threads, 'number');
  assert.equal(typeof body.files, 'number');
  assert.ok(body.storage, 'the caller gets the fresh figure back');
});
