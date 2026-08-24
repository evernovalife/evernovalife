/* ============================================================
   EVER NOVA LIFE — knowledge-base route tests

   These routes hand ELEVENLABS_API_KEY-backed powers to the admin
   console: anyone who reaches them can rewrite what the agent
   tells customers. So the properties worth pinning are the
   boundary ones — non-admins get nothing, the key never appears in
   a response, and a vendor error is passed through as something
   the owner can act on rather than swallowed into a 500.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-agentkb-api-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-agent-kb';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
process.env.ELEVENLABS_API_KEY = 'super-secret-key-value';
process.env.ELEVENLABS_AGENT_ID = 'agent_test123';
delete process.env.ADMIN_KEY;

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

function stub(handler) {
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    // Let the test's own requests to our server through untouched.
    if (u.startsWith(base)) return real(url, opts);
    return handler(u, opts || {});
  };
  return () => { global.fetch = real; };
}
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const AGENT_DOC = { conversation_config: { agent: { prompt: { knowledge_base: [
  { type: 'url', name: 'returns.html', id: 'd1' }
] } } } };

async function adminToken() {
  await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Boss', lastName: 'Admin', email: 'boss@evernovalife.com', password: 'CorrectHorse9!' })
  });
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'boss@evernovalife.com', password: 'CorrectHorse9!' })
  });
  return (await res.json()).token;
}
async function plainToken() {
  await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'No', lastName: 'Body', email: 'nobody@example.com', password: 'CorrectHorse9!' })
  });
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'CorrectHorse9!' })
  });
  return (await res.json()).token;
}

test('every knowledge route refuses an anonymous caller', async () => {
  const paths = [
    ['GET', '/api/admin/agent/knowledge'],
    ['POST', '/api/admin/agent/knowledge/text'],
    ['POST', '/api/admin/agent/knowledge/url'],
    ['POST', '/api/admin/agent/knowledge/file'],
    ['POST', '/api/admin/agent/knowledge/sync'],
    ['POST', '/api/admin/agent/knowledge/abc/refresh'],
    ['DELETE', '/api/admin/agent/knowledge/abc']
  ];
  for (const [method, p] of paths) {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' })
    });
    assert.strictEqual(res.status, 401, `${method} ${p} should be 401`);
  }
});

test('a signed-in non-admin is refused too', async () => {
  const token = await plainToken();
  const res = await fetch(`${base}/api/admin/agent/knowledge`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(res.status, 401);
});

test('an admin sees the document list, and the API key is not in it', async () => {
  const restore = stub(() => ok(AGENT_DOC));
  try {
    const token = await adminToken();
    const res = await fetch(`${base}/api/admin/agent/knowledge`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.text();
    assert.match(body, /returns\.html/);
    assert.ok(!body.includes('super-secret-key-value'), 'the API key must never reach the browser');
    assert.strictEqual(JSON.parse(body).configured, true);
  } finally { restore(); }
});

test('adding text reaches ElevenLabs and comes back with the document', async () => {
  const seen = [];
  const restore = stub((url, opts) => {
    seen.push(url);
    if (url.endsWith('/knowledge-base/text')) return ok({ id: 'new1' });
    if (/\/agents\//.test(url) && (!opts.method || opts.method === 'GET')) return ok(AGENT_DOC);
    return ok({});
  });
  try {
    const token = await adminToken();
    const res = await fetch(`${base}/api/admin/agent/knowledge/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Holiday hours', text: 'Closed on federal holidays.' })
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).document.name, 'Holiday hours');
    assert.ok(seen.some(u => u.endsWith('/knowledge-base/text')));
  } finally { restore(); }
});

test('an empty note is refused before any call goes out', async () => {
  let called = false;
  const restore = stub(() => { called = true; return ok({}); });
  try {
    const token = await adminToken();
    const res = await fetch(`${base}/api/admin/agent/knowledge/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Empty', text: '   ' })
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(called, false, 'nothing should be sent to the vendor');
  } finally { restore(); }
});

test('a bare filename is completed against our own site', async () => {
  let sentUrl = null;
  const restore = stub((url, opts) => {
    if (url.endsWith('/knowledge-base/url')) {
      sentUrl = JSON.parse(opts.body).url;
      return ok({ id: 'u1' });
    }
    if (/\/agents\//.test(url) && (!opts.method || opts.method === 'GET')) return ok(AGENT_DOC);
    return ok({});
  });
  try {
    const token = await adminToken();
    await fetch(`${base}/api/admin/agent/knowledge/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: 'faq.html' })
    });
    assert.match(sentUrl, /^https?:\/\/.+\/faq\.html$/);
  } finally { restore(); }
});

test("the vendor's own error text reaches the owner, not a generic 500", async () => {
  const restore = stub(() => ({
    ok: false, status: 401,
    text: async () => JSON.stringify({ detail: { message: 'missing the permission convai_write' } })
  }));
  try {
    const token = await adminToken();
    const res = await fetch(`${base}/api/admin/agent/knowledge`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 401);
    assert.match((await res.json()).error, /convai_write/);
  } finally { restore(); }
});

test('sync rebuilds both generated documents from live data', async () => {
  const uploaded = [];
  const restore = stub((url, opts) => {
    if (url.endsWith('/knowledge-base/text')) {
      uploaded.push(JSON.parse(opts.body).name);
      return ok({ id: 'g' + uploaded.length });
    }
    if (/\/agents\//.test(url) && (!opts.method || opts.method === 'GET')) return ok(AGENT_DOC);
    return ok({});
  });
  try {
    const token = await adminToken();
    const res = await fetch(`${base}/api/admin/agent/knowledge/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}'
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.match(data.stamp, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepStrictEqual(uploaded, ['Catalogue', 'Delivery and shipping']);
  } finally { restore(); }
});
