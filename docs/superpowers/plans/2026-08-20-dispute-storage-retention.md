# Dispute Attachment Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the dispute feature's attachment ceiling a door — photos expire 90 days after a thread is resolved, the admin can see how full storage is and free it by hand, and one email warns the owner before it fills.

**Architecture:** Retention lives in `server/disputes.js`, which already owns the on-disk layout and the byte accounting. The sweep runs on the existing `/api/outreach/run` cron alongside the low-stock alert, using `server/outreach.js`'s established select-then-mark pattern with its re-arm rule. Three admin routes expose the figure, the sweep and a per-thread strip; both UIs render an expired attachment as a label rather than a fetch button.

**Tech Stack:** Node 18+, Express 4, `node:test`, nodemailer via `server/email.js`, vanilla browser JS (no build step).

**Spec:** [docs/superpowers/specs/2026-08-20-dispute-storage-retention-design.md](../specs/2026-08-20-dispute-storage-retention-design.md)

## Global Constraints

- **No new npm dependencies.** `server/package.json` does not change.
- Node built-ins use the `node:` prefix in test files, plain names (`fs`, `path`) in server modules — match the file you are editing.
- Store errors carry a status: `throw Object.assign(new Error('message'), { status: 400 })` — `disputes.js` has an `err()` helper that does this.
- **HTML files are UTF-8 without a BOM.** Use the Edit/Write tools or Python (`encoding='utf-8', newline=''`). **NEVER** PowerShell `Get-Content`/`Out-File` — it double-encodes every non-ASCII character across the whole file.
- **No emoji as UI icons.** Inline SVG only, matching the `ICONS` set in `js/admin-core.js`.
- The admin console re-renders views wholesale — **no listeners inside `js/admin-disputes.js`**; branches go in `js/admin-console.js`'s one delegated click handler.
- The shared admin helper object is `window.Admin` (`var A = window.Admin;`) and the disputes view publishes `window.AdminDisputes`. There is no `ENLAdmin`/`ENLDisputes`.
- Escape every interpolated value with `A.esc` (admin) or the local `esc` (support.js); any newline-to-`<br>` goes **after** escaping.
- Copy is research-supplier neutral.
- Tunables are read **per call** from `process.env`, never cached at module load, so they can change on Render without a redeploy.
- Tests run from `server/` with `npm test`. The suite is at **281** and every one must still pass.
- Never commit runtime state — `server/data/` is gitignored.
- **Do not bump cache-busters until Task 5.** Everything is at `?v=71` until then.

---

### Task 1: Expiry primitives in the store

**Files:**
- Modify: `server/disputes.js`
- Test: `server/test/dispute-retention.test.js` (create)

**Interfaces:**
- Consumes: the existing `load`/`save`/`err`/`attachStore`/`totalAttachmentBytes`/`totalBytesMax` in `server/disputes.js`.
- Produces, for Tasks 2–4:
  - attachment records gain `expiredAt` (ISO string, absent until expired)
  - `retentionDays()` → number
  - `sweepExpiredAttachments(now)` → `{ threads, files, bytes }`
  - `stripAttachments(disputeId, now)` → `{ files, bytes }` · `null` when there is no such thread
  - `storageStatus()` → `{ usedBytes, ceilingBytes, pct }`
  - `attachStore.removeAll(disputeId)` now returns `boolean`
  - `totalAttachmentBytes()` **excludes** expired records
  - `fileMeta(disputeId, fileId)` returns `null` for an expired attachment

- [ ] **Step 1: Write the failing test**

Create `server/test/dispute-retention.test.js`:

```js
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
  const out = disputes.sweepExpiredAttachments(Date.now());
  assert.equal(out.threads, 0);
  const after = disputes.get(d.id);
  assert.equal(after.messages[0].attachments[0].expiredAt, undefined);
});

test('a thread resolved outside the window loses the bytes and keeps the record', () => {
  const d = withPhoto();
  const fileId = d.messages[0].attachments[0].id;
  const onDisk = path.join(TMP_DATA, 'dispute-files', d.id);
  assert.ok(fs.existsSync(onDisk));

  resolveDaysAgo(d.id, 120);
  const out = disputes.sweepExpiredAttachments(Date.now());
  assert.equal(out.threads, 1);
  assert.equal(out.files, 1);
  assert.equal(out.bytes, PNG.length);

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
  const out = disputes.sweepExpiredAttachments(Date.now());
  assert.equal(out.threads, 0);
  assert.equal(disputes.get(d.id).messages[0].attachments[0].expiredAt, undefined);
});

test('resolving a second time restarts the clock', () => {
  const d = withPhoto();
  resolveDaysAgo(d.id, 400);
  disputes.reopen(d.id, { by: 'boss@evernovalife.com' });
  disputes.resolve(d.id, { outcome: 'replaced', by: 'boss@evernovalife.com' });
  assert.equal(disputes.sweepExpiredAttachments(Date.now()).threads, 0);
});

test('the byte total excludes what the sweep deleted', () => {
  const d = withPhoto();
  const before = disputes.totalAttachmentBytes();
  assert.ok(before >= PNG.length);
  resolveDaysAgo(d.id, 120);
  disputes.sweepExpiredAttachments(Date.now());
  assert.equal(disputes.totalAttachmentBytes(), before - PNG.length,
    'counting deleted bytes would keep the ceiling shut after a sweep');
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
  const first = disputes.sweepExpiredAttachments(Date.now());
  assert.equal(first.threads, 1);
  const second = disputes.sweepExpiredAttachments(Date.now());
  assert.deepEqual(second, { threads: 0, files: 0, bytes: 0 });
});

test('a thread with no attachments is left alone', () => {
  const d = disputes.create({
    userId: 'u-none', orderId: 'ENL-NONE', reason: 'other',
    body: 'No photo.', authorEmail: 'n@example.com'
  });
  resolveDaysAgo(d.id, 120);
  assert.equal(disputes.sweepExpiredAttachments(Date.now()).threads, 0);
});

test('stripAttachments frees an open thread and leaves it readable', () => {
  const d = withPhoto();
  const before = disputes.totalAttachmentBytes();
  const out = disputes.stripAttachments(d.id, Date.now());
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
  assert.deepEqual(disputes.stripAttachments(d.id, Date.now()), { files: 0, bytes: 0 });
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
    resolveDaysAgo(d.id, 3);            // inside 90, outside 1
    assert.equal(disputes.sweepExpiredAttachments(Date.now()).threads, 1);
  } finally {
    if (prev === undefined) delete process.env.DISPUTE_PHOTO_RETENTION_DAYS;
    else process.env.DISPUTE_PHOTO_RETENTION_DAYS = prev;
  }
});
```

