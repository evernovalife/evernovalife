/* ============================================================
   EVER NOVA LIFE — what the chat agent knows

   Everything the admin console needs to manage the agent's
   knowledge base, and the two generated documents (catalogue,
   delivery) that are built from our own live data.

   All of it runs HERE rather than in the browser for one reason:
   ELEVENLABS_API_KEY can read and rewrite every agent on the
   account, so it must never be sent to a page. The console asks
   this server; this server asks ElevenLabs.

   Uploading a document and ATTACHING it to the agent are two
   separate calls, and a document that is uploaded but not
   attached looks exactly like a working one until you notice the
   agent never cites it. Every function here does both.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const API = 'https://api.elevenlabs.io';
const CONFIG_JS = path.join(__dirname, '..', 'js', 'config.js');

function err(message, status) {
  return Object.assign(new Error(message), { status: status || 400 });
}

/* The agent id is public — it sits in js/config.js and ships to every
   visitor. Prefer an env var so the server can be pointed at a staging
   agent, but fall back to the file so there is one less thing to set and
   no way for the console to manage a different agent than the site talks
   to. The comment block in config.js carries a placeholder example, hence
   the anchor: match the assignment at column 0, not the illustration. */
function agentId() {
  if (process.env.ELEVENLABS_AGENT_ID) return process.env.ELEVENLABS_AGENT_ID;
  let cfg;
  try { cfg = fs.readFileSync(CONFIG_JS, 'utf8'); }
  catch (e) { throw err('Cannot read js/config.js to find the agent id.', 500); }
  const m = /^window\.ENL_CHAT\s*=\s*\{[^}]*?agentId:\s*'([^']*)'/m.exec(cfg);
  if (!m || !m[1] || /^agent_x+$/i.test(m[1])) {
    throw err('The chat agent is not switched on yet — no agent id in js/config.js.', 409);
  }
  return m[1];
}

