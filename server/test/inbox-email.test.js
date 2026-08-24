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
