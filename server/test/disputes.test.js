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

// Each call opens its own account, keyed off the order reference, so the
// unrelated tests in this file don't pile up against the MAX_OPEN_PER_USER
// cap on a single shared user — only the cap test means to hit that limit.
function open(over = {}) {
  const orderId = over.orderId || 'ENL-AAA';
  return disputes.create({
    userId: 'u-' + orderId,
    orderId,
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

test('an unknown outcome code is refused, and the thread stays open', () => {
  const d = open({ orderId: 'ENL-BADO' });
  assert.throws(() => disputes.resolve(d.id, { outcome: 'vibes', by: 'boss@evernovalife.com' }));
  const after = disputes.get(d.id);
  assert.equal(after.status, 'awaiting_us');
  assert.equal(after.outcome, '');
  assert.equal(after.resolvedAt, null);
});

test('a resolved thread refuses another message until it is reopened', () => {
  const d = open({ orderId: 'ENL-CLOSED' });
  disputes.resolve(d.id, { outcome: 'no_action', by: 'boss@evernovalife.com' });
  assert.throws(
    () => disputes.addMessage(d.id, { from: 'customer', authorEmail: 'alice@example.com', body: 'One more thing' }),
    /resolved/i
  );
  const back = disputes.reopen(d.id, { by: 'boss@evernovalife.com' });
  // The store is who reopened it, and no reply has been sent since — so it
  // is the store that owes the next word, not the customer.
  assert.equal(back.status, 'awaiting_us');
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

test('threads created inside one millisecond all survive', () => {
  // The whole point of the entropy in a dispute id: the map is keyed by it,
  // so two threads minted in the same millisecond would file under one key
  // and the first would be lost. Real disk I/O spaces creates out far enough
  // to hide that, so the clock is pinned here to force the collision case.
  const realNow = Date.now;
  Date.now = () => 1755648000000;
  let made;
  try {
    made = Array.from({ length: 25 }, (_, i) =>
      disputes.create({
        userId: 'u-ms' + i, orderId: 'ENL-MS' + i, reason: 'other',
        body: 'x', authorEmail: 'ms@example.com'
      })
    );
  } finally {
    Date.now = realNow;
  }
  const ids = made.map(d => d.id);
  assert.equal(new Set(ids).size, 25, 'every id is distinct');
  // The assertion that actually catches the bug: a collision presents as a
  // MISSING record, not as a duplicate id.
  const stored = disputes.list();
  for (const id of ids) assert.ok(stored.some(d => d.id === id), 'thread ' + id + ' survived');
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
