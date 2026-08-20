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
