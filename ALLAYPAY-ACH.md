# ACH / bank payments — AllayPay (Finagy)

Third payment method, alongside BTCPay crypto and manual Zelle. Buyers pay
straight from a US bank account.

**AllayPay is the ISO, not the gateway.** They underwrote the merchant account;
the rails are **Finagy**, a division of TOSD Corporation. Everything in the code
follows *Transaction Processing Specifications for ACH Billing*, updated
2026‑08‑14. Anywhere this doc says "ask Finagy", the AllayPay rep is the person
who gets you to them.

---

## The one thing to understand

**Finagy has no webhook.** They never call us.

The buyer comes back from their hosted page on a redirect carrying *unsigned
query parameters*, and even an honest one says `status=PENDING` — because at
that instant the money genuinely has not moved. ACH is slow: the file goes to
the bank that night, settles roughly three business days later, and a return can
land up to 60 days after that.

So payment is confirmed by **asking, on a schedule**. `POST /api/ach/poll` is the
only thing that turns an ACH order into a paid one.

> **Without a cron ping on `/api/ach/poll`, every bank payment sits at `pending`
> forever while the money quietly lands in the account.** This is the single
> most important line in this document.

---

## Go-live checklist

### 1. Confirmed by Finagy — 2026-09-09

| Question | Answer |
|---|---|
| `paymentMethod` for ACH — 1 or 2? | **1.** Their parameter table (p.107) was right; every worked example (p.103–105) was wrong. Independently confirmed by reading their `client.min.js`: `case 1 → ach_index`, `case 2 → gach_index` (*guaranteed* ACH, a separate product), `case 3 → cc_index` (cards). |
| Is the redirect's `payment_id` the transaction's `authorizationId`? | **Yes.** Stored as the order's `transactionId` and used for every later lookup, refund and void. |
| Does `clientReferenceId` become the transaction's `uniqueTranId`? | **Yes.** This is the load-bearing one — see below. |
| Is the HPP product enabled on our account? | **Yes.** Proven directly: a session key mints successfully against staging. |

**Why the third answer matters more than it looks.** It means a transaction can
always be found by *our own order reference*. A buyer who closes the tab before
the redirect takes the `payment_id` with them — without `uniqueTranId` their
money would arrive attached to nothing, and no amount of polling would ever
match it to an order. With it, the poller finds them anyway.

### 1b. Two bugs the live tests found — both ours, both fixed

**Blank name and zip.** `collectCheckout()` in `js/main.js` emits a COMBINED
`name` and a `postalCode`; `hppConfig()` was reading `firstName`, `lastName`
and `zip`. So we handed Finagy three empty fields:

```json
{"errors":{"LastName":["'Last Name' must not be empty"]}}
```

That 400 came from `bank-connect/sessions`, and only *then* did Ribbit answer
403 for want of a valid session — which is why the first failure looked like a
gateway block rather than our own payload. Fixed with `pickName()` /
`pickPostalCode()`, which read every spelling in use across this codebase.

**A non-US state.** "State / Region" was a free-text box on a US-only store, so
`BASILAN` (a Philippine province) passed `assertUsShipping`, which only checked
the *country*. Finagy truncates state to two characters, rejected `"BA"`, and
the buyer saw nothing explaining why. Now a **dropdown** (50 states + DC) in
checkout.html, plus a USPS check server-side — the dropdown is a convenience,
the server check is the guard. Territories (PR, VI, GU, AS, MP) are excluded on
purpose: US postal destinations, but nobody has priced shipping to them.

Both verified against live staging: blank or invalid → 400, correct → **200**.

**The lesson worth keeping.** All 443 tests passed through both bugs, because
every fixture was written in the shape the driver *assumed* rather than the
shape the form emits. `server/test/ach.test.js` now fixtures from
`collectCheckout()`'s real output and asserts no field Finagy needs is blank.

### 1c. Ribbit geo-blocks non-US addresses

Once the data is right, `bank-connect/sessions` returns 200 and the buyer is
handed to **Ribbit** for the bank login. Ribbit refuses non-US addresses at the
root, with no token involved:

