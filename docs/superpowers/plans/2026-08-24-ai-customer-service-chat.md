# AI Customer-Service Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a text-only ElevenLabs chat agent that answers pre-sale product and policy questions from our own published copy, and escalates to a human by opening a thread in a new server-side inbox.

**Architecture:** The ElevenLabs widget runs in the browser and reaches our Express server through three endpoints: a live product lookup (so prices are never stale), an escalation call that creates an inbox thread, and a post-call webhook that stores the transcript. The inbox itself is a new module modelled line-for-line on `server/disputes.js` — a JSON map behind `load()`/`save()`, an admin console tab, and a tokenized guest page so someone without an account can still read the reply and write back.

**Tech Stack:** Node 18+, Express, `node:test` (no test framework dependency), vanilla browser JS (no build step), ElevenLabs Agents Chat Mode.

**Spec:** `docs/superpowers/specs/2026-08-24-ai-customer-service-chat-design.md`

## Global Constraints

- **Never edit the site's HTML files with PowerShell `Get-Content`/`Out-File`.** They are no-BOM UTF-8 and PowerShell double-encodes every non-ASCII character site-wide. Use the Edit tool or Python with `encoding='utf-8', newline=''`.
- **No new npm dependencies.** Everything here uses Node built-ins plus what `server/package.json` already has.
- **Tests run with `npm test` from `server/`** (which is `node --test`). Every server test creates a throwaway `DATA_DIR` via `fs.mkdtempSync` and sets `process.env` **before** `require('../server.js')` — `auth.js` reads `JWT_SECRET` and `ADMIN_EMAILS` at module load.
- **No health claims anywhere in copy.** No dosing, administration, human use, safety, or therapeutic language in prompts, emails, page copy, or fallbacks. This is the store's standing compliance rule.
- **Cache-buster:** the site is currently on `?v=86`. Any task that changes a `.js` or `.css` file bumps every reference to `?v=87` across all HTML files in that same task.
- **Cloudflare caches css/js for 4 hours.** Upload assets to the host BEFORE the HTML, or the new `?v=` binds to the old file.
- **Statuses are derived, never typed.** Follow `disputes.deriveStatus()`: the message stream is the source of truth.
- **Secrets stay server-side.** `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_SECRET` and `ELEVENLABS_WEBHOOK_SECRET` live in `server/.env` and are never sent to the browser. Only the public `agentId` goes in `js/config.js`.

---

### Task 1: The inbox store module

**Files:**
- Create: `server/inbox.js`
- Test: `server/test/inbox.test.js`

**Interfaces:**
- Consumes: nothing. This is the foundation task.
- Produces:
  - `MAX_BODY` (4000), `MAX_MESSAGES` (200), `MAX_OPEN_PER_EMAIL` (5), `MAX_TRANSCRIPT` (100)
  - `create({ email, name, subject, body, transcript }) -> thread`
  - `addMessage(id, { from, body }) -> thread` where `from` is `'customer' | 'store'`
  - `close(id, { by }) -> thread`
  - `get(id) -> thread | null`
  - `list() -> thread[]` newest-updated first
  - `markRead(id, who) -> thread | null` where `who` is `'admin' | 'customer'`
  - `unreadFor(thread, who) -> boolean`
  - `summarize(thread) -> { id, email, name, subject, status, messageCount, lastFrom, lastAt, createdAt, updatedAt, unreadForAdmin }`
  - `forGuest(thread) -> thread minus internal fields`
  - `deleteForEmail(email) -> number` (count removed)
  - A thread object is:
    `{ id, createdAt, updatedAt, email, name, subject, transcript: [{ role, text, at }], messages: [{ id, from, body, createdAt }], status, closedAt, closedBy, adminReadAt, customerReadAt }`

- [ ] **Step 1: Write the failing test**

Create `server/test/inbox.test.js`:

```js
/* ============================================================
   EVER NOVA LIFE — inbox store tests
   The inbox is where a chat escalation lands when the visitor
   has no account. Same JSON-map shape as disputes.js, so the
   same properties are worth pinning: status is derived from the
   stream, caps are enforced, and unread means "they spoke last
   and I have not looked since".
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-inbox-'));
process.env.DATA_DIR = TMP_DATA;

const inbox = require('../inbox.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('create stores the question and starts awaiting_us', () => {
  const t = inbox.create({
    email: 'visitor@example.com',
    name: 'Sam',
    subject: 'Does BPC-157 ship to Texas?',
    body: 'The agent could not answer whether you ship to Texas.',
    transcript: [
      { role: 'user', text: 'do you ship to texas', at: '2026-08-24T10:00:00.000Z' },
      { role: 'agent', text: 'Let me put you in touch with someone.', at: '2026-08-24T10:00:05.000Z' }
    ]
  });
  assert.match(t.id, /^MSG-/);
  assert.strictEqual(t.status, 'awaiting_us');
  assert.strictEqual(t.email, 'visitor@example.com');
  assert.strictEqual(t.messages.length, 1);
  assert.strictEqual(t.messages[0].from, 'customer');
  assert.strictEqual(t.transcript.length, 2);
});

test('create requires an email and a body', () => {
  assert.throws(() => inbox.create({ email: '', body: 'hi' }), /email/i);
  assert.throws(() => inbox.create({ email: 'a@b.com', body: '   ' }), /message/i);
});

test('create rejects an address that is not an address', () => {
  assert.throws(() => inbox.create({ email: 'not-an-email', body: 'hi' }), /email/i);
});

test('a store reply flips the status to awaiting_them', () => {
  const t = inbox.create({ email: 'a@example.com', subject: 'Q', body: 'question' });
  const after = inbox.addMessage(t.id, { from: 'store', body: 'Here is the answer.' });
  assert.strictEqual(after.status, 'awaiting_them');
  const back = inbox.addMessage(t.id, { from: 'customer', body: 'Thanks!' });
  assert.strictEqual(back.status, 'awaiting_us');
});

test('closing is sticky and refuses further messages', () => {
  const t = inbox.create({ email: 'b@example.com', subject: 'Q', body: 'question' });
  const closed = inbox.close(t.id, { by: 'boss@evernovalife.com' });
  assert.strictEqual(closed.status, 'closed');
  assert.strictEqual(inbox.get(t.id).status, 'closed');
  assert.throws(() => inbox.addMessage(t.id, { from: 'customer', body: 'more' }), /closed/i);
});

test('bodies over the cap are refused', () => {
  const t = inbox.create({ email: 'c@example.com', subject: 'Q', body: 'question' });
  assert.throws(
    () => inbox.addMessage(t.id, { from: 'customer', body: 'x'.repeat(inbox.MAX_BODY + 1) }),
    /too long/i
  );
});

test('an email address cannot hold more than MAX_OPEN_PER_EMAIL open threads', () => {
  const who = 'flood@example.com';
  for (let i = 0; i < inbox.MAX_OPEN_PER_EMAIL; i++) {
    inbox.create({ email: who, subject: 'Q' + i, body: 'question ' + i });
  }
  assert.throws(() => inbox.create({ email: who, subject: 'one more', body: 'again' }), /open/i);
});

test('the transcript is truncated, not trusted', () => {
  const long = [];
  for (let i = 0; i < inbox.MAX_TRANSCRIPT + 50; i++) {
    long.push({ role: 'user', text: 'line ' + i, at: '2026-08-24T10:00:00.000Z' });
  }
  const t = inbox.create({ email: 'd@example.com', subject: 'Q', body: 'question', transcript: long });
  assert.strictEqual(t.transcript.length, inbox.MAX_TRANSCRIPT);
  // The tail is what matters — the end of the conversation is where it broke down.
  assert.strictEqual(t.transcript[t.transcript.length - 1].text, 'line ' + (long.length - 1));
});

test('unreadFor is true only when the other side spoke last', () => {
  const t = inbox.create({ email: 'e@example.com', subject: 'Q', body: 'question' });
  assert.strictEqual(inbox.unreadFor(inbox.get(t.id), 'admin'), true);
  inbox.markRead(t.id, 'admin');
  assert.strictEqual(inbox.unreadFor(inbox.get(t.id), 'admin'), false);
  inbox.addMessage(t.id, { from: 'store', body: 'answered' });
  assert.strictEqual(inbox.unreadFor(inbox.get(t.id), 'customer'), true);
  assert.strictEqual(inbox.unreadFor(inbox.get(t.id), 'admin'), false);
});

test('forGuest hides the read timestamps', () => {
  const t = inbox.create({ email: 'f@example.com', subject: 'Q', body: 'question' });
  const view = inbox.forGuest(inbox.get(t.id));
  assert.strictEqual(view.adminReadAt, undefined);
  assert.strictEqual(view.customerReadAt, undefined);
  assert.strictEqual(view.id, t.id);
  assert.ok(Array.isArray(view.messages));
});

test('list is newest-updated first', () => {
  const before = inbox.list().length;
  const a = inbox.create({ email: 'g@example.com', subject: 'older', body: 'q' });
  const b = inbox.create({ email: 'h@example.com', subject: 'newer', body: 'q' });
  // Two creates can land in the same millisecond, which would make the sort
  // a coin toss. Touch b so the timestamps genuinely differ — the ordering
  // is what is under test, not the clock's resolution.
  inbox.addMessage(b.id, { from: 'store', body: 'touched' });
  const rows = inbox.list();
  assert.strictEqual(rows.length, before + 2);
  assert.strictEqual(rows[0].id, b.id);
  assert.ok(rows.some(r => r.id === a.id));
});

test('deleteForEmail removes every thread for an address', () => {
  const who = 'erase@example.com';
  inbox.create({ email: who, subject: 'one', body: 'q' });
  inbox.create({ email: who, subject: 'two', body: 'q' });
  const removed = inbox.deleteForEmail(who);
  assert.strictEqual(removed, 2);
  assert.strictEqual(inbox.list().filter(r => r.email === who).length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test test/inbox.test.js`