- [ ] **Step 2: Run the test to watch it fail**

Run: `cd server && node --test test/dispute-retention.test.js`
Expected: FAIL — `disputes.sweepExpiredAttachments is not a function`.

- [ ] **Step 3: Make `removeAll` report success**

In `server/disputes.js`, the sweep must know whether a directory actually went away, so it can leave a failure unstamped and retry next run instead of marking it done. Replace `attachStore.removeAll`:

```js
  /* Returns whether the bytes are actually gone. The sweep stamps `expiredAt`
     only on a true, so a directory that could not be removed is retried on the
     next run rather than silently recorded as reclaimed. `force: true` means a
     directory that was never there counts as removed, which is what makes the
     sweep idempotent. */
  removeAll(disputeId) {
    if (!disputeId) return false;
    try {
      fs.rmSync(path.join(FILES_DIR, disputeId), { recursive: true, force: true });
      return true;
    } catch (e) {
      console.error('[disputes] could not remove attachments:', e.message);
      return false;
    }
  }
```

- [ ] **Step 4: Stop counting bytes that are no longer on disk**

In `totalAttachmentBytes()`, skip expired records. **This is the detail the whole feature turns on** — without it the ceiling keeps refusing photos after a sweep has already freed the space, and the storage figure is a lie:

```js
function totalAttachmentBytes() {
  const all = load();
  let total = 0;
  for (const id of Object.keys(all)) {
    const d = all[id];
    for (const m of (d && d.messages) || []) {
      for (const a of (m.attachments || [])) {
        // The file is gone; only the record remains. Counting it would keep
        // the ceiling shut against space that has already been reclaimed.
        if (a.expiredAt) continue;
        total += Number(a.bytes) || 0;
      }
    }
  }
  return total;
}
```

- [ ] **Step 5: Add the retention window and the two removal paths**

Add below `totalAttachmentBytes()`:

```js
/* How long a resolved report keeps its photos. Read per call, like the
   ceiling, so it can be changed on Render without a redeploy. The clock is
   keyed to `resolvedAt` and not to message age, so an active conversation
   never loses evidence in the middle of itself. */
const RETENTION_DAYS_DEFAULT = 90;
function retentionDays() {
  const n = Number(process.env.DISPUTE_PHOTO_RETENTION_DAYS);
  return (Number.isFinite(n) && n > 0) ? n : RETENTION_DAYS_DEFAULT;
}

/* Every attachment on one thread that still has bytes behind it. */
function liveAttachments(d) {
  const live = [];
  for (const m of (d && d.messages) || []) {
    for (const a of (m.attachments || [])) if (!a.expiredAt) live.push(a);
  }
  return live;
}

function stampExpired(d, stamp) {
  for (const m of d.messages) {
    for (const a of (m.attachments || [])) if (!a.expiredAt) a.expiredAt = stamp;
  }
}

/* Drop one thread's photos now, whatever its age or status. The admin's
   "Remove photos" control — for the report that is eating the disk today. */
function stripAttachments(disputeId, now) {
  const all = load();
  const d = all[disputeId];
  if (!d) return null;

  const live = liveAttachments(d);
  if (!live.length) return { files: 0, bytes: 0 };
  if (!attachStore.removeAll(disputeId)) return { files: 0, bytes: 0 };

  stampExpired(d, new Date(now || Date.now()).toISOString());
  save(all);
  return { files: live.length, bytes: live.reduce((n, a) => n + (Number(a.bytes) || 0), 0) };
}

/* The scheduled pass: every thread resolved longer ago than the window loses
   its photos. A thread that has been reopened has no `resolvedAt`, so it is
   safe again — and resolving it a second time restarts the clock. One
   unreadable directory logs and the run continues; stopping would leave every
   later thread unreclaimed because of one bad one. */
function sweepExpiredAttachments(now) {
  const at = now || Date.now();
  const cutoff = at - retentionDays() * 24 * 60 * 60 * 1000;
  const stamp = new Date(at).toISOString();
  const all = load();
  let threads = 0, files = 0, bytes = 0, dirty = false;

  for (const id of Object.keys(all)) {
    const d = all[id];
    if (!d || !d.resolvedAt) continue;
    const resolvedMs = new Date(d.resolvedAt).getTime();
    if (!Number.isFinite(resolvedMs) || resolvedMs > cutoff) continue;

    const live = liveAttachments(d);
    if (!live.length) continue;
    if (!attachStore.removeAll(id)) continue;   // unstamped → retried next run

    stampExpired(d, stamp);
    threads++;
    files += live.length;
    bytes += live.reduce((n, a) => n + (Number(a.bytes) || 0), 0);
    dirty = true;
  }

  if (dirty) save(all);
  return { threads, files, bytes };
}

/* One line for the admin: how full is the allowance? */
function storageStatus() {
  const usedBytes = totalAttachmentBytes();
  const ceilingBytes = totalBytesMax();
  return {
    usedBytes,
    ceilingBytes,
    pct: ceilingBytes > 0 ? Math.round((usedBytes / ceilingBytes) * 100) : 0
  };
}
```