```
403  test.ribbit.ai/            403  portal.ribbit.ai/
403  test.ribbit.ai/CONNECT     403  playground.ribbit.ai/
200  cdn.ribbit.ai/…js          ← only their CDN, a different service
```

Ribbit is a US bank-data aggregator; geo-blocking its login portal is ordinary
fraud posture. **It does not affect real customers** — we ship US-only and ACH
is a US-only network, so genuine buyers are in the US. It affects testing from
outside the US, and a VPN clears it.

### 1d. Account configuration — answered by Finagy 2026-09-09

`GET /api/hpp/products/ach` (session-key header) reports our HPP config:

```json
{
  "is_enabled": true,
  "is_email_verification_enabled": false,
  "is_user_validation_enabled": true,
  "is_user_validation_input_enabled": false,
  "rtp_validation_max_timeout_seconds": 10
}
```

**`is_user_validation_input_enabled: false` is deliberate, not a fault.** Dan
Locker at Finagy: *"For new merchants we only enable Bank Connect. Once you have
had some time of successfully processing with low returns, we can have a
conversation about enabling additional options like the manual entry."*

So there is no manual routing/account path, and the API enforces it — posting
`/api/hpp/transactions/ach` with `account_number` and `routing_number` returns
`'Bank Connect Account Token' must not be empty`.

> **Plan for this at launch.** Every ACH buyer must log into their bank through
> Ribbit. Anyone whose bank Ribbit cannot reach has no ACH path at all and falls
> back to crypto. Revisit manual entry with Finagy once there is a processing
> history to point at.

**A wrong diagnosis, corrected.** This document previously claimed Finagy's
validation product was broken because `queryInstitution` reports
`achEligible: false` for every routing number, including their own documented
example. That inference was wrong. This account uses **Bank Connect**
(User-Authenticated) validation, so the frictionless DB/RTP product simply is
not provisioned for us — `queryInstitution` failing is consistent with that
rather than evidence of a fault, and `rtp_validation_max_timeout_seconds` is a
default sitting in the config, not proof RTP is running.

The three declined transactions (`639245064869527503`, `639245074916668658`,
`639245075966290768`, all status 1) are explained by not using Finagy's
designated sandbox bank.

### 1e. Sandbox test account

Ribbit's staging bank login, from Andrii Seniv at Finagy:

| | |
|---|---|
| Bank | **chime** |
| Email | `test@evernovalife.com` |
| Password | `ChimeBank01` |

Search for "chime" on the Ribbit bank picker and sign in with those. Any other
bank in the sandbox will decline.

Note that Ribbit geo-blocks its portal: `test.ribbit.ai`, `portal.ribbit.ai`
and `playground.ribbit.ai` all return 403 at the root from non-US addresses.
That affects testing from outside the US only — real buyers are US-based,
because we ship US-only and ACH is a US-only network.

### 1f. RESOLVED — the decline was geography, not their configuration

**Fixed 2026-09-09 by testing through a US VPN.** From a US IP the chime sandbox
account is accepted first time: `639245942322405169` (`ENL-CERT-S01B`, $0.50)
came back **status 2, pending** — the first transaction of this integration ever
to get past `invalidated`. Void, refund-refusal, and the three query endpoints
were all exercised against real transactions the same evening; see
`ALLAYPAY-ACH-TEST-CASES.xlsx` (rebuilt by `tools/build-allaypay-testsheet.py`).

The lesson worth keeping is in the next paragraph: everything below *looked*
like a merchant-account fault and was argued convincingly as one. The single
thing never varied was the egress IP.

**What it looked like before.** Using the chime sandbox account exactly as
Finagy instructed, the HPP answered **"Transaction Declined."** and
`POST /api/hpp/transactions/ach` returned 400.

That string is the whole error. Their modal template is:

```html
<b>{validationDescription}</b>
<p>Please use another account or click Cancel to return to payment selection.</p>
```

so `AccountNumber[0]` in the 400 body literally contains *"Transaction
Declined."* and nothing else — no reason code, no detail.

**The Ribbit login is succeeding.** Their branch is:

```js
bankConnectAccountToken || state.accountId
  ? displayBankNotSupportedModal(...)   ← what we get
  : displayAccountNumberVerificationError(...)
```