Expected: FAIL — `Cannot find module '../inbox.js'`

- [ ] **Step 3: Write the implementation**

Create `server/inbox.js`:

```js
/* ============================================================
   EVER NOVA LIFE — the inbox
   Where a chat escalation lands when the person asking has no
   account and no order, which is most of the people who will
   ever use the chat bubble. Disputes cannot hold these: they
   require a userId and an orderId by construction.

   Same JSON-file approach as disputes.js — state behind
   load/save helpers so it can become a table later without
   touching a route.

     · DATA_DIR/inbox.json   → { [threadId]: thread }

   Keyed by thread id, not by email: the admin queue is the
   common read and it is cross-address.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const INBOX_FILE = path.join(DATA_DIR, 'inbox.json');

const MAX_BODY = 4000;
const MAX_SUBJECT = 160;
const MAX_NAME = 80;
const MAX_MESSAGES = 200;
const MAX_OPEN_PER_EMAIL = 5;
const MAX_TRANSCRIPT = 100;
const MAX_TRANSCRIPT_LINE = 2000;

function err(message, status) {
  return Object.assign(new Error(message), { status: status || 400 });
}

/* ---- tiny JSON-map store (read-through + atomic write) ---- */
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function load() {
  ensureDir();
  try {
    const obj = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (e) {
    return {};
  }
}
function save(obj) {
  ensureDir();
  const tmp = INBOX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, INBOX_FILE);
}

let seq = 0;
// Same reasoning as newDisputeId(): the id is the key the store is filed
// under, so a repeat inside one millisecond would overwrite a stranger's
// thread rather than merely look odd.
function newThreadId() {
  return 'MSG-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
}
function newMessageId() { return 'm' + Date.now().toString(36) + (seq++).toString(36); }

/* ---- validation ---- */
function cleanEmail(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) throw err('An email address is needed so we can reply.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 254) {
    throw err('That email address does not look right.');
  }
  return s;
}
function cleanBody(body) {
  const s = String(body == null ? '' : body).trim();
  if (!s) throw err('Write a message before sending.');
  if (s.length > MAX_BODY) throw err(`That message is too long — keep it under ${MAX_BODY} characters.`);
  return s;
}
function cleanShort(value, max) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').slice(0, max);
}

/* The transcript arrives from the agent, which means it arrives from a
   place we do not control. Take the tail (the end is where it broke
   down), cap each line, and keep only the two roles we render. */
function cleanTranscript(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .slice(-MAX_TRANSCRIPT)
    .map(line => ({
      role: (line && line.role === 'agent') ? 'agent' : 'user',
      text: cleanShort(line && line.text, MAX_TRANSCRIPT_LINE),
      at: String((line && line.at) || '')
    }))
    .filter(line => line.text);
}

/* Status is derived from the stream, never typed by a human, so the admin
   queue cannot disagree with the messages in front of it. `closed` is the
   one sticky state. */
function deriveStatus(t) {
  if (t.closedAt) return 'closed';
  const spoken = [...t.messages].reverse().find(m => m.from === 'customer' || m.from === 'store');
  return (spoken && spoken.from === 'store') ? 'awaiting_them' : 'awaiting_us';
}
function stamp(t) { t.status = deriveStatus(t); return t; }

/* ---- reads ---- */
function list() {
  const all = load();
  return Object.keys(all).map(id => stamp(all[id]))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
function get(id) {
  const all = load();
  return all[id] ? stamp(all[id]) : null;
}
function openForEmail(email) {
  return list().filter(t => t.email === email && !t.closedAt);
}

/* ---- writes ---- */
function create({ email, name, subject, body, transcript }) {
  const who = cleanEmail(email);
  const text = cleanBody(body);
  if (openForEmail(who).length >= MAX_OPEN_PER_EMAIL) {
    throw err('There are already several open conversations for that address. Reply on one of those instead.', 429);
  }
  const all = load();
  let id = newThreadId();
  while (all[id]) id = newThreadId();
  const now = new Date().toISOString();
  const thread = {
    id,
    createdAt: now,
    updatedAt: now,
    email: who,
    name: cleanShort(name, MAX_NAME),
    subject: cleanShort(subject, MAX_SUBJECT) || 'A question from the chat',
    transcript: cleanTranscript(transcript),
    messages: [{ id: newMessageId(), from: 'customer', body: text, createdAt: now }],
    status: 'awaiting_us',
    closedAt: null,
    closedBy: '',
    adminReadAt: null,
    customerReadAt: now
  };
  all[id] = thread;
  save(all);
  return stamp(thread);
}

function addMessage(id, { from, body }) {
  const all = load();
  const t = all[id];
  if (!t) throw err('No conversation with that reference.', 404);
  if (t.closedAt) throw err('That conversation is closed. Start a new one, or email support@evernovalife.com.', 409);
  if (from !== 'customer' && from !== 'store') throw err('Unknown sender.');
  if (t.messages.length >= MAX_MESSAGES) {
    throw err(`This conversation has reached ${MAX_MESSAGES} messages. Email support@evernovalife.com and we'll pick it up there.`);
  }
  const text = cleanBody(body);
  const now = new Date().toISOString();
  t.messages.push({ id: newMessageId(), from, body: text, createdAt: now });
  t.updatedAt = now;
  if (from === 'store') t.adminReadAt = now; else t.customerReadAt = now;
  save(all);
  return stamp(t);
}

function close(id, { by }) {
  const all = load();
  const t = all[id];
  if (!t) throw err('No conversation with that reference.', 404);
  if (t.closedAt) return stamp(t);
  const now = new Date().toISOString();
  t.closedAt = now;
  t.closedBy = String(by || 'admin');
  t.updatedAt = now;
  t.adminReadAt = now;
  save(all);
  return stamp(t);
}

function markRead(id, who) {
  const all = load();
  const t = all[id];
  if (!t) return null;
  const now = new Date().toISOString();
  if (who === 'admin') t.adminReadAt = now; else t.customerReadAt = now;
  save(all);
  return stamp(t);
}

/* Unread means "the other side spoke last, and I have not opened it
   since". Two timestamps answer that; a read flag per message would be a
   lot of writes for the same answer. */
function unreadFor(t, who) {
  if (!t || !t.messages || !t.messages.length) return false;
  const last = [...t.messages].reverse().find(m => m.from === 'customer' || m.from === 'store');
  if (!last) return false;
  const mine = who === 'admin' ? 'store' : 'customer';
  if (last.from === mine) return false;
  const readAt = who === 'admin' ? t.adminReadAt : t.customerReadAt;
  if (!readAt) return true;
  return String(readAt) < String(last.createdAt);
}

function summarize(t) {
  const last = t.messages[t.messages.length - 1] || null;
  return {
    id: t.id,
    email: t.email,
    name: t.name,
    subject: t.subject,
    status: deriveStatus(t),
    messageCount: t.messages.length,
    transcriptLines: (t.transcript || []).length,
    lastFrom: last ? last.from : '',
    lastAt: last ? last.createdAt : t.createdAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    unreadForAdmin: unreadFor(t, 'admin')
  };
}

/* What the guest page is allowed to see: the conversation, and nothing
   about how we work it. */
function forGuest(t) {
  return {
    id: t.id,
    subject: t.subject,
    status: deriveStatus(t),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    closedAt: t.closedAt || null,
    messages: (t.messages || []).map(m => ({
      id: m.id, from: m.from, body: m.body, createdAt: m.createdAt
    }))
  };
}

/* Account deletion has to reach here too — a thread carries an address
   and whatever the visitor typed into a chat box. */
function deleteForEmail(email) {
  const who = String(email || '').trim().toLowerCase();
  if (!who) return 0;
  const all = load();
  let removed = 0;
  Object.keys(all).forEach(id => {
    if (all[id] && all[id].email === who) { delete all[id]; removed++; }
  });
  if (removed) save(all);
  return removed;
}

