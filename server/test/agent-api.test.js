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
  assert.ok(data.products.length <= 5);
  if (data.products.length) {
    const p = data.products[0];
    assert.strictEqual(typeof p.name, 'string');
    assert.strictEqual(typeof p.price, 'number');
    assert.strictEqual(typeof p.inStock, 'boolean');
    // Nothing about who bought what may cross this boundary.
    assert.strictEqual(p.orders, undefined);
  }
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

test('a transcript with no signature at all is rejected', async () => {
  const res = await fetch(`${base}/api/agent/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: 'conv_none' })
  });
  assert.strictEqual(res.status, 401);
});