The first branch only runs when a `bankConnectAccountToken` exists, so Ribbit
completes and returns a valid account token. The decline happens in Finagy's
validation *after* that.

Transactions from that period, all status 1 (invalidated), all correctly
reconciled by our poller via `uniqueTranId`: `639245064869527503`,
`639245074916668658`, `639245075966290768`, plus client reference
`ENL-MTU4D6BQ`. They are explained by the geo-block, not by a fault at Finagy.

**The diagnostic that would have found it in a minute:** `curl ipinfo.io` before
blaming anyone's configuration. Ribbit's 403 was already documented one section
above (1c) — it just was not connected to the decline that happened *after* the
Ribbit login appeared to succeed.

### 1g. Settlement, refund and the live feed shapes — 2026-09-11

Finagy (Andrii Seniv) settled `639245589443869934` and `639245635306201861`
($0.22 each, orders `ENL-MTU5U6TG` / `ENL-MTU8KE4Z`) and returned
`639245942322405169` (`ENL-CERT-S01B`) **R01**. The refund we had parked on
S01B was therefore impossible, so SALE-05 and SALE-06 were re-run on the settled
pair at 02:58 UTC:

- **Refund** `639245589443869934` → `{"successful":true,"authorizationId":"639246923014123850"}`.
  The credit reads back `tranCode 2`, $0.22, same account, **status 16**, and
  **`uniqueTranId: null`**. The original debit then reads **status 0** — found,
  not "not found", and not in their status table. *(Both statuses were a
  sandbox settlement Finagy had entered wrongly — corrected the same evening to
  **40** on the debit and **4** on the credit. See 1h.)*
- **Void on settled** `639245635306201861` → 400
  `"Cannot void. Transaction is already processed"`; still status 16 after.
- **queryreserves** now returns a row: $100.00 `debitAdjustment`, blank
  `debitReason`, `reserveDate 2026-09-10T18:48:38`, legal name "Ever NovA Life".

The refund was run straight against the API, not through our admin endpoint, so
the live order `ENL-MTU5U6TG` does not record that it was refunded.

**Two bugs the real feed rows exposed** (the stub had been fed the shape we
assumed — same lesson as the blank `lastName`):

1. **In querysettlements/queryreturns, `uniqueTranId` is Finagy's
   authorizationId**, not our `clientReferenceId` (it IS our reference in
   `retrieve`). The late-return sweep looked rows up as order references, so it
   matched nothing — a return against a shipped order would have gone unflagged.
   Now matched on the stored `transactionId` (`findAchOrderForFeedRow`).
2. **`tranStatus` was 1 on an R01 whose settlement row has no `settleDate`.**
   Lateness is decided from our own record: a return on an order we counted as
   `paid` keeps its stock for a human; anything else releases it. (Finagy has
   since defined `tranStatus` — see 1h. That row is hand-made sandbox data, and
   the rule stays, because "might have shipped" is a fact about us, not the
   bank.)

And a guard: `POST /api/admin/ach/:orderId/refund` used to refund anything that
was not status 2 — including a debit already refunded (then reading status 0,
now 40), which could have raised a second credit. It now voids only at 2,
refunds only at 16, refuses everything else before calling Finagy, and refuses
an order already `refunded`/`voided`. There is **no admin UI button** for this
endpoint yet.

### 1h. Finagy's answers — 2026-09-11 (evening)

Andrii Seniv answered the questions on the test sheet. Every answer was checked
against live staging the same night (read-only calls) before anything changed:

1. **"I did a mistake in your Settlement — you must see the '40' status."**
   Confirmed: the refunded debit `639245589443869934` now reads **status 40**.
   Not in their spec. It is now `40: 'refunded'` in `server/finagy.js`.
2. **"It does not appear in settlements because the transaction is currently
   pending."** Confirmed: the refund credit `639246923014123850` now reads
   **status 4** (sent to bank). It will show in querysettlements once it
   settles. It still has `uniqueTranId: null`.
