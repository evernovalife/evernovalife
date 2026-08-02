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
const zelle = require('./zelle.js');
const auth = require('./auth.js');
const store = require('./store.js');
const loyalty = require('./loyalty.js');
const subscriptions = require('./subscriptions.js');
const productStore = require('./products.js');
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
// Limit is generous (8mb) so admins can upload a product image as a data URL.
app.use(express.json({
  limit: '8mb',
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
  zelle: zelle.CONFIGURED,        // Zelle (manual bank transfer) ready?
  auth: true,                     // email/password accounts always available
  email: mailer.CONFIGURED,       // reset + welcome emails (Gmail SMTP) ready?
  autoship: braintree.CONFIGURED, // recurring shipments need the card vault
  cron: !!CRON_KEY                // is the scheduled-charge trigger armed?
}));

/* ============================================================
   AUTH — email + password accounts
   Passwords are bcrypt-hashed; a signed JWT is returned on
   register/login and sent back as "Authorization: Bearer <token>".
   ============================================================ */

/* ---- create an account ---- */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { firstName, lastName, email, password, ref } = req.body || {};
    const result = await auth.registerUser({ firstName, lastName, email, password, ref });
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

/* Like requireAuth, but never rejects: if a valid token is present it
   attaches req.user, otherwise it just continues as a guest.
   NOTE: checkout no longer uses this — as of the 2026-08 compliance
   review an account is REQUIRED to order, so every payment route runs
   auth.requireAuth. Kept for routes that may serve guests. */
function optionalAuth(req, _res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const payload = m && auth.verifyToken(m[1]);
  if (payload) {
    const user = auth.getUserById(payload.sub);
    if (user) req.user = user;
  }
  next();
}

/* A short, human-friendly order reference. */
function newOrderId() {
  return 'ENL-' + Date.now().toString(36).toUpperCase();
}

/* ============================================================
   SHIPPING SCOPE — U.S. addresses only.
   The checkout form only offers "United States", but the form is
   the client's copy: enforce it here too, on every payment path,
   so a tampered request can't place an international order.
   The browser sends `countryCode`; other callers may send
   `country` — accept either, require one of them.
   ============================================================ */
const US_COUNTRY = /^(US|USA|UNITED STATES|UNITED STATES OF AMERICA)$/;

/* ---- Research qualification, required on every order.
   The buyer must name the institution/lab the material is going to and pick
   the research field it's for. Checked server-side so the record we keep is
   never empty just because someone bypassed the form. ---- */
const RESEARCH_FIELDS = [
  'Molecular Biology',
  'Biochemistry',
  'Peptide Chemistry',
  'Chemical Biology',
  'Biotechnology Research',
  'Academic Research'
];

function assertResearchDetails(shipping) {
  const institution = String((shipping && shipping.institution) || '').trim();
  const field = String((shipping && shipping.researchField) || '').trim();
  if (!institution) {
    throw new Error('An institution or lab name is required to order.');
  }
  if (!field) {
    throw new Error('Please select the research field this order is for.');
  }
  if (!RESEARCH_FIELDS.includes(field)) {
    throw new Error('Please select a research field from the list.');
  }
}

function assertUsShipping(shipping) {
  const raw = String((shipping && (shipping.countryCode || shipping.country)) || '')
    .trim().toUpperCase();
  if (!raw) {
    throw new Error('A U.S. shipping country is required — we ship within the United States only.');
  }
  if (!US_COUNTRY.test(raw)) {
    throw new Error('We ship within the United States only. Please use a U.S. delivery address.');
  }
}

/* ============================================================
   CART — a signed-in user's cart, saved server-side so it
   follows them across devices/browsers.
   ============================================================ */
app.get('/api/cart', auth.requireAuth, (req, res) => {
  res.json({ success: true, items: store.getCart(req.user.id) });
});

app.put('/api/cart', auth.requireAuth, (req, res) => {
  const items = store.saveCart(req.user.id, (req.body && req.body.items) || []);
  res.json({ success: true, items });
});

/* ============================================================
   ORDERS — the signed-in user's order history.
   ============================================================ */
app.get('/api/orders', auth.requireAuth, (req, res) => {
  res.json({ success: true, orders: store.listOrders(req.user.id) });
});

/* ============================================================
   LOYALTY — the signed-in user's points balance + history, and
   the conversion rates the UI needs to show "N points ≈ $X".
   Points are EARNED/REDEEMED server-side during checkout; this
   endpoint is read-only.
   ============================================================ */
app.get('/api/loyalty', auth.requireAuth, (req, res) => {
  const acct = loyalty.getAccount(req.user.id);
  res.json({
    success: true,
    balance: acct.balance,
    dollarValue: loyalty.pointsToDollars(acct.balance),
    ledger: acct.ledger.slice(0, 50),
    perDollar: loyalty.POINTS_PER_DOLLAR,
    valueCents: loyalty.POINTS_VALUE_CENTS
  });
});

/* ============================================================
   REFERRAL — the signed-in user's share code, a ready-made invite
   link, how many people they've referred, and the reward size.
   ============================================================ */
app.get('/api/referral', auth.requireAuth, (req, res) => {
  const stats = auth.getReferralStats(req.user.id);
  const base = (process.env.SITE_URL || req.headers.origin || '').replace(/\/+$/, '');
  const link = (base || '') + '/register.html?ref=' + encodeURIComponent(stats.code);
  res.json({
    success: true,
    code: stats.code,
    link,
    referredCount: stats.referredCount,
    rewardedCount: stats.rewardedCount,
    rewardPoints: loyalty.REFERRAL_REWARD_POINTS
  });
});

/* ============================================================
   AUTO-SHIP — repeating shipments ("subscriptions")
   A customer turns a checkout into a standing order: the same
   items, re-charged to the card they saved, every N days of their
   choosing. Nothing about the money is trusted from the browser —
   every run re-prices against the live catalog and charges a token
   held in Braintree's vault.

   The scheduler lives further down (runDueSubscriptions); these
   routes are the customer's controls over their own plans.
   ============================================================ */

/* ---- my plans ---- */
app.get('/api/subscriptions', auth.requireAuth, (req, res) => {
  res.json({
    success: true,
    subscriptions: subscriptions.listForUser(req.user.id).map(subscriptions.publicSubscription),
    minDays: subscriptions.MIN_DAYS,
    maxDays: subscriptions.MAX_DAYS,
    defaultDays: subscriptions.DEFAULT_DAYS
  });
});

/* ---- start a plan outside of a checkout ----
   Either vaults a fresh Drop-in nonce, or reuses a card already saved on one
   of this account's other plans. No charge happens now — the first recurring
   shipment lands one interval from today. */
