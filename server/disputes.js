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

/* What the customer is allowed to see. Admin messages are the store speaking,
   not a named person: the owner's own address has no business travelling to a
   customer, and neither UI ever renders it. Applied at the source — on every
   customer-facing response that carries a thread — rather than at the display
   layer, so a field nobody renders today can't leak through a page written
   tomorrow. `system` lines stamp the acting admin too, so they are redacted
   on the same rule: anything that is not the customer's own message. */
function forCustomer(d) {
  if (!d) return d;
  return Object.assign({}, d, {
    resolvedBy: '',
    messages: (d.messages || []).map(function (m) {
      return m.from === 'customer' ? m : Object.assign({}, m, { authorEmail: '' });
    })
  });
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

/* A ceiling on every attachment this feature is holding, across all accounts.
   The per-account caps alone allow 5 threads × 200 messages × 3 images × 2 MB
   — 6 GB from one customer — and nothing reclaims the bytes, so an image flood
   here does not fail politely: it fills the Render disk that orders.json,
   users.json, loyalty.json and subscriptions.json all write through, and the
   whole store starts failing writes. This bounds the blast radius to "photos
   are refused" instead. DISPUTE_TOTAL_BYTES_MAX overrides the default on a
   bigger disk; it is read per call so it can be raised without a redeploy of
   this file's constants. */
const TOTAL_BYTES_DEFAULT = 2 * 1024 * 1024 * 1024;   // 2 GB
function totalBytesMax() {
  const n = Number(process.env.DISPUTE_TOTAL_BYTES_MAX);
  return (Number.isFinite(n) && n > 0) ? n : TOTAL_BYTES_DEFAULT;
}

/* Sum of every stored attachment. The metadata already carries `bytes`, so
   this is one parse of disputes.json — no directory walk, no stat() per file. */
function totalAttachmentBytes() {
  const all = load();
  let total = 0;
  for (const id of Object.keys(all)) {
    const d = all[id];
    for (const m of (d && d.messages) || []) {
      for (const a of (m.attachments || [])) {
        // The file is gone; only the record remains. Counting it would keep
        // the ceiling shut against space that has already been reclaimed.
        if (a.expiredAt) continue;
        total += Number(a.bytes) || 0;
      }
    }
  }
  return total;
}

/* How long a resolved report keeps its photos. Read per call, like the
   ceiling, so it can be changed on Render without a redeploy. The clock is
   keyed to `resolvedAt` and not to message age, so an active conversation
   never loses evidence in the middle of itself. */
const RETENTION_DAYS_DEFAULT = 90;
function retentionDays() {
  const n = Number(process.env.DISPUTE_PHOTO_RETENTION_DAYS);
  return (Number.isFinite(n) && n > 0) ? n : RETENTION_DAYS_DEFAULT;
}

/* Every attachment on one thread that still has bytes behind it. */
function liveAttachments(d) {
  const live = [];
  for (const m of (d && d.messages) || []) {
    for (const a of (m.attachments || [])) if (!a.expiredAt) live.push(a);
  }
  return live;
}

function stampExpired(d, stamp) {
  for (const m of d.messages) {
    for (const a of (m.attachments || [])) if (!a.expiredAt) a.expiredAt = stamp;
  }
}

/* Drop one thread's photos now, whatever its age or status. The admin's
   "Remove photos" control — for the report that is eating the disk today. */
function stripAttachments(disputeId, now) {
  const all = load();
  const d = all[disputeId];
  if (!d) return null;

  const live = liveAttachments(d);
  if (!live.length) return { files: 0, bytes: 0 };
  if (!attachStore.removeAll(disputeId)) return { files: 0, bytes: 0 };

  stampExpired(d, new Date(now || Date.now()).toISOString());
  save(all);
  return { files: live.length, bytes: live.reduce((n, a) => n + (Number(a.bytes) || 0), 0) };
}

/* The scheduled pass: every thread resolved longer ago than the window loses
   its photos. A thread that has been reopened has no `resolvedAt`, so it is
   safe again — and resolving it a second time restarts the clock. One
   unreadable directory logs and the run continues; stopping would leave every
   later thread unreclaimed because of one bad one. */
function sweepExpiredAttachments(now) {
  const at = now || Date.now();
  const cutoff = at - retentionDays() * 24 * 60 * 60 * 1000;
  const stamp = new Date(at).toISOString();
  const all = load();
  let threads = 0, files = 0, bytes = 0, dirty = false;

  for (const id of Object.keys(all)) {
    const d = all[id];
    if (!d || !d.resolvedAt) continue;
    const resolvedMs = new Date(d.resolvedAt).getTime();
    if (!Number.isFinite(resolvedMs) || resolvedMs > cutoff) continue;

    const live = liveAttachments(d);
    if (!live.length) continue;
    if (!attachStore.removeAll(id)) continue;   // unstamped → retried next run

    stampExpired(d, stamp);
    threads++;
    files += live.length;
    bytes += live.reduce((n, a) => n + (Number(a.bytes) || 0), 0);
    dirty = true;
  }

  if (dirty) save(all);
  return { threads, files, bytes };
}

/* One line for the admin: how full is the allowance? */
function storageStatus() {
  const usedBytes = totalAttachmentBytes();
  const ceilingBytes = totalBytesMax();
  return {
    usedBytes,
    ceilingBytes,
    pct: ceilingBytes > 0 ? Math.round((usedBytes / ceilingBytes) * 100) : 0
  };
}

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
    // Counted up as the batch is read so a single message can't step over the
    // ceiling in three 2 MB jumps between two checks.
    const ceiling = totalBytesMax();
    let used = totalAttachmentBytes();
    try {
      const meta = list.map(item => {
        const raw = String((item && item.data) || '').replace(/^data:[^;,]*;base64,/, '');
        let buf;
        try { buf = Buffer.from(raw, 'base64'); } catch (e) { buf = Buffer.alloc(0); }
        if (!buf.length) throw err('That attachment was empty.');
        if (buf.length > MAX_FILE_BYTES) throw err('Each image has to be under 2 MB.');
        const mime = sniffImage(buf);
        if (!mime) throw err('Attachments have to be PNG, JPEG or WebP images.');

        used += buf.length;
        if (used > ceiling) {
          throw err('We can\'t store any more photos at the moment. Send the report without them and describe what is wrong — we\'ll ask for images if we need them.');
        }

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

  /* Returns whether the bytes are actually gone. The sweep stamps `expiredAt`
     only on a true, so a directory that could not be removed is retried on the
     next run rather than silently recorded as reclaimed. `force: true` means a
     directory that was never there counts as removed, which is what makes the
     sweep idempotent. */
  removeAll(disputeId) {
    if (!disputeId) return false;
    try {
      fs.rmSync(path.join(FILES_DIR, disputeId), { recursive: true, force: true });
      return true;
    } catch (e) {
      console.error('[disputes] could not remove attachments:', e.message);
      return false;
    }
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
        // The record outlives the file. An expired attachment has no bytes to
        // serve, and the UIs render it as a label rather than a fetch button.
        if (a.expiredAt) return null;
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

module.exports = {
  REASONS, OUTCOMES,
  MAX_BODY, MAX_NOTE, MAX_MESSAGES, MAX_OPEN_PER_USER, MAX_FILES_PER_MESSAGE, MAX_FILE_BYTES,
  list, listForUser, get, findOpenForOrder,
  create, addMessage, resolve, reopen, markRead,
  unreadFor, summarize, forCustomer, deleteUserData,
  sniffImage, fileMeta, readFile, totalAttachmentBytes,
  retentionDays, sweepExpiredAttachments, stripAttachments, storageStatus
};