- [ ] **Step 6: Make an expired id resolve to nothing**

In `fileMeta`, return `null` once the bytes are gone, so the attachment routes answer 404 rather than reading a missing path:

```js
      if (a.id === fileId) {
        // The record outlives the file. An expired attachment has no bytes to
        // serve, and the UIs render it as a label rather than a fetch button.
        if (a.expiredAt) return null;
        return { path: path.join(FILES_DIR, disputeId, a.id + '.' + extFor(a.mime)), mime: a.mime, name: a.name };
      }
```

- [ ] **Step 7: Export the new functions**

Add `retentionDays`, `sweepExpiredAttachments`, `stripAttachments` and `storageStatus` to `module.exports`.

- [ ] **Step 8: Run the retention tests**

Run: `cd server && node --test test/dispute-retention.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 9: Run the whole suite**

Run: `cd server && npm test`
Expected: 281 existing + 12 new = 293, 0 failing.

- [ ] **Step 10: Commit**

```bash
git add server/disputes.js server/test/dispute-retention.test.js
git commit -m "feat(disputes): expire a resolved report's photos, keeping the record"
```

---

### Task 2: Admin routes — the figure, the sweep, the strip

**Files:**
- Modify: `server/server.js` (the admin dispute block)
- Modify: `server/test/disputes-api.test.js` (append)

**Interfaces:**
- Consumes: Task 1's `sweepExpiredAttachments`, `stripAttachments`, `storageStatus`.
- Produces, for Task 4:
  - `GET /api/admin/disputes` → the existing payload plus `storage: { usedBytes, ceilingBytes, pct }`
  - `POST /api/admin/disputes/sweep` → `{ success, threads, files, bytes, storage }`
  - `DELETE /api/admin/disputes/:id/attachments` → `{ success, files, bytes, storage }` · `404` unknown thread

- [ ] **Step 1: Append the failing tests**

Add to the end of `server/test/disputes-api.test.js`:

```js
/* ============================================================
   STORAGE — the figure, the sweep, the strip
   ============================================================ */

test('the admin queue carries the storage figure', async () => {
  const token = await adminToken();
  const { status, body } = await api('/api/admin/disputes', { token });
  assert.equal(status, 200);
  assert.ok(body.storage, 'storage rides on the existing response');
  assert.equal(typeof body.storage.usedBytes, 'number');
  assert.equal(typeof body.storage.ceilingBytes, 'number');
  assert.equal(typeof body.storage.pct, 'number');
});

test('an ordinary account is refused the storage controls', async () => {
  const mal = await signUp('mal-storage@example.com');
  for (const [method, pathname] of [
    ['POST', '/api/admin/disputes/sweep'],
    ['DELETE', '/api/admin/disputes/DSP-NOPE/attachments']
  ]) {
    const { status } = await api(pathname, { method, token: mal.token, body: method === 'POST' ? {} : undefined });
    assert.equal(status, 401, `${method} ${pathname} should be 401, got ${status}`);
  }
});

test('stripping a thread frees its photos and reports what went', async () => {
  const vera = await signUp('vera-d@example.com');
  placeOrder(vera.user.id, 'ENL-STRIP');
  const made = await api('/api/disputes', {
    method: 'POST', token: vera.token,
    body: { orderId: 'ENL-STRIP', reason: 'damaged', message: 'See photo.', attachments: [{ name: 'p.png', data: PNG }] }
  });
  const id = made.body.dispute.id;
  const fileId = made.body.dispute.messages[0].attachments[0].id;
  const token = await adminToken();

  const before = (await api('/api/admin/disputes', { token })).body.storage.usedBytes;
  const out = await api(`/api/admin/disputes/${id}/attachments`, { method: 'DELETE', token });
  assert.equal(out.status, 200);
  assert.equal(out.body.files, 1);
  assert.ok(out.body.bytes > 0);
  assert.equal(out.body.storage.usedBytes, before - out.body.bytes);

  // The bytes are gone for both sides; the conversation is not.
  assert.equal((await api(`/api/disputes/${id}/files/${fileId}`, { token: vera.token })).status, 404);
  assert.equal((await api(`/api/admin/disputes/${id}/files/${fileId}`, { token })).status, 404);
  const seen = await api(`/api/disputes/${id}`, { token: vera.token });
  assert.equal(seen.body.dispute.messages[0].body, 'See photo.');
  assert.ok(seen.body.dispute.messages[0].attachments[0].expiredAt);
});

test('stripping an unknown thread is a 404', async () => {
  const token = await adminToken();
  assert.equal((await api('/api/admin/disputes/DSP-NOPE/attachments', { method: 'DELETE', token })).status, 404);
});

