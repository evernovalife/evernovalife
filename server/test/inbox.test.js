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
