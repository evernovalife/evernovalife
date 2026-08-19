# Customer disputes — design

Date: 2026-08-20
Status: approved, not yet implemented

## Problem

When something goes wrong with an order — it never arrived, a vial arrived broken, the wrong item shipped, the charge doesn't match what was ordered — the customer's only channel is `support@evernovalife.com`, reached through a `contact.html` form that does not post anywhere: it opens a pre-filled message in the visitor's own mail app. Nothing about that exchange is attached to the order, nothing is visible in the admin console, and nothing records how it ended.

That has three costs. The owner works a problem out of an inbox with no order in front of them. The customer has no place to look for a reply. And the store has no record of how many orders ended in a refund or a replacement, which is the number that matters when deciding whether a product, a courier or a packing method is the thing that keeps failing.

This design adds order-tied dispute threads: the customer opens one from an order on their account page, both sides post messages and images, and the owner resolves it with a recorded outcome.

## Scope

A dispute is always about **one order**, opened by the **signed-in account that placed it**. There is no guest path and no general-purpose support inbox — `contact.html` keeps its existing mailto behaviour, unchanged.

In scope:

- One open thread per order, opened by the customer with a reason and a first message.
- Messages both ways, with up to three images per message.
- An unread tally on the admin rail, and an email to the customer whenever the store replies or resolves.
- Resolution with a recorded outcome label and a note.

Out of scope, deliberately:

- **Guest disputes.** `POST /api/orders/lookup` already lets a guest see an order's status from a reference-plus-email pair, and that pair is weak enough for read-only status but not for a durable two-way channel. Adding one means minting and mailing a per-thread token, which is a second authentication system for a case that barely occurs — an account is required to order, so almost every order has one.
- **Resolving does not move money or stock.** Marking a dispute `refunded` records that a refund happened; it does not issue one. Payments are crypto and Zelle (see `payments-crypto-only`), neither of which can be reversed from this server, and a "refund" button that only writes a label into two places invites the books and the threads to disagree. Same for `replaced`: the reship is created as a normal order by the owner. This is the deliberate boundary of the feature — the thread is a record, not an engine.
- **Inbound email.** The customer cannot reply by replying to the notification. There is no inbound mail handling on this stack.
- **Live transport.** No websockets. An open thread polls.

## Data model

Threads live in `DATA_DIR/disputes.json`, managed by a new `server/disputes.js`. The module follows `server/store.js`: `ensureDir` / `loadMap` / `saveMap` with an atomic temp-file rename, everything behind named functions so the file can become a table later without touching a route.

The file is a map keyed by dispute id, not by user id. Two of the three most common reads — the admin list and "is there already a thread on this order?" — are cross-user, and a per-user map would make both of them a full scan of a nested structure.

A dispute record:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | `DSP-` + base36 timestamp, matching the `ENL-` order convention |
| `orderId` | string | the order this is about |
| `userId` | string | the account that opened it; the only account that may read it |
| `reason` | one of the reason codes below | what went wrong, chosen when opening |
| `status` | `awaiting_us` \| `awaiting_customer` \| `resolved` | see below |
| `outcome` | `''` \| `refunded` \| `replaced` \| `no_action` \| `withdrawn` | set when resolving |
| `outcomeNote` | string | the owner's free-text note, max 1000 chars |
| `createdAt` / `updatedAt` | ISO string | `updatedAt` moves on every message and status change |
| `resolvedAt` | ISO string or null | |
| `resolvedBy` | string | admin email, or `'admin'` when resolved with the admin key |
| `adminReadAt` / `customerReadAt` | ISO string or null | when each side last opened the thread |
| `messages` | array | oldest first |

A message:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | `m` + base36 timestamp + a counter, unique within the thread |
| `from` | `customer` \| `admin` | |
| `authorEmail` | string | who actually wrote it, for the record |
| `body` | string | max 4000 chars |
| `attachments` | array | `{ id, name, mime, bytes }` — metadata only, never the image data |
| `createdAt` | ISO string | |

Reason codes: `not_delivered`, `damaged`, `wrong_item`, `quality`, `billing`, `other`. Their labels are supplier-neutral — "Product quality or documentation concern", not anything framed around use. This is a research-supply store (see `research-repositioning`); the dispute form is one more place where wording has to hold that line.

