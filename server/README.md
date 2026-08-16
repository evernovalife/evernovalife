# Ever Nova Life — payment backend

Real payments for the Ever Nova Life store. Two methods, **no card processor**:

- **Bitcoin / Lightning** via a self-hosted **BTCPay Server** — the primary method
- **Zelle** bank transfer — manual, confirmed by hand in `admin.html`

Both share one rule: this server **recomputes prices from the product catalog**,
so the amount owed can never be altered from the browser. Both also confirm
*after* the order is created — there is no card-style synchronous capture, so
every order starts unpaid and is settled by a webhook (crypto) or by the owner
(Zelle).

```
Browser (checkout.html)
   │  POST /api/crypto/checkout   ── server prices the cart + opens a BTCPay invoice
   │  ◄ { checkoutLink }
   │  redirect → hosted BTCPay checkout
   ▼
BTCPay Server ── POST /api/crypto/webhook (signed) ──► order marked paid
```

> **Why no cards?** Card processing was removed deliberately. See
> *A note on this product category* near the end of this file — high-risk
> classification made a card gateway a liability rather than an asset.

## 1. Configure

```bash
cd server
cp .env.example .env      # then edit .env
```

The essentials:

| Variable            | What to put                                              |
|---------------------|----------------------------------------------------------|
| `BTCPAY_*`          | Your BTCPay instance — see the crypto section below       |
| `CURRENCY`          | `USD` (what prices and invoices are denominated in)       |
| `PORT`              | API port (default `4242`)                                 |
| `ALLOWED_ORIGINS`   | `*` for local dev; your real origin in production         |
| `JWT_SECRET`        | Long random string — accounts are required to check out   |

## 2. Run

```bash
cd server
npm install
npm start
```

You'll see:

```
Ever Nova Life payment server
  crypto: BTCPay ready → https://pay.example.com
  zelle:  not configured (set ZELLE_RECIPIENT + ZELLE_NAME in .env)
  auth:   accounts ready
  api:    http://localhost:4242/api
```

The server also serves the static site, so open **http://localhost:4242/checkout.html**
— same origin means `window.PEPTIDE_API_BASE` can stay `""`.

## 3. Go live

1. Point `BTCPAY_*` at your production BTCPay store and register the webhook
   (below). `GET /api/health` must report `"crypto": true`.
2. Set `ALLOWED_ORIGINS` to your real site origin (e.g. `https://evernovalife.com`).
3. If the site is hosted separately from this API, set
   `window.PEPTIDE_API_BASE` in `js/config.js` to the API origin, and make sure
   that origin is in `ALLOWED_ORIGINS`.
4. Serve everything over **HTTPS**.
5. Set `CRON_KEY` and point an external scheduler at
   `POST /api/subscriptions/run-due` so auto-ship invoices go out.

## Endpoints