3. **"PageId is not just a page number. It's a Base64 string containing
   information about the last item on the page. Query the next page to check
   whether the cursor is null."** Confirmed. The cursors are Base64 JSON:
   queryreturns `{"ReturnId":21457}`, queryreserves `{"ReserveId":34}`,
   querysettlements `{"SettlementId":25285,"ReturnId":0,"ReserveId":0}`. A page
   with rows always hands back a cursor. The next request returns 0 rows and
   `pageId: null`. That holds for queryreturns, queryreserves, and
   querysettlements with `excludeReturnedItems: true`.

   **One report never ends — reported back to Finagy.** querysettlements with
   `excludeReturnedItems: false` (the returned row included) goes:
   page 1 = 3 rows, cursor `{"SettlementId":25285,…}` → page 2 = the returned row
   AGAIN, cursor `{"SettlementId":0,"ReturnId":0,"ReserveId":0}` (the "all-zeros"
   cursor seen earlier) → page 3 = page 1 again, same cursor as page 1. A naive
   `while (pageId)` loop spins forever there. The cursor never records the
   return's `ReturnId`.
4. **`tranStatus` on a queryreturns row:**
   **1** = the original debit had settled to the merchant's bank account, and the
   return amount is debited on the next business day.
   **2** = it was pending deposit when returned, so the funds never settle to the
   merchant.
   **3** = a **Notification of Change (NOC)**, for information only.
5. **"Everything you see in staging is sandbox data."** That covers the $100.00
   reserve (not our production terms) and the "Ever NovA Life" spelling on
   staging.

**What the answers changed in code:**

- **NOC bug, fixed.** The late-return sweep treated EVERY row of queryreturns as
  a return. A NOC (the bank corrects an account or routing detail and lets the
  debit through) would have moved a paying order to `returned`. On a pending
  order it also released stock and dropped the order out of the poller, and
  then the money arrived anyway. On a paid order it raised a false
  late-return alarm. Now `finagy.isNotificationOfChange(row)` (tranStatus 3,
  or any NACHA C-code) skips those rows. The order keeps its status, and the
  code is noted on it as `achNocCode`. The row's `addenda` is not kept, because
  it carries corrected account details, and we hold none. Nothing needs
  correcting on our side: every debit is authorized fresh through Bank Connect.
- **Paging, fixed.** The sweep read page one only. `finagy.queryAllReturns()`
  follows the cursor to `null`. It stops if a cursor repeats (the loop above)
  or after 20 pages. When a report is cut short, the poll summary says so under
  `errors` (scope `returns`) instead of going quiet.
- **Status 40.** A pending order whose debit reads 40 means it was refunded in
  Finagy's portal before our poller saw it settle. That order is now cancelled,
  and its stock and points are released. Before, `unknown` read as "still
  moving", so it held stock and was polled forever. The admin refund endpoint
  now reports `refunded` on a 40, not `unknown`.

Verified against real staging with the changed driver: 40 → `refunded`, credit →
`sent_to_bank`, `queryAllReturns` → complete, 1 row (R01, not a NOC). 466/466
server tests pass.

### 1i. Also still open

| # | Question | Why it matters |
|---|---|---|
| 1 | **Statement descriptor** — what the buyer sees on their bank statement. | An unrecognised descriptor is the #1 cause of R10 ("I didn't authorize this") returns; NACHA polices those at 0.5%. |
| 2 | **Bank cutoff time** and whether same-day ACH is on. | Files sent before 2pm ET settle the same night. Decides how fast orders clear. |
| 3 | **Production credentials**, once the test sheet is signed off. | |
| 4 | **Refund credit → original debit.** The credit has `uniqueTranId: null`. Can it carry our reference, or is there a field linking it to the debit? (Not answered.) | A credit with no reference cannot be matched to an order by anything automatic. |
| 5 | **querysettlements paging with `excludeReturnedItems: false`** never reaches `null` (reported, see 1h). | Anyone who pages that report naively loops forever. We don't call it. |
| 6 | **Legal name on the production record** — staging reads "Ever NovA Life". | Sandbox data per Finagy; worth one check that production is right. |

Not needed: SFTP credentials and PGP keys — that is the flat-file batch
product; we use the REST API and the HPP.

### 1j. Every certification case is now something the site does — 2026-09-12

