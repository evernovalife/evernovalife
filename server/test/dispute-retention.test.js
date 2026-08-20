/* ============================================================
   EVER NOVA LIFE — dispute attachment retention
   Photos expire 90 days after the thread is resolved. The record
   survives, the bytes do not. What is guarded here: the clock is
   keyed to resolution (so an active thread never loses evidence
   mid-conversation), a reopened thread is safe again, and the byte
   accounting stops counting what it deleted — without that last
   one the ceiling stays shut after a sweep has freed the space.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-retain-'));
process.env.DATA_DIR = TMP_DATA;

const disputes = require('../disputes.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(2048, 7)
]);
const b64 = PNG.toString('base64');
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
function withPhoto(over = {}) {
  const n = seq++;
  return disputes.create({
    userId: 'u-r' + n, orderId: 'ENL-R' + n, reason: 'damaged',
    body: 'Photo attached.', authorEmail: 'r@example.com',
    attachments: [{ name: 'vial.png', data: b64 }],
    ...over
  });
}
function resolveDaysAgo(id, days) {
  // The store stamps resolvedAt itself, so back-date it on disk — the sweep
  // reads the record, and this is the only way to age one without waiting.
  disputes.resolve(id, { outcome: 'no_action', by: 'boss@evernovalife.com' });
  const file = path.join(TMP_DATA, 'disputes.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  all[id].resolvedAt = new Date(Date.now() - days * DAY).toISOString();
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

test('a thread resolved inside the window keeps its photos', () => {
  const d = withPhoto();
  resolveDaysAgo(d.id, 10);
  disputes.sweepExpiredAttachments(Date.now());
  // Asserted on this thread, not on the sweep's global count: the suite
  // shares one DATA_DIR, and what else the sweep did or didn't touch is not
  // this test's claim.
  const after = disputes.get(d.id);
  assert.equal(after.messages[0].attachments[0].expiredAt, undefined);
});

test('a thread resolved outside the window loses the bytes and keeps the record', () => {
  const d = withPhoto();
  const fileId = d.messages[0].attachments[0].id;
  const onDisk = path.join(TMP_DATA, 'dispute-files', d.id);
  assert.ok(fs.existsSync(onDisk));

  resolveDaysAgo(d.id, 120);
  const before = disputes.totalAttachmentBytes();
  const out = disputes.sweepExpiredAttachments(Date.now());
  assert.ok(out.files >= 1, 'this thread was among those swept');
  // Position-independent, and a stronger claim than a fixed count: whatever the
  // sweep collected, the bytes it reports must equal the space that actually
  // came back. A miscount here is what would make the admin toast lie.
  assert.equal(before - disputes.totalAttachmentBytes(), out.bytes,
    'the sweep reports exactly what it freed');

  const after = disputes.get(d.id);
  const att = after.messages[0].attachments[0];
  assert.ok(att.expiredAt, 'the record survives, stamped');
  assert.equal(att.name, 'vial.png', 'the label survives so the thread still reads');
  assert.equal(att.bytes, PNG.length, 'the historical size survives');
  assert.equal(fs.existsSync(onDisk), false, 'the bytes are gone');
  assert.equal(disputes.readFile(d.id, fileId), null);
  assert.equal(disputes.fileMeta(d.id, fileId), null, 'an expired id resolves to nothing');
});

test('a reopened thread is never swept, however old its last resolution', () => {
  const d = withPhoto();
  resolveDaysAgo(d.id, 400);
  disputes.reopen(d.id, { by: 'boss@evernovalife.com' });
  disputes.sweepExpiredAttachments(Date.now());
  // Asserted on this thread, not on the sweep's global count — see the note
  // on the first test above.
  assert.equal(disputes.get(d.id).messages[0].attachments[0].expiredAt, undefined);
});

test('resolving a second time restarts the clock', () => {
  const d = withPhoto();
  resolveDaysAgo(d.id, 400);
  disputes.reopen(d.id, { by: 'boss@evernovalife.com' });
  disputes.resolve(d.id, { outcome: 'replaced', by: 'boss@evernovalife.com' });
  disputes.sweepExpiredAttachments(Date.now());
  assert.equal(disputes.get(d.id).messages[0].attachments[0].expiredAt, undefined,
    'the fresh resolution restarts the clock, so the sweep leaves it alone');
});

test('the byte total excludes what the sweep deleted', () => {
  const d = withPhoto();
  const before = disputes.totalAttachmentBytes();
  assert.ok(before >= PNG.length);
  resolveDaysAgo(d.id, 120);
  const out = disputes.sweepExpiredAttachments(Date.now());
  assert.equal(before - disputes.totalAttachmentBytes(), out.bytes,
    'counting deleted bytes would keep the ceiling shut after a sweep');
  // The line above proves the arithmetic is self-consistent, but it would
  // hold just as well if the sweep collected nothing (0 == 0). This proves
  // it specifically was this thread's photo that left the total, which is
  // the "what the sweep deleted" the test is named for.
  assert.ok(disputes.get(d.id).messages[0].attachments[0].expiredAt,
    'this thread is the one whose bytes left the total');
});

test('freeing space lets an attachment through that was refused before', () => {
  const old = withPhoto();
  resolveDaysAgo(old.id, 120);

  // A ceiling just under what is already stored: the next photo is refused.
  const prev = process.env.DISPUTE_TOTAL_BYTES_MAX;
  process.env.DISPUTE_TOTAL_BYTES_MAX = String(disputes.totalAttachmentBytes() + 1);
  try {
    assert.throws(() => withPhoto(), /can't store any more photos/i);
    disputes.sweepExpiredAttachments(Date.now());
    const fresh = withPhoto();          // the same request now succeeds
    assert.equal(fresh.messages[0].attachments.length, 1);
  } finally {
    if (prev === undefined) delete process.env.DISPUTE_TOTAL_BYTES_MAX;
    else process.env.DISPUTE_TOTAL_BYTES_MAX = prev;
  }
});

test('the sweep is idempotent', () => {
  const d = withPhoto();
  resolveDaysAgo(d.id, 120);
  disputes.sweepExpiredAttachments(Date.now());
  assert.ok(disputes.get(d.id).messages[0].attachments[0].expiredAt, 'the first sweep caught this thread');

  // The second call IS a genuinely global claim, and it is safe regardless of
  // the shared DATA_DIR: run twice back-to-back, with no time passing and no
  // new thread created in between, there is nothing left for ANY thread to
  // lose, not just this one — that is what idempotent means here.
  const second = disputes.sweepExpiredAttachments(Date.now());
  assert.deepEqual(second, { threads: 0, files: 0, bytes: 0 });
});

test('a thread with no attachments is left alone', () => {
  // This thread has no attachments, so there is nothing on its own record to
  // assert against afterwards — the claim can only be checked through the
  // sweep's count. Sweeping first clears anything else already due in the
  // shared DATA_DIR, so the zero below is guaranteed by this thread alone,
  // not by what earlier tests happened to leave behind.
  disputes.sweepExpiredAttachments(Date.now());
  const d = disputes.create({
    userId: 'u-none', orderId: 'ENL-NONE', reason: 'other',
    body: 'No photo.', authorEmail: 'n@example.com'
  });
  resolveDaysAgo(d.id, 120);
  assert.equal(disputes.sweepExpiredAttachments(Date.now()).threads, 0,
    'no live attachments means nothing to reclaim, however overdue the thread');
});

test('stripAttachments frees an open thread and leaves it readable', () => {
  const d = withPhoto();
  const before = disputes.totalAttachmentBytes();
  const out = disputes.stripAttachments(d.id, Date.now());
  assert.equal(out.ok, true);
  assert.equal(out.files, 1);
  assert.equal(out.bytes, PNG.length);
  assert.equal(disputes.totalAttachmentBytes(), before - PNG.length);

  const after = disputes.get(d.id);
  assert.equal(after.messages[0].body, 'Photo attached.', 'the conversation survives');
  assert.ok(after.messages[0].attachments[0].expiredAt);
  assert.equal(after.status, 'awaiting_us', 'stripping does not change the status');
});

test('stripAttachments on an unknown thread is null, and on a stripped one is a no-op', () => {
  assert.equal(disputes.stripAttachments('DSP-NOPE', Date.now()), null);
  const d = withPhoto();
  disputes.stripAttachments(d.id, Date.now());
  assert.deepEqual(disputes.stripAttachments(d.id, Date.now()), { ok: true, files: 0, bytes: 0 });
});

/* Zeros are not zeros. "There was nothing to remove" and "the removal failed"
   used to be the same answer, which is how the console came to report that a
   report had no photos while the pane beside it counted one. */
