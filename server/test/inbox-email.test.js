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
  const mail = app.buildInboxOpenedMail(t);

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
  const mail = app.buildInboxOpenedMail(t);
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
  const mail = app.buildInboxOpenedMail(t);
  assert.ok(!mail.html.includes('<script>'), 'the html part must escape the name');
});

/* ---- `subject` is hostile input ----
   It is free text the chat agent relayed from a visitor, to an address
   nothing has verified, and it lands in a mail this shop's branding is on.
   Two properties: it never reaches the Subject header, and no CR/LF survives
   anywhere near one. The CR/LF half is currently killed by cleanShort()'s
   `\s+ → ' '` collapse in inbox.js — that collapse is load-bearing, and is
   commented there as such, because a "preserve line breaks" change would
   reopen header injection. */
test('a hostile subject never reaches the Subject header', () => {
  const t = inbox.create({
    email: 'guest4@example.com',
    name: 'Sam',
    subject: 'Free vials\r\nBcc: victim@example.com\r\nSubject: Your account is suspended',
    body: 'question'
  });
  const mail = app.buildInboxOpenedMail(t);

  // Fixed Subject: the reference and nothing else the visitor chose.
  assert.ok(mail.subject.includes(t.id), 'the reference is what identifies this mail');
  assert.ok(!/Bcc:/i.test(mail.subject), 'a header the visitor typed must not be in the Subject');
  assert.ok(!/suspended/i.test(mail.subject), 'the visitor must not be able to word the Subject');
  assert.ok(!/[\r\n]/.test(mail.subject), 'no CR or LF may survive into a header');

  // And it is not smuggled through the body either, which is where a
  // branded phishing line would have done its work.
  assert.ok(!/Bcc:/i.test(mail.text));
  assert.ok(!/suspended/i.test(mail.text));
  assert.ok(!/Bcc:/i.test(mail.html));
  assert.ok(!/suspended/i.test(mail.html));
});

test('cleanShort strips the CR/LF out of a stored subject', () => {
  // The store-level half of the same guarantee: whatever else renders a
  // subject later, it never gets a line break to work with.
  const t = inbox.create({
    email: 'guest5@example.com',
    subject: 'Line one\r\nLine two',
    body: 'question'
  });
  assert.ok(!/[\r\n]/.test(t.subject), 'inbox.js must not store a subject with a line break in it');
  assert.strictEqual(t.subject, 'Line one Line two');
});

test('markup in a subject is escaped wherever it is shown', () => {
  const t = inbox.create({
    email: 'guest6@example.com',
    subject: '<img src=x onerror=alert(1)>',
    body: 'question'
  });
  // The opened mail drops the subject entirely today, so this is the guard
  // on it ever coming back — if someone reinstates the line, it has to come
  // back through escapeHtmlSrv() or this fails.
  const mail = app.buildInboxOpenedMail(t);
  assert.ok(!mail.html.includes('<img'), 'no raw markup from a visitor may reach an html mail part');
  assert.ok(!mail.html.includes('onerror='));
});
