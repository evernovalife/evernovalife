/* ============================================================
   EVER NOVA LIFE — authorization tests
   Verifies that private/account/admin endpoints are enforced
   SERVER-SIDE: anonymous callers get 401, ordinary users can't
   reach admin tools, one user can't read another's data, and
   password hashes are never returned.

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

// ---- configure the environment BEFORE requiring the app ----
// auth.js reads JWT_SECRET / ADMIN_EMAILS at module load, so set them first.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-authz-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-authz';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
process.env.ELEVENLABS_AGENT_SECRET = 'test-agent-secret';
delete process.env.ADMIN_KEY; // exercise account-based admin only

const app = require('../server.js');
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

/* registerLimiter/loginLimiter count per IP/email, and every request in this
   file comes from 127.0.0.1 in one process — so without a reset, this file's
   own volume of test accounts would trip a control aimed at mass signup, not
   at a legitimate test run. */
test.beforeEach(() => ratelimit.reset());

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

async function register(email, password = 'password123', firstName = 'Test', lastName = 'User') {
  const r = await api('/api/auth/register', { method: 'POST', body: { firstName, lastName, email, password } });
  return r;
}
async function login(email, password = 'password123') {
  const r = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return r;
}

/* ============================================================
   1) Public endpoint stays public
   ============================================================ */
test('GET /api/products is public and returns the catalog', async () => {
  const { status, body } = await api('/api/products');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.products), 'products array present');
});

/* ============================================================
   2) Anonymous callers are rejected from every private endpoint
   ============================================================ */
test('anonymous users get 401 on all account/admin endpoints', async () => {
  const cases = [
    ['GET', '/api/auth/me'],
    ['GET', '/api/cart'],
    ['PUT', '/api/cart'],
    ['GET', '/api/orders'],
    ['GET', '/api/loyalty'],
    ['GET', '/api/referral'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/orders'],
    ['GET', '/api/disputes'],
    ['POST', '/api/disputes'],
    ['GET', '/api/admin/disputes'],
    ['POST', '/api/admin/disputes/DSP-NOPE/resolve'],
    ['POST', '/api/admin/disputes/sweep'],
    ['DELETE', '/api/admin/disputes/DSP-NOPE/attachments'],
    ['POST', '/api/admin/orders/ENL-NOPE/paid'],
    ['POST', '/api/admin/orders/ENL-NOPE/cancel'],
    ['POST', '/api/products'],
    ['DELETE', '/api/admin/users/does-not-exist'],
    ['PUT', '/api/products/1'],
    ['DELETE', '/api/products/1'],
  ];
  for (const [method, pathname] of cases) {
    const { status, body } = await api(pathname, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(status, 401, `${method} ${pathname} should be 401, got ${status}`);
    assert.ok(!body || !body.success, `${method} ${pathname} must not succeed`);
  }
});

test('a malformed/garbage token is rejected', async () => {
  const { status } = await api('/api/cart', { token: 'not-a-real-token' });
  assert.equal(status, 401);
});

/* ============================================================
   3) A signed-in user can reach their own data (and no hash leaks)
   ============================================================ */
test('registered user can read their own profile; no password hash is returned', async () => {
  const reg = await register('alice@example.com');
  assert.equal(reg.status, 201);
  const token = reg.body.token;
  assert.ok(token, 'register returns a token');
  assert.ok(!('passwordHash' in reg.body.user), 'register does not leak passwordHash');

  const me = await api('/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'alice@example.com');
  assert.ok(!('passwordHash' in me.body.user), '/me does not leak passwordHash');
  assert.equal(me.body.user.isAdmin, false, 'ordinary user is not admin');
  assert.ok(me.body.user.referralCode && me.body.user.referralCode.length >= 6,
    'a new account is issued a referral code');
});

/* ============================================================
   3b) Loyalty + referral endpoints work for a signed-in user
   ============================================================ */
test('a signed-in user sees a zero loyalty balance and their referral code', async () => {
  const { body } = await login('alice@example.com');
  const token = body.token;

  const loy = await api('/api/loyalty', { token });
  assert.equal(loy.status, 200);
  assert.equal(loy.body.balance, 0, 'new account starts at 0 points');
  assert.ok(Array.isArray(loy.body.ledger), 'ledger is an array');
  assert.ok(loy.body.perDollar >= 0 && loy.body.valueCents >= 0, 'conversion rates present');

  const ref = await api('/api/referral', { token });
  assert.equal(ref.status, 200);
  assert.ok(ref.body.code && ref.body.code.length >= 6, 'referral code returned');
  assert.match(ref.body.link, /register\.html\?ref=/, 'invite link points at register with the code');
  assert.equal(ref.body.referredCount, 0, 'no referrals yet');
});

test('a user can save and read back their own cart', async () => {
  const { body } = await login('alice@example.com');
  const token = body.token;
  const put = await api('/api/cart', { method: 'PUT', token, body: { items: [{ id: 1, name: 'Retatrutide', price: 109.99, quantity: 2 }] } });
  assert.equal(put.status, 200);
  const get = await api('/api/cart', { token });
  assert.equal(get.status, 200);
  assert.equal(get.body.items.length, 1);
  assert.equal(get.body.items[0].id, 1);
});

/* ============================================================
   4) An ordinary user cannot reach admin tools
   ============================================================ */
test('a non-admin authenticated user is denied admin endpoints', async () => {
  const { body } = await login('alice@example.com');
  const token = body.token;

  const users = await api('/api/admin/users', { token });
  assert.equal(users.status, 401, 'non-admin cannot list users');

  const addProduct = await api('/api/products', { method: 'POST', token, body: { name: 'Hacked', price: 1 } });
  assert.equal(addProduct.status, 401, 'non-admin cannot add products');

  const del = await api('/api/admin/users/whatever', { method: 'DELETE', token });
  assert.equal(del.status, 401, 'non-admin cannot delete users');
});

/* ============================================================
   5) One user cannot read another user's cart (data isolation)
   ============================================================ */
test('a second user does not see the first user\'s cart', async () => {
  const reg = await register('bob@example.com');
  assert.equal(reg.status, 201);
  const token = reg.body.token;
  const get = await api('/api/cart', { token });
  assert.equal(get.status, 200);
  assert.equal(get.body.items.length, 0, "Bob's cart is empty — he cannot see Alice's items");
});

/* ============================================================
   6) The admin account (by ADMIN_EMAILS) can use admin tools
   ============================================================ */
test('the admin account can list users, and no hashes are exposed', async () => {
  const reg = await register('boss@evernovalife.com', 'adminpass123', 'Boss', 'Admin');
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.isAdmin, true, 'ADMIN_EMAILS account is flagged isAdmin');
  const token = reg.body.token;

  const users = await api('/api/admin/users', { token });
  assert.equal(users.status, 200, 'admin can list users');
  assert.ok(Array.isArray(users.body.users));
  for (const u of users.body.users) {
    assert.ok(!('passwordHash' in u), 'admin user listing never contains passwordHash');
  }
});

test('the admin account can create a product', async () => {
  const { body } = await login('boss@evernovalife.com', 'adminpass123');
  const token = body.token;
  const add = await api('/api/products', { method: 'POST', token, body: { name: 'Test Reagent', price: 5, category: 'metabolic' } });
  assert.equal(add.status, 201, 'admin can add a product');
  assert.equal(add.body.product.name, 'Test Reagent');
});

/* ---- promotions ----
   Reading which deals are running is public (the storefront needs it to badge
   a product). Writing one changes what every customer is charged, so it is
   admin-only — and a scheduled campaign must not leak before it starts. */
test('anyone may read the running promotions', async () => {
  const res = await api('/api/promotions');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.promotions));
});

