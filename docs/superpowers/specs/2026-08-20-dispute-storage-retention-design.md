# Dispute attachment storage — design

Date: 2026-08-20
Status: approved, not yet implemented
Follows: [2026-08-20-customer-disputes-design.md](2026-08-20-customer-disputes-design.md)

## Problem

The dispute feature lets a customer attach photos to a report. Nothing ever removes them. `attachStore.removeAll` is called from exactly one place — deleting a user account — so the only way a byte leaves the disk today is by deleting the customer who sent it.

The feature shipped with a global ceiling (`DISPUTE_TOTAL_BYTES_MAX`) that refuses new photos once the total is reached, which stops an image flood from filling the Render disk and taking `orders.json`, `users.json` and `loyalty.json` down with it. But the ceiling is a wall with no door: there is no way to see how close it is, nothing announces reaching it, and nothing frees space afterwards. The store owner would learn about it from a customer mentioning that photos would not attach.

The production disk is **1 GB**. The ceiling's default is 2 GB, so as shipped it never engages before the disk fills — the exact failure it exists to prevent. `DISPUTE_TOTAL_BYTES_MAX` must be set to `536870912` (512 MB) on that instance regardless of this work.

This design adds the door: expiry, visibility, a warning, and two manual controls.

## Scope

- Photos expire **90 days after the thread is resolved**, on the existing outreach cron.
- Expiry removes the bytes and keeps the record, so the conversation still reads honestly.
- The admin console shows storage used against the ceiling, always.
- One email warns the owner at 80%, and re-arms after space is freed.
- Two manual controls: strip one thread's photos, and run the expiry sweep now.

Out of scope, deliberately:

- **Deleting a whole thread.** The text of a dispute is the record of what was agreed; it costs almost nothing and there is no reason to destroy it. Only the bytes expire.
- **Per-attachment deletion.** A thread's photos are one piece of evidence about one problem. Picking individual files out of it is finer control than the job needs and doubles the UI.
- **A second cron.** Per `outreach-and-order-tracking`, `/api/outreach/run` already needs its own ping and is easy to forget; adding another scheduled trigger adds a second thing to forget.
- **Expiring by message age.** Expiry keys off `resolvedAt`, so an active conversation never loses a photo mid-thread.

## Retention

`DISPUTE_PHOTO_RETENTION_DAYS` (default 90) and `DISPUTE_STORAGE_ALERT_PCT` (default 80) join `DISPUTE_TOTAL_BYTES_MAX` as env-overridable tunables read **per call**, matching the existing ceiling so they can be changed on Render without a redeploy.

A thread is eligible when `resolvedAt` is set and older than the window. Two consequences fall out of that and are intended:

- **A reopened thread is never swept.** `reopen()` clears `resolvedAt`, so the moment a conversation restarts its photos are safe again.
- **Resolving a second time restarts the clock**, because `resolvedAt` is rewritten.

Both are the behaviour a person would want, and both are the kind of thing a later reader might "fix" without realising — so they are asserted in tests rather than only described here.

## What expiry leaves behind

Each attachment record gains one field:

| Field | Type | Meaning |
| --- | --- | --- |
| `expiredAt` | ISO string or absent | when the bytes were removed |

`name`, `mime` and `bytes` stay. The message then reads *"cracked vial.png — photo removed after 90 days"* on both sides. That costs a few hundred bytes per attachment forever, and buys a thread that does not contradict itself: without it, a message saying "see the photo attached" would sit above nothing, with no way to tell whether the photo expired or was never sent.

Both UIs render an attachment with `expiredAt` as that label instead of a fetch button, so nobody clicks into a 404.

### The bytes accounting must exclude expired records

`totalAttachmentBytes()` currently sums `a.bytes` across every attachment. Once expiry exists, that number counts files that are no longer on disk — the ceiling would keep refusing new photos after a sweep had freed the space, and the storage figure would be a lie.

It must sum only attachments **without** `expiredAt`. This is a change to shipped behaviour, not a new function, and it is the single most important correctness detail in this design: get it wrong and the sweep appears to do nothing.

## Sweeping

`server/disputes.js` gains three functions. Retention lives there rather than in a new module because that file already owns `attachStore`, the on-disk layout and the byte accounting; a separate module would have to reach into all three. It grows from ~470 to roughly 550 lines and keeps one responsibility: threads and their bytes.

| Function | Behaviour |
| --- | --- |
| `sweepExpiredAttachments(now)` | Removes files for every eligible thread, stamps `expiredAt` on each attachment it clears, returns `{ threads, files, bytes }`. Idempotent — a thread whose attachments are all stamped is skipped, so a second run does nothing and reports zeros. |
| `stripAttachments(disputeId, now)` | The same operation on one thread, regardless of age or status. Returns `{ files, bytes }`, or `null` if there is no such thread. |
| `storageStatus()` | `{ usedBytes, ceilingBytes, pct }` — `pct` rounded to a whole number. |