test('a strip that could not delete the bytes says so, and stamps nothing', () => {
  const d = withPhoto();
  const before = disputes.totalAttachmentBytes();
  const realRm = fs.rmSync;
  let out;
  try {
    fs.rmSync = () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); };
    out = disputes.stripAttachments(d.id, Date.now());
  } finally {
    fs.rmSync = realRm;
  }
  assert.equal(out.ok, false, 'a failure is distinguishable from a no-op');
  assert.equal(out.files, 0);
  assert.equal(out.bytes, 0);

  const after = disputes.get(d.id);
  assert.equal(after.messages[0].attachments[0].expiredAt, undefined,
    'nothing was stamped, so the record still agrees with the disk');
  assert.equal(disputes.totalAttachmentBytes(), before, 'and the bytes are still counted');

  // And it is retryable: the same call succeeds once the disk cooperates.
  const retry = disputes.stripAttachments(d.id, Date.now());
  assert.equal(retry.ok, true);
  assert.equal(retry.files, 1);
});

test('storageStatus reports used, ceiling and a whole-number percentage', () => {
  const prev = process.env.DISPUTE_TOTAL_BYTES_MAX;
  process.env.DISPUTE_TOTAL_BYTES_MAX = '1000';
  try {
    const s = disputes.storageStatus();
    assert.equal(s.ceilingBytes, 1000);
    assert.equal(s.usedBytes, disputes.totalAttachmentBytes());
    assert.equal(s.pct, Math.round((s.usedBytes / 1000) * 100));
  } finally {
    if (prev === undefined) delete process.env.DISPUTE_TOTAL_BYTES_MAX;
    else process.env.DISPUTE_TOTAL_BYTES_MAX = prev;
  }
});

test('the retention window is env-overridable and read per call', () => {
  const prev = process.env.DISPUTE_PHOTO_RETENTION_DAYS;
  try {
    delete process.env.DISPUTE_PHOTO_RETENTION_DAYS;
    assert.equal(disputes.retentionDays(), 90);
    process.env.DISPUTE_PHOTO_RETENTION_DAYS = '1';
    assert.equal(disputes.retentionDays(), 1);

    const d = withPhoto();
    resolveDaysAgo(d.id, 3);            // inside the 90-day default, outside a 1-day window
    disputes.sweepExpiredAttachments(Date.now());
    // Asserted on this thread rather than on a global count: the suite shares
    // one DATA_DIR, and a shortened window legitimately catches whatever else
    // earlier tests left resolved.
    assert.ok(disputes.get(d.id).messages[0].attachments[0].expiredAt,
      'the shortened window caught a thread the default would have kept');
  } finally {
    if (prev === undefined) delete process.env.DISPUTE_PHOTO_RETENTION_DAYS;
    else process.env.DISPUTE_PHOTO_RETENTION_DAYS = prev;
  }
});
