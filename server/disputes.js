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
const crypto = require('crypto');

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
// The timestamp alone repeats inside the same millisecond under load, and
// this id is the key the whole store is filed under — a repeat here would
// silently overwrite another customer's thread, not just look odd. A few
// random hex bytes make that vanishingly unlikely; create() below closes
// the gap the rest of the way by regenerating on an actual collision.
function newDisputeId() {
  return 'DSP-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
}
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

  const openOnOrder = findOpenForOrder(orderId);
  if (openOnOrder) {
    throw Object.assign(err('There is already an open report on that order.', 409),
      { disputeId: openOnOrder.id });
  }
  const openMine = listForUser(userId).filter(d => !d.resolvedAt).length;
  if (openMine >= MAX_OPEN_PER_USER) {
    throw err(`You already have ${MAX_OPEN_PER_USER} open reports. We'll answer those first — reply on one of them instead.`);
  }

  const all = load();
  // Belt and braces: newDisputeId() is already collision-resistant, but the
  // map is keyed by this id, so regenerate rather than merely trust it.
  let id = newDisputeId();
  while (all[id]) id = newDisputeId();

  const now = new Date().toISOString();
  const d = {
    id,
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
      attachments: [],
      createdAt: now
    }]
  };
  // Attachments are Task 2; this call is real (attachStore.attach() below
  // is a stub returning []), kept as its own statement so a throw here —
  // once it does something — happens before anything is saved.
  d.messages[0].attachments = attachStore.attach(d.id, attachments);

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
