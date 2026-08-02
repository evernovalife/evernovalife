/* ============================================================
   EVER NOVA LIFE — Zelle (manual bank transfer) gateway
   Zelle has NO merchant API: there is no way to create a charge,
   no redirect, and no webhook. Money moves bank-to-bank between
   two people, and the only thing we can do programmatically is
   (a) tell the buyer exactly who to send to and what memo to put
   on it, and (b) let the store owner confirm the payment landed.

   So this module is deliberately thin — it holds the receiving
   details, decides whether an order is payable this way, and
   formats the instructions. The order is created as
   "awaiting_payment"; an admin flips it to "paid" from
   admin.html once the transfer shows up in the bank account.

   Env (server/.env):
     ZELLE_RECIPIENT     email or US phone number enrolled with Zelle
     ZELLE_NAME          the name the buyer will see when they send
     ZELLE_BANK          optional — bank name, shown for reassurance
     ZELLE_WINDOW_HOURS  how long to hold the order (default 24)
     ZELLE_MAX_TOTAL     optional — decline orders over this amount
                         (bank daily send limits are often $500–$2,500)

   NOTE for the store owner: consumer Zelle terms don't cover
   paying for goods, and there's no buyer/seller protection or
   chargeback path. Use a Zelle-for-business enrollment through
   your bank. See server/README.md.
   ============================================================ */

const RECIPIENT = (process.env.ZELLE_RECIPIENT || '').trim();
const RECIPIENT_NAME = (process.env.ZELLE_NAME || '').trim();
const BANK = (process.env.ZELLE_BANK || '').trim();
const CURRENCY = process.env.CURRENCY || 'USD';

const WINDOW_HOURS = clampNum(process.env.ZELLE_WINDOW_HOURS, 24, 1, 168);
const MAX_TOTAL = Math.max(0, Number(process.env.ZELLE_MAX_TOTAL) || 0); // 0 = no cap

const CONFIGURED = Boolean(RECIPIENT && RECIPIENT_NAME);

if (!CONFIGURED) {
  console.warn('[zelle] Zelle checkout is off (set ZELLE_RECIPIENT + ZELLE_NAME in server/.env to turn it on).');
}

function clampNum(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* Is the recipient an email or a phone number? Only used for wording — Zelle
   accepts either, and the buyer types it into their own banking app. */
const RECIPIENT_KIND = RECIPIENT.includes('@') ? 'email' : 'phone';

/* ---- Can this order be paid by Zelle?
   Throws an Error whose message is safe to show the buyer, so the route can
   pass it straight through. Two hard limits are worth catching BEFORE we
   create an order the buyer can't actually pay:
     · Zelle only moves money between US bank accounts
     · a bank's daily send limit can be below the order total
   ---- */
function assertPayable({ order, shipping }) {
  if (!CONFIGURED) {
    throw new Error('Zelle payment is not set up yet (missing ZELLE_RECIPIENT / ZELLE_NAME in server/.env).');
  }
  // The browser sends `countryCode`; accept `country` too so any caller works.
  const country = String((shipping && (shipping.countryCode || shipping.country)) || '').trim().toUpperCase();
  if (country && country !== 'US' && country !== 'USA' && country !== 'UNITED STATES') {
    throw new Error('Zelle only works between US bank accounts. Please pay by card or crypto instead.');
  }
  if (MAX_TOTAL > 0 && order.total > MAX_TOTAL) {
    throw new Error(
      `Zelle is available on orders up to $${MAX_TOTAL.toFixed(2)} — this one is $${order.total.toFixed(2)}. ` +
      'Please pay by card or crypto instead.'
    );
  }
}

/* ---- Everything the buyer needs to send the money, and everything we need
   to recognise it when it arrives. `orderId` doubles as the memo: it's short,
   unique, and already printed on their confirmation. ---- */
function instructions({ orderId, order }) {
  return {
    recipient: RECIPIENT,
    recipientKind: RECIPIENT_KIND,   // 'email' | 'phone'
    recipientName: RECIPIENT_NAME,
    bank: BANK,
    amount: Number(order.total.toFixed(2)),
    currency: CURRENCY,
    memo: orderId,                   // what they must put in the Zelle memo
    windowHours: WINDOW_HOURS,
    expiresAt: new Date(Date.now() + WINDOW_HOURS * 3600 * 1000).toISOString()
  };
}

/* Same instructions as plain lines — used in the confirmation email. */
function instructionLines(inst) {
  return [
    `Send to:   ${inst.recipient}  (${inst.recipientName})`,
    `Amount:    $${inst.amount.toFixed(2)} ${inst.currency}`,
    `Memo:      ${inst.memo}   ← this is how we match your payment to your order`,
    inst.bank ? `Our bank:  ${inst.bank}` : ''
  ].filter(Boolean);
}

module.exports = {
  CONFIGURED,
  CURRENCY,
  RECIPIENT,
  RECIPIENT_NAME,
  RECIPIENT_KIND,
  BANK,
  WINDOW_HOURS,
  MAX_TOTAL,
  assertPayable,
  instructions,
  instructionLines
};