The test sheet was answered with API calls run by hand. SALE-03 to SALE-10 are
now real features of the site, in **admin.html → Bank (ACH)** and on every bank
order row in **Orders**:

| Case | Where it lives |
|---|---|
| SALE-03 status | **Check with Finagy** on any bank order → `POST /api/admin/ach/:orderId/sync`. The only way a refund made in Finagy's portal (status 40) or a return reaches a PAID order, because the poller only re-reads unpaid ones. |
| SALE-04..07 void / refund | **Void** (unpaid) / **Refund** (paid) → `POST /api/admin/ach/:orderId/refund`. The server reads the live status and picks void at 2, refund at 16, and refuses anything else. A refund now stores the credit's id as `achRefundTransactionId`: the credit carries `uniqueTranId: null`, so that id is the only link back to the order. |
| SALE-08/09/10 reports | **Bank (ACH)** view → `GET /api/admin/ach/reports?start=&end=` (≤ 93 days). Reads settlements (`excludeReturnedItems: true`, the setting under which that report ends), returns and reserves to their last page. Each row is tied to its order, including refund credits. Returns are labelled by `tranStatus`, reserves show the balance. KPIs: settled in, refunded out, returned, reserve held, waiting on the bank. Also **Run the poller now**. The nav badge counts bank orders still unsettled after 7 days, which usually means the cron ping is not running. |

**Bugs found while building it — all fixed, all tested:**

1. **Zelle buttons on bank orders.** The Orders view offered *Mark paid* and
   *Cancel* on a pending ACH order, and neither route checked the method.
   *Mark paid* shipped against a debit that had not settled. *Cancel* closed the
   order while Finagy still debited the buyer. Now `/api/admin/orders/:id/paid`
   refuses ACH (409). `/cancel` asks Finagy first and refuses while the debit is
   live (2/4/16), sending staff to Void / refund. Cancelling is still allowed when
   Finagy never received the order. Bank rows get their own buttons.
2. **A shipped order went back to `paid`.** `syncAchOrder` marked any settled
   order paid "unless it already says paid", and `/api/ach/confirm` runs it for
   the buyer at any time. A buyer re-confirming a SHIPPED order put it back into
   the To-ship queue and credited the loyalty points again. Now only an order
   still waiting on money can become paid.
3. **Late returns on shipped orders were skipped.** The returns sweep only looked
   at `paid`/`pending`/`awaiting_payment`, so a return after the parcel left went
   unflagged. `shipped`/`delivered` are now handled as late returns (flagged, no
   restock). The same rule applies in `syncAchOrder`: a return on anything we
   counted as a sale is late.

Verified end to end on 2026-09-12 against real staging, not just the stub. I ran
the real server on localhost with email, BTCPay and cron turned off and a
throwaway data dir, and drove admin.html in headless Chrome. Real transactions
landed correctly: 16 → paid, 40 → cancelled/refunded, 8 R01 → returned. The
reports tied all three rows to their orders, and the page did not scroll
sideways at 400px. Void/Refund were deliberately NOT pressed, because that would
alter Finagy's certification transactions. 478/478 server tests pass.

### 2. Environment variables

Set on Render (see `DEPLOY-RENDER.md`):

Finagy issues an account with **both** a numeric *Merchant User* and a named
*Username*, and their `Basic base64(UserID:APIKey)` example uses a bare number —
so which one belongs in the pair is ambiguous from the paperwork. They also send
a pre-computed **Basic Token Header**. Prefer it: it cannot be assembled wrongly.

```
FINAGY_BASIC_TOKEN=…        the Basic Token Header Finagy sent, verbatim
                            (a leading "Basic " is tolerated). Takes precedence.

# …or the parts, if only those are to hand:
FINAGY_USER_ID=…            the Merchant User (e.g. 251)
FINAGY_API_KEY=…            the API key Finagy issued
FINAGY_BASE_URL=https://token-staging.finagy.com    # production: https://token.finagy.com
FINAGY_CLIENT_NAME=Ever Nova Life                   # max 16 chars, shown on their page
FINAGY_SEC_CODE=WEB                                 # do not change without asking Finagy
FINAGY_PAYMENT_METHOD=1                             # 1 = ACH, confirmed by Finagy
ACH_ABANDON_HOURS=6                                 # release stock on an unstarted payment
SITE_URL=https://evernovalife.com                   # required — Finagy redirects here
```

