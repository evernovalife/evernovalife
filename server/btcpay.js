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

// Base URL of YOUR BTCPay instance, e.g. https://pay.evernovalife.com
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

/* ---- Create a hosted invoice from an authoritative order.
   `order` comes from pricing.js (server-priced); the browser never
   sends the amount. The metadata is echoed back on the webhook and
   shown in the BTCPay invoice, so the merchant can reconcile + ship.
   Returns { id, checkoutLink, status }. ---- */
async function createInvoice({ order, email, shipping, orderId, redirectUrl }) {
  if (!CONFIGURED) throw new Error('BTCPay is not configured (missing keys in server/.env).');

  const itemDesc = order.items.map(i => `${i.quantity}x ${i.name}`).join(', ');

  const payload = {
    amount: order.total.toFixed(2),
    currency: CURRENCY,
    metadata: {
      orderId,
      buyerEmail: email || '',
      itemDesc,
      // full breakdown so the order can be reconciled + shipped from BTCPay
      orderSummary: {
        subtotal: order.subtotal,
        shipping: order.shipping,
        tax: order.tax,
        total: order.total,
        items: order.items
      },
      shipping: shipping || null
    },
    checkout: {
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
  return { id: inv.id, checkoutLink: inv.checkoutLink, status: inv.status };
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
  CONFIGURED,
  CURRENCY,
  BASE_URL,
  STORE_ID,
  HAS_WEBHOOK_SECRET: Boolean(WEBHOOK_SECRET)
};