test('an ordinary user cannot create, list-all or delete a promotion', async () => {
  const user = await register('promo-user@example.com');
  const token = user.body.token;

  // requireAdmin answers 401 for an authenticated non-admin (see "a non-admin
  // authenticated user is denied admin endpoints" above) — same convention here.
  const create = await api('/api/admin/promotions', {
    method: 'POST', token,
    body: { name: 'Free money', type: 'cart', mode: 'percent', value: 100 }
  });
  assert.strictEqual(create.status, 401);

  const listAll = await api('/api/admin/promotions', { token });
  assert.strictEqual(listAll.status, 401);

  const del = await api('/api/admin/promotions/free-money', { method: 'DELETE', token });
  assert.strictEqual(del.status, 401);
});

test('an anonymous caller cannot create a promotion', async () => {
  const res = await api('/api/admin/promotions', {
    method: 'POST',
    body: { name: 'Free money', type: 'cart', mode: 'percent', value: 100 }
  });
  assert.ok(res.status === 401 || res.status === 403);
});

/* ============================================================
   The chat agent's account context
   ============================================================ */

/* Like api(), but for the agent's own routes: the shared secret proves the
   caller is our agent, and x-account-token says who it is talking to. */
async function agentApi(pathname, { secret = 'test-agent-secret', accountToken, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['x-agent-secret'] = secret;
  if (accountToken !== undefined) headers['x-account-token'] = accountToken;
  const res = await fetch(base + pathname, {
    method: 'POST', headers, body: JSON.stringify(body || {})
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* no JSON body */ }
  return { status: res.status, body: parsed };
}

/* A registered account plus a freshly minted agent token for it. */
async function signedInWithAgentToken(email, firstName = 'Sam') {
  const reg = await register(email, 'password123', firstName, 'Tester');
  const mint = await api('/api/agent/account-token', { method: 'POST', token: reg.body.token });
  return { sessionToken: reg.body.token, agentToken: mint.body.token, mint };
}

test('a signed-in browser can mint an agent token, and an anonymous one cannot', async () => {
  const { mint } = await signedInWithAgentToken('agent-mint@example.com', 'Sam');
  assert.strictEqual(mint.status, 200);
  assert.ok(mint.body.token, 'a token should come back');
  assert.strictEqual(mint.body.ttl, 1800);
  assert.strictEqual(mint.body.firstName, 'Sam');

  const anon = await api('/api/agent/account-token', { method: 'POST' });
  assert.strictEqual(anon.status, 401);
});

test('the minted agent token cannot be spent as a session token', async () => {
  const { agentToken } = await signedInWithAgentToken('agent-replay@example.com');
  // Two ordinary account routes, both behind requireAuth. Neither may open.
  const orders = await api('/api/orders', { token: agentToken });
  assert.strictEqual(orders.status, 401);
  const cart = await api('/api/cart', { token: agentToken });
  assert.strictEqual(cart.status, 401);
});

test('the account endpoint needs BOTH the shared secret and a valid account token', async () => {
  const { agentToken } = await signedInWithAgentToken('agent-both@example.com');

  // Right token, no shared secret.
  const noSecret = await agentApi('/api/agent/account', { secret: null, accountToken: agentToken });
  assert.strictEqual(noSecret.status, 401);

  // Right token, wrong shared secret.
  const wrongSecret = await agentApi('/api/agent/account', { secret: 'wrong-secret', accountToken: agentToken });
  assert.strictEqual(wrongSecret.status, 401);

  // Right shared secret, no account token.
  const noToken = await agentApi('/api/agent/account', {});
  assert.strictEqual(noToken.status, 401);

  // Right shared secret, a session token where an account token belongs.
  const { sessionToken } = await signedInWithAgentToken('agent-session-swap@example.com');
  const swapped = await agentApi('/api/agent/account', { accountToken: sessionToken });
  assert.strictEqual(swapped.status, 401);

  // Both correct.
  const ok = await agentApi('/api/agent/account', { accountToken: agentToken });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.customer.firstName, 'Sam');
  assert.ok(Array.isArray(ok.body.orders));
});

test('one customer\'s agent token never returns another customer\'s orders', async () => {
  const alice = await signedInWithAgentToken('agent-alice@example.com', 'Alice');
  const bob = await signedInWithAgentToken('agent-bob@example.com', 'Bob');

  const asAlice = await agentApi('/api/agent/account', { accountToken: alice.agentToken });
  assert.strictEqual(asAlice.status, 200);
  assert.strictEqual(asAlice.body.customer.firstName, 'Alice');

  const asBob = await agentApi('/api/agent/account', { accountToken: bob.agentToken });
  assert.strictEqual(asBob.body.customer.firstName, 'Bob');
});

test('nothing in the request body can steer which account is read', async () => {
  const alice = await signedInWithAgentToken('agent-steer-a@example.com', 'Alice');
  const bob = await signedInWithAgentToken('agent-steer-b@example.com', 'Bob');

  // Bob's token, Alice's identifiers in the body. The token wins, every time.
  const res = await agentApi('/api/agent/account', {
    accountToken: bob.agentToken,
    body: { userId: 'anything', email: 'agent-steer-a@example.com', orderId: 'ENL-AAAAAAAA' }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.customer.firstName, 'Bob');
});

test('an expired account token is refused with a sentence the agent can read out', async () => {
  const jwtLib = require('jsonwebtoken');
  const stale = jwtLib.sign({ sub: 'u_nobody', scope: 'agent-read' }, process.env.JWT_SECRET, { expiresIn: '-1s' });
  const res = await agentApi('/api/agent/account', { accountToken: stale });
  assert.strictEqual(res.status, 401);
  assert.match(res.body.error, /sign in again/i);
});

test('at most the ten most recent orders come back, newest first', async () => {
  const reg = await register('agent-cap@example.com');
  const userId = reg.body.user.id;
  const mint = await api('/api/agent/account-token', { method: 'POST', token: reg.body.token });

  /* Seeded through the store directly rather than through checkout: a real
     order needs a live payment provider, and what is under test here is the
     cap and the ordering, not how an order comes into being. Same process,
     same DATA_DIR, so this is the store the app is reading. */
  const store = require('../store.js');
  for (let n = 1; n <= 12; n++) {
    store.addOrder(userId, {
      orderId: 'ENL-CAP' + String(n).padStart(5, '0'),
      createdAt: '2026-08-' + String(n).padStart(2, '0') + 'T00:00:00.000Z',
      status: 'paid',
      method: 'crypto',
      items: [{ id: 1, name: 'Test item', unitPrice: 10, quantity: 1, lineTotal: 10 }],
      total: 10,
      email: 'agent-cap@example.com',
      shippingAddress: null
    });
  }

  const res = await agentApi('/api/agent/account', { accountToken: mint.body.token });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.orders.length, 10);
  assert.strictEqual(res.body.orders[0].orderId, 'ENL-CAP00012');
  assert.strictEqual(res.body.orders[9].orderId, 'ENL-CAP00003');
});

test('no street address appears anywhere in the account response', async () => {
  const reg = await register('agent-address@example.com');
  const userId = reg.body.user.id;
  const mint = await api('/api/agent/account-token', { method: 'POST', token: reg.body.token });

  /* Seeded directly through the store, like the order-cap test above — a real
     order needs a live payment provider, and what this test needs is a real
     STREET ADDRESS actually present in the record the endpoint reads from.
     Without this, a freshly registered account with no orders has no
     address-shaped data anywhere, and the scan below would pass against an
     empty response no matter what the endpoint does with a real one. */
  const store = require('../store.js');
  store.addOrder(userId, {
    orderId: 'ENL-ADDR00001',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'paid',
    method: 'crypto',
    items: [{ id: 1, name: 'Test item', unitPrice: 10, quantity: 1, lineTotal: 10 }],
    total: 10,
    email: 'agent-address@example.com',
    shippingAddress: { line1: '9 Nowhere Lane', city: 'Austin', state: 'TX', country: 'US' }
  });

  const res = await agentApi('/api/agent/account', { accountToken: mint.body.token });
  assert.strictEqual(res.status, 200);
  const text = JSON.stringify(res.body);

  /* Key-name scan: catches the street line coming back under its own field
     name, wherever in the response shape that happens. */
  assert.ok(!/"(address1|address2|street|line1|line2)"/i.test(text),
    'the response must not carry a street-address field, under any name');

  /* Value scan: catches the same leak under a RENAMED field, which the
     key-name scan above cannot — a later change that starts returning
     `line1`'s value under some new key would still fail here. City/state are
     expected to survive (agentPlace() keeps them for "where is my package");
     only the street line must be gone. */
  assert.ok(!text.includes('9 Nowhere Lane'),
    'the response must not carry the street-address value anywhere');
  assert.ok(text.includes('Austin') && text.includes('TX'),
    'the response should still carry the destination city/state');
});

test('the account response carries points, auto-ship and the cart', async () => {
  const { sessionToken, agentToken } = await signedInWithAgentToken('agent-full@example.com');

  // Put something in the cart through the ordinary route first.
  const products = await api('/api/products');
  const first = products.body.products[0];
  await api('/api/cart', {
    method: 'PUT', token: sessionToken,
    body: { items: [{ id: first.id, name: first.name, price: first.price, quantity: 2 }] }
  });

  const res = await agentApi('/api/agent/account', { accountToken: agentToken });
  assert.strictEqual(res.status, 200);

  assert.strictEqual(typeof res.body.loyalty.points, 'number');
  assert.strictEqual(typeof res.body.loyalty.worth, 'number');
  assert.ok(Array.isArray(res.body.subscriptions));

  assert.strictEqual(res.body.cart.items.length, 1);
  assert.strictEqual(res.body.cart.items[0].quantity, 2);
  // Priced off the live catalogue, not off whatever the browser saved.
  assert.strictEqual(res.body.cart.items[0].unitPrice, first.price);
  assert.strictEqual(res.body.cart.subtotal, Math.round(first.price * 2 * 100) / 100);
});

test('a cart line the browser mispriced is corrected from the catalogue', async () => {
  const { sessionToken, agentToken } = await signedInWithAgentToken('agent-cart-price@example.com');
  const products = await api('/api/products');
  const first = products.body.products[0];

  // A browser claiming this costs a dollar. The agent must not repeat that.
  await api('/api/cart', {
    method: 'PUT', token: sessionToken,
    body: { items: [{ id: first.id, name: 'Something cheap', price: 1, quantity: 1 }] }
  });

  const res = await agentApi('/api/agent/account', { accountToken: agentToken });
  assert.strictEqual(res.body.cart.items[0].unitPrice, first.price);
  assert.strictEqual(res.body.cart.items[0].name, first.name);
});

test('a cart holding an unknown product still returns, flagged unavailable', async () => {
  const { sessionToken, agentToken } = await signedInWithAgentToken('agent-cart-ghost@example.com');
  await api('/api/cart', {
    method: 'PUT', token: sessionToken,
    body: { items: [{ id: 999999, name: 'Ghost', price: 10, quantity: 1 }] }
  });

  // buildOrder() would throw here. This endpoint must not.
  const res = await agentApi('/api/agent/account', { accountToken: agentToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.cart.items.length, 1);
  assert.strictEqual(res.body.cart.items[0].available, false);
});