module.exports = {
  MAX_BODY, MAX_SUBJECT, MAX_MESSAGES, MAX_OPEN_PER_EMAIL, MAX_TRANSCRIPT,
  create, addMessage, close, get, list, markRead,
  unreadFor, summarize, forGuest, deleteForEmail
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --test test/inbox.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the whole suite to check nothing regressed**

Run: `cd server && npm test`
Expected: PASS. Note the total test count in the commit body so later tasks can compare.

- [ ] **Step 6: Commit**

```bash
git add server/inbox.js server/test/inbox.test.js
git commit -m "feat(inbox): a place for questions from people without an account"
```

---

### Task 2: Guest and admin inbox routes

**Files:**
- Modify: `server/server.js` (add a section near the dispute routes, which start around line 2150)
- Test: `server/test/inbox-api.test.js`

**Interfaces:**
- Consumes: everything `server/inbox.js` exports from Task 1; `auth.refToken(scope, value)` and `auth.verifyRefToken(scope, value, token)` from `server/auth.js:306`; `ratelimit.limit({ name, windowMs, max, key, message })` from `server/ratelimit.js`; the existing `requireAdmin` middleware in `server.js`.
- Produces:
  - `inboxToken(id) -> string` — `auth.refToken('inbox', id)`
  - `inboxLink(thread) -> string` — `${SITE()}/inbox.html?id=…&t=…`
  - Routes: `GET /api/inbox/:id`, `POST /api/inbox/:id/messages`, `GET /api/admin/inbox`, `GET /api/admin/inbox/:id`, `POST /api/admin/inbox/:id/messages`, `POST /api/admin/inbox/:id/close`

- [ ] **Step 1: Write the failing test**

Create `server/test/inbox-api.test.js`:

```js
/* ============================================================
   EVER NOVA LIFE — inbox route tests
   The guest half of this is deliberately unauthenticated: the
   person reading it has no account and is on a phone hours
   later. The signed token in the URL is the whole credential,
   so the tests that matter are the ones that prove it unlocks
   exactly one thread and nothing else.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-inbox-api-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-inbox';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
delete process.env.ADMIN_KEY;

const app = require('../server.js');
const auth = require('../auth.js');
const inbox = require('../inbox.js');

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

async function adminToken() {
  const res = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Boss', email: 'boss@evernovalife.com', password: 'CorrectHorse9!' })
  });
  const data = await res.json();
  if (data.token) return data.token;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'boss@evernovalife.com', password: 'CorrectHorse9!' })
  });
  return (await login.json()).token;
}

function seed(subject) {
  return inbox.create({ email: 'guest@example.com', name: 'Guest', subject, body: 'The original question.' });
}

test('a valid token reads exactly one thread', async () => {
  const t = seed('token read');
  const good = auth.refToken('inbox', t.id);
  const res = await fetch(`${base}/api/inbox/${t.id}?t=${good}`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.thread.id, t.id);
  assert.strictEqual(data.thread.messages.length, 1);
  // The guest view must not leak how the queue is worked.
  assert.strictEqual(data.thread.adminReadAt, undefined);
  assert.strictEqual(data.thread.email, undefined);
});

test('a wrong token is refused, and says no more than a missing one', async () => {
  const t = seed('wrong token');
  const wrong = await fetch(`${base}/api/inbox/${t.id}?t=deadbeefdeadbeefdeadbeefdeadbeef`);
  const missing = await fetch(`${base}/api/inbox/MSG-NOPE?t=deadbeefdeadbeefdeadbeefdeadbeef`);
  assert.strictEqual(wrong.status, 404);
  assert.strictEqual(missing.status, 404);
  assert.deepStrictEqual(await wrong.json(), await missing.json());
});

test("one thread's token does not open another thread", async () => {
  const a = seed('thread a');
  const b = seed('thread b');
  const res = await fetch(`${base}/api/inbox/${b.id}?t=${auth.refToken('inbox', a.id)}`);
  assert.strictEqual(res.status, 404);
});

test('a guest can reply with the token, and it lands as customer', async () => {
  const t = seed('guest reply');
  const res = await fetch(`${base}/api/inbox/${t.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: auth.refToken('inbox', t.id), body: 'Following up.' })
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  const last = data.thread.messages[data.thread.messages.length - 1];
  assert.strictEqual(last.from, 'customer');
  assert.strictEqual(last.body, 'Following up.');
  assert.strictEqual(data.thread.status, 'awaiting_us');
});

test('the admin queue needs an admin', async () => {
  const anon = await fetch(`${base}/api/admin/inbox`);
  assert.strictEqual(anon.status, 401);

  await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nobody', email: 'nobody@example.com', password: 'CorrectHorse9!' })
  });
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'CorrectHorse9!' })
  });
  const plain = (await login.json()).token;
  const res = await fetch(`${base}/api/admin/inbox`, { headers: { Authorization: `Bearer ${plain}` } });
  assert.strictEqual(res.status, 403);
});

