/* ============================================================
   EVER NOVA LIFE — BTCPay Server gateway client
   Talks to your self-hosted BTCPay instance over the Greenfield
   API. Creates a hosted crypto invoice (Bitcoin on-chain +
   Lightning) and verifies the webhook it calls back with.
   Non-custodial: funds settle straight to the wallet connected
   in your BTCPay store — this server never touches the money.
   Docs: https://docs.btcpayserver.org/API/Greenfield/v1/
   ============================================================ */

const crypto = require('crypto');

// Base URL of YOUR BTCPay instance, e.g. https://btcpay.evernovalife.com
const BASE_URL = (process.env.BTCPAY_URL || '').replace(/\/+$/, ''); // trim trailing slash
const API_KEY = process.env.BTCPAY_API_KEY || '';
const STORE_ID = process.env.BTCPAY_STORE_ID || '';
const WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET || '';
const CURRENCY = process.env.CURRENCY || 'USD';

const CONFIGURED = Boolean(BASE_URL && API_KEY && STORE_ID);

if (!CONFIGURED) {
  console.warn('[btcpay] WARNING: BTCPAY_URL / BTCPAY_API_KEY / BTCPAY_STORE_ID are not set. ' +
    'Crypto checkout is disabled until you fill them into server/.env.');
}

/* ---- how long a buyer gets, and how exact they have to be ----
   These are set on every invoice we raise, so they don't depend on anyone
   remembering to change a store setting in the BTCPay UI. BTCPay's own
   defaults are what turned real buyers into "partially paid, expired":

     expirationMinutes  how long the invoice stays payable. The default is 15,
                        which is not enough time to open a wallet, fund it or
                        move coin off an exchange — and an invoice that dies
                        mid-payment banks whatever arrived as a partial.
     monitoringMinutes  how long after expiry we keep watching the address, so
                        a late payment is still SEEN and can be settled rather
                        than landing in the wallet unattached to anything.
     paymentTolerance   percent under the asking price that still counts as
                        paid in full. This exists for wallet-fee dust — the
                        sender's wallet deducting its network fee from the
                        amount sent — NOT for real shortfalls. Keep it small.
     speedPolicy        confirmations required before BTCPay calls it settled.

   All overridable from server/.env; the clamps stop a typo (0, or 100) from
   turning into free goods or an invoice nobody can pay in time. */