test('the sweep runs on demand and reports zeros when nothing is due', async () => {
  const token = await adminToken();
  const { status, body } = await api('/api/admin/disputes/sweep', { method: 'POST', token });
  assert.equal(status, 200);
  assert.equal(typeof body.threads, 'number');
  assert.equal(typeof body.files, 'number');
  assert.ok(body.storage, 'the caller gets the fresh figure back');
});
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd server && node --test test/disputes-api.test.js`
Expected: FAIL — `body.storage` is undefined; the two new routes 404.

- [ ] **Step 3: Add `storage` to the queue response**

In `server/server.js`, in the `GET /api/admin/disputes` handler, add `storage` to the JSON it already returns:

```js
  res.json({
    success: true,
    reasons: disputes.REASONS,
    outcomes: disputes.OUTCOMES,
    /* The figure rides on the queue the console already loads, so the
       storage line costs no extra request. */
    storage: disputes.storageStatus(),
    disputes: rows
  });
```

- [ ] **Step 4: Add the two controls**

Immediately after the `GET /api/admin/disputes` route — **before** the `/:id` routes, so `sweep` can never be read as a dispute id — add:

```js
/* ---- ADMIN: reclaim attachment space ----
   Two destructive controls, and the only ones in the console not tied to
   deleting an account. Both drop bytes and keep the record, so a thread that
   has been cleared still reads honestly: the message says a photo was sent,
   and the label says it is gone. */
app.post('/api/admin/disputes/sweep', requireAdmin, (req, res) => {
  const out = disputes.sweepExpiredAttachments(Date.now());
  if (out.threads) {
    console.log(`[disputes] swept ${out.files} photo(s) from ${out.threads} resolved report(s)`);
  }
  res.json({ success: true, ...out, storage: disputes.storageStatus() });
});

app.delete('/api/admin/disputes/:id/attachments', requireAdmin, (req, res) => {
  const out = disputes.stripAttachments(req.params.id, Date.now());
  if (!out) return res.status(404).json({ error: 'No report with that reference.' });
  res.json({ success: true, ...out, storage: disputes.storageStatus() });
});
```

- [ ] **Step 5: Add the new routes to the authz sweep**

In `server/test/authz.test.js`, in the anonymous-401 case list, add:

```js
    ['POST', '/api/admin/disputes/sweep'],
    ['DELETE', '/api/admin/disputes/DSP-NOPE/attachments'],
```

- [ ] **Step 6: Run the API tests, then the suite**

Run: `cd server && node --test test/disputes-api.test.js`
Expected: PASS.

Run: `cd server && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/server.js server/test/disputes-api.test.js server/test/authz.test.js
git commit -m "feat(disputes): admin can see storage and reclaim it"
```

---

### Task 3: The warning email

**Files:**
- Modify: `server/outreach.js`
- Modify: `server/server.js` (`runOutreach` and a new sender)
- Test: `server/test/dispute-storage-alert.test.js` (create)

**Interfaces:**
- Consumes: Task 1's `storageStatus()`.
- Produces:
  - `outreach.selectStorageAlert(status, now)` → `{ pct, usedBytes, ceilingBytes, threshold, previousPct } | null`
  - `outreach.markStorageAlerted(pct, now)` → the stored mark
  - `outreach.config()` gains `storageAlertPct`
  - `runOutreach`'s summary gains `storageAlerts`

- [ ] **Step 1: Write the failing test**

Create `server/test/dispute-storage-alert.test.js`:

```js
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
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd server && node --test test/dispute-storage-alert.test.js`
Expected: FAIL — `outreach.selectStorageAlert is not a function`.

- [ ] **Step 3: Carry the mark in the state file**

In `server/outreach.js`, `load()`'s normaliser returns a fixed set of keys. Add `storage` — unlike the others it is a single record, not a map, and `null` means nothing outstanding:

```js
  return {
    carts: obj.carts && typeof obj.carts === 'object' ? obj.carts : {},
    orders: obj.orders && typeof obj.orders === 'object' ? obj.orders : {},
    stock: obj.stock && typeof obj.stock === 'object' ? obj.stock : {},
    /* One record, not a map: there is only one disk. `null` = nothing
       outstanding, which is what makes the re-arm below readable. */
    storage: obj.storage && typeof obj.storage === 'object' ? obj.storage : null
  };
```

- [ ] **Step 4: Add the selector and the mark**

Add after `markStockAlerted`, reading the threshold per call so Render can change it without a redeploy:

```js
/* Dispute photos share the disk with every other JSON store here, so the
   allowance filling up is worth an email before it stops accepting them.
   Same shape as the stock alert: due once on the crossing, silent while it
   stays there, and the mark is DELETED when usage falls back under — so a
   sweep re-arms the warning for next time. The exception mirrors the
   run-to-zero rule: reaching 100% says something the 80% email did not,
   namely that photos are being refused right now. */
function storageAlertPct() {
  return num(process.env.DISPUTE_STORAGE_ALERT_PCT, 80);
}

function selectStorageAlert(status, now = Date.now()) {
  const pct = Number(status && status.pct);
  if (!Number.isFinite(pct)) return null;

  const threshold = storageAlertPct();
  const state = load();

  if (pct < threshold) {
    if (state.storage) { state.storage = null; save(state); }   // re-arm
    return null;
  }

  const prev = state.storage;
  const firstCrossing = !prev;
  const hitFull = prev && pct >= 100 && Number(prev.pct) < 100;
  if (!firstCrossing && !hitFull) return null;

  return {
    pct,
    usedBytes: Number(status.usedBytes) || 0,
    ceilingBytes: Number(status.ceilingBytes) || 0,
    threshold,
    previousPct: prev ? Number(prev.pct) : null
  };
}

