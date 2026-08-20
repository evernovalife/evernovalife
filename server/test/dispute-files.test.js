/* ============================================================
   EVER NOVA LIFE — dispute attachment tests
   The bytes go to disk and only the metadata into the record.
   What is guarded here: the declared type is never trusted, the
   client's filename is never a path, and deleting an account
   takes the files with it.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-dfiles-'));
process.env.DATA_DIR = TMP_DATA;

const disputes = require('../disputes.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Smallest valid-enough samples: the magic bytes plus filler.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(32, 1)]);
const NOT_AN_IMAGE = Buffer.from('<?php system($_GET["c"]); ?>');

const b64 = (buf) => buf.toString('base64');

function open(over = {}) {
  return disputes.create({
    userId: 'u1', orderId: 'ENL-F' + Math.floor(Math.random() * 1e6),
    reason: 'damaged', body: 'Photo attached.', authorEmail: 'alice@example.com', ...over
  });
}

test('sniffImage recognises png, jpeg and webp and refuses anything else', () => {
  assert.equal(disputes.sniffImage(PNG), 'image/png');
  assert.equal(disputes.sniffImage(JPEG), 'image/jpeg');
  assert.equal(disputes.sniffImage(WEBP), 'image/webp');
  assert.equal(disputes.sniffImage(NOT_AN_IMAGE), null);
});

test('an attached image is written to disk and only its metadata is in the record', () => {
  const d = open({ attachments: [{ name: 'cracked vial.png', data: b64(PNG) }] });
  const att = d.messages[0].attachments;
  assert.equal(att.length, 1);
  assert.equal(att[0].mime, 'image/png');
  assert.equal(att[0].name, 'cracked vial.png');
  assert.equal(att[0].bytes, PNG.length);
  assert.ok(!('data' in att[0]), 'the record must not carry the image data');

  const raw = fs.readFileSync(path.join(TMP_DATA, 'disputes.json'), 'utf8');
  assert.ok(!raw.includes(b64(PNG).slice(0, 24)), 'no base64 payload in the JSON store');

  const buf = disputes.readFile(d.id, att[0].id);
  assert.ok(buf && buf.equals(PNG));
});

test('a file that claims to be a png but is not is refused', () => {
  assert.throws(
    () => open({ attachments: [{ name: 'harmless.png', data: b64(NOT_AN_IMAGE) }] }),
    /image/i
  );
});

test('a file over the size cap is refused', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(disputes.MAX_FILE_BYTES + 1, 7)]);
  assert.throws(() => open({ attachments: [{ name: 'huge.png', data: b64(big) }] }), /2 ?MB|too large/i);
});

test('a fourth image on one message is refused', () => {
  const four = [1, 2, 3, 4].map(n => ({ name: `p${n}.png`, data: b64(PNG) }));
  assert.throws(() => open({ attachments: four }), /3 images|three images/i);
});

test('a data-URL prefix is accepted and stripped', () => {
  const d = open({ attachments: [{ name: 'p.png', data: 'data:image/png;base64,' + b64(PNG) }] });
  assert.equal(d.messages[0].attachments[0].mime, 'image/png');
});

test("the client's filename cannot escape the dispute folder", () => {
  const d = open({ attachments: [{ name: '../../../../escape.png', data: b64(PNG) }] });
  const meta = disputes.fileMeta(d.id, d.messages[0].attachments[0].id);
  const dir = path.join(TMP_DATA, 'dispute-files', d.id);
  assert.ok(meta.path.startsWith(dir + path.sep), 'the stored path stays inside the thread folder');
  assert.ok(fs.existsSync(meta.path));
});

test('fileMeta refuses an id that is not one of this thread\'s attachments', () => {
  const d = open();
  assert.equal(disputes.fileMeta(d.id, '../../disputes'), null);
  assert.equal(disputes.fileMeta(d.id, 'not-a-real-file'), null);
});

test('deleting an account removes its attachment folder from disk', () => {
  const d = open({ userId: 'u-purge', attachments: [{ name: 'p.png', data: b64(PNG) }] });
  const dir = path.join(TMP_DATA, 'dispute-files', d.id);
  assert.ok(fs.existsSync(dir));
  disputes.deleteUserData('u-purge');
  assert.equal(fs.existsSync(dir), false);
});
