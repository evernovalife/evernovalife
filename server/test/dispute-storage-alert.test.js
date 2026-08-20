/* ============================================================
   EVER NOVA LIFE — dispute storage warning
   One email when the allowance is filling, and — like the low-stock
   alert it mirrors — silence afterwards until the condition clears.
   A sweep that frees space re-arms it for next time.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-storealert-'));
process.env.DATA_DIR = TMP_DATA;

const outreach = require('../outreach.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

const at = (pct) => ({ usedBytes: pct * 10, ceilingBytes: 1000, pct });

test('below the threshold nothing is due', () => {
  assert.equal(outreach.selectStorageAlert(at(10)), null);
  assert.equal(outreach.selectStorageAlert(at(79)), null);
});

test('crossing the threshold is due once, then silent', () => {
  const due = outreach.selectStorageAlert(at(82));
  assert.ok(due, 'the first crossing is due');
  assert.equal(due.pct, 82);
  assert.equal(due.threshold, 80);
  assert.equal(due.previousPct, null);

  outreach.markStorageAlerted(due.pct);
  assert.equal(outreach.selectStorageAlert(at(85)), null, 'still filling is not news');
});

test('reaching 100% re-alerts once, because full is a different message', () => {
  const full = outreach.selectStorageAlert(at(100));
  assert.ok(full, 'photos are being refused right now — worth saying');
  assert.equal(full.previousPct, 82);
  outreach.markStorageAlerted(full.pct);
  assert.equal(outreach.selectStorageAlert(at(100)), null, 'and only once');
});

test('freeing space re-arms the warning', () => {
  assert.equal(outreach.selectStorageAlert(at(40)), null, 'quiet once under');
  const again = outreach.selectStorageAlert(at(88));
  assert.ok(again, 'the next crossing is due again');
  assert.equal(again.previousPct, null, 'the old mark was cleared, not kept');
});

test('the threshold is env-overridable and reported in config', () => {
  const prev = process.env.DISPUTE_STORAGE_ALERT_PCT;
  try {
    process.env.DISPUTE_STORAGE_ALERT_PCT = '50';
    // Read per call, so the module does not need reloading.
    assert.equal(outreach.config().storageAlertPct, 50);
  } finally {
    if (prev === undefined) delete process.env.DISPUTE_STORAGE_ALERT_PCT;
    else process.env.DISPUTE_STORAGE_ALERT_PCT = prev;
  }
});

test('an unusable status is treated as nothing to say', () => {
  assert.equal(outreach.selectStorageAlert(null), null);
  assert.equal(outreach.selectStorageAlert({}), null);
});
