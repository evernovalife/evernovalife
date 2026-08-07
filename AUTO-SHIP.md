# Auto-Ship (repeating orders) — setup & testing

**What it does:** a signed-in customer ticks *"Auto-ship this order"* at checkout,
types how many days apart they want it (any number from 7 to 180), and on that
schedule the server prepares the same items again and **emails them a BTCPay
invoice to pay**. They control it from **Account → Auto-Ship**: change the
frequency, skip one shipment, pause, or cancel. No discount is applied; it's a
convenience feature.

**Nothing is ever charged automatically.** Crypto is push-only — there is no
stored credential, and nobody can debit a wallet on a schedule. So auto-ship is
*scheduled invoicing*, not recurring billing: we prepare the order, the customer
chooses to pay it, and the ordinary BTCPay webhook marks it paid and releases it
for shipping. An invoice the customer ignores simply expires. That's a weaker
guarantee of revenue than a card subscription and a much better deal for the
customer — the terms and emails say so plainly, and they should keep saying so.

---

## Part A — Two settings on Render (~3 min)

Render dashboard → your `evernova-api` service → **Environment** → add:

| Key | Value |
|---|---|
| `CRON_KEY` | `5b28dbec330ceb43ac64282f9d8d625ea0b62e0d85a1de99` |
| `SITE_URL` | `https://evernovalife.com` |

`CRON_KEY` is the password for the trigger that invoices due plans — it stops
anyone on the internet from firing your billing run. (One was generated for you
above; if you'd rather make your own, any long random string works.)

`SITE_URL` may already be set. It's what puts the right links in the auto-ship
emails, so check it's there.

Save → Render redeploys automatically. Then open
`https://evernova-api.onrender.com/api/health` — you should now see
`"autoship":true` and `"cron":true`. (`autoship` follows your BTCPay config: no
crypto, no auto-ship, since there'd be no way to invoice a shipment.)

## Part B — The hourly trigger (~3 min)

Something has to tell the server "it's time, invoice anything that's due."
Use **cron-job.org** (free). It also pings your Render instance every hour,
which conveniently stops the free tier from falling asleep.

1. Sign up at **https://cron-job.org** → **Create cronjob**.
2. Fill in:
   - **Title:** `Ever Nova Life auto-ship`
   - **URL:** `https://evernova-api.onrender.com/api/subscriptions/run-due`
   - **Schedule:** Every hour (at minute 0)
3. Open the **Advanced** tab:
   - **Request method:** `POST`
   - **Headers** → add one: name `x-cron-key`, value `5b28dbec330ceb43ac64282f9d8d625ea0b62e0d85a1de99`
4. **Create** → then hit **Test run**. A working response looks like:
   ```json
   {"success":true,"due":0,"invoiced":0,"failed":0,"reminded":0}
   ```
   `401` means the header name or value doesn't match `CRON_KEY` on Render.

Hourly is right: it isn't about precision (a shipment due "today" can go out any
time today), it's so a missed hour is never a missed shipment. Shipments are
dated from when they were **due**, not when the trigger ran, so a late or skipped
ping never drifts the schedule.

## Part C — Upload the site files to GoDaddy

Everything else deploys itself when you push to GitHub (Render rebuilds the
backend). These files go to `public_html/` on GoDaddy:

```
checkout.html      ← the auto-ship opt-in
account.html       ← the customer's Auto-Ship card
admin.html         ← your plan list + "Run due now"
shipping.html      ← the Auto-Ship section
terms.html         ← auto-ship terms (section 6)
css/styles.css     ← styling for both
js/main.js         ← checkout logic
js/auth.js         ← account-page logic
```

Plus every other `*.html` file, because the cache-buster changed site-wide —
otherwise returning visitors keep the old cached CSS and the new panels look
broken. Simplest is to upload all `.html` files, `css/` and `js/`.

**Upload order matters** (Cloudflare caches CSS/JS for 4h): assets first, HTML
last. See the note in project memory.

---

## Testing it end-to-end

You don't have to wait 30 days.

1. Sign in on the live site and add something to the cart.
2. At checkout, tick **Auto-ship this order** and set **Repeat every** to `7` days.
   Read the terms line it shows you — that's the disclosure customers get.
3. Pay the BTCPay invoice. The confirmation should say auto-ship is on, with the
   next date. (Testing against a real BTCPay store spends real coin — use a
   cheap item, or open the invoice and let it expire: the plan is created when
   the order opens, so you can test steps 4–6 without paying at all.)
4. Go to **Account → Auto-Ship**. The plan is there. Try **Skip next shipment**
   and watch the date jump forward a week.
5. Now force the whole cycle without waiting. Open **admin.html** signed in as
   the admin account — your plan is in the **Auto-Ship Plans** table.
   Click **Ship now** on it. That only moves its date to right now; it doesn't
   invoice anything yet.
6. Click **▶ Run due now**. That invoices every plan past its date — exactly what
   the hourly trigger does. You should see `1 invoiced`, a new `pending` order in
   the customer's history, an email with a **Pay now** link, and the plan's next
   date jump forward by 7 days. Pay that invoice and the order flips to `paid`.

Repeat steps 5–6 as often as you like. To watch a *failure*, delete the product
the plan contains (admin → Products) and run it again: no invoice is created, the
plan retries, and after three failures it pauses and emails the customer.

**What the customer receives:** a setup confirmation, a reminder 3 days before
every shipment, an invoice email with the pay link on each shipment date, and a
notice if we couldn't prepare an order. Those need `SMTP_USER` / `SMTP_PASS` set
on Render. **Email is not optional here** — the invoice email *is* the payment
mechanism, so without SMTP a due plan produces an order nobody can pay. Check
with `/api/health` → `"email":true`.

---

## ⚠️ Before real customers: fix data persistence

Render's **free** tier wipes the disk on every redeploy and sleeps when idle.
Auto-ship plans live in `DATA_DIR/subscriptions.json`, so on the free tier a
redeploy **silently deletes everyone's plans** — no invoices, no shipments, no
error, and no way to tell it happened.

That's tolerable for testing. It is not acceptable once someone is relying on a
shipment arriving. Before launch, do one of:

1. **Paid Render instance (~$7/mo) + a Render Disk** mounted at `/var/data`, with
   env var `DATA_DIR=/var/data`. The code already supports this — nothing to change.
2. **Move to Postgres.** Ask me and I'll convert the stores (accounts, cart,
   orders, loyalty, subscriptions). Free Postgres is available on Render/Neon/Supabase.