function markStorageAlerted(pct, now = Date.now()) {
  const state = load();
  state.storage = { pct: Number(pct) || 0, alertedAt: now };
  save(state);
  return state.storage;
}
```

Add `storageAlertPct: storageAlertPct()` to the object `config()` returns, and add `selectStorageAlert` and `markStorageAlerted` to `module.exports`.

- [ ] **Step 5: Run the alert tests**

Run: `cd server && node --test test/dispute-storage-alert.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Send it from the outreach run**

In `server/server.js`, add the sender beside `sendLowStockAlert`, matching its recipient and guard exactly:

```js
/* The owner's copy of the storage figure. Same recipient and guard as the
   low-stock alert: without ADMIN_EMAIL this is built and dropped, which is
   why /api/health reports whether that inbox exists at all. */
async function sendDisputeStorageAlert({ pct, usedBytes, ceilingBytes, threshold }) {
  const to = process.env.ADMIN_EMAIL || '';
  if (!mailer.CONFIGURED || !to) return;
  const mb = n => (Number(n) / (1024 * 1024)).toFixed(0) + ' MB';
  const full = pct >= 100;
  return mailer.sendMail({
    to,
    subject: full
      ? 'Dispute photo storage is FULL — photos are being refused'
      : `Dispute photo storage at ${pct}%`,
    text: (full
      ? `Customers can no longer attach photos to a report. Their reports still go through, and they are told to describe the problem instead — but the evidence is not reaching you.\n\n`
      : `Dispute photos are using ${mb(usedBytes)} of the ${mb(ceilingBytes)} allowance (${pct}%, warning at ${threshold}%).\n\n`) +
      `Photos expire on their own ${DISPUTE_RETENTION_NOTE}, and you can reclaim space now from the Disputes screen:\n` +
      `${SITE()}/admin.html#disputes\n\n` +
      `If the disk itself has room, raise DISPUTE_TOTAL_BYTES_MAX on the server instead.\n`,
    html: orderEmailHtml({
      heading: full ? 'Photo storage is full' : 'Photo storage is filling up',
      intro: full
        ? 'Customers can no longer attach photos to a report. Their reports still go through — but the evidence is not reaching you.'
        : `Dispute photos are using <strong>${escapeHtmlSrv(mb(usedBytes))}</strong> of the ${escapeHtmlSrv(mb(ceilingBytes))} allowance (<strong>${escapeHtmlSrv(String(pct))}%</strong>).`,
      extraHtml: `<p><a href="${SITE()}/admin.html#disputes" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Open Disputes</a></p>`
    })
  });
}
```

`orderEmailHtml`'s signature is `{ heading, intro, rowsHtml, extraHtml }` (`server/server.js:2810`) — verified, not assumed. There is no `ctaHref`/`ctaText`; the button goes in `extraHtml`, matching how `sendPaidOwnerAlert` builds its "Open admin" button at `server/server.js:2877`. `rowsHtml` is optional and omitted here because there is no table to show.

Define the retention note near the sender so the wording stays in one place:

```js
const DISPUTE_RETENTION_NOTE = `${disputes.retentionDays()} days after a report is resolved`;
```

Place it inside the function instead if you prefer it re-read per send — the value is env-driven, and a module-level `const` would freeze it at boot.

- [ ] **Step 7: Wire it into `runOutreach`**

In `runOutreach`, add `storageAlerts: 0` to the `summary` object, and add this pass after the stock pass, following the same stamp-whether-or-not-it-sent rule:

```js
  /* ---- 4. dispute photo storage ---- */
  try {
    const due = outreach.selectStorageAlert(disputes.storageStatus(), now);
    if (due) {
      try {
        await sendDisputeStorageAlert(due);
        summary.storageAlerts++;
      } catch (e) {
        summary.errors++;
        console.error('[outreach] storage alert failed:', e.message);
      }
      /* Stamped either way — a broken SMTP must turn one missed warning into
         one missed warning, not an hourly retry. */
      outreach.markStorageAlerted(due.pct, now);
    }
  } catch (e) {
    summary.errors++;
    console.error('[outreach] storage pass failed:', e.message);
  }
```

Add `storageAlerts` to the summary line that `console.log`s at the end of the run, and to the `if (...)` that decides whether to log at all.

- [ ] **Step 8: Run the whole suite**

Run: `cd server && npm test`
Expected: all pass, including the six new alert tests.

- [ ] **Step 9: Commit**

```bash
git add server/outreach.js server/server.js server/test/dispute-storage-alert.test.js
git commit -m "feat(disputes): warn the owner before photo storage fills"
```

---

### Task 4: The admin and customer UI

**Files:**
- Modify: `js/admin-disputes.js`
- Modify: `js/admin-console.js`
- Modify: `js/support.js`
- Modify: `css/styles.css`

**Interfaces:**
- Consumes: Task 2's `storage` field and two routes; Task 1's `expiredAt` on attachment records.
- Produces: nothing further consumes this.

There is no browser test runner in this project; verification is a scripted structural check plus `node --check`, both spelled out below.

- [ ] **Step 1: Render an expired attachment as a label, not a button — admin**

In `js/admin-disputes.js`, `attachmentsHtml` currently renders every attachment as a fetch button. An expired one has no bytes to fetch:

```js
  function attachmentsHtml(disputeId, list) {
    if (!list || !list.length) return '';
    return '<div class="dsp-atts">' + list.map(function (a) {
      // The record outlives the file. Rendering a button here would send the
      // owner to a 404 for something that expired exactly as intended.
      if (a.expiredAt) {
        return '<span class="dsp-att expired" title="Removed ' + A.esc(A.date(a.expiredAt)) + '">' +
          A.esc(a.name) + ' — photo removed</span>';
      }
      return '<button type="button" class="dsp-att act-dsp-att" data-dsp="' + A.esc(disputeId) +
        '" data-file="' + A.esc(a.id) + '">' + A.icon('download') + A.esc(a.name) + '</button>';
    }).join('') + '</div>';
  }
