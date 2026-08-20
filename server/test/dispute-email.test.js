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

/* ---- the storage warning ----
   Built through the same builder/sender split as the two notices above, and
   for the same reason: the owner's warning is the part worth asserting, and
   asserting it must not need SMTP. What matters here is that the HTML half
   says as much as the plain-text half — most clients render the HTML, and it
   used to carry the figure and a button and neither of the two facts that
   tell the owner what to do about it. */
const DUE = { pct: 86, usedBytes: 440 * 1024 * 1024, ceilingBytes: 512 * 1024 * 1024, threshold: 80 };

test('the storage warning carries the figures in both parts', () => {
  const mail = app.buildDisputeStorageMail(DUE);
  assert.match(mail.subject, /86%/);
  for (const part of [mail.text, mail.html]) {
    assert.ok(part.includes('440 MB'), 'the used figure is in both parts');
    assert.ok(part.includes('512 MB'), 'the allowance is in both parts');
    assert.ok(part.includes('86'), 'the percentage is in both parts');
    assert.ok(part.includes('80'), 'so is the threshold that sent it');
  }
});

test('both parts say photos expire on their own, and how to raise the ceiling', () => {
  const mail = app.buildDisputeStorageMail(DUE);
  for (const part of [mail.text, mail.html]) {
    assert.match(part, /expire on their own/, 'the retention note is in both parts');
    assert.match(part, /90 days after a report is resolved/, 'with the actual window');
    assert.ok(part.includes('DISPUTE_TOTAL_BYTES_MAX'), 'and the remediation hint');
    assert.ok(part.includes('admin.html#disputes'), 'and the way to reclaim space now');
  }
});

test('the full variant says photos are being refused, in both parts', () => {
  const mail = app.buildDisputeStorageMail({ ...DUE, pct: 100, usedBytes: DUE.ceilingBytes });
  assert.match(mail.subject, /FULL/);
  assert.match(mail.text, /can no longer attach photos/);
  assert.match(mail.html, /can no longer attach photos/);
});

/* This mail is about a disk, not about a person. It is sent to the owner, but
   it travels through whatever mail chain the owner forwards it into — so the
   rule the two customer notices follow applies here too, from the other side:
   nothing that identifies a customer, a report or a file on disk. */
test('the storage warning names no customer, no report and no path', () => {
  const mail = app.buildDisputeStorageMail(DUE);
  for (const part of [mail.subject, mail.text, mail.html]) {
    assert.ok(!/DSP-/.test(part), 'no dispute reference');
    assert.ok(!/@example\.com|@gmail\.com/.test(part), 'no customer address');
    assert.ok(!/dispute-files/.test(part), 'no attachment path');
  }
});

test('the retention figure in the warning is read per send, not frozen', () => {
  const prev = process.env.DISPUTE_PHOTO_RETENTION_DAYS;
  try {
    process.env.DISPUTE_PHOTO_RETENTION_DAYS = '30';
    const mail = app.buildDisputeStorageMail(DUE);
    assert.match(mail.text, /30 days after a report is resolved/);
    assert.match(mail.html, /30 days after a report is resolved/);
  } finally {
    if (prev === undefined) delete process.env.DISPUTE_PHOTO_RETENTION_DAYS;
    else process.env.DISPUTE_PHOTO_RETENTION_DAYS = prev;
  }
});
