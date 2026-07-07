/* ============================================================
   EVER NOVA LIFE — Braintree gateway client
   Server-to-server calls using your Merchant ID + API keys.
   Docs: https://developer.paypal.com/braintree/docs/start/overview
   Braintree is PayPal's gateway; one Drop-in checkout accepts
   debit/credit cards, PayPal and Venmo.
   ============================================================ */

const braintree = require('braintree');

const ENV = (process.env.BRAINTREE_ENV || 'sandbox').toLowerCase();
const CURRENCY = process.env.CURRENCY || 'USD';

const MERCHANT_ID = process.env.BRAINTREE_MERCHANT_ID;
const PUBLIC_KEY = process.env.BRAINTREE_PUBLIC_KEY;
const PRIVATE_KEY = process.env.BRAINTREE_PRIVATE_KEY;

const CONFIGURED = Boolean(MERCHANT_ID && PUBLIC_KEY && PRIVATE_KEY);

// Construct the gateway lazily: the SDK throws if any key is missing, so when
// .env isn't filled in yet we keep the server running and return a friendly
// error from the endpoints instead of crashing on boot.
let gateway = null;
if (CONFIGURED) {
  gateway = new braintree.BraintreeGateway({
    environment: ENV === 'production'
      ? braintree.Environment.Production
      : braintree.Environment.Sandbox,
    merchantId: MERCHANT_ID,
    publicKey: PUBLIC_KEY,
    privateKey: PRIVATE_KEY
  });
} else {
  console.warn('[braintree] WARNING: BRAINTREE_MERCHANT_ID / BRAINTREE_PUBLIC_KEY / ' +
    'BRAINTREE_PRIVATE_KEY are not set. Copy server/.env.example to server/.env and fill them in.');
}

/* ---- Client token: short-lived auth the browser Drop-in uses to talk
   directly to Braintree (safe to expose). ---- */
async function generateClientToken() {
  if (!gateway) throw new Error('Braintree is not configured (missing API keys in server/.env).');
  const resp = await gateway.clientToken.generate({});
  if (!resp || !resp.clientToken) {
    throw new Error('Braintree did not return a client token (check your API keys).');
  }
  return resp.clientToken;
}

/* ---- Split "Jane Q Doe" → { firstName: "Jane", lastName: "Q Doe" } ---- */
function splitName(full) {
  const parts = (full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0].slice(0, 255), lastName: '' };
  return {
    firstName: parts[0].slice(0, 255),
    lastName: parts.slice(1).join(' ').slice(0, 255)
  };
}

/* ---- Run a sale from an authoritative pricing breakdown + the Drop-in nonce.
   `order` comes from pricing.js (server-priced); the browser only supplies the
   payment nonce, never the amount. ---- */
async function createTransaction({ order, nonce, deviceData, shipping, email }) {
  if (!gateway) throw new Error('Braintree is not configured (missing API keys in server/.env).');
  if (!nonce) throw new Error('Missing payment method nonce.');

  const sale = {
    amount: order.total.toFixed(2),
    paymentMethodNonce: nonce,
    options: { submitForSettlement: true } // authorize + capture in one step
  };

  if (deviceData) sale.deviceData = deviceData; // fraud / risk signal from the browser

  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    sale.customer = { email: email.slice(0, 255) };
  }

  // Attach a shipping address only when a valid 2-letter country code is present.
  if (shipping && shipping.address && /^[A-Z]{2}$/.test(shipping.countryCode || '')) {
    const { firstName, lastName } = splitName(shipping.name);
    sale.shipping = {
      firstName,
      lastName,
      streetAddress: (shipping.address || '').slice(0, 255),
      locality: (shipping.city || '').slice(0, 255),        // city
      region: (shipping.state || '').slice(0, 255),         // state / region
      postalCode: (shipping.postalCode || '').slice(0, 30),
      countryCodeAlpha2: shipping.countryCode
    };
  }

  const result = await gateway.transaction.sale(sale);

  if (!result.success) {
    // Surface the most useful message Braintree gives us.
    const msg = result.message
      || (result.transaction && result.transaction.processorResponseText)
      || 'The payment was declined.';
    const err = new Error(msg);
    err.braintree = {
      processorResponseCode: result.transaction && result.transaction.processorResponseCode,
      transactionId: result.transaction && result.transaction.id
    };
    throw err;
  }

  return result.transaction; // { id, status, amount, ... }
}

module.exports = { generateClientToken, createTransaction, ENV, CURRENCY, CONFIGURED };