```

- [ ] **Step 2: Add the storage line and the two controls — admin view**

In `js/admin-disputes.js`, add a formatter and the line, then place it in `render`:

```js
  function mb(n) {
    var v = Number(n) || 0;
    return v >= 1024 * 1024
      ? (v / (1024 * 1024)).toFixed(0) + ' MB'
      : Math.max(1, Math.round(v / 1024)) + ' KB';
  }

  /* How full the photo allowance is, with the control that frees it. Amber at
     the same threshold that sends the email, so the screen and the inbox never
     disagree about whether this is a problem yet. */
  function storageLine(state) {
    var s = state.storage;
    if (!s) return '';
    var warn = s.pct >= (state.storageAlertPct || 80);
    return '<div class="dsp-storage' + (warn ? ' warn' : '') + '">' +
      '<span>' + A.esc(mb(s.usedBytes)) + ' of ' + A.esc(mb(s.ceilingBytes)) +
        ' · ' + A.esc(String(s.pct)) + '%</span>' +
      '<button type="button" class="btn btn-ghost btn-sm act-dsp-sweep">Run cleanup</button>' +
      '</div>';
  }
```

In `render`, insert `storageLine(state)` immediately inside `.dsp-wrap`, before `.dsp-queue`:

```js
    body.innerHTML =
      '<div class="dsp-wrap">' +
        storageLine(state) +
        '<div class="dsp-queue">' +
```

- [ ] **Step 3: Add "Remove photos" to the thread pane**

In `threadPane`, after `resolveBox(d, outcomes)`, add the control — shown only when there is something to remove:

```js
      resolveBox(d, outcomes) +
      (liveAttachmentCount(d)
        ? '<div class="dsp-strip">' +
            '<span class="muted">' + A.esc(String(liveAttachmentCount(d))) + ' photo(s) stored on this report</span>' +
            '<button type="button" class="btn btn-ghost btn-sm act-dsp-strip" data-id="' + A.esc(d.id) + '">Remove photos</button>' +
          '</div>'
        : '') +
```

with the counter beside the other helpers:

```js
  function liveAttachmentCount(d) {
    var n = 0;
    (d.messages || []).forEach(function (m) {
      (m.attachments || []).forEach(function (a) { if (!a.expiredAt) n++; });
    });
    return n;
  }
```

- [ ] **Step 4: Carry the figure into state and wire the clicks**

In `js/admin-console.js`, add to `state`:

```js
    storage: null,            // dispute photo usage against the ceiling
    storageAlertPct: 80,      // the amber threshold, from the server
```

In `loadAll`, alongside the existing `state.disputes` assignment, take the figure from the same response:

```js
    if (results[8].status === 'fulfilled') {
      state.disputeOutcomes = results[8].value.outcomes || [];
      state.storage = results[8].value.storage || null;
    }