test('an admin reply flips the thread and the guest can see it', async () => {
  const t = seed('admin reply');
  const token = await adminToken();
  const res = await fetch(`${base}/api/admin/inbox/${t.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body: 'Here is the answer.' })
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).thread.status, 'awaiting_them');

  const guest = await fetch(`${base}/api/inbox/${t.id}?t=${auth.refToken('inbox', t.id)}`);
  const seen = (await guest.json()).thread;
  assert.strictEqual(seen.messages[seen.messages.length - 1].from, 'store');
});

test('closing a thread stops the guest writing to it', async () => {
  const t = seed('closing');
  const token = await adminToken();
  const closed = await fetch(`${base}/api/admin/inbox/${t.id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({})
  });
  assert.strictEqual(closed.status, 200);

  const res = await fetch(`${base}/api/inbox/${t.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: auth.refToken('inbox', t.id), body: 'still there?' })
  });
  assert.strictEqual(res.status, 409);
});

test('the admin list carries the unread flag', async () => {
  const t = seed('unread flag');
  const token = await adminToken();
  const res = await fetch(`${base}/api/admin/inbox`, { headers: { Authorization: `Bearer ${token}` } });
  const rows = (await res.json()).threads;
  const row = rows.find(r => r.id === t.id);
  assert.ok(row, 'the seeded thread should be in the queue');
  assert.strictEqual(row.unreadForAdmin, true);
  assert.strictEqual(row.email, 'guest@example.com');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test test/inbox-api.test.js`
Expected: FAIL — the guest read returns 404 from the static handler or the SPA fallback, not from a route.

- [ ] **Step 3: Write the implementation**

In `server/server.js`, add `const inbox = require('./inbox.js');` next to `const disputes = require('./disputes.js');` (line 33).

Then add this block immediately after the dispute routes section (after the `GET /api/disputes/:id/files/:fileId` handler, around line 2290):

```js
/* ============================================================
   THE INBOX
   Disputes need an account and an order. Most people who will
   ever use the chat bubble have neither — they are shopping.
   These routes are the landing pad for that, and the guest half
   of them is deliberately unauthenticated for the same reason
   the pay-the-balance page is: the reader is a stranger on a
   phone, hours later, with no password to hand.

   The signed token in the URL is the whole credential. It
   unlocks exactly ONE thread, and all it can do is read that
   conversation and add a line to it. It cannot move money,
   reveal an account, or list anything.
   ============================================================ */
const inboxPostLimiter = ratelimit.limit({
  name: 'inbox-post',
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Too many messages from this connection. Wait a few minutes and try again.'
});

function inboxToken(id) { return auth.refToken('inbox', id); }

function inboxLink(t) {
  return `${SITE()}/inbox.html?id=${encodeURIComponent(t.id)}&t=${inboxToken(t.id)}`;
}

/* A wrong token and a thread that never existed get the same answer, so
   the endpoint cannot be used to find out which thread ids are real. */
function threadFromToken(req) {
  const id = String(req.params.id || '');
  const t = String((req.query && req.query.t) || (req.body && req.body.t) || '');
  if (!auth.verifyRefToken('inbox', id, t)) return null;
  return inbox.get(id);
}

const INBOX_NOT_FOUND = { error: 'That conversation link is not valid.' };

app.get('/api/inbox/:id', (req, res) => {
  const t = threadFromToken(req);
  if (!t) return res.status(404).json(INBOX_NOT_FOUND);
  inbox.markRead(t.id, 'customer');
  res.json({ success: true, thread: inbox.forGuest(t) });
});

app.post('/api/inbox/:id/messages', inboxPostLimiter, (req, res) => {
  const t = threadFromToken(req);
  if (!t) return res.status(404).json(INBOX_NOT_FOUND);
  try {
    const updated = inbox.addMessage(t.id, { from: 'customer', body: req.body && req.body.body });
    sendInboxReplyAlert(updated).catch(e => console.error('[inbox] reply alert failed:', e.message));
    res.json({ success: true, thread: inbox.forGuest(updated) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

/* ---- the admin side ---- */
app.get('/api/admin/inbox', requireAdmin, (req, res) => {
  res.json({ success: true, threads: inbox.list().map(inbox.summarize) });
});

app.get('/api/admin/inbox/:id', requireAdmin, (req, res) => {
  const t = inbox.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'No conversation with that reference.' });
  inbox.markRead(t.id, 'admin');
  res.json({ success: true, thread: t, link: inboxLink(t) });
});

app.post('/api/admin/inbox/:id/messages', requireAdmin, (req, res) => {
  try {
    const updated = inbox.addMessage(req.params.id, { from: 'store', body: req.body && req.body.body });
    sendInboxAnsweredEmail(updated).catch(e => console.error('[inbox] answer email failed:', e.message));
    res.json({ success: true, thread: updated });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.post('/api/admin/inbox/:id/close', requireAdmin, (req, res) => {
  try {
    const by = (req.user && req.user.email) || 'admin';
    res.json({ success: true, thread: inbox.close(req.params.id, { by }) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});
```

Add the two email helpers next to `buildDisputeOpenedMail` (around line 2330). They are deliberately thin — Task 3 fills in the acknowledgement that goes out when the thread is *created*; these two cover the reply cycle:

```js
/* The guest has no account, so email is the only way to tell them an
   answer is waiting. The body of the answer is NOT included: an inbox
   thread can carry an address or an order reference, and a forwarded
   chain outlives the tab. */
async function sendInboxAnsweredEmail(t) {
  if (!email.CONFIGURED) return;
  const link = inboxLink(t);
  const who = t.name || 'there';
  const subject = 'We have replied to your question';
  const text = `Hi ${who},\n\n` +
    `There's an answer waiting on your question ("${t.subject}").\n\n` +
    `Read it and reply here:\n${link}\n\n` +
    `— The Ever Nova Life team`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="color:#6d28d9;margin-bottom:4px">We have replied</h2>
    <p>Hi ${escapeHtmlSrv(who)}, there's an answer waiting on your question.</p>
    <p><strong>${escapeHtmlSrv(t.subject)}</strong></p>
    <p><a href="${link}" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Read the reply</a></p>
  </div>`;
  await email.sendMail({ to: t.email, subject, text, html });
}

/* Tell the shop a guest wrote back. The admin console polls, but the
   owner is not always looking at it. */
async function sendInboxReplyAlert(t) {
  if (!email.CONFIGURED) return;
  const to = (process.env.ADMIN_EMAIL || (process.env.ADMIN_EMAILS || '').split(',')[0] || '').trim();
  if (!to) return;
  const subject = `Reply on ${t.id} — ${t.subject}`;
  const text = `${t.email} wrote back on ${t.id}.\n\n` +
    `Open the console: ${SITE()}/admin.html#inbox\n`;
  await email.sendMail({ to, subject, text, html: `<p>${escapeHtmlSrv(t.email)} wrote back on <strong>${escapeHtmlSrv(t.id)}</strong>.</p><p><a href="${SITE()}/admin.html#inbox">Open the console</a></p>` });
}
```

Finally, extend the account-deletion cleanup at line 762 so an erased account takes its inbox threads with it. It currently reads:

```js
  try { disputes.deleteUserData(id); } catch (e) { console.error('[admin delete] dispute cleanup failed:', e.message); }
```

`auth.deleteUser(id)` returns `publicUser(removed)`, which carries the address, and it is already in scope as `removed`. Add directly beneath the disputes line:

```js
  try { inbox.deleteForEmail(removed.email); } catch (e) { console.error('[admin delete] inbox cleanup failed:', e.message); }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --test test/inbox-api.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the whole suite**

Run: `cd server && npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add server/server.js server/test/inbox-api.test.js
git commit -m "feat(inbox): guest and admin routes, with a signed link that opens one thread"
```

---

### Task 3: The acknowledgement email

**Files:**
- Modify: `server/server.js` (add one builder next to `buildDisputeOpenedMail`, around line 2330)
- Test: `server/test/inbox-email.test.js`

**Interfaces:**
- Consumes: `inboxLink(t)` and `inbox.create()` from Tasks 1–2; the `email.CONFIGURED` / `email.sendMail` surface from `server/email.js`; `escapeHtmlSrv()` already in `server.js`.
- Produces: `buildInboxOpenedMail(thread) -> { to, subject, text, html }` — exported on the app object as `app.__test_buildInboxOpenedMail` so it can be tested without a live SMTP server, matching how `dispute-email.test.js` reaches its builder. Read that test first and copy whichever hook it uses.

- [ ] **Step 1: Read the existing email test to match its hook**

Run: `cd server && cat test/dispute-email.test.js`

Note how it gets at the builder. Use the identical mechanism below rather than inventing a second one.

- [ ] **Step 2: Write the failing test**

Create `server/test/inbox-email.test.js`:

```js
/* ============================================================
   EVER NOVA LIFE — inbox acknowledgement email
   Until this existed, escalating from the chat notified nobody:
   close the tab and nothing anywhere said you had reached a
   human. The properties worth pinning are that the link works
   and that the message body is NOT quoted back.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-inbox-mail-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-inbox-mail';
process.env.SITE_URL = 'https://evernovalife.com';

const app = require('../server.js');
const auth = require('../auth.js');
const inbox = require('../inbox.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('the acknowledgement carries a working signed link', () => {
  const t = inbox.create({
    email: 'guest@example.com',
    name: 'Sam',
    subject: 'Shipping to Texas',
    body: 'A secret detail that must not be quoted back.'
  });
  const mail = app.__test_buildInboxOpenedMail(t);

  assert.strictEqual(mail.to, 'guest@example.com');
  assert.match(mail.subject, /question/i);
  assert.ok(mail.text.includes(t.id), 'the reference belongs in the body');

  const m = /inbox\.html\?id=([^&\s]+)&t=([a-f0-9]+)/.exec(mail.text);
  assert.ok(m, 'the email should carry an inbox.html link');
  assert.strictEqual(decodeURIComponent(m[1]), t.id);
  assert.strictEqual(auth.verifyRefToken('inbox', t.id, m[2]), true);
});

test('the acknowledgement does not quote the message back', () => {
  const secret = 'A secret detail that must not be quoted back.';
  const t = inbox.create({ email: 'guest2@example.com', subject: 'Q', body: secret });
  const mail = app.__test_buildInboxOpenedMail(t);
  assert.ok(!mail.text.includes(secret), 'a forwarded chain outlives the tab');
  assert.ok(!mail.html.includes(secret));
});

test('a name with markup in it is escaped in the html part', () => {
  const t = inbox.create({
    email: 'guest3@example.com',
    name: '<script>alert(1)</script>',
    subject: 'Q',
    body: 'question'
  });
  const mail = app.__test_buildInboxOpenedMail(t);
  assert.ok(!mail.html.includes('<script>'), 'the html part must escape the name');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && node --test test/inbox-email.test.js`
Expected: FAIL — `app.__test_buildInboxOpenedMail is not a function`

- [ ] **Step 4: Write the implementation**

In `server/server.js`, next to the other inbox mail helpers from Task 2:

```js
/* The visitor's receipt. Escalating from a chat box is a moment of
   doubt — the person has just been told a machine cannot help them —
   and an email that arrives immediately is what makes the handoff feel
   real. No message body, for the reason the dispute mails give: a
   forwarded chain outlives the tab. */
function buildInboxOpenedMail(t) {
  const link = inboxLink(t);
  const who = t.name || 'there';
  const subject = `We've got your question (${t.id})`;
  const text = `Hi ${who},\n\n` +
    `Your question has reached us — reference ${t.id}.\n\n` +
    `What it was about: ${t.subject}\n\n` +
    `A person will reply. You'll get an email when there's an answer, and you can read the conversation here at any time:\n${link}\n\n` +
    `Nothing else is needed from you for now.\n\n` +
    `— The Ever Nova Life team`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="color:#6d28d9;margin-bottom:4px">We've got your question</h2>
    <p>Hi ${escapeHtmlSrv(who)}, your question has reached us — reference <strong>${escapeHtmlSrv(t.id)}</strong>.</p>
    <p><strong>What it was about:</strong> ${escapeHtmlSrv(t.subject)}</p>
    <p>A person will reply. You'll get an email when there's an answer.</p>
    <p><a href="${link}" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">See the conversation</a></p>
    <p style="color:#9ca3af;font-size:12px;margin-top:24px">Nothing else is needed from you for now.</p>
  </div>`;
  return { to: t.email, subject, text, html };
}

async function sendInboxOpenedEmail(t) {
  if (!email.CONFIGURED) return;
  await email.sendMail(buildInboxOpenedMail(t));
}
```

Expose the builder for tests using the same hook `dispute-email.test.js` uses. If that file reaches its builder through an `app.__test_*` property, add alongside the existing ones:

```js
app.__test_buildInboxOpenedMail = buildInboxOpenedMail;
```

If it uses a different mechanism, use that one instead and adjust the test's call site to match.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && node --test test/inbox-email.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the whole suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/server.js server/test/inbox-email.test.js
git commit -m "feat(inbox): acknowledgement email, carrying the signed conversation link"
```

---

### Task 4: The agent endpoints

**Files:**
- Modify: `server/server.js` (a new section after the inbox routes)
- Test: `server/test/agent-api.test.js`

**Interfaces:**
- Consumes: `inbox.create()` and `sendInboxOpenedEmail()` from Tasks 1–3; `products.list()` from `server/products.js` (read the module's exports before writing — use whatever the catalog read is actually called); `req.rawBody`, already captured globally by the `express.json({ verify })` at `server/server.js:57`.
- Produces:
  - `GET /api/agent/product?q=<text>` — header `x-agent-secret`, returns `{ success, products: [{ id, name, sku, price, currency, inStock, url }] }`, at most 5
  - `POST /api/agent/escalate` — header `x-agent-secret`, body `{ email, name, subject, body, transcript }`, returns `{ success, reference, message }`
  - `POST /api/agent/transcript` — header `elevenlabs-signature`, HMAC-verified, stores to `DATA_DIR/agent-transcripts/`
  - `verifyAgentSignature(rawBody, header) -> boolean`

**Before writing:** confirm the request/response contract for ElevenLabs webhook tools and the post-call webhook signature format at <https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools>. The scheme implemented below is `t=<unix>,v0=<hex>` over `${timestamp}.${rawBody}`. If the docs disagree, follow the docs and adjust the test.

- [ ] **Step 1: Read the products module surface**

Run: `cd server && grep -n "module.exports" -A12 products.js`

Note the exact name of the "give me the catalog" function and the field names on a product (`id`, `name`, `price`, `stockQty`, and whatever the SKU/slug field is called). The implementation below assumes `products.list()` returning objects with `id`, `name`, `price`, `stockQty` — correct it to match reality.

- [ ] **Step 2: Write the failing test**

Create `server/test/agent-api.test.js`:

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && node --test test/agent-api.test.js`
Expected: FAIL — the routes do not exist.

- [ ] **Step 4: Write the implementation**

In `server/server.js`, after the inbox routes:

```js
/* ============================================================
   THE CHAT AGENT'S THREE DOORS
   Everything the ElevenLabs agent can reach is here, and the
   list is short on purpose. It can read the catalog, it can
   hand a conversation to a human, and it can post back a
   finished transcript. It cannot read an order, an account, or
   anything with a name and address attached — handing an LLM a
   lookup keyed on customer records is the shortest path to
   disclosing one to whoever guessed a reference.
   ============================================================ */
const AGENT_SECRET = process.env.ELEVENLABS_AGENT_SECRET || '';
const AGENT_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || '';

const agentLimiter = ratelimit.limit({
  name: 'agent-tool',
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many lookups. Tell the visitor to try again in a minute.'
});

function requireAgent(req, res, next) {
  const given = String(req.get('x-agent-secret') || '');
  if (!AGENT_SECRET || given.length !== AGENT_SECRET.length ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(AGENT_SECRET))) {
    return res.status(401).json({ error: 'Not authorised.' });
  }
  next();
}

/* What the agent may say about a product: the name, what it costs, and
   whether we have it. `stockQty` absent means untracked, which the
   catalog treats as available. */
function agentProductView(p) {
  const tracked = p.stockQty !== undefined && p.stockQty !== null && p.stockQty !== '';
  return {
    id: p.id,
    name: p.name,
    price: Number(p.price) || 0,
    currency: 'USD',
    inStock: tracked ? Number(p.stockQty) > 0 : true,
    url: `${SITE()}/product.html?id=${encodeURIComponent(p.id)}`
  };
}

app.get('/api/agent/product', requireAgent, agentLimiter, (req, res) => {
  const q = String((req.query && req.query.q) || '').trim().toLowerCase();
  const all = products.list();
  const hits = q
    ? all.filter(p => String(p.name || '').toLowerCase().includes(q))
    : all;
  res.json({ success: true, products: hits.slice(0, 5).map(agentProductView) });
});

app.post('/api/agent/escalate', requireAgent, agentLimiter, (req, res) => {
  const b = req.body || {};
  try {
    const t = inbox.create({
      email: b.email,
      name: b.name,
      subject: b.subject,
      body: b.body,
      transcript: b.transcript
    });
    sendInboxOpenedEmail(t).catch(e => console.error('[inbox] acknowledgement failed:', e.message));
    res.json({
      success: true,
      reference: t.id,
      // The agent reads this sentence out. Keep it a sentence.
      message: `A person has it. The reference is ${t.id}, and a confirmation is on its way to ${t.email}.`
    });
  } catch (e) {
    // The agent has to say something useful, so the error text is the
    // message — not a code it would have to interpret.
    res.status(e.status || 400).json({ error: e.message });
  }
});

/* The post-call webhook. Audit evidence must not live only in a vendor
   dashboard we could lose access to, so every finished conversation is
   written here as well. The signature is checked against the RAW body —
   `express.json({ verify })` at the top of this file keeps it on
   req.rawBody precisely so webhooks like this one can. */
function verifyAgentSignature(rawBody, header) {
  if (!AGENT_WEBHOOK_SECRET || !header || !rawBody) return false;
  const parts = String(header).split(',').reduce((acc, piece) => {
    const [k, v] = piece.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  if (!parts.t || !parts.v0) return false;
  const expected = crypto.createHmac('sha256', AGENT_WEBHOOK_SECRET)
    .update(`${parts.t}.${rawBody.toString('utf8')}`)
    .digest('hex');
  const a = Buffer.from(parts.v0);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/agent/transcript', (req, res) => {
  if (!verifyAgentSignature(req.rawBody, req.get('elevenlabs-signature'))) {
    console.error('[agent] transcript rejected: signature mismatch');
    return res.status(401).json({ error: 'Not authorised.' });
  }
  try {
    const dir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'agent-transcripts');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const id = String((req.body && req.body.conversation_id) || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
    const stampName = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${stampName}-${id}.json`), JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (e) {
    console.error('[agent] transcript store failed:', e.message);
    res.status(500).json({ error: 'Could not store that.' });
  }
});
```

If `crypto`, `fs` or `path` are not already required at the top of `server.js`, add them.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && node --test test/agent-api.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the whole suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/server.js server/test/agent-api.test.js
git commit -m "feat(agent): catalog lookup, escalation and a signed transcript webhook"
```

