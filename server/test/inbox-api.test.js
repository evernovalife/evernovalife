/* ============================================================
   EVER NOVA LIFE — inbox route tests
   The guest half of this is deliberately unauthenticated: the
   person reading it has no account and is on a phone hours
   later. The signed token in the URL is the whole credential,
   so the tests that matter are the ones that prove it unlocks
   exactly one thread and nothing else.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-inbox-api-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-inbox';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
delete process.env.ADMIN_KEY;

const app = require('../server.js');
const auth = require('../auth.js');
const inbox = require('../inbox.js');

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

async function adminToken() {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'boss@evernovalife.com', password: 'CorrectHorse9!' })
  });
  const loginData = await login.json();
  if (loginData.token) return loginData.token;
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Boss', lastName: 'Admin', email: 'boss@evernovalife.com', password: 'CorrectHorse9!' })
  });
  return (await res.json()).token;
}

// Each seeded thread gets its own address by default, so tests exercising
// unrelated scenarios don't trip inbox.js's MAX_OPEN_PER_EMAIL guard against
// each other. Pass an explicit email where a test cares about its value.
let seedSeq = 0;
function seed(subject, guestEmail) {
  seedSeq += 1;
  const email = guestEmail || `guest${seedSeq}@example.com`;
  return inbox.create({ email, name: 'Guest', subject, body: 'The original question.' });
}

test('a valid token reads exactly one thread', async () => {
  const t = seed('token read');
  const good = auth.refToken('inbox', t.id);
  const res = await fetch(`${base}/api/inbox/${t.id}?t=${good}`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.thread.id, t.id);
  assert.strictEqual(data.thread.messages.length, 1);
  // The guest view must not leak how the queue is worked.
  assert.strictEqual(data.thread.adminReadAt, undefined);
  assert.strictEqual(data.thread.email, undefined);
});

test('a wrong token is refused, and says no more than a missing one', async () => {
  const t = seed('wrong token');
  const wrong = await fetch(`${base}/api/inbox/${t.id}?t=deadbeefdeadbeefdeadbeefdeadbeef`);
  const missing = await fetch(`${base}/api/inbox/MSG-NOPE?t=deadbeefdeadbeefdeadbeefdeadbeef`);
  assert.strictEqual(wrong.status, 404);
  assert.strictEqual(missing.status, 404);
  assert.deepStrictEqual(await wrong.json(), await missing.json());
});

test("one thread's token does not open another thread", async () => {
  const a = seed('thread a');
  const b = seed('thread b');
  const res = await fetch(`${base}/api/inbox/${b.id}?t=${auth.refToken('inbox', a.id)}`);
  assert.strictEqual(res.status, 404);
});

test('a guest can reply with the token, and it lands as customer', async () => {
  const t = seed('guest reply');
  const res = await fetch(`${base}/api/inbox/${t.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: auth.refToken('inbox', t.id), body: 'Following up.' })
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  const last = data.thread.messages[data.thread.messages.length - 1];
  assert.strictEqual(last.from, 'customer');
  assert.strictEqual(last.body, 'Following up.');
  assert.strictEqual(data.thread.status, 'awaiting_us');
});

test('the admin queue needs an admin', async () => {
  const anon = await fetch(`${base}/api/admin/inbox`);
  assert.strictEqual(anon.status, 401);

  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'No', lastName: 'Body', email: 'nobody@example.com', password: 'CorrectHorse9!' })
  });
  const plain = (await reg.json()).token;
  // requireAdmin answers 401 for an authenticated non-admin too (see
  // authz.test.js's "an ordinary user cannot create, list-all or delete a
  // promotion") — same convention here, not 403.
  const res = await fetch(`${base}/api/admin/inbox`, { headers: { Authorization: `Bearer ${plain}` } });
  assert.strictEqual(res.status, 401);
});

test('an admin reply flips the thread and the guest can see it', async () => {
  const t = seed('admin reply');
  const token = await adminToken();
  const res = await fetch(`${base}/api/admin/inbox/${t.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body: 'Here is the answer.' })
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).thread.status, 'awaiting_them');

  const guest = await fetch(`${base}/api/inbox/${t.id}?t=${auth.refToken('inbox', t.id)}`);
  const seen = (await guest.json()).thread;
  assert.strictEqual(seen.messages[seen.messages.length - 1].from, 'store');
});

test('closing a thread stops the guest writing to it', async () => {
  const t = seed('closing');
  const token = await adminToken();
  const closed = await fetch(`${base}/api/admin/inbox/${t.id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({})
  });
  assert.strictEqual(closed.status, 200);

  const res = await fetch(`${base}/api/inbox/${t.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: auth.refToken('inbox', t.id), body: 'still there?' })
  });
  assert.strictEqual(res.status, 409);
});

test('the admin list carries the unread flag', async () => {
  const t = seed('unread flag', 'guest@example.com');
  const token = await adminToken();
  const res = await fetch(`${base}/api/admin/inbox`, { headers: { Authorization: `Bearer ${token}` } });
  const rows = (await res.json()).threads;
  const row = rows.find(r => r.id === t.id);
  assert.ok(row, 'the seeded thread should be in the queue');
  assert.strictEqual(row.unreadForAdmin, true);
  assert.strictEqual(row.email, 'guest@example.com');
});
