/* ============================================================
   EVER NOVA LIFE — shipping-label design tests

   Two things have to hold about the label store:

     · it is ADMIN-ONLY IN BOTH DIRECTIONS. It holds the store's
       own street address, which the site deliberately publishes
       nowhere, so a customer must not be able to read it — let
       alone edit the label every parcel goes out with.
     · a saved design must be PRINTABLE. A preset size can never
       be stored next to contradicting dimensions (the printer
       would silently crop), and the numbers stay inside ranges
       that leave room to print on.

   Runs with the built-in Node test runner:
       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-label-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-label';
process.env.ALLOWED_ORIGINS = '*';
process.env.ADMIN_EMAILS = 'boss-label@example.com';
process.env.SUBSCRIPTION_INPROCESS_CRON = '0';
delete process.env.ADMIN_KEY;

const app = require('../server.js');

let server, base, boss, customer;

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  boss = (await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'Boss', lastName: 'Label', email: 'boss-label@example.com', password: 'password123' }
  })).body;
  customer = (await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'Cust', lastName: 'Label', email: 'cust-label@example.com', password: 'password123' }
  })).body;
});

test.after(async () => {
  if (server) { server.close(); await once(server, 'close'); }
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('the default label is a 4×6 with every block on', async () => {
  const res = await api('/api/admin/label-design', { token: boss.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.design.size, '4x6');
  assert.equal(res.body.design.widthMm, 101.6);
  assert.equal(res.body.design.heightMm, 152.4);
  assert.equal(res.body.design.showBarcode, true);
  // The customer's email is the one block that starts off — a parcel passes
  // through many hands.
  assert.equal(res.body.design.showEmail, false);
  assert.ok(res.body.sizes['4x6'], 'the size list rides along for the picker');
});

test('a customer can neither read nor change the label', async () => {
  const read = await api('/api/admin/label-design', { token: customer.token });
  assert.equal(read.status, 401, 'the return address is not customer-readable');

  const write = await api('/api/admin/label-design', {
    method: 'PUT', token: customer.token, body: { handling: 'STEAL ME' }
  });
  assert.equal(write.status, 401);

  const anon = await api('/api/admin/label-design');
  assert.equal(anon.status, 401);

  const after = await api('/api/admin/label-design', { token: boss.token });
  assert.equal(after.body.design.handling, '', 'nothing the customer sent was stored');
});

test('a saved design survives and is merged, not replaced wholesale', async () => {
  const saved = await api('/api/admin/label-design', {
    method: 'PUT', token: boss.token,
    body: {
      from: { name: 'Ever Nova Life', line1: '1 Lab Way', city: 'Austin', state: 'TX', postalCode: '78701' },
      handling: 'DO NOT FREEZE',
      showItems: false
    }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.design.from.line1, '1 Lab Way');
  assert.equal(saved.body.design.handling, 'DO NOT FREEZE');
  assert.equal(saved.body.design.showItems, false);
  assert.equal(saved.body.design.showBarcode, true, 'untouched settings keep their value');

  // A partial edit must not wipe the address typed in the edit before it.
  const patched = await api('/api/admin/label-design', {
    method: 'PUT', token: boss.token, body: { showItems: true }
  });
  assert.equal(patched.body.design.from.line1, '1 Lab Way');
  assert.equal(patched.body.design.showItems, true);

  const reread = await api('/api/admin/label-design', { token: boss.token });
  assert.equal(reread.body.design.from.city, 'Austin', 'it is on disk, not in memory');
});

test('a preset size fixes its own dimensions; only custom can set them', async () => {
  // Lying about a preset's size would print a 4×6 layout onto 4×4 stock.
  const preset = await api('/api/admin/label-design', {
    method: 'PUT', token: boss.token, body: { size: '4x4', widthMm: 999, heightMm: 12 }
  });
  assert.equal(preset.body.design.widthMm, 101.6);
  assert.equal(preset.body.design.heightMm, 101.6);

  const custom = await api('/api/admin/label-design', {
    method: 'PUT', token: boss.token, body: { size: 'custom', widthMm: 80, heightMm: 120 }
  });
  assert.equal(custom.body.design.widthMm, 80);
  assert.equal(custom.body.design.heightMm, 120);

  // Out-of-range custom dimensions fall back rather than producing a label
  // the printer cannot feed.
  const silly = await api('/api/admin/label-design', {
    method: 'PUT', token: boss.token, body: { size: 'custom', widthMm: 5000, heightMm: -3 }
  });
  assert.equal(silly.body.design.widthMm, 305);
  assert.equal(silly.body.design.heightMm, 40);

  const unknown = await api('/api/admin/label-design', {
    method: 'PUT', token: boss.token, body: { size: 'billboard' }
  });
  assert.equal(unknown.body.design.size, '4x6');
});

test('type scale and margin stay inside printable limits', async () => {
  const res = await api('/api/admin/label-design', {
    method: 'PUT', token: boss.token, body: { size: '4x6', fontScale: 9, paddingMm: 90 }
  });
  assert.equal(res.body.design.fontScale, 1.6);
  assert.ok(res.body.design.paddingMm <= 20 && res.body.design.paddingMm > 0,
    `padding clamped, got ${res.body.design.paddingMm}`);
});

test('reset puts the default label back, address and all', async () => {
  const res = await api('/api/admin/label-design/reset', { method: 'POST', token: boss.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.design.from.line1, '');
  assert.equal(res.body.design.handling, '');
  assert.equal(res.body.design.size, '4x6');

  const denied = await api('/api/admin/label-design/reset', { method: 'POST', token: customer.token });
  assert.equal(denied.status, 401);
});

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: parsed };
}
