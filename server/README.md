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
| GET    | `/api/admin/orders`    | Admin: all orders (`?status=awaiting_payment`)   |
| POST   | `/api/admin/orders/:id/paid`   | Admin: confirm a manual payment landed   |
| POST   | `/api/admin/orders/:id/cancel` | Admin: cancel an order that was never paid |
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
| `InvoiceExpired` / `InvoiceInvalid`, **money against it** | `underpaid` — stock and points stay held | buyer ("your payment came in short"), you (action needed) |

That last row is the one that bites. **An expired invoice is not the same as an
unpaid one:** BTCPay expires an invoice that was underpaid or paid too late, and
those coins are already in your wallet. Such an order is parked at `underpaid`
and waits for a human — "Mark paid" in `admin.html` releases it (the buyer sent
the rest, or you're accepting the shortfall), "Cancel" gives back the stock and
the loyalty points, and the refund itself is a send from your wallet.

**Two BTCPay store settings decide how often that happens** (Store Settings →
Checkout):

- *Invoice expires if the full amount has not been paid after N minutes* — the
  default 15 is tight for on-chain Bitcoin. A buyer withdrawing from an exchange
  can easily take longer than that before the transaction is even broadcast.
  30–60 is kinder.
- *Payment tolerance* — 0% means a wallet or exchange that deducts its network
  fee from the amount sent leaves the order unpaid. 1–2% absorbs that.

And one store *wallet* setting: the checkout is labelled **Bitcoin / Lightning**
throughout the site, so a Lightning node has to actually be connected in BTCPay
(Store → Lightning). With on-chain as the only method, every buyer is subject to
mempool timing inside that expiry window — check an invoice's `paymentMethods`:
`["BTC-CHAIN"]` alone means Lightning is off.

> Volatility tip: set your BTCPay store to auto-convert or settle in a
> stablecoin if you don't want to hold BTC.

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