---

## How it behaves (worth knowing)

- **Pricing is never stored.** Every shipment is re-priced from the live catalog
  at the moment it's invoiced, so a price change or a product you delist is
  picked up automatically. A delisted product makes the run fail and the plan
  pause rather than shipping something wrong.
- **"Invoiced" is not "paid."** A successful run means the customer has been sent
  a bill. The order sits at `pending` until the BTCPay webhook settles it. Watch
  for plans that invoice every cycle and never settle — that's a customer who has
  quietly stopped paying, and the schedule won't notice on its own.
- **A failed run** (BTCPay unreachable, items unpriceable) retries after 3 days,
  up to 3 attempts, then pauses the plan and emails the customer.
- **Double-invoicing is guarded twice**: a plan is locked for the duration of its
  run (so two overlapping triggers can't both invoice it), and the order
  reference is written to the plan *before* the invoice is opened, so a run that
  crashes mid-flight recognises the existing order instead of billing again.
- **Deleting a customer** in admin also deletes their plans — otherwise the
  scheduler would keep invoicing an account that no longer exists.
- **Zelle can't be auto-shipped** (a manual transfer can't be scheduled), so the
  Zelle option hides itself while auto-ship is ticked.
- **Loyalty points** are earned on every auto-ship order once it's paid, same as
  a normal one.

## Settings you can tune

All optional, all set as Render environment variables — see `server/.env.example`
for the full list with defaults:

| Variable | Default | What it does |
|---|---|---|
| `SUBSCRIPTION_MIN_DAYS` / `MAX_DAYS` | 7 / 180 | The range customers may choose |
| `SUBSCRIPTION_RETRY_DAYS` | 3 | Wait before retrying a failed run |
| `SUBSCRIPTION_MAX_FAILS` | 3 | Failures before the plan auto-pauses |
| `SUBSCRIPTION_REMINDER_DAYS` | 3 | Days of notice before each shipment |

If you ever want to add a subscribe-and-save discount, that's a small change to
`server/pricing.js` plus the terms text — say the word.
