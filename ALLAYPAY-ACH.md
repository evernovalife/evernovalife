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

### 1f. Still open with Finagy

| # | Question | Why it matters |
|---|---|---|
| 1 | **Statement descriptor** — what the buyer sees on their bank statement. | An unrecognised descriptor is the #1 cause of R10 ("I didn't authorize this") returns; NACHA polices those at 0.5%. |
| 2 | **Bank cutoff time** and whether same-day ACH is on. | Files sent before 2pm ET settle the same night. Decides how fast orders clear. |
| 3 | **The testing script** they sign off against. | Required before production is enabled. |
| 4 | **Production credentials**, once testing is signed off. | |

Not needed: SFTP credentials and PGP keys — that is the flat-file batch
product; we use the REST API and the HPP.

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
token works too, which is how you test it by hand.

### 4. Verify before taking real money

1. `GET /api/admin/ach` as an admin — it mints a token against Finagy and
   reports `ok`, plus which environment you are pointed at.
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

**Only 16 pays an order. Nothing ships before it.**

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
| `server/finagy.js` | The gateway client. Token, session key, retrieve, settlements, returns, void, refund. |
| `server/server.js` | `/api/ach/checkout`, `/api/ach/confirm`, `/api/ach/poll`, `/api/admin/ach`, `/api/admin/ach/:orderId/refund`, and `syncAchOrder()` — the one place an ACH order's fate is decided. |
| `server/test/ach.test.js` | Stubs Finagy on localhost and runs the whole ladder. Notably asserts the redirect **cannot** mark an order paid. |
| `js/main.js` | `submitAchOrder`, `handleAchReturn`, the on-demand load of Finagy's browser library. |
| `checkout.html` | The bank button, and the web-order-authorization text. |
| `terms.html` §13 | The ACH debit authorization the buyer agrees to. |

### Order fields this adds

`achStatus` · `achStatusCode` · `achSessionKey` · `achOpenedAt` ·
`achReturnedAt` · `achCheckedAt` · `achSettledAt` · `achReturnCode` ·
`achLateReturn` · `achSandbox` · `transactionId` (Finagy's `authorizationId`)

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
- **Guest checkout is already impossible** site-wide — every checkout route sits
  behind `requireAuth`.

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