function envNum(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
/* ---- which rails an invoice offers, and which one opens first ----
   BTCPAY_PAYMENT_METHODS pins the list. Left empty, the invoice offers whatever
   the store has enabled — both rails — and that is the right default: on-chain
   is the only way some buyers can pay at all, and an exchange withdrawal is how
   most of this store's customers actually send money.

   Setting it to `BTC-LN` makes partial payment structurally impossible, because
   a Lightning invoice is for a fixed amount and cannot be paid short. It also
   turns away every buyer whose wallet or exchange can't send over Lightning, and
   caps what can be paid at all — routing a few hundred dollars over Lightning is
   much harder than routing ten. A deliberate trade, never a default.

   BTCPAY_DEFAULT_METHOD only decides which tab is selected when the checkout
   page opens. Lightning first, because the rail that can't go wrong should be
   the one most people take without thinking about it. */
const PAYMENT_METHODS = (process.env.BTCPAY_PAYMENT_METHODS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_METHOD = (process.env.BTCPAY_DEFAULT_METHOD || 'BTC-LN').trim();

const EXPIRY_MINUTES = envNum('BTCPAY_EXPIRY_MINUTES', 60, 10, 1440);
const MONITORING_MINUTES = envNum('BTCPAY_MONITORING_MINUTES', 1440, 0, 20160);
const PAYMENT_TOLERANCE = envNum('BTCPAY_PAYMENT_TOLERANCE', 1, 0, 5);
const SPEED_POLICY = process.env.BTCPAY_SPEED_POLICY || 'MediumSpeed';

/* ---- Create a hosted invoice from an authoritative order.
   `order` comes from pricing.js (server-priced); the browser never
   sends the amount. The metadata is echoed back on the webhook and
   shown in the BTCPay invoice, so the merchant can reconcile + ship.

   `amount` bills for less than the order total — a top-up invoice for
   whatever is still owed after a short payment. `kind` rides back on the
   webhook so the handler can tell "the order's invoice settled" from "the
   balance invoice settled", which mean different things for an order that is
   already parked as underpaid.

   Returns { id, checkoutLink, status, amount }. ---- */
async function createInvoice({ order, email, shipping, orderId, redirectUrl, amount, kind, note }) {
  if (!CONFIGURED) throw new Error('BTCPay is not configured (missing keys in server/.env).');

  const due = Number(amount != null ? amount : order.total);
  if (!Number.isFinite(due) || due <= 0) {
    throw new Error('Refusing to raise an invoice for nothing — there is no amount owed.');
  }

  const items = Array.isArray(order.items) ? order.items : [];
  const itemDesc = note || items.map(i => `${i.quantity}x ${i.name}`).join(', ');

  const payload = {
    amount: due.toFixed(2),
    currency: CURRENCY,
    metadata: {
      orderId,
      kind: kind || 'order',
      buyerEmail: email || '',
      itemDesc,
      // full breakdown so the order can be reconciled + shipped from BTCPay
      orderSummary: {
        subtotal: order.subtotal,
        shipping: order.shipping,
        tax: order.tax,
        total: order.total,
        items
      },
      shipping: shipping || null
    },
    checkout: {
      ...(PAYMENT_METHODS.length ? { paymentMethods: PAYMENT_METHODS } : {}),
      ...(DEFAULT_METHOD ? { defaultPaymentMethod: DEFAULT_METHOD } : {}),
      expirationMinutes: EXPIRY_MINUTES,
      monitoringMinutes: MONITORING_MINUTES,
      paymentTolerance: PAYMENT_TOLERANCE,
      speedPolicy: SPEED_POLICY,
      redirectAutomatically: true,
      ...(redirectUrl ? { redirectURL: redirectUrl } : {})
    }
  };

  let res;
  try {
    res = await fetch(`${BASE_URL}/api/v1/stores/${STORE_ID}/invoices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `token ${API_KEY}` // BTCPay Greenfield API-key scheme
      },
      body: JSON.stringify(payload)
    });
  } catch (netErr) {
    throw new Error(`Could not reach the BTCPay server at ${BASE_URL}. Please try again in a moment.`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`BTCPay invoice creation failed (HTTP ${res.status}). ${text.slice(0, 300)}`);
  }

  const inv = await res.json();
  return { id: inv.id, checkoutLink: inv.checkoutLink, status: inv.status, amount: due };
}

/* ---- Read side of the Greenfield API ----
   Everything below is GET-only. The admin console uses it to answer the two
   questions the local order store cannot: "is BTCPay actually reachable with
   these keys", and "does BTCPay agree with us about what has been paid".

   A missing permission on the API key comes back as 403, which is a different
   problem from a wrong URL or a dead host, so the status is passed through
   rather than flattened into one "failed" string. */
async function apiGet(path) {
  if (!CONFIGURED) throw new Error('BTCPay is not configured (missing keys in server/.env).');
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Authorization': `token ${API_KEY}`, 'Accept': 'application/json' }
    });
  } catch (netErr) {
    const err = new Error(`Could not reach the BTCPay server at ${BASE_URL}.`);
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(res.status === 403
      ? 'The BTCPay API key is missing a permission for this data.'
      : res.status === 401
        ? 'BTCPay rejected the API key.'
        : `BTCPay returned HTTP ${res.status}. ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** The store this server invoices through — name, default currency, etc. */
function getStore() {
  return apiGet(`/api/v1/stores/${STORE_ID}`);
}

/** Recent invoices, newest first. BTCPay caps `take`; 100 is plenty here. */
async function listInvoices({ take = 50 } = {}) {
  const list = await apiGet(`/api/v1/stores/${STORE_ID}/invoices?take=${Math.min(100, Math.max(1, take))}`);
  return Array.isArray(list) ? list : [];
}

function getInvoice(id) {
  return apiGet(`/api/v1/stores/${STORE_ID}/invoices/${encodeURIComponent(id)}`);
}

/** Per-method detail for one invoice: address, rate, paid vs due, payments. */
function getInvoicePaymentMethods(id) {
  return apiGet(`/api/v1/stores/${STORE_ID}/invoices/${encodeURIComponent(id)}/payment-methods`);
}

/* ---- How much FIAT actually landed on one invoice ----
   The invoice object carries `paidAmount`, but it is not always populated and
   it is the one number a reconciliation cannot afford to guess at: too low and
   the buyer gets billed for money they already sent. So the authoritative read
   is the per-method detail, where BTCPay states the crypto received and the
   rate it was locked at — the same two figures the invoice page shows as
   "Paid" and "Rate". Fiat = paid x rate, summed over every method (an invoice
   can take on-chain AND Lightning).

   Field names have drifted across BTCPay versions, so each value is read from
   the first name that is present rather than assuming one shape.

   `known` is false when a method took money at a rate we cannot read. The
   caller must NOT treat that as zero — an unreadable payment is the exact
   case that re-bills a paying customer. */
function firstNum(obj, names) {
  for (const n of names) {
    const v = Number(obj && obj[n]);
    if (Number.isFinite(v) && obj[n] !== null && obj[n] !== '') return v;
  }
  return null;
}

async function getInvoicePaidFiat(id) {
  const [inv, methods] = await Promise.all([
    getInvoice(id),
    getInvoicePaymentMethods(id).catch(() => null)   // detail is preferred, not required
  ]);
  const meta = (inv && inv.metadata) || {};
  const out = {
    invoiceId: inv && inv.id ? inv.id : id,
    status: inv ? inv.status : '',
    additionalStatus: (inv && inv.additionalStatus) || '',
    currency: (inv && inv.currency) || CURRENCY,
    invoiceAmount: Number(inv && inv.amount) || 0,
    orderId: meta.orderId || '',
    kind: meta.kind || '',
    createdTime: inv ? inv.createdTime : null,
    methods: []
  };

  if (Array.isArray(methods) && methods.length) {
    let sum = 0;
    let known = true;
    for (const m of methods) {
      const rate = firstNum(m, ['rate']);
      const paidCrypto = firstNum(m, ['totalPaid', 'paymentMethodPaid', 'paid']);
      // A method nobody sent to contributes nothing and is not a gap in the read.
      if (paidCrypto === null || paidCrypto === 0) continue;
      if (rate === null) { known = false; continue; }
      sum += paidCrypto * rate;
      out.methods.push({
        method: m.paymentMethodId || m.paymentMethod || m.cryptoCode || '',
        rate,
        paidCrypto,
        due: firstNum(m, ['due']),
        amount: firstNum(m, ['amount']),
        paidFiat: Math.round(paidCrypto * rate * 100) / 100
      });
    }
    out.paid = Math.round(sum * 100) / 100;
    out.known = known;
    out.source = 'payment-methods';
    return out;
  }

  /* No per-method detail (older BTCPay, or the key lacks the permission).
     `paidAmount` is already in the invoice currency. Absent entirely means we
     genuinely do not know, which is different from zero. */
  const flat = firstNum(inv, ['paidAmount']);
  out.paid = flat === null ? 0 : Math.round(flat * 100) / 100;
  out.known = flat !== null;
  out.source = 'invoice.paidAmount';
  return out;
}

/* ---- webhooks: is the pipe that confirms payments actually connected? ----
   Everything downstream of a payment (order marked paid, buyer emailed, owner
   told to ship) depends on BTCPay calling us back. If that webhook is missing,
   pointed at the wrong URL, or subscribed to the wrong events, the store looks
   exactly like a store nobody buys from — so it has to be inspectable.

   BTCPay has no read-only webhook permission: the key needs
   btcpay.store.webhooks.canmodifywebhooks even to LIST them. A 403 here is
   therefore a missing permission, not a missing webhook. */
async function listWebhooks() {
  const list = await apiGet(`/api/v1/stores/${STORE_ID}/webhooks`);
  return Array.isArray(list) ? list : [];
}

/** Recent delivery attempts for one webhook — this is where a silent failure
    (our host asleep, a 500, a signature mismatch) actually shows up. */
async function listWebhookDeliveries(webhookId, { count = 20 } = {}) {
  const list = await apiGet(
    `/api/v1/stores/${STORE_ID}/webhooks/${encodeURIComponent(webhookId)}/deliveries?count=${Math.min(50, Math.max(1, count))}`
  );
  return Array.isArray(list) ? list : [];
}

/* ---- Verify the BTCPAY-SIG header on a webhook callback.
   BTCPay signs the RAW request body with your webhook secret
   (HMAC-SHA256) and sends it as "sha256=<hex>". Compare in constant
   time. Returns false (rather than throwing) on any mismatch so the
   caller can simply reject with 400. ---- */
function verifyWebhookSignature(rawBody, sigHeader) {
  if (!WEBHOOK_SECRET) return false;                 // can't verify without a secret
  if (!sigHeader || !Buffer.isBuffer(rawBody)) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(sigHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  createInvoice,
  verifyWebhookSignature,
  getStore,
  listInvoices,
  getInvoice,
  getInvoicePaymentMethods,
  getInvoicePaidFiat,
  listWebhooks,
  listWebhookDeliveries,
  CONFIGURED,
  CURRENCY,
  BASE_URL,
  STORE_ID,
  HAS_WEBHOOK_SECRET: Boolean(WEBHOOK_SECRET),
  // Surfaced so the admin panel can show the window a buyer actually gets,
  // rather than the one somebody assumes is configured.
  CHECKOUT: {
    paymentMethods: PAYMENT_METHODS,
    defaultPaymentMethod: DEFAULT_METHOD,
    expirationMinutes: EXPIRY_MINUTES,
    monitoringMinutes: MONITORING_MINUTES,
    paymentTolerance: PAYMENT_TOLERANCE,
    speedPolicy: SPEED_POLICY
  }
};