```

Add the two handlers beside the other dispute handlers:

```js
  async function sweepDisputes(btn) {
    if (!window.confirm('Remove photos from every report resolved more than the retention window ago?\n\n' +
        'The conversations stay. The photos are deleted from the server and cannot be recovered.')) return;
    btn.disabled = true;
    try {
      var data = await A.api('/api/admin/disputes/sweep', { method: 'POST' });
      state.storage = data.storage || state.storage;
      A.toast(data.files
        ? 'Removed ' + A.plural(data.files, 'photo') + ' from ' + A.plural(data.threads, 'report') + '.'
        : 'Nothing was old enough to remove.', 'success');
      await loadAll({ quiet: true });
      render();
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
  }

  async function stripDisputePhotos(id, btn) {
    if (!window.confirm('Remove every photo on this report?\n\n' +
        'The conversation stays and still shows that photos were sent. The images themselves are ' +
        'deleted from the server and cannot be recovered.')) return;
    btn.disabled = true;
    try {
      var data = await A.api('/api/admin/disputes/' + encodeURIComponent(id) + '/attachments', { method: 'DELETE' });
      if (state.disputeId !== id) return;      // the owner moved on mid-request
      state.storage = data.storage || state.storage;
      A.toast(data.files ? 'Removed ' + A.plural(data.files, 'photo') + '.' : 'There were no photos to remove.', 'success');
      await openDispute(id);                   // reload the thread so the labels update
    } catch (e) {
      A.toast(e.message, 'error');
      if (state.disputeId === id) btn.disabled = false;
    }
  }
```

Note the `state.disputeId !== id` guard: it is the same one every other thread handler carries, for the same reason — a response for one thread must never write into a pane the owner has moved on from.

Add the branches to the delegated click handler:

```js
      else if (t.classList.contains('act-dsp-sweep')) sweepDisputes(t);
      else if (t.classList.contains('act-dsp-strip')) stripDisputePhotos(t.getAttribute('data-id'), t);
```

- [ ] **Step 5: Render an expired attachment as a label — customer**

In `js/support.js`, in `messageHtml`, the attachments map currently emits a `.sup-att` button for every attachment:

```js
    var atts = (m.attachments || []).map(function (a) {
      // Expired photos keep their place in the conversation so it still reads
      // honestly — a message saying "see the photo" above nothing would leave
      // the customer wondering whether it ever sent.
      if (a.expiredAt) {
        return '<span class="sup-att expired">' + esc(a.name) + ' — photo removed</span>';
      }
      return '<button type="button" class="sup-att" data-file="' + esc(a.id) + '">' + esc(a.name) + '</button>';
    }).join('');
```

- [ ] **Step 6: Style it**

Append to `css/styles.css`:

```css
/* ===== ADMIN — DISPUTE STORAGE ===== */
.dsp-storage { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: .75rem;
  padding: .5rem .75rem; border: 1px solid rgba(255,255,255,.1); border-radius: 10px;
  background: rgba(255,255,255,.03); font-size: .85rem; }
.dsp-storage.warn { border-color: rgba(212,175,55,.5); background: rgba(212,175,55,.1); color: #f0d98a; }
.dsp-strip { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; }
.dsp-att.expired, .sup-att.expired { opacity: .65; font-style: italic; cursor: default;
  border-style: dashed; display: inline-block; padding: .25rem .5rem; border-radius: 8px;
  border: 1px dashed rgba(255,255,255,.2); font-size: .8rem; }
```

`.dsp-storage` spans both columns of `.dsp-wrap`'s grid; at the existing `@media (max-width: 860px)` breakpoint the grid is already one column, so nothing more is needed there.

- [ ] **Step 7: Verify mechanically**

Save as `<scratchpad>/check-storage-ui.js` and run with `node`:

```js
const fs = require('fs');
const read = p => fs.readFileSync(p, 'utf8');
const view = read('js/admin-disputes.js');
const console_ = read('js/admin-console.js');
const support = read('js/support.js');
const css = read('css/styles.css');

const checks = [
  ['storage line is rendered', view.includes('storageLine(state)') && view.includes('function storageLine')],
  ['sweep button has a handler', view.includes('act-dsp-sweep') && console_.includes('act-dsp-sweep')],
  ['strip button has a handler', view.includes('act-dsp-strip') && console_.includes('act-dsp-strip')],
  ['no orphan handler', !/act-dsp-(sweep|strip)/.test(console_) === !/act-dsp-(sweep|strip)/.test(view)],
  ['strip guards against a stale pane', /state\.disputeId !== id/.test(console_)],
  ['admin renders expired as a span, not a button', /expiredAt[\s\S]{0,200}dsp-att expired/.test(view)],
  ['support renders expired as a span, not a button', /expiredAt[\s\S]{0,200}sup-att expired/.test(support)],
  ['figure is taken from the queue response', console_.includes('.storage')],
  ['styles exist', ['dsp-storage', 'dsp-strip', 'sup-att.expired'].every(c => css.includes('.' + c))],
  ['amber threshold comes from the server, not a literal', view.includes('state.storageAlertPct')],
  ['no emoji', ![view, console_, support].some(s => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s))]
];

let bad = 0;
for (const [name, ok] of checks) { if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name); }
process.exit(bad ? 1 : 0);
```

Run: `node <scratchpad>/check-storage-ui.js`
Expected: 11 PASS, exit 0.

Then: `node --check js/admin-disputes.js && node --check js/admin-console.js && node --check js/support.js`
Expected: silent (no syntax errors — a broken console fails silently in a browser).

- [ ] **Step 8: Run the server suite**

Run: `cd server && npm test`
Expected: unchanged, all passing.

- [ ] **Step 9: Commit**

```bash
git add js/admin-disputes.js js/admin-console.js js/support.js css/styles.css
git commit -m "feat(disputes): show storage, reclaim it, and label a photo that has expired"
```

---

### Task 5: Tell the customer, document, and release

**Files:**
- Modify: `support.html`
- Modify: `privacy.html`
- Modify: `server/README.md`
- Modify: every root `*.html` (cache-busters)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Say it on the form**

Deleting a customer's own submitted evidence on a schedule should not be a surprise. `support.html` has two attachment labels and **their text differs** — verified:

- `support.html:111` — `<label for="supFiles">Photos (optional — up to 3, PNG/JPEG/WebP, 2 MB each)</label>` (the open-report form)
- `support.html:129` — `<label for="supReplyFiles">Photos (optional — up to 3)</label>` (the reply form)

Both need the retention line; do not try to match them with one find-and-replace. Add it after each `</label>` as a `<span class="text-muted">`:

```html
              <span class="text-muted">Photos are kept while the report is open and for 90 days after it is closed.</span>
```

Use the Edit tool or Python. **Never PowerShell** — this file contains em-dashes and curly quotes that it would corrupt.

- [ ] **Step 2: Say it in the privacy policy**

`privacy.html` has **no retention section** — I checked. Its headings are: Information We Collect (`privacy.html:96`), How We Use Your Information (105), Cookies & Tracking (114), Data Sharing & Third Parties (117), Data Security (126), Your Rights (129), Children's Privacy (137), Changes to This Policy (140), Contact Us (143). The only nearby line is a "right to request correction or deletion" bullet at line 133, which is about the customer's rights, not about what the store does on its own.

So this fact needs a home. Add it to the end of **Data Security** (line 126), which is the section about what happens to data once the store holds it — not to Your Rights, which is about what the customer can ask for:

```html
        <p>Photographs you attach to a problem report are kept while the report is open and for 90 days after it is resolved, after which they are deleted from our servers. The written conversation is kept as a record of what was agreed.</p>
