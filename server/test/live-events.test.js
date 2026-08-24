/* ============================================================
   EVER NOVA LIFE — the live event stream
   A reply should reach the other side the instant it is written. What
   is guarded here is mostly the credential: EventSource cannot send an
   Authorization header, so something has to travel in the URL — and it
   must not be the JWT, because URLs reach server logs, proxy logs and
   browser history.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-live-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-live';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
delete process.env.ADMIN_KEY;

const app = require('../server.js');
const store = require('../store.js');

let server, base;
test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  if (server) { server.close(); await once(server, 'close'); }
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function api(pathname, opts) {
  opts = opts || {};
  const headers = {};
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, res: res };
}

async function signUp(email) {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'T', lastName: 'U', email: email, password: 'password123' }
  });
  return { token: r.body.token, user: r.body.user };
}
async function adminToken() {
  const r = await api('/api/auth/login', {
    method: 'POST', body: { email: 'boss@evernovalife.com', password: 'password123' }
  });
  if (r.body && r.body.token) return r.body.token;
  return (await signUp('boss@evernovalife.com')).token;
}
async function mintTicket(token) {
  const r = await api('/api/events/ticket', { method: 'POST', token: token });
  return r.body && r.body.ticket;
}
async function placeAndOpen(who, orderId, token) {
  store.addOrder(who, {
    orderId: orderId, status: 'shipped', total: 10, method: 'crypto',
    createdAt: new Date().toISOString(), items: []
  });
  const made = await api('/api/disputes', {
    method: 'POST', token: token,
    body: { orderId: orderId, reason: 'other', message: 'Hello.' }
  });
  return made.body.dispute.id;
}

/* Reads one `data:` frame off a live stream, then hangs up. Resolves null
   if nothing arrives inside the window — which is what "heard nothing"
   has to look like for the isolation test to mean anything. */
function listen(ticket, ms) {
  ms = ms || 4000;
  return new Promise(function (resolve) {
    const ctl = new AbortController();
    const timer = setTimeout(function () { ctl.abort(); resolve(null); }, ms);
    fetch(base + '/api/events?ticket=' + encodeURIComponent(ticket), { signal: ctl.signal })
      .then(async function (res) {
        if (!res.ok) { clearTimeout(timer); ctl.abort(); return resolve({ status: res.status }); }
        const reader = res.body.getReader();
        let buf = '';
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += Buffer.from(chunk.value).toString('utf8');
          const line = buf.split('\n').find(function (l) { return l.indexOf('data: ') === 0; });
          if (line) {
            clearTimeout(timer);
            ctl.abort();
            return resolve(JSON.parse(line.slice(6)));
          }
        }
        clearTimeout(timer);
        resolve(null);
      })
      .catch(function () { clearTimeout(timer); resolve(null); });
  });
}
const settle = (ms) => new Promise(r => setTimeout(r, ms || 300));

test('a ticket is required, and a JWT is never accepted as one', async () => {
  const ada = await signUp('ada-live@example.com');
  assert.equal((await api('/api/events')).status, 401, 'no ticket');
  assert.equal((await api('/api/events?ticket=nonsense')).status, 401, 'made-up ticket');
  /* The whole reason the ticket exists: a token in a URL gets logged. */
  assert.equal((await api('/api/events?ticket=' + ada.token)).status, 401, 'a JWT is not a ticket');
});

test('minting a ticket needs a real session', async () => {
  assert.equal((await api('/api/events/ticket', { method: 'POST' })).status, 401);
  const ada = await signUp('ada2-live@example.com');
  const r = await api('/api/events/ticket', { method: 'POST', token: ada.token });
  assert.equal(r.status, 200);
  assert.match(r.body.ticket, /^[0-9a-f]{32}$/);
});

test('a ticket dies on first use', async () => {
  const ada = await signUp('ada3-live@example.com');
  const t = await mintTicket(ada.token);
  const held = listen(t, 1500);
  await settle();
  assert.equal((await api('/api/events?ticket=' + t)).status, 401, 'the same ticket cannot be reused');
  await held;
});

test('an admin reply reaches that customer, and nobody else', async () => {
  const ada = await signUp('ada4-live@example.com');
  const bob = await signUp('bob-live@example.com');
  const id = await placeAndOpen(ada.user.id, 'ENL-LIVE1', ada.token);

  const adaHears = listen(await mintTicket(ada.token));
  const bobHears = listen(await mintTicket(bob.token), 2500);
  await settle();

  const admin = await adminToken();
  await api('/api/admin/disputes/' + id + '/messages', {
    method: 'POST', token: admin, body: { message: 'On it.' }
  });

  const heard = await adaHears;
  assert.ok(heard, 'the customer heard something');
  assert.equal(heard.type, 'dispute-reply');
  assert.equal(heard.orderId, 'ENL-LIVE1');
  assert.equal(await bobHears, null, 'another customer heard nothing');
});

test('a customer reply reaches the owner', async () => {
  const cara = await signUp('cara-live@example.com');
  const id = await placeAndOpen(cara.user.id, 'ENL-LIVE2', cara.token);

  const admin = await adminToken();
  const ownerHears = listen(await mintTicket(admin));
  await settle();

  await api('/api/disputes/' + id + '/messages', {
    method: 'POST', token: cara.token, body: { message: 'Any news?' }
  });

  const heard = await ownerHears;
  assert.ok(heard, 'the owner heard something');
  assert.equal(heard.type, 'dispute-message');
  assert.equal(heard.orderId, 'ENL-LIVE2');
});

test('a dead stream never breaks the write that triggered it', async () => {
  const dave = await signUp('dave-live@example.com');
  const id = await placeAndOpen(dave.user.id, 'ENL-LIVE3', dave.token);

  /* Open a stream and abandon it, so the server is holding a socket that is
     going away underneath it. The reply must still be saved — the broadcast
     is a courtesy on top of work that has already happened. */
  listen(await mintTicket(dave.token), 200);
  await settle(400);

  const admin = await adminToken();
  const reply = await api('/api/admin/disputes/' + id + '/messages', {
    method: 'POST', token: admin, body: { message: 'Still here.' }
  });
  assert.equal(reply.status, 200, 'the reply was saved regardless of the stream');
});
