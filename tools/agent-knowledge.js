#!/usr/bin/env node
/* ============================================================
   EVER NOVA LIFE — what the chat agent knows

   Add, list, refresh and remove the documents the agent answers
   from. Three ways in:

     add-page   a page on the live site, fetched by ElevenLabs
     add-text   something you type that isn't on the site at all
     add-file   a PDF, .txt or .md from your machine

   Uploading a document is only half the job — it also has to be
   ATTACHED to the agent, or it sits in the account unread. Every
   command here does both, which is the whole reason this script
   exists rather than a note saying "use the dashboard".

   Usage (agent id is read from js/config.js):

     node tools/agent-knowledge.js list
     node tools/agent-knowledge.js add-page returns.html
     node tools/agent-knowledge.js add-page https://example.com/x
     node tools/agent-knowledge.js add-text "Holiday hours" notes.txt
     node tools/agent-knowledge.js add-file docs/handling.pdf
     node tools/agent-knowledge.js refresh returns.html
     node tools/agent-knowledge.js remove "Holiday hours"

   NEVER add prices, stock levels or a product list. The agent is
   told to call lookup_product for those, and a catalogue in here
   could only ever go stale and contradict it.
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = 'https://api.elevenlabs.io';
const SITE = 'https://evernovalife.com';

(function loadEnv() {
  let raw;
  try { raw = fs.readFileSync(path.join(ROOT, 'server', '.env'), 'utf8'); }
  catch (e) { return; }
  raw.split(/\r?\n/).forEach(line => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) return;
    process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  });
}());

/* Throws rather than process.exit()ing: exiting hard while fetch still holds
   a keep-alive socket makes libuv assert on Windows, printing an alarming
   stack trace underneath an otherwise ordinary error message. main()'s catch
   prints it and sets a non-zero exit code. */
function die(message) { throw Object.assign(new Error(message), { expected: true }); }

/* The agent id lives in js/config.js — the same value the site loads, so
   this script can never act on a different agent than the one your
   visitors are talking to. */
function agentId() {
  const cfg = fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8');
  // Match the ASSIGNMENT, not any `agentId:` in the doc comment above it —
  // that comment carries a placeholder example, and a looser pattern picks
  // it up and cheerfully talks to an agent that does not exist.
  const m = /^window\.ENL_CHAT\s*=\s*\{[^}]*?agentId:\s*'([^']*)'/m.exec(cfg);
  if (!m || !m[1]) die('No agentId set in js/config.js — the chat is not switched on yet.');
  if (/^agent_x+$/i.test(m[1])) die('js/config.js still holds the placeholder agent id.');
  return m[1];
}

