# Customer Disputes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in customer open a dispute thread about one of their orders, exchange messages and images with the store, and let the owner work and resolve it from the admin console with a recorded outcome.

**Architecture:** A new `server/disputes.js` JSON-file store (same shape as `server/store.js`) holds threads keyed by dispute id; image bytes live beside it on disk under `DATA_DIR/dispute-files/` with only metadata in the record. Routes are added to `server/server.js` — customer routes behind `auth.requireAuth`, admin routes behind `requireAdmin`. The admin console gets a new hash view backed by a new `js/admin-disputes.js`; the customer gets a new `support.html` + `js/support.js`, reached from a button on each order row.

**Tech Stack:** Node 18+, Express 4, `node:test`, nodemailer (via `server/email.js`), vanilla browser JS (no framework, no build step), CSS in `css/styles.css`.

**Spec:** [docs/superpowers/specs/2026-08-20-customer-disputes-design.md](../specs/2026-08-20-customer-disputes-design.md)

## Global Constraints

- **No new npm dependencies.** `server/package.json` stays as it is. Uploads ride in the JSON body — `express.json` is already at `limit: '8mb'` (`server/server.js:51`).
- **Node built-ins are required with the `node:` prefix** in test files, plain names (`fs`, `path`) in server modules — match the file you are editing.
- **HTML files are UTF-8 without a BOM.** Edit them with the Edit tool or Python (`encoding='utf-8', newline=''`). **Never** with PowerShell `Get-Content`/`Out-File` — it double-encodes every non-ASCII character site-wide.
- **Copy is research-supplier neutral.** No wording that frames a product around human use. Reason labels are about the shipment, the packaging and the paperwork.
- **No emoji as UI icons.** Inline SVG only, matching the existing sets (`ICONS` in `js/admin-core.js`, the icon helpers in `js/main.js`).
- **Errors thrown by store modules carry a status:** `throw Object.assign(new Error('message'), { status: 400 })`. Routes translate with `res.status(err.status || 400).json({ error: err.message })`.
- **404, not 403,** when a thread belongs to another account.
- **Cache-busters** are bumped only in the final task, and per `cloudflare-asset-cache` the asset files are uploaded to hosting **before** the HTML that names them.
- **Never commit runtime state.** `server/data/` is already gitignored; `disputes.json` and `dispute-files/` live there.
- Tests run from `server/` with `npm test`.

---

### Task 1: Dispute store — records, derived status, caps

**Files:**
- Create: `server/disputes.js`
- Test: `server/test/disputes.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, for Tasks 2–5:
  - `REASONS` — `[{ code, label }]`, codes: `not_delivered`, `damaged`, `wrong_item`, `quality`, `billing`, `other`
  - `OUTCOMES` — `[{ code, label }]`, codes: `refunded`, `replaced`, `no_action`, `withdrawn`
  - `MAX_BODY = 4000`, `MAX_MESSAGES = 200`, `MAX_OPEN_PER_USER = 5`, `MAX_FILES_PER_MESSAGE = 3`, `MAX_FILE_BYTES = 2 * 1024 * 1024`
  - `list()` → `dispute[]` newest `updatedAt` first
  - `listForUser(userId)` → `dispute[]`
  - `get(id)` → `dispute | null`
  - `findOpenForOrder(orderId)` → `dispute | null`
  - `create({ userId, orderId, reason, body, authorEmail, attachments })` → `dispute`
  - `addMessage(id, { from, authorEmail, body, attachments })` → `dispute`
  - `resolve(id, { outcome, note, by })` → `dispute`
  - `reopen(id, { by })` → `dispute`
  - `markRead(id, who)` → `dispute` (`who` is `'admin'` or `'customer'`)
  - `unreadFor(dispute, who)` → `boolean`
  - `summarize(dispute)` → list row without message bodies
  - `deleteUserData(userId)` → `number` of threads removed
  - `attachments` on input is `[{ name, data }]` with `data` base64 — handled in Task 2; in Task 1 it is accepted and stored as `[]`.

- [ ] **Step 1: Write the failing test**

Create `server/test/disputes.test.js`:

```js
/* ============================================================
   EVER NOVA LIFE — dispute store tests
   The thread record itself: derived status, unread, the caps,
   and the cascade when an account is deleted. No HTTP here —
   the routes get their own tests in disputes-api.test.js.
       npm test        (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-disputes-'));
process.env.DATA_DIR = TMP_DATA;

const disputes = require('../disputes.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

function open(over = {}) {
  return disputes.create({
    userId: 'u1',
    orderId: 'ENL-AAA',
    reason: 'damaged',
    body: 'One vial arrived cracked.',
    authorEmail: 'alice@example.com',
    ...over
  });
}

test('a new thread is awaiting_us, has one message, and no outcome', () => {
  const d = open({ orderId: 'ENL-NEW' });
  assert.match(d.id, /^DSP-/);
  assert.equal(d.status, 'awaiting_us');
  assert.equal(d.outcome, '');
  assert.equal(d.messages.length, 1);
  assert.equal(d.messages[0].from, 'customer');
  assert.equal(d.messages[0].body, 'One vial arrived cracked.');
});

test('an unknown reason code is refused', () => {
  assert.throws(() => open({ orderId: 'ENL-BADR', reason: 'nonsense' }), /reason/i);
});

test('a store reply flips the thread to awaiting_customer', () => {
  const d = open({ orderId: 'ENL-REPLY' });
  const after = disputes.addMessage(d.id, {
    from: 'admin', authorEmail: 'boss@evernovalife.com', body: 'Sending a replacement today.'
  });
  assert.equal(after.status, 'awaiting_customer');
  assert.equal(after.messages.length, 2);
});

test('resolving records the outcome, the note and who did it', () => {
  const d = open({ orderId: 'ENL-RES' });
  const done = disputes.resolve(d.id, { outcome: 'replaced', note: 'Reshipped on the 21st.', by: 'boss@evernovalife.com' });
  assert.equal(done.status, 'resolved');
  assert.equal(done.outcome, 'replaced');
  assert.equal(done.outcomeNote, 'Reshipped on the 21st.');
  assert.equal(done.resolvedBy, 'boss@evernovalife.com');
  assert.ok(done.resolvedAt);
});

test('an unknown outcome code is refused', () => {
  const d = open({ orderId: 'ENL-BADO' });
  assert.throws(() => disputes.resolve(d.id, { outcome: 'vibes', by: 'boss@evernovalife.com' }), /outcome/i);
});

test('a resolved thread refuses another message until it is reopened', () => {
  const d = open({ orderId: 'ENL-CLOSED' });
  disputes.resolve(d.id, { outcome: 'no_action', by: 'boss@evernovalife.com' });
  assert.throws(
    () => disputes.addMessage(d.id, { from: 'customer', authorEmail: 'alice@example.com', body: 'One more thing' }),
    /resolved/i
  );
  const back = disputes.reopen(d.id, { by: 'boss@evernovalife.com' });
  assert.equal(back.status, 'awaiting_customer');
  assert.equal(back.outcome, '');
  const after = disputes.addMessage(d.id, { from: 'customer', authorEmail: 'alice@example.com', body: 'One more thing' });
  assert.equal(after.status, 'awaiting_us');
});

test('reopening leaves a system line in the stream so the history survives', () => {
  const d = open({ orderId: 'ENL-HIST' });
  disputes.resolve(d.id, { outcome: 'refunded', note: 'Sent back in full.', by: 'boss@evernovalife.com' });
  const back = disputes.reopen(d.id, { by: 'boss@evernovalife.com' });
  const last = back.messages[back.messages.length - 1];
  assert.equal(last.from, 'system');
  assert.match(last.body, /refunded/i);
});

test('one open thread per order; the second attempt names the first', () => {
  const first = open({ orderId: 'ENL-DUPE' });
  assert.equal(disputes.findOpenForOrder('ENL-DUPE').id, first.id);
  assert.throws(() => open({ orderId: 'ENL-DUPE' }), /already/i);
  // Resolved frees the order up again.
  disputes.resolve(first.id, { outcome: 'no_action', by: 'boss@evernovalife.com' });
  assert.equal(disputes.findOpenForOrder('ENL-DUPE'), null);
  const second = open({ orderId: 'ENL-DUPE' });
  assert.notEqual(second.id, first.id);
});

test('a sixth open thread for one account is refused', () => {
  for (let i = 0; i < disputes.MAX_OPEN_PER_USER; i++) {
    disputes.create({ userId: 'u-cap', orderId: 'ENL-CAP' + i, reason: 'other', body: 'x', authorEmail: 'cap@example.com' });
  }
  assert.throws(
    () => disputes.create({ userId: 'u-cap', orderId: 'ENL-CAPX', reason: 'other', body: 'x', authorEmail: 'cap@example.com' }),
    /5 open reports/i
  );
});

test('an over-long message body is refused, and nothing is written', () => {
  const d = open({ orderId: 'ENL-LONG' });
  const before = disputes.get(d.id).messages.length;
  assert.throws(
    () => disputes.addMessage(d.id, { from: 'customer', authorEmail: 'alice@example.com', body: 'x'.repeat(disputes.MAX_BODY + 1) }),
    /4000/
  );
  assert.equal(disputes.get(d.id).messages.length, before);
});

test('an empty message body is refused', () => {
  const d = open({ orderId: 'ENL-EMPTY' });
  assert.throws(() => disputes.addMessage(d.id, { from: 'customer', authorEmail: 'a@b.c', body: '   ' }), /message/i);
});

test('unread is true for us after the customer posts, false once we read it', () => {
  const d = open({ orderId: 'ENL-UNREAD' });
  assert.equal(disputes.unreadFor(disputes.get(d.id), 'admin'), true);
  assert.equal(disputes.unreadFor(disputes.get(d.id), 'customer'), false);
  disputes.markRead(d.id, 'admin');
  assert.equal(disputes.unreadFor(disputes.get(d.id), 'admin'), false);
  // Our own reply must not make it unread for us.
  disputes.addMessage(d.id, { from: 'admin', authorEmail: 'boss@evernovalife.com', body: 'Looking into it.' });
  assert.equal(disputes.unreadFor(disputes.get(d.id), 'admin'), false);
  assert.equal(disputes.unreadFor(disputes.get(d.id), 'customer'), true);
});

test('summarize carries the counts but no message bodies', () => {
  const d = open({ orderId: 'ENL-SUM' });
  const s = disputes.summarize(disputes.get(d.id));
  assert.equal(s.id, d.id);
  assert.equal(s.orderId, 'ENL-SUM');
  assert.equal(s.messageCount, 1);
  assert.equal(s.lastFrom, 'customer');
  assert.ok(!('messages' in s), 'summaries must not carry the stream');
});

test('listForUser returns only that account, newest activity first', () => {
  disputes.create({ userId: 'u-a', orderId: 'ENL-A1', reason: 'other', body: 'a', authorEmail: 'a@x.c' });
  disputes.create({ userId: 'u-b', orderId: 'ENL-B1', reason: 'other', body: 'b', authorEmail: 'b@x.c' });
  const mine = disputes.listForUser('u-a');
  assert.ok(mine.length >= 1);
  assert.ok(mine.every(x => x.userId === 'u-a'));
});

test('deleting an account removes its threads and leaves everyone else alone', () => {
  disputes.create({ userId: 'u-gone', orderId: 'ENL-G1', reason: 'other', body: 'g', authorEmail: 'g@x.c' });
  const others = disputes.list().filter(x => x.userId !== 'u-gone').length;
  const removed = disputes.deleteUserData('u-gone');
  assert.ok(removed >= 1);
  assert.equal(disputes.listForUser('u-gone').length, 0);
  assert.equal(disputes.list().length, others);
});
```

- [ ] **Step 2: Run the test to watch it fail**

Run: `cd server && npm test -- --test-name-pattern="dispute"`
Expected: FAIL — `Cannot find module '../disputes.js'`.

- [ ] **Step 3: Write the store**

Create `server/disputes.js`:

```js
/* ============================================================
   EVER NOVA LIFE — customer dispute threads
   One thread per problem, always about one order, opened by the
   account that placed it. Same JSON-file approach as store.js:
   state behind load/save helpers so it can become a table later
   without touching a route.

     · DATA_DIR/disputes.json      → { [disputeId]: dispute }
     · DATA_DIR/dispute-files/…    → the attached images (Task 2)

   The map is keyed by dispute id, not by user: two of the three
   common reads (the admin list, "is one already open on this
   order?") are cross-user, and a per-user map makes both a scan.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DISPUTES_FILE = path.join(DATA_DIR, 'disputes.json');

const REASONS = [
  { code: 'not_delivered', label: 'The parcel never arrived' },
  { code: 'damaged', label: 'Something arrived damaged' },
  { code: 'wrong_item', label: 'The wrong item or quantity arrived' },
  { code: 'quality', label: 'A concern about the vial, seal or documentation' },
  { code: 'billing', label: 'The amount charged looks wrong' },
  { code: 'other', label: 'Something else' }
];

const OUTCOMES = [
  { code: 'refunded', label: 'Refunded' },
  { code: 'replaced', label: 'Replacement sent' },
  { code: 'no_action', label: 'No action needed' },
  { code: 'withdrawn', label: 'Withdrawn by the customer' }
];

const MAX_BODY = 4000;
const MAX_NOTE = 1000;
const MAX_MESSAGES = 200;
const MAX_OPEN_PER_USER = 5;
const MAX_FILES_PER_MESSAGE = 3;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

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
    const obj = JSON.parse(fs.readFileSync(DISPUTES_FILE, 'utf8'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (e) {
    return {};
  }
}
function save(obj) {
  ensureDir();
  const tmp = DISPUTES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, DISPUTES_FILE);
}

/* Ids follow the ENL- order convention: short, sortable, sayable. */
let seq = 0;
function newDisputeId() { return 'DSP-' + Date.now().toString(36).toUpperCase(); }
function newMessageId() { return 'm' + Date.now().toString(36) + (seq++).toString(36); }

/* Status is derived from the stream, never typed by a human, so the
   admin queue can't disagree with the messages in front of it. The one
   exception is `resolved`, which is sticky until someone reopens. */
