/* ============================================================
   EVER NOVA LIFE — payment API server (Braintree Drop-in)
   Endpoints:
     GET  /api/client-token   → short-lived token the Drop-in UI needs
     POST /api/checkout       → price the cart server-side + run the sale
     GET  /api/health         → liveness probe
   Also (optionally) serves the static site from the repo root,
   so the whole store runs from one origin during development.
   ============================================================ */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const { buildOrder } = require('./pricing.js');
const braintree = require('./braintree.js');
const btcpay = require('./btcpay.js');
const auth = require('./auth.js');

const app = express();
const PORT = process.env.PORT || 4242;
const ROOT = path.join(__dirname, '..'); // project root (HTML/CSS/JS live here)

/* ---- CORS: allow your site origin(s) to call this API ---- */
const allowed = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  }
}));

// Keep the raw request body around (needed to verify the BTCPay webhook's
// HMAC signature, which is computed over the exact bytes BTCPay sent).
app.use(express.json({
  limit: '32kb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

/* ---- client token: the browser Drop-in exchanges this to talk to Braintree ---- */
app.get('/api/client-token', async (req, res) => {
  if (!braintree.CONFIGURED) {
    return res.status(500).json({ error: 'Server is missing Braintree API keys (see server/.env).' });
  }
  try {
    const clientToken = await braintree.generateClientToken();
    res.json({ clientToken, currency: braintree.CURRENCY, env: braintree.ENV });
  } catch (err) {
    console.error('[client-token] failed:', err.message);
    res.status(500).json({ error: 'Could not initialise the payment form. Check your Braintree keys.' });
  }
});

app.get('/api/health', (req, res) => res.json({
  ok: true,
  env: braintree.ENV,
  card: braintree.CONFIGURED,     // Braintree (cards / PayPal / Venmo) ready?
  crypto: btcpay.CONFIGURED,      // BTCPay (Bitcoin / Lightning) ready?
  auth: true                      // email/password accounts always available
}));

/* ============================================================
   AUTH — email + password accounts
   Passwords are bcrypt-hashed; a signed JWT is returned on
   register/login and sent back as "Authorization: Bearer <token>".
   ============================================================ */

/* ---- create an account ---- */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body || {};
    const result = await auth.registerUser({ firstName, lastName, email, password });
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/* ---- sign in ---- */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await auth.authenticate({ email, password });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/* ---- who am I? (used to hydrate the account page) ---- */
app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

/* ---- checkout: price it HERE (never trust the browser's total), then sell ---- */
app.post('/api/checkout', async (req, res) => {
  try {
    const body = req.body || {};
    const order = buildOrder(body.items);                 // authoritative price
    const transaction = await braintree.createTransaction({
      order,
      nonce: body.nonce,
      deviceData: body.deviceData,
      shipping: body.shipping,
      email: body.email
    });
    res.status(201).json({
      success: true,
      transactionId: transaction.id,
      status: transaction.status,                          // e.g. "submitted_for_settlement"
      amount: transaction.amount,
      total: order.total
    });
  } catch (err) {
    console.error('[checkout] failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

/* ============================================================
   CRYPTO CHECKOUT — Bitcoin / Lightning via BTCPay Server
   Same rule as cards: price the cart HERE, never trust the
   browser's total. We open a hosted BTCPay invoice and hand the
   browser its checkoutLink to redirect to.
   ============================================================ */

/* ---- open a BTCPay invoice for the (server-priced) cart ---- */
app.post('/api/crypto/checkout', async (req, res) => {
  if (!btcpay.CONFIGURED) {
    return res.status(500).json({ error: 'Crypto payments are not set up yet (missing BTCPay keys in server/.env).' });
  }
  try {
    const body = req.body || {};
    const order = buildOrder(body.items);                       // authoritative price
    const orderId = 'ENL-' + Date.now().toString(36).toUpperCase();

    // Build a same-site return URL so BTCPay can send the buyer back to us.
    // Prefer an explicit SITE_URL; otherwise use the caller's Origin (a
    // same-site fetch → our own site). No trusted origin → let BTCPay show
    // its own receipt page instead of redirecting anywhere.
    const base = (process.env.SITE_URL || req.headers.origin || '').replace(/\/+$/, '');
    const redirectUrl = base ? `${base}/checkout.html?paid=crypto` : '';

    const invoice = await btcpay.createInvoice({
      order,
      email: body.email,
      shipping: body.shipping,
      orderId,
      redirectUrl
    });

    res.status(201).json({
      success: true,
      orderId,
      invoiceId: invoice.id,
      checkoutLink: invoice.checkoutLink,
      total: order.total
    });
  } catch (err) {
    console.error('[crypto checkout] failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

/* ---- webhook: BTCPay calls this whenever an invoice changes state.
   We verify the signature, then acknowledge. This is where order
   fulfilment hooks in once you add an order store. ---- */
app.post('/api/crypto/webhook', (req, res) => {
  const sig = req.get('BTCPay-Sig');
  if (!btcpay.verifyWebhookSignature(req.rawBody, sig)) {
    console.warn('[crypto webhook] rejected: bad or missing signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const evt = req.body || {};
  const orderId = evt.metadata && evt.metadata.orderId;
  // Common types: InvoiceReceivedPayment, InvoiceProcessing (seen, awaiting
  // confirmations), InvoiceSettled (paid & confirmed), InvoiceExpired,
  // InvoiceInvalid. See https://docs.btcpayserver.org/API/Greenfield/v1/#webhooks
  console.log(`[crypto webhook] ${evt.type} · invoice ${evt.invoiceId || '—'} · order ${orderId || '—'}`);

  // TODO(fulfilment): when evt.type === 'InvoiceSettled', mark the order paid
  // and trigger shipping / a confirmation email. This app has no order DB yet,
  // so for now we simply acknowledge so BTCPay stops retrying.
  res.json({ ok: true });
});

/* ---- serve the static site from the same origin — only when it's actually here ----
   Same-origin deploy (e.g. GoDaddy / local): ROOT holds the site → serve it.
   API-only deploy (e.g. Render, where just /server is deployed and the site lives
   on GoDaddy): there's no site next to us → skip static serving entirely so nothing
   unintended is exposed; the API endpoints above are all that respond.
   SECURITY: when we DO serve static, block the backend folder + secrets first, or
   requests like /server/.env would leak the Braintree private key + JWT secret. */
if (fs.existsSync(path.join(ROOT, 'index.html'))) {
  app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    const hidden =
      p === '/server' || p.startsWith('/server/') ||
      p.startsWith('/node_modules/') ||
      p.split('/').some(seg => seg.startsWith('.'));   // /.env, /.git/…, /server/.env
    if (hidden) return res.status(404).type('txt').send('Not found');
    next();
  });
  app.use(express.static(ROOT, { extensions: ['html'], dotfiles: 'deny' }));
} else {
  // API-only: a friendly root response so hitting the base URL isn't a bare 404.
  app.get('/', (_req, res) => res.json({ ok: true, service: 'Ever Nova Life API' }));
}

app.listen(PORT, () => {
  console.log(`\nEver Nova Life payment server`);
  console.log(`  env:    ${braintree.ENV}`);
  console.log(`  card:   ${braintree.CONFIGURED ? 'Braintree ready' : 'not configured (set BRAINTREE_* in .env)'}`);
  console.log(`  crypto: ${btcpay.CONFIGURED ? 'BTCPay ready → ' + btcpay.BASE_URL : 'not configured (set BTCPAY_* in .env)'}`);
  console.log(`  auth:   accounts ready${auth.CONFIGURED ? '' : ' (JWT_SECRET not set — set it in .env for production)'}`);
  console.log(`  api:    http://localhost:${PORT}/api`);
  console.log(`  site:   http://localhost:${PORT}/  (serving ${ROOT})\n`);
});