async function call(method, endpoint, body, isForm) {
  const headers = { 'xi-api-key': process.env.ELEVENLABS_API_KEY };
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + endpoint, {
    method,
    headers,
    ...(body ? { body: isForm ? body : JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* keep raw */ }
  if (!res.ok) {
    const d = (data && (data.detail || data.message)) || text || '(no body)';
    die(`${method} ${endpoint} → ${res.status}\n  ${typeof d === 'string' ? d : JSON.stringify(d, null, 2)}`);
  }
  return data;
}

/* ---- the agent's attached list ----
   Read-modify-write, because the API replaces the array wholesale. Doing
   this in two steps means a crash between them leaves the document
   uploaded but unattached — which `list` will show you, rather than it
   failing silently. */
async function getAttached() {
  const agent = await call('GET', '/v1/convai/agents/' + agentId());
  const prompt = agent.conversation_config.agent.prompt;
  return { agent, list: prompt.knowledge_base || [] };
}

async function setAttached(list) {
  await call('PATCH', '/v1/convai/agents/' + agentId(), {
    conversation_config: { agent: { prompt: { knowledge_base: list } } }
  });
}

async function attach(entry) {
  const { list } = await getAttached();
  if (list.some(d => d.id === entry.id)) return;
  await setAttached(list.concat([entry]));
}

/* ---- commands ---- */
async function cmdList() {
  const { list } = await getAttached();
  if (!list.length) {
    console.log('\n  The agent has no documents attached.\n');
    return;
  }
  console.log('\n  ' + list.length + ' document(s) the agent can answer from:\n');
  list.forEach(d => console.log('    ' + (d.name || '(unnamed)').padEnd(34) + d.type.padEnd(6) + d.id));
  const hasCatalog = list.some(d => d.name === 'Catalogue');
  if (hasCatalog) {
    console.log('\n  "Catalogue" carries prices as BACKGROUND, dated on the day it was');
    console.log('  generated. The agent still quotes live figures through the');
    console.log('  lookup_product tool — re-run tools/agent-catalog.js after a price');
    console.log('  change so the two do not drift apart.\n');
  } else {
    console.log('\n  Prices and stock come live from your server through the');
    console.log('  lookup_product tool, not from any document here.\n');
  }
}

async function cmdAddPage(target) {
  if (!target) die('Which page?\n\n    node tools/agent-knowledge.js add-page returns.html');
  const url = /^https?:\/\//.test(target) ? target : `${SITE}/${target.replace(/^\/+/, '')}`;
  const name = target.replace(/^https?:\/\/[^/]+\//, '');
  process.stdout.write(`  Reading ${url}… `);
  const doc = await call('POST', '/v1/convai/knowledge-base/url', { url, name });
  const id = doc.id || doc.document_id;
  await attach({ type: 'url', name, id, usage_mode: 'auto' });
  console.log('ok');
  console.log(`\n  Added "${name}". The agent can answer from it now.`);
  console.log('  It is a SNAPSHOT — edit that page later and run:');
  console.log(`      node tools/agent-knowledge.js refresh ${name}\n`);
}

async function cmdAddText(name, file) {
  if (!name || !file) {
    die('Needs a name and a file to read the text from:\n\n' +
        '    node tools/agent-knowledge.js add-text "Holiday hours" notes.txt');
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { die(`Could not read ${file}.`); }
  if (!text.trim()) die(`${file} is empty.`);
  process.stdout.write(`  Uploading "${name}" (${text.length} characters)… `);
  const doc = await call('POST', '/v1/convai/knowledge-base/text', { text, name });
  const id = doc.id || doc.document_id;
  await attach({ type: 'text', name, id, usage_mode: 'auto' });
  console.log('ok\n');
  console.log(`  Added "${name}".\n`);
}

async function cmdAddFile(file) {
  if (!file) die('Which file?\n\n    node tools/agent-knowledge.js add-file docs/handling.pdf');
  let buf;
  try { buf = fs.readFileSync(file); }
  catch (e) { die(`Could not read ${file}.`); }
  const name = path.basename(file);
  const form = new FormData();
  form.append('file', new Blob([buf]), name);
  form.append('name', name);
  process.stdout.write(`  Uploading ${name} (${Math.round(buf.length / 1024)} KB)… `);
  const doc = await call('POST', '/v1/convai/knowledge-base/file', form, true);
  const id = doc.id || doc.document_id;
  await attach({ type: 'file', name, id, usage_mode: 'auto' });
  console.log('ok\n');
  console.log(`  Added ${name}.\n`);
}

async function cmdRemove(which) {
  if (!which) die('Which document? Run `list` to see the names.');
  const { list } = await getAttached();
  const doc = list.find(d => d.name === which || d.id === which);
  if (!doc) die(`No attached document called "${which}". Run \`list\` to see them.`);
  await setAttached(list.filter(d => d.id !== doc.id));
  // Detached first, deleted second: if the delete fails the agent has
  // already stopped answering from it, which is the half that matters.
  await call('DELETE', '/v1/convai/knowledge-base/' + doc.id);
  console.log(`\n  Removed "${doc.name}". The agent no longer answers from it.\n`);
}

async function cmdRefresh(which) {
  if (!which) die('Which page? Run `list` to see the names.');
  const { list } = await getAttached();
  const doc = list.find(d => d.name === which || d.id === which);
  if (!doc) die(`No attached document called "${which}".`);
  if (doc.type !== 'url') die(`"${doc.name}" is a ${doc.type} document, not a page — remove and re-add it instead.`);
  console.log(`  Refreshing "${doc.name}" from the live site…`);
  await cmdRemove(doc.name);
  await cmdAddPage(doc.name);
}

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    die('ELEVENLABS_API_KEY is not set in server/.env.');
  }
  const [cmd, a, b] = process.argv.slice(2);
  switch (cmd) {
    case 'list':      return cmdList();
    case 'add-page':  return cmdAddPage(a);
    case 'add-text':  return cmdAddText(a, b);
    case 'add-file':  return cmdAddFile(a);
    case 'refresh':   return cmdRefresh(a);
    case 'remove':    return cmdRemove(a);
    default:
      console.log(`
  What the chat agent knows.

    node tools/agent-knowledge.js list
    node tools/agent-knowledge.js add-page returns.html
    node tools/agent-knowledge.js add-text "Holiday hours" notes.txt
    node tools/agent-knowledge.js add-file docs/handling.pdf
    node tools/agent-knowledge.js refresh returns.html
    node tools/agent-knowledge.js remove "Holiday hours"

  Never add prices, stock or a product list — the agent gets those live
  from your server, and a copy in here could only go stale.
`);
  }
}

// exitCode rather than process.exit(): exiting hard while fetch still holds
// a keep-alive socket makes libuv assert on Windows, which prints an alarming
// stack trace under a perfectly ordinary error message.
main().catch(e => { console.error('\n  Failed.\n  ' + e.message + '\n'); process.exitCode = 1; });