---

### Task 5: The guest conversation page

**Files:**
- Create: `inbox.html`
- Create: `js/inbox.js`
- Modify: `css/styles.css` (append an `.inbox-*` block)
- Modify: every `*.html` at the repo root (cache-buster `?v=86` → `?v=87`)

**Interfaces:**
- Consumes: `GET /api/inbox/:id?t=` and `POST /api/inbox/:id/messages` from Task 2.
- Produces: a page at `inbox.html?id=<threadId>&t=<token>`.

**Before writing:** open `support.html` and copy its `<head>`, header, skip link, `<main>` wrapper and footer verbatim. Every page on this site shares them, and a hand-written variant will drift. Also read `js/support.js` for how it calls the API (there is an existing base-URL helper from `js/config.js` — use it, do not hard-code an origin).

- [ ] **Step 1: Create the page shell**

Create `inbox.html` by copying `support.html` and replacing only the `<main>` contents with:

```html
<main id="main">
  <section class="section">
    <div class="container inbox-wrap">
      <h1 class="inbox-title" id="inboxTitle">Your conversation</h1>
      <p class="inbox-sub" id="inboxSub">Loading…</p>

      <div class="inbox-thread" id="inboxThread" aria-live="polite"></div>

      <form class="inbox-composer" id="inboxComposer" hidden>
        <label class="sr-only" for="inboxBody">Your reply</label>
        <textarea id="inboxBody" rows="3" maxlength="4000" placeholder="Write a reply…" required></textarea>
        <button class="btn btn-primary" type="submit" id="inboxSend">Send</button>
      </form>

      <p class="inbox-closed" id="inboxClosed" hidden>
        This conversation is closed. Email
        <a href="mailto:support@evernovalife.com">support@evernovalife.com</a> to pick it back up.
      </p>

      <p class="form-msg" id="inboxMsg" role="status"></p>
    </div>
  </section>
</main>
```

Update the page `<title>` to `Your conversation — Ever Nova Life`, the meta description to `Read our reply and write back — no account needed.`, and add `<meta name="robots" content="noindex,nofollow">` in the head. A tokenized private page has no business in a search index.

In the script block at the bottom, add `<script src="js/inbox.js?v=87"></script>` and set every other `?v=` on the page to `87`.

- [ ] **Step 2: Write the page script**

Create `js/inbox.js`:

