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

/* ---- Run a sale from an authoritative pricing breakdown.
   `order` comes from pricing.js (server-priced); the browser only supplies the
   payment nonce, never the amount.

   Two ways to pay:
     · `nonce`              — a fresh Drop-in nonce (the customer is present)
     · `paymentMethodToken` — a card already in the Braintree vault, used by the
                              auto-ship scheduler when nobody is at the keyboard

   Auto-ship extras:
     · `customerId`   attach the sale to a Braintree customer (needed to vault)
     · `storeInVault` keep the payment method after a successful sale, so we can
                      charge it again on the schedule
     · `source`       the stored-credential indicator the card networks require:
                      'recurring_first' on the sale that starts a plan, then
                      'recurring' on every scheduled charge. Getting this right
                      is what keeps repeat charges from being declined.
     · `orderId`      our own reference, echoed onto the Braintree transaction —
                      the scheduler searches on it to make sure a charge that
                      succeeded during a crash is never repeated. ---- */
async function createTransaction({ order, nonce, paymentMethodToken, deviceData, shipping, email,
                                   customerId, storeInVault, source, orderId }) {
  if (!gateway) throw new Error('Braintree is not configured (missing API keys in server/.env).');
  if (!nonce && !paymentMethodToken) throw new Error('Missing payment method nonce.');

  const sale = {
    amount: order.total.toFixed(2),
    options: { submitForSettlement: true } // authorize + capture in one step
  };

  if (paymentMethodToken) sale.paymentMethodToken = paymentMethodToken;
  else sale.paymentMethodNonce = nonce;

  if (deviceData) sale.deviceData = deviceData; // fraud / risk signal from the browser
  if (orderId) sale.orderId = String(orderId).slice(0, 255);
  if (source) sale.transactionSource = source;

  // A sale can name an EXISTING customer (customerId) or describe a new one
  // (customer: {...}) — never both, so prefer the id when we have one.
  if (customerId) {
    sale.customerId = customerId;
    if (storeInVault) sale.options.storeInVaultOnSuccess = true;
  } else if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
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

/* ============================================================
   VAULT — saved payment methods for auto-ship
   To charge a customer again later we need their payment method
   stored in Braintree's vault, attached to a Braintree "customer".
   We reuse OUR account id as the Braintree customer id (a UUID —
   within Braintree's 36-char limit), so the two systems line up
   without an extra lookup table.
   ============================================================ */

/* Fetch the Braintree customer for an account, creating it on first use.
   Returns the customer id. */
async function findOrCreateCustomer({ id, email, firstName, lastName }) {
  if (!gateway) throw new Error('Braintree is not configured (missing API keys in server/.env).');
  if (!id) throw new Error('Missing account id for the Braintree customer.');
  const customerId = String(id).slice(0, 36);

  try {
    const existing = await gateway.customer.find(customerId);
    if (existing) return customerId;
  } catch (e) {
    // "not found" is the expected path on first use — anything else is real.
    if (!/not found|notfound/i.test(e.type || e.name || e.message || '')) throw e;
  }

  const result = await gateway.customer.create({
    id: customerId,
    ...(email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { email: email.slice(0, 255) } : {}),
    ...(firstName ? { firstName: String(firstName).slice(0, 255) } : {}),
    ...(lastName ? { lastName: String(lastName).slice(0, 255) } : {})
  });
  if (!result.success) {
    throw new Error(result.message || 'Could not save your details for auto-ship.');
  }
  return customerId;
}

/* Pull the vaulted payment method off a completed sale (only present when the
   sale ran with storeInVaultOnSuccess). Returns { token, label } or null.
   The label is all the browser ever sees — "Visa ending 1111". */
function vaultedMethodFrom(transaction) {
  if (!transaction) return null;

  const card = transaction.creditCard;
  if (card && card.token) {
    const type = card.cardType || 'Card';
    return { token: card.token, label: card.last4 ? `${type} ending ${card.last4}` : type };
  }

  const paypal = transaction.paypalAccount;
  if (paypal && paypal.token) {
    return { token: paypal.token, label: paypal.payerEmail ? `PayPal (${paypal.payerEmail})` : 'PayPal' };
  }

  const venmo = transaction.venmoAccount;
  if (venmo && venmo.token) {
    return { token: venmo.token, label: venmo.username ? `Venmo (@${venmo.username})` : 'Venmo' };
  }

  return null;
}

/* Attach a fresh Drop-in nonce to a customer's vault without charging it —
   used when someone sets up auto-ship outside of a checkout, or updates the
   card on an existing plan. Returns { token, label }. */
async function vaultPaymentMethod({ customerId, nonce, deviceData }) {
  if (!gateway) throw new Error('Braintree is not configured (missing API keys in server/.env).');
  if (!customerId || !nonce) throw new Error('Missing customer or payment method.');

  const result = await gateway.paymentMethod.create({
    customerId,
    paymentMethodNonce: nonce,
    ...(deviceData ? { deviceData } : {}),
    options: { verifyCard: true, makeDefault: true }   // check the card is live before we rely on it
  });
  if (!result.success || !result.paymentMethod) {
    throw new Error(result.message || 'That payment method could not be saved.');
  }
  const pm = result.paymentMethod;
  const label = pm.cardType && pm.last4
    ? `${pm.cardType} ending ${pm.last4}`
    : (pm.email ? `PayPal (${pm.email})` : (pm.username ? `Venmo (@${pm.username})` : 'Saved payment method'));
  return { token: pm.token, label };
}

/* Confirm a vault token really belongs to this customer, so a plan can never
   be pointed at somebody else's card by passing a guessed token. */
async function paymentMethodBelongsTo(token, customerId) {
  if (!gateway || !token || !customerId) return false;
  try {
    const pm = await gateway.paymentMethod.find(String(token));
    return !!pm && pm.customerId === customerId;
  } catch (e) {
    return false;
  }
}

/* Has a transaction already been created for this order reference?
   The scheduler stamps its order id on every sale, so if a run charged the
   card and then died before recording anything, the retry finds the charge
   here instead of taking the money twice. Returns the transaction or null;
   any lookup failure returns null (the caller treats that as "unknown"). */
async function findTransactionByOrderId(orderId) {
  if (!gateway || !orderId) return null;
  try {
    const found = await gateway.transaction.search(search => {
      search.orderId().is(String(orderId));
    });
    if (!found) return null;
    if (typeof found.first === 'function') {
      const first = await found.first();
      return first || null;
    }
    if (Array.isArray(found.ids) && found.ids.length) {
      return await gateway.transaction.find(found.ids[0]);
    }
    return null;
  } catch (e) {
    console.error('[braintree] order lookup failed:', e.message);
    return null;
  }
}

module.exports = {
  generateClientToken,
  createTransaction,
  findOrCreateCustomer,
  vaultedMethodFrom,
  vaultPaymentMethod,
  paymentMethodBelongsTo,
  findTransactionByOrderId,
  ENV,
  CURRENCY,
  CONFIGURED
};