Both removal paths call the existing `attachStore.removeAll(disputeId)`, which drops the thread's whole directory. Per-file unlinking would be needed only if attachments within one thread could expire at different times, and they cannot: they share the thread's `resolvedAt`.

A sweep that cannot delete a directory logs and continues to the next thread rather than aborting the run — one unreadable directory must not stop the rest from being reclaimed. The `expiredAt` stamp is written only for threads whose removal succeeded, so a failure is retried on the next run instead of being silently marked done.

## The warning

`server/outreach.js` gains `selectStorageAlert` and `markStorageAlerted`, mirroring `selectStockAlerts` / `markStockAlerted` exactly, including the property that matters most: **the mark is deleted when the condition clears**, so a sweep re-arms the warning for next time.

`load()`'s normaliser gains a `storage` key alongside `carts`, `orders` and `stock`. Unlike those it holds a single record, not a map: `{ pct, alertedAt }`, or absent when nothing is outstanding.

- Below the threshold: the mark is deleted, nothing is due.
- At or above it with no mark: due once.
- At or above it with a mark: silent — with one exception, matching the low-stock rule that re-alerts when a product falls to zero. A thread that has reached **100%** re-alerts once even if a warning was already sent at 80%, because "filling up" and "full, photos are being refused right now" are different messages.

`runOutreach` in `server.js` sends it through the same recipient and `CONFIGURED` guard as the low-stock alert, and — following the established rule there — **stamps the mark whether or not the send succeeded**, so a broken SMTP turns one missed warning into one missed warning rather than an hourly retry.

## Admin surface

| Route | Behaviour |
| --- | --- |
| `GET /api/admin/disputes` | Gains `storage: { usedBytes, ceilingBytes, pct }` on the existing response, so the figure costs no extra request. |
| `POST /api/admin/disputes/sweep` | Runs the expiry now. Returns `{ threads, files, bytes }`. |
| `DELETE /api/admin/disputes/:id/attachments` | Strips one thread's photos. Returns `{ files, bytes }`. `404` if there is no such thread. |

All three are behind `requireAdmin`, like every other admin dispute route.

In the Disputes view (`js/admin-disputes.js`):

- A storage line above the queue: `412 MB of 512 MB · 80%`, amber once `pct` reaches `DISPUTE_STORAGE_ALERT_PCT` (the same threshold that sends the email, so the screen and the inbox never disagree), with a **Run cleanup** button beside it.
- **Remove photos** in the thread pane, shown only when the thread actually has unexpired attachments.

Both are irreversible and both confirm first, naming exactly what will be destroyed — how many photos, from how many reports. These are the only destructive controls in the admin console that are not tied to deleting an account, and they should read that way.

## Telling the customer

Deleting a customer's own submitted evidence on a schedule is not something to do silently. Two copy changes, both small:

- `support.html`'s attachment field gains a line: photos are kept while a report is open and for 90 days after it is closed.
- `privacy.html` gains the same fact in whichever section covers what is kept and for how long.

If the 90-day default is changed on the server, that copy is wrong — so the spec names the number in both places deliberately, as a prompt to keep them in step, rather than templating it.

## Testing

`server/test/dispute-retention.test.js`, `node:test`, alongside the existing dispute suites:

- A thread resolved inside the window is not swept; one resolved outside it is.
- A **reopened** thread is never swept, however old its previous resolution.
- Resolving a second time restarts the clock.
- After a sweep the record survives with `expiredAt` set, and the bytes return `404`.
- `totalAttachmentBytes()` **excludes** expired records — asserted directly, because the ceiling depends on it.
- Freeing space below the ceiling lets a new attachment through that was refused before the sweep.
- The sweep is idempotent: a second run reports zeros and changes nothing.
- `stripAttachments` frees space on an open thread and leaves the messages readable.
- The alert fires once, stays silent on the next tick, re-arms after usage drops, and re-alerts at 100%.
- A thread with no attachments, and one already fully expired, are both no-ops.

## Deployment notes

- Cache-busters move to `?v=72` across the root HTML, assets uploaded before the pages per `cloudflare-asset-cache`.
- HTML is UTF-8 without a BOM — Python or the Edit tool, never PowerShell.
- **`DISPUTE_TOTAL_BYTES_MAX=536870912`** must be set on Render for any of this to engage on the 1 GB disk. `DISPUTE_PHOTO_RETENTION_DAYS` and `DISPUTE_STORAGE_ALERT_PCT` can stay at their defaults.
- The sweep runs on the existing `/api/outreach/run` ping. If that cron is not currently armed, nothing expires — the manual **Run cleanup** button is then the only path, and the warning email never sends.