| Method | Path                   | Purpose                                          |
|--------|------------------------|--------------------------------------------------|
| POST   | `/api/crypto/checkout` | Price the cart + open a BTCPay crypto invoice    |
| POST   | `/api/crypto/webhook`  | BTCPay → us: invoice state changes (signed)      |
| POST   | `/api/zelle/checkout`  | Price the cart + open an unpaid Zelle order      |
| GET    | `/api/orders/:id/balance` | What a short-paid order still owes (signed `?t=` link, no sign-in) |
| POST   | `/api/orders/:id/balance/invoice` | Open a fresh crypto invoice for that difference |
| POST   | `/api/admin/orders/:id/pay-link` | Admin: re-email the buyer their pay-the-rest link |
| POST   | `/api/admin/orders/:id/collect-balance` | Admin: record what really arrived and re-open the order for the rest |
| GET    | `/api/admin/orders`    | Admin: all orders (`?status=awaiting_payment`)   |
| POST   | `/api/admin/orders/:id/paid`   | Admin: confirm a manual payment landed   |
| POST   | `/api/admin/orders/:id/cancel` | Admin: cancel an order that was never paid |
| POST   | `/api/admin/orders/:id/shipped` | Admin: record the shipment (carrier + tracking) and email the customer |
| GET    | `/api/shipping`        | Delivery methods offered at checkout (admins also see disabled ones) |
| POST   | `/api/shipping`        | Admin: add or edit a delivery method |
| DELETE | `/api/shipping/:id`    | Admin: remove a delivery method |
| POST   | `/api/admin/orders/:orderId/reconcile` | Rebuild an order's payment ledger from BTCPay |
| GET    | `/api/admin/label-design` | Admin: the shipping-label design (+ the size list) |
| PUT    | `/api/admin/label-design` | Admin: save the label design (merged onto what's stored) |
| POST   | `/api/admin/label-design/reset` | Admin: back to the default label |
| POST   | `/api/auth/register`   | Create an account (bcrypt) → returns a JWT       |
| POST   | `/api/auth/login`      | Verify email + password → returns a JWT          |
| GET    | `/api/auth/me`         | Current user (needs `Authorization: Bearer …`)   |
| GET    | `/api/health`          | Liveness + which methods are configured          |

## Crypto payments — Bitcoin / Lightning (BTCPay Server)

The store's primary payment method. The buyer clicks **Pay with Bitcoin /
Lightning**, we price the cart server-side, open a **hosted BTCPay invoice**, and
redirect them to it. BTCPay is **non-custodial** — funds settle straight to the
wallet connected in your BTCPay store; this server never touches the money, and
there are **no processing fees** (against the 5–8% high-risk card rates this
product category attracts).

```
Browser (checkout.html)
   │  POST /api/crypto/checkout   ── server prices the cart + opens a BTCPay invoice
   │  ◄ { checkoutLink }
   │  redirect → hosted BTCPay checkout (buyer pays on-chain or via Lightning)
   │  BTCPay → POST /api/crypto/webhook   (signed; invoice state changes)
   ▼  redirect back → checkout.html?paid=crypto  (confirmation)
```

### Set up (you already have a BTCPay instance)

1. **API key** — BTCPay → *Account → Manage Account → API Keys → Generate*. Grant
   `btcpay.store.cancreateinvoice` (scoped to your store is fine). Put it in
   `BTCPAY_API_KEY`.
2. **Store id** — BTCPay → *Store Settings* (also in the store URL). Put it in
   `BTCPAY_STORE_ID`.
3. **Instance URL** — e.g. `https://btcpay.evernovalife.com` → `BTCPAY_URL`
   (no trailing slash).
4. **Webhook** — BTCPay → *Store → Settings → Webhooks → Create*. Payload URL:
   `https://<this-api>/api/crypto/webhook`. Copy the generated secret into
   `BTCPAY_WEBHOOK_SECRET`. (Unsigned/unverifiable webhook calls are rejected.)
5. Restart the server. `GET /api/health` should now show `"crypto": true`, and
   the startup log prints `crypto: BTCPay ready → <url>`.

`POST /api/crypto/checkout` body:

```json
{
  "items":   [{ "id": 1, "quantity": 2 }],
  "shipping":{ "name": "...", "address": "...", "city": "...",
               "state": "...", "postalCode": "...", "countryCode": "US" },
  "email":   "you@lab.com",
  "pointsToRedeem": 500,
  "autoship": { "enabled": true, "intervalDays": 30 }
}
```

The order id + full price breakdown + ship-to are stored in the invoice
`metadata`, so you can reconcile and ship right from the BTCPay invoice screen
as well as from `admin.html`.

**Order lifecycle.** The order is recorded as `pending` when the invoice opens,
and the buyer is emailed the pay link (a BTCPay invoice expires in minutes, and
the checkout tab is otherwise the only copy of it). `/api/crypto/webhook` then
verifies the signature and acts on the state:

| BTCPay event | Order becomes | Who is told |
|---|---|---|
| `InvoiceSettled` | `paid` — points earned, referral rewards granted | buyer ("payment received"), you ("PAID — ship it") |
| `InvoiceExpired` / `InvoiceInvalid`, nothing paid | `cancelled` — held points returned, stock released | buyer ("expired, nothing was charged") |
| `InvoiceExpired` / `InvoiceInvalid`, **money against it** | `underpaid` — stock and points stay held, and it can never ship in this state | buyer ("your payment came in short"), you (action needed) |

That last row is the one that bites. **An expired invoice is not the same as an
unpaid one:** BTCPay expires an invoice that was underpaid or paid too late, and
those coins are already in your wallet. Such an order is parked at `underpaid`,
where it can never ship, and the buyer is handed a way to finish it.

### Paying off a short payment

A buyer who sends too little used to be stuck: the invoice they underpaid is
expired, BTCPay will not reopen it, and the only route to finishing the order
was an email thread with a human. So the shortfall now comes with its own way
out.

Every short-paid order carries a permanent link — `pay.html?order=…&t=…` — and
the buyer is emailed it automatically the moment the shortfall is detected. The
link **mints a fresh BTCPay invoice for exactly the outstanding amount each
time it is opened**, which is the point: a checkout link is only payable inside
its own window, so any link that sits in an inbox is dead by the time someone
taps it. This page isn't; it's the thing that stays valid.

- The token is an HMAC of the order reference under `JWT_SECRET` — nothing is
  stored, so orders raised long before this existed get a working link too. It
  unlocks exactly one order, and only to read the balance and invoice it.
- Payments are recorded **per invoice** on the order (`payments`), and
  `paidAmount` is their sum. An order paid across two invoices reaches its
  total instead of the second payment overwriting the first.
- When the top-up settles, the order marks itself `paid` and moves into
  **To ship** with no admin involvement. If the top-up is *itself* short, the
  amounts add up and the buyer gets a fresh link for what's left.
- The buyer's account page shows the same button on the order row.

Three admin actions cover what automation can't reach, all in `admin.html`:

- **Orders → Email pay link** — re-sends that email. For the buyer who deleted
  it.
- **Reconcile** — rebuilds the order's ledger from BTCPay. See below.
- **BTCPay → Collect the rest** — for an order **already marked paid** against
  a partial payment. That case has no disagreement left for anything automatic
  to notice: the store says paid, BTCPay says PaidPartial, and the goods would
  ship for part of the price. You type what actually arrived (BTCPay's figure
  is pre-filled), the order re-opens at the difference, and the buyer is
  emailed the link. It refuses an order that has already shipped.

One case is deliberately left to a human: when BTCPay flags a partial payment
but won't say how much (no invoice id on the event), the balance is unknowable.
No link is offered and no amount is billed — charging the full total there
would take the buyer's money twice. The order says so, and the alert asks you
to settle it by hand.

### Reconcile — when one order was billed twice

`payments` keyed by invoice only helps if every invoice got recorded. Orders
raised before that ledger existed have a flat `paidAmount` holding whichever
webhook landed last, and if a shortfall was never written down, the *next*
invoice for that order was raised for the **full total** rather than the
difference. The result is two live invoices each demanding everything, part
paid on each, and a store that believes the buyer sent less than they did — so
the balance link asks them for coins already in the wallet.

**Orders → Reconcile** (also on the BTCPay panel, which is where the duplicate
becomes visible) asks the payment processor instead of trusting the stored
figure:

    POST /api/admin/orders/:orderId/reconcile
    { dryRun?: true, invoiceIds?: [...], force?: true }

It finds every invoice tagged with the order — the ids the order remembers,
plus a sweep of the last 100 in BTCPay — reads what actually settled on each
from the per-method detail (crypto received × the locked rate, the same two
numbers the invoice page shows), and **replaces** `payments` with one line per
invoice. The stored total becomes their sum, and the status follows: full
means `paid` (points credited on the first transition only), short means
`underpaid`, nothing received leaves it alone.

- The admin console always previews first — you approve the corrected numbers
  before they're written.
- Reaching further back than the sweep window: pass `invoiceIds` explicitly.
- An invoice carrying a **different** order's reference is refused outright,
  not skipped. Crediting one buyer's coins to another buyer's order is worse
  than the bug being fixed.
- If any invoice's paid amount can't be read, the commit is **blocked** (409)
  rather than booking a total that is only a floor — understating it is what
  re-bills a paying customer. `force: true` books what could be read.
- A `shipped` or `delivered` order has its ledger corrected but its status left
  alone; a parcel already gone doesn't go back in the packing queue.
- Re-opening a cancelled order as `underpaid` does **not** re-reserve its stock
  or points — it isn't owed goods until the balance lands.

**The shortfall is also made rarer at the source.** Every invoice this server
raises now carries its own checkout settings, so they can't be lost to a store
setting nobody remembered to change (all overridable in `server/.env`):

| | default | why |
|---|---|---|
| `BTCPAY_EXPIRY_MINUTES` | 60 | BTCPay's own default is 15, which is not enough time to open a wallet or move coin off an exchange — and an invoice that dies mid-payment banks whatever arrived as a partial |
| `BTCPAY_MONITORING_MINUTES` | 1440 | a late payment is still *seen* after the window closes, instead of landing in the wallet attached to nothing |
| `BTCPAY_PAYMENT_TOLERANCE` | 1% | wallet-fee dust settles instead of parking a real order. For dust only — a real shortfall still parks |
| `BTCPAY_SPEED_POLICY` | `MediumSpeed` | 1 confirmation before settled |
| `BTCPAY_DEFAULT_METHOD` | `BTC-LN` | which tab opens first. Lightning, because it's the rail that can't be underpaid — but the buyer can still switch |
| `BTCPAY_PAYMENT_METHODS` | *(empty)* | pins which rails are offered at all. Empty = both |

**Going Lightning-only.** Setting `BTCPAY_PAYMENT_METHODS=BTC-LN` makes partial
payment *structurally* impossible: a Lightning invoice is for a fixed amount and
the payer has no field to type a smaller one in. It is also the one change here
that can lose you sales — every buyer whose wallet or exchange can't send over
Lightning is turned away, and a few-hundred-dollar payment is much harder to
route than a small one. The store's own short-paying customer sends on-chain, so
this setting would have blocked him from buying at all rather than making him
pay in full. Left empty on purpose.

And one store *wallet* setting that only you can fix: the checkout is labelled **Bitcoin / Lightning**
throughout the site, so a Lightning node has to actually be connected in BTCPay
(Store → Lightning). With on-chain as the only method, every buyer is subject to
mempool timing inside that expiry window — check an invoice's `paymentMethods`:
`["BTC-CHAIN"]` alone means Lightning is off.

> Volatility tip: set your BTCPay store to auto-convert or settle in a
> stablecoin if you don't want to hold BTC.

**Shipping fees are data, not code.** `server/shipping.js` holds the delivery
methods (name, fee, delivery estimate, free-over threshold, offered yes/no) on
the DATA_DIR disk, seeded once with the three rates the site has always
published — Standard $9.99 free over $100 enabled, Expedited $19.99 and
Overnight $34.99 **disabled**, since those cost real money to honour and are the
owner's call to switch on. Edit them in **admin.html → Shipping rates**; the
change applies to the next checkout with no deploy.

The browser sends a method **id**, never a fee: `pricing.js` looks up what that
method costs, so a tampered client can at worst pick a cheaper service the store
already offers. An unknown or since-disabled id falls back to the cheapest
enabled method rather than failing a checkout. Checkout is never left with
nothing to charge — the last enabled method can't be disabled or deleted. The
public table on `shipping.html` renders from the same list, so it can't advertise
a rate the checkout doesn't charge.

**Full payment or nothing.** A short payment never becomes a sale on its own,
and `/api/admin/orders/:id/shipped` refuses an `underpaid` order outright. The
buyer collects themselves through the pay link above; if they'd rather have
their coins back, "Cancel & refund" releases the stock and the held points, and
the refund itself is a send from your wallet.

**Shipping.** A paid order lands in **admin.html → To ship**: one card per
parcel with the address, the items and a printable packing slip (no prices on
it). Recording carrier + tracking marks it `shipped` and emails the customer;
re-posting corrects a mistyped number without emailing again.

**Is the webhook actually connected?** `GET /api/admin/btcpay/webhooks` (and the
Webhook card in admin.html → BTCPay) lists what BTCPay has registered, whether
one points at this server, whether it covers `InvoiceSettled`, and how the last
20 deliveries went. Nothing confirms automatically without it, and it fails
silently — a store with a dead webhook looks exactly like a store with no
customers. Listing webhooks needs `btcpay.store.webhooks.canmodifywebhooks` on
the API key (BTCPay has no read-only variant).

**Notifications need both `SMTP_USER`/`SMTP_PASS` and `ADMIN_EMAIL`.** Without
the first, buyers get no pay link and no receipt; without the second, *you* are
never told an order happened. `GET /api/health` reports both (`email`,
`ownerAlerts`), the admin dashboard warns when either is off, and
`GET /api/admin/email-test` names the inbox owner alerts are going to.

## Zelle — manual bank transfer (US only)

Zelle has **no merchant API**: no charge to create, nothing to redirect to, and
no webhook to tell us the money arrived. So this is an offline payment with an
online paper trail — the buyer sends the transfer from their own banking app,
and **you** confirm it landed. Fees: none, either side.

```
Browser (checkout.html)
   │  POST /api/zelle/checkout   ── server prices the cart, opens the order
   │  ◄ { orderId, instructions } status = awaiting_payment   (nothing charged)
   │  buyer sends the transfer themselves, memo = orderId
   ▼
You (admin.html → "Payments to Confirm")
   │  see the memo in your bank → press "Mark paid"
   ▼  POST /api/admin/orders/:id/paid → order paid, points credited, buyer emailed
```

### Set up

1. Enrol with Zelle **as a business** through your bank (see the warning below),
   and note the email address or US mobile number buyers will send to.
2. Put it in `ZELLE_RECIPIENT`, and the name buyers will see in their banking app
   in `ZELLE_NAME`. Optionally `ZELLE_BANK`, `ZELLE_WINDOW_HOURS` (hold time,
   default 24) and `ZELLE_MAX_TOTAL` (refuse orders above a bank's daily send
   limit).
3. Restart. `GET /api/health` shows `"zelle": true`, the startup log prints
   `zelle: ready → …`, and the option appears at checkout. Leave the variables
   blank and the option simply never shows.

### Things worth knowing before switching it on

- **Use a business enrolment.** Consumer Zelle terms don't cover paying for goods
  and services. Most banks offer Zelle for Small Business; use that.
- **Nothing ships until you confirm.** An order sits at `awaiting_payment` — it is
  a claim, not a payment. Only "Mark paid" credits points, emails the buyer, and
  releases it.
- **Confirm against your bank, not the buyer's word.** A screenshot is not money.
  Confirming is idempotent, so a double-click can't double-credit points.
- **There is no chargeback, in either direction.** Money that arrives is yours;
  money that never arrives is simply an order to cancel. Refunds are a transfer
  you send back by hand.
- **Points redemption and auto-ship are hidden for Zelle** — there's no invoice of
  ours to discount, and no way to schedule a repeat around a manual transfer.
  Both live on the crypto path.
- **US only.** Non-US shipping addresses are refused at `/api/zelle/checkout`
  before an order is created.

`POST /api/zelle/checkout` body (same shape as the others):

```json
{
  "items":   [{ "id": 1, "quantity": 2 }],
  "shipping":{ "firstName": "...", "lastName": "...", "address": "...",
               "city": "...", "state": "...", "postalCode": "...", "country": "US" },
  "email":   "you@lab.com"
}
```

Guest Zelle orders are stored too (under a reserved `__guest__` key), otherwise a
transfer could arrive with a reference matching nothing.

## Accounts — sign in / sign up

Real email + password accounts power `login.html`, `register.html`, and
`account.html`. Passwords are **bcrypt-hashed**; on register/login the server
returns a signed **JWT** which the browser stores and sends back as
`Authorization: Bearer <token>`. Users persist to a small JSON store at
`server/data/users.json` (git-ignored, created automatically) — no database or
native build step. The store lives behind load/save helpers in `auth.js`, so you
can swap it for Postgres/SQLite later without touching the routes.

### Set up

1. Add a signing secret to `.env` (already scaffolded in `.env.example`):
   ```
   JWT_SECRET=<long random string>
   JWT_TTL=30d
   ```
   Generate one with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
   If `JWT_SECRET` is blank the server still runs but uses a **random per-restart**
   secret (fine for local dev; every login breaks when it restarts). Always set it
   in production.
2. Restart the server. The startup log shows `auth: accounts ready`, and
   `GET /api/health` reports `"auth": true`.

`POST /api/auth/register` body → `201 { success, user, token }`:

```json
{ "firstName": "Jane", "lastName": "Doe", "email": "you@lab.com", "password": "at-least-8-chars" }
```

`POST /api/auth/login` body → `200 { success, user, token }`:

```json
{ "email": "you@lab.com", "password": "at-least-8-chars" }
```

Errors are JSON `{ "error": "…" }` with a matching status: `409` duplicate email,
`401` wrong credentials, `400` validation (bad email / password &lt; 8 chars).

> **Cross-origin note:** if the site and this API are on different hosts, set
> `window.PEPTIDE_API_BASE` to the API origin (same knob `checkout.html` uses) and
> add that site origin to `ALLOWED_ORIGINS`. Tokens travel in the `Authorization`
> header (not cookies), so there are no SameSite/cookie hoops.

> **Hardening for production:** serve over HTTPS (tokens are bearer credentials),
> and consider adding password-reset + email verification when you wire up an
> email provider. The account page's orders/stats are still placeholder demo data
> until an order database exists.

## Changing a price (read this before editing prices)

The catalog has **two layers**, and only one of them is live:

| Layer | File | Role |
|---|---|---|
| Seed | `js/products-data.js` | the built-in catalog, in git |
| Store | `products.json` on `DATA_DIR` | what the shop actually reads and charges |

The store is written **once**, on a server's first run. After that, editing the
seed changes nothing on a running site — `/api/products` and `pricing.js` both
read the store, so the shop keeps the old price and the edit looks applied.

Two ways to change a price, both fine:

1. **In the admin UI** — `admin-products.html` → edit → save. Live immediately,
   no deploy. Best for one-off changes.
2. **In the seed** — edit `js/products-data.js`, then **bump `SEED_SYNC_VERSION`
   in `server/products.js`** and deploy. On the next read the seed's `price` and
   `originalPrice` are re-applied to the built-in products *once*, and the
   version applied is recorded in `products.sync.json` beside the store. Without
   the bump, nothing happens. With it, the change is logged:
   `[products] seed sync v2 · #3 GHK-Cu · price: 39.99 → 85`.

Products an admin **added** are never touched by the sync, and a price an admin
sets *after* a sync survives — the version has to move again to override it.

## Stock counts

A product may carry `stockQty`, a live unit count. It is **optional and
tri-state**, so nothing changes until a number is actually entered:

| `stockQty` | Meaning |
|---|---|
| absent / `null` | **untracked** — unlimited. Availability is the `inStock` switch alone (how the whole catalog behaved before counts existed). |
| `0` | tracked and sold out — refused at checkout. |
| `n > 0` | tracked; `n` units left. |

`inStock` stays the master switch: turning it off withdraws a product from sale
with its count untouched, waiting. Availability needs **both**.

**Setting it** — `admin-products.html`. Every row has the count inline (type a
number, Save or press Enter); the add/edit form has the same field. Blank means
untracked. The inline control is its own endpoint so changing a number doesn't
re-upload the product's image:

```
PATCH /api/products/:id/stock     { "stockQty": 12 }   → set
PATCH /api/products/:id/stock     { "stockQty": null } → stop tracking
```

**When the count moves.** Stock is taken when an order is **opened**, not when
it is paid, and given back if the order dies unpaid — the same hold/release
shape as the loyalty points, and for the same reason: every payment method here
confirms later (a BTCPay invoice the buyer still has to fund, a Zelle transfer
that arrives by hand), so counting down only on settlement would promise the
last vial to several buyers at once.

| Event | Effect |
|---|---|
| crypto / Zelle checkout, auto-ship invoice | units reserved (decremented) |
| BTCPay `InvoiceSettled`, admin "Mark paid" | **no change** — already taken |
| BTCPay `InvoiceExpired` / `InvoiceInvalid` | units released |
| admin cancels an unpaid order | units released |
| invoice creation or order save fails | units released immediately |

What was taken is recorded on the order as `stockReserved`, and a release stamps
`stockReleased` — so a repeated webhook or a double-click in admin cannot credit
the same units twice. Reserving is **all-or-nothing**: a basket with one
unfillable line decrements nothing.

An order larger than the count is refused with a 409 and a message that names
the number (`Only 2 left of X — please lower the quantity.`). The storefront
caps its quantity steppers at the same figure and shows "Only N left" below 5,
but the server is authoritative — `products.reserveStock` is the only thing that
checks and takes in the same turn.

Covered by `test/stock.test.js` (the counting rules) and
`test/stock-orders.test.js` (the same rules driven through the real order
routes, including cancel-and-restore and the two-buyers-one-unit case).

## Shipping labels

Every paid order arrives at **Admin → To ship** with its label already made:
press **Shipping label** on a card, or **Print all N shipping labels** for the
whole queue in one print dialog. Nothing is typed — the buyer's name, delivery
address, order reference, delivery service and contents are read off the stored
order, so a label can never disagree with the sale it belongs to.

What the label *looks like* is designed once in **Admin → Label designer**:
stock size (4×6 thermal, 4×4, 3×4, A6, half-letter or a custom size), inner
margin, text size, which blocks print, a handling stamp, the small print, and
the **return address** — the one thing only the owner can supply. The preview
beside the form is an iframe running the very document that goes to the
printer, so what you see is what comes out.

- Stored in `DATA_DIR/label-design.json` via `label-design.js`; rendered by
  `../js/admin-labels.js` (shared by the preview and the print sheet).
- **Admin-only in both directions.** It holds the store's own street address,
  which the public site deliberately never shows.
- The barcode is **Code 39** carrying the order reference (or the tracking
  number, if you switch it) — chosen because a reference is exactly the
  character set Code 39 covers. The reference is printed underneath in plain
  type as well, so a smudged label is still a readable one.
- **This is not postage.** No carrier indicia, nothing prepaid: it is a
  packing/routing label. Buy the postage label from USPS/UPS/FedEx as usual and
  put it on the box alongside this one.
- Covered by `test/label-design.test.js`.

## Notes & next steps

- **Pricing source of truth:** `pricing.js` + `../js/products-data.js`. Update
  prices in one place and both the store and the invoice stay in sync.
- **A note on this product category — why there is no card processor.** Card
  processors (including PayPal/Braintree, which are the **same company**)
  routinely restrict research-peptide sales. An account can be approved and then
  have funds held or reversed once the category is noticed, which makes a card
  gateway an unpredictable dependency rather than a safety net. Crypto settles
  non-custodially with no processing fee and no chargeback; Zelle covers buyers
  who won't touch crypto. Removing Braintree was a deliberate choice, not an
  outage — don't "restore" it without re-doing that underwriting question.
- **Adding a card/ACH processor later.** The scheduler is the only place that
  assumes push-only payment. Give the subscription record a `method` other than
  `crypto` and branch in `runOneSubscription` (server.js) — the claim/recovery,
  scheduling and email machinery around it are payment-agnostic already.
