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
/* The `\s+ → ' '` collapse is LOAD-BEARING, not cosmetic. `subject` and
   `name` arrive from the chat agent — free text a visitor talked an LLM
   into relaying — and end up in emails the shop sends. Collapsing runs of
   whitespace is what destroys a CR or LF before it can reach a mail header,
   so a "preserve the line breaks the visitor typed" change here would
   reopen header injection. Anything that needs multi-line text must go
   through cleanBody(), which never reaches a header. */
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
