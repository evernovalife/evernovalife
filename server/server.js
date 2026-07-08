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
const mailer = require('./email.js');

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
  auth: true,                     // email/password accounts always available
  email: mailer.CONFIGURED        // reset + welcome emails (Gmail SMTP) ready?
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

    // Fire-and-forget after responding, so they never delay or fail signup.
    sendWelcomeEmail(result.user).catch(err => console.error('[welcome] failed:', err.message));
    notifyAdminOfSignup(result.user).catch(err => console.error('[admin-notify] failed:', err.message));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/* Notify the store owner (ADMIN_EMAIL) that someone signed up — a permanent
   record in their inbox, independent of the server's (ephemeral) disk. */
async function notifyAdminOfSignup(user) {
  const to = process.env.ADMIN_EMAIL || '';
  if (!mailer.CONFIGURED || !to || !user) return;
  const full = ((user.firstName || '') + ' ' + (user.lastName || '')).trim() || '(no name)';
  const when = user.createdAt || new Date().toISOString();
  const subject = `New signup: ${full}`;
  const text = `A new account was created on Ever Nova Life:\n\n` +
    `Name:  ${full}\nEmail: ${user.email}\nWhen:  ${when}\n`;
  const html = `<div style="font-family:Arial,sans-serif;color:#1f2937">
    <h3 style="color:#6d28d9">New Ever Nova Life signup</h3>
    <table style="border-collapse:collapse">
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Name</td><td><strong>${escapeHtmlSrv(full)}</strong></td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Email</td><td>${escapeHtmlSrv(user.email)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280">When</td><td>${escapeHtmlSrv(when)}</td></tr>
    </table>
  </div>`;
  return mailer.sendMail({ to, subject, text, html });
}

/* Send a friendly "thanks for signing up" email to a new account. */
async function sendWelcomeEmail(user) {
  if (!mailer.CONFIGURED || !user || !user.email) return;
  const site = (process.env.SITE_URL || 'https://evernovalife.com').replace(/\/+$/, '');
  const name = user.firstName || 'there';
  const subject = 'Welcome to Ever Nova Life 🎉';
  const text = `Hi ${name},\n\n` +
    `Thank you for creating your Ever Nova Life account — welcome to the Nest!\n\n` +
    `You can now track orders, save a wishlist, and check out faster. Browse our ` +
    `lab-verified research peptides here:\n${site}/products.html\n\n` +
    `All products are for in-vitro research and laboratory use only.\n\n` +
    `— The Ever Nova Life team`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="color:#6d28d9;margin-bottom:4px">Welcome to the Nest, ${escapeHtmlSrv(name)}! 🎉</h2>
    <p>Thank you for creating your <strong>Ever Nova Life</strong> account.</p>
    <p>You can now track orders, save a wishlist, and check out faster.</p>
    <p><a href="${site}/products.html" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Browse products</a></p>
    <p style="color:#9ca3af;font-size:12px;margin-top:24px">All products are sold strictly for in-vitro research and laboratory use only. Not for human consumption.</p>
  </div>`;
  return mailer.sendMail({ to: user.email, subject, text, html });
}

/* tiny HTML escaper for values interpolated into email markup */
function escapeHtmlSrv(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

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

/* ---- ADMIN: list everyone who has signed up ----
   Protected by ADMIN_KEY (sent as the "x-admin-key" header or ?key=…).
   Returns public fields only — never password hashes. */
const ADMIN_KEY = process.env.ADMIN_KEY || '';
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Admin view is not set up yet (set ADMIN_KEY in the server env).' });
  const key = req.get('x-admin-key') || req.query.key || '';
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key.' });
  next();
}
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = auth.listUsers();
  res.json({ success: true, count: users.length, users });
});

/* ---- ADMIN: diagnose email (SMTP) ----
   GET /api/admin/email-test?key=…&to=you@example.com
   Reports the SMTP config, whether connect+login works (or the exact error),
   and (if ?to= given) whether a test message actually sends. */
app.get('/api/admin/email-test', requireAdmin, async (req, res) => {
  const out = { config: mailer.config() };
  try {
    await mailer.verify();
    out.verify = 'ok';
  } catch (e) {
    out.verify = 'FAILED';
    out.verifyError = e.message;
    return res.json(out);
  }
  if (req.query.to) {
    try {
      await mailer.sendMail({
        to: String(req.query.to),
        subject: 'Ever Nova Life — email test',
        text: 'Test email from your Ever Nova Life server. If you got this, sending works.',
        html: '<p>Test email from your Ever Nova Life server. If you got this, <strong>sending works</strong>.</p>'
      });
      out.testSend = 'sent to ' + req.query.to;
    } catch (e) {
      out.testSend = 'FAILED';
      out.sendError = e.message;
    }
  }
  res.json(out);
});

/* ---- forgot password: email a reset link ----
   Always responds the same way whether or not the email exists, so this
   can't be used to discover which emails are registered. */
app.post('/api/auth/forgot', async (req, res) => {
  const generic = { success: true, message: 'If that email has an account, a reset link is on its way. Check your inbox (and spam).' };
  try {
    const addr = (req.body && req.body.email) || '';
    const result = await auth.createResetToken(addr);
    if (result) {
      const base = (process.env.SITE_URL || req.headers.origin || '').replace(/\/+$/, '');
      const link = `${base}/reset-password.html?token=${result.token}`;
      const subject = 'Reset your Ever Nova Life password';
      const text = `We received a request to reset your Ever Nova Life password.\n\n` +
        `Open this link to choose a new password (valid for 1 hour):\n${link}\n\n` +
        `If you didn't request this, you can safely ignore this email — your password won't change.`;
      const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
        <h2 style="color:#6d28d9">Reset your password</h2>
        <p>We received a request to reset your <strong>Ever Nova Life</strong> password.</p>
        <p><a href="${link}" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Choose a new password</a></p>
        <p style="color:#6b7280;font-size:13px">This link is valid for 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>
        <p style="color:#9ca3af;font-size:12px;word-break:break-all">Or paste this into your browser:<br>${link}</p>
      </div>`;

      if (mailer.CONFIGURED) {
        try {
          await mailer.sendMail({ to: result.user.email, subject, text, html });
        } catch (mailErr) {
          console.error('[forgot] email send failed:', mailErr.message);
        }
      } else {
        // No SMTP set up yet — log the link so resets still work in dev/testing.
        console.warn(`[forgot] EMAIL NOT CONFIGURED — reset link for ${result.user.email}:\n  ${link}`);
      }
    }
    res.json(generic);
  } catch (err) {
    console.error('[forgot] failed:', err.message);
    res.json(generic);   // never leak details on this endpoint
  }
});

/* ---- reset password: consume the token + set the new password ---- */
app.post('/api/auth/reset', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    await auth.resetPassword(token, password);
    res.json({ success: true, message: 'Your password has been reset. You can now sign in.' });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
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