function configured() {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

async function call(method, endpoint, body, isForm) {
  if (!configured()) {
    throw err('ELEVENLABS_API_KEY is not set on this server, so the knowledge base cannot be reached.', 503);
  }
  const headers = { 'xi-api-key': process.env.ELEVENLABS_API_KEY };
  // Never set Content-Type for a FormData body — fetch has to write the
  // multipart boundary itself, and setting it strips that.
  if (body && !isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(API + endpoint, {
    method,
    headers,
    ...(body ? { body: isForm ? body : JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* keep the raw text */ }
  if (!res.ok) {
    const d = data && (data.detail || data.message);
    const detail = (d && (d.message || d)) || text || 'no detail';
    // The vendor's own words: "missing the permission convai_write" is
    // actionable, "the request failed" is not.
    throw err(`ElevenLabs said: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, res.status);
  }
  return data || {};
}

/* ---- the attached list ----
   Read-modify-write, because the API replaces the array wholesale. */
async function attachedList() {
  const agent = await call('GET', '/v1/convai/agents/' + encodeURIComponent(agentId()));
  const prompt = (((agent.conversation_config || {}).agent || {}).prompt) || {};
  return prompt.knowledge_base || [];
}

async function setAttached(list) {
  await call('PATCH', '/v1/convai/agents/' + encodeURIComponent(agentId()), {
    conversation_config: { agent: { prompt: { knowledge_base: list } } }
  });
}

async function attach(entry) {
  const list = await attachedList();
  if (list.some(d => d.id === entry.id)) return;
  await setAttached(list.concat([entry]));
}

async function list() {
  return attachedList();
}

function docId(doc) {
  const id = doc && (doc.id || doc.document_id);
  if (!id) throw err('ElevenLabs accepted the upload but returned no document id.', 502);
  return id;
}

function cleanName(name, fallback) {
  const s = String(name == null ? '' : name).trim().replace(/\s+/g, ' ').slice(0, 120);
  return s || fallback;
}

async function addUrl(url, name) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw err('That does not look like a web address.');
  const label = cleanName(name, target.replace(/^https?:\/\/[^/]+\//, '') || target);
  const doc = await call('POST', '/v1/convai/knowledge-base/url', { url: target, name: label });
  const id = docId(doc);
  await attach({ type: 'url', name: label, id, usage_mode: 'auto' });
  return { id, name: label, type: 'url' };
}

async function addText(name, text) {
  const body = String(text == null ? '' : text).trim();
  if (!body) throw err('Write something before saving it.');
  if (body.length > 200000) throw err('That is too long — keep a single document under 200,000 characters.');
  const label = cleanName(name, 'Untitled note');
  const doc = await call('POST', '/v1/convai/knowledge-base/text', { text: body, name: label });
  const id = docId(doc);
  await attach({ type: 'text', name: label, id, usage_mode: 'auto' });
  return { id, name: label, type: 'text' };
}

/* The browser reads the file to base64 and posts it as JSON — the same
   route dispute photos and product images already take, so there is no
   multipart parser on this server to add or maintain. It is decoded here
   and re-sent to ElevenLabs as a real multipart upload. */
async function addFile(name, base64) {
  const label = cleanName(name, 'document');
  let buf;
  try { buf = Buffer.from(String(base64 || ''), 'base64'); }
  catch (e) { throw err('That file could not be read.'); }
  if (!buf.length) throw err('That file is empty.');

  const form = new FormData();
  form.append('file', new Blob([buf]), label);
  form.append('name', label);
  const doc = await call('POST', '/v1/convai/knowledge-base/file', form, true);
  const id = docId(doc);
  await attach({ type: 'file', name: label, id, usage_mode: 'auto' });
  return { id, name: label, type: 'file', bytes: buf.length };
}

/* Detach first, delete second. If the delete fails the agent has already
   stopped answering from it, which is the half that matters. */
async function remove(id) {
  const list = await attachedList();
  const doc = list.find(d => d.id === id || d.name === id);
  if (!doc) throw err('The agent does not have that document.', 404);
  await setAttached(list.filter(d => d.id !== doc.id));
  await call('DELETE', '/v1/convai/knowledge-base/' + encodeURIComponent(doc.id));
  return { id: doc.id, name: doc.name };
}

/* A url document is a snapshot. Refreshing is remove-then-re-add, because
   there is no re-crawl endpoint. */
async function refresh(id) {
  const list = await attachedList();
  const doc = list.find(d => d.id === id || d.name === id);
  if (!doc) throw err('The agent does not have that document.', 404);
  if (doc.type !== 'url') {
    throw err(`"${doc.name}" is not a page — remove it and add the new version instead.`, 409);
  }
  const name = doc.name;
  const url = /^https?:\/\//i.test(name) ? name : `${siteBase()}/${name}`;
  await remove(doc.id);
  return addUrl(url, name);
}

function siteBase() {
  return (process.env.SITE_URL || 'https://evernovalife.com').replace(/\/+$/, '');
}

/* ============================================================
   The two generated documents

   Built from our own live data rather than written by hand, so they
   cannot drift from what the shop actually sells.
   ============================================================ */

const money = n => '$' + Number(n || 0).toFixed(2);

function buildCatalog(products, stamp) {
  const live = (products || []).filter(p => p && p.published !== false);
  const byCategory = {};
  live.forEach(p => {
    const key = p.categoryName || p.category || 'Other';
    (byCategory[key] = byCategory[key] || []).push(p);
  });

  let out = 'EVER NOVA LIFE — PRODUCT CATALOGUE\n';
  out += '==================================\n\n';
  out += 'Every item below is supplied for in-vitro laboratory research use only.\n';
  out += `This document was generated on ${stamp} and lists ${live.length} products.\n\n`;
  out += 'IMPORTANT: the prices and stock figures here are a snapshot taken on the\n';
  out += 'date above. Always call the lookup_product tool for the current price and\n';
  out += 'availability before telling a customer either one. Use this document to\n';
  out += 'know what exists and what it is, not to quote a number.\n';

  Object.keys(byCategory).sort().forEach(cat => {
    out += `\n\n${String(cat).toUpperCase()}\n${'-'.repeat(String(cat).length)}\n\n`;
    byCategory[cat].forEach(p => {
      out += `${p.name}\n`;
      if (p.description) out += `${p.description}\n`;
      const facts = [];
      if (p.quantity) facts.push(`Size: ${p.quantity}`);
      if (p.purity) facts.push(`Purity: ${p.purity}`);
      if (p.lot) facts.push(`Lot: ${p.lot}`);
      facts.push(`Price on ${stamp}: ${money(p.price)}`);
      if (p.originalPrice && p.originalPrice > p.price) facts.push(`was ${money(p.originalPrice)}`);
      const tracked = p.stockQty !== undefined && p.stockQty !== null && p.stockQty !== '';
      facts.push(p.inStock === false ? 'Not currently offered'
        : tracked ? `${p.stockQty} in stock on ${stamp}` : 'In stock');
      out += facts.join('. ') + '.\n';
      if (p.specs && Object.keys(p.specs).length) {
        out += 'Specifications: ' + Object.entries(p.specs).map(([k, v]) => `${k} ${v}`).join('; ') + '.\n';
      }
      if (p.coa && p.coa.status === 'available') {
        out += `A certificate of analysis is available${p.coa.lab ? `, tested by ${p.coa.lab}` : ''}. ` +
               'Ask for it by lot number.\n';
      }
      out += '\n';
    });
  });

  out += '\nWHAT IS NOT IN THIS DOCUMENT\n';
  out += '----------------------------\n';
  out += 'Anything unpublished or retired. If a customer asks about a product not\n';
  out += 'listed here and lookup_product does not find it either, say we do not\n';
  out += 'currently offer it rather than guessing.\n';
  return out;
}

function buildDelivery(shipping, stamp) {
  const methods = ((shipping || {}).methods || []).filter(m => m && m.enabled !== false);
  let out = 'EVER NOVA LIFE — DELIVERY AND SHIPPING\n';
  out += '=====================================\n\n';
  out += `Generated ${stamp}. These rates change rarely, but if a customer disputes\n`;
  out += 'one, say you will check rather than insisting.\n\n';

  if (!methods.length) {
    out += 'No shipping methods are currently enabled.\n';
    return out;
  }

  out += 'SHIPPING METHODS\n----------------\n\n';
  methods.forEach(m => {
    out += `${m.name}: ${money(m.price)}`;
    if (m.eta) out += `, arriving in ${m.eta}`;
    out += '.';
    if (m.freeOver) out += ` Free on orders over ${money(m.freeOver)}.`;
    out += '\n';
  });

  const free = methods.filter(m => m.freeOver).map(m => m.freeOver);
  if (free.length) out += `\nFree shipping applies once the order reaches ${money(Math.min(...free))}.\n`;

  out += '\nWHERE WE SHIP\n-------------\nUnited States only. We do not ship internationally.\n';
  out += '\nTRACKING AN ORDER\n-----------------\n';
  out += 'A signed-in customer\'s order can be read with the get_my_account tool —\n';
  out += 'use it rather than asking them for a reference they should not need.\n';
  out += 'Anyone not signed in goes to the order-status page on the site, where they\n';
  out += 'enter their order reference and the email address they used. If they cannot\n';
  out += 'find the reference, escalate to a person.\n';
  return out;
}

/* Replace both generated documents in one go. Removing first means running
   this twice leaves one copy of each rather than two that disagree. */
async function syncGenerated({ products, shipping }) {
  const stamp = new Date().toISOString().slice(0, 10);
  const wanted = [
    { name: 'Catalogue', text: buildCatalog(products, stamp) },
    { name: 'Delivery and shipping', text: buildDelivery(shipping, stamp) }
  ];
  const existing = await attachedList();
  for (const doc of wanted) {
    const old = existing.find(d => d.name === doc.name);
    if (old) { try { await remove(old.id); } catch (e) { /* already gone */ } }
  }
  const made = [];
  for (const doc of wanted) made.push(await addText(doc.name, doc.text));
  return { stamp, documents: made };
}

module.exports = {
  configured, agentId,
  list, addUrl, addText, addFile, remove, refresh,
  buildCatalog, buildDelivery, syncGenerated
};
