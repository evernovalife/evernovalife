/* ============================================================
   EVER NOVA LIFE — agent endpoint tests
   These three routes are the only surface the chat agent can
   reach. Two properties matter more than the happy paths: an
   unauthenticated caller gets nothing, and a tampered webhook
   body is never stored.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-agent-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-agent';
process.env.ALLOWED_ORIGINS = '*';
process.env.ELEVENLABS_AGENT_SECRET = 'agent-shared-secret';
process.env.ELEVENLABS_WEBHOOK_SECRET = 'webhook-hmac-secret';

const app = require('../server.js');
const inbox = require('../inbox.js');
const productStore = require('../products.js');

let server, base;
const AGENT = { 'Content-Type': 'application/json', 'x-agent-secret': 'agent-shared-secret' };

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) { server.close(); await once(server, 'close'); }
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('product lookup needs the shared secret', async () => {
  const res = await fetch(`${base}/api/agent/product?q=bpc`);
  assert.strictEqual(res.status, 401);
});

test('product lookup returns live catalog rows, capped at five', async () => {
  const res = await fetch(`${base}/api/agent/product?q=`, { headers: AGENT });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.products));
  // The seeded catalog ships 9 products, all published — an unfiltered read
  // returns more than 5, so this is exactly 5 only if the cap actually ran.
  assert.strictEqual(data.products.length, 5);
  if (data.products.length) {
    const p = data.products[0];
    assert.strictEqual(typeof p.name, 'string');
    assert.strictEqual(typeof p.price, 'number');
    assert.strictEqual(typeof p.inStock, 'boolean');
    // Nothing about who bought what may cross this boundary.
    assert.strictEqual(p.orders, undefined);
  }
});

test('an unpublished product never reaches the agent', async () => {
  // published:true is the visible one; published:false is a draft/pulled
  // listing — "not on the site at all" per products.js — and must not be
  // quoted a price or handed a live product.html link by the chat agent.
  const visible = productStore.addProduct({ name: 'Agent Visible Peptide', price: 42, published: true });
  const hidden = productStore.addProduct({ name: 'Agent Hidden Peptide', price: 42, published: false });

  const res = await fetch(`${base}/api/agent/product?q=Agent`, { headers: AGENT });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  const names = data.products.map(p => p.name);
  assert.ok(names.includes(visible.name), 'the published product should be found');
  assert.ok(!names.includes(hidden.name), 'the unpublished product must not be found');
  assert.ok(!data.products.some(p => p.id === hidden.id), 'the unpublished product id must not appear at all');
});

test('escalate needs the shared secret', async () => {
  const res = await fetch(`${base}/api/agent/escalate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'x@example.com', body: 'help' })
  });
  assert.strictEqual(res.status, 401);
});

test('escalate opens a thread and hands back a reference the agent can read out', async () => {
  const res = await fetch(`${base}/api/agent/escalate`, {
    method: 'POST',
    headers: AGENT,
    body: JSON.stringify({
      email: 'Visitor@Example.com',
      name: 'Sam',
      subject: 'Shipping to Texas',
      body: 'I could not answer whether we ship to Texas.',
      transcript: [{ role: 'user', text: 'do you ship to texas', at: '2026-08-24T10:00:00.000Z' }]
    })
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.match(data.reference, /^MSG-/);
  assert.strictEqual(typeof data.message, 'string');

  const t = inbox.get(data.reference);
  assert.strictEqual(t.email, 'visitor@example.com');
  assert.strictEqual(t.status, 'awaiting_us');
  assert.strictEqual(t.transcript.length, 1);
});

test('escalate refuses a bad address with a sentence the agent can say', async () => {
  const res = await fetch(`${base}/api/agent/escalate`, {
    method: 'POST',
    headers: AGENT,
    body: JSON.stringify({ email: 'not-an-email', body: 'help' })
  });
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(typeof data.error, 'string');
  assert.ok(data.error.length > 0);
});

test('requireAgent rejects a byte-length mismatch with 401, not a thrown 500', async () => {
  // 'agent-shared-secret' is 20 UTF-16 code units. This probe is also 20 code
  // units (each 'é' is one code unit) but 40 UTF-8 bytes — same JS .length,
  // different Buffer length. A guard comparing string .length instead of
  // buffer byte length would let this reach crypto.timingSafeEqual, which
  // throws on a buffer-length mismatch rather than returning false.
  const probe = 'é'.repeat('agent-shared-secret'.length);
  assert.strictEqual(probe.length, 'agent-shared-secret'.length);
  assert.notStrictEqual(Buffer.byteLength(probe), Buffer.byteLength('agent-shared-secret'));
  const res = await fetch(`${base}/api/agent/product?q=`, { headers: { 'x-agent-secret': probe } });
  assert.strictEqual(res.status, 401);
});

function signed(bodyString, secret, timestamp) {
  const t = timestamp || Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', secret).update(`${t}.${bodyString}`).digest('hex');
  return `t=${t},v0=${mac}`;
}

test('a correctly signed transcript is stored', async () => {
  const body = JSON.stringify({ conversation_id: 'conv_1', transcript: [{ role: 'user', message: 'hi' }] });
  const res = await fetch(`${base}/api/agent/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'elevenlabs-signature': signed(body, 'webhook-hmac-secret') },
    body
  });
  assert.strictEqual(res.status, 200);
  const files = fs.readdirSync(path.join(TMP_DATA, 'agent-transcripts'));
  assert.ok(files.some(f => f.includes('conv_1')), 'the conversation should be on disk');
});

test('a tampered transcript is rejected and never stored', async () => {
  const body = JSON.stringify({ conversation_id: 'conv_evil', transcript: [] });
  const sig = signed('{"conversation_id":"something-else"}', 'webhook-hmac-secret');
  const res = await fetch(`${base}/api/agent/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'elevenlabs-signature': sig },
    body
  });
  assert.strictEqual(res.status, 401);
  const dir = path.join(TMP_DATA, 'agent-transcripts');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.ok(!files.some(f => f.includes('conv_evil')), 'a tampered body must never reach disk');
});

test('a transcript with a stale timestamp is rejected and never stored', async () => {
  const body = JSON.stringify({ conversation_id: 'conv_stale', transcript: [] });
  const twoHoursAgo = Math.floor(Date.now() / 1000) - (2 * 60 * 60);
  const res = await fetch(`${base}/api/agent/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'elevenlabs-signature': signed(body, 'webhook-hmac-secret', twoHoursAgo) },
    body
  });
  assert.strictEqual(res.status, 401);
  const dir = path.join(TMP_DATA, 'agent-transcripts');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.ok(!files.some(f => f.includes('conv_stale')), 'a stale-timestamp body must never reach disk');
});

test('a transcript with no signature at all is rejected', async () => {
  const res = await fetch(`${base}/api/agent/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: 'conv_none' })
  });
  assert.strictEqual(res.status, 401);
});