`FINAGY_BASE_URL` **defaults to staging**. Production has to be asked for by
name. While it points anywhere but `token.finagy.com`, `/api/health` reports
`achSandbox: true` and the checkout shows a "Test mode" note under the button.

### 3. Schedule the poller

`POST /api/ach/poll` with header `x-cron-key: <CRON_KEY>`.

**Every 30 minutes is plenty** — ACH moves in days, not seconds. Use the same
scheduler as `/api/outreach/run` and `/api/subscriptions/run-due`.

```
curl -s -X POST https://evernova-api.onrender.com/api/ach/poll \
  -H "x-cron-key: $CRON_KEY"
```

It answers `{ checked, paid, returned, cancelled, unchanged, errors }`. An admin
token works too — **Run the poller now** in admin.html → Bank (ACH) is that call.

### 4. Verify before taking real money

1. Open admin.html → **Bank (ACH)** (or `GET /api/admin/ach`) — it mints a
   token against Finagy and says which environment you are pointed at, whether
   the credentials are accepted and whether `CRON_KEY` is set.
2. Place a sandbox order end to end, signing in on Ribbit with the **chime**
   sandbox account (see 1e). Any other bank in their sandbox declines.
3. Confirm the order sits at `pending` after the redirect — **it must not say
   paid**.
4. Ask Finagy to settle the test transaction, run the poller, confirm the order
   flips to `paid` and the buyer gets the "payment cleared" email.
5. Only then switch `FINAGY_BASE_URL` to production and repeat once with a real,
   small order against your own bank account.

---

## How it works

```
buyer clicks "Pay from a bank account"
        │
        ▼
POST /api/ach/checkout          server prices the cart, holds stock + points,
        │                       opens the order `pending`, mints a 5-minute
        │                       Finagy session key
        ▼
redirectToFinagyHostedPage()    Finagy's page. Routing and account numbers are
        │                       typed there and NEVER touch our servers.
        ▼
GET /checkout.html?paid=ach     unsigned redirect. Believed for exactly one
        │                       thing: Finagy's payment_id.
        ▼
POST /api/ach/confirm           stores that id, then asks Finagy what is true.
        │
        ▼
POST /api/ach/poll  (cron)      every 30 min, until the ladder ends
```

### The status ladder

Finagy's numeric `status` (p.64), and what we do with it:

| Code | Finagy | Our order becomes | Stock / points |
|---|---|---|---|
| 0 | not found | stays `pending`; `cancelled` after `ACH_ABANDON_HOURS` | released on abandon |
| 1 | invalidated | `cancelled` | released |
| 2 | pending | `pending` | held |
| 4 | sent to bank | `pending` | held |
| 8 | returned | `returned` | released |
| 16 | **settled** | **`paid`** | kept — this is the sale |
| 24 | late return | `returned` + `achLateReturn` | **not** released — see below |
| 32 | voided | `cancelled` | released |
| 40 | refunded — a settled debit after its refund (not in the spec; Finagy, 2026-09-11) | `cancelled` if it was never marked paid | released (only when never paid) |

**Only 16 pays an order. Nothing ships before it.** And only an order still
waiting on money (`pending` / `awaiting_payment`) can become paid. A settled
debit never pulls a shipped or cancelled order back to `paid`. A return on
anything already counted as a sale (`paid` / `shipped` / `delivered`) is a late
return, whatever the code says.

The returns report has its own, separate `tranStatus` scale (1 = had settled,
debited back next business day · 2 = returned before it settled · 3 = Notification
of Change, information only). A NOC never changes an order — see 1h.

### Late returns are the dangerous one

Status 24 means the payment settled — we counted it, possibly packed and shipped
it — and then the bank pulled the money back out, up to 60 days later. Releasing
stock there would invent inventory that is physically inside a courier's van, so
the code deliberately does *not*. It flags the order, emails the owner with
`LATE ACH RETURN` in the subject, and leaves the count for a human.