function deriveStatus(d) {
  if (d.resolvedAt) return 'resolved';
  const spoken = [...d.messages].reverse().find(m => m.from === 'customer' || m.from === 'admin');
  return (spoken && spoken.from === 'admin') ? 'awaiting_customer' : 'awaiting_us';
}
function stamp(d) { d.status = deriveStatus(d); return d; }

function isReason(code) { return REASONS.some(r => r.code === code); }
function isOutcome(code) { return OUTCOMES.some(o => o.code === code); }

function cleanBody(body) {
  const s = String(body == null ? '' : body).trim();
  if (!s) throw err('Write a message before sending.');
  if (s.length > MAX_BODY) throw err(`That message is too long — keep it under ${MAX_BODY} characters.`);
  return s;
}

/* ---- reads ---- */
function list() {
  const all = load();
  return Object.keys(all).map(id => stamp(all[id]))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
function listForUser(userId) { return list().filter(d => d.userId === userId); }
function get(id) {
  const all = load();
  return all[id] ? stamp(all[id]) : null;
}
function findOpenForOrder(orderId) {
  return list().find(d => d.orderId === orderId && !d.resolvedAt) || null;
}

/* ---- writes ---- */
function create({ userId, orderId, reason, body, authorEmail, attachments }) {
  if (!userId) throw err('An account is required to open a report.', 401);
  if (!orderId) throw err('A report has to be about an order.');
  if (!isReason(reason)) throw err('Choose a reason for the report.');
  const text = cleanBody(body);

  if (findOpenForOrder(orderId)) {
    throw Object.assign(err('There is already an open report on that order.', 409),
      { disputeId: findOpenForOrder(orderId).id });
  }
  const openMine = listForUser(userId).filter(d => !d.resolvedAt).length;
  if (openMine >= MAX_OPEN_PER_USER) {
    throw err(`You already have ${MAX_OPEN_PER_USER} open reports. We'll answer those first — reply on one of them instead.`);
  }

  const now = new Date().toISOString();
  const d = {
    id: newDisputeId(),
    orderId: String(orderId),
    userId: String(userId),
    reason,
    status: 'awaiting_us',
    outcome: '',
    outcomeNote: '',
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedBy: '',
    adminReadAt: null,
    customerReadAt: now,      // they just wrote it; it is not unread to them
    messages: [{
      id: newMessageId(),
      from: 'customer',
      authorEmail: String(authorEmail || ''),
      body: text,
      attachments: attachStore.attach(null, attachments),
      createdAt: now
    }]
  };
  // The attachment ids need the dispute id to land in the right folder, so
  // the files are written once the record has one.
  d.messages[0].attachments = attachStore.attach(d.id, attachments);

  const all = load();
  all[d.id] = d;
  save(all);
  return stamp(d);
}

function addMessage(id, { from, authorEmail, body, attachments }) {
  const all = load();
  const d = all[id];
  if (!d) throw err('No report with that reference.', 404);
  if (d.resolvedAt) throw err('That report is resolved. Reopen it, or open a new one.', 409);
  if (from !== 'customer' && from !== 'admin') throw err('Unknown sender.');
  if (d.messages.length >= MAX_MESSAGES) {
    throw err(`This report has reached ${MAX_MESSAGES} messages. Email support@evernovalife.com and we'll pick it up there.`);
  }
  const text = cleanBody(body);
  const now = new Date().toISOString();
  d.messages.push({
    id: newMessageId(),
    from,
    authorEmail: String(authorEmail || ''),
    body: text,
    attachments: attachStore.attach(d.id, attachments),
    createdAt: now
  });
  d.updatedAt = now;
  if (from === 'admin') d.adminReadAt = now; else d.customerReadAt = now;
  save(all);
  return stamp(d);
}

function resolve(id, { outcome, note, by }) {
  const all = load();
  const d = all[id];
  if (!d) throw err('No report with that reference.', 404);
  if (!isOutcome(outcome)) throw err('Choose how this report ended.');
  const now = new Date().toISOString();
  d.outcome = outcome;
  d.outcomeNote = String(note == null ? '' : note).trim().slice(0, MAX_NOTE);
  d.resolvedAt = now;
  d.resolvedBy = String(by || 'admin');
  d.updatedAt = now;
  d.adminReadAt = now;
  save(all);
  return stamp(d);
}

function reopen(id, { by }) {
  const all = load();
  const d = all[id];
  if (!d) throw err('No report with that reference.', 404);
  if (!d.resolvedAt) return stamp(d);
  const label = (OUTCOMES.find(o => o.code === d.outcome) || {}).label || d.outcome;
  const now = new Date().toISOString();
  d.messages.push({
    id: newMessageId(),
    from: 'system',
    authorEmail: String(by || 'admin'),
    body: `Reopened. It had been closed as: ${label}.`,
    attachments: [],
    createdAt: now
  });
  d.resolvedAt = null;
  d.resolvedBy = '';
  d.outcome = '';
  d.outcomeNote = '';
  d.updatedAt = now;
  save(all);
  return stamp(d);
}

function markRead(id, who) {
  const all = load();
  const d = all[id];
  if (!d) return null;
  const now = new Date().toISOString();
  if (who === 'admin') d.adminReadAt = now; else d.customerReadAt = now;
  save(all);
  return stamp(d);
}

/* Unread means "the other side spoke last, and I haven't opened it since".
   Two timestamps answer that; a read flag per message would be a lot of
   writes for the same answer. A `system` line is nobody's message. */
function unreadFor(d, who) {
  if (!d || !d.messages || !d.messages.length) return false;
  const last = [...d.messages].reverse().find(m => m.from === 'customer' || m.from === 'admin');
  if (!last) return false;
  const mine = who === 'admin' ? 'admin' : 'customer';
  if (last.from === mine) return false;
  const readAt = who === 'admin' ? d.adminReadAt : d.customerReadAt;
  if (!readAt) return true;
  return String(readAt) < String(last.createdAt);
}

function summarize(d) {
  const last = d.messages[d.messages.length - 1] || null;
  return {
    id: d.id,
    orderId: d.orderId,
    userId: d.userId,
    reason: d.reason,
    reasonLabel: (REASONS.find(r => r.code === d.reason) || {}).label || d.reason,
    status: deriveStatus(d),
    outcome: d.outcome,
    outcomeLabel: (OUTCOMES.find(o => o.code === d.outcome) || {}).label || '',
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    resolvedAt: d.resolvedAt,
    messageCount: d.messages.length,
    lastFrom: last ? last.from : '',
    lastAt: last ? last.createdAt : d.createdAt,
    unreadForAdmin: unreadFor(d, 'admin'),
    unreadForCustomer: unreadFor(d, 'customer')
  };
}

function deleteUserData(userId) {
  const all = load();
  let removed = 0;
  for (const id of Object.keys(all)) {
    if (all[id] && all[id].userId === userId) {
      attachStore.removeAll(id);
      delete all[id];
      removed++;
    }
  }
  if (removed) save(all);
  return removed;
}

/* Attachments are Task 2. Until then, nothing is stored and nothing is
   removed — the seam is here so the record shape never changes. */
const attachStore = {
  attach() { return []; },
  removeAll() { }
};

module.exports = {
  REASONS, OUTCOMES,
  MAX_BODY, MAX_NOTE, MAX_MESSAGES, MAX_OPEN_PER_USER, MAX_FILES_PER_MESSAGE, MAX_FILE_BYTES,
  list, listForUser, get, findOpenForOrder,
  create, addMessage, resolve, reopen, markRead,
  unreadFor, summarize, deleteUserData
};
```

- [ ] **Step 4: Run the test to watch it pass**

Run: `cd server && npm test -- --test-name-pattern="dispute"`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the whole suite so nothing else moved**

Run: `cd server && npm test`
Expected: every existing test still passes.

- [ ] **Step 6: Commit**

```bash
git add server/disputes.js server/test/disputes.test.js
git commit -m "feat(disputes): thread store with derived status, unread and caps"
```

---

### Task 2: Image attachments on disk, verified by magic bytes

**Files:**
- Modify: `server/disputes.js` (replace the `attachStore` stub, export the new functions)
- Create: `server/test/dispute-files.test.js`

**Interfaces:**
- Consumes: Task 1's `create`, `addMessage`, `get`, `deleteUserData`.
- Produces, for Tasks 3–5:
  - `sniffImage(buf)` → `'image/png' | 'image/jpeg' | 'image/webp' | null`
  - stored attachment metadata: `{ id, name, mime, bytes }` — `name` is the customer's label, never a path
  - `fileMeta(disputeId, fileId)` → `{ path, mime, name } | null` (returns `null` for anything that is not one of that thread's own attachment ids, so a traversal attempt cannot resolve)
  - `readFile(disputeId, fileId)` → `Buffer | null`

- [ ] **Step 1: Write the failing test**

Create `server/test/dispute-files.test.js`:

```js
/* ============================================================
   EVER NOVA LIFE — dispute attachment tests
   The bytes go to disk and only the metadata into the record.
   What is guarded here: the declared type is never trusted, the
   client's filename is never a path, and deleting an account
   takes the files with it.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-dfiles-'));
process.env.DATA_DIR = TMP_DATA;

const disputes = require('../disputes.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Smallest valid-enough samples: the magic bytes plus filler.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(32, 1)]);
const NOT_AN_IMAGE = Buffer.from('<?php system($_GET["c"]); ?>');

const b64 = (buf) => buf.toString('base64');

function open(over = {}) {
  return disputes.create({
    userId: 'u1', orderId: 'ENL-F' + Math.floor(Math.random() * 1e6),
    reason: 'damaged', body: 'Photo attached.', authorEmail: 'alice@example.com', ...over
  });
}

test('sniffImage recognises png, jpeg and webp and refuses anything else', () => {
  assert.equal(disputes.sniffImage(PNG), 'image/png');
  assert.equal(disputes.sniffImage(JPEG), 'image/jpeg');
  assert.equal(disputes.sniffImage(WEBP), 'image/webp');
  assert.equal(disputes.sniffImage(NOT_AN_IMAGE), null);
});

test('an attached image is written to disk and only its metadata is in the record', () => {
  const d = open({ attachments: [{ name: 'cracked vial.png', data: b64(PNG) }] });
  const att = d.messages[0].attachments;
  assert.equal(att.length, 1);
  assert.equal(att[0].mime, 'image/png');
  assert.equal(att[0].name, 'cracked vial.png');
  assert.equal(att[0].bytes, PNG.length);
  assert.ok(!('data' in att[0]), 'the record must not carry the image data');

  const raw = fs.readFileSync(path.join(TMP_DATA, 'disputes.json'), 'utf8');
  assert.ok(!raw.includes(b64(PNG).slice(0, 24)), 'no base64 payload in the JSON store');

  const buf = disputes.readFile(d.id, att[0].id);
  assert.ok(buf && buf.equals(PNG));
});

test('a file that claims to be a png but is not is refused', () => {
  assert.throws(
    () => open({ attachments: [{ name: 'harmless.png', data: b64(NOT_AN_IMAGE) }] }),
    /image/i
  );
});

test('a file over the size cap is refused', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(disputes.MAX_FILE_BYTES + 1, 7)]);
  assert.throws(() => open({ attachments: [{ name: 'huge.png', data: b64(big) }] }), /2 ?MB|too large/i);
});

test('a fourth image on one message is refused', () => {
  const four = [1, 2, 3, 4].map(n => ({ name: `p${n}.png`, data: b64(PNG) }));
  assert.throws(() => open({ attachments: four }), /3 images|three images/i);
});

test('a data-URL prefix is accepted and stripped', () => {
  const d = open({ attachments: [{ name: 'p.png', data: 'data:image/png;base64,' + b64(PNG) }] });
  assert.equal(d.messages[0].attachments[0].mime, 'image/png');
});

test("the client's filename cannot escape the dispute folder", () => {
  const d = open({ attachments: [{ name: '../../../../escape.png', data: b64(PNG) }] });
  const meta = disputes.fileMeta(d.id, d.messages[0].attachments[0].id);
  const dir = path.join(TMP_DATA, 'dispute-files', d.id);
  assert.ok(meta.path.startsWith(dir + path.sep), 'the stored path stays inside the thread folder');
  assert.ok(fs.existsSync(meta.path));
});

test('fileMeta refuses an id that is not one of this thread\'s attachments', () => {
  const d = open();
  assert.equal(disputes.fileMeta(d.id, '../../disputes'), null);
  assert.equal(disputes.fileMeta(d.id, 'not-a-real-file'), null);
});

test('deleting an account removes its attachment folder from disk', () => {
  const d = open({ userId: 'u-purge', attachments: [{ name: 'p.png', data: b64(PNG) }] });
  const dir = path.join(TMP_DATA, 'dispute-files', d.id);
  assert.ok(fs.existsSync(dir));
  disputes.deleteUserData('u-purge');
  assert.equal(fs.existsSync(dir), false);
});
```

- [ ] **Step 2: Run the test to watch it fail**

Run: `cd server && npm test -- --test-name-pattern="sniffImage"`
Expected: FAIL — `disputes.sniffImage is not a function`.

- [ ] **Step 3: Replace the `attachStore` stub in `server/disputes.js`**

Delete the stub block (`const attachStore = { attach() { return []; }, removeAll() { } };`) and put this in its place. Note that `attachStore` is referenced by `create` before it is defined — that is fine, `const` at module scope is initialised before any exported function runs, and the tests prove it.

```js
/* ============================================================
   ATTACHMENTS
   The bytes go to DATA_DIR/dispute-files/<disputeId>/<fileId>.<ext>
   and only the metadata into the record. A data-URL in the record
   (how product images work) would rewrite a multi-megabyte JSON
   file on every message in every thread.

   Two rules on the way in, both load-bearing:
     1. the type comes from the BYTES, never from the declared MIME
        or the filename — a declared image/png that is really a
        script is refused;
     2. the client's filename is never used as a path — the file is
        stored as <fileId>.<ext> and the given name is kept as a
        display label only.
   ============================================================ */
const FILES_DIR = path.join(DATA_DIR, 'dispute-files');

const MAGIC = [
  { mime: 'image/png', ext: 'png', test: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: b => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' }
];

function sniffImage(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const hit = MAGIC.find(m => m.test(buf));
  return hit ? hit.mime : null;
}
function extFor(mime) { return (MAGIC.find(m => m.mime === mime) || {}).ext || 'bin'; }

let fileSeq = 0;
function newFileId() { return 'f' + Date.now().toString(36) + (fileSeq++).toString(36); }

/* The label the customer sees. Stripped of anything path-shaped so it can
   never be mistaken for one, even by a later change to this file. */
function cleanName(name) {
  const s = String(name == null ? '' : name).replace(/[\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 120) || 'image';
}

const attachStore = {
  /* Returns the metadata array to store on the message. Throws on anything
     it will not accept — the caller has not written the record yet, so a
     throw here leaves nothing behind. */
  attach(disputeId, input) {
    if (!disputeId || !input) return [];
    const list = Array.isArray(input) ? input : [input];
    if (!list.length) return [];
    if (list.length > MAX_FILES_PER_MESSAGE) {
      throw err(`Attach at most ${MAX_FILES_PER_MESSAGE} images to one message.`);
    }

    const dir = path.join(FILES_DIR, disputeId);
    const written = [];
    try {
      const meta = list.map(item => {
        const raw = String((item && item.data) || '').replace(/^data:[^;,]*;base64,/, '');
        let buf;
        try { buf = Buffer.from(raw, 'base64'); } catch (e) { buf = Buffer.alloc(0); }
        if (!buf.length) throw err('That attachment was empty.');
        if (buf.length > MAX_FILE_BYTES) throw err('Each image has to be under 2 MB.');
        const mime = sniffImage(buf);
        if (!mime) throw err('Attachments have to be PNG, JPEG or WebP images.');

        const id = newFileId();
        const file = path.join(dir, id + '.' + extFor(mime));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, buf);
        written.push(file);
        return { id, name: cleanName(item && item.name), mime, bytes: buf.length };
      });
      return meta;
    } catch (e) {
      // One bad image in a batch must not leave the good ones orphaned on disk.
      for (const f of written) { try { fs.unlinkSync(f); } catch (e2) { /* ignore */ } }
      throw e;
    }
  },

  removeAll(disputeId) {
    if (!disputeId) return;
    try { fs.rmSync(path.join(FILES_DIR, disputeId), { recursive: true, force: true }); }
    catch (e) { console.error('[disputes] could not remove attachments:', e.message); }
  }
};

/* Resolve a file id to a path — but ONLY through the record, so an id that
   is not one of this thread's own attachments cannot resolve to anything.
   That is what makes a `../` id inert: it is never joined to a path. */
function fileMeta(disputeId, fileId) {
  const d = get(disputeId);
  if (!d) return null;
  for (const m of d.messages) {
    for (const a of (m.attachments || [])) {
      if (a.id === fileId) {
        return { path: path.join(FILES_DIR, disputeId, a.id + '.' + extFor(a.mime)), mime: a.mime, name: a.name };
      }
    }
  }
  return null;
}

function readFile(disputeId, fileId) {
  const meta = fileMeta(disputeId, fileId);
  if (!meta) return null;
  try { return fs.readFileSync(meta.path); } catch (e) { return null; }
}
```

- [ ] **Step 4: Fix the double-attach in `create`**

In `create`, the record is built with `attachments: attachStore.attach(null, attachments)` and then overwritten on the next line. With Task 2's implementation the first call is a no-op (`disputeId` is null), but the line is now confusing and one edit away from writing the files twice. Replace the two lines so the files are written exactly once, before the record is saved:

```js
  const attached = attachStore.attach(d.id, attachments);
  d.messages[0].attachments = attached;
```

i.e. the message literal keeps `attachments: []`, and the two lines above `const all = load();` become that pair. Delete the old comment about "the attachment ids need the dispute id".

Order matters: `d.id` is generated in the object literal, so `attach` runs after the id exists and before `save`. If `attach` throws, nothing is saved — the thread is not created, which is what the "a fourth image is refused" test asserts.

- [ ] **Step 5: Export the new functions**

In the `module.exports` block, add `sniffImage`, `fileMeta`, `readFile` to the list.

- [ ] **Step 6: Run both dispute test files**

Run: `cd server && node --test test/disputes.test.js test/dispute-files.test.js`
Expected: PASS, 23 tests.

- [ ] **Step 7: Commit**

```bash
git add server/disputes.js server/test/dispute-files.test.js
git commit -m "feat(disputes): image attachments on disk, typed by magic bytes"
```

---

### Task 3: Customer routes

**Files:**
- Modify: `server/server.js` (require the module near line 32; routes; the delete-user cascade around line 735; the `/api/health` flags around line 79)
- Create: `server/test/disputes-api.test.js`

**Interfaces:**
- Consumes: everything Task 1 and Task 2 export.
- Produces, for Tasks 4–7:
  - `GET /api/disputes` → `{ success, reasons, disputes: summary[] }`
  - `POST /api/disputes` `{ orderId, reason, message, attachments }` → `201 { success, dispute }` · `404` not your order · `409 { error, disputeId }` already open · `400` cancelled order
  - `GET /api/disputes/:id` → `{ success, dispute, order }` (`order` is the summary the page shows; `null` if the order has since been voided)
  - `POST /api/disputes/:id/messages` `{ message, attachments }` → `{ success, dispute }`
  - `POST /api/disputes/:id/read` → `{ success }`
  - `GET /api/disputes/:id/files/:fileId` → the image bytes
  - a `disputes: true` flag on `/api/health`

- [ ] **Step 1: Write the failing test**

Create `server/test/disputes-api.test.js`. It boots the app the way `authz.test.js` does, and places a real order so the ownership checks have something to check.

```js
/* ============================================================
   EVER NOVA LIFE — dispute API tests
   Ownership is the whole point of this file: one account must not
   be able to read, answer or download another account's report,
   and the refusal must not tell them whether it exists.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-disp-api-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-disputes';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
delete process.env.ADMIN_KEY;

const app = require('../server.js');
const store = require('../store.js');

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

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, res };
}

async function signUp(email) {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'T', lastName: 'U', email, password: 'password123' }
  });
  return { token: r.body.token, user: r.body.user };
}

/* An order has to exist for a report to hang off. The checkout path needs a
   payment gateway; the store module is what checkout writes through, so we
   write through it directly and keep this test about disputes. */
function placeOrder(userId, orderId, over = {}) {
  return store.addOrder(userId, {
    orderId, status: 'shipped', total: 96.39, method: 'crypto',
    createdAt: new Date().toISOString(),
    items: [{ id: 7, name: 'Test peptide', price: 96.39, quantity: 1 }],
    ...over
  });
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]).toString('base64');

test('anonymous callers get 401 on every dispute route', async () => {
  const cases = [
    ['GET', '/api/disputes'],
    ['POST', '/api/disputes'],
    ['GET', '/api/disputes/DSP-NOPE'],
    ['POST', '/api/disputes/DSP-NOPE/messages'],
    ['POST', '/api/disputes/DSP-NOPE/read'],
    ['GET', '/api/disputes/DSP-NOPE/files/f1']
  ];
  for (const [method, pathname] of cases) {
    const { status } = await api(pathname, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(status, 401, `${method} ${pathname} should be 401, got ${status}`);
  }
});

test('a customer opens a report on their own order', async () => {
  const alice = await signUp('alice-d@example.com');
  placeOrder(alice.user.id, 'ENL-OWN1');
  const { status, body } = await api('/api/disputes', {
    method: 'POST', token: alice.token,
    body: { orderId: 'ENL-OWN1', reason: 'damaged', message: 'A vial arrived cracked.', attachments: [{ name: 'v.png', data: PNG }] }
  });
  assert.equal(status, 201);
  assert.equal(body.dispute.orderId, 'ENL-OWN1');
  assert.equal(body.dispute.status, 'awaiting_us');
  assert.equal(body.dispute.messages[0].attachments.length, 1);
});

test('opening a report on an order that is not yours is a 404', async () => {
  const bob = await signUp('bob-d@example.com');
  const { status } = await api('/api/disputes', {
    method: 'POST', token: bob.token,
    body: { orderId: 'ENL-OWN1', reason: 'damaged', message: 'Not mine.' }
  });
  assert.equal(status, 404);
});

test('a second report on the same order is a 409 that names the first', async () => {
  const carol = await signUp('carol-d@example.com');
  placeOrder(carol.user.id, 'ENL-DUP1');
  const first = await api('/api/disputes', {
    method: 'POST', token: carol.token,
    body: { orderId: 'ENL-DUP1', reason: 'not_delivered', message: 'Nothing arrived.' }
  });
  assert.equal(first.status, 201);
  const second = await api('/api/disputes', {
    method: 'POST', token: carol.token,
    body: { orderId: 'ENL-DUP1', reason: 'not_delivered', message: 'Still nothing.' }
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.disputeId, first.body.dispute.id);
});

test('a report cannot be opened on a cancelled order', async () => {
  const dave = await signUp('dave-d@example.com');
  placeOrder(dave.user.id, 'ENL-CANC', { status: 'cancelled' });
  const { status } = await api('/api/disputes', {
    method: 'POST', token: dave.token,
    body: { orderId: 'ENL-CANC', reason: 'other', message: 'Hello?' }
  });
  assert.equal(status, 400);
});

test("another account gets 404 — not 403 — on someone else's thread", async () => {
  const erin = await signUp('erin-d@example.com');
  placeOrder(erin.user.id, 'ENL-PRIV');
  const mine = await api('/api/disputes', {
    method: 'POST', token: erin.token,
    body: { orderId: 'ENL-PRIV', reason: 'billing', message: 'The total looks wrong.', attachments: [{ name: 'r.png', data: PNG }] }
  });
  const id = mine.body.dispute.id;
  const fileId = mine.body.dispute.messages[0].attachments[0].id;

  const frank = await signUp('frank-d@example.com');
  assert.equal((await api(`/api/disputes/${id}`, { token: frank.token })).status, 404);
  assert.equal((await api(`/api/disputes/${id}/messages`, { method: 'POST', token: frank.token, body: { message: 'hi' } })).status, 404);
  assert.equal((await api(`/api/disputes/${id}/files/${fileId}`, { token: frank.token })).status, 404);

  // …and the owner can still do all three.
  assert.equal((await api(`/api/disputes/${id}`, { token: erin.token })).status, 200);
  const img = await api(`/api/disputes/${id}/files/${fileId}`, { token: erin.token });
  assert.equal(img.res.status, 200);
  assert.equal(img.res.headers.get('content-type'), 'image/png');
});

test('GET /api/disputes lists only my threads, and carries the reason list', async () => {
  const gina = await signUp('gina-d@example.com');
  placeOrder(gina.user.id, 'ENL-LIST1');
  await api('/api/disputes', { method: 'POST', token: gina.token, body: { orderId: 'ENL-LIST1', reason: 'other', message: 'A question.' } });
  const { status, body } = await api('/api/disputes', { token: gina.token });
  assert.equal(status, 200);
  assert.equal(body.disputes.length, 1);
  assert.ok(body.reasons.some(r => r.code === 'damaged'));
  assert.ok(!('messages' in body.disputes[0]), 'the list is summaries only');
});

test('the thread comes back with its order summary attached', async () => {
  const hana = await signUp('hana-d@example.com');
  placeOrder(hana.user.id, 'ENL-WITHORD');
  const made = await api('/api/disputes', { method: 'POST', token: hana.token, body: { orderId: 'ENL-WITHORD', reason: 'wrong_item', message: 'Wrong vial.' } });
  const { body } = await api(`/api/disputes/${made.body.dispute.id}`, { token: hana.token });
  assert.equal(body.order.orderId, 'ENL-WITHORD');
  assert.equal(body.order.total, 96.39);
  assert.ok(Array.isArray(body.order.items));
});

test('read stamps the thread so it stops counting as unread for the customer', async () => {
  const ivan = await signUp('ivan-d@example.com');
  placeOrder(ivan.user.id, 'ENL-READ');
  const made = await api('/api/disputes', { method: 'POST', token: ivan.token, body: { orderId: 'ENL-READ', reason: 'other', message: 'Hello.' } });
  const r = await api(`/api/disputes/${made.body.dispute.id}/read`, { method: 'POST', token: ivan.token });
  assert.equal(r.status, 200);
});

test('deleting the account takes the threads with it', async () => {
  const jack = await signUp('jack-d@example.com');
  placeOrder(jack.user.id, 'ENL-DEL');
  const made = await api('/api/disputes', { method: 'POST', token: jack.token, body: { orderId: 'ENL-DEL', reason: 'other', message: 'Bye.' } });
  const boss = await signUp('boss@evernovalife.com');
  const del = await api(`/api/admin/users/${jack.user.id}`, { method: 'DELETE', token: boss.token });
  assert.equal(del.status, 200);
  const disputes = require('../disputes.js');
  assert.equal(disputes.get(made.body.dispute.id), null);
});
```

- [ ] **Step 2: Run the test to watch it fail**

Run: `cd server && node --test test/disputes-api.test.js`
Expected: FAIL — the 401 test passes by accident (unknown route → 404, not 401), so read the failures: `POST /api/disputes` returns 404 instead of 201.

- [ ] **Step 3: Wire the module into `server/server.js`**

Beside the other requires (after `const outreach = require('./outreach.js');`, around line 31):

```js
const disputes = require('./disputes.js');
```

In the `/api/health` flag block (around line 79, next to `orderLookup: true`):

```js
    disputes: true,               // customer dispute threads exist (support.html)
```

In the delete-user cascade (`app.delete('/api/admin/users/:id'…`, around line 735), after the subscriptions line:

```js
  // Threads AND the images on disk — this is the only cascade that leaves
  // bytes behind if it is missed.
  try { disputes.deleteUserData(id); } catch (e) { console.error('[admin delete] dispute cleanup failed:', e.message); }
```

- [ ] **Step 4: Add the customer routes**

Put this block after the order routes and before the admin section — search for `app.get('/api/admin/orders'` and place it above that, so the file keeps its customer-then-admin shape.

```js
/* ============================================================
   CUSTOMER DISPUTES
   A thread about one order, opened by the account that placed it.
   Deliberately narrow: no guest path (an account is required to
   order, so almost every order has one), and resolving records an
   outcome — it never moves money or stock. See
   docs/superpowers/specs/2026-08-20-customer-disputes-design.md
   ============================================================ */

const disputeOpenLimiter = ratelimit.limit({
  name: 'dispute-open',
  windowMs: 60 * 60 * 1000,
  max: 6,
  message: 'That is a lot of reports in an hour. Reply on one of the open ones, or email support@evernovalife.com.'
});
const disputePostLimiter = ratelimit.limit({
  name: 'dispute-post',
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'Too many messages from this connection. Wait a few minutes and try again.'
});

/* The slice of an order a dispute page needs: enough to talk about the
   parcel without opening another tab, and nothing the thread has no use
   for (no address, no payment ledger). */
function disputeOrderView(order) {
  if (!order) return null;
  return {
    orderId: order.orderId,
    status: order.status,
    total: order.total,
    createdAt: order.createdAt,
    carrier: order.carrier || '',
    tracking: order.tracking || '',
    items: (order.items || []).map(i => ({
      name: i.name, quantity: i.quantity, paidQuantity: i.paidQuantity, price: i.price
    }))
  };
}

/* The caller's own order, or null. Every dispute route that names an order
   goes through this — it is the ownership check. */
function ownOrder(userId, orderId) {
  return store.listOrders(userId).find(o => o && o.orderId === orderId) || null;
}

app.get('/api/disputes', auth.requireAuth, (req, res) => {
  const mine = disputes.listForUser(req.user.id).map(disputes.summarize);
  res.json({ success: true, reasons: disputes.REASONS, disputes: mine });
});

app.post('/api/disputes', auth.requireAuth, disputeOpenLimiter, (req, res) => {
  const orderId = String(req.body.orderId || '').trim();
  const order = ownOrder(req.user.id, orderId);
  // 404, not 403: a 403 would confirm that the reference belongs to someone.
  if (!order) return res.status(404).json({ error: 'No order of yours with that reference.' });
  if (order.status === 'cancelled') {
    return res.status(400).json({ error: 'That order was cancelled. If something is still wrong, email support@evernovalife.com.' });
  }
  try {
    const d = disputes.create({
      userId: req.user.id,
      orderId,
      reason: req.body.reason,
      body: req.body.message,
      authorEmail: req.user.email,
      attachments: req.body.attachments
    });
    res.status(201).json({ success: true, dispute: d, order: disputeOrderView(order) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, disputeId: err.disputeId });
  }
});

/* One helper for the three routes that read a thread: it returns the thread
   only to its owner, and answers 404 for everything else — a wrong id and
   someone else's id are indistinguishable from outside. */
function ownDispute(req) {
  const d = disputes.get(req.params.id);
  if (!d || d.userId !== req.user.id) return null;
  return d;
}

app.get('/api/disputes/:id', auth.requireAuth, (req, res) => {
  const d = ownDispute(req);
  if (!d) return res.status(404).json({ error: 'No report with that reference.' });
  res.json({ success: true, dispute: d, order: disputeOrderView(ownOrder(req.user.id, d.orderId)) });
});

app.post('/api/disputes/:id/messages', auth.requireAuth, disputePostLimiter, (req, res) => {
  const d = ownDispute(req);
  if (!d) return res.status(404).json({ error: 'No report with that reference.' });
  try {
    const updated = disputes.addMessage(d.id, {
      from: 'customer',
      authorEmail: req.user.email,
      body: req.body.message,
      attachments: req.body.attachments
    });
    res.json({ success: true, dispute: updated });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/api/disputes/:id/read', auth.requireAuth, (req, res) => {
  const d = ownDispute(req);
  if (!d) return res.status(404).json({ error: 'No report with that reference.' });
  disputes.markRead(d.id, 'customer');
  res.json({ success: true });
});

app.get('/api/disputes/:id/files/:fileId', auth.requireAuth, (req, res) => {
  const d = ownDispute(req);
  if (!d) return res.status(404).json({ error: 'No report with that reference.' });
  const meta = disputes.fileMeta(d.id, req.params.fileId);
  const buf = meta && disputes.readFile(d.id, req.params.fileId);
  if (!buf) return res.status(404).json({ error: 'No such attachment.' });
  res.set('Content-Type', meta.mime);
  res.set('Content-Disposition', 'inline');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(buf);
});
```

- [ ] **Step 5: Run the API tests**

Run: `cd server && node --test test/disputes-api.test.js`
Expected: PASS, 10 tests. The "deleting the account" test also proves the cascade from Step 3.

- [ ] **Step 6: Run the whole suite**

Run: `cd server && npm test`
Expected: everything passes, including `authz.test.js`.

- [ ] **Step 7: Commit**

```bash
git add server/server.js server/test/disputes-api.test.js
git commit -m "feat(disputes): customer routes, ownership-gated and rate-limited"
```

---

### Task 4: Admin routes

**Files:**
- Modify: `server/server.js` (admin section, beside the other `requireAdmin` routes)
- Modify: `server/test/disputes-api.test.js` (append)

**Interfaces:**
- Consumes: Task 3's routes and helpers (`disputeOrderView`).
- Produces, for Tasks 5–6:
  - `GET /api/admin/disputes` → `{ success, reasons, outcomes, disputes: (summary & { customerEmail, order })[] }`
  - `GET /api/admin/disputes/:id` → `{ success, dispute, order, customer }`
  - `POST /api/admin/disputes/:id/messages` `{ message, attachments }` → `{ success, dispute }`
  - `POST /api/admin/disputes/:id/resolve` `{ outcome, note }` → `{ success, dispute }`
  - `POST /api/admin/disputes/:id/reopen` → `{ success, dispute }`
  - `POST /api/admin/disputes/:id/read` → `{ success }`

- [ ] **Step 1: Append the failing tests**

Add to the end of `server/test/disputes-api.test.js`:

```js
/* ============================================================
   ADMIN SIDE
   ============================================================ */

async function adminToken() {
  const r = await api('/api/auth/login', { method: 'POST', body: { email: 'boss@evernovalife.com', password: 'password123' } });
  if (r.body && r.body.token) return r.body.token;
  const reg = await signUp('boss@evernovalife.com');
  return reg.token;
}

test('an ordinary account is refused every admin dispute route', async () => {
  const mallory = await signUp('mallory-d@example.com');
  const cases = [
    ['GET', '/api/admin/disputes'],
    ['GET', '/api/admin/disputes/DSP-NOPE'],
    ['POST', '/api/admin/disputes/DSP-NOPE/messages'],
    ['POST', '/api/admin/disputes/DSP-NOPE/resolve'],
    ['POST', '/api/admin/disputes/DSP-NOPE/reopen'],
    ['POST', '/api/admin/disputes/DSP-NOPE/read']
  ];
  for (const [method, pathname] of cases) {
    const { status } = await api(pathname, { method, token: mallory.token, body: method === 'GET' ? undefined : {} });
    assert.equal(status, 401, `${method} ${pathname} should be 401 for a non-admin, got ${status}`);
  }
});

test('the admin list stitches the customer and the order onto each thread', async () => {
  const nina = await signUp('nina-d@example.com');
  placeOrder(nina.user.id, 'ENL-ADM1');
  await api('/api/disputes', { method: 'POST', token: nina.token, body: { orderId: 'ENL-ADM1', reason: 'damaged', message: 'Cracked.' } });

  const token = await adminToken();
  const { status, body } = await api('/api/admin/disputes', { token });
  assert.equal(status, 200);
  const row = body.disputes.find(d => d.orderId === 'ENL-ADM1');
  assert.ok(row, 'the new thread is in the list');
  assert.equal(row.customerEmail, 'nina-d@example.com');
  assert.equal(row.order.total, 96.39);
  assert.equal(row.unreadForAdmin, true);
  assert.ok(body.outcomes.some(o => o.code === 'refunded'));
});

test('the store replies, the thread flips, and the customer sees it', async () => {
  const omar = await signUp('omar-d@example.com');
  placeOrder(omar.user.id, 'ENL-ADM2');
  const made = await api('/api/disputes', { method: 'POST', token: omar.token, body: { orderId: 'ENL-ADM2', reason: 'not_delivered', message: 'Nothing came.' } });
  const id = made.body.dispute.id;

  const token = await adminToken();
  const reply = await api(`/api/admin/disputes/${id}/messages`, { method: 'POST', token, body: { message: 'We have opened a claim with the courier.' } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.dispute.status, 'awaiting_customer');

  const seen = await api(`/api/disputes/${id}`, { token: omar.token });
  assert.equal(seen.body.dispute.messages.length, 2);
  assert.equal(seen.body.dispute.messages[1].from, 'admin');
});

test('resolving records the outcome and closes the thread to replies', async () => {
  const pia = await signUp('pia-d@example.com');
  placeOrder(pia.user.id, 'ENL-ADM3');
  const made = await api('/api/disputes', { method: 'POST', token: pia.token, body: { orderId: 'ENL-ADM3', reason: 'damaged', message: 'Broken.' } });
  const id = made.body.dispute.id;
  const token = await adminToken();

  const done = await api(`/api/admin/disputes/${id}/resolve`, { method: 'POST', token, body: { outcome: 'replaced', note: 'Reshipped.' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.dispute.status, 'resolved');
  assert.equal(done.body.dispute.outcome, 'replaced');

  const blocked = await api(`/api/disputes/${id}/messages`, { method: 'POST', token: pia.token, body: { message: 'Thanks!' } });
  assert.equal(blocked.status, 409);

  const back = await api(`/api/admin/disputes/${id}/reopen`, { method: 'POST', token });
  assert.equal(back.body.dispute.status, 'awaiting_customer');
  const allowed = await api(`/api/disputes/${id}/messages`, { method: 'POST', token: pia.token, body: { message: 'Thanks!' } });
  assert.equal(allowed.status, 200);
});

test('an unknown outcome is refused', async () => {
  const quinn = await signUp('quinn-d@example.com');
  placeOrder(quinn.user.id, 'ENL-ADM4');
  const made = await api('/api/disputes', { method: 'POST', token: quinn.token, body: { orderId: 'ENL-ADM4', reason: 'other', message: 'Hm.' } });
  const token = await adminToken();
  const bad = await api(`/api/admin/disputes/${made.body.dispute.id}/resolve`, { method: 'POST', token, body: { outcome: 'whatever' } });
  assert.equal(bad.status, 400);
});

test('an admin can download an attachment on any thread', async () => {
  const rosa = await signUp('rosa-d@example.com');
  placeOrder(rosa.user.id, 'ENL-ADM5');
  const made = await api('/api/disputes', {
    method: 'POST', token: rosa.token,
    body: { orderId: 'ENL-ADM5', reason: 'damaged', message: 'See photo.', attachments: [{ name: 'p.png', data: PNG }] }
  });
  const id = made.body.dispute.id;
  const fileId = made.body.dispute.messages[0].attachments[0].id;
  const token = await adminToken();
  const img = await api(`/api/admin/disputes/${id}/files/${fileId}`, { token });
  assert.equal(img.res.status, 200);
  assert.equal(img.res.headers.get('content-type'), 'image/png');
});
```

Note: `adminToken()` logs in first because `boss@evernovalife.com` may already have been registered by the delete-user test earlier in the file. Registration of an existing email fails; the login path covers it.

- [ ] **Step 2: Run to watch it fail**

Run: `cd server && node --test test/disputes-api.test.js`
Expected: FAIL — `GET /api/admin/disputes` returns 404.

- [ ] **Step 3: Add the admin routes**

In `server/server.js`, directly after the customer dispute block from Task 3:

```js
/* ---- ADMIN: the dispute queue ----
   The owner works from this: every thread, newest activity first, each with
   the order and the customer already attached so the queue answers "what is
   this about?" without a second request. */
app.get('/api/admin/disputes', requireAdmin, (req, res) => {
  const rows = disputes.list().map(d => {
    const user = auth.getUserById(d.userId);
    const order = store.listOrders(d.userId).find(o => o && o.orderId === d.orderId) || null;
    return {
      ...disputes.summarize(d),
      customerEmail: user ? user.email : '',
      customerName: user ? [user.firstName, user.lastName].filter(Boolean).join(' ') : '',
      order: disputeOrderView(order)
    };
  });
  res.json({ success: true, reasons: disputes.REASONS, outcomes: disputes.OUTCOMES, disputes: rows });
});

app.get('/api/admin/disputes/:id', requireAdmin, (req, res) => {
  const d = disputes.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'No report with that reference.' });
  const user = auth.getUserById(d.userId);
  const order = store.listOrders(d.userId).find(o => o && o.orderId === d.orderId) || null;
  res.json({
    success: true,
    dispute: d,
    order: disputeOrderView(order),
    customer: user ? { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName } : null
  });
});

app.post('/api/admin/disputes/:id/messages', requireAdmin, async (req, res) => {
  const d = disputes.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'No report with that reference.' });
  try {
    const updated = disputes.addMessage(d.id, {
      from: 'admin',
      authorEmail: (req.user && req.user.email) || 'admin',
      body: req.body.message,
      attachments: req.body.attachments
    });
    sendDisputeReplyEmail(updated).catch(e => console.error('[disputes] reply email failed:', e.message));
    res.json({ success: true, dispute: updated });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/api/admin/disputes/:id/resolve', requireAdmin, (req, res) => {
  const d = disputes.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'No report with that reference.' });
  try {
    const updated = disputes.resolve(d.id, {
      outcome: req.body.outcome,
      note: req.body.note,
      by: (req.user && req.user.email) || 'admin'
    });
    sendDisputeResolvedEmail(updated).catch(e => console.error('[disputes] resolved email failed:', e.message));
    res.json({ success: true, dispute: updated });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/api/admin/disputes/:id/reopen', requireAdmin, (req, res) => {
  const d = disputes.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'No report with that reference.' });
  res.json({ success: true, dispute: disputes.reopen(d.id, { by: (req.user && req.user.email) || 'admin' }) });
});

app.post('/api/admin/disputes/:id/read', requireAdmin, (req, res) => {
  const d = disputes.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'No report with that reference.' });
  disputes.markRead(d.id, 'admin');
  res.json({ success: true });
});

app.get('/api/admin/disputes/:id/files/:fileId', requireAdmin, (req, res) => {
  const meta = disputes.fileMeta(req.params.id, req.params.fileId);
  const buf = meta && disputes.readFile(req.params.id, req.params.fileId);
  if (!buf) return res.status(404).json({ error: 'No such attachment.' });
  res.set('Content-Type', meta.mime);
  res.set('Content-Disposition', 'inline');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(buf);
});
```

- [ ] **Step 4: Add temporary email stubs so the routes run**

The two `send…Email` functions arrive in Task 5. Add them now as no-ops directly above the admin block, so this task's tests can pass on their own:

```js
/* Filled in by the notification task; declared here so the routes above have
   something to call. */
async function sendDisputeReplyEmail() { }
async function sendDisputeResolvedEmail() { }
```

- [ ] **Step 5: Run the API tests**

Run: `cd server && node --test test/disputes-api.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 6: Add the new admin routes to the authz sweep**

In `server/test/authz.test.js`, in the "anonymous users get 401 on all account/admin endpoints" case list, add:

```js
    ['GET', '/api/disputes'],
    ['POST', '/api/disputes'],
    ['GET', '/api/admin/disputes'],
    ['POST', '/api/admin/disputes/DSP-NOPE/resolve'],
```

- [ ] **Step 7: Run the whole suite**

Run: `cd server && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add server/server.js server/test/disputes-api.test.js server/test/authz.test.js
git commit -m "feat(disputes): admin queue routes — reply, resolve, reopen"
```

---

### Task 5: Notification emails

**Files:**
- Modify: `server/server.js` (replace the two stubs from Task 4 Step 4)
- Create: `server/test/dispute-email.test.js`

**Interfaces:**
- Consumes: Task 4's call sites, `mailer` (`server/email.js`), `escapeHtmlSrv` (already in `server.js`).
- Produces: nothing further consumes these.

The rule this task exists to enforce: **the message body never goes in the email.** A dispute can carry an address, a courier claim, a photo description; once it is in a mail body it lives in whatever chain that mail gets forwarded into. The notification is a doorbell.

- [ ] **Step 1: Write the failing test**

Create `server/test/dispute-email.test.js`. It calls the builders directly rather than sending mail, so it needs them exported for testing.

```js
/* ============================================================
   EVER NOVA LIFE — dispute notification tests
   One rule, tested from both directions: the notification links
   to the thread and NEVER carries the message body.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-dmail-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-dmail';
process.env.SITE_URL = 'https://evernovalife.com';

const app = require('../server.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

const SECRET = 'the tracking number is 9400111899223197428490';

const thread = {
  id: 'DSP-TEST',
  orderId: 'ENL-MAIL1',
  status: 'awaiting_customer',
  outcome: '',
  outcomeNote: '',
  messages: [
    { from: 'customer', body: 'It never arrived.', createdAt: '2026-08-20T10:00:00.000Z' },
    { from: 'admin', body: SECRET, createdAt: '2026-08-20T11:00:00.000Z' }
  ]
};

test('the reply notice links to the thread and omits the message body', () => {
  const mail = app.buildDisputeReplyMail(thread, 'alice@example.com', 'Alice');
  assert.match(mail.subject, /ENL-MAIL1/);
  assert.ok(mail.text.includes('support.html?order=ENL-MAIL1'), 'links to the thread');
  assert.ok(mail.html.includes('support.html?order=ENL-MAIL1'));
  assert.ok(!mail.text.includes(SECRET), 'the reply body is not in the plain text');
  assert.ok(!mail.html.includes(SECRET), 'the reply body is not in the HTML');
});

test('the resolved notice carries the outcome and the note, but still no message body', () => {
  const closed = { ...thread, status: 'resolved', outcome: 'replaced', outcomeNote: 'Reshipped on the 21st.' };
  const mail = app.buildDisputeResolvedMail(closed, 'alice@example.com', 'Alice');
  assert.match(mail.subject, /ENL-MAIL1/);
  assert.ok(mail.text.includes('Replacement sent'), 'the outcome label is in the notice');
  assert.ok(mail.text.includes('Reshipped on the 21st.'), 'the note is in the notice');
  assert.ok(!mail.text.includes(SECRET));
  assert.ok(!mail.html.includes(SECRET));
});

test('a note with markup in it is escaped in the HTML part', () => {
  const closed = { ...thread, status: 'resolved', outcome: 'no_action', outcomeNote: '<script>alert(1)</script>' };
  const mail = app.buildDisputeResolvedMail(closed, 'alice@example.com', 'Alice');
  assert.ok(!mail.html.includes('<script>'), 'the note is escaped');
  assert.ok(mail.html.includes('&lt;script&gt;'));
});
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd server && node --test test/dispute-email.test.js`
Expected: FAIL — `app.buildDisputeReplyMail is not a function`.

- [ ] **Step 3: Replace the stubs with the real senders**

In `server/server.js`, replace the two no-op stubs added in Task 4 Step 4 with:

```js
/* ============================================================
   DISPUTE NOTIFICATIONS
   A doorbell, not a transcript: the mail says a reply is waiting
   and links to the thread. The message body is deliberately NOT
   included — a dispute can carry an address or a courier claim,
   and once that is in a mail body it lives in whatever chain the
   mail gets forwarded into.
   ============================================================ */
function disputeLink(d) {
  const site = (process.env.SITE_URL || 'https://evernovalife.com').replace(/\/+$/, '');
  return `${site}/support.html?order=${encodeURIComponent(d.orderId)}`;
}

function buildDisputeReplyMail(d, email, name) {
  const link = disputeLink(d);
  const who = name || 'there';
  const subject = `We've replied about your report on order ${d.orderId}`;
  const text = `Hi ${who},\n\n` +
    `There's a reply waiting on your report about order ${d.orderId}.\n\n` +
    `Read it and answer here:\n${link}\n\n` +
    `We keep the conversation on the site rather than in email so everything about the order stays in one place.\n\n` +
    `— The Ever Nova Life team`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="color:#6d28d9;margin-bottom:4px">We've replied</h2>
    <p>Hi ${escapeHtmlSrv(who)}, there's a reply waiting on your report about order <strong>${escapeHtmlSrv(d.orderId)}</strong>.</p>
    <p><a href="${link}" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Read the reply</a></p>
    <p style="color:#9ca3af;font-size:12px;margin-top:24px">We keep the conversation on the site rather than in email so everything about the order stays in one place.</p>
  </div>`;
  return { to: email, subject, text, html };
}

function buildDisputeResolvedMail(d, email, name) {
  const link = disputeLink(d);
  const who = name || 'there';
  const label = (disputes.OUTCOMES.find(o => o.code === d.outcome) || {}).label || 'Closed';
  const note = String(d.outcomeNote || '').trim();
  const subject = `Your report on order ${d.orderId} is resolved`;
  const text = `Hi ${who},\n\n` +
    `We've closed your report about order ${d.orderId}.\n\n` +
    `Outcome: ${label}\n` +
    (note ? `Note: ${note}\n` : '') +
    `\nThe full conversation stays here:\n${link}\n\n` +
    `If this isn't settled, open a new report from the order and we'll pick it up.\n\n` +
    `— The Ever Nova Life team`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="color:#6d28d9;margin-bottom:4px">Report resolved</h2>
    <p>Hi ${escapeHtmlSrv(who)}, we've closed your report about order <strong>${escapeHtmlSrv(d.orderId)}</strong>.</p>
    <p><strong>Outcome:</strong> ${escapeHtmlSrv(label)}</p>
    ${note ? `<p><strong>Note:</strong> ${escapeHtmlSrv(note)}</p>` : ''}
    <p><a href="${link}" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">See the conversation</a></p>
    <p style="color:#9ca3af;font-size:12px;margin-top:24px">If this isn't settled, open a new report from the order and we'll pick it up.</p>
  </div>`;
  return { to: email, subject, text, html };
}

/* Nothing emails the owner: the rail tally in the admin console is that
   notification, and a second channel for the same event is just noise. */
async function sendDisputeReplyEmail(d) {
  if (!mailer.CONFIGURED) return;
  const user = auth.getUserById(d.userId);
  if (!user || !user.email) return;
  return mailer.sendMail(buildDisputeReplyMail(d, user.email, user.firstName));
}

async function sendDisputeResolvedEmail(d) {
  if (!mailer.CONFIGURED) return;
  const user = auth.getUserById(d.userId);
  if (!user || !user.email) return;
  return mailer.sendMail(buildDisputeResolvedMail(d, user.email, user.firstName));
}
```

- [ ] **Step 4: Export the builders for the test**

`server.js` already exports the app. Find the `module.exports` at the bottom and hang the two builders off it, the way the file already exposes the app for tests:

```js
app.buildDisputeReplyMail = buildDisputeReplyMail;
app.buildDisputeResolvedMail = buildDisputeResolvedMail;
```

Place those two lines immediately above the existing `module.exports = app;`. If the export is written differently, match whatever is there — the test reads `app.buildDisputeReplyMail`.

- [ ] **Step 5: Run the email tests**

Run: `cd server && node --test test/dispute-email.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the whole suite**

Run: `cd server && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/server.js server/test/dispute-email.test.js
git commit -m "feat(disputes): notify the customer on reply and resolution"
```

---

### Task 6: Admin console — nav, tally and the Disputes view

**Files:**
- Modify: `js/admin-core.js` (`ICONS` around line 130, `NAV` around line 223)
- Modify: `js/admin-console.js` (`state` around line 51, `loadAll` around line 74, `TITLES` around line 332, the tally block around line 384, the delegated click handler around line 2440)
- Create: `js/admin-disputes.js`
- Modify: `admin.html` (script tag)
- Modify: `css/styles.css` (append the thread styles)

**Interfaces:**
- Consumes: Task 4's admin routes; `A` (the `window.ENLAdmin` helper object from `admin-core.js`) with `A.api`, `A.esc`, `A.money`, `A.date`, `A.ago`, `A.toast`, `A.empty`, `A.icon`.
- Produces: `window.ENLDisputes` with `{ render(state, body, handlers), handleClick(target, ctx) }`, consumed only by `admin-console.js`.

There is no browser test runner in this project. Verification is a scripted check of the file's shape plus a manual pass in the browser, both spelled out below.

- [ ] **Step 1: Add the icon and the nav entry**

In `js/admin-core.js`, add to `ICONS` (keep the 24×24 stroke style of its neighbours):

```js
    chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
```

In `NAV`, between the `autoship` and `customers` entries:

```js
    { key: 'disputes', href: 'admin.html#disputes', label: 'Disputes', icon: 'chat', tally: 'navDisputes' },
```

- [ ] **Step 2: Load the queue and show the tally**

In `js/admin-console.js`:

Add to `state` (after `promos: null,`):

```js
    disputes: null,       // customer dispute threads (the queue and its tally)
    disputeId: '',        // which thread the right pane is showing
    disputeThread: null,  // the full thread, loaded when one is opened
    disputeTab: 'awaiting_us',
```

Add to the `Promise.allSettled` list in `loadAll`, at the end:

```js
      A.api('/api/admin/disputes')
```

and after the existing assignments:

```js
    state.disputes = results[8].status === 'fulfilled' ? (results[8].value.disputes || []) : (state.disputes || []);
```

(Confirm the index: the array currently holds 8 entries ending with `/api/admin/promotions`, so the new one is `results[8]`. If the list has grown, use the last index.)

Add to `TITLES`:

```js
    disputes: ['Disputes', 'Problems customers have reported, and how they ended'],
```

In the tally block, beside `navShip`:

```js
    // Threads where the customer spoke last — the queue that is waiting on us.
    var dq = document.getElementById('navDisputes');
    if (dq) {
      var n3 = (state.disputes || []).filter(function (d) { return d.unreadForAdmin; }).length;
      dq.textContent = n3 ? String(n3) : '';
    }
```

In the view switch inside `render()` (wherever `state.view === 'promos'` is handled — follow the existing shape), add the `disputes` branch delegating to the new file:

```js
      case 'disputes':
        window.ENLDisputes.render(state, body, {
          open: openDispute, reply: replyToDispute, resolve: resolveDispute,
          reopen: reopenDispute, tab: setDisputeTab
        });
        break;
```

- [ ] **Step 3: Write the view**

Create `js/admin-disputes.js`:

```js
/* ============================================================
   EVER NOVA LIFE — admin: dispute threads
   The Disputes view: a queue on the left, one thread on the right
   with the order it is about sitting above the conversation.

   It lives in its own file because admin-console.js is already
   long, and a message stream with a composer, image previews and
   a resolve control is a screen, not a section.

   Talks to /api/admin/disputes. Rendered wholesale on every state
   change, like every other view here — so no listeners are wired
   in this file; the console's delegated handler calls back in.
   ============================================================ */
(function (window, document) {
  'use strict';
  var A = window.ENLAdmin;

  var TABS = [
    { key: 'awaiting_us', label: 'Awaiting us' },
    { key: 'awaiting_customer', label: 'Awaiting customer' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'all', label: 'All' }
  ];

  var STATUS_LABEL = {
    awaiting_us: 'Waiting on us',
    awaiting_customer: 'Waiting on them',
    resolved: 'Resolved'
  };

  function filtered(list, tab) {
    list = list || [];
    if (tab === 'all') return list;
    return list.filter(function (d) { return d.status === tab; });
  }

  function queueRow(d, activeId) {
    return '<button type="button" class="dsp-row' + (d.id === activeId ? ' active' : '') +
      (d.unreadForAdmin ? ' unread' : '') + '" data-dsp-open="' + A.esc(d.id) + '">' +
      '<div class="dsp-row-top"><strong>' + A.esc(d.orderId) + '</strong>' +
        '<span class="dsp-when">' + A.esc(A.ago(d.lastAt)) + '</span></div>' +
      '<div class="dsp-row-who">' + A.esc(d.customerEmail || '') + '</div>' +
      '<div class="dsp-row-why">' + A.esc(d.reasonLabel || '') + '</div>' +
      '<span class="dsp-chip dsp-' + A.esc(d.status) + '">' + A.esc(STATUS_LABEL[d.status] || d.status) + '</span>' +
      '</button>';
  }

  function orderCard(order) {
    if (!order) {
      return '<div class="dsp-order muted">That order is no longer in the books.</div>';
    }
    var items = (order.items || []).map(function (i) {
      var shipped = i.quantity;
      var paid = (i.paidQuantity == null) ? i.quantity : i.paidQuantity;
      // A BOGO line ships more than it bills, so both numbers earn their place.
      var qty = (paid !== shipped) ? (shipped + ' shipped · ' + paid + ' billed') : ('×' + shipped);
      return '<li>' + A.esc(i.name) + ' <span class="muted">' + A.esc(qty) + '</span></li>';
    }).join('');
    var track = [order.carrier, order.tracking].filter(Boolean).join(' · ');
    return '<div class="dsp-order">' +
      '<div class="dsp-order-head"><strong>' + A.esc(order.orderId) + '</strong>' +
        '<span class="muted">' + A.esc(A.date(order.createdAt)) + '</span>' +
        '<span class="dsp-chip">' + A.esc(order.status || '') + '</span>' +
        '<span>' + A.esc(A.money(order.total)) + '</span></div>' +
      '<ul class="dsp-order-items">' + items + '</ul>' +
      (track ? '<div class="muted">Tracking: ' + A.esc(track) + '</div>' : '') +
      '</div>';
  }

  function attachmentsHtml(disputeId, list) {
    if (!list || !list.length) return '';
    return '<div class="dsp-atts">' + list.map(function (a) {
      var url = A.apiUrl('/api/admin/disputes/' + encodeURIComponent(disputeId) + '/files/' + encodeURIComponent(a.id));
      return '<a href="' + url + '" target="_blank" rel="noopener">' +
        '<img src="' + url + '" alt="' + A.esc(a.name) + '" loading="lazy">' +
        '</a>';
    }).join('') + '</div>';
  }

  function messageHtml(disputeId, m) {
    if (m.from === 'system') {
      return '<div class="dsp-msg system">' + A.esc(m.body) +
        ' <span class="dsp-when">' + A.esc(A.date(m.createdAt)) + '</span></div>';
    }
    return '<div class="dsp-msg ' + (m.from === 'admin' ? 'ours' : 'theirs') + '">' +
      '<div class="dsp-msg-head">' + A.esc(m.from === 'admin' ? 'Us' : (m.authorEmail || 'Customer')) +
        ' <span class="dsp-when">' + A.esc(A.date(m.createdAt)) + '</span></div>' +
      '<div class="dsp-msg-body">' + A.esc(m.body).replace(/\n/g, '<br>') + '</div>' +
      attachmentsHtml(disputeId, m.attachments) +
      '</div>';
  }

  function resolveBox(d, outcomes) {
    if (d.status === 'resolved') {
      var label = (outcomes.find(function (o) { return o.code === d.outcome; }) || {}).label || d.outcome;
      return '<div class="dsp-resolved">' +
        '<div><strong>Resolved:</strong> ' + A.esc(label) +
          (d.outcomeNote ? ' — ' + A.esc(d.outcomeNote) : '') + '</div>' +
        '<button type="button" class="btn btn-sm act-dsp-reopen" data-id="' + A.esc(d.id) + '">Reopen</button>' +
        '</div>';
    }
    return '<div class="dsp-resolve">' +
      '<select id="dspOutcome" aria-label="How did this end?">' +
        '<option value="">How did this end?</option>' +
        outcomes.map(function (o) { return '<option value="' + A.esc(o.code) + '">' + A.esc(o.label) + '</option>'; }).join('') +
      '</select>' +
      '<input type="text" id="dspNote" placeholder="Note for the record (optional)" maxlength="1000">' +
      '<button type="button" class="btn btn-sm act-dsp-resolve" data-id="' + A.esc(d.id) + '">Resolve</button>' +
      '</div>';
  }

  function threadPane(state) {
    var t = state.disputeThread;
    if (!state.disputeId) {
      return '<div class="dsp-pane empty">' + A.empty('No report open', 'Pick one from the queue on the left.') + '</div>';
    }
    if (!t) return '<div class="dsp-pane">' + A.skeleton(4) + '</div>';

    var d = t.dispute;
    var outcomes = state.disputeOutcomes || [];
    return '<div class="dsp-pane">' +
      orderCard(t.order) +
      resolveBox(d, outcomes) +
      '<div class="dsp-stream">' + d.messages.map(function (m) { return messageHtml(d.id, m); }).join('') + '</div>' +
      (d.status === 'resolved'
        ? '<p class="muted">This report is closed. Reopen it to reply.</p>'
        : '<div class="dsp-composer">' +
            '<textarea id="dspReply" rows="3" maxlength="4000" placeholder="Write a reply…"></textarea>' +
            '<button type="button" class="btn btn-primary btn-sm act-dsp-reply" data-id="' + A.esc(d.id) + '">Send</button>' +
          '</div>') +
      '</div>';
  }

  function render(state, body) {
    var list = state.disputes;
    if (!list) { body.innerHTML = A.skeleton(6); return; }
    if (!list.length) {
      body.innerHTML = A.empty('No reports yet',
        'When a customer reports a problem with an order, the thread lands here.');
      return;
    }
    var rows = filtered(list, state.disputeTab);
    body.innerHTML =
      '<div class="dsp-wrap">' +
        '<div class="dsp-queue">' +
          '<div class="seg dsp-tabs" role="group" aria-label="Filter reports">' +
            TABS.map(function (t) {
              var n = filtered(list, t.key).length;
              return '<button type="button" data-dsp-tab="' + t.key + '" aria-pressed="' +
                (state.disputeTab === t.key) + '">' + A.esc(t.label) + (n ? ' (' + n + ')' : '') + '</button>';
            }).join('') +
          '</div>' +
          (rows.length
            ? rows.map(function (d) { return queueRow(d, state.disputeId); }).join('')
            : '<p class="muted">Nothing in this tab.</p>') +
        '</div>' +
        threadPane(state) +
      '</div>';
  }

  window.ENLDisputes = { render: render };
})(window, document);
```

- [ ] **Step 4: Add `A.apiUrl` and `A.skeleton` if either is missing**

`js/admin-disputes.js` uses `A.apiUrl(path)` to build an absolute image URL, because an `<img src>` cannot carry an `Authorization` header the way `A.api` does. Check `js/admin-core.js` for an existing helper. If there is none, add one beside `api` and export it — and note that the image request must carry the admin credential in the query string, since the header is unavailable:

```js
  /* An absolute URL for something an <img> or a link will fetch — those can't
     send an Authorization header, so the admin key rides in the query. */
  function apiUrl(path) {
    var base = (window.PEPTIDE_API_BASE || '');
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    var k = getKey();
    return base + path + (k ? sep + 'key=' + encodeURIComponent(k) : '');
  }
```

`requireAdmin` already accepts `req.query.key` (`server/server.js:710`), so this works when the console is authenticated by key. **When the console is authenticated by an admin *account* rather than a key, `getKey()` is empty and the image will 401.** Handle that by fetching the image with `A.api` and rendering a blob URL instead. If `getKey()` is empty, replace `attachmentsHtml` with a placeholder button and load on click:

```js
  function attachmentsHtml(disputeId, list) {
    if (!list || !list.length) return '';
    return '<div class="dsp-atts">' + list.map(function (a) {
      return '<button type="button" class="dsp-att act-dsp-att" data-dsp="' + A.esc(disputeId) +
        '" data-file="' + A.esc(a.id) + '">' + A.icon('download') + A.esc(a.name) + '</button>';
    }).join('') + '</div>';
  }
```

and in `admin-console.js`'s delegated click handler, an `act-dsp-att` branch that fetches with the bearer token and opens the blob:

```js
      else if (t.classList.contains('act-dsp-att')) openDisputeAttachment(t.getAttribute('data-dsp'), t.getAttribute('data-file'));
```

```js
  /* An <img> can't send the bearer token, so the bytes are fetched with it
     and handed to the browser as a blob URL. */
  async function openDisputeAttachment(disputeId, fileId) {
    try {
      var url = (window.PEPTIDE_API_BASE || '') + '/api/admin/disputes/' +
        encodeURIComponent(disputeId) + '/files/' + encodeURIComponent(fileId);
      var headers = {};
      var tok = A.getToken && A.getToken();
      if (tok) headers.Authorization = 'Bearer ' + tok;
      var k = A.getKey();
      if (k) headers['x-admin-key'] = k;
      var res = await fetch(url, { headers: headers });
      if (!res.ok) throw new Error('That attachment could not be loaded.');
      var blob = await res.blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) { A.toast(e.message, 'error'); }
  }
```

Use this blob approach and **delete the `apiUrl` variant** — one path that always works beats two that each work half the time. Check `admin-core.js` for the token accessor's real name (it is beside `getKey`); if it is not exported, export it.

- [ ] **Step 5: Add the console handlers**

In `js/admin-console.js`, add the five functions the view calls back into, near the other action handlers:

```js
  /* ---- disputes ---- */
  function setDisputeTab(tab) { state.disputeTab = tab; render(); }

  async function openDispute(id) {
    state.disputeId = id;
    state.disputeThread = null;
    render();
    try {
      var data = await A.api('/api/admin/disputes/' + encodeURIComponent(id));
      state.disputeThread = data;
      state.disputeOutcomes = data.outcomes || state.disputeOutcomes;
      render();
      // Opening it IS reading it — mark it and drop the rail tally.
      await A.api('/api/admin/disputes/' + encodeURIComponent(id) + '/read', { method: 'POST' });
      await loadAll({ quiet: true });
      render();
    } catch (e) { A.toast(e.message, 'error'); }
  }

  async function replyToDispute(id, btn) {
    var box = document.getElementById('dspReply');
    var message = box ? box.value.trim() : '';
    if (!message) { A.toast('Write a reply first.', 'error'); return; }
    btn.disabled = true;
    try {
      var data = await A.api('/api/admin/disputes/' + encodeURIComponent(id) + '/messages',
        { method: 'POST', body: { message: message } });
      state.disputeThread = Object.assign({}, state.disputeThread, { dispute: data.dispute });
      A.toast('Sent. The customer has been emailed a link to it.', 'success');
      await loadAll({ quiet: true });
      render();
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
  }

  async function resolveDispute(id, btn) {
    var sel = document.getElementById('dspOutcome');
    var note = document.getElementById('dspNote');
    var outcome = sel ? sel.value : '';
    if (!outcome) { A.toast('Pick how this ended first.', 'error'); return; }
    if (!window.confirm('Close this report as “' + sel.options[sel.selectedIndex].text + '”?\n\n' +
        'The customer is emailed the outcome. Nothing is refunded or reshipped by this — do that separately.')) return;
    btn.disabled = true;
    try {
      var data = await A.api('/api/admin/disputes/' + encodeURIComponent(id) + '/resolve',
        { method: 'POST', body: { outcome: outcome, note: note ? note.value : '' } });
      state.disputeThread = Object.assign({}, state.disputeThread, { dispute: data.dispute });
      A.toast('Closed, and the customer has been told.', 'success');
      await loadAll({ quiet: true });
      render();
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
  }

  async function reopenDispute(id, btn) {
    btn.disabled = true;
    try {
      var data = await A.api('/api/admin/disputes/' + encodeURIComponent(id) + '/reopen', { method: 'POST' });
      state.disputeThread = Object.assign({}, state.disputeThread, { dispute: data.dispute });
      await loadAll({ quiet: true });
      render();
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
  }
```

Load the outcome list once, in `loadAll`, from the same `/api/admin/disputes` response:

```js
    if (results[8].status === 'fulfilled') state.disputeOutcomes = results[8].value.outcomes || [];
```

- [ ] **Step 6: Wire the clicks**

In the delegated click handler in `admin-console.js`, add before the closing brace of the `if (!t) return;` chain:

```js
      else if (t.hasAttribute('data-dsp-tab')) setDisputeTab(t.getAttribute('data-dsp-tab'));
      else if (t.hasAttribute('data-dsp-open')) openDispute(t.getAttribute('data-dsp-open'));
      else if (t.classList.contains('act-dsp-reply')) replyToDispute(t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-dsp-resolve')) resolveDispute(t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-dsp-reopen')) reopenDispute(t.getAttribute('data-id'), t);
```

The queue rows are `<button>` elements, so `e.target.closest('button')` already finds them.

- [ ] **Step 7: Load the script**

In `admin.html`, add before the `admin-console.js` tag (it must be defined before the console renders):

```html
  <!-- The dispute queue and thread view: its own file because a message
       stream with a composer is a screen, not a section. -->
  <script src="js/admin-disputes.js?v=66"></script>
```

- [ ] **Step 8: Style it**

Append to `css/styles.css`, following the `adm-` conventions already there (dark ground `#07040f`, violet `#7c3aed` actions, gold `#d4af37` brand):

```css
/* ===== ADMIN — DISPUTE THREADS ===== */
.dsp-wrap { display: grid; grid-template-columns: minmax(240px, 320px) 1fr; gap: 1rem; align-items: start; }
.dsp-tabs { margin-bottom: .75rem; }
.dsp-queue { display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
.dsp-row { text-align: left; width: 100%; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08);
  border-radius: 10px; padding: .6rem .7rem; color: inherit; cursor: pointer; display: grid; gap: .2rem; }
.dsp-row:hover { border-color: rgba(124,58,237,.5); }
.dsp-row.active { border-color: #7c3aed; background: rgba(124,58,237,.12); }
.dsp-row.unread { border-left: 3px solid #d4af37; }
.dsp-row-top { display: flex; justify-content: space-between; gap: .5rem; }
.dsp-row-who, .dsp-row-why { font-size: .82rem; opacity: .75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsp-when { font-size: .75rem; opacity: .6; }
.dsp-chip { display: inline-block; font-size: .7rem; padding: .1rem .45rem; border-radius: 999px;
  background: rgba(255,255,255,.08); justify-self: start; }
.dsp-chip.dsp-awaiting_us { background: rgba(212,175,55,.18); color: #f0d98a; }
.dsp-chip.dsp-awaiting_customer { background: rgba(124,58,237,.2); color: #cdb4fe; }
.dsp-chip.dsp-resolved { background: rgba(34,197,94,.15); color: #86efac; }

.dsp-pane { min-width: 0; display: flex; flex-direction: column; gap: .85rem; }
.dsp-order { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: .75rem; }
.dsp-order-head { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-bottom: .4rem; }
.dsp-order-items { margin: 0; padding-left: 1.1rem; font-size: .88rem; }
.dsp-resolve, .dsp-resolved { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.dsp-resolve input { flex: 1 1 12rem; min-width: 0; }

.dsp-stream { display: flex; flex-direction: column; gap: .6rem; max-height: 60vh; overflow-y: auto; padding-right: .25rem; }
.dsp-msg { max-width: 42rem; border-radius: 12px; padding: .6rem .75rem; border: 1px solid rgba(255,255,255,.08); }
.dsp-msg.theirs { background: rgba(255,255,255,.04); align-self: flex-start; }
.dsp-msg.ours { background: rgba(124,58,237,.15); border-color: rgba(124,58,237,.35); align-self: flex-end; }
.dsp-msg.system { align-self: center; font-size: .8rem; opacity: .7; border: 0; background: none; }
.dsp-msg-head { font-size: .78rem; opacity: .7; margin-bottom: .25rem; }
.dsp-msg-body { white-space: normal; overflow-wrap: anywhere; }
.dsp-atts { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .5rem; }
.dsp-att { display: inline-flex; align-items: center; gap: .3rem; font-size: .8rem; padding: .25rem .5rem;
  border-radius: 8px; border: 1px solid rgba(255,255,255,.15); background: none; color: inherit; cursor: pointer; }
.dsp-att svg { width: 14px; height: 14px; }
.dsp-composer { display: flex; gap: .5rem; align-items: flex-end; }
.dsp-composer textarea { flex: 1; min-width: 0; resize: vertical; }

/* Phones: the queue stacks above the thread. Per the mobile pass, nothing
   here may be wider than its column. */
@media (max-width: 860px) {
  .dsp-wrap { grid-template-columns: 1fr; }
  .dsp-stream { max-height: none; }
  .dsp-msg { max-width: 100%; }
}
```

- [ ] **Step 9: Verify the wiring mechanically**

The console is not unit-tested in this project, so check the seams that a typo silently breaks. Save as `<scratchpad>/check-admin-disputes.js` and run with `node`:

```js
const fs = require('fs');
const read = p => fs.readFileSync(p, 'utf8');
const core = read('js/admin-core.js');
const console_ = read('js/admin-console.js');
const view = read('js/admin-disputes.js');
const html = read('admin.html');
const css = read('css/styles.css');

const checks = [
  ['nav entry exists', /key:\s*'disputes'/.test(core)],
  ['chat icon exists', /chat:\s*'</.test(core)],
  ['tally id matches nav', core.includes("tally: 'navDisputes'") && console_.includes("getElementById('navDisputes')")],
  ['TITLES entry', /disputes:\s*\['Disputes'/.test(console_)],
  ['queue is loaded', console_.includes("/api/admin/disputes")],
  ['view is dispatched', console_.includes('window.ENLDisputes.render')],
  ['view is defined', view.includes('window.ENLDisputes')],
  ['script tag present', html.includes('js/admin-disputes.js')],
  ['script loads before the console', html.indexOf('admin-disputes.js') < html.indexOf('admin-console.js')],
  ['every action class has a handler', ['act-dsp-reply', 'act-dsp-resolve', 'act-dsp-reopen', 'act-dsp-att']
    .every(c => view.includes(c) && console_.includes(c))],
  ['every data hook has a handler', ['data-dsp-tab', 'data-dsp-open']
    .every(c => view.includes(c) && console_.includes(c))],
  ['styles exist for every class used', ['dsp-wrap', 'dsp-queue', 'dsp-row', 'dsp-pane', 'dsp-stream', 'dsp-msg', 'dsp-composer', 'dsp-atts']
    .every(c => css.includes('.' + c))],
  ['no emoji in the view', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(view)]
];

let bad = 0;
for (const [name, ok] of checks) { if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name); }
process.exit(bad ? 1 : 0);
```

Run: `node <scratchpad>/check-admin-disputes.js`
Expected: 13 PASS, exit 0.

- [ ] **Step 10: Verify it in the browser**

Run: `cd server && npm start`, open `http://localhost:4242/admin.html#disputes`, sign in with the admin account.

Check, in order: the rail shows **Disputes**; with no threads the empty state reads "No reports yet"; after opening one from the customer side (Task 7) the tally shows `1`; opening the thread clears the tally; a reply appears in the stream immediately and flips the chip to "Waiting on them"; an attachment button opens the image in a new tab; Resolve refuses without an outcome, then closes the thread and swaps the composer for the resolved line; Reopen brings the composer back with a system line in the stream. Narrow the window under 860px and confirm nothing scrolls sideways.

- [ ] **Step 11: Commit**

```bash
git add js/admin-core.js js/admin-console.js js/admin-disputes.js admin.html css/styles.css
git commit -m "feat(disputes): admin queue and thread view with an unread tally"
```

---

### Task 7: Customer side — support.html, the composer, and the order-row button

**Files:**
- Create: `support.html`
- Create: `js/support.js`
- Modify: `js/auth.js` (`renderAccountOrders`, around line 240)
- Modify: `css/styles.css` (append)

**Interfaces:**
- Consumes: Task 3's customer routes; `Auth` (`window.Auth` in `js/auth.js`) for the token and the API base.
- Produces: nothing further consumes this.

- [ ] **Step 1: Create the page**

Create `support.html` by copying `account.html` and replacing only the `<main>` contents. Copy, verbatim from `account.html`: the whole `<head>` (changing the title, description, canonical and OG/Twitter tags to this page), the skip link, the `<header>` block, the search overlay, and the whole `<footer>` with the scripts at the bottom. `noindex, nofollow` stays — this page is per-customer.

The `<main>` body:

```html
  <main id="main">
    <section class="section">
      <div class="container narrow">
        <h1>Report a problem</h1>
        <p class="text-muted" id="supIntro">Loading…</p>

        <div id="supGate" hidden>
          <p>Sign in to open or read a report about an order.</p>
          <p><a class="btn btn-primary" href="login.html?next=support.html">Sign in</a></p>
        </div>

        <!-- The order this is about, so nobody has to open another tab. -->
        <div class="glass card" id="supOrder" hidden></div>

        <!-- Path A: no thread on this order yet -->
        <form class="form-card glass" id="supOpenForm" hidden>
          <div class="form-field full">
            <label for="supReason">What went wrong?</label>
            <select id="supReason" required></select>
          </div>
          <div class="form-field full">
            <label for="supMessage">Tell us what happened</label>
            <textarea id="supMessage" rows="5" maxlength="4000" required
              placeholder="What arrived, what you expected, and anything on the parcel or paperwork that looks wrong."></textarea>
          </div>
          <div class="form-field full">
            <label for="supFiles">Photos (optional — up to 3, PNG/JPEG/WebP, 2 MB each)</label>
            <input type="file" id="supFiles" accept="image/png,image/jpeg,image/webp" multiple>
            <div class="sup-previews" id="supPreviews"></div>
          </div>
          <div class="form-msg" id="supOpenMsg" role="status"></div>
          <button class="btn btn-primary" type="submit">Send the report</button>
        </form>

        <!-- Path B: a thread already exists -->
        <div id="supThread" hidden>
          <div class="sup-stream" id="supStream"></div>
          <div class="sup-closed" id="supClosed" hidden></div>
          <form class="form-card glass" id="supReplyForm">
            <div class="form-field full">
              <label for="supReply">Reply</label>
              <textarea id="supReply" rows="3" maxlength="4000" required placeholder="Write a reply…"></textarea>
            </div>
            <div class="form-field full">
              <label for="supReplyFiles">Photos (optional — up to 3)</label>
              <input type="file" id="supReplyFiles" accept="image/png,image/jpeg,image/webp" multiple>
              <div class="sup-previews" id="supReplyPreviews"></div>
            </div>
            <div class="form-msg" id="supReplyMsg" role="status"></div>
            <button class="btn btn-primary" type="submit">Send</button>
          </form>
        </div>

        <p class="text-muted"><a href="account.html">← Back to your orders</a></p>
      </div>
    </section>
  </main>
```

Add the page script beside the others at the bottom, after `js/auth.js`:

```html
  <script src="js/support.js?v=1"></script>
```

- [ ] **Step 2: Write the page script**

Create `js/support.js`:

```js
/* ============================================================
   EVER NOVA LIFE — support.html
   One order, one thread. The page has two shapes: the form that
   opens a report, and the conversation once one exists.

   Reached as support.html?order=ENL-… from the order row on the
   account page and from the notification email, so the order
   reference — never a dispute id — is what the URL carries. The
   customer knows their order reference; they have no reason to
   know a DSP- id.
   ============================================================ */
(function (window, document) {
  'use strict';

  var API = (window.PEPTIDE_API_BASE || '');
  var POLL_MS = 20000;

  var state = { orderId: '', dispute: null, order: null, reasons: [], pending: [], pendingReply: [], timer: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function token() { return window.Auth && window.Auth.token && window.Auth.token(); }

  async function api(path, opts) {
    opts = opts || {};
    var headers = {};
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    var res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) {
      var err = new Error((data && data.error) || 'Something went wrong. Try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---- attachments: read to base64 in the browser, capped before we ask
     the server to refuse them ---- */
  var MAX_FILES = 3;
  var MAX_BYTES = 2 * 1024 * 1024;

  function readFiles(input, bucket, previewEl, msgEl) {
    var files = Array.prototype.slice.call(input.files || []);
    bucket.length = 0;
    previewEl.innerHTML = '';
    msgEl.textContent = '';
    if (files.length > MAX_FILES) {
      msgEl.textContent = 'Attach at most ' + MAX_FILES + ' photos.';
      input.value = '';
      return;
    }
    files.forEach(function (f) {
      if (f.size > MAX_BYTES) { msgEl.textContent = 'Each photo has to be under 2 MB — ' + f.name + ' is bigger.'; return; }
      var reader = new FileReader();
      reader.onload = function () {
        var data = String(reader.result || '');
        bucket.push({ name: f.name, data: data });
        var img = document.createElement('img');
        img.src = data;
        img.alt = f.name;
        previewEl.appendChild(img);
      };
      reader.readAsDataURL(f);
    });
  }

  /* ---- rendering ---- */
  function orderCard(o) {
    if (!o) return '';
    var items = (o.items || []).map(function (i) {
      var paid = (i.paidQuantity == null) ? i.quantity : i.paidQuantity;
      var qty = (paid !== i.quantity) ? (i.quantity + ' sent · ' + paid + ' billed') : ('×' + i.quantity);
      return '<li>' + esc(i.name) + ' <span class="text-muted">' + esc(qty) + '</span></li>';
    }).join('');
    var track = [o.carrier, o.tracking].filter(Boolean).join(' · ');
    return '<h2>Order ' + esc(o.orderId) + '</h2>' +
      '<ul>' + items + '</ul>' +
      '<p class="text-muted">' + esc(o.status || '') +
        (track ? ' · Tracking: ' + esc(track) : '') + '</p>';
  }

  function messageHtml(d, m) {
    if (m.from === 'system') {
      return '<div class="sup-msg system">' + esc(m.body) + '</div>';
    }
    var atts = (m.attachments || []).map(function (a) {
      return '<button type="button" class="sup-att" data-file="' + esc(a.id) + '">' + esc(a.name) + '</button>';
    }).join('');
    return '<div class="sup-msg ' + (m.from === 'admin' ? 'theirs' : 'mine') + '">' +
      '<div class="sup-msg-head">' + (m.from === 'admin' ? 'Ever Nova Life' : 'You') +
        ' · ' + esc(new Date(m.createdAt).toLocaleString()) + '</div>' +
      '<div class="sup-msg-body">' + esc(m.body).replace(/\n/g, '<br>') + '</div>' +
      (atts ? '<div class="sup-atts">' + atts + '</div>' : '') +
      '</div>';
  }

  function renderThread() {
    var d = state.dispute;
    $('supOpenForm').hidden = true;
    $('supThread').hidden = false;
    $('supStream').innerHTML = d.messages.map(function (m) { return messageHtml(d, m); }).join('');
    $('supStream').scrollTop = $('supStream').scrollHeight;

    var closed = d.status === 'resolved';
    $('supReplyForm').hidden = closed;
    $('supClosed').hidden = !closed;
    if (closed) {
      $('supClosed').innerHTML = '<p><strong>This report is closed.</strong> ' +
        (d.outcomeNote ? esc(d.outcomeNote) + ' ' : '') +
        'If it still isn\'t settled, <a href="account.html">open a new report</a> from the order.</p>';
    }
    $('supIntro').textContent = closed
      ? 'This report is resolved.'
      : (d.status === 'awaiting_us' ? 'We have your report and will reply here.' : 'We have replied — your turn.');
  }

  function renderOpenForm() {
    $('supThread').hidden = true;
    $('supOpenForm').hidden = false;
    $('supReason').innerHTML = '<option value="">Choose one…</option>' +
      state.reasons.map(function (r) { return '<option value="' + esc(r.code) + '">' + esc(r.label) + '</option>'; }).join('');
    $('supIntro').textContent = 'Tell us what went wrong and we will answer here.';
  }

  /* ---- loading ---- */
  async function load(quiet) {
    try {
      var mine = await api('/api/disputes');
      state.reasons = mine.reasons || [];
      var existing = (mine.disputes || []).find(function (d) { return d.orderId === state.orderId; });
      // The newest thread on this order wins: a resolved one and a later open
      // one can both exist, and the open one is the live conversation.
      if (existing) {
        var full = await api('/api/disputes/' + encodeURIComponent(existing.id));
        state.dispute = full.dispute;
        state.order = full.order;
        $('supOrder').hidden = false;
        $('supOrder').innerHTML = orderCard(state.order);
        renderThread();
        if (!quiet) api('/api/disputes/' + encodeURIComponent(existing.id) + '/read', { method: 'POST' }).catch(function () { });
      } else {
        state.dispute = null;
        renderOpenForm();
      }
    } catch (e) {
      if (e.status === 401) { $('supGate').hidden = false; $('supIntro').textContent = ''; return; }
      $('supIntro').textContent = e.message;
    }
  }

  /* A background tab polling forever is a battery and a bandwidth cost for
     nothing, so the timer only runs while the page is actually visible. */
  function startPolling() {
    stopPolling();
    if (document.hidden || !state.dispute) return;
    state.timer = window.setInterval(function () { load(true); }, POLL_MS);
  }
  function stopPolling() { if (state.timer) { window.clearInterval(state.timer); state.timer = null; } }

  /* ---- actions ---- */
  async function submitOpen(e) {
    e.preventDefault();
    var msg = $('supOpenMsg');
    var btn = e.target.querySelector('button[type=submit]');
    msg.textContent = '';
    btn.disabled = true;
    try {
      var data = await api('/api/disputes', {
        method: 'POST',
        body: {
          orderId: state.orderId,
          reason: $('supReason').value,
          message: $('supMessage').value,
          attachments: state.pending.slice()
        }
      });
      state.dispute = data.dispute;
      state.order = data.order || state.order;
      $('supOrder').hidden = false;
      $('supOrder').innerHTML = orderCard(state.order);
      state.pending.length = 0;
      $('supPreviews').innerHTML = '';
      renderThread();
      startPolling();
    } catch (e2) {
      msg.textContent = e2.message;
      btn.disabled = false;
    }
  }

  async function submitReply(e) {
    e.preventDefault();
    var msg = $('supReplyMsg');
    var btn = e.target.querySelector('button[type=submit]');
    msg.textContent = '';
    btn.disabled = true;
    try {
      var data = await api('/api/disputes/' + encodeURIComponent(state.dispute.id) + '/messages', {
        method: 'POST',
        body: { message: $('supReply').value, attachments: state.pendingReply.slice() }
      });
      state.dispute = data.dispute;
      $('supReply').value = '';
      state.pendingReply.length = 0;
      $('supReplyPreviews').innerHTML = '';
      renderThread();
    } catch (e2) {
      msg.textContent = e2.message;
    }
    btn.disabled = false;
  }

  /* An <img> can't send the bearer token, so an attachment is fetched with
     it and handed to the browser as a blob. */
  async function openAttachment(fileId) {
    try {
      var headers = {};
      var t = token();
      if (t) headers.Authorization = 'Bearer ' + t;
      var res = await fetch(API + '/api/disputes/' + encodeURIComponent(state.dispute.id) +
        '/files/' + encodeURIComponent(fileId), { headers: headers });
      if (!res.ok) throw new Error('That photo could not be loaded.');
      window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
    } catch (e) { $('supReplyMsg').textContent = e.message; }
  }

  /* ---- boot ---- */
  function init() {
    var params = new URLSearchParams(window.location.search);
    state.orderId = (params.get('order') || '').trim();
    if (!state.orderId) {
      $('supIntro').innerHTML = 'Open a report from one of <a href="account.html">your orders</a>.';
      return;
    }
    if (!token()) { $('supGate').hidden = false; $('supIntro').textContent = ''; return; }

    $('supOpenForm').addEventListener('submit', submitOpen);
    $('supReplyForm').addEventListener('submit', submitReply);
    $('supFiles').addEventListener('change', function () {
      readFiles(this, state.pending, $('supPreviews'), $('supOpenMsg'));
    });
    $('supReplyFiles').addEventListener('change', function () {
      readFiles(this, state.pendingReply, $('supReplyPreviews'), $('supReplyMsg'));
    });
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.sup-att');
      if (b) openAttachment(b.getAttribute('data-file'));
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPolling(); else { load(true); startPolling(); }
    });

    load().then(startPolling);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window, document);
```

- [ ] **Step 3: Check the `Auth` token accessor's real name**

`js/support.js` calls `window.Auth.token()`. Open `js/auth.js` and confirm what the exported object actually calls it — the file has a `token` concept already (it sends `Authorization: 'Bearer ' + token` around line 100). If the accessor has a different name or the token is read from storage directly, match that instead. Do **not** re-implement token storage in `support.js`; use whatever `auth.js` exposes.

- [ ] **Step 4: Add the order-row button**

In `js/auth.js`, inside `renderAccountOrders`, the row template gains a link. `orders` from `/api/orders` does not say whether a thread exists, so fetch the customer's threads once before the map and mark the orders that have one:

```js
    // Which orders already have a report open — one request for the whole
    // list, so the rows can say "view" instead of "report" where it matters.
    let threads = [];
    try { threads = (await Auth.disputes()) || []; } catch (e) { /* the rows still render */ }
    const threadFor = (id) => threads.find(t => t.orderId === id) || null;
```

and in the returned template, after the `owe` line:

```js
      /* A problem with an order is reported from the order — it is the only
         place the customer has the reference in front of them. Cancelled
         orders have nothing to report against. */
      const t = threadFor(o.orderId);
      const report = o.status === 'cancelled' ? '' :
        `<div><a class="btn btn-sm ${t ? 'btn-ghost' : 'btn-ghost'}" href="support.html?order=${encodeURIComponent(o.orderId)}">${
          t ? (t.status === 'resolved' ? 'See the closed report' : 'View your report') : 'Report a problem'
        }</a></div>`;
```

and add `${report}` to the row markup, after `${owe}`.

Add the fetch helper beside `Auth.orders()` (around line 96):

```js
    /* This account's dispute threads, as summaries. Empty array if signed
       out or the API is unreachable — the account page still renders. */
    async disputes() {
      const token = getToken();
      if (!token) return [];
      try {
        const res = await fetch(API_BASE + '/api/disputes', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data.disputes) ? data.disputes : [];
      } catch (e) { return []; }
    },
```

Match the surrounding style exactly — if `orders()` reads the token through a differently-named helper, use that one.

- [ ] **Step 5: Style the customer thread**

Append to `css/styles.css`:

```css
/* ===== SUPPORT — CUSTOMER DISPUTE THREAD ===== */
.sup-stream { display: flex; flex-direction: column; gap: .6rem; margin: 1rem 0; max-height: 60vh; overflow-y: auto; }
.sup-msg { max-width: 90%; border-radius: 12px; padding: .65rem .8rem; border: 1px solid rgba(255,255,255,.08); }
.sup-msg.mine { background: rgba(124,58,237,.15); border-color: rgba(124,58,237,.35); align-self: flex-end; }
.sup-msg.theirs { background: rgba(255,255,255,.04); align-self: flex-start; }
.sup-msg.system { align-self: center; font-size: .82rem; opacity: .7; border: 0; background: none; }
.sup-msg-head { font-size: .78rem; opacity: .7; margin-bottom: .25rem; }
.sup-msg-body { overflow-wrap: anywhere; }
.sup-atts { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .5rem; }
.sup-att { font-size: .8rem; padding: .25rem .5rem; border-radius: 8px; border: 1px solid rgba(255,255,255,.15);
  background: none; color: inherit; cursor: pointer; }
.sup-previews { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .5rem; }
.sup-previews img { width: 76px; height: 76px; object-fit: cover; border-radius: 8px; border: 1px solid rgba(255,255,255,.15); }
.sup-closed { border: 1px solid rgba(212,175,55,.35); background: rgba(212,175,55,.08); border-radius: 10px; padding: .75rem 1rem; }
@media (max-width: 600px) { .sup-msg { max-width: 100%; } }
```

- [ ] **Step 6: Verify mechanically**

Save as `<scratchpad>/check-support.js` and run with `node`:

```js
const fs = require('fs');
const read = p => fs.readFileSync(p, 'utf8');
const html = read('support.html');
const js = read('js/support.js');
const authjs = read('js/auth.js');
const css = read('css/styles.css');

// Every id the script reaches for must exist in the page, and vice versa.
const idsUsed = [...js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map(m => m[1]);
const missing = [...new Set(idsUsed)].filter(id => !html.includes('id="' + id + '"'));

const checks = [
  ['every id the script uses exists in the page', missing.length === 0, missing.join(', ')],
  ['skip link present', html.includes('class="skip-link"')],
  ['main landmark present', html.includes('<main id="main">')],
  ['noindex (per-customer page)', html.includes('noindex')],
  ['script is loaded', html.includes('js/support.js')],
  ['auth.js loads before support.js', html.indexOf('js/auth.js') < html.indexOf('js/support.js')],
  ['account rows link here', authjs.includes('support.html?order=')],
  ['Auth.disputes exists', /disputes\s*\(\)\s*\{/.test(authjs) || authjs.includes('async disputes(')],
  ['styles exist', ['sup-stream', 'sup-msg', 'sup-att', 'sup-previews', 'sup-closed'].every(c => css.includes('.' + c))],
  ['no emoji in the script', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(js)],
  ['polling stops when hidden', js.includes('visibilitychange') && js.includes('stopPolling')]
];

let bad = 0;
for (const [name, ok, extra] of checks) { if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || !extra ? '' : ' → ' + extra)); }
process.exit(bad ? 1 : 0);
```

Run: `node <scratchpad>/check-support.js`
Expected: 11 PASS, exit 0.

- [ ] **Step 7: Verify in the browser, end to end**

With `cd server && npm start` running, at `http://localhost:4242`:

1. Register an account, place an order (or add one with `store.addOrder` from a node REPL against the same `DATA_DIR`).
2. Open `account.html` — the order row shows **Report a problem**.
3. Click it. `support.html?order=ENL-…` shows the order card and the open form.
4. Submit without a reason — the browser's own validation blocks it.
5. Attach four photos — the page refuses before sending.
6. Attach one photo and submit — the thread renders with the image button.
7. In another browser profile, open the admin console, reply. Within 20 seconds the customer tab shows the reply without a refresh.
8. Resolve from the admin. The customer tab swaps the composer for the closed panel.
9. Sign out and open the same URL — the sign-in gate shows, not an error.
10. At 375px wide, nothing scrolls sideways.

- [ ] **Step 8: Commit**

```bash
git add support.html js/support.js js/auth.js css/styles.css
git commit -m "feat(disputes): support.html thread page and the order-row entry point"
```

---

### Task 8: Cache-busters, docs and the release sweep

**Files:**
- Modify: every `*.html` at the repo root (cache-buster query strings)
- Modify: `docs/content-needed.md` (if the dispute copy raises a business fact)
- Modify: `server/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Bump every cache-buster**

Current values: `css/styles.css?v=70`, `js/main.js?v=69`, `js/admin-console.js?v=66`, `js/auth.js?v=62`, and the rest. Bump **every** `?v=` on **every** root HTML file to a single new number, `71`, so one number describes the release. `js/support.js?v=1` becomes `?v=71` too.

Use Python — **not** PowerShell, which double-encodes the non-ASCII characters in these no-BOM UTF-8 files:

```python
import re, pathlib
for p in pathlib.Path('.').glob('*.html'):
    s = p.read_text(encoding='utf-8')
    n = re.sub(r'\?v=\d+', '?v=71', s)
    if n != s:
        p.write_text(n, encoding='utf-8', newline='')
        print('bumped', p.name)
```

Run: `python <scratchpad>/bump.py`
Expected: every root HTML file listed, including the new `support.html`.

- [ ] **Step 2: Confirm no file was mangled**

Run: `git diff --stat` and then `git diff -- index.html | head -40`.
Expected: only `?v=` numbers changed. If any line shows characters like `â€"`, the file was written with the wrong encoding — `git checkout` it and redo Step 1 with Python.

- [ ] **Step 3: Document the routes**

Append to `server/README.md`, in the endpoint list, matching the existing formatting:

```
Disputes (customer, requires a signed-in account)
  GET    /api/disputes                        this account's threads, as summaries
  POST   /api/disputes                        open one { orderId, reason, message, attachments[] }
  GET    /api/disputes/:id                    the full thread + the order it is about
  POST   /api/disputes/:id/messages           reply { message, attachments[] }
  POST   /api/disputes/:id/read               mark read
  GET    /api/disputes/:id/files/:fileId      an attached image

Disputes (admin)
  GET    /api/admin/disputes                  the queue, with the customer and order attached
  GET    /api/admin/disputes/:id              one thread
  POST   /api/admin/disputes/:id/messages     reply (emails the customer)
  POST   /api/admin/disputes/:id/resolve      close it { outcome, note } (emails the customer)
  POST   /api/admin/disputes/:id/reopen       reopen a closed one
  POST   /api/admin/disputes/:id/read         mark read
  GET    /api/admin/disputes/:id/files/:fileId

State: DATA_DIR/disputes.json and DATA_DIR/dispute-files/. Resolving records an
outcome — it never refunds or reships. Neither is seeded; neither is in git.
```

- [ ] **Step 4: Run everything one more time**

Run: `cd server && npm test`
Expected: the full suite passes, including the three new files.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(disputes): cache-busters to v=71 and route docs"
```

- [ ] **Step 6: Deploy in the right order**

Per `cloudflare-asset-cache`: upload the changed **assets** to GoDaddy first (`css/styles.css`, `js/support.js`, `js/admin-disputes.js`, `js/admin-console.js`, `js/admin-core.js`, `js/auth.js`), **then** the HTML that names them (`support.html`, `admin.html`, and every page whose `?v=` moved). Deploy the server to Render.

Verify on the live site: `https://evernovalife.com/support.html?order=…` loads the sign-in gate when signed out, and `curl -sI 'https://evernovalife.com/js/support.js?bust=1' | grep -i cf-cache-status` returns a MISS on a query string never used before.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Data model, derived status, derived unread, caps | 1 |
| Attachments on disk, magic bytes, path safety, cascade | 2 |
| Customer routes, rate limits, `deleteUserData` wiring | 3 |
| Admin routes | 4 |
| Email (no message body) | 5 |
| Admin UI — nav, tally, view, new file | 6 |
| Customer UI — support.html, order-row entry, polling | 7 |
| Cache-busters, docs, deploy order | 8 |
| Testing list (every bullet) | 1, 2, 3, 4, 5 |

Spec bullets mapped to a specific test: ownership isolation (T3), duplicate-open 409 (T1 + T3), resolved reply refused (T1 + T4), caps (T1 + T2), magic-byte rejection (T2), `../` filename (T2), unread math (T1), delete-user cascade removing files (T2 + T3).

**Type consistency:** `disputes.summarize` produces `unreadForAdmin`, consumed by the admin tally in Task 6 and asserted in Task 4's test. `status` values `awaiting_us` / `awaiting_customer` / `resolved` are used identically in the store, the admin tabs (`state.disputeTab`), and `support.js`. `attachments` is `[{ name, data }]` inbound and `[{ id, name, mime, bytes }]` stored, everywhere. `fileMeta` returns `{ path, mime, name }` in Task 2 and is read as `meta.mime` in Tasks 3 and 4.

**Two known verify-as-you-go points**, called out inside the tasks rather than hidden here: the `results[8]` index in `loadAll` (Task 6 Step 2) and the real name of the token accessor in `js/auth.js` (Task 7 Step 3). Both are checked against the file before use.