```js
/* ============================================================
   EVER NOVA LIFE — the guest conversation page
   Reached only from a link in an email. The token in the URL is
   the whole credential and it opens exactly one thread, so
   there is nothing to sign into and nothing to remember.
   ============================================================ */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var id = params.get('id') || '';
  var token = params.get('t') || '';

  var elThread = document.getElementById('inboxThread');
  var elComposer = document.getElementById('inboxComposer');
  var elBody = document.getElementById('inboxBody');
  var elSend = document.getElementById('inboxSend');
  var elMsg = document.getElementById('inboxMsg');
  var elSub = document.getElementById('inboxSub');
  var elClosed = document.getElementById('inboxClosed');

  // Same one every other page script uses — see js/support.js:15.
  var API = (window.PEPTIDE_API_BASE || '');
  function api(path) { return API + path; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function say(text, bad) {
    elMsg.textContent = text || '';
    elMsg.className = 'form-msg' + (bad ? ' error' : '');
  }

  function render(thread) {
    elSub.textContent = thread.subject + ' — reference ' + thread.id;
    elThread.innerHTML = (thread.messages || []).map(function (m) {
      var mine = m.from === 'customer';
      return '<article class="inbox-msg ' + (mine ? 'is-mine' : 'is-store') + '">' +
        '<header class="inbox-msg-head">' +
          '<span class="inbox-who">' + (mine ? 'You' : 'Ever Nova Life') + '</span>' +
          '<time datetime="' + esc(m.createdAt) + '">' + esc(when(m.createdAt)) + '</time>' +
        '</header>' +
        '<p class="inbox-msg-body">' + esc(m.body).replace(/\n/g, '<br>') + '</p>' +
      '</article>';
    }).join('');

    var closed = thread.status === 'closed';
    elComposer.hidden = closed;
    elClosed.hidden = !closed;
  }

  function loadThread() {
    return fetch(api('/api/inbox/' + encodeURIComponent(id) + '?t=' + encodeURIComponent(token)))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          elSub.textContent = res.data.error || 'That conversation link is not valid.';
          elThread.innerHTML = '';
          elComposer.hidden = true;
          return null;
        }
        render(res.data.thread);
        return res.data.thread;
      })
      .catch(function () {
        elSub.textContent = 'We could not reach the server. Try again in a moment.';
        return null;
      });
  }

  if (!id || !token) {
    elSub.textContent = 'That conversation link is not valid.';
    elComposer.hidden = true;
  } else {
    loadThread();
  }

  elComposer.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = elBody.value.trim();
    if (!body) return;
    elSend.disabled = true;
    say('Sending…');
    fetch(api('/api/inbox/' + encodeURIComponent(id) + '/messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token, body: body })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) { say(res.data.error || 'That did not send.', true); return; }
        elBody.value = '';
        say('Sent.');
        render(res.data.thread);
      })
      .catch(function () { say('We could not reach the server. Try again in a moment.', true); })
      .then(function () { elSend.disabled = false; });
  });
}());
```

`window.PEPTIDE_API_BASE` is set by `js/config.js` and is empty when the Node app serves both the site and the API, so `API + path` works on localhost and on the split GoDaddy/Render deployment without a branch.

- [ ] **Step 3: Style it**

Append to `css/styles.css`:

```css
/* ---- guest conversation page (inbox.html) ---- */
.inbox-wrap { max-width: 720px; }
.inbox-title { margin-bottom: 4px; }
.inbox-sub { color: var(--muted); margin-bottom: 24px; }
.inbox-thread { display: flex; flex-direction: column; gap: 14px; margin-bottom: 20px; }
.inbox-msg {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 14px 16px;
  background: rgba(255, 255, 255, 0.03);
}
.inbox-msg.is-mine { border-color: rgba(124, 58, 237, 0.35); }
.inbox-msg-head {
  display: flex; justify-content: space-between; align-items: baseline;
  gap: 12px; margin-bottom: 6px; font-size: 0.85rem;
}
.inbox-who { font-weight: 600; }
.inbox-msg-head time { color: var(--muted); }
.inbox-msg-body { margin: 0; line-height: 1.55; overflow-wrap: anywhere; }
.inbox-composer { display: flex; flex-direction: column; gap: 10px; }
.inbox-composer textarea { width: 100%; resize: vertical; }
.inbox-composer button { align-self: flex-end; }
.inbox-closed { color: var(--muted); }
```

Use the site's real custom-property names — check the `:root` block at the top of `css/styles.css` and substitute `var(--muted)` for whatever the muted-text token is actually called.

- [ ] **Step 4: Bump the cache-buster site-wide**

Run: `cd "c:/Users/Administrator/Documents/PEPTIDE" && grep -rl 'v=86' --include='*.html' .`

Then replace `v=86` with `v=87` in every file listed, using Python (**not** PowerShell — see Global Constraints):

```python
import pathlib
for p in pathlib.Path('.').glob('*.html'):
    s = p.read_text(encoding='utf-8')
    if 'v=86' in s:
        p.write_text(s.replace('v=86', 'v=87'), encoding='utf-8', newline='')
```

- [ ] **Step 5: Verify by hand**

Run: `cd server && npm start`

Then in another shell, mint a thread and its link:

```bash
cd server && node -e "
process.env.DATA_DIR = process.env.DATA_DIR || './data';
const inbox = require('./inbox.js'), auth = require('./auth.js');
const t = inbox.create({ email: 'you@example.com', name: 'You', subject: 'Manual check', body: 'Does this page render?' });
console.log('http://localhost:4242/inbox.html?id=' + t.id + '&t=' + auth.refToken('inbox', t.id));
"
```

Open the printed URL. Confirm: the question renders, a reply sends and appears, and changing one character of the `t=` parameter shows "That conversation link is not valid." with no thread content.

- [ ] **Step 6: Commit**

```bash
git add inbox.html js/inbox.js css/styles.css *.html
git commit -m "feat(inbox): a guest conversation page that needs no account"
```

---

### Task 6: The admin inbox tab

**Files:**
- Modify: `js/admin-core.js:224` (the `NAV` array)
- Modify: `js/admin-console.js` (the `TITLES` map at line 346, the `render()` switch at line 384, the tally block at line 420, and the delegated click listener at line 2718)
- Modify: `server/server.js` (the admin summary endpoint around line 2449)
- Test: `server/test/admin-summary.test.js` (extend the existing file)

**Interfaces:**
- Consumes: `GET /api/admin/inbox`, `GET /api/admin/inbox/:id`, `POST /api/admin/inbox/:id/messages`, `POST /api/admin/inbox/:id/close` from Task 2; `inbox.list()`, `inbox.summarize()` from Task 1.
- Produces: an `admin.html#inbox` view; a `navInbox` tally element; `summary.inbox` on the admin summary payload.

**Before writing:** read `renderDisputes()` at `js/admin-console.js:2470` end to end. The inbox view is the same shape with fewer states, and matching it is the point — the console re-renders views wholesale through one delegated listener, so per-render listener wiring would leak.

- [ ] **Step 1: Add the summary count and its test**

In `server/server.js`, in the admin summary handler near line 2449 where `waitingThreads` is computed, add:

```js
  const waitingInbox = inbox.list().filter(t => t.status === 'awaiting_us').length;
```

and add `inbox: waitingInbox,` to the response object next to `disputes: waitingThreads,`. Then extend the "does the owner need to look at the console" condition (around line 2476) so it includes `summary.inbox`.