### Status is derived, not typed

`status` is never chosen by a human except when resolving. A thread whose last message is from the customer is `awaiting_us`; one whose last message is from the store is `awaiting_customer`. `resolved` is sticky and set only by the resolve route; a reply into a resolved thread is refused, and reopening returns it to the derived value. Keeping it derived means the admin queue can never disagree with the messages in front of it.

### Unread is derived too

Admin unread means "the last message is from the customer and `adminReadAt` is older than it". The mirror holds for the customer. No per-message read flags: a read flag per message is a lot of writes to answer a question that two timestamps already answer.

### Caps

| Cap | Value | Why |
| --- | --- | --- |
| Open threads per order | 1 | A second one splits the conversation about one problem. |
| Open threads per user | 5 | A user with five unresolved problems needs the owner, not another form. |
| Messages per thread | 200 | Bounds the record; a thread that long is a phone call. |
| Message body | 4000 chars | |
| Images per message | 3 | |
| Image size | 2 MB each | |

Hitting a cap is a `400` with a sentence that says which cap and what to do, never a silent truncation.

## Attachments

The bytes are written to `DATA_DIR/dispute-files/<disputeId>/<fileId>.<ext>`. Only the metadata goes in `disputes.json`.

The upload rides in the JSON request body as a base64 string. `express.json` is already configured at `8mb` in `server.js`, so three 2 MB images fit and no multipart dependency is added. The rejected alternative is the one products use — a data-URL stored inside the record — which would rewrite a multi-megabyte JSON file on every message in every thread.

Two rules on the way in:

1. **Type is verified by magic bytes**, not by the declared MIME or the filename: PNG `89 50 4E 47`, JPEG `FF D8 FF`, WebP `RIFF….WEBP`. A declared `image/png` that is actually a script is rejected. Only those three types are accepted.
2. **The filename from the client is never used as a path.** The stored name is `<fileId>.<ext>` from the sniffed type; the client's name is kept as a display label only, escaped on render.

Reading goes through `GET /api/disputes/:id/files/:fileId`, which loads the thread first and serves the file only to its owner or an admin, with `Content-Type` from the sniffed type and `Content-Disposition: inline`. The directory is never mounted as static: a static mount would make every attachment public to anyone who guessed a path, which for a photo of a delivery address is a real disclosure.

`deleteUserData(userId)` removes the user's threads and their file directories. It is wired into the existing delete-user cascade in `server.js` alongside `store`, `loyalty` and `subscriptions` — the one place where a missed module leaves orphaned data behind, and the only one here that leaves orphaned *bytes*.

## Routes

Customer routes, all behind `auth.requireAuth`:

| Route | Behaviour |
| --- | --- |
| `GET /api/disputes` | This account's threads, newest activity first, as summaries (no message bodies). |
| `POST /api/disputes` | `{ orderId, reason, message, attachments[] }`. `404` if that order is not this user's, `409` with the existing `disputeId` if one is already open on it, `400` if the order is cancelled. |
| `GET /api/disputes/:id` | The full thread. `404` — not `403` — if it belongs to someone else, so the route cannot be used to test whether an id exists. |
| `POST /api/disputes/:id/messages` | `{ message, attachments[] }`. `409` if the thread is resolved. |
| `POST /api/disputes/:id/read` | Stamps `customerReadAt`. |
| `GET /api/disputes/:id/files/:fileId` | The image. |

Admin routes, behind `requireAdmin`:

| Route | Behaviour |
| --- | --- |
| `GET /api/admin/disputes` | Every thread, newest activity first, each stitched with its order summary and the customer's email. |
| `GET /api/admin/disputes/:id` | The full thread. |
| `POST /api/admin/disputes/:id/messages` | Reply. Emails the customer. |
| `POST /api/admin/disputes/:id/resolve` | `{ outcome, note }`. Emails the customer. |
| `POST /api/admin/disputes/:id/reopen` | Clears `resolved`, keeps the outcome history in the message stream as a system line. |
| `POST /api/admin/disputes/:id/read` | Stamps `adminReadAt`. |