app.post('/api/subscriptions', auth.requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const order = buildOrder(body.items);   // validates ids/quantities + previews the price

    // Check the request is complete before touching the payment gateway — a
    // missing field is the caller's problem, not something to spend a
    // round-trip (and a stray Braintree customer record) discovering.
    if (!body.nonce && !body.paymentMethodToken) {
      return res.status(400).json({ error: 'A payment method is required to start auto-ship.' });
    }

    const customerId = await braintree.findOrCreateCustomer({
      id: req.user.id,
      email: body.email || req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName
    });

    let token = '';
    let label = 'Saved payment method';
    if (body.nonce) {
      const vaulted = await braintree.vaultPaymentMethod({
        customerId, nonce: body.nonce, deviceData: body.deviceData
      });
      token = vaulted.token;
      label = vaulted.label;
    } else if (body.paymentMethodToken) {
      // Never take the caller's word for it — confirm the vault entry is on
      // THIS customer before pointing a recurring charge at it.
      const owned = await braintree.paymentMethodBelongsTo(body.paymentMethodToken, customerId);
      if (!owned) return res.status(400).json({ error: 'That saved payment method is not on your account.' });
      token = body.paymentMethodToken;
      const known = subscriptions.listForUser(req.user.id).find(s => s.paymentMethodToken === token);
      if (known && known.paymentLabel) label = known.paymentLabel;
    }

    const sub = subscriptions.create(req.user.id, {
      items: orderToSubscriptionItems(order),
      intervalDays: body.intervalDays,
      paymentMethodToken: token,
      paymentLabel: label,
      braintreeCustomerId: customerId,
      email: body.email || req.user.email,
      shippingAddress: body.shipping
    });

    res.status(201).json({ success: true, subscription: subscriptions.publicSubscription(sub) });
    sendSubscriptionCreatedEmail(req.user, sub)
      .catch(err => console.error('[autoship email] failed:', err.message));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/* ---- change a plan: frequency, items, address, pause/resume, skip next ---- */
app.patch('/api/subscriptions/:id', auth.requireAuth, (req, res) => {
  try {
    const sub = subscriptions.get(req.params.id, req.user.id);
    if (!sub) return res.status(404).json({ error: 'No auto-ship plan with that id.' });

    const body = req.body || {};
    if (body.items) buildOrder(body.items);   // reject unknown / out-of-stock items up front

    const patch = subscriptions.applyCustomerEdits(sub, body);
    const updated = subscriptions.update(sub.id, req.user.id, patch);
    res.json({ success: true, subscription: subscriptions.publicSubscription(updated) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/* ---- cancel a plan (kept as history; never charged again) ---- */
app.delete('/api/subscriptions/:id', auth.requireAuth, (req, res) => {
  const cancelled = subscriptions.cancel(req.params.id, req.user.id);
  if (!cancelled) return res.status(404).json({ error: 'No auto-ship plan with that id.' });
  res.json({ success: true, subscription: subscriptions.publicSubscription(cancelled) });
  sendSubscriptionCancelledEmail(req.user, cancelled)
    .catch(err => console.error('[autoship email] failed:', err.message));
});

/* Cart-shaped items for a plan, taken from an order priced by pricing.js.
   Only id + quantity are ever authoritative; name/price ride along so the
   account page can show something without a catalog lookup. */
function orderToSubscriptionItems(order) {
  return order.items.map(i => ({ id: i.id, name: i.name, price: i.unitPrice, quantity: i.quantity }));
}

/* ============================================================
   PRODUCTS — admin-managed catalog.
   GET is public (the storefront reads it). Add/edit/delete are
   admin-only (same requireAdmin as the user tools).
   ============================================================ */
app.get('/api/products', (req, res) => {
  res.json({ success: true, products: productStore.listProducts(), categories: productStore.CATEGORIES });
});

app.post('/api/products', requireAdmin, (req, res) => {
  try {
    const product = productStore.addProduct(req.body || {});
    res.status(201).json({ success: true, product });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
  try {
    const product = productStore.updateProduct(req.params.id, req.body || {});
    if (!product) return res.status(404).json({ error: 'No product with that id.' });
    res.json({ success: true, product });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const removed = productStore.deleteProduct(req.params.id);
  if (!removed) return res.status(404).json({ error: 'No product with that id.' });
  res.json({ success: true, deleted: removed });
});

/* ---- ADMIN: list everyone who has signed up ----
   Protected by ADMIN_KEY (sent as the "x-admin-key" header or ?key=…).
   Returns public fields only — never password hashes. */
const ADMIN_KEY = process.env.ADMIN_KEY || '';
/* Admin access is granted two ways:
     1. Signed in as an admin account (email in ADMIN_EMAILS/ADMIN_EMAIL) — the
        "main account" flow; attaches req.user.
     2. The admin key (x-admin-key header or ?key=) — kept for tools/back-compat.
   Either one is sufficient. */
function requireAdmin(req, res, next) {
  // 1) admin account via Bearer token
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const payload = m && auth.verifyToken(m[1]);
  if (payload) {
    const user = auth.getUserById(payload.sub);
    if (user && user.isAdmin) { req.user = user; return next(); }
  }
  // 2) admin key
  const key = req.get('x-admin-key') || req.query.key || '';
  if (ADMIN_KEY && key && key === ADMIN_KEY) return next();

  if (!ADMIN_KEY && !auth.ADMIN_ENABLED) {
    return res.status(503).json({ error: 'Admin is not set up yet (set ADMIN_EMAIL/ADMIN_EMAILS or ADMIN_KEY in the server env).' });
  }
  return res.status(401).json({ error: 'Admin access required. Sign in with the admin account, or provide the admin key.' });
}
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = auth.listUsers();
  res.json({ success: true, count: users.length, users });
});

/* ---- ADMIN: delete a user account ----
   Removes the account and cascades to their saved cart + orders. An admin
   signed in with their account can't delete themselves (avoids self-lockout). */
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  if (req.user && req.user.id === id) {
    return res.status(400).json({ error: "You can't delete the account you're currently signed in with." });
  }
  const removed = auth.deleteUser(id);
  if (!removed) return res.status(404).json({ error: 'No account with that id.' });
  try { store.deleteUserData(id); } catch (e) { console.error('[admin delete] cleanup failed:', e.message); }
  try { loyalty.deleteUser(id); } catch (e) { console.error('[admin delete] loyalty cleanup failed:', e.message); }
  // Critical: drop their auto-ship plans too, or the scheduler would keep
  // charging a card for an account that no longer exists.
  try { subscriptions.deleteUserData(id); } catch (e) { console.error('[admin delete] autoship cleanup failed:', e.message); }
  res.json({ success: true, deleted: removed });
});

/* ---- ADMIN: bring a plan's next shipment forward to now ----
   Two real uses: testing the whole cycle without waiting weeks, and customer
   service ("send my next one early"). It only moves the DATE — the charge still
   goes through the normal scheduled run, with all its guards. */
app.post('/api/admin/subscriptions/:id/due-now', requireAdmin, (req, res) => {
  const sub = subscriptions.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'No auto-ship plan with that id.' });
  if (sub.status !== 'active') {
    return res.status(400).json({ error: `That plan is ${sub.status} — resume it first.` });
  }
  const updated = subscriptions.update(sub.id, null, {
    nextRunAt: new Date().toISOString(),
    reminderSentFor: ''
  });
  res.json({ success: true, subscription: subscriptions.publicSubscription(updated) });
});

/* ---- ADMIN: every auto-ship plan, with who it belongs to ---- */
app.get('/api/admin/subscriptions', requireAdmin, (req, res) => {
  const all = subscriptions.listAll()
    .map(s => {
      const owner = auth.getUserById(s.userId);
      return {
        ...subscriptions.publicSubscription(s),
        userId: s.userId,
        userEmail: owner ? owner.email : '(deleted account)',
        userName: owner ? `${owner.firstName} ${owner.lastName}`.trim() : ''
      };
    })
    .sort((a, b) => String(a.scheduledFor || '').localeCompare(String(b.scheduledFor || '')));
  res.json({ success: true, count: all.length, subscriptions: all });
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

/* ---- LOYALTY / REFERRAL bookkeeping helpers ----
   Turn a validated redemption request into a discount BEFORE pricing, so the
   amount we charge already reflects it. We work out the actual points to spend
   from the discount pricing.js ends up applying (it clamps to the subtotal), so
   points and dollars can never drift apart. The points are only DEDUCTED after
   the charge succeeds (see the checkout handlers). Guests can't redeem. */
function plannedDiscount(user, pointsToRedeem) {
  if (!user) return 0;
  const requested = Math.max(0, Math.floor(Number(pointsToRedeem) || 0));
  if (!requested) return 0;
  const usePoints = Math.min(requested, loyalty.getBalance(user.id));
  return loyalty.pointsToDollars(usePoints);
}

/* After a paid order: deduct redeemed points, grant earned points, and process
   any pending referral reward. Returns { pointsEarned, pointsRedeemed } for the
   stored record + the API response. */
function settleLoyaltyForPaidOrder(userId, orderId, order) {
  let pointsRedeemed = 0, pointsEarned = 0;
  try {
    pointsRedeemed = order.discount > 0 ? loyalty.centsToPoints(Math.round(order.discount * 100)) : 0;
    if (pointsRedeemed > 0) loyalty.redeem(userId, pointsRedeemed, 'Redeemed at checkout', { orderId });
    // earn on the cash actually spent on product (subtotal minus any discount)
    pointsEarned = loyalty.earnForAmount(order.subtotal - order.discount);
    if (pointsEarned > 0) loyalty.earn(userId, pointsEarned, 'Order ' + orderId, { orderId });
  } catch (e) {
    console.error('[loyalty] settle failed:', e.message);
  }
  awardReferral(userId);
  return { pointsEarned, pointsRedeemed };
}

/* Referral reward — granted once, on the referred buyer's first paid order.
   Credits loyalty points to BOTH the referrer and the new customer, then (if
   email is configured) tells the referrer. Safe to call on every paid order:
   auth.claimReferralReward returns null after the first successful claim. */
function awardReferral(userId) {
  let claim;
  try { claim = auth.claimReferralReward(userId); }
  catch (e) { console.error('[referral] claim failed:', e.message); return; }
  if (!claim) return;
  const pts = loyalty.REFERRAL_REWARD_POINTS;
  if (pts > 0) {
    try {
      loyalty.earn(claim.referrerId, pts, 'Referral reward', {});
      loyalty.earn(claim.refereeId, pts, 'Referral welcome bonus', {});
    } catch (e) { console.error('[referral] credit failed:', e.message); }
  }
  sendReferralRewardEmail(claim.referrerId, pts)
    .catch(err => console.error('[referral email] failed:', err.message));
}

async function sendReferralRewardEmail(referrerId, points) {
  if (!mailer.CONFIGURED || points <= 0) return;
  const referrer = auth.getUserById(referrerId);
  if (!referrer || !referrer.email) return;
  const name = referrer.firstName || 'there';
  const dollars = loyalty.pointsToDollars(points).toFixed(2);
  const subject = 'You earned a referral reward 🎁';
  const text = `Hi ${name},\n\n` +
    `Someone you referred just placed their first order on Ever Nova Life — so we've added ` +
    `${points} reward points (worth $${dollars}) to your account. Thanks for spreading the word!\n\n` +
    `— The Ever Nova Life team`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="color:#6d28d9">You earned a referral reward 🎁</h2>
    <p>Hi ${escapeHtmlSrv(name)}, someone you referred just placed their first order on <strong>Ever Nova Life</strong>.</p>
    <p>We've added <strong>${points} reward points</strong> (worth $${dollars}) to your account. Thanks for spreading the word!</p>
  </div>`;
  return mailer.sendMail({ to: referrer.email, subject, text, html });
}

/* ---- checkout: price it HERE (never trust the browser's total), then sell ---- */
app.post('/api/checkout', auth.requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    assertResearchDetails(body.shipping);
    assertUsShipping(body.shipping);                      // U.S. addresses only
    // Loyalty redemption (signed-in only) is folded into the price up-front so
    // the charge already reflects it; the points are spent only on success.
    const discount = plannedDiscount(req.user, body.pointsToRedeem);
    const order = buildOrder(body.items, { discount });   // authoritative price
    const orderId = newOrderId();

    /* Auto-ship opt-in. Signed-in only — a repeating charge needs an account
       to manage and cancel it. When they opt in we attach this sale to a
       Braintree customer and keep the payment method in the vault, so the
       scheduler can charge it again without the card ever touching our server.
       If any of that fails we let the one-off sale go through anyway rather
       than blocking a purchase over a convenience feature. */
    const wantsAutoship = !!(req.user && body.autoship && body.autoship.enabled);
    let customerId = '';
    if (wantsAutoship) {
      try {
        customerId = await braintree.findOrCreateCustomer({
          id: req.user.id,
          email: body.email || req.user.email,
          firstName: req.user.firstName,
          lastName: req.user.lastName
        });
      } catch (e) {
        console.error('[autoship] could not prepare the saved card:', e.message);
      }
    }

    const transaction = await braintree.createTransaction({
      order,
      nonce: body.nonce,
      deviceData: body.deviceData,
      shipping: body.shipping,
      email: body.email,
      orderId,
      // The card networks want the first sale in a series flagged as such;
      // scheduled charges later go out as 'recurring'.
      ...(customerId ? { customerId, storeInVault: true, source: 'recurring_first' } : {})
    });

    let pointsEarned = 0, pointsRedeemed = 0;

    // Signed in? Record the order on their account and empty their saved cart.
    if (req.user) {
      try {
        ({ pointsEarned, pointsRedeemed } = settleLoyaltyForPaidOrder(req.user.id, orderId, order));
        store.addOrder(req.user.id, buildOrderRecord({
          orderId, order, method: 'card', status: 'paid',
          email: body.email, shipping: body.shipping,
          transactionId: transaction.id,
          pointsEarned, pointsRedeemed
        }));
        store.clearCart(req.user.id);
      } catch (e) {
        console.error('[checkout] could not save order:', e.message);
      }
    }

    // The sale is done and recorded — now set up the repeat, if they asked for
    // one. This order IS the first shipment, so the plan's first recurring
    // charge is one full interval away.
    let subscription = null;
    if (wantsAutoship && customerId) {
      try {
        const vaulted = braintree.vaultedMethodFrom(transaction);
        if (!vaulted) throw new Error('Braintree did not return a saved payment method.');
        const sub = subscriptions.create(req.user.id, {
          items: orderToSubscriptionItems(order),
          intervalDays: body.autoship.intervalDays,
          paymentMethodToken: vaulted.token,
          paymentLabel: vaulted.label,
          braintreeCustomerId: customerId,
          email: body.email || req.user.email,
          shippingAddress: body.shipping,
          firstOrderId: orderId
        });
        subscription = subscriptions.publicSubscription(sub);
        sendSubscriptionCreatedEmail(req.user, sub)
          .catch(err => console.error('[autoship email] failed:', err.message));
      } catch (e) {
        console.error('[autoship] could not start the plan:', e.message);
      }
    }

    res.status(201).json({
      success: true,
      orderId,
      transactionId: transaction.id,
      status: transaction.status,                          // e.g. "submitted_for_settlement"
      amount: transaction.amount,
      total: order.total,
      discount: order.discount,
      pointsEarned,
      pointsRedeemed,
      subscription,
      // Tell the browser when auto-ship was asked for but couldn't be set up,
      // so the confirmation can be honest instead of silently dropping it.
      autoshipFailed: wantsAutoship && !subscription
    });
  } catch (err) {
    console.error('[checkout] failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

/* Shape a stored order record from a priced order + payment details.
   `order.shipping` is the shipping COST (from pricing.js); the delivery
   address arrives separately as `shipping`, stored as shippingAddress so
   the two never collide. */
function buildOrderRecord({ orderId, order, method, status, email, shipping, transactionId, invoiceId, pointsEarned, pointsRedeemed, subscriptionId }) {
  return {
    orderId,
    createdAt: new Date().toISOString(),
    status,
    method,
    items: order.items,          // [{ id, name, unitPrice, quantity, lineTotal }]
    subtotal: order.subtotal,
    discount: order.discount || 0,
    shippingCost: order.shipping,
    tax: order.tax,
    total: order.total,
    email: email || '',
    shippingAddress: shipping || null,
    ...(pointsEarned ? { pointsEarned } : {}),
    ...(pointsRedeemed ? { pointsRedeemed } : {}),
    ...(transactionId ? { transactionId } : {}),
    ...(invoiceId ? { invoiceId } : {}),
    ...(subscriptionId ? { subscriptionId } : {})   // marks an auto-ship shipment
  };
}

/* ============================================================
   CRYPTO CHECKOUT — Bitcoin / Lightning via BTCPay Server
   Same rule as cards: price the cart HERE, never trust the
   browser's total. We open a hosted BTCPay invoice and hand the
   browser its checkoutLink to redirect to.
   ============================================================ */

/* ---- open a BTCPay invoice for the (server-priced) cart ---- */
app.post('/api/crypto/checkout', auth.requireAuth, async (req, res) => {
  if (!btcpay.CONFIGURED) {
    return res.status(500).json({ error: 'Crypto payments are not set up yet (missing BTCPay keys in server/.env).' });
  }
  try {
    const body = req.body || {};
    assertResearchDetails(body.shipping);
    assertUsShipping(body.shipping);                            // U.S. addresses only
    const order = buildOrder(body.items);                       // authoritative price
    const orderId = newOrderId();

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

    // Signed in? Record the order as pending now; the webhook flips it to
    // paid once BTCPay confirms the on-chain payment. Empty their saved cart
    // so the same items don't linger after they've committed to buying.
    if (req.user) {
      try {
        store.addOrder(req.user.id, buildOrderRecord({
          orderId, order, method: 'crypto', status: 'pending',
          email: body.email, shipping: body.shipping,
          invoiceId: invoice.id
        }));
        store.clearCart(req.user.id);
      } catch (e) {
        console.error('[crypto checkout] could not save order:', e.message);
      }
    }

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

  // Move the stored order to its final state. Only signed-in orders were
  // recorded (guest orders have no owner to attach to), so updateOrderStatus
  // simply no-ops when the order isn't found.
  if (evt.type === 'InvoiceSettled') {
    markOrderPaid(orderId);
  } else if (evt.type === 'InvoiceExpired' || evt.type === 'InvoiceInvalid') {
    store.updateOrderStatus(orderId, 'cancelled');
  }

  res.json({ ok: true });
});

/* Move an order to paid and credit the buyer for it. Shared by every payment
   that confirms AFTER the order was created: the BTCPay webhook, and an admin
   confirming a Zelle transfer landed. Points and referral rewards are granted
   only on the FIRST transition to paid, so a repeated webhook delivery — or a
   double-click in admin — can't credit twice. Returns the store's update
   result ({ userId, order, previousStatus }) or null when the reference matches
   no stored order. */
function markOrderPaid(orderId, patch) {
  const upd = store.updateOrderStatus(orderId, 'paid', {
    paidAt: new Date().toISOString(),
    ...(patch || {})
  });
  if (!upd || upd.previousStatus === 'paid') return upd;
  if (upd.userId === store.GUEST_KEY) return upd;      // guest order — no account to credit
  try {
    const o = upd.order;
    const earned = loyalty.earnForAmount((o.subtotal || 0) - (o.discount || 0));
    if (earned > 0) {
      loyalty.earn(upd.userId, earned, 'Order ' + (o.orderId || ''), { orderId: o.orderId });
      store.updateOrderStatus(orderId, null, { pointsEarned: earned });   // stamp for display
    }
    awardReferral(upd.userId);
  } catch (e) {
    console.error('[order paid] loyalty/referral failed:', e.message);
  }
  return upd;
}

/* ============================================================
   ZELLE CHECKOUT — manual bank transfer
   Zelle has no API, no redirect and no webhook (see zelle.js), so
   this is an offline flow with an online paper trail:
     1. we price the cart HERE and open the order as
        "awaiting_payment", with the order reference as the memo
     2. the buyer sends the money from their own banking app
     3. the owner sees it land, and confirms it in admin.html —
        which is what actually marks the order paid
   Nothing ships on step 1. The order is a claim, not a payment.
   ============================================================ */

/* ---- place an order to be paid by Zelle ---- */
app.post('/api/zelle/checkout', auth.requireAuth, async (req, res) => {
  if (!zelle.CONFIGURED) {
    return res.status(500).json({ error: 'Zelle payment is not set up yet (missing ZELLE_* keys in server/.env).' });
  }
  try {
    const body = req.body || {};
    assertResearchDetails(body.shipping);
    assertUsShipping(body.shipping);                            // U.S. addresses only
    // No points discount here: the money arrives by hand, so there's no charge
    // to reduce, and reserving points against an order that may never be paid
    // would strand them. The UI hides Zelle while points are being redeemed.
    const order = buildOrder(body.items);                       // authoritative price
    zelle.assertPayable({ order, shipping: body.shipping });     // US-only + send-limit guards

    const orderId = newOrderId();
    const instructions = zelle.instructions({ orderId, order });

    // Record it whether or not they're signed in. A guest order still has to be
    // reconcilable — otherwise the money arrives with a reference that matches
    // nothing, and the owner has no idea what to ship or where.
    const record = buildOrderRecord({
      orderId, order, method: 'zelle', status: 'awaiting_payment',
      email: body.email, shipping: body.shipping
    });
    record.expiresAt = instructions.expiresAt;

    try {
      store.addOrder(req.user ? req.user.id : store.GUEST_KEY, record);
      if (req.user) store.clearCart(req.user.id);
    } catch (e) {
      console.error('[zelle checkout] could not save order:', e.message);
      return res.status(500).json({ error: 'We could not record your order. Nothing has been charged — please try again.' });
    }

    res.status(201).json({ success: true, orderId, total: order.total, instructions });

    // After responding: the buyer needs these details in writing, and the owner
    // needs to know money is on its way. Neither should be able to fail the sale.
    sendZelleInstructionsEmail({ email: body.email, orderId, order, instructions })
      .catch(err => console.error('[zelle email] failed:', err.message));
    notifyAdminOfZelleOrder({ orderId, order, email: body.email, instructions })
      .catch(err => console.error('[zelle admin-notify] failed:', err.message));
  } catch (err) {
    console.error('[zelle checkout] failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

/* ============================================================
   ADMIN — orders + confirming manual payments
   ============================================================ */

/* ---- ADMIN: every order, newest first. ?status=awaiting_payment narrows it
   to the ones waiting on a manual transfer, which is the working queue. ---- */
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const want = String(req.query.status || '').trim().toLowerCase();
  const orders = store.listAllOrders()
    .filter(o => !want || String(o.status || '').toLowerCase() === want)
    .map(o => {
      const guest = o.userId === store.GUEST_KEY;
      const owner = guest ? null : auth.getUserById(o.userId);
      return {
        ...o,
        guest,
        userEmail: guest ? (o.email || '(guest)') : (owner ? owner.email : '(deleted account)'),
        userName: owner ? `${owner.firstName} ${owner.lastName}`.trim() : ''
      };
    });
  res.json({ success: true, count: orders.length, orders });
});

/* ---- ADMIN: confirm the money landed → mark the order paid ----
   This is the only thing that turns a Zelle order into a real sale, so it's
   deliberately manual: the owner checks their bank, matches the memo against
   the order reference, and confirms. Idempotent — confirming twice reports
   alreadyPaid instead of crediting points again. */
app.post('/api/admin/orders/:orderId/paid', requireAdmin, (req, res) => {
  const ref = String((req.body && req.body.paymentRef) || '').slice(0, 120);
  const upd = markOrderPaid(req.params.orderId, {
    confirmedBy: (req.user && req.user.email) || 'admin key',
    ...(ref ? { paymentRef: ref } : {})
  });
  if (!upd) return res.status(404).json({ error: 'No order with that reference.' });
  if (upd.previousStatus === 'paid') {
    return res.json({ success: true, alreadyPaid: true, order: upd.order });
  }
  sendPaymentConfirmedEmail(upd.order)
    .catch(err => console.error('[payment confirmed email] failed:', err.message));
  res.json({ success: true, order: upd.order });
});

/* ---- ADMIN: cancel an order that was never paid ----
   Refuses to touch a paid one: cancelling a sale that took money is a refund,
   which has to happen in the bank, not here. */
app.post('/api/admin/orders/:orderId/cancel', requireAdmin, (req, res) => {
  const existing = store.listAllOrders().find(o => o.orderId === req.params.orderId);
  if (!existing) return res.status(404).json({ error: 'No order with that reference.' });
  if (String(existing.status).toLowerCase() === 'paid') {
    return res.status(400).json({ error: 'That order is already paid — refund it in your bank, then adjust it here.' });
  }
  const upd = store.updateOrderStatus(req.params.orderId, 'cancelled', {
    cancelledAt: new Date().toISOString(),
    cancelledBy: (req.user && req.user.email) || 'admin key'
  });
  res.json({ success: true, order: upd && upd.order });
});

/* ---- emails around a manual payment ---- */

/* Shared wrapper so the Zelle emails match the rest of the site. */
function zelleEmailHtml({ heading, intro, rowsHtml, extraHtml }) {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="color:#6d28d9;margin-bottom:4px">${escapeHtmlSrv(heading)}</h2>
    <p>${intro}</p>
    ${rowsHtml || ''}
    ${extraHtml || ''}
    <p style="color:#9ca3af;font-size:12px;margin-top:24px">All products are sold strictly for in-vitro research and laboratory use only. Not for human consumption.</p>
  </div>`;
}

/* The buyer needs the payment details somewhere they can't lose them — the
   confirmation screen closes, the email doesn't. */
async function sendZelleInstructionsEmail({ email, orderId, order, instructions }) {
  if (!mailer.CONFIGURED || !email) return;
  const lines = zelle.instructionLines(instructions);
  const rowsHtml = `<table style="border-collapse:collapse;margin:14px 0;font-size:15px">
    <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Send to</td><td><strong>${escapeHtmlSrv(instructions.recipient)}</strong> (${escapeHtmlSrv(instructions.recipientName)})</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Amount</td><td><strong>$${escapeHtmlSrv(instructions.amount.toFixed(2))} ${escapeHtmlSrv(instructions.currency)}</strong></td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Memo</td><td><strong>${escapeHtmlSrv(instructions.memo)}</strong></td></tr>
    ${instructions.bank ? `<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Our bank</td><td>${escapeHtmlSrv(instructions.bank)}</td></tr>` : ''}
  </table>`;
  return mailer.sendMail({
    to: email,
    subject: `Complete your Ever Nova Life order ${orderId} with Zelle`,
    text: `Thanks for your order.\n\n` +
      `Your order is being held for ${instructions.windowHours} hours while we wait for your Zelle transfer.\n\n` +
      lines.join('\n') + '\n\n' +
      `Send it from your bank's app or website (look for "Send money with Zelle"). Put the memo above on the ` +
      `transfer — that's how we match your payment to your order.\n\n` +
      `Order total: $${order.total.toFixed(2)}\nOrder reference: ${orderId}\n\n` +
      `We'll email you again as soon as the payment lands, and ship after that.\n\n— The Ever Nova Life team`,
    html: zelleEmailHtml({
      heading: 'One step left — send your Zelle payment',
      intro: `Thanks for your order. We're holding it for <strong>${escapeHtmlSrv(String(instructions.windowHours))} hours</strong> while we wait for your transfer.`,
      rowsHtml,
      extraHtml: `<p style="font-size:14px">Send it from your bank's app or website — look for <em>"Send money with Zelle"</em>. ` +
        `Please put <strong>${escapeHtmlSrv(instructions.memo)}</strong> in the memo; that's how we match your payment to your order.</p>
        <p style="color:#6b7280;font-size:14px">Order reference: <strong>${escapeHtmlSrv(orderId)}</strong> · Total: <strong>$${escapeHtmlSrv(order.total.toFixed(2))}</strong><br>
        We'll email you the moment it lands, and ship after that. Nothing has been charged to any card.</p>`
    })
  });
}

/* The owner has to go looking in their bank for this money, so tell them it's
   coming — with the memo they'll be matching against. */
async function notifyAdminOfZelleOrder({ orderId, order, email, instructions }) {
  const to = process.env.ADMIN_EMAIL || '';
  if (!mailer.CONFIGURED || !to) return;
  const items = (order.items || []).map(i => `${i.quantity}× ${i.name}`).join(', ');
  return mailer.sendMail({
    to,
    subject: `Zelle order awaiting payment: ${orderId} ($${order.total.toFixed(2)})`,
    text: `A buyer has placed an order to pay by Zelle.\n\n` +
      `Order:  ${orderId}\nTotal:  $${order.total.toFixed(2)}\nBuyer:  ${email || '(no email)'}\n` +
      `Items:  ${items}\nMemo to look for: ${instructions.memo}\n\n` +
      `When the transfer lands in your account, confirm it at ${SITE()}/admin.html — that's what marks the order paid ` +
      `and releases it for shipping.\n`,
    html: zelleEmailHtml({
      heading: 'Zelle order awaiting payment',
      intro: `A buyer has placed an order to pay by Zelle. Nothing ships until you confirm the money landed.`,
      rowsHtml: `<table style="border-collapse:collapse;margin:14px 0;font-size:15px">
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Order</td><td><strong>${escapeHtmlSrv(orderId)}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Total</td><td><strong>$${escapeHtmlSrv(order.total.toFixed(2))}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Buyer</td><td>${escapeHtmlSrv(email || '(no email)')}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Items</td><td>${escapeHtmlSrv(items)}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Memo</td><td><strong>${escapeHtmlSrv(instructions.memo)}</strong></td></tr>
      </table>`,
      extraHtml: `<p><a href="${SITE()}/admin.html" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Open admin</a></p>`
    })
  });
}

/* Sent when the owner confirms a manual payment — the buyer's "we got it". */
async function sendPaymentConfirmedEmail(order) {
  if (!mailer.CONFIGURED || !order || !order.email) return;
  const total = Number(order.total || 0).toFixed(2);
  return mailer.sendMail({
    to: order.email,
    subject: `Payment received — Ever Nova Life order ${order.orderId}`,
    text: `We've received your payment of $${total} for order ${order.orderId}. Thank you!\n\n` +
      `Your order is now being prepared and will ship to the address you gave us.\n\n— The Ever Nova Life team`,
    html: zelleEmailHtml({
      heading: 'Payment received ✅',
      intro: `We've received your payment of <strong>$${escapeHtmlSrv(total)}</strong> for order <strong>${escapeHtmlSrv(order.orderId)}</strong>. Thank you!`,
      extraHtml: `<p style="color:#6b7280;font-size:14px">Your order is now being prepared and will ship to the address you gave us.</p>`
    })
  });
}

/* ============================================================
   AUTO-SHIP SCHEDULER
   Charges every plan whose next shipment is due. Nothing here
   trusts stored money: each run re-prices the plan's items against
   the live catalog, so a price change or a delisted product is
   picked up automatically.

   Safety properties that matter when real cards are involved:
     · one plan is claimed for the duration of its run, so two
       overlapping triggers can't both charge it
     · the order reference is stamped on the Braintree transaction
       BEFORE charging, so a run interrupted mid-charge recognises
       the completed payment instead of taking the money twice
     · a decline retries a few times, then pauses the plan and
       emails the customer rather than hammering a dead card
     · the schedule advances from the date it was DUE, not from
       "now", so a late trigger never drifts the billing date
   ============================================================ */

const CRON_KEY = process.env.CRON_KEY || '';
const SUB_RUN_LIMIT = 25;   // plans charged per trigger — keeps one run bounded

/* Charge one plan. Never throws: every outcome comes back as a result object
   so one bad plan can't abort the whole batch. */
async function runOneSubscription(sub) {
  const claimed = subscriptions.claim(sub.id);
  if (!claimed) return { id: sub.id, status: 'skipped', reason: 'already running' };

  const user = auth.getUserById(claimed.userId);
  if (!user) {
    // The account was deleted out from under the plan — stop it for good.
    subscriptions.cancel(claimed.id, claimed.userId);
    return { id: sub.id, status: 'cancelled', reason: 'account no longer exists' };
  }

  try {
    // Recovering an interrupted run: did the charge actually go through?
    if (claimed.pendingOrderId) {
      const already = await braintree.findTransactionByOrderId(claimed.pendingOrderId);
      if (already) {
        subscriptions.recordSuccess(claimed.id, claimed.pendingOrderId);
        console.warn(`[autoship] ${claimed.id}: recovered an already-charged order ${claimed.pendingOrderId}`);
        return { id: sub.id, status: 'recovered', orderId: claimed.pendingOrderId };
      }
    }

    const order = buildOrder(claimed.items);            // authoritative, re-priced now
    const orderId = claimed.pendingOrderId || newOrderId();

    // Write the reference down BEFORE the money moves, so a crash between
    // these two lines is recoverable by the check above.
    subscriptions.update(claimed.id, null, { pendingOrderId: orderId });

    const transaction = await braintree.createTransaction({
      order,
      paymentMethodToken: claimed.paymentMethodToken,
      customerId: claimed.braintreeCustomerId,
      source: 'recurring',                              // merchant-initiated, stored credential
      orderId,
      shipping: claimed.shippingAddress,
      email: claimed.email || user.email
    });

    let pointsEarned = 0, pointsRedeemed = 0;
    try {
      ({ pointsEarned, pointsRedeemed } = settleLoyaltyForPaidOrder(user.id, orderId, order));
      store.addOrder(user.id, buildOrderRecord({
        orderId, order, method: 'card', status: 'paid',
        email: claimed.email || user.email,
        shipping: claimed.shippingAddress,
        transactionId: transaction.id,
        pointsEarned, pointsRedeemed,
        subscriptionId: claimed.id
      }));
    } catch (e) {
      // The charge succeeded — a bookkeeping failure must not look like a decline.
      console.error(`[autoship] ${claimed.id}: charged but could not record the order:`, e.message);
    }

    const updated = subscriptions.recordSuccess(claimed.id, orderId);
    sendSubscriptionChargedEmail(user, updated || claimed, order, orderId)
      .catch(err => console.error('[autoship email] failed:', err.message));

    return { id: sub.id, status: 'charged', orderId, total: order.total, transactionId: transaction.id };
  } catch (err) {
    const { sub: updated, paused } = subscriptions.recordFailure(claimed.id, err.message);
    sendSubscriptionFailedEmail(user, updated || claimed, err.message, paused)
      .catch(mailErr => console.error('[autoship email] failed:', mailErr.message));
    console.error(`[autoship] ${claimed.id}: ${paused ? 'PAUSED after repeated failures' : 'failed, will retry'} — ${err.message}`);
    return { id: sub.id, status: 'failed', paused, error: err.message };
  } finally {
    subscriptions.release(claimed.id);
  }
}

/* Email everyone whose next shipment is coming up. The "already reminded"
   stamp is written whether or not the email actually sent — one missed
   courtesy notice is better than an hourly retry loop. */
async function sendDueReminders(now) {
  const pending = subscriptions.listNeedingReminder(now);
  for (const sub of pending) {
    const user = auth.getUserById(sub.userId);
    if (!user) continue;
    try {
      await sendSubscriptionReminderEmail(user, sub);
    } catch (e) {
      console.error('[autoship reminder] failed:', e.message);
    }
    subscriptions.update(sub.id, null, { reminderSentFor: sub.nextRunAt });
  }
  return pending.length;
}

/* The whole tick: charge what's due, then send the advance notices. */
async function runDueSubscriptions(now = Date.now()) {
  const due = subscriptions.listDue(now).slice(0, SUB_RUN_LIMIT);
  const results = [];
  for (const sub of due) {
    results.push(await runOneSubscription(sub));   // sequential: keeps card traffic calm
  }
  let reminded = 0;
  try {
    reminded = await sendDueReminders(now);
  } catch (e) {
    console.error('[autoship] reminders failed:', e.message);
  }
  const charged = results.filter(r => r.status === 'charged' || r.status === 'recovered').length;
  const failed = results.filter(r => r.status === 'failed').length;
  if (due.length || reminded) {
    console.log(`[autoship] due ${due.length} · charged ${charged} · failed ${failed} · reminders ${reminded}`);
  }
  return { due: due.length, charged, failed, reminded, results };
}

/* The trigger is open to the scheduled pinger (CRON_KEY) or to an admin —
   the admin path is what powers the "Run due now" button while testing. */
function requireCron(req, res, next) {
  const key = req.get('x-cron-key') || req.query.cronKey || '';
  if (CRON_KEY && key && key === CRON_KEY) return next();
  return requireAdmin(req, res, next);
}

app.post('/api/subscriptions/run-due', requireCron, async (req, res) => {
  const started = Date.now();
  try {
    const summary = await runDueSubscriptions();
    res.json({ success: true, ...summary, ms: Date.now() - started });
  } catch (err) {
    console.error('[autoship] run failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   AUTO-SHIP EMAILS
   All of these no-op quietly when SMTP isn't configured, so the
   feature still works end-to-end without email set up.
   ============================================================ */

const SITE = () => (process.env.SITE_URL || 'https://evernovalife.com').replace(/\/+$/, '');
const prettyDate = iso => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : '';
};
const everyPhrase = days => (Number(days) === 1 ? 'every day' : `every ${days} days`);

/* Shared wrapper so every auto-ship email looks like the rest of the site. */
function autoshipEmailHtml({ heading, intro, sub, extraHtml }) {
  const rows = (sub.items || [])
    .map(i => `<tr><td style="padding:2px 12px 2px 0">${escapeHtmlSrv(i.name)}</td><td style="color:#6b7280">× ${escapeHtmlSrv(i.quantity)}</td></tr>`)
    .join('');
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="color:#6d28d9;margin-bottom:4px">${escapeHtmlSrv(heading)}</h2>
    <p>${intro}</p>
    <table style="border-collapse:collapse;margin:12px 0">${rows}</table>
    <p style="color:#6b7280;font-size:14px">Frequency: <strong>${escapeHtmlSrv(everyPhrase(sub.intervalDays))}</strong><br>
    Payment: ${escapeHtmlSrv(sub.paymentLabel || 'your saved payment method')}<br>
    Plan reference: ${escapeHtmlSrv(sub.id)}</p>
    ${extraHtml || ''}
    <p><a href="${SITE()}/account.html#autoship" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Manage auto-ship</a></p>
    <p style="color:#9ca3af;font-size:12px;margin-top:24px">You can change the frequency, skip a shipment, pause or cancel at any time from your account — there's no minimum and no cancellation fee. All products are sold strictly for in-vitro research and laboratory use only. Not for human consumption.</p>
  </div>`;
}

async function sendSubscriptionCreatedEmail(user, sub) {
  if (!mailer.CONFIGURED || !user || !user.email) return;
  const when = prettyDate(sub.nextRunAt);
  return mailer.sendMail({
    to: user.email,
    subject: 'Your Ever Nova Life auto-ship is set up',
    text: `Hi ${user.firstName || 'there'},\n\n` +
      `Your auto-ship plan is active. We'll send the same items ${everyPhrase(sub.intervalDays)}, ` +
      `and your card (${sub.paymentLabel}) will be charged on each shipment date.\n\n` +
      `Next shipment: ${when}\nPlan reference: ${sub.id}\n\n` +
      `We'll email you ${subscriptions.REMINDER_DAYS} days before each charge. You can change the ` +
      `frequency, skip a shipment, pause or cancel any time at ${SITE()}/account.html#autoship\n\n` +
      `— The Ever Nova Life team`,
    html: autoshipEmailHtml({
      heading: 'Your auto-ship is set up ✅',
      intro: `Hi ${escapeHtmlSrv(user.firstName || 'there')}, we'll send these items <strong>${escapeHtmlSrv(everyPhrase(sub.intervalDays))}</strong> and charge your saved payment method on each shipment date.`,
      sub,
      extraHtml: `<p style="color:#6b7280;font-size:14px">Next shipment: <strong>${escapeHtmlSrv(when)}</strong><br>
        We'll remind you ${subscriptions.REMINDER_DAYS} days before each charge.</p>`
    })
  });
}

async function sendSubscriptionReminderEmail(user, sub) {
  if (!mailer.CONFIGURED || !user || !user.email) return;
  const when = prettyDate(sub.nextRunAt);
  return mailer.sendMail({
    to: user.email,
    subject: `Your next Ever Nova Life shipment is on ${when}`,
    text: `Hi ${user.firstName || 'there'},\n\n` +
      `A heads-up that your auto-ship order is scheduled for ${when}, when we'll charge ` +
      `${sub.paymentLabel}.\n\nIf you'd like to skip this one, change the items, or stop the plan, ` +
      `do it before that date at ${SITE()}/account.html#autoship\n\nPlan reference: ${sub.id}\n\n` +
      `— The Ever Nova Life team`,
    html: autoshipEmailHtml({
      heading: 'Your next shipment is coming up 📦',
      intro: `Hi ${escapeHtmlSrv(user.firstName || 'there')}, your auto-ship order is scheduled for <strong>${escapeHtmlSrv(when)}</strong>. We'll charge your saved payment method on that date.`,
      sub,
      extraHtml: `<p style="color:#6b7280;font-size:14px">Want to skip this one, swap the items, or stop the plan? Do it before ${escapeHtmlSrv(when)}.</p>`
    })
  });
}

async function sendSubscriptionChargedEmail(user, sub, order, orderId) {
  if (!mailer.CONFIGURED || !user || !user.email) return;
  const next = prettyDate(sub.nextRunAt);
  const total = Number(order.total).toFixed(2);
  return mailer.sendMail({
    to: user.email,
    subject: `Ever Nova Life auto-ship order ${orderId} — $${total}`,
    text: `Hi ${user.firstName || 'there'},\n\n` +
      `Your auto-ship order has been placed and your payment method charged $${total}.\n\n` +
      `Order: ${orderId}\nNext shipment: ${next}\n\n` +
      `See it in your account: ${SITE()}/account.html\n\n— The Ever Nova Life team`,
    html: autoshipEmailHtml({
      heading: 'Your auto-ship order is on its way 🚚',
      intro: `Hi ${escapeHtmlSrv(user.firstName || 'there')}, we've placed your scheduled order and charged <strong>$${escapeHtmlSrv(total)}</strong> to ${escapeHtmlSrv(sub.paymentLabel || 'your saved payment method')}.`,
      sub,
      extraHtml: `<p style="color:#6b7280;font-size:14px">Order reference: <strong>${escapeHtmlSrv(orderId)}</strong><br>
        Next shipment: <strong>${escapeHtmlSrv(next)}</strong></p>`
    })
  });
}

async function sendSubscriptionFailedEmail(user, sub, message, paused) {
  if (!mailer.CONFIGURED || !user || !user.email) return;
  const retryLine = paused
    ? `We've paused the plan so nothing else is attempted. Update your payment method and resume it whenever you're ready.`
    : `We'll try again in ${subscriptions.RETRY_DAYS} days.`;
  return mailer.sendMail({
    to: user.email,
    subject: paused ? 'Your Ever Nova Life auto-ship is paused' : 'We couldn\'t process your auto-ship payment',
    text: `Hi ${user.firstName || 'there'},\n\n` +
      `We couldn't charge ${sub.paymentLabel || 'your saved payment method'} for your scheduled order.\n\n` +
      `Reason given: ${message}\n\n${retryLine}\n\n` +
      `Manage the plan here: ${SITE()}/account.html#autoship\n\nPlan reference: ${sub.id}\n\n` +
      `— The Ever Nova Life team`,
    html: autoshipEmailHtml({
      heading: paused ? 'Auto-ship paused ⏸' : 'We couldn\'t take that payment',
      intro: `Hi ${escapeHtmlSrv(user.firstName || 'there')}, we weren't able to charge ${escapeHtmlSrv(sub.paymentLabel || 'your saved payment method')} for your scheduled order.`,
      sub,
      extraHtml: `<p style="color:#b91c1c;font-size:14px">Reason given: ${escapeHtmlSrv(message)}</p>
        <p style="color:#6b7280;font-size:14px">${escapeHtmlSrv(retryLine)}</p>`
    })
  });
}

async function sendSubscriptionCancelledEmail(user, sub) {
  if (!mailer.CONFIGURED || !user || !user.email) return;
  return mailer.sendMail({
    to: user.email,
    subject: 'Your Ever Nova Life auto-ship is cancelled',
    text: `Hi ${user.firstName || 'there'},\n\n` +
      `Your auto-ship plan (${sub.id}) has been cancelled — there are no further charges and ` +
      `nothing more will ship.\n\nYou can start a new plan any time at ${SITE()}/products.html\n\n` +
      `— The Ever Nova Life team`,
    html: autoshipEmailHtml({
      heading: 'Auto-ship cancelled',
      intro: `Hi ${escapeHtmlSrv(user.firstName || 'there')}, your plan has been cancelled. <strong>There are no further charges</strong> and nothing more will ship.`,
      sub,
      extraHtml: `<p style="color:#6b7280;font-size:14px">Changed your mind? You can start a new plan at any time.</p>`
    })
  });
}

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

// Only start listening when run directly (`node server.js`). When the app is
// require()'d — e.g. by the authorization tests — it's exported without binding
// a port, so tests can start it on an ephemeral port of their choosing.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\nEver Nova Life payment server`);
    console.log(`  env:    ${braintree.ENV}`);
    console.log(`  card:   ${braintree.CONFIGURED ? 'Braintree ready' : 'not configured (set BRAINTREE_* in .env)'}`);
    console.log(`  crypto: ${btcpay.CONFIGURED ? 'BTCPay ready → ' + btcpay.BASE_URL : 'not configured (set BTCPAY_* in .env)'}`);
    console.log(`  zelle:  ${zelle.CONFIGURED ? 'ready → ' + zelle.RECIPIENT + ' (manual confirmation in admin.html)' : 'not configured (set ZELLE_RECIPIENT + ZELLE_NAME in .env)'}`);
    console.log(`  auth:   accounts ready${auth.CONFIGURED ? '' : ' (JWT_SECRET not set — set it in .env for production)'}`);
    console.log(`  ship:   auto-ship ${CRON_KEY ? 'ready (CRON_KEY set)' : 'WITHOUT a CRON_KEY — set one so the scheduled trigger can be secured'}`);
    console.log(`  api:    http://localhost:${PORT}/api`);
    console.log(`  site:   http://localhost:${PORT}/  (serving ${ROOT})\n`);
  });

  /* In-process backstop for the auto-ship scheduler. The real trigger is the
     external hourly ping to /api/subscriptions/run-due — this only covers the
     window while the process happens to be up, and is deliberately not the
     thing we rely on (a sleeping or restarted host runs no timers). Set
     SUBSCRIPTION_INPROCESS_CRON=0 to turn it off. */
  if (process.env.SUBSCRIPTION_INPROCESS_CRON !== '0') {
    const tickMinutes = Math.max(5, Number(process.env.SUBSCRIPTION_TICK_MINUTES) || 60);
    setInterval(() => {
      runDueSubscriptions().catch(err => console.error('[autoship] tick failed:', err.message));
    }, tickMinutes * 60 * 1000).unref();
  }
}

module.exports = app;