Append to `server/test/admin-summary.test.js` (match the file's existing helpers for getting an admin token — read it first):

```js
test('the summary counts inbox threads waiting on us', async () => {
  const inbox = require('../inbox.js');
  inbox.create({ email: 'waiting@example.com', subject: 'Waiting', body: 'A question.' });
  const token = await adminToken();
  const res = await fetch(`${base}/api/admin/summary`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  assert.ok(data.summary.inbox >= 1, 'a thread awaiting us should be counted');
});
```

- [ ] **Step 2: Run the summary test**

Run: `cd server && node --test test/admin-summary.test.js`
Expected: PASS.

- [ ] **Step 3: Register the nav entry**

In `js/admin-core.js`, in the `NAV` array, insert immediately after the `disputes` entry:

```js
    { key: 'inbox', href: 'admin.html#inbox', label: 'Inbox', icon: 'chat', tally: 'navInbox' },
```

- [ ] **Step 4: Register the view**

In `js/admin-console.js`, add to `TITLES` (line 346):

```js
    inbox: ['Inbox', 'Questions from people without an account — mostly from the chat'],
```

Add to the `render()` switch (line 384), next to the disputes branch:

```js
    else if (state.view === 'inbox') renderInbox();
```

In the tally block (line 420), beside `navDisputes`:

```js
    var iq = document.getElementById('navInbox');
    if (iq) {
      var waitingInbox = (state.inbox || []).filter(function (t) { return t.status === 'awaiting_us'; }).length;
      iq.textContent = waitingInbox ? String(waitingInbox) : '';
      iq.hidden = !waitingInbox;
    }
```

- [ ] **Step 5: Load and render the queue**

Wherever `loadAll()` fetches the dispute queue, fetch the inbox queue the same way and store it as `state.inbox`. Then add:

```js
  /* The inbox view. Same shape as the dispute queue and deliberately so —
     one open thread on the left, the conversation on the right, and the
     composer pinned under it. The only states are: waiting on us,
     waiting on them, closed. */
  function renderInbox() {
    var rows = (state.inbox || []);
    if (!rows.length) {
      body.innerHTML = '<div class="admin-empty">Nothing waiting. Questions escalated from the chat land here.</div>';
      return;
    }

    var openId = state.inboxOpenId || rows[0].id;
    var open = rows.find(function (r) { return r.id === openId; }) || rows[0];

    body.innerHTML =
      '<div class="admin-split">' +
        '<div class="admin-queue">' +
          rows.map(function (r) {
            return '<button class="admin-queue-row act-inbox-open' + (r.id === open.id ? ' is-open' : '') + '"' +
              ' data-id="' + A.esc(r.id) + '">' +
              '<span class="q-subject">' + A.esc(r.subject) + '</span>' +
              '<span class="q-who">' + A.esc(r.email) + '</span>' +
              '<span class="q-status status-' + A.esc(r.status) + '">' + A.esc(statusLabel(r.status)) + '</span>' +
              (r.unreadForAdmin ? '<span class="q-dot" aria-label="unread"></span>' : '') +
            '</button>';
          }).join('') +
        '</div>' +
        '<div class="admin-detail" id="inboxDetail">Loading…</div>' +
      '</div>';

    loadInboxThread(open.id);
  }

  function statusLabel(code) {
    return code === 'awaiting_us' ? 'Waiting on us'
      : code === 'awaiting_them' ? 'Waiting on them'
      : 'Closed';
  }

  function loadInboxThread(id) {
    state.inboxOpenId = id;
    A.api('/api/admin/inbox/' + encodeURIComponent(id)).then(function (data) {
      var t = data.thread;
      var host = document.getElementById('inboxDetail');
      if (!host) return;
      host.innerHTML =
        '<header class="detail-head">' +
          '<h3>' + A.esc(t.subject) + '</h3>' +
          '<p>' + A.esc(t.email) + (t.name ? ' — ' + A.esc(t.name) : '') + ' · ' + A.esc(t.id) + '</p>' +
        '</header>' +
        (t.transcript && t.transcript.length
          ? '<details class="detail-transcript"><summary>Chat before the handoff (' + t.transcript.length + ' lines)</summary>' +
            t.transcript.map(function (line) {
              return '<p class="tr-line tr-' + A.esc(line.role) + '"><strong>' +
                (line.role === 'agent' ? 'Assistant' : 'Visitor') + ':</strong> ' + A.esc(line.text) + '</p>';
            }).join('') + '</details>'
          : '') +
        '<div class="detail-thread">' +
          t.messages.map(function (m) {
            return '<article class="detail-msg is-' + A.esc(m.from) + '">' +
              '<header><span>' + (m.from === 'store' ? 'You' : 'Them') + '</span>' +
              '<time>' + A.esc(new Date(m.createdAt).toLocaleString()) + '</time></header>' +
              '<p>' + A.esc(m.body).replace(/\n/g, '<br>') + '</p>' +
            '</article>';
          }).join('') +
        '</div>' +
        (t.status === 'closed'
          ? '<p class="detail-closed">Closed ' + A.esc(new Date(t.closedAt).toLocaleString()) + '.</p>'
          : '<form class="detail-composer" id="inboxReplyForm">' +
              '<textarea id="inboxReplyBody" rows="3" maxlength="4000" placeholder="Reply…"></textarea>' +
              '<div class="detail-actions">' +
                '<button class="btn btn-primary act-inbox-send" type="button" data-id="' + A.esc(t.id) + '">Send reply</button>' +
                '<button class="btn btn-ghost act-inbox-close" type="button" data-id="' + A.esc(t.id) + '">Close conversation</button>' +
              '</div>' +
            '</form>');
    });
  }
```

`A.esc(s)` and `A.api(path, opts)` are the real helpers exported by `js/admin-core.js` — `api` takes `{ method, body }` and throws an `ApiError` carrying `.message` and `.status` on failure, so the `.catch` handlers below can show `e.message` directly. Reuse the class names `renderDisputes()` already uses for its queue/detail split rather than the `admin-split` / `admin-queue` / `admin-detail` names written here; read that function first and match it, so no new CSS is needed.

- [ ] **Step 6: Wire the three actions**

In the delegated click listener (line 2718), alongside the existing `act-*` branches:

```js
      else if (t.classList.contains('act-inbox-open')) loadInboxThread(t.getAttribute('data-id'));
      else if (t.classList.contains('act-inbox-send')) sendInboxReply(t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-inbox-close')) closeInboxThread(t.getAttribute('data-id'), t);
```

And the two handlers:

```js
  function sendInboxReply(id, btn) {
    var field = document.getElementById('inboxReplyBody');
    var body = field ? field.value.trim() : '';
    if (!body) return;
    btn.disabled = true;
    A.api('/api/admin/inbox/' + encodeURIComponent(id) + '/messages', { method: 'POST', body: { body: body } })
      .then(function () { return loadAll(); })
      .then(function () { loadInboxThread(id); })
      .catch(function (e) { window.alert(e.message || 'That did not send.'); })
      .then(function () { btn.disabled = false; });
  }

  function closeInboxThread(id, btn) {
    if (!window.confirm('Close this conversation? They will be told to email support if they need to reopen it.')) return;
    btn.disabled = true;
    A.api('/api/admin/inbox/' + encodeURIComponent(id) + '/close', { method: 'POST', body: {} })
      .then(function () { return loadAll(); })
      .then(function () { loadInboxThread(id); })
      .catch(function (e) { window.alert(e.message || 'That did not close.'); })
      .then(function () { btn.disabled = false; });
  }
```

- [ ] **Step 7: Bump the admin cache-buster**

The admin pages carry their own `?v=` number, separate from the storefront. Run `grep -n 'v=[0-9]' admin.html | head` , note the current value, and bump every `?v=` reference in `admin.html` and `admin-products.html` by one, using the Edit tool or Python.

- [ ] **Step 8: Verify by hand**

Run: `cd server && npm start`

Sign in to `admin.html` as the admin account, click **Inbox** in the rail. Confirm: the seeded thread from Task 5 is listed, the transcript expander shows the chat, a reply sends and flips the status to "Waiting on them", the tally badge decrements, and closing the conversation hides the composer.

- [ ] **Step 9: Run the whole suite and commit**

Run: `cd server && npm test`

```bash
git add js/admin-core.js js/admin-console.js server/server.js server/test/admin-summary.test.js admin.html admin-products.html
git commit -m "feat(admin): an inbox tab for questions with no order attached"
```

---

### Task 7: The chat widget

**Files:**
- Create: `js/chat.js`
- Modify: `js/config.js` (add the `ENL_CHAT` block)
- Modify: every storefront `*.html` at the repo root (add the script tag)

**Interfaces:**
- Consumes: `window.ENL_CHAT` from `js/config.js`; the age gate's cleared signal from `js/age-gate.js`.
- Produces: nothing other code depends on.

**Before writing:** read `js/age-gate.js` and find out how a page learns the gate has been passed — an event, a body class, or a stored flag. `js/chat.js` must hook that, not guess. Also read the widget attribute names at <https://elevenlabs.io/docs/eleven-agents/customization/widget>, since the custom element's tag and attributes are the vendor's to define.

- [ ] **Step 1: Add the config block**

In `js/config.js`, following the shape of the `ENL_ANALYTICS` block already there:

```js
/* ------------------------------------------------------------
   AI CHAT  (off until you fill this in)
   The assistant that answers product and policy questions, and
   hands the conversation to a person when it cannot.

     agentId — the PUBLIC agent id from the ElevenLabs dashboard.
               Public is the right word: it is visible in the page
               source by design. The API key and the tool secrets
               are server-side only and never appear here.

   Leave agentId empty and nothing loads at all — no script tag,
   no bubble, no requests — and the site behaves exactly as it
   did before the feature existed.

     window.ENL_CHAT = { agentId: 'agent_xxxxxxxxxxxx' };
   ------------------------------------------------------------ */
window.ENL_CHAT = { agentId: '' };
```

- [ ] **Step 2: Write the loader**

Create `js/chat.js`:

```js
/* ============================================================
   EVER NOVA LIFE — the chat bubble
   Loads the ElevenLabs agent widget, and only ever in text
   mode. Two conditions gate it, both deliberate:

     · ENL_CHAT.agentId must be set. Empty means the feature
       does not exist — no script tag, no requests.
     · The age gate must have been cleared first. Someone who
       has not confirmed they are old enough to be here should
       not be in a conversation with the shop.

   If the vendor script fails to load, nothing happens: no
   bubble, no layout shift, no error in the visitor's face. The
   contact page is still there.
   ============================================================ */
(function () {
  'use strict';

  var cfg = window.ENL_CHAT || {};
  if (!cfg.agentId) return;

  var WIDGET_SRC = 'https://unpkg.com/@elevenlabs/convai-widget-embed';
  var loaded = false;

  function mount() {
    if (loaded) return;
    loaded = true;

    var el = document.createElement('elevenlabs-convai');
    el.setAttribute('agent-id', cfg.agentId);
    // Text only. Voice is a separate decision, not a default.
    el.setAttribute('variant', 'expandable');
    document.body.appendChild(el);

    var s = document.createElement('script');
    s.src = WIDGET_SRC;
    s.async = true;
    s.type = 'text/javascript';
    s.onerror = function () {
      // The vendor is unreachable or blocked. Take the element back
      // out so there is no dead furniture on the page.
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    document.head.appendChild(s);
  }

  function ageGateCleared() {
    // Replace this with whatever js/age-gate.js actually exposes —
    // read that file before trusting the fallback below.
    return document.body && !document.body.classList.contains('age-gate-open');
  }

  function start() {
    if (ageGateCleared()) { mount(); return; }
    // Poll briefly rather than racing the gate's own script.
    var tries = 0;
    var timer = window.setInterval(function () {
      if (ageGateCleared()) { window.clearInterval(timer); mount(); }
      else if (++tries > 120) window.clearInterval(timer);   // two minutes, then give up
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
```

**Correct the two vendor-specific details before committing:** the widget's script URL and the attribute names come from the ElevenLabs widget documentation, and the age-gate check comes from reading `js/age-gate.js`. Both placeholders above are marked in comments.

- [ ] **Step 3: Add the script tag to the storefront**

Add `<script src="js/chat.js?v=87"></script>` after the `js/config.js` tag on every customer-facing page. **Not** on `admin.html`, `admin-products.html`, or `labels.html` — the owner does not need a support bubble in their own console.

Verify the set:

```bash
cd "c:/Users/Administrator/Documents/PEPTIDE" && grep -L 'js/chat.js' --include='*.html' -r . | sort
```

Expected: only the three admin pages, `404.html`, and `_run_check.html`.

- [ ] **Step 4: Verify the off switch**

Run: `cd server && npm start`, open `http://localhost:4242/`, and confirm with `agentId` still empty that the Network tab shows **no** request to any elevenlabs or unpkg host, and no bubble appears.

Then set `window.ENL_CHAT = { agentId: 'agent_test' };` temporarily, reload, and confirm the script tag is added. Revert to empty before committing — the real id is set at deploy time, not in git.

- [ ] **Step 5: Commit**

```bash
git add js/chat.js js/config.js *.html
git commit -m "feat(chat): load the agent widget, off until an agent id is set"
```

---

### Task 8: The agent's own configuration

**Files:**
- Create: `docs/AI-CHAT.md`
- Modify: `server/README.md` (add the three new environment variables to whatever list it keeps)

This task produces the document the owner follows in the ElevenLabs dashboard, and the prompt text itself. Nothing here is code, and none of it can be tested by `npm test` — which is exactly why it has to be written down rather than done once from memory.

- [ ] **Step 1: Write the operator guide**

Create `docs/AI-CHAT.md` containing, in this order:

1. **What this is** — one paragraph: a text-only ElevenLabs agent that answers from our published copy and hands off to a human, whose escalations land in `admin.html#inbox`.

2. **The three secrets**, and where each goes:

   | Variable | Where | What it is |
   |---|---|---|
   | `ELEVENLABS_API_KEY` | `server/.env` | account key, used for knowledge-base uploads |
   | `ELEVENLABS_AGENT_SECRET` | `server/.env` **and** each webhook tool's header config in the dashboard | the shared secret the agent presents as `x-agent-secret` |
   | `ELEVENLABS_WEBHOOK_SECRET` | `server/.env` **and** the post-call webhook config | HMAC key for transcript verification |
   | `agentId` | `js/config.js` | public, appears in page source by design |

3. **The system prompt**, verbatim and ready to paste:

```
You are the assistant for Ever Nova Life, a supplier of peptides for
in-vitro laboratory research. You answer questions about the catalogue,
prices, stock, shipping, returns, documentation and lot certificates.

WHAT YOU ANSWER FROM
Answer only from the documents in your knowledge base and from the
lookup_product tool. If the answer is not in either, say you don't have
it and offer to put the person in touch with someone who does. Never
answer from general knowledge about peptides.

WHAT YOU NEVER DISCUSS
Every product here is for laboratory research use only. You must refuse,
in one short sentence, any question about:
  - dosing, quantities to take, schedules, or cycles
  - how to administer anything, by any route
  - use in or on humans or animals
  - whether something is safe, effective, or beneficial
  - treating, preventing, curing, or diagnosing any condition
  - comparisons to medicines or supplements
  - personal results, before-and-afters, or what to expect

Refuse like this: "That's outside what I can help with — these materials
are supplied for laboratory research only. I can put you in touch with a
person if you have a question about an order or our documentation."

Do not soften it, do not add a caveat and then answer anyway, and do not
speculate about what a researcher "might" do. If someone rephrases the
question, refuse again.

ORDERS
You cannot look up orders, accounts, or addresses. Someone asking about
an existing order should be pointed at the order-status page on the site,
where they enter their reference and email address. If they need more
than that, escalate.

PRICES AND STOCK
Always call lookup_product. Never state a price or stock level from
memory or from the knowledge base.

HANDING OFF TO A PERSON
Escalate when: you refused something and they still need help; the
knowledge base does not cover it; they ask for a human; or they sound
frustrated. Ask for their email address first, then call escalate with a
short subject line and a plain summary of what they need. Read the
reference number back to them.

If the escalate tool fails, tell them to email support@evernovalife.com
directly, and give them that address.

TONE
Brief and plain. No exclamation marks, no emoji, no sales language. If
you don't know, say so in one sentence.
```

4. **Knowledge-base contents** — the list of pages to upload, and the instruction to re-upload after editing any of them: `shipping.html`, `returns.html`, `terms.html`, `privacy.html`, `quality.html`, `faq.html`, `about.html`, `research-accounts.html`. Note explicitly that `products.html` is **not** on the list, and why: prices and stock come from `lookup_product` so they cannot go stale.

5. **Tool definitions** — for each of the two webhook tools, the URL, method, the `x-agent-secret` header, and the parameter schema:

   - `lookup_product` — `GET https://<api-host>/api/agent/product?q={query}`. One string parameter `query`: "the product name or part of it, as the visitor said it".
   - `escalate` — `POST https://<api-host>/api/agent/escalate`. Body parameters: `email` (required, "the visitor's email address, which you must ask for before calling this"), `name` (optional), `subject` (required, "a short line describing what they need"), `body` (required, "a plain summary of the question in your own words"), `transcript` (optional array of `{role, text, at}`).

6. **Post-call webhook** — `POST https://<api-host>/api/agent/transcript`, with `ELEVENLABS_WEBHOOK_SECRET` as the signing secret.

7. **Widget appearance** — set the accent to `#7c3aed`, the surface to `#07040f`, and text-only/chat mode on. The bubble should read "Questions?" rather than anything implying a person is typing.

8. **A go-live checklist** the owner ticks: secrets set on the server, knowledge base uploaded, both tools wired and tested from the dashboard's test panel, transcript webhook verified, `agentId` set in `js/config.js`, assets uploaded to the host **before** the HTML (Cloudflare caches js/css for four hours), and a real escalation walked end to end.

- [ ] **Step 2: Document the environment variables**

Add the three variables from the table above to `server/README.md`, alongside however it already documents `BTCPAY_WEBHOOK_SECRET` and friends. Match that file's existing format.

- [ ] **Step 3: Walk one escalation end to end**

With the agent configured and the server running:

1. Open the site, click the bubble, ask "how much is BPC-157?" — confirm the price matches what `admin-products.html` shows.
2. Ask a dosing question — confirm it refuses in one sentence and offers a person.
3. Accept, give an email address — confirm you get the acknowledgement email with a working link.
4. Open `admin.html#inbox` — confirm the thread is there with the chat transcript attached.
5. Reply — confirm the guest email arrives and the link shows the reply.
6. End the chat — confirm a file appears in `server/data/agent-transcripts/`.

- [ ] **Step 4: Commit**

```bash
git add docs/AI-CHAT.md server/README.md
git commit -m "docs: how the chat agent is configured, and the prompt it runs on"
```

---

## Notes for the executor

- **Tasks 1–4 need no ElevenLabs account and no network.** If the vendor side is blocked or the account is not ready, those four still ship and still close the contact-form gap on their own.
- **Task 8 is the compliance surface.** The system prompt in it is the single artifact standing between a generative model and a health claim on a live chat. Do not paraphrase it to be friendlier.
- **Every task that touches a `.js` or `.css` file bumps the cache-buster** in the same commit. A shipped asset with a stale `?v=` is invisible to returning visitors for as long as Cloudflare holds it.