`ratelimit.limit` guards `POST /api/disputes` and both message routes. Without it, one script with a valid token can fill the Render disk with 2 MB images; the disk is the store's real constraint, not CPU.

## Admin UI

`js/admin-core.js` gains a nav entry between Auto-Ship and Customers:

```js
{ key: 'disputes', href: 'admin.html#disputes', label: 'Disputes', icon: 'chat', tally: 'navDisputes' }
```

`ICONS` gains a `chat` glyph in the existing 24×24 stroke style. `admin-console.js` gains a `TITLES.disputes` entry and loads dispute summaries in `loadAll` — the tally has to be right on first paint, the same reason unpaid orders are loaded there rather than on demand.

The view itself lives in a **new file, `js/admin-disputes.js`**. `admin-console.js` is already 2524 lines; a thread list, a message stream, a composer with image previews and a resolve control is not a section to append to it. `admin-disputes.js` exposes a render function and its own handlers, in the same IIFE-plus-global style as `admin-labels.js`.

Layout: a left column of threads with filter tabs — **Awaiting us** (default), **Awaiting customer**, **Resolved**, **All** — and a right pane holding the order summary card — items, total, status, tracking, so the owner never has to open another tab — above the message stream and the composer. Resolving is a control at the top of the right pane that asks for an outcome and a note before it will close.

Opening a thread marks it read and calls `loadAll({ quiet: true })` so the rail tally drops without a flash.

## Customer UI

A new `support.html` with `js/support.js`, reached from a **Report a problem** button added to each order row in `renderAccountOrders` in `js/auth.js`. The button is shown on any order that is not cancelled, and reads **View the open report** when a thread already exists.

`support.html?order=ENL-…` does one of two things:

- **No thread on that order** — the order summary, a reason `<select>`, a message box, an image picker, and a submit that opens the thread.
- **A thread exists** — the summary, the message stream, and a composer. When the thread is resolved the composer is replaced by the outcome and a line explaining that replying means opening a new report.

The page polls `GET /api/disputes/:id` every 20 seconds while the tab is visible, and stops on `visibilitychange` — a background tab polling forever is a battery and a bandwidth cost for nothing.

The page follows the site conventions already in place: the skip link and `<main>` from the accessibility pass, the shared header and footer, no emoji icons.

## Email

Through `server/email.js`, in the existing template style:

- **The store replied** — subject names the order, body says a reply is waiting and links to `support.html?order=…`.
- **The report was resolved** — the outcome and the note, and the same link.

**The message body is never in the email.** A dispute can contain an address, a courier claim, or a photo description; once it is in an email body it lives in whatever chain that mail is forwarded into. The notification is a doorbell, not a transcript.

Nothing emails the owner. The requirement was an unread badge in the admin console, and that is what the rail tally is.

## Testing

`server/test/disputes.test.js`, `node:test`, run by `npm test` in `server/` like the existing suites:

- A user cannot read, reply to, or attach to another user's thread — `404`, not `403`.
- Opening on an order that is not the caller's is refused.
- A second open thread on the same order returns `409` and names the existing one.
- A reply into a resolved thread is refused; after reopening it succeeds.
- Every cap rejects with a message and writes nothing.
- A file whose bytes are not PNG/JPEG/WebP is rejected even when it declares `image/png`.
- A filename containing `../` cannot escape the dispute's directory.
- Unread is true after the customer posts, false after `read`, and unaffected by the store's own reply.
- `deleteUserData` removes both the threads and the files on disk.

## Deployment notes

- Cache-busters are bumped site-wide at the end, following the project convention: CSS is at `?v=70`, `main.js` at `?v=69`, `auth.js` at `?v=62`, the admin scripts at `?v=66`. Per `cloudflare-asset-cache`, the asset files go up to GoDaddy **before** the HTML that names them.
- The HTML files are UTF-8 without a BOM. Per `powershell-utf8-corruption`, they are edited with the Edit tool or Python, never with PowerShell `Get-Content`/`Out-File`.
- `disputes.json` and `dispute-files/` are runtime state on the Render persistent disk. Neither is seeded, and neither belongs in git.
