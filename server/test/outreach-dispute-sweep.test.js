/* ============================================================
   EVER NOVA LIFE — the scheduled run actually expires photos

   sweepExpiredAttachments() and /api/admin/disputes/sweep (the
   admin's manual "Run cleanup" button) both had their own tests
   already — but nothing ever drove POST /api/outreach/run, the
   route the cron pinger calls, and proved a photo actually expires
   from THAT path with nobody clicking anything. That gap is
   exactly how "the sweep rides the outreach cron" shipped as a
   comment and a README line while the cron handler itself never
   called the sweep at all.

   So this file drives the real HTTP route with the cron key only —
   no admin token anywhere below — and checks the photo on disk, not
   just a response field.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-outreach-sweep-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-outreach-sweep';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
process.env.CRON_KEY = 'test-cron-key-outreach-sweep';
delete process.env.ADMIN_KEY;

const app = require('../server.js');
const disputes = require('../disputes.js');

const DAY = 24 * 60 * 60 * 1000;

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

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(2048, 7)
]);
const b64 = PNG.toString('base64');

let seq = 0;
function withPhoto(over = {}) {
  const n = seq++;
  return disputes.create({
    userId: 'u-sweep' + n, orderId: 'ENL-SWEEP' + n, reason: 'damaged',
    body: 'Photo attached.', authorEmail: 'sweep@example.com',
    attachments: [{ name: 'vial.png', data: b64 }],
    ...over
  });
}

/* Same trick dispute-retention.test.js uses: the store stamps resolvedAt
   itself on resolve(), so back-date it on disk afterwards — that is the only
   way to age a thread without waiting for real time to pass. */
function resolveDaysAgo(id, days) {
  disputes.resolve(id, { outcome: 'no_action', by: 'boss@evernovalife.com' });
  const file = path.join(TMP_DATA, 'disputes.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  all[id].resolvedAt = new Date(Date.now() - days * DAY).toISOString();
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

/* Runs the cron trigger with ONLY the cron key — no Authorization header at
   all, so this cannot be mistaken for exercising the admin "Run cleanup"
   route (that path is already covered in disputes-api.test.js). */
async function runCron() {
  const res = await fetch(base + '/api/outreach/run', {
    method: 'POST',
    headers: { 'x-cron-key': process.env.CRON_KEY }
  });
  const body = await res.json();
  return { status: res.status, body };
}

test('the cron key is required — no key, no run', async () => {
  const res = await fetch(base + '/api/outreach/run', { method: 'POST' });
  assert.equal(res.status, 401);
});

test('a photo on a long-resolved thread expires from the cron run alone', async () => {
  const d = withPhoto();
  const fileId = d.messages[0].attachments[0].id;
  const onDisk = path.join(TMP_DATA, 'dispute-files', d.id);
  assert.ok(fs.existsSync(onDisk), 'the file exists before any run');

  resolveDaysAgo(d.id, 120);   // well past the 90-day default window

  const before = disputes.totalAttachmentBytes();
  const { status, body } = await runCron();
  assert.equal(status, 200);
  assert.equal(body.success, true);

  // The whole point: this number only moves if runOutreach calls the sweep
  // itself. Before the fix this test fails here with photosExpired === 0.
  assert.ok(body.photosExpired >= 1, `expected at least one expired photo, got ${body.photosExpired}`);

  const after = disputes.get(d.id);
  assert.ok(after.messages[0].attachments[0].expiredAt, 'the record is stamped');
  assert.equal(fs.existsSync(onDisk), false, 'the file itself is gone');
  assert.ok(disputes.totalAttachmentBytes() < before, 'the byte total actually dropped');

  // Nothing but the cron key ever touched the network in this test — the
  // admin sweep/strip routes were never called.
});

test('a thread resolved inside the window is left alone by the same cron run', async () => {
  const d = withPhoto();
  resolveDaysAgo(d.id, 5);   // recently resolved — well inside the window
  const { status, body } = await runCron();
  assert.equal(status, 200);
  const after = disputes.get(d.id);
  assert.equal(after.messages[0].attachments[0].expiredAt, undefined,
    'a thread inside the retention window keeps its photo, even though a run happened');
  // photosExpired may be > 0 from other test data in this same run, so this
  // assertion is scoped to THIS thread rather than the summary count.
  void body;
});
