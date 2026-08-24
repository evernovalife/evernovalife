/* ============================================================
   EVER NOVA LIFE — agent knowledge-base tests

   The admin console can now add, refresh and remove the documents
   the chat agent answers from. Everything here goes out to
   ElevenLabs, so the network is stubbed: what is worth pinning is
   OUR side — that the API key never leaves the server, that only
   an admin can reach any of it, that an upload is actually
   attached to the agent rather than left orphaned in the account,
   and that the catalogue we generate says what we think it says.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-agentkb-'));
process.env.DATA_DIR = TMP_DATA;
process.env.ELEVENLABS_API_KEY = 'test-key-never-leaves-the-server';
process.env.ELEVENLABS_AGENT_ID = 'agent_test123';

const kb = require('../agent-knowledge.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ---- a tiny recording stub for global fetch ---- */
function stub(handler) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return handler(String(url), opts || {}, calls.length);
  };
  return { calls, restore: () => { global.fetch = real; } };
}
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('list returns the documents attached to the agent', async () => {
  const s = stub(() => ok({
    conversation_config: { agent: { prompt: { knowledge_base: [
      { type: 'url', name: 'returns.html', id: 'd1' },
      { type: 'text', name: 'Catalogue', id: 'd2' }
    ] } } }
  }));
  try {
    const docs = await kb.list();
    assert.strictEqual(docs.length, 2);
    assert.strictEqual(docs[0].name, 'returns.html');
    assert.match(s.calls[0].url, /\/v1\/convai\/agents\/agent_test123$/);
    assert.strictEqual(s.calls[0].opts.headers['xi-api-key'], 'test-key-never-leaves-the-server');
  } finally { s.restore(); }
});

test('adding text uploads AND attaches it — an unattached document is invisible', async () => {
  const s = stub((url, opts) => {
    if (url.endsWith('/knowledge-base/text')) return ok({ id: 'new1' });
    if (/\/agents\/agent_test123$/.test(url) && (!opts.method || opts.method === 'GET')) {
      return ok({ conversation_config: { agent: { prompt: { knowledge_base: [{ type: 'url', name: 'a', id: 'old' }] } } } });
    }
    return ok({});                                   // the PATCH
  });
  try {
    const doc = await kb.addText('Holiday hours', 'We are closed on federal holidays.');
    assert.strictEqual(doc.id, 'new1');

    const patch = s.calls.find(c => c.opts.method === 'PATCH');
    assert.ok(patch, 'the agent must be PATCHed, or the document is orphaned');
    const sent = JSON.parse(patch.opts.body).conversation_config.agent.prompt.knowledge_base;
    assert.strictEqual(sent.length, 2, 'the existing document must be kept');
    assert.ok(sent.some(d => d.id === 'new1'), 'the new document must be attached');
    assert.ok(sent.some(d => d.id === 'old'), 'the old document must survive');
  } finally { s.restore(); }
});

test('a file is decoded from base64 and sent as multipart', async () => {
  let body = null;
  const s = stub((url, opts) => {
    if (url.endsWith('/knowledge-base/file')) { body = opts.body; return ok({ id: 'f1' }); }
    if (/\/agents\//.test(url) && (!opts.method || opts.method === 'GET')) {
      return ok({ conversation_config: { agent: { prompt: { knowledge_base: [] } } } });
    }
    return ok({});
  });
  try {
    const base64 = Buffer.from('%PDF-1.4 pretend').toString('base64');
    const doc = await kb.addFile('handling.pdf', base64);
    assert.strictEqual(doc.id, 'f1');
    assert.ok(body instanceof FormData, 'files go as multipart, not JSON');
    // Content-Type must NOT be set by us — fetch writes the multipart boundary.
    const call = s.calls.find(c => String(c.url).endsWith('/knowledge-base/file'));
    assert.strictEqual(call.opts.headers['Content-Type'], undefined);
  } finally { s.restore(); }
});

test('remove detaches before deleting, so a failed delete still silences the document', async () => {
  const order = [];
  const s = stub((url, opts) => {
    if (/\/agents\//.test(url) && (!opts.method || opts.method === 'GET')) {
      return ok({ conversation_config: { agent: { prompt: { knowledge_base: [{ type: 'text', name: 'Gone', id: 'g1' }] } } } });
    }
    if (opts.method === 'PATCH') { order.push('detach'); return ok({}); }
    if (opts.method === 'DELETE') { order.push('delete'); return ok({}); }
    return ok({});
  });
  try {
    await kb.remove('g1');
    assert.deepStrictEqual(order, ['detach', 'delete']);
  } finally { s.restore(); }
});

test('remove refuses an id the agent does not have', async () => {
  const s = stub(() => ok({ conversation_config: { agent: { prompt: { knowledge_base: [] } } } }));
  try {
    await assert.rejects(() => kb.remove('nope'), /not/i);
  } finally { s.restore(); }
});

test('an ElevenLabs failure surfaces its own message, not a generic one', async () => {
  const s = stub(() => ({
    ok: false, status: 401,
    text: async () => JSON.stringify({ detail: { message: 'missing the permission convai_write' } })
  }));
  try {
    await assert.rejects(() => kb.list(), /convai_write/);
  } finally { s.restore(); }
});

/* ---- the generated documents ---- */
test('the catalogue names every published product and skips the rest', () => {
  const text = kb.buildCatalog([
    { name: 'Alpha', published: true, price: 10, quantity: '5mg', categoryName: 'Peptides', description: 'A.' },
    { name: 'Hidden', published: false, price: 20, categoryName: 'Peptides', description: 'B.' },
    { name: 'Beta', price: 30, categoryName: 'Blends', description: 'C.' }
  ], '2026-08-25');
  assert.match(text, /Alpha/);
  assert.match(text, /Beta/, 'a product with no published flag counts as published');
  assert.ok(!/Hidden/.test(text), 'unpublished products must never reach the agent');
  assert.match(text, /\$10\.00/);
  assert.match(text, /2026-08-25/, 'the snapshot must be dated');
  assert.match(text, /lookup_product/, 'it must tell the agent where the real price lives');
});

test('the catalogue carries no health claims', () => {
  const text = kb.buildCatalog(
    [{ name: 'Alpha', price: 10, categoryName: 'Peptides', description: 'A reference compound.' }],
    '2026-08-25'
  );
  assert.ok(!/dosage|dose|mg per kg|treat|cure|therapy|safe for human/i.test(text));
  assert.match(text, /research use only/i);
});

test('delivery lists enabled methods and omits disabled ones', () => {
  const text = kb.buildDelivery({ methods: [
    { name: 'Standard', price: 9.99, eta: '3–5 business days', freeOver: 100, enabled: true },
    { name: 'Retired', price: 4.99, enabled: false }
  ] }, '2026-08-25');
  assert.match(text, /Standard/);
  assert.match(text, /\$9\.99/);
  assert.match(text, /\$100\.00/);
  assert.ok(!/Retired/.test(text));
});

test('the agent id comes from the environment when set', () => {
  assert.strictEqual(kb.agentId(), 'agent_test123');
});
