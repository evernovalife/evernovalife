# Ever Nova Life — Braintree payment backend

Real payments for the Ever Nova Life store, using **Braintree** (PayPal's payment
gateway) with the **Drop-in UI**. One checkout box accepts **debit/credit cards,
PayPal, and Venmo**. The browser renders the Drop-in and produces a payment
*nonce*; this server **recomputes prices from the product catalog** and runs the
sale, so the amount charged can never be altered from the browser.

```
Browser (checkout.html)
   │  GET  /api/client-token      ── server returns a Drop-in client token
   │  ◄ client token
   │  buyer picks card / PayPal / Venmo in the Drop-in → gets a payment nonce
   │  POST /api/checkout          ── server prices the cart + runs the sale
   ▼
Braintree gateway
```

## 1. Get Braintree API credentials

1. Create / sign in to a Braintree account at **https://www.braintreepayments.com**
   (this goes through PayPal/Braintree approval).
2. In the **Control Panel → Settings → API Keys**, copy your:
   - **Merchant ID**
   - **Public Key**
   - **Private Key**
3. Use the **sandbox** Control Panel (https://sandbox.braintreegateway.com) for
   testing, and your **production** Control Panel keys when you go live.

## 2. Configure

```bash
cd server
cp .env.example .env      # then edit .env
```

Fill in `.env`:

| Variable                 | What to put                                              |
|--------------------------|---------------------------------------------------------|
| `BRAINTREE_ENV`          | `sandbox` while testing, `production` for real payments  |
| `BRAINTREE_MERCHANT_ID`  | Merchant ID for the selected environment                 |
| `BRAINTREE_PUBLIC_KEY`   | Public Key for the selected environment                  |
| `BRAINTREE_PRIVATE_KEY`  | Private Key for the selected environment                 |
| `CURRENCY`               | `USD` (must be enabled on your merchant account)         |
| `PORT`                   | API port (default `4242`)                                |
| `ALLOWED_ORIGINS`        | `*` for local dev; your real origin in production        |

## 3. Run

```bash
cd server
npm install
npm start
```

You'll see:

```
Ever Nova Life payment server (Braintree)
  env:   sandbox
  api:   http://localhost:4242/api
  site:  http://localhost:4242/  (serving ...)
```

The server also serves the static site, so open **http://localhost:4242/checkout.html**
— same origin means `window.PEPTIDE_API_BASE` can stay `""`.

## 4. Test the full flow (sandbox)

1. Add products to the cart, go to checkout, fill the form, tick the consent box.
2. In the Drop-in, pay with a **sandbox test card** (e.g. Visa `4111 1111 1111 1111`,
   any future expiry, any CVV) or the sandbox **PayPal / Venmo** options.
   Full list of test card numbers:
   https://developer.paypal.com/braintree/docs/reference/general/testing
3. Click **Pay**. You should land on the "Payment received" confirmation with a
   transaction reference, and see the transaction in your sandbox Control Panel
   under **Transactions** (status `Submitted for Settlement`).

## 5. Go live

1. Set `BRAINTREE_ENV=production` and swap in your **production** Merchant ID +
   Public/Private keys.
2. Set `ALLOWED_ORIGINS` to your real site origin (e.g. `https://evernovalife.com`).
3. If the site is hosted separately from this API, set
   `window.PEPTIDE_API_BASE` in `checkout.html` to the API origin
   (e.g. `https://api.evernovalife.com`) and make sure that origin is in
   `ALLOWED_ORIGINS`.
4. Serve everything over **HTTPS** (required for live card entry).
5. In the Control Panel, enable the payment methods you want in the Drop-in
   (cards are on by default; enable **PayPal** and **Venmo** under
   **Settings → Processing**).

## Endpoints

| Method | Path                   | Purpose                                          |
|--------|------------------------|--------------------------------------------------|
| GET    | `/api/client-token`    | Short-lived token the Drop-in needs to start     |
| POST   | `/api/checkout`        | Price the cart server-side and run the card sale |
| POST   | `/api/crypto/checkout` | Price the cart + open a BTCPay crypto invoice    |
| POST   | `/api/crypto/webhook`  | BTCPay → us: invoice state changes (signed)      |
| POST   | `/api/auth/register`   | Create an account (bcrypt) → returns a JWT       |
| POST   | `/api/auth/login`      | Verify email + password → returns a JWT          |
| GET    | `/api/auth/me`         | Current user (needs `Authorization: Bearer …`)   |
| GET    | `/api/health`          | Liveness + which methods are configured          |

`POST /api/checkout` body:

```json
{
  "items":   [{ "id": 1, "quantity": 2 }],
  "shipping":{ "name": "...", "address": "...", "city": "...",
               "state": "...", "postalCode": "...", "countryCode": "US" },
  "email":   "you@lab.com",
  "nonce":   "<payment nonce from the Drop-in>",
  "deviceData": "<device data from the Drop-in>"
}
```

## Crypto payments — Bitcoin / Lightning (BTCPay Server)

Runs alongside cards. The buyer clicks **Pay with Bitcoin / Lightning**, we price
the cart server-side (same `pricing.js` as cards), open a **hosted BTCPay
invoice**, and redirect them to it. BTCPay is **non-custodial** — funds settle
straight to the wallet connected in your BTCPay store; this server never touches
the money, and there are **no processing fees** (unlike the 5–8% high-risk card
rates for this product category).

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
3. **Instance URL** — e.g. `https://pay.evernovalife.com` → `BTCPAY_URL`
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
  "email":   "you@lab.com"
}
```

The order id + full price breakdown + ship-to are stored in the invoice
`metadata`, so you can reconcile and ship right from the BTCPay invoice screen
(handy since this app has no order database yet).

> **Fulfilment hook:** `/api/crypto/webhook` verifies the signature and logs the
> event. When you add an order store, act on `InvoiceSettled` (paid & confirmed)
> to mark the order paid / trigger shipping. Volatility tip: set your BTCPay
> store to auto-convert or settle in a stablecoin if you don't want to hold BTC.

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

## Cards / PayPal / Venmo — all in one box

The Drop-in UI handles all three. Card fields are Braintree-hosted iframes, so
card data never touches your page or server (keeps you in the simplest PCI scope,
**SAQ A**). PayPal and Venmo appear as buttons inside the same box once enabled on
your merchant account.

## Notes & next steps

- **Pricing source of truth:** `pricing.js` + `../js/products-data.js`. Update
  prices in one place and both the store and the charge stay in sync.
- **A note on this product category:** card processors (incl. PayPal/Braintree —
  they are the **same company**) often restrict research-peptide sales. Confirm
  your account is approved for this category before going live, or payments may be
  held or reversed. Switching gateways within PayPal/Braintree does **not** change
  this underwriting.
- **Recommended hardening for production:** add a Braintree **webhook** listener
  to record settled transactions server-side, persist orders to a database, and
  send your own confirmation email. (`transaction.sale` here authorizes **and**
  submits for settlement in one step.)
- **Optional:** add Braintree **line items** to `braintree.js` for Level 2/3
  interchange data — omitted here to keep the sale call simple and robust.
