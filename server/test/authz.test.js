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
delete process.env.ADMIN_KEY; // exercise account-based admin only

const app = require('../server.js');

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
    ['GET', '/api/admin/users'],
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
  const add = await api('/api/products', { method: 'POST', token, body: { name: 'Test Reagent', price: 5, category: 'supplies' } });
  assert.equal(add.status, 201, 'admin can add a product');
  assert.equal(add.body.product.name, 'Test Reagent');
});