```

Do not create a new `<h2>` for one sentence.

**If you change `DISPUTE_PHOTO_RETENTION_DAYS` from 90 on the server, both of these become wrong.** That is deliberate: the number is written out so it has to be kept in step, rather than templated into something nobody notices.

- [ ] **Step 3: Document the routes and the tunables**

Append to `server/README.md`'s Disputes section, matching its existing formatting:

```
Storage (admin)
  POST   /api/admin/disputes/sweep              expire photos on reports resolved past the window
  DELETE /api/admin/disputes/:id/attachments    drop one report's photos now

  GET /api/admin/disputes also returns storage: { usedBytes, ceilingBytes, pct }.

Tunables (all read per request, so Render can change them without a redeploy):
  DISPUTE_TOTAL_BYTES_MAX        total photo allowance in bytes (default 2 GB — set
                                 this to about half the actual disk; the production
                                 disk is 1 GB, so 536870912)
  DISPUTE_PHOTO_RETENTION_DAYS   days after resolution before photos expire (default 90)
  DISPUTE_STORAGE_ALERT_PCT      percentage that triggers the warning email (default 80)

Expiry drops the bytes and keeps the record, so a cleared thread still reads honestly.
The sweep runs on the existing /api/outreach/run cron — if that ping is not armed,
nothing expires and the warning never sends.
```

- [ ] **Step 4: Bump the cache-busters**

Bump every `?v=` on every root HTML file from 71 to 72, using Python — **not** PowerShell:

```python
import re, pathlib
for p in pathlib.Path('.').glob('*.html'):
    s = p.read_text(encoding='utf-8')
    n = re.sub(r'((?:href|src)="[^"]*?)\?v=\d+', r'\1?v=72', s)
    if n != s:
        p.write_text(n, encoding='utf-8', newline='')
        print('bumped', p.name)
```

Note the regex only matches inside an `href=`/`src=` attribute. That is deliberate: a blanket `\?v=\d+` would also rewrite `admin-products.html`'s `'assets/vials/' + p.id + '.webp?v=8'`, which is a separate image-version counter inside a JS string literal and must be left alone.

- [ ] **Step 5: Verify nothing was mangled**

Run: `git diff --stat` — only HTML files, small line counts.

Run: `git diff -- '*.html' | grep -E '^[+-]' | grep -v '^[+-][+-]' | grep -vE '\?v=[0-9]+'`
Expected: **no output** — every changed line differs only in a version number.

Run: `grep -rlP 'â€|Ã‚|Ã—' *.html`
Expected: no matches. If any file appears, it was written with the wrong encoding — `git checkout` it and redo Step 4 with Python.

Run: `grep -oh '?v=[0-9]*' *.html | sort | uniq -c`
Expected: everything at `?v=72`, plus exactly one `?v=8` (the vial counter).

- [ ] **Step 6: Run the whole suite**

Run: `cd server && npm test`
Expected: all passing.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(disputes): retention copy, route docs and cache-busters to v=72"
```

**Do not deploy.** Uploading to GoDaddy and Render is the site owner's decision, and the asset-before-HTML ordering matters — that is handed over, not performed.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Retention window, `resolvedAt` keying, reopen behaviour | 1 |
| `expiredAt`, what survives expiry | 1 |
| Byte accounting excludes expired records | 1 (Step 4, with its own test) |
| `sweepExpiredAttachments` / `stripAttachments` / `storageStatus` | 1 |
| Failed removal left unstamped and retried | 1 (Step 3 + Step 5) |
| The three admin routes | 2 |
| `selectStorageAlert` / `markStorageAlerted`, re-arm, 100% exception | 3 |
| Stamp-whether-or-not-sent | 3 (Step 7) |
| Storage line, Run cleanup, Remove photos, expired labels | 4 |
| Customer-facing retention copy | 5 |
| Cache-busters, docs, deploy handover | 5 |
| Every testing bullet in the spec | 1, 2, 3 |

**Type consistency:** `{ threads, files, bytes }` is returned by `sweepExpiredAttachments` in Task 1, asserted in Task 1 and Task 2's tests, and read as `data.files` / `data.threads` in Task 4. `{ files, bytes }` from `stripAttachments` likewise. `storage: { usedBytes, ceilingBytes, pct }` is produced in Task 1, attached to the response in Task 2, read as `state.storage` in Task 4, and passed to `selectStorageAlert` in Task 3 — the same three keys throughout. `expiredAt` is written in Task 1 and read in Tasks 1, 2 and 4.

**Two things I checked rather than asserted.** The previous plan on this feature carried six defects, and every one came from stating a name or a behaviour of existing code instead of quoting it. So both unknowns here were resolved against the files before this plan was finished, and the answers are written in rather than left as instructions to go and look:

- `orderEmailHtml`'s signature is `{ heading, intro, rowsHtml, extraHtml }` (`server/server.js:2810`). My first draft used `ctaHref`/`ctaText`, which do not exist — corrected in Task 3, Step 6.
- `privacy.html` has no retention section at all; my first draft told the implementer to find one. Corrected in Task 5, Step 2 with the real heading list and a specific home for the sentence.

A third was checked the same way: `support.html`'s two attachment labels are at lines 111 and 129 and their text **differs**, so one find-and-replace will not catch both. Task 5, Step 1 quotes both.
