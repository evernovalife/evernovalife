# Reminders & tracking — setup

Three things that used to happen only if someone was watching now happen on a
schedule, plus a page that answers *"where is my order?"* without an account.

| # | What | Who gets it |
|---|---|---|
| 1 | An unpaid order that has gone quiet is chased twice, then left alone | the buyer |
| 2 | A saved cart that sat still for a day is mentioned once | the buyer |
| 3 | A SKU that runs down to the threshold, and again if it hits zero | you |
| 4 | `order-status.html` — order status from a reference + email | anyone |

**Number 1 is the one that pays for this.** Crypto is push-only: if a buyer
doesn't send the money, nothing anywhere tells them the order is still sitting
there. That is how a run of orders can quietly die with the stock still
reserved against them.

---

## Part A — One setting on Render (~2 min)

The reminders ride on the same trigger design as auto-ship, and reuse the same
`CRON_KEY` you already set (see `AUTO-SHIP.md` Part A). If it is set, there is
nothing new to add here.

Everything below is **optional** — the defaults are the ones described in this
document.

| Key | Default | What it does |
|---|---|---|
| `ORDER_NUDGE_HOURS` | `6,48` | when to chase an unpaid order, in hours after it was placed. Two stages, then silence. |
| `CART_NUDGE_HOURS` | `20` | how long a cart must sit untouched before it's mentioned |
| `CART_NUDGE_COOLDOWN_DAYS` | `7` | the soonest the same account can get a second cart email |
| `LOW_STOCK_THRESHOLD` | `5` | the count that triggers the owner alert |
| `OUTREACH_TICK_MINUTES` | `60` | the in-process backstop's interval (minimum 15) |
| `OUTREACH_INPROCESS_CRON` | on | set to `0` to rely only on the external trigger |

Two existing settings do the real work and are worth checking:

- **`ADMIN_EMAIL`** — where the low-stock alert goes. Without it, that alert is
  built and dropped.
- **`SMTP_USER` / `SMTP_PASS`** — without email configured, every reminder
  quietly no-ops. Nothing breaks; nothing sends.

---

## Part B — Add the scheduled ping (~2 min)

The same arrangement as auto-ship: an external hourly ping is the real trigger,
and the in-process timer is only a backstop for the window while the process
happens to be up. (Render can sleep or restart; a timer inside a sleeping
process runs nothing.)

Wherever you already ping `/api/subscriptions/run-due`, add a second job:

```
POST https://evernova-api.onrender.com/api/outreach/run
Header:  x-cron-key: <your CRON_KEY>
Every:   1 hour
```

Or with the key in the query string, if your scheduler can't set headers:

```
POST https://evernova-api.onrender.com/api/outreach/run?cronKey=<your CRON_KEY>
```

Running it more often than hourly is harmless — who has already been told is
recorded in `DATA_DIR/outreach.json`, so a repeated trigger sends nothing new.

**Test it now** (signed in as an admin, the trigger also accepts an admin
session):

```bash
curl -X POST https://evernova-api.onrender.com/api/outreach/run \
     -H "x-cron-key: <your CRON_KEY>"
```

It answers with what it did:

```json
{ "success": true, "cartsNudged": 0, "ordersNudged": 2, "stockAlerts": 1, "errors": 0 }
```

---

## What each email says

**Unpaid order** — the wording follows how the order was *meant* to be paid:

- **Short-paid (`underpaid`)** → the pay-the-balance link. Safe and self-serve:
  it mints a fresh invoice for the shortfall each time it's opened.
- **Zelle (`awaiting_payment`)** → the recipient, amount and memo again.
- **Crypto (`pending`)** → tells them the invoice has almost certainly expired
  and asks them to reply for a fresh one. **It deliberately does not hand out a
  payment link**: the original invoice is still the live bill for those goods,
  and raising a second one risks billing the same cart twice.

The second reminder says it is the last one. There is no third.

**Abandoned cart** — one email, ever, per cart. It says plainly that stock isn't
held until an order is placed, and that emptying the cart ends it.

**Low stock** — one email per crossing. It won't repeat while the count sits
there; it fires again if the SKU reaches zero, and re-arms only after you
restock above the threshold.

---

## The tracking page

`order-status.html` takes an **order reference and the email on that order** —
both, together, are the credential. A wrong email is answered exactly the same
way as a reference that doesn't exist, so the page can't be used to find out
which references are real, and the endpoint is rate limited (12 attempts per
10 minutes per IP) so they can't be walked.

What it shows: status in plain English, what was bought, the total, tracking
once it ships, and — only when there genuinely is a payable balance — the
pay-the-balance link. It does not show the delivery address, the account, or
any payment detail.

It's linked from every page footer ("Track an order") and is in `sitemap.xml`.
You can send someone straight to their own status:
`order-status.html?order=ENL-XXXXXXXX&email=them@lab.org`

---

## Analytics (off until you turn it on)

Separate from the above, and **not enabled**. `js/config.js` has an
`ENL_ANALYTICS` block; while `provider` is empty, no script loads and every
event call is a no-op.

To turn it on, pick a cookieless provider — Plausible or Umami — and set:

```js
window.ENL_ANALYTICS = { provider: 'plausible', domain: 'evernovalife.com' };
```

Cookieless matters here for two reasons: no consent banner is required, and no
advertising network is handed a view of who buys research materials. Google
Analytics would fail both.

Four events are sent, and nothing else: `view_item`, `add_to_cart`,
`begin_checkout`, `payment_started`. **No money figures, no email addresses, no
order references** — the server's order records are the books, and revenue does
not belong in a third party's dataset. What this buys you is the one number the
order records can't produce: of the people who reached the checkout, where the
rest of them went.

---

## Where the state lives

`DATA_DIR/outreach.json` — who has already been emailed, and about what. It is
the only thing standing between an hourly trigger and an hourly email, so it
belongs on the Render persistent disk with everything else in `DATA_DIR`. If it
is lost, every open order gets one more reminder than it should; nothing worse.

Rules and edge cases are covered by `server/test/outreach.test.js` and
`server/test/order-lookup.test.js` (`npm test` in `server/`).