### Common return codes

`R01` insufficient funds · `R02` account closed · `R03` account not found ·
`R08` stop payment · **`R10` "I didn't authorize this"**.

R10 is the one to watch. A rising R10 rate is usually a statement descriptor
buyers don't recognise (question 8 above), and NACHA polices unauthorized-return
rates at 0.5%.

---

## What lives where

| File | What it does |
|---|---|
| `server/finagy.js` | The gateway client. Token, session key, retrieve, void, refund, and the three reports — settlements, returns, reserves — each read to its last page (`readAllPages`). `returnKind()` / `isNotificationOfChange()` name a return row. |
| `server/server.js` | `/api/ach/checkout`, `/api/ach/confirm`, `/api/ach/poll`, `/api/admin/ach`, `/api/admin/ach/:orderId/refund`, `/api/admin/ach/:orderId/sync`, `/api/admin/ach/reports`, and `syncAchOrder()` — the one place an ACH order's fate is decided. |
| `js/admin-console.js` | The **Bank (ACH)** view (connection, poller, reports) and the bank-order buttons in Orders (Check with Finagy, Void, Refund). |
| `server/test/ach.test.js` | Stubs Finagy on localhost, paging every report the way staging does, and runs the whole ladder. Notably asserts the redirect **cannot** mark an order paid, and neither can an admin by hand. |
| `js/main.js` | `submitAchOrder`, `handleAchReturn`, the on-demand load of Finagy's browser library. |
| `checkout.html` | The bank button, and the web-order-authorization text. |
| `terms.html` §13 | The ACH debit authorization the buyer agrees to. |

### Order fields this adds

`achStatus` · `achStatusCode` · `achSessionKey` · `achOpenedAt` ·
`achReturnedAt` · `achCheckedAt` · `achSettledAt` · `achReturnCode` ·
`achLateReturn` · `achSandbox` · `transactionId` (Finagy's `authorizationId`) ·
`achNocCode` / `achNocAt` (a notification of change, information only) ·
`achRefundTransactionId` (the credit a refund raised) · `refundedAt` / `refundedBy`

---

## Deliberate limits

- **No auto-ship on ACH.** A repeating bank debit needs its own recurring NACHA
  authorization (`WebType: R`) and different consent copy at checkout. The bank
  button hides itself when auto-ship is ticked. Finagy's HPP returns a
  `merchant_token` that would make this possible later — it is a feature, not a
  bug fix.
- **No partial refunds.** Finagy's `refund` raises a credit for the *full*
  original amount and nothing less. A partial has to be a manual credit through
  their portal.
- **Void vs refund is not a choice.** Void only works the same day before the
  bank cutoff; refund only works after the debit has gone. `/api/admin/ach/:orderId/refund`
  picks whichever is possible and tells you which it did.
- **Every order has an account behind it — without a sign-in wall.** AllayPay's
  underwriting requires the account, not the friction, so since 2026-09-09 the
  three checkout routes run on `optionalAuth` and `resolveCheckoutBuyer()`
  (server.js) opens an account from the email on the form. Nothing else is
  granted by typing an address: no session token is issued, loyalty points are
  unspendable and auto-ship is unavailable unless the request is genuinely
  signed in. The buyer gets a "set a password" link by email, and the order is
  flagged `guestCheckout: true` so the admin queue can still tell the two
  apart. A signed-out browser proves an ACH order is its own with the
  `payToken` handed back by `/api/ach/checkout` — the same HMAC scheme as the
  resume link — because it has no session to prove it with at `/api/ach/confirm`.

---

## Compliance notes

The web order authorization (checkout.html `#webAuthText`, version
`2026-09-08`) previously promised *"no amount is debited or withdrawn from any
account of mine"* — true of crypto and Zelle, and the exact opposite of what a
bank debit does. It now carries an explicit one-time ACH debit authorization,
because NACHA requires the debit to be authorized **in the text the buyer
agrees to**, not implied by the button they press.

`WEB_AUTH_VERSION` in `js/main.js` must be bumped whenever that wording changes
— the version is stored per order and is the record we would rely on if a
transaction were ever disputed.
