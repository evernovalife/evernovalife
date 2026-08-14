/* ============================================================
   EVER NOVA LIFE — payment API server
   Every payment path prices the cart HERE; the browser never sends
   a total. Two methods, both of which confirm AFTER the order is
   created (there is no card-style synchronous capture):
     POST /api/crypto/checkout → open a BTCPay invoice  (webhook confirms)
     POST /api/zelle/checkout  → open an unpaid order   (admin confirms)
     GET  /api/health          → liveness probe
   Also (optionally) serves the static site from the repo root,
   so the whole store runs from one origin during development.
   ============================================================ */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const { buildOrder } = require('./pricing.js');
const btcpay = require('./btcpay.js');
const zelle = require('./zelle.js');
const auth = require('./auth.js');
const store = require('./store.js');
const loyalty = require('./loyalty.js');
const subscriptions = require('./subscriptions.js');
const productStore = require('./products.js');
const shippingRates = require('./shipping.js');
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

/* The checkout reads this to decide which payment buttons to show, so a
   method that isn't configured is never offered rather than failing on click. */
app.get('/api/health', (req, res) => res.json({
  ok: true,
  crypto: btcpay.CONFIGURED,      // BTCPay (Bitcoin / Lightning) ready?
  zelle: zelle.CONFIGURED,        // Zelle (manual bank transfer) ready?
  auth: true,                     // email/password accounts always available
  email: mailer.CONFIGURED,       // reset + welcome emails (Gmail SMTP) ready?
  /* Is there an inbox for owner alerts (new order, paid, underpaid)? Without
     ADMIN_EMAIL those are built and then dropped, which looks identical to a
     store nobody is buying from. Boolean only — the address stays private. */
  ownerAlerts: Boolean(process.env.ADMIN_EMAIL),
  // Auto-ship re-invoices through BTCPay, so it rides on the same config —
  // and on email, which is how the customer receives each pay link.
  autoship: btcpay.CONFIGURED,
  cron: !!CRON_KEY,               // is the scheduled-invoice trigger armed?
  /* Capability flags. The site is deployed separately from this API (static
     host + Render), so a page can be newer than the server answering it. A
     tool whose endpoint is missing would otherwise look like it saved and
     silently lose the change — admin-products.html reads this and says so
     instead. Add a flag whenever a new admin endpoint lands. */
  features: {
    stockCounts: true             // PATCH /api/products/:id/stock exists
  }
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

/* ---- Web order authorization, required on every order.
   The buyer ticks an authorization box directly above the payment buttons
   (checkout.html; the wording is Section 12 of the Terms). We keep what they
   were shown, which version of it, when they agreed, and where from — that
   record is the answer to a "I never authorized this" dispute, so it is built
   HERE rather than trusted from the browser for the parts we can observe
   ourselves. Checked server-side so an order cannot be placed around the form. */
const WEB_AUTH_VERSION = '2026-08-14';
const WEB_AUTH_MAX_TEXT = 4000;

function buildWebAuthorization(raw, req) {
  const a = raw && typeof raw === 'object' ? raw : null;
  if (!a || a.accepted !== true) {
    throw new Error('Please tick the order authorization box before placing your order.');
  }
  /* Trust the browser's timestamp only if it is a real date; otherwise the
     record is stamped with when we received it. Either way we also keep our
     own arrival time, which no client can move. */
  const claimed = a.acceptedAt ? new Date(a.acceptedAt) : null;
  const now = new Date();
  return {
    accepted: true,
    version: String(a.version || WEB_AUTH_VERSION).slice(0, 40),
    acceptedAt: (claimed && !isNaN(claimed.getTime()) ? claimed : now).toISOString(),
    recordedAt: now.toISOString(),
    text: String(a.text || '').slice(0, WEB_AUTH_MAX_TEXT),
    ip: String((req && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req && req.ip) || '').slice(0, 64),
    userAgent: String((req && req.headers['user-agent']) || '').slice(0, 300)
  };
}

/* ---- Buyer declarations, required on every order.
   The conditions of sale for this product category: acceptance of the Terms,
   and the age / non-consumption / qualified-professional statement. Same
   reasoning as the authorization above — the tick only means something if what
   was ticked is kept, so the wording, its version and the arrival time are
   stored with the order.

   Checked here, not only in the browser, because a form check is a courtesy to
   honest buyers and nothing at all to anyone posting straight at the API. */
const DECLARATIONS_VERSION = '2026-08-14';
const DECLARATIONS_REQUIRED = ['terms', 'age-and-use'];
const DECLARATION_MAX_TEXT = 2000;

function buildDeclarations(raw, req) {
  const d = raw && typeof raw === 'object' ? raw : null;
  const items = d && Array.isArray(d.items) ? d.items : [];
  const accepted = new Set(items.filter(i => i && i.accepted === true).map(i => String(i.id)));
  const missing = DECLARATIONS_REQUIRED.filter(id => !accepted.has(id));
  if (missing.length) {
    throw new Error(missing.includes('age-and-use')
      ? 'Please confirm you are 21 or over and that these products will not be consumed, before placing your order.'
      : 'Please accept the Terms and Conditions before placing your order.');
  }
  const claimed = d.acceptedAt ? new Date(d.acceptedAt) : null;
  const now = new Date();
  return {
    version: String(d.version || DECLARATIONS_VERSION).slice(0, 40),
    acceptedAt: (claimed && !isNaN(claimed.getTime()) ? claimed : now).toISOString(),
    recordedAt: now.toISOString(),
    items: items
      .filter(i => i && i.accepted === true && DECLARATIONS_REQUIRED.includes(String(i.id)))
      .map(i => ({
        id: String(i.id).slice(0, 40),
        accepted: true,
        text: String(i.text || '').slice(0, DECLARATION_MAX_TEXT)
      })),
    ip: String((req && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req && req.ip) || '').slice(0, 64),
    userAgent: String((req && req.headers['user-agent']) || '').slice(0, 300)
  };
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
  /* A short-paid order carries its own way out: what's still owed, and the
     link that raises an invoice for it. Attached here rather than stored, so
     it is always current and orders raised before the feature existed get one
     too. Everything else is returned untouched. */
  const orders = store.listOrders(req.user.id).map(o => canPayBalance(o)
    ? { ...o, amountDue: amountDue(o), payUrl: payLinkFor(o.orderId) }
    : o);
  res.json({ success: true, orders });
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
   items, re-invoiced every N days of their choosing. Nothing about
   the money is trusted from the browser — every run re-prices
   against the live catalog.

   Crypto is push-only: we cannot debit a wallet on a schedule, so
   a due plan opens a fresh BTCPay invoice and emails the pay link
   instead of charging silently. The plan is the schedule; the
   customer still authorises each payment.

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
   Nothing is paid now: the first invoice goes out one interval from today.
   There's no payment method to collect up front — each shipment is paid from
   its own BTCPay invoice when it's issued. */
app.post('/api/subscriptions', auth.requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (!btcpay.CONFIGURED) {
      return res.status(503).json({ error: 'Auto-ship is unavailable right now (crypto payments are not set up).' });
    }
    const order = buildOrder(body.items);   // validates ids/quantities + previews the price
    if (body.shipping) assertUsShipping(body.shipping);

    const sub = subscriptions.create(req.user.id, {
      items: orderToSubscriptionItems(order),
      intervalDays: body.intervalDays,
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

/* ---- PRICE A CART, CHARGE NOTHING ----
   The browser's cart caches the price each item was added at. The server
   re-prices every checkout from the live catalog, so a cart holding a stale
   price used to show one total on the page and invoice another — a customer
   saw $53.18 and BTCPay asked for $101.79, because GHK-Cu had moved from
   $39.99 to $85.00 since it went in the cart.

   This is the same buildOrder() the invoice is built from, exposed read-only,
   so the checkout summary can show the figure that will actually be charged
   instead of its own arithmetic. No auth: it reveals nothing a visitor can't
   read off the catalog, and guests reach checkout too. */
app.post('/api/quote', (req, res) => {
  try {
    const body = req.body || {};
    const order = buildOrder(body.items || [], { shippingMethod: body.shippingMethod });
    res.json({
      success: true,
      items: order.items,          // [{ id, name, unitPrice, quantity, lineTotal }]
      subtotal: order.subtotal,
      shipping: order.shipping,
      shippingMethod: order.shippingMethod,
      shippingLabel: order.shippingLabel,
      tax: order.tax,
      total: order.total
    });
  } catch (err) {
    // 409 = a stock shortfall, which the cart page words differently from a
    // malformed item; keep buildOrder's own status when it sets one.
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

/* ---- cancel a plan (kept as history; never invoiced again) ---- */
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
/* Hidden products are filtered out for the public. The admin console reads
   the same route and needs to see everything it can edit, so an authenticated
   admin gets the unfiltered list — checked softly, because a visitor with no
   credentials must get the catalog, not a 401. */
app.get('/api/products', (req, res) => {
  const all = productStore.listProducts();
  const products = isAdminRequest(req) ? all : all.filter(productStore.isPublished);
  res.json({ success: true, products, categories: productStore.CATEGORIES });
});

app.post('/api/products', requireAdmin, (req, res) => {
  try {
    const product = productStore.addProduct(req.body || {});
    res.status(201).json({ success: true, product });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/* ============================================================
   SHIPPING RATES
   The fee used to be a constant in three files. Now it is data the
   owner edits, and the checkout offers exactly what is enabled.
   Public GET (checkout has to show the options to guests too);
   an admin sees the disabled ones as well, since those are what
   they are about to turn on.
   ============================================================ */
app.get('/api/shipping', (req, res) => {
  const admin = isAdminRequest(req);
  res.json({
    success: true,
    methods: admin ? shippingRates.listAll() : shippingRates.listEnabled(),
    // Never let the browser guess which one is preselected: it decides the
    // fee, so the server names the default.
    defaultMethod: (shippingRates.quote(null, 0).method || {}).id || ''
  });
});

/* Add or edit one. Same route for both: the id is the key, and a blank id on a
   new method is derived from its name. */
app.post('/api/shipping', requireAdmin, (req, res) => {
  try {
    const method = shippingRates.upsert(req.body || {});
    res.json({ success: true, method, methods: shippingRates.listAll() });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.delete('/api/shipping/:id', requireAdmin, (req, res) => {
  try {
    const removed = shippingRates.remove(req.params.id);
    res.json({ success: true, removed, methods: shippingRates.listAll() });
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

/* ---- ADMIN: set one product's stock count ----
   Its own route so the admin list can save a count inline without round-tripping
   the entire product (which would mean re-uploading the image data-URL just to
   change a number, and would let a stale row overwrite a field edited elsewhere).
   Send { stockQty: 12 } to set it, or { stockQty: null } to stop tracking. */
/* ---- ADMIN: show or hide one product ----
   Same reasoning as the stock route: the admin list flips this inline, and
   re-sending the whole product just to change a boolean would mean shipping
   the image data-URL back and forth and risking a stale row overwriting an
   edit made elsewhere. Send { published: false } to take it off the shop. */
app.patch('/api/products/:id/published', requireAdmin, (req, res) => {
  const body = req.body || {};
  const product = productStore.setPublished(req.params.id, body.published !== false);
  if (!product) return res.status(404).json({ error: 'No product with that id.' });
  res.json({ success: true, product });
});

app.patch('/api/products/:id/stock', requireAdmin, (req, res) => {
  try {
    const body = req.body || {};
    const product = productStore.setStock(req.params.id, body.stockQty);
    if (!product) return res.status(404).json({ error: 'No product with that id.' });
    res.json({ success: true, product });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
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
/* Same two credentials requireAdmin accepts, asked as a question instead of
   enforced as a gate. Used where a route serves both the public and an admin
   (GET /api/products), so an anonymous visitor gets the public view rather
   than a 401. */
function isAdminRequest(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const payload = m && auth.verifyToken(m[1]);
  if (payload) {
    const user = auth.getUserById(payload.sub);
    if (user && user.isAdmin) return true;
  }
  const key = req.get('x-admin-key') || req.query.key || '';
  return Boolean(ADMIN_KEY && key && key === ADMIN_KEY);
}

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
  // invoicing an account that no longer exists.
  try { subscriptions.deleteUserData(id); } catch (e) { console.error('[admin delete] autoship cleanup failed:', e.message); }
  res.json({ success: true, deleted: removed });
});

/* ---- ADMIN: bring a plan's next shipment forward to now ----
   Two real uses: testing the whole cycle without waiting weeks, and customer
   service ("send my next one early"). It only moves the DATE — the invoice still
   goes out through the normal scheduled run, with all its guards. */
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
  /* Where owner notifications go is part of "is email working". A blank
     ADMIN_EMAIL swallows every new-order and underpaid alert silently — SMTP
     verifies fine, and nothing is ever sent. */
  const out = {
    config: mailer.config(),
    ownerAlerts: { to: process.env.ADMIN_EMAIL || '', configured: Boolean(process.env.ADMIN_EMAIL) }
  };
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
   amount we bill already reflects it. We work out the actual points to spend
   from the discount pricing.js ends up applying (it clamps to the subtotal), so
   points and dollars can never drift apart. The points are held the moment the
   order is opened and returned if it dies unpaid — see reserveLoyaltyPoints /
   refundReservedPoints. Guests can't redeem. */
function plannedDiscount(user, pointsToRedeem) {
  if (!user) return 0;
  const requested = Math.max(0, Math.floor(Number(pointsToRedeem) || 0));
  if (!requested) return 0;
  const usePoints = Math.min(requested, loyalty.getBalance(user.id));
  return loyalty.pointsToDollars(usePoints);
}

/* Hold the points a discount was priced against, at the moment the order is
   opened. Every payment method here confirms later (a BTCPay invoice, a Zelle
   transfer), so waiting until "paid" to debit would let one balance discount
   several open orders. Returns the points taken, for the stored record.

   Points are EARNED separately, in markOrderPaid — nothing is granted for an
   order that was never paid for. */
function reserveLoyaltyPoints(userId, order, orderId) {
  if (!userId || !order || !(order.discount > 0)) return 0;
  try {
    const points = loyalty.centsToPoints(Math.round(order.discount * 100));
    if (points > 0) loyalty.redeem(userId, points, 'Redeemed at checkout', { orderId });
    return points;
  } catch (e) {
    console.error('[loyalty] could not reserve points:', e.message);
    return 0;
  }
}

/* Give held points back when an order dies unpaid (an expired or invalid
   BTCPay invoice, an admin cancelling a Zelle order that never landed).
   Idempotent: the refund is stamped on the order, so a repeated webhook
   delivery can't credit the same points twice. */
function refundReservedPoints(orderId) {
  const found = store.listAllOrders().find(o => o.orderId === orderId);
  if (!found || found.userId === store.GUEST_KEY) return 0;
  const points = Number(found.pointsRedeemed) || 0;
  if (!points || found.pointsRefunded) return 0;
  try {
    loyalty.earn(found.userId, points, 'Refund — order ' + orderId + ' was not paid', { orderId });
    store.updateOrderStatus(orderId, null, { pointsRefunded: points });
    return points;
  } catch (e) {
    console.error('[loyalty] could not refund reserved points:', e.message);
    return 0;
  }
}

/* ---- stock hold, same lifecycle as the loyalty hold above ----

   Products may carry a stock COUNT (products.js `stockQty`; absent = untracked
   and unlimited, which is how everything behaved before counts existed). The
   count comes down when the order is OPENED, not when it is paid: every method
   here confirms later, so waiting for settlement would let the last vial be
   promised to several buyers at once. If the order then dies unpaid the units
   go back on the shelf.

   Throws (409) when a line can't be filled — the caller must let that reach the
   buyer rather than opening an invoice for goods that aren't there. */
function reserveOrderStock(order) {
  const lines = (order && order.items || []).map(i => ({ id: i.id, quantity: i.quantity }));
  return productStore.reserveStock(lines);      // [] when nothing was tracked
}

/* Put units back. Idempotent through the `stockReleased` stamp on the order, so
   a repeated BTCPay webhook or a double-click in admin can't credit twice.
   Pass `reserved` directly for the case where no order was stored yet (a
   checkout that threw after taking stock). */
function releaseOrderStock(orderId, reserved) {
  if (reserved) {
    try { productStore.releaseStock(reserved); }
    catch (e) { console.error('[stock] could not release:', e.message); }
    return;
  }
  const found = store.listAllOrders().find(o => o.orderId === orderId);
  if (!found || found.stockReleased) return;
  const held = Array.isArray(found.stockReserved) ? found.stockReserved : [];
  if (!held.length) return;
  try {
    productStore.releaseStock(held);
    store.updateOrderStatus(orderId, null, { stockReleased: true });
  } catch (e) {
    console.error('[stock] could not release for ' + orderId + ':', e.message);
  }
}

/* An order that was written off and then turns out to be a sale after all — a
   webhook that arrived late, or an owner marking a cancelled order paid because
   the money did land — had its units put back on the shelf. Now that it ships,
   take them off again, or the count is one too high forever.

   A shortfall is stamped, not thrown: the money is already in and the order is
   already paid, so the honest outcome is a flagged order rather than a refused
   payment. */
function retakeStockIfReleased(order) {
  if (!order || !order.stockReleased) return;
  const held = Array.isArray(order.stockReserved) ? order.stockReserved : [];
  if (!held.length) return;
  try {
    productStore.reserveStock(held.map(l => ({ id: l.id, quantity: l.quantity })));
    store.updateOrderStatus(order.orderId, null, { stockReleased: false });
  } catch (e) {
    console.error('[stock] could not re-take stock for ' + order.orderId + ':', e.message);
    store.updateOrderStatus(order.orderId, null, { stockShort: true });
  }
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

/* Shape a stored order record from a priced order + payment details.
   `order.shipping` is the shipping COST (from pricing.js); the delivery
   address arrives separately as `shipping`, stored as shippingAddress so
   the two never collide. */
function buildOrderRecord({ orderId, order, method, status, email, shipping, transactionId, invoiceId, pointsEarned, pointsRedeemed, subscriptionId, stockReserved, webAuthorization, declarations }) {
  return {
    orderId,
    createdAt: new Date().toISOString(),
    status,
    method,
    items: order.items,          // [{ id, name, unitPrice, quantity, lineTotal }]
    subtotal: order.subtotal,
    discount: order.discount || 0,
    shippingCost: order.shipping,
    // Which service was bought, so the packing queue knows how fast it has to
    // go out — a fee on its own doesn't say that.
    ...(order.shippingLabel ? { shippingMethod: order.shippingMethod, shippingLabel: order.shippingLabel } : {}),
    tax: order.tax,
    total: order.total,
    email: email || '',
    shippingAddress: shipping || null,
    // what the buyer authorized, and when — the audit trail for this sale
    ...(webAuthorization ? { webAuthorization } : {}),
    // …and the conditions of sale they declared to meet (age, non-consumption,
    // qualified professional, Terms). Same audit trail, different question.
    ...(declarations ? { declarations } : {}),
    ...(pointsEarned ? { pointsEarned } : {}),
    ...(pointsRedeemed ? { pointsRedeemed } : {}),
    ...(transactionId ? { transactionId } : {}),
    ...(invoiceId ? { invoiceId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),  // marks an auto-ship shipment
    // units taken off the shelf when this order opened; what a cancel gives back
    ...(stockReserved && stockReserved.length ? { stockReserved } : {})
  };
}

/* ============================================================
   CRYPTO CHECKOUT — Bitcoin / Lightning via BTCPay Server
   The store's primary payment method. Price the cart HERE, never
   trust the browser's total. We open a hosted BTCPay invoice and
   hand the browser its checkoutLink to redirect to.
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
    const webAuthorization = buildWebAuthorization(body.webAuthorization, req);
    const declarations = buildDeclarations(body.declarations, req);
    // Loyalty redemption is folded into the invoice amount, so the buyer pays
    // the discounted total. The points are HELD (debited now) and returned if
    // the invoice expires unpaid — see refundReservedPoints below. Holding
    // rather than spending-on-settle is what stops the same balance funding
    // two open invoices at once.
    const discount = plannedDiscount(req.user, body.pointsToRedeem);
    // The browser names the service; shipping.js sets what it costs.
    const order = buildOrder(body.items, { discount, shippingMethod: body.shippingMethod });
    const orderId = newOrderId();

    /* Resolve the buyer's email ONCE and store that, rather than whatever the
       checkout form happened to send. Every later message — receipt, expiry
       notice, "your payment came in short" — is addressed from the order
       record, so an empty field here is an order that can never be written to
       again. The account address is always there to fall back on. */
    const buyerEmail = body.email || req.user.email;

    /* Take the stock BEFORE opening the invoice, and before the first `await`.
       buildOrder has already checked availability, but only this call checks and
       decrements in the same turn — between the two, another checkout could take
       the last unit. Anything that fails after this point must put it back, which
       is what the catch below does. */
    const stockReserved = reserveOrderStock(order);

    // Build a same-site return URL so BTCPay can send the buyer back to us.
    // Prefer an explicit SITE_URL; otherwise use the caller's Origin (a
    // same-site fetch → our own site). No trusted origin → let BTCPay show
    // its own receipt page instead of redirecting anywhere.
    const base = (process.env.SITE_URL || req.headers.origin || '').replace(/\/+$/, '');
    const redirectUrl = base ? `${base}/checkout.html?paid=crypto` : '';

    let invoice;
    try {
      invoice = await btcpay.createInvoice({
        order,
        email: buyerEmail,
        shipping: body.shipping,
        orderId,
        redirectUrl
      });
    } catch (e) {
      // no invoice, so no order and nothing to pay — the units go straight back
      releaseOrderStock(null, stockReserved);
      throw e;
    }

    /* Auto-ship opt-in. Signed-in only — a standing order needs an account to
       manage and cancel it. The plan is created now, alongside the unpaid
       invoice: it holds no money and charges nothing, so an invoice the buyer
       abandons costs them a plan they can cancel, not a payment. The first
       repeat invoice is one full interval away. */
    const wantsAutoship = !!(body.autoship && body.autoship.enabled);
    let subscription = null;
    if (wantsAutoship) {
      try {
        const sub = subscriptions.create(req.user.id, {
          items: orderToSubscriptionItems(order),
          intervalDays: body.autoship.intervalDays,
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

    // Record the order as pending now; the webhook flips it to paid once
    // BTCPay confirms the payment. Empty their saved cart so the same items
    // don't linger after they've committed to buying.
    const pointsRedeemed = reserveLoyaltyPoints(req.user.id, order, orderId);
    try {
      store.addOrder(req.user.id, buildOrderRecord({
        orderId, order, method: 'crypto', status: 'pending',
        email: buyerEmail, shipping: body.shipping,
        invoiceId: invoice.id,
        pointsRedeemed,
        stockReserved,
        webAuthorization,
        declarations,
        subscriptionId: subscription ? subscription.id : ''
      }));
      store.clearCart(req.user.id);
    } catch (e) {
      /* The invoice exists and is payable, but we have no record of it — so the
         held units have nothing to release them later. Give them back now; the
         alternative is stock that is gone forever with no order to point at. */
      console.error('[crypto checkout] could not save order:', e.message);
      releaseOrderStock(null, stockReserved);
    }

    res.status(201).json({
      success: true,
      orderId,
      invoiceId: invoice.id,
      checkoutLink: invoice.checkoutLink,
      total: order.total,
      discount: order.discount,
      pointsRedeemed,
      subscription,
      // Be honest when auto-ship was asked for but couldn't be set up, rather
      // than silently dropping it.
      autoshipFailed: wantsAutoship && !subscription
    });

    /* After responding, so neither can fail the sale. The buyer needs the pay
       link somewhere they can't lose it — a BTCPay invoice expires in minutes
       and the tab that held it is the only copy otherwise. The owner needs to
       know an invoice is live, because a crypto payment lands in the wallet
       whether or not anyone is watching this server. */
    sendCryptoInvoiceEmail({ email: buyerEmail, orderId, order, checkoutLink: invoice.checkoutLink })
      .catch(err => console.error('[crypto invoice email] failed:', err.message));
    notifyAdminOfCryptoOrder({ orderId, order, email: buyerEmail, invoice })
      .catch(err => console.error('[crypto admin-notify] failed:', err.message));
  } catch (err) {
    console.error('[crypto checkout] failed:', err.message);
    // 409 = a stock shortfall (someone took the last one first), not bad input
    res.status(err.status === 409 ? 409 : 400).json({ error: err.message });
  }
});

/* ---- webhook: BTCPay calls this whenever an invoice changes state.
   Verify the signature, decide what it means for the order, then
   acknowledge. The order state is settled BEFORE the 200 goes back, so a
   caller (or a test) that gets an ok has a store that already agrees; only
   the emails are left running behind it. ---- */
app.post('/api/crypto/webhook', async (req, res) => {
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

  try {
    await handleInvoiceEvent(evt, orderId);
  } catch (err) {
    /* Still acknowledge. A 500 makes BTCPay redeliver, which re-runs the same
       decision against an order that may already have moved — and the one
       thing worse than a missed notification is a duplicated one. */
    console.error('[crypto webhook] handling failed:', err.message);
  }
  res.json({ ok: true });
});

/* What a BTCPay invoice event does to the order behind it. Only signed-in
   orders were recorded, so every store update no-ops when the order isn't
   found. Async because a dead invoice has to be asked "did any money arrive?"
   before it can be written off.

   Emails are started but NOT awaited: a slow SMTP handshake must not hold the
   webhook open, and a bounced notification must not look like a failed
   delivery. Each carries its own .catch so nothing becomes an unhandled
   rejection. */
async function handleInvoiceEvent(evt, orderId) {
  /* Which invoice is this? The one raised at checkout, or a top-up raised
     afterwards to collect a shortfall. They mean different things for an order
     that is already parked as underpaid, so the kind rides along in the
     metadata rather than being guessed at. */
  const isBalance = String((evt.metadata && evt.metadata.kind) || 'order') === 'balance';

  if (evt.type === 'InvoiceSettled') {
    /* A settled invoice means its OWN amount arrived in full — for a top-up
       that is exactly the shortfall, so either way the order is now covered.
       Book it against the invoice it came in on before flipping the status, so
       the order's payment history still adds up to what was taken. */
    settleInvoicePayment(orderId, evt, isBalance);
    const upd = markOrderPaid(orderId, isBalance
      // Don't overwrite the reference of the invoice this order was opened on —
      // reconciling a two-payment order needs both.
      ? { balanceInvoiceId: evt.invoiceId || '', paidInFullBy: 'balance invoice' }
      : { invoiceId: evt.invoiceId || '' });
    if (!upd || upd.previousStatus === 'paid') return;   // repeat delivery — don't email twice
    const order = upd.order;
    sendPaymentConfirmedEmail(order).catch(e => console.error('[paid email] failed:', e.message));
    notifyAdminOfPaidOrder(order).catch(e => console.error('[paid admin-notify] failed:', e.message));
    return;
  }

  if (evt.type !== 'InvoiceExpired' && evt.type !== 'InvoiceInvalid') return;

  const existing = findOrder(orderId);

  /* A top-up invoice dying is not the same event as the original one dying.
     The order is already `underpaid`, so the "already decided" guard below
     would throw away whatever landed against this second invoice — the very
     bug this feature exists to fix, one level down. Add it to the running
     total instead, and settle the order if it now covers the bill. */
  if (isBalance && existing) {
    const { amount, known } = await invoicePaidAmount(evt);
    if (!known || amount <= 0) return;                   // nothing new arrived
    recordInvoicePayment(orderId, evt.invoiceId, amount);
    const after = findOrder(orderId) || existing;
    if (amountDue(after) <= DUST) {
      const upd = markOrderPaid(orderId, { paidInFullBy: 'balance invoice' });
      if (upd && upd.previousStatus !== 'paid') {
        sendPaymentConfirmedEmail(upd.order).catch(e => console.error('[paid email] failed:', e.message));
        notifyAdminOfPaidOrder(upd.order).catch(e => console.error('[paid admin-notify] failed:', e.message));
      }
      return;
    }
    // Still short. Same treatment as the first time — including a fresh link.
    reportShortfall({ orderId, order: after, paid: paidSoFar(after), invoiceId: evt.invoiceId });
    return;
  }

  if (existing && ['paid', 'underpaid', 'cancelled'].includes(String(existing.status).toLowerCase())) {
    return;    // already decided — a redelivery must not undo it
  }

  /* An expired invoice is NOT automatically an unpaid one. BTCPay expires an
     invoice that was underpaid or paid too late, and that money is already in
     the wallet — cancelling it silently is how a paying customer ends up with
     nothing and nobody is told. Ask BTCPay what actually landed. */
  const { amount: paid, known } = await invoicePaidAmount(evt);

  if (paid > 0 || !known) {
    /* Money arrived but not enough (or not in time). Hold everything exactly as
       it is — the stock stays reserved and the loyalty points stay held — and
       give the buyer a way to finish. They get a permanent link that raises a
       fresh invoice for the difference; the owner is told either way, because
       the buyer may prefer a refund. */
    if (known) recordInvoicePayment(orderId, evt.invoiceId, paid);
    store.updateOrderStatus(orderId, 'underpaid', {
      underpaidAt: new Date().toISOString(),
      invoiceId: evt.invoiceId || (existing && existing.invoiceId) || '',
      /* "Some money arrived, we can't see how much" is the one case where the
         balance cannot be worked out — and billing the buyer the full total
         again would charge them twice for what they already sent. Flag it so
         the self-serve top-up stays shut and a human picks it up. */
      paidAmountUnknown: !known
    });
    reportShortfall({
      orderId,
      order: findOrder(orderId) || existing,
      paid: known ? paid : null,
      invoiceId: evt.invoiceId
    });
    return;
  }

  // Nobody paid — hand back any loyalty points the discount was held against
  // and put the reserved units back on the shelf, BOTH before cancelling, so
  // the stored pointsRedeemed / stockReserved are still there to read.
  refundReservedPoints(orderId);
  releaseOrderStock(orderId);
  store.updateOrderStatus(orderId, 'cancelled');
  if (existing) {
    sendInvoiceExpiredEmail(existing).catch(e => console.error('[expired email] failed:', e.message));
  }
}

/* How much money is actually sitting against this invoice, in the store's
   currency. The expiry webhook carries a `partiallyPaid` flag but no amount,
   so the invoice itself is the only place the number exists.
   { amount, known }: `known: false` means "some money arrived but we couldn't
   read how much" — the caller must still treat that as needing a human, since
   writing off a paid order is the expensive mistake here. */
async function invoicePaidAmount(evt) {
  const flagged = Boolean(evt.partiallyPaid);
  if (evt.invoiceId) {
    try {
      const inv = await btcpay.getInvoice(evt.invoiceId);
      return { amount: Number(inv && inv.paidAmount) || 0, known: true };
    } catch (e) {
      console.error('[crypto webhook] could not read invoice', evt.invoiceId + ':', e.message);
    }
  }
  // No amount available: only the flag decides, and an unflagged event is a
  // clean expiry (the ordinary abandoned checkout) that can be cancelled.
  return { amount: 0, known: !flagged };
}

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
  retakeStockIfReleased(upd.order);
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
   PAYING OFF A SHORT PAYMENT
   Crypto is the one method where "paid" is not a yes/no. Coins land in
   whatever amount the sender chose, and a buyer who sends too little has no
   way back in: the invoice they underpaid is expired, and BTCPay will not
   reopen it. Their money is in the wallet, their order is frozen, and the
   only route to finishing it used to be an email exchange with a human.

   The way out is a fresh invoice for the difference, reached through a link
   that does not go stale. /pay.html?order=…&t=… is permanent — it mints a NEW
   BTCPay invoice each time it is opened, because a checkout link is only
   payable inside its own window and any link that sits in an inbox will be
   opened after that window closed.

   Payments are recorded per invoice and summed, so an order paid across two
   invoices actually reaches its total instead of the second payment
   overwriting the first.
   ============================================================ */

/* Below this, a difference is rounding noise from a currency conversion, not
   money anyone should be asked for. */
const DUST = 0.01;

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/* One order by reference, across every account (including guests). The webhook
   and the pay link both know only the orderId. */
function findOrder(orderId) {
  if (!orderId) return null;
  try { return store.listAllOrders().find(o => o.orderId === orderId) || null; }
  catch (e) { return null; }
}

/* Everything received against this order, whichever invoice it arrived on.
   Falls back to the flat paidAmount so orders written before the ledger
   existed — including the ones currently stuck — still read correctly. */
function paidSoFar(order) {
  if (!order) return 0;
  const ledger = order.payments && typeof order.payments === 'object' ? order.payments : null;
  if (!ledger) return round2(order.paidAmount);
  return round2(Object.keys(ledger).reduce((sum, k) => sum + (Number(ledger[k]) || 0), 0));
}

function amountDue(order) {
  if (!order) return 0;
  return Math.max(0, round2(Number(order.total || 0) - paidSoFar(order)));
}

/* Book a payment against the invoice it arrived on. Keyed by invoice, so a
   redelivery of the same event restates the same number rather than adding it
   twice, and a top-up adds to the first partial rather than replacing it. */
function recordInvoicePayment(orderId, invoiceId, amount) {
  const existing = findOrder(orderId);
  if (!existing) return null;
  const payments = { ...(existing.payments || {}) };
  /* An order that predates the ledger carries a flat paidAmount with no
     invoice against it. Seed it as its own line so the sum below doesn't
     silently forget money that is already in the wallet. */
  if (!existing.payments && Number(existing.paidAmount) > 0) {
    payments[existing.invoiceId || 'original'] = round2(existing.paidAmount);
  }
  payments[invoiceId || 'unknown'] = round2(amount);
  const total = round2(Object.keys(payments).reduce((s, k) => s + (Number(payments[k]) || 0), 0));
  // A readable figure answers the question the flag was raised over.
  return store.updateOrderStatus(orderId, null, { payments, paidAmount: total, paidAmountUnknown: false });
}

/* The permanent, un-expiring link a buyer uses to settle what they owe. The
   token is an HMAC of the order reference, so this works for orders that were
   raised long before the feature existed — no stored token, nothing to
   backfill. */
function payLinkFor(orderId) {
  return `${SITE()}/pay.html?order=${encodeURIComponent(orderId)}&t=${auth.refToken('pay', orderId)}`;
}

/* Only a short-paid crypto order can be topped up. A pending order still has
   its original invoice live (raising a second one bills the same goods twice),
   and a cancelled or paid one owes nothing.

   An order whose received amount could not be read is excluded on purpose: the
   balance is unknowable, and the only figure available to bill would be the
   full total — charging a second time for money already sent. */
function canPayBalance(order) {
  return Boolean(order) &&
    String(order.status).toLowerCase() === 'underpaid' &&
    !order.paidAmountUnknown &&
    amountDue(order) > DUST;
}

/* What the webhook does once it knows an order came up short: tell the owner
   there is money in the wallet against goods that aren't going out, and give
   the buyer a way to finish instead of an inbox to wait in. Fired and
   forgotten — a slow SMTP handshake must not hold the webhook open. */
function reportShortfall({ orderId, order, paid, invoiceId }) {
  const payUrl = payLinkFor(orderId);
  // With no readable amount there is no honest "still due" figure to print.
  const due = paid == null ? null : (order ? amountDue(order) : null);
  const payable = canPayBalance(order);
  notifyAdminOfUnderpaidOrder({ orderId, order, paid, due, invoiceId, payUrl, payable })
    .catch(e => console.error('[underpaid admin-notify] failed:', e.message));
  sendUnderpaidEmail({ order, orderId, paid, due, payUrl, payable })
    .catch(e => console.error('[underpaid email] failed:', e.message));
}

/* Book what a settled invoice was raised for. Keyed by invoice id, so the
   partial already recorded against that same invoice is restated as its full
   amount rather than added to. */
function settleInvoicePayment(orderId, evt, isBalance) {
  const order = findOrder(orderId);
  if (!order || String(order.status).toLowerCase() === 'paid') return;
  const amount = isBalance
    ? (Number(order.balanceInvoiceAmount) || amountDue(order))
    : round2(order.total);
  if (amount > 0) recordInvoicePayment(orderId, evt.invoiceId, amount);
}

/* A checkout link the buyer can actually pay right now.

   Reused for a couple of minutes so a refresh, a double-tap or the second of
   two devices lands on the same invoice instead of littering BTCPay with
   abandoned ones — but never longer, because the reused link has to still be
   inside its own payment window. */
const BALANCE_REUSE_MS = 3 * 60 * 1000;

async function openBalanceInvoice(order) {
  const due = amountDue(order);
  if (due <= DUST) {
    const e = new Error('There is nothing left to pay on that order.');
    e.status = 409;
    throw e;
  }

  const mintedAt = order.balanceInvoiceAt ? Date.parse(order.balanceInvoiceAt) : 0;
  const fresh = mintedAt && (Date.now() - mintedAt) < BALANCE_REUSE_MS;
  if (fresh && order.balanceCheckoutLink && round2(order.balanceInvoiceAmount) === due) {
    return { checkoutLink: order.balanceCheckoutLink, invoiceId: order.balanceInvoiceId, due, reused: true };
  }

  const invoice = await btcpay.createInvoice({
    order,
    amount: due,
    kind: 'balance',
    note: `Balance of order ${order.orderId}`,
    email: order.email,
    shipping: order.shippingAddress,
    orderId: order.orderId,
    redirectUrl: `${SITE()}/pay.html?order=${encodeURIComponent(order.orderId)}` +
      `&t=${auth.refToken('pay', order.orderId)}&sent=1`
  });

  store.updateOrderStatus(order.orderId, null, {
    balanceInvoiceId: invoice.id,
    balanceCheckoutLink: invoice.checkoutLink,
    balanceInvoiceAmount: due,
    balanceInvoiceAt: new Date().toISOString()
  });

  return { checkoutLink: invoice.checkoutLink, invoiceId: invoice.id, due, reused: false };
}

/* The two endpoints behind pay.html. Deliberately unauthenticated: the buyer
   may be a guest, and will be reading this off a phone hours after checkout.
   The signed token in the URL is the credential, and it only ever unlocks ONE
   order — reading what is owed on it, and raising an invoice for that amount.
   Neither can move money, change an address or reveal an account. */
function orderFromPayToken(req) {
  const orderId = String(req.params.orderId || '');
  const t = String((req.query && req.query.t) || (req.body && req.body.t) || '');
  if (!auth.verifyRefToken('pay', orderId, t)) return null;
  return findOrder(orderId);
}

app.get('/api/orders/:orderId/balance', (req, res) => {
  const order = orderFromPayToken(req);
  if (!order) return res.status(404).json({ error: 'That payment link is not valid.' });
  res.json({
    success: true,
    orderId: order.orderId,
    status: order.status,
    total: round2(order.total),
    paid: paidSoFar(order),
    due: amountDue(order),
    payable: canPayBalance(order),
    currency: btcpay.CURRENCY,
    items: (order.items || []).map(i => ({ name: i.name, quantity: i.quantity })),
    // How long the invoice they are about to open will stay payable, so the
    // page can say it out loud instead of letting it run out unannounced.
    windowMinutes: btcpay.CHECKOUT.expirationMinutes
  });
});

app.post('/api/orders/:orderId/balance/invoice', async (req, res) => {
  const order = orderFromPayToken(req);
  if (!order) return res.status(404).json({ error: 'That payment link is not valid.' });
  if (!btcpay.CONFIGURED) return res.status(500).json({ error: 'Crypto payments are not set up on this server.' });
  if (!canPayBalance(order)) {
    const status = String(order.status).toLowerCase();
    return res.status(409).json({
      error: status === 'paid' || status === 'shipped' || status === 'delivered'
        ? 'That order is already paid in full — nothing more is owed.'
        : status === 'cancelled'
          ? 'That order was cancelled. Get in touch and we will sort out a refund or a new order.'
          : 'There is nothing to pay on that order right now.',
      status: order.status
    });
  }
  try {
    const out = await openBalanceInvoice(order);
    res.json({ success: true, ...out });
  } catch (e) {
    console.error('[balance invoice] failed for', order.orderId + ':', e.message);
    res.status(e.status === 409 ? 409 : 502).json({ error: e.message });
  }
});

/* ---- ADMIN: send the buyer their pay-the-rest link ----
   The same link the underpaid email already carries, re-sent on demand: for
   the orders that went short before this existed, and for the buyer who
   deleted the first email. */
app.post('/api/admin/orders/:orderId/pay-link', requireAdmin, async (req, res) => {
  const order = findOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'No order with that reference.' });
  if (!canPayBalance(order)) {
    return res.status(400).json({
      error: `That order is "${order.status}" with $${amountDue(order).toFixed(2)} outstanding — there is no balance to collect.`
    });
  }
  const payUrl = payLinkFor(order.orderId);
  const due = amountDue(order);
  /* No inbox to send to — but the link itself is the useful part, so hand it
     back rather than failing. The admin can paste it wherever the buyer
     actually is. */
  if (!mailer.CONFIGURED || !order.email) {
    return res.json({
      success: true, sent: false, payUrl, due,
      reason: mailer.CONFIGURED
        ? 'That order has no email address on it — send this link to the buyer yourself.'
        : 'Email is not set up on this server — send this link to the buyer yourself.'
    });
  }
  try {
    await sendBalanceLinkEmail({ order, due, payUrl });
    res.json({ success: true, sent: true, to: order.email, payUrl, due });
  } catch (e) {
    console.error('[pay-link email] failed:', e.message);
    res.status(502).json({ error: 'Could not send the email: ' + e.message, payUrl, due });
  }
});

/* ---- ADMIN: this order is short, whatever the store says ----
   The webhook path parks a shortfall on its own, but it can only do that for
   orders it saw go short. Two kinds slip past it:

     · orders released by hand before the shortfall was noticed — the store
       says "paid", BTCPay says "partially paid", and there is no disagreement
       anywhere for the automation to act on
     · orders from before any of this existed, where the money in the wallet
       was never written down at all

   So this takes the amount the owner can actually see in BTCPay, records it as
   the truth, re-opens the order at what is still owed, and emails the buyer
   the link. It reverses a `paid` an admin should not have given — deliberately
   loud, because the alternative is a customer who paid $36 of $96 and gets
   $96 of goods. */
app.post('/api/admin/orders/:orderId/collect-balance', requireAdmin, async (req, res) => {
  const order = findOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'No order with that reference.' });

  const status = String(order.status).toLowerCase();
  if (status === 'shipped' || status === 'delivered') {
    return res.status(400).json({
      error: 'That order has already shipped. Chase the balance directly — re-opening it would put a ' +
             'parcel that is already gone back into the packing queue.'
    });
  }
  if (status === 'cancelled') {
    return res.status(400).json({ error: 'That order was cancelled. Its stock and points are already released — place a new one instead.' });
  }

  const received = Number(req.body && req.body.received);
  if (!Number.isFinite(received) || received < 0) {
    return res.status(400).json({ error: 'Enter how much has actually been received against this order (0 or more).' });
  }
  const total = round2(order.total);
  if (received >= total - DUST) {
    return res.status(400).json({ error: `That covers the full $${total.toFixed(2)} — there is no balance to collect.` });
  }

  /* Replaces the ledger rather than adding to it: the caller is stating what
     has arrived in total, having read it off BTCPay, and the whole reason this
     endpoint exists is that whatever is recorded here is wrong. */
  store.updateOrderStatus(order.orderId, 'underpaid', {
    payments: { 'admin-corrected': round2(received) },
    paidAmount: round2(received),
    paidAmountUnknown: false,
    underpaidAt: order.underpaidAt || new Date().toISOString(),
    balanceCorrectedBy: (req.user && req.user.email) || 'admin key',
    balanceCorrectedAt: new Date().toISOString()
  });

  const updated = findOrder(order.orderId);
  const due = amountDue(updated);
  const payUrl = payLinkFor(order.orderId);

  if (!mailer.CONFIGURED || !updated.email) {
    return res.json({
      success: true, sent: false, payUrl, due, status: updated.status,
      reason: mailer.CONFIGURED
        ? 'That order has no email address on it — send this link to the buyer yourself.'
        : 'Email is not set up on this server — send this link to the buyer yourself.'
    });
  }
  try {
    await sendBalanceLinkEmail({ order: updated, due, payUrl });
    res.json({ success: true, sent: true, to: updated.email, payUrl, due, status: updated.status });
  } catch (e) {
    console.error('[collect-balance email] failed:', e.message);
    res.status(502).json({ error: 'The order was re-opened, but the email did not go out: ' + e.message, payUrl, due });
  }
});

/* ---- ADMIN: rebuild an order's payment ledger from BTCPay ----
   `collect-balance` takes the owner's word for what arrived. This takes
   BTCPay's, which is better when an order was billed more than once.

   The failure it repairs: an order goes short, the shortfall is never written
   down, and the SECOND invoice is therefore raised for the full total instead
   of the difference. Now two invoices exist, each asking for everything, and
   the buyer has paid part of each. No single invoice tells the truth and the
   order's flat `paidAmount` is whichever one landed last.

   So: find every invoice tagged with this order, read what actually settled on
   each, and write them into `payments` keyed by invoice id — the shape
   `paidSoFar` already sums. Two partials then add up to what the buyer really
   sent, and the balance link bills the real remainder.

   Refuses to commit a partial read. If any invoice's paid amount cannot be
   determined, the total would be understated and the buyer would be asked for
   money already in the wallet — the one outcome worth failing over. Pass
   { force: true } to book only what could be read.

   POST body (all optional):
     dryRun     true  — report the numbers, change nothing. Do this first.
     invoiceIds [ids] — reconcile exactly these instead of sweeping BTCPay.
                        Needed for invoices older than the sweep window.
     force      true  — commit even though an invoice could not be read.  */
app.post('/api/admin/orders/:orderId/reconcile', requireAdmin, async (req, res) => {
  if (!btcpay.CONFIGURED) {
    return res.status(400).json({ error: 'BTCPay is not configured on this server — there is nothing to reconcile against.' });
  }
  const order = findOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'No order with that reference.' });

  const body = req.body || {};
  const dryRun = Boolean(body.dryRun);
  const force = Boolean(body.force);

  /* Which invoices belong to this order. An explicit list wins: `listInvoices`
     only reaches back so far, and the orders worth reconciling are the old
     ones. Otherwise seed from the ids the order itself remembers, then sweep
     BTCPay for anything else carrying this reference — that sweep is the part
     that finds the duplicate nobody recorded. */
  const wanted = new Set();
  let swept = 0;
  let sweepError = null;
  if (Array.isArray(body.invoiceIds) && body.invoiceIds.length) {
    body.invoiceIds.map(id => String(id || '').trim()).filter(Boolean).forEach(id => wanted.add(id));
  } else {
    [order.invoiceId, order.balanceInvoiceId].filter(Boolean).forEach(id => wanted.add(String(id)));
    try {
      const list = await btcpay.listInvoices({ take: 100 });
      swept = list.length;
      list.forEach(inv => {
        if (inv && inv.id && ((inv.metadata || {}).orderId === order.orderId)) wanted.add(inv.id);
      });
    } catch (e) {
      sweepError = e.message;
    }
  }
  if (!wanted.size) {
    return res.status(400).json({
      error: sweepError
        ? 'Could not list invoices from BTCPay: ' + sweepError
        : 'No BTCPay invoice could be found for that order. Pass the invoice ids explicitly if they are older than the last 100.',
      swept
    });
  }

  const reads = await Promise.all([...wanted].map(async id => {
    try { return await btcpay.getInvoicePaidFiat(id); }
    catch (e) { return { invoiceId: id, error: e.message, known: false, paid: 0 }; }
  }));

  /* An invoice stamped with someone else's order must never be booked here.
     Crediting one buyer's coins to another buyer's order is worse than the bug
     this endpoint fixes, so it stops rather than skipping quietly. */
  const foreign = reads.filter(r => r.orderId && r.orderId !== order.orderId);
  if (foreign.length) {
    return res.status(400).json({
      error: 'Some of those invoices belong to a different order — refusing to credit them here.',
      foreign: foreign.map(r => ({ invoiceId: r.invoiceId, orderId: r.orderId }))
    });
  }
  /* Different currency, different number. Adding EUR into a USD total would
     silently overstate what was paid and ship goods that were not paid for. */
  const mixed = reads.filter(r => !r.error && r.currency && r.currency !== btcpay.CURRENCY);
  if (mixed.length) {
    return res.status(400).json({
      error: `Those invoices are not all in ${btcpay.CURRENCY} — convert them by hand and use "Collect the rest" instead.`,
      mixed: mixed.map(r => ({ invoiceId: r.invoiceId, currency: r.currency }))
    });
  }

  const unreadable = reads.filter(r => r.error || !r.known);
  const usable = reads.filter(r => !r.error && r.known);

  const ledger = {};
  usable.forEach(r => { if (r.paid > 0) ledger[r.invoiceId] = round2(r.paid); });

  const paid = round2(Object.keys(ledger).reduce((s, k) => s + ledger[k], 0));
  const total = round2(order.total);
  const due = Math.max(0, round2(total - paid));
  const before = { status: order.status, paidAmount: round2(order.paidAmount), due: amountDue(order) };

  /* What the commit WOULD do, worked out once and returned on the dry run so
     the preview and the write can never describe different things. */
  const status = String(order.status).toLowerCase();
  const frozen = status === 'shipped' || status === 'delivered';
  const nextStatus = frozen ? null
    : paid >= total - DUST ? 'paid'
    : paid > 0 ? 'underpaid'
    : null;                                   // nothing arrived — leave it where it is

  const report = {
    orderId: order.orderId,
    total,
    before,
    invoices: reads.map(r => ({
      invoiceId: r.invoiceId,
      status: r.status || '',
      billed: r.invoiceAmount || 0,
      paid: r.error || !r.known ? null : round2(r.paid),
      kind: r.kind || '',
      source: r.source || '',
      methods: r.methods || [],
      error: r.error || (r.known ? null : 'BTCPay did not report a readable amount for this invoice.')
    })),
    paid,
    due,
    nextStatus,
    frozen,
    swept,
    sweepError,
    unreadable: unreadable.length
  };

  if (unreadable.length && !force) {
    return res.status(409).json({
      error: `${unreadable.length} of ${reads.length} invoices could not be read, so $${paid.toFixed(2)} is a floor, not a total. ` +
             'Committing it could bill the buyer for money already in the wallet. Read those invoices in BTCPay, then either ' +
             'retry with force, or use "Collect the rest" with the figure you can see.',
      ...report
    });
  }

  if (dryRun) return res.json({ success: true, dryRun: true, ...report });

  /* The ledger is REPLACED, not merged: it is being restated from the payment
     processor, which is the authority on what arrived. Merging would preserve
     exactly the wrong numbers this exists to correct. */
  store.updateOrderStatus(order.orderId, null, {
    payments: ledger,
    paidAmount: paid,
    paidAmountUnknown: false,
    reconciledBy: (req.user && req.user.email) || 'admin key',
    reconciledAt: new Date().toISOString(),
    reconciledFrom: Object.keys(ledger)
  });

  const notes = [];
  if (frozen) {
    notes.push(`The ledger was corrected but the status was left at "${order.status}" — that parcel has already gone out.`);
  } else if (nextStatus === 'paid') {
    // markOrderPaid only credits points/referrals on the FIRST move to paid,
    // so a re-run cannot pay the buyer twice.
    markOrderPaid(order.orderId, { paidInFullBy: 'reconciled from BTCPay' });
  } else if (nextStatus === 'underpaid') {
    store.updateOrderStatus(order.orderId, 'underpaid', {
      underpaidAt: order.underpaidAt || new Date().toISOString()
    });
    /* Stock and points released when the order died are NOT re-reserved here:
       an underpaid order is not owed goods yet, and silently re-reserving would
       hide stock from buyers who can actually pay for it. They are retaken when
       the balance settles. */
    if (status === 'cancelled') notes.push('The order was re-opened as underpaid; its stock and points stay released until the balance is paid.');
  } else if (paid === 0) {
    notes.push('BTCPay shows nothing received against this order, so its status was left alone.');
  }

  const updated = findOrder(order.orderId);
  res.json({
    success: true,
    ...report,
    after: { status: updated.status, paidAmount: round2(updated.paidAmount), due: amountDue(updated) },
    payUrl: canPayBalance(updated) ? payLinkFor(order.orderId) : null,
    notes
  });
});

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
    const webAuthorization = buildWebAuthorization(body.webAuthorization, req);
    const declarations = buildDeclarations(body.declarations, req);
    // No points discount here: the money arrives by hand, so there's no charge
    // to reduce, and reserving points against an order that may never be paid
    // would strand them. The UI hides Zelle while points are being redeemed.
    const order = buildOrder(body.items, { shippingMethod: body.shippingMethod });
    zelle.assertPayable({ order, shipping: body.shipping });     // US-only + send-limit guards

    const orderId = newOrderId();
    /* Held the same way as a crypto invoice. A Zelle order can sit unpaid for
       days, which is exactly why the units come off the shelf now — otherwise
       the same vial gets promised again while the first transfer is in flight.
       Admin cancelling the order gives them back. */
    const stockReserved = reserveOrderStock(order);
    const instructions = zelle.instructions({ orderId, order });

    // Record it whether or not they're signed in. A guest order still has to be
    // reconcilable — otherwise the money arrives with a reference that matches
    // nothing, and the owner has no idea what to ship or where.
    // Same rule as crypto: store a resolved address, not a possibly-empty form
    // field, so the order can still be written to after today.
    const buyerEmail = body.email || (req.user && req.user.email) || '';
    const record = buildOrderRecord({
      orderId, order, method: 'zelle', status: 'awaiting_payment',
      email: buyerEmail, shipping: body.shipping, stockReserved, webAuthorization, declarations
    });
    record.expiresAt = instructions.expiresAt;

    try {
      store.addOrder(req.user ? req.user.id : store.GUEST_KEY, record);
      if (req.user) store.clearCart(req.user.id);
    } catch (e) {
      console.error('[zelle checkout] could not save order:', e.message);
      releaseOrderStock(null, stockReserved);   // unrecorded order holds nothing
      return res.status(500).json({ error: 'We could not record your order. Nothing has been charged — please try again.' });
    }

    res.status(201).json({ success: true, orderId, total: order.total, instructions });

    // After responding: the buyer needs these details in writing, and the owner
    // needs to know money is on its way. Neither should be able to fail the sale.
    sendZelleInstructionsEmail({ email: buyerEmail, orderId, order, instructions })
      .catch(err => console.error('[zelle email] failed:', err.message));
    notifyAdminOfZelleOrder({ orderId, order, email: buyerEmail, instructions })
      .catch(err => console.error('[zelle admin-notify] failed:', err.message));
  } catch (err) {
    console.error('[zelle checkout] failed:', err.message);
    res.status(err.status === 409 ? 409 : 400).json({ error: err.message });
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
        userName: owner ? `${owner.firstName} ${owner.lastName}`.trim() : '',
        // What is still owed, and whether it can be collected without a human
        // — the two things the underpaid rows are actually worked from.
        amountDue: amountDue(o),
        canCollect: canPayBalance(o)
      };
    });
  res.json({ success: true, count: orders.length, orders });
});

/* ============================================================
   ADMIN — BTCPay
   The order store records what THIS server believes. BTCPay records what
   actually happened on the blockchain. When those two disagree, it is almost
   always a webhook that never arrived (BTCPay retries, but a deploy or a
   sleeping instance can still swallow one), and the symptom is a customer who
   paid sitting at `pending` forever.

   So this endpoint does not just proxy the invoice list — it joins it against
   our own orders and marks the rows where the two disagree.
   ============================================================ */
app.get('/api/admin/btcpay', requireAdmin, async (req, res) => {
  const base = {
    configured: btcpay.CONFIGURED,
    baseUrl: btcpay.BASE_URL,
    storeId: btcpay.STORE_ID,
    hasWebhookSecret: btcpay.HAS_WEBHOOK_SECRET,
    currency: btcpay.CURRENCY
  };
  if (!btcpay.CONFIGURED) {
    return res.json({ success: true, ...base, error: 'BTCPay is not configured on this server.' });
  }

  /* The two reads need DIFFERENT permissions, so they are allowed to fail
     independently. A key scoped only to `cancreateinvoice` + `canviewinvoices`
     — which is all checkout needs — can list invoices but not read the store,
     and the invoice list is the part worth having. Failing the whole panel on
     the store lookup hid the useful half over a cosmetic one. */
  const [storeRes, invoiceRes] = await Promise.allSettled([
    btcpay.getStore(),
    btcpay.listInvoices({ take: Number(req.query.take) || 50 })
  ]);

  const store = storeRes.status === 'fulfilled' ? storeRes.value : null;
  const storeError = storeRes.status === 'rejected' ? storeRes.reason.message : null;
  const invoices = invoiceRes.status === 'fulfilled' ? invoiceRes.value : [];
  const invoiceError = invoiceRes.status === 'rejected' ? invoiceRes.reason.message : null;

  // Only when NEITHER read works is the connection itself the problem.
  if (!store && !invoices.length && invoiceError) {
    const status = invoiceRes.reason.status;
    return res.json({
      success: true, ...base, reachable: false,
      error: invoiceError,
      status,
      // A permission problem has a fix the owner can act on; name it.
      missingPermission: status === 403
        ? 'btcpay.store.canviewinvoices (and btcpay.store.canviewstoresettings for the store name)'
        : null
    });
  }

  const ordersById = new Map(store_listAllOrdersSafe().map(o => [o.orderId, o]));

  const rows = invoices.map(inv => {
    const meta = inv.metadata || {};
    const local = meta.orderId ? ordersById.get(meta.orderId) : null;
    const settled = inv.status === 'Settled';
    const localPaid = local ? String(local.status).toLowerCase() === 'paid' : false;
    return {
      id: inv.id,
      status: inv.status,
      additionalStatus: inv.additionalStatus || '',
      amount: inv.amount,
      currency: inv.currency,
      createdTime: inv.createdTime,          // unix seconds
      expirationTime: inv.expirationTime,
      checkoutLink: inv.checkoutLink,
      orderId: meta.orderId || '',
      buyerEmail: meta.buyerEmail || '',
      itemDesc: meta.itemDesc || '',
      localStatus: local ? local.status : (meta.orderId ? 'missing' : ''),
      paidAmount: inv.paidAmount || '',
      /* An invoice with no orderId was raised inside BTCPay itself, not through
         checkout — a test, or a bill sent by hand. There is no order behind it
         to release, so it is labelled rather than flagged. */
      unlinked: !meta.orderId,
      /* The rows worth acting on. Two different failures, one flag:
           · BTCPay says the money settled, our store still says unpaid — a
             webhook that never arrived. The order needs releasing by hand.
           · money reached the wallet but the invoice died anyway (underpaid, or
             paid too late). Nobody is owed a shipment yet, but somebody is owed
             either the rest of the goods or their coins back.
         Both need an order to act ON: without an orderId there is nothing to
         mark paid, and offering the button anyway just fails the request. */
      needsAttention: Boolean(meta.orderId) && !localPaid && (settled || Number(inv.paidAmount) > 0)
    };
  });

  res.json({
    success: true,
    ...base,
    reachable: true,
    store: store ? { id: store.id, name: store.name, defaultCurrency: store.defaultCurrency } : null,
    storeError,
    invoices: rows,
    invoiceError
  });
});

/* ---- ADMIN: is the confirmation pipe connected? ----
   Every automatic thing that happens after a crypto payment — order marked
   paid, buyer's receipt, "ship it" alert — hangs off BTCPay calling
   /api/crypto/webhook. When that isn't wired up the store is silent in exactly
   the way a store with no customers is silent, so this answers the question
   directly: which webhooks exist, where they point, what they're subscribed
   to, and whether the recent deliveries actually succeeded. */
app.get('/api/admin/btcpay/webhooks', requireAdmin, async (req, res) => {
  if (!btcpay.CONFIGURED) return res.status(400).json({ error: 'BTCPay is not configured on this server.' });
  let hooks;
  try {
    hooks = await btcpay.listWebhooks();
  } catch (e) {
    /* Listing webhooks needs btcpay.store.webhooks.canmodifywebhooks — BTCPay
       has no read-only variant. Say so, because "403" here reads as "no
       webhook" and would send the owner off recreating one that exists. */
    return res.status(e.status === 403 ? 200 : (e.status && e.status >= 400 ? e.status : 502)).json({
      success: e.status === 403,
      error: e.message,
      ...(e.status === 403 ? { missingPermission: 'btcpay.store.webhooks.canmodifywebhooks' } : {})
    });
  }

  const expected = `${SITE_API_BASE(req)}/api/crypto/webhook`;
  const out = await Promise.all(hooks.map(async h => {
    let deliveries = [];
    try { deliveries = await btcpay.listWebhookDeliveries(h.id, { count: 20 }); } catch { /* not fatal */ }
    const events = h.authorizedEvents || {};
    return {
      id: h.id,
      url: h.url,
      enabled: h.enabled !== false,
      everything: Boolean(events.everything),
      specificEvents: events.specificEvents || [],
      // Does this hook point at THIS server's endpoint?
      isOurs: String(h.url || '').replace(/\/+$/, '') === expected,
      deliveries: deliveries.slice(0, 20).map(d => ({
        id: d.id, timestamp: d.timestamp, success: d.success,
        errorMessage: d.errorMessage || '', isRedelivery: Boolean(d.isRedelivery)
      })),
      failedRecently: deliveries.filter(d => d.success === false).length
    };
  }));

  res.json({
    success: true,
    expectedUrl: expected,
    hasWebhookSecret: btcpay.HAS_WEBHOOK_SECRET,
    webhooks: out,
    /* The two ways this is broken without looking broken: nothing points here,
       or something points here but isn't subscribed to InvoiceSettled. */
    ourWebhook: out.find(w => w.isOurs) || null,
    settledCovered: out.some(w => w.isOurs && w.enabled &&
      (w.everything || w.specificEvents.includes('InvoiceSettled')))
  });
});

/* This server's own public base URL, as best it can be known: an explicit
   API_URL beats the host the admin happens to be calling through. */
function SITE_API_BASE(req) {
  const explicit = process.env.API_URL || '';
  if (explicit) return explicit.replace(/\/+$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

/* One invoice in full, including what was actually paid on each method —
   address, rate, amount due vs received. Used by the detail drawer. */
app.get('/api/admin/btcpay/invoices/:id', requireAdmin, async (req, res) => {
  if (!btcpay.CONFIGURED) return res.status(400).json({ error: 'BTCPay is not configured on this server.' });
  try {
    const [invoice, methods] = await Promise.all([
      btcpay.getInvoice(req.params.id),
      btcpay.getInvoicePaymentMethods(req.params.id).catch(() => [])
    ]);
    res.json({ success: true, invoice, paymentMethods: methods });
  } catch (e) {
    res.status(e.status && e.status >= 400 ? e.status : 502).json({ error: e.message });
  }
});

/* Never let a store read break the panel — an unreadable orders file should
   cost the join, not the whole page. */
function store_listAllOrdersSafe() {
  try { return store.listAllOrders(); } catch (e) { return []; }
}

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

/* ---- ADMIN: the order has left the building ----
   The last step of a sale, and the only one that isn't automatic: a paid order
   sits in the "To ship" queue until someone packs it and records how it went
   out. Recording it here is what tells the customer, so the tracking number
   reaches them instead of living in a courier's website.

   Only a PAID order can ship. Anything else is either not a sale yet or was
   written off, and shipping goods against it is the expensive kind of mistake.
   Re-posting on an already-shipped order updates the tracking (a courier
   number typed wrong is a normal thing to fix) but does not re-send the email. */
app.post('/api/admin/orders/:orderId/shipped', requireAdmin, (req, res) => {
  const existing = store.listAllOrders().find(o => o.orderId === req.params.orderId);
  if (!existing) return res.status(404).json({ error: 'No order with that reference.' });

  const status = String(existing.status).toLowerCase();
  if (status !== 'paid' && status !== 'shipped') {
    return res.status(400).json({
      error: status === 'underpaid'
        ? 'That order is short-paid, not paid. We only ship on the full amount — collect the rest or cancel and refund it.'
        : `That order is "${existing.status}", not paid. Nothing ships until the money is in.`
    });
  }

  const body = req.body || {};
  const carrier = String(body.carrier || '').trim().slice(0, 60);
  const tracking = String(body.tracking || '').trim().slice(0, 120);
  const patch = {
    shippedAt: existing.shippedAt || new Date().toISOString(),
    shippedBy: (req.user && req.user.email) || 'admin key',
    ...(carrier ? { carrier } : {}),
    ...(tracking ? { tracking } : {})
  };
  const upd = store.updateOrderStatus(req.params.orderId, 'shipped', patch);
  const alreadyShipped = status === 'shipped';

  if (!alreadyShipped) {
    sendShippedEmail(upd.order)
      .catch(err => console.error('[shipped email] failed:', err.message));
  }
  res.json({ success: true, alreadyShipped, order: upd && upd.order });
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
  refundReservedPoints(req.params.orderId);   // give back any held loyalty points
  releaseOrderStock(req.params.orderId);      // …and any units held off the shelf
  const upd = store.updateOrderStatus(req.params.orderId, 'cancelled', {
    cancelledAt: new Date().toISOString(),
    cancelledBy: (req.user && req.user.email) || 'admin key'
  });
  res.json({ success: true, order: upd && upd.order });
});

/* ---- order emails ---- */

/* Shared wrapper so every order email matches the rest of the site. */
function orderEmailHtml({ heading, intro, rowsHtml, extraHtml }) {
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
    html: orderEmailHtml({
      heading: 'One step left — send your Zelle payment',
      intro: `Thanks for your order. We're holding it for <strong>${escapeHtmlSrv(String(instructions.windowHours))} hours</strong> while we wait for your transfer.`,
      rowsHtml,
      extraHtml: `<p style="font-size:14px">Send it from your bank's app or website — look for <em>"Send money with Zelle"</em>. ` +
        `Please put <strong>${escapeHtmlSrv(instructions.memo)}</strong> in the memo; that's how we match your payment to your order.</p>
        <p style="color:#6b7280;font-size:14px">Order reference: <strong>${escapeHtmlSrv(orderId)}</strong> · Total: <strong>$${escapeHtmlSrv(order.total.toFixed(2))}</strong><br>
        We'll email you the moment it lands, and ship after that. Nothing has been taken from you yet.</p>`
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
    html: orderEmailHtml({
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
    html: orderEmailHtml({
      heading: 'Payment received ✅',
      intro: `We've received your payment of <strong>$${escapeHtmlSrv(total)}</strong> for order <strong>${escapeHtmlSrv(order.orderId)}</strong>. Thank you!`,
      extraHtml: `<p style="color:#6b7280;font-size:14px">Your order is now being prepared and will ship to the address you gave us.</p>`
    })
  });
}

/* ---- emails around a crypto (BTCPay) order ----
   Crypto is push-only: the buyer sends the money themselves, from a wallet we
   have no control over. So every state change is news to somebody — and unlike
   a card, there is no gateway dashboard that emails on our behalf. */

/* One-line-per-item summary used in both the buyer and owner emails. */
function itemLines(order) {
  return ((order && order.items) || []).map(i => `${i.quantity}× ${i.name}`).join(', ') || '—';
}

/* Plain-text block of the delivery address, for the owner's "ship it" email. */
function addressText(addr) {
  if (!addr) return '(no address on the order)';
  return [addr.name, addr.institution, addr.address,
    [addr.city, addr.state, addr.postalCode].filter(Boolean).join(', '),
    addr.countryCode].filter(Boolean).join('\n');
}

/* The buyer's copy of the pay link. A BTCPay invoice expires in minutes, and
   the checkout tab is otherwise the only place the link exists — close it and
   the order is unpayable with no way back to it. */
async function sendCryptoInvoiceEmail({ email, orderId, order, checkoutLink }) {
  if (!mailer.CONFIGURED || !email) return;
  const total = Number(order.total || 0).toFixed(2);
  return mailer.sendMail({
    to: email,
    subject: `Finish paying your Ever Nova Life order ${orderId}`,
    text: `Thanks for your order.\n\n` +
      `Order:  ${orderId}\nItems:  ${itemLines(order)}\nTotal:  $${total}\n\n` +
      `Pay in Bitcoin or Lightning here:\n${checkoutLink}\n\n` +
      `Important: send the FULL amount the invoice asks for, in one payment, before the invoice ` +
      `expires. If your wallet or exchange deducts its network fee from what you send, top the ` +
      `amount up so we receive the full total — a short payment leaves the order unpaid and has ` +
      `to be sorted out by hand.\n\n` +
      `We'll email you again the moment the payment confirms, and ship after that.\n\n— The Ever Nova Life team`,
    html: orderEmailHtml({
      heading: 'One step left — send your crypto payment',
      intro: `Thanks for your order. It's reserved for you and will be released as soon as the payment confirms.`,
      rowsHtml: `<table style="border-collapse:collapse;margin:14px 0;font-size:15px">
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Order</td><td><strong>${escapeHtmlSrv(orderId)}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Items</td><td>${escapeHtmlSrv(itemLines(order))}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Total</td><td><strong>$${escapeHtmlSrv(total)}</strong></td></tr>
      </table>`,
      extraHtml: `<p><a href="${escapeHtmlSrv(checkoutLink)}" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Pay with Bitcoin / Lightning</a></p>
        <p style="font-size:14px"><strong>Please send the full amount the invoice asks for, in one payment, before it expires.</strong>
        If your wallet or exchange takes its network fee out of what you send, add it on top — a short
        payment leaves your order unpaid and has to be sorted out by hand.</p>
        <p style="color:#6b7280;font-size:14px">We'll email you the moment it confirms, and ship after that.</p>`
    })
  });
}

/* The owner's "an invoice is live" notice. Crypto lands in the wallet whether
   or not anyone is watching this server, so the order exists in their inbox
   from the moment it is placed — not only once it pays. */
async function notifyAdminOfCryptoOrder({ orderId, order, email, invoice }) {
  const to = process.env.ADMIN_EMAIL || '';
  if (!mailer.CONFIGURED || !to) return;
  const total = Number(order.total || 0).toFixed(2);
  return mailer.sendMail({
    to,
    subject: `New crypto order (unpaid): ${orderId} ($${total})`,
    text: `A buyer opened a crypto invoice. Nothing ships until it confirms.\n\n` +
      `Order:   ${orderId}\nTotal:   $${total}\nBuyer:   ${email || '(no email)'}\n` +
      `Items:   ${itemLines(order)}\nInvoice: ${invoice.checkoutLink}\n\n` +
      `You'll get a second email if it pays. Watch it at ${SITE()}/admin.html → BTCPay.\n`,
    html: orderEmailHtml({
      heading: 'New crypto order — unpaid',
      intro: `A buyer opened a crypto invoice. Nothing ships until it confirms.`,
      rowsHtml: `<table style="border-collapse:collapse;margin:14px 0;font-size:15px">
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Order</td><td><strong>${escapeHtmlSrv(orderId)}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Total</td><td><strong>$${escapeHtmlSrv(total)}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Buyer</td><td>${escapeHtmlSrv(email || '(no email)')}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Items</td><td>${escapeHtmlSrv(itemLines(order))}</td></tr>
      </table>`,
      extraHtml: `<p><a href="${escapeHtmlSrv(invoice.checkoutLink)}" style="color:#6d28d9">View the invoice in BTCPay</a></p>`
    })
  });
}

/* The one email that means "pack a box". */
async function notifyAdminOfPaidOrder(order) {
  const to = process.env.ADMIN_EMAIL || '';
  if (!mailer.CONFIGURED || !to || !order) return;
  const total = Number(order.total || 0).toFixed(2);
  const addr = order.shippingAddress || null;
  return mailer.sendMail({
    to,
    subject: `PAID — ship order ${order.orderId} ($${total})`,
    text: `The money for this order has confirmed. It's ready to ship.\n\n` +
      `Order:  ${order.orderId}\nTotal:  $${total}\nMethod: ${order.method || '—'}\n` +
      `Buyer:  ${order.email || '(no email)'}\nItems:  ${itemLines(order)}\n\n` +
      `Ship to:\n${addressText(addr)}\n\n` +
      `Full details: ${SITE()}/admin.html → Orders\n`,
    html: orderEmailHtml({
      heading: 'Paid — ready to ship',
      intro: `The money for this order has confirmed.`,
      rowsHtml: `<table style="border-collapse:collapse;margin:14px 0;font-size:15px">
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Order</td><td><strong>${escapeHtmlSrv(order.orderId)}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Total</td><td><strong>$${escapeHtmlSrv(total)}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Buyer</td><td>${escapeHtmlSrv(order.email || '(no email)')}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Items</td><td>${escapeHtmlSrv(itemLines(order))}</td></tr>
      </table>`,
      extraHtml: `<p style="font-size:14px;white-space:pre-line;background:#f9fafb;padding:12px;border-radius:8px">${escapeHtmlSrv(addressText(addr))}</p>`
    })
  });
}

/* Money arrived, but not the full amount (or not before the invoice expired).
   This is the case that used to be written off silently, so the alert is loud:
   the store is holding both the buyer's money and the stock until a human
   decides which way it goes. */
async function notifyAdminOfUnderpaidOrder({ orderId, order, paid, due, invoiceId, payUrl, payable }) {
  const to = process.env.ADMIN_EMAIL || '';
  if (!mailer.CONFIGURED || !to) return;
  const total = order ? Number(order.total || 0).toFixed(2) : '?';
  const got = paid == null ? 'an unknown amount' : '$' + Number(paid).toFixed(2);
  const short = due == null ? 'unknown' : '$' + Number(due).toFixed(2);
  const link = btcpay.BASE_URL && invoiceId ? `${btcpay.BASE_URL}/i/${invoiceId}` : '';
  /* The difference between this alert and the old one: the buyer has already
     been handed a way to finish. Say so, or the owner starts an email thread
     that crosses with the payment. */
  const selfServe = payable && payUrl;
  return mailer.sendMail({
    to,
    subject: `ACTION NEEDED — underpaid crypto order ${orderId} (${got} of $${total})`,
    text: `A crypto invoice expired with money against it. The payment is in your wallet; ` +
      `the order is NOT paid and nothing has shipped.\n\n` +
      `Order:     ${orderId}\nInvoiced:  $${total}\nReceived:  ${got}\nStill due: ${short}\n` +
      `Buyer:     ${(order && order.email) || '(no email)'}\nItems:     ${itemLines(order)}\n` +
      (link ? `Invoice:   ${link}\n` : '') + `\n` +
      (selfServe
        ? `The buyer has been emailed a link to pay the remaining ${short}. It raises a fresh invoice ` +
          `whenever they open it, so it can't go stale:\n  ${payUrl}\n\n` +
          `If that clears, this order marks itself paid and lands in "To ship" — you don't have to do ` +
          `anything. Nothing ships until then.\n\n`
        : `We could not read how much arrived, so there is no balance to bill. Check the invoice in ` +
          `BTCPay and settle it by hand.\n\n`) +
      `The stock and any loyalty points stay held meanwhile. In ${SITE()}/admin.html you can:\n` +
      `  · re-send the pay link ("Email pay link" on the order), or\n` +
      `  · "Cancel & refund" — releases the stock and the points; send the ${got} back from your wallet.\n`,
    html: orderEmailHtml({
      heading: 'Underpaid crypto order — action needed',
      intro: `A crypto invoice expired with money against it. The payment is in your wallet, the order is <strong>not paid</strong>, and nothing has shipped.`,
      rowsHtml: `<table style="border-collapse:collapse;margin:14px 0;font-size:15px">
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Order</td><td><strong>${escapeHtmlSrv(orderId)}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Invoiced</td><td><strong>$${escapeHtmlSrv(total)}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Received</td><td><strong>${escapeHtmlSrv(got)}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Still due</td><td><strong>${escapeHtmlSrv(short)}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Buyer</td><td>${escapeHtmlSrv((order && order.email) || '(no email)')}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Items</td><td>${escapeHtmlSrv(itemLines(order))}</td></tr>
      </table>`,
      extraHtml: (selfServe
        ? `<p style="font-size:14px">The buyer has been emailed a link to pay the remaining <strong>${escapeHtmlSrv(short)}</strong>. It raises a fresh invoice every time it's opened, so it can't go stale. If that payment clears, this order marks itself paid and moves to <strong>To ship</strong> on its own.</p>
           <p style="font-size:13px;word-break:break-all;color:#6b7280">${escapeHtmlSrv(payUrl)}</p>`
        : `<p style="font-size:14px">We could not read how much arrived, so there is no balance to bill automatically. Open the invoice in BTCPay and settle this one by hand.</p>`) +
        `<p style="font-size:14px"><strong>Nothing ships on a short payment.</strong> The stock and any loyalty points stay held until it clears or you cancel — <strong>Cancel &amp; refund</strong> releases both, and you send the ${escapeHtmlSrv(got)} back from your wallet.</p>
        <p><a href="${SITE()}/admin.html" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Open admin</a>
        ${link ? ` &nbsp; <a href="${escapeHtmlSrv(link)}" style="color:#6d28d9">See the invoice</a>` : ''}</p>`
    })
  });
}

/* …and the buyer's side of the same event. They paid something and heard
   nothing, which from where they're sitting looks exactly like being robbed. */
async function sendUnderpaidEmail({ order, orderId, paid, due, payUrl, payable }) {
  const email = order && order.email;
  if (!mailer.CONFIGURED || !email) return;
  const total = Number(order.total || 0).toFixed(2);
  const got = paid == null ? 'part of the amount' : '$' + Number(paid).toFixed(2);
  const owed = due == null ? null : Number(due).toFixed(2);

  /* Without a readable amount there is no button to press — asking someone to
     pay a figure we can't work out is how you charge them twice. */
  if (!payable || !payUrl || owed == null) {
    return mailer.sendMail({
      to: email,
      subject: `We received ${got} for order ${orderId} — it's short of the total`,
      text: `Thanks for paying — but the payment we received for order ${orderId} was ${got}, and the ` +
        `invoice was for $${total}.\n\nWe only ship an order once it's paid in full, so this one is on ` +
        `hold — nothing has shipped, and your money is safe with us. Reply to this email and we'll ` +
        `either send you an invoice for the difference or refund what you sent. Your choice, and ` +
        `there's no rush either way.\n\n— The Ever Nova Life team`,
      html: orderEmailHtml({
        heading: 'Your payment came in short',
        intro: `Thanks for paying. The payment we received for order <strong>${escapeHtmlSrv(orderId)}</strong> was <strong>${escapeHtmlSrv(got)}</strong>, and the invoice was for <strong>$${escapeHtmlSrv(total)}</strong>.`,
        extraHtml: `<p style="font-size:14px">We only ship an order once it's paid in full, so this one is on hold. <strong>Nothing has shipped and your money is safe with us.</strong> Reply to this email and we'll either send you an invoice for the difference or refund what you sent — your choice, and there's no rush either way.</p>`
      })
    });
  }

  return mailer.sendMail({
    to: email,
    subject: `$${owed} left to pay on order ${orderId}`,
    text: `Thanks for paying. We received ${got} against order ${orderId}, and the total was $${total} — ` +
      `so there's $${owed} still to go. That usually happens when a wallet or exchange takes its ` +
      `network fee out of the amount you sent, or when the payment window closed part-way through.\n\n` +
      `Your ${got} is safe with us and still counted against this order. Nothing has shipped yet, ` +
      `because we only send an order out once it's paid in full.\n\n` +
      `Pay the remaining $${owed} here:\n  ${payUrl}\n\n` +
      `That link doesn't expire — it opens a fresh crypto invoice for exactly the amount outstanding ` +
      `each time you use it, so take as long as you need. The moment it clears, your order goes ` +
      `straight into our packing queue.\n\n` +
      `Would rather have the ${got} back instead? Reply to this email and we'll refund it, no ` +
      `questions asked.\n\n— The Ever Nova Life team`,
    html: orderEmailHtml({
      heading: `$${escapeHtmlSrv(owed)} left to pay`,
      intro: `Thanks for paying. We received <strong>${escapeHtmlSrv(got)}</strong> against order <strong>${escapeHtmlSrv(orderId)}</strong>, and the total was <strong>$${escapeHtmlSrv(total)}</strong> — so there's <strong>$${escapeHtmlSrv(owed)}</strong> still to go.`,
      rowsHtml: `<table style="border-collapse:collapse;margin:14px 0;font-size:15px">
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Order total</td><td>$${escapeHtmlSrv(total)}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Received</td><td>${escapeHtmlSrv(got)}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Still to pay</td><td><strong>$${escapeHtmlSrv(owed)}</strong></td></tr>
      </table>`,
      extraHtml: `<p style="font-size:14px">This usually happens when a wallet or exchange takes its network fee out of the amount you sent, or when the payment window closed part-way through. <strong>Your ${escapeHtmlSrv(got)} is safe with us and still counted against this order.</strong> Nothing has shipped yet — we only send an order out once it's paid in full.</p>
        <p><a href="${escapeHtmlSrv(payUrl)}" style="display:inline-block;background:#6d28d9;color:#fff;padding:14px 26px;border-radius:8px;text-decoration:none;font-weight:600">Pay the remaining $${escapeHtmlSrv(owed)}</a></p>
        <p style="font-size:14px;color:#6b7280">That link doesn't expire. It opens a fresh crypto invoice for exactly the amount outstanding each time you use it, so take as long as you need — the moment it clears, your order goes into our packing queue.</p>
        <p style="font-size:14px">Would rather have the ${escapeHtmlSrv(got)} back instead? Reply to this email and we'll refund it, no questions asked.</p>`
    })
  });
}

/* The same link, sent on its own — from the admin "Email pay link" button. For
   the orders that went short before any of this existed, and for the buyer who
   deleted the first email. */
async function sendBalanceLinkEmail({ order, due, payUrl }) {
  if (!mailer.CONFIGURED || !order || !order.email) {
    throw new Error('Email is not configured on this server, so the link cannot be sent.');
  }
  const owed = Number(due).toFixed(2);
  const total = Number(order.total || 0).toFixed(2);
  const got = '$' + paidSoFar(order).toFixed(2);
  return mailer.sendMail({
    to: order.email,
    subject: `$${owed} left to pay on order ${order.orderId}`,
    text: `Here's the link to finish paying for order ${order.orderId}.\n\n` +
      `Order total: $${total}\nAlready received: ${got}\nStill to pay: $${owed}\n\n` +
      `  ${payUrl}\n\n` +
      `The link doesn't expire — it opens a fresh crypto invoice for the outstanding amount each ` +
      `time you use it. As soon as it clears we pack your order and send you tracking.\n\n` +
      `Items: ${itemLines(order)}\n\n` +
      `If you'd rather we refunded the ${got} you've already sent, just reply and say so.\n\n` +
      `— The Ever Nova Life team`,
    html: orderEmailHtml({
      heading: `$${escapeHtmlSrv(owed)} left to pay`,
      intro: `Here's the link to finish paying for order <strong>${escapeHtmlSrv(order.orderId)}</strong>.`,
      rowsHtml: `<table style="border-collapse:collapse;margin:14px 0;font-size:15px">
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Order total</td><td>$${escapeHtmlSrv(total)}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Already received</td><td>${escapeHtmlSrv(got)}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Still to pay</td><td><strong>$${escapeHtmlSrv(owed)}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Items</td><td>${escapeHtmlSrv(itemLines(order))}</td></tr>
      </table>`,
      extraHtml: `<p><a href="${escapeHtmlSrv(payUrl)}" style="display:inline-block;background:#6d28d9;color:#fff;padding:14px 26px;border-radius:8px;text-decoration:none;font-weight:600">Pay the remaining $${escapeHtmlSrv(owed)}</a></p>
        <p style="font-size:14px;color:#6b7280">The link doesn't expire — it opens a fresh crypto invoice for the outstanding amount each time you use it. As soon as it clears we pack your order and send you tracking.</p>
        <p style="font-size:14px">If you'd rather we refunded the ${escapeHtmlSrv(got)} you've already sent, just reply and say so.</p>`
    })
  });
}

/* The only email the customer actually waits for. Carrier and tracking are
   optional — plenty of small shipments go out without a number — so the email
   works either way rather than refusing to send without one. */
async function sendShippedEmail(order) {
  if (!mailer.CONFIGURED || !order || !order.email) return;
  const addr = order.shippingAddress || null;
  const track = [order.carrier, order.tracking].filter(Boolean).join(' · ');
  return mailer.sendMail({
    to: order.email,
    subject: `Your Ever Nova Life order ${order.orderId} has shipped`,
    text: `Good news — order ${order.orderId} is on its way.\n\n` +
      `Items:  ${itemLines(order)}\n` +
      (track ? `Tracking: ${track}\n` : '') +
      `\nShipping to:\n${addressText(addr)}\n\n` +
      `Reply to this email if anything arrives damaged or doesn't match the order.\n\n— The Ever Nova Life team`,
    html: orderEmailHtml({
      heading: 'Your order is on its way',
      intro: `Order <strong>${escapeHtmlSrv(order.orderId)}</strong> has shipped.`,
      rowsHtml: `<table style="border-collapse:collapse;margin:14px 0;font-size:15px">
        <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Items</td><td>${escapeHtmlSrv(itemLines(order))}</td></tr>
        ${track ? `<tr><td style="padding:4px 14px 4px 0;color:#6b7280">Tracking</td><td><strong>${escapeHtmlSrv(track)}</strong></td></tr>` : ''}
      </table>`,
      extraHtml: `<p style="font-size:14px;white-space:pre-line;background:#f9fafb;padding:12px;border-radius:8px">${escapeHtmlSrv(addressText(addr))}</p>
        <p style="color:#6b7280;font-size:14px">Reply to this email if anything arrives damaged or doesn't match the order.</p>`
    })
  });
}

/* The abandoned-checkout note. Says plainly that nothing was taken, so an
   expired invoice never reads as a charge the buyer has to chase. */
async function sendInvoiceExpiredEmail(order) {
  if (!mailer.CONFIGURED || !order || !order.email) return;
  const total = Number(order.total || 0).toFixed(2);
  return mailer.sendMail({
    to: order.email,
    subject: `Your Ever Nova Life invoice expired — nothing was charged`,
    text: `The payment window for order ${order.orderId} ($${total}) closed before the payment ` +
      `arrived, so we've released the order. Nothing was taken from you.\n\n` +
      `Your items are back in stock and you can order again any time at ${SITE()}.\n\n— The Ever Nova Life team`,
    html: orderEmailHtml({
      heading: 'Your invoice expired',
      intro: `The payment window for order <strong>${escapeHtmlSrv(order.orderId)}</strong> ($${escapeHtmlSrv(total)}) closed before a payment arrived, so we've released it. <strong>Nothing was taken from you.</strong>`,
      extraHtml: `<p><a href="${SITE()}/products.html" style="display:inline-block;background:#6d28d9;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Start a new order</a></p>`
    })
  });
}

/* ============================================================
   AUTO-SHIP SCHEDULER
   Issues an invoice for every plan whose next shipment is due.
   Nothing here trusts stored money: each run re-prices the plan's
   items against the live catalog, so a price change or a delisted
   product is picked up automatically.

   Crypto is push-only, so a run does NOT move money — it opens a
   BTCPay invoice and emails the customer its pay link. The order
   lands as `pending` and the ordinary BTCPay webhook marks it paid
   when the coins arrive, exactly like a manual crypto checkout.
   "Success" here therefore means *invoiced*, not *paid*.

   Safety properties:
     · one plan is claimed for the duration of its run, so two
       overlapping triggers can't both invoice it
     · the order reference is stamped on the plan BEFORE the invoice
       is opened, so a run interrupted mid-flight reuses that
       reference instead of issuing a second invoice
     · a failure to invoice retries a few times, then pauses the
       plan and emails the customer
     · the schedule advances from the date it was DUE, not from
       "now", so a late trigger never drifts the shipment date
   ============================================================ */

const CRON_KEY = process.env.CRON_KEY || '';
const SUB_RUN_LIMIT = 25;   // plans invoiced per trigger — keeps one run bounded

/* Invoice one plan. Never throws: every outcome comes back as a result object
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
    if (!btcpay.CONFIGURED) throw new Error('Crypto payments are not configured on the server.');

    // Recovering an interrupted run: was the invoice already opened and
    // recorded? If the order exists, this plan has been served — don't send
    // the customer a second bill for the same shipment.
    if (claimed.pendingOrderId) {
      const already = store.listAllOrders().find(o => o.orderId === claimed.pendingOrderId);
      if (already) {
        subscriptions.recordSuccess(claimed.id, claimed.pendingOrderId);
        console.warn(`[autoship] ${claimed.id}: recovered an already-invoiced order ${claimed.pendingOrderId}`);
        return { id: sub.id, status: 'recovered', orderId: claimed.pendingOrderId };
      }
    }

    const order = buildOrder(claimed.items);            // authoritative, re-priced now
    const orderId = claimed.pendingOrderId || newOrderId();

    /* A repeat shipment takes stock like any other order. If the plan's items
       have run out, buildOrder/reserveStock throw and recordFailure handles it
       the same way it handles an unreachable BTCPay — the customer is told and
       the plan retries, rather than an invoice going out for goods we haven't
       got. Taken before the invoice `await`, released if the invoice fails. */
    const stockReserved = reserveOrderStock(order);

    // Write the reference down BEFORE the invoice exists, so a crash between
    // these two lines is recoverable by the check above.
    subscriptions.update(claimed.id, null, { pendingOrderId: orderId });

    let invoice;
    try {
      invoice = await btcpay.createInvoice({
        order,
        email: claimed.email || user.email,
        shipping: claimed.shippingAddress,
        orderId,
        redirectUrl: `${SITE()}/account.html#autoship`
      });
    } catch (e) {
      releaseOrderStock(null, stockReserved);
      throw e;
    }

    try {
      store.addOrder(user.id, buildOrderRecord({
        orderId, order, method: 'crypto', status: 'pending',
        email: claimed.email || user.email,
        shipping: claimed.shippingAddress,
        invoiceId: invoice.id,
        stockReserved,
        /* A repeat shipment has no checkout screen, so nobody ticks a box for
           it. Say so plainly rather than copying an "accepted" flag nobody
           gave: the authorization for this shipment is the customer choosing
           to pay its invoice (Terms §6 — nothing is ever charged
           automatically). The enrolling order holds the signed authorization. */
        webAuthorization: {
          accepted: false,
          source: 'autoship',
          subscriptionId: claimed.id,
          enrollingOrderId: claimed.firstOrderId || '',
          recordedAt: new Date().toISOString(),
          text: 'Scheduled auto-ship shipment. Not charged automatically — this shipment is authorized by the customer paying its invoice.'
        },
        /* Same for the conditions of sale: they were declared on the enrolling
           order and carry forward. Pointing at that order is honest; copying
           its "accepted" onto a screen nobody saw is not. */
        declarations: {
          source: 'autoship',
          enrollingOrderId: claimed.firstOrderId || '',
          recordedAt: new Date().toISOString(),
          text: 'Declared on the enrolling order for this auto-ship plan.'
        },
        subscriptionId: claimed.id
      }));
    } catch (e) {
      // The invoice is live — a bookkeeping failure must not look like a
      // failure to invoice, or the next run would bill them twice. The units
      // do go back, though: with no order record nothing can ever release them.
      console.error(`[autoship] ${claimed.id}: invoiced but could not record the order:`, e.message);
      releaseOrderStock(null, stockReserved);
    }

    const updated = subscriptions.recordSuccess(claimed.id, orderId);
    sendSubscriptionInvoicedEmail(user, updated || claimed, order, orderId, invoice.checkoutLink)
      .catch(err => console.error('[autoship email] failed:', err.message));

    return { id: sub.id, status: 'invoiced', orderId, total: order.total, invoiceId: invoice.id };
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

/* The whole tick: invoice what's due, then send the advance notices. */
async function runDueSubscriptions(now = Date.now()) {
  const due = subscriptions.listDue(now).slice(0, SUB_RUN_LIMIT);
  const results = [];
  for (const sub of due) {
    results.push(await runOneSubscription(sub));   // sequential: keeps BTCPay traffic calm
  }
  let reminded = 0;
  try {
    reminded = await sendDueReminders(now);
  } catch (e) {
    console.error('[autoship] reminders failed:', e.message);
  }
  const invoiced = results.filter(r => r.status === 'invoiced' || r.status === 'recovered').length;
  const failed = results.filter(r => r.status === 'failed').length;
  if (due.length || reminded) {
    console.log(`[autoship] due ${due.length} · invoiced ${invoiced} · failed ${failed} · reminders ${reminded}`);
  }
  return { due: due.length, invoiced, failed, reminded, results };
}

/* The trigger is open to the scheduled pinger (CRON_KEY) or to an admin —
   the admin path is what powers the "Run due now" button while testing.
   Re-running it is safe: a plan already invoiced for this cycle is recognised
   by its pendingOrderId and skipped. */
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
    Payment: ${escapeHtmlSrv(sub.paymentLabel || 'Bitcoin / Lightning invoice')}<br>
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
      `Your auto-ship plan is active. We'll prepare the same items ${everyPhrase(sub.intervalDays)} and ` +
      `email you a Bitcoin / Lightning invoice on each shipment date — nothing is taken automatically, ` +
      `you approve every payment.\n\n` +
      `Next shipment: ${when}\nPlan reference: ${sub.id}\n\n` +
      `We'll remind you ${subscriptions.REMINDER_DAYS} days before each one. You can change the ` +
      `frequency, skip a shipment, pause or cancel any time at ${SITE()}/account.html#autoship\n\n` +
      `— The Ever Nova Life team`,
    html: autoshipEmailHtml({
      heading: 'Your auto-ship is set up ✅',
      intro: `Hi ${escapeHtmlSrv(user.firstName || 'there')}, we'll prepare these items <strong>${escapeHtmlSrv(everyPhrase(sub.intervalDays))}</strong> and email you an invoice to pay on each shipment date. Nothing is ever taken automatically — you approve every payment.`,
      sub,
      extraHtml: `<p style="color:#6b7280;font-size:14px">Next shipment: <strong>${escapeHtmlSrv(when)}</strong><br>
        We'll remind you ${subscriptions.REMINDER_DAYS} days before each one.</p>`
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
      `A heads-up that your auto-ship order is scheduled for ${when}. We'll email you an ` +
      `invoice to pay on that date.\n\nIf you'd like to skip this one, change the items, or stop the plan, ` +
      `do it before then at ${SITE()}/account.html#autoship\n\nPlan reference: ${sub.id}\n\n` +
      `— The Ever Nova Life team`,
    html: autoshipEmailHtml({
      heading: 'Your next shipment is coming up 📦',
      intro: `Hi ${escapeHtmlSrv(user.firstName || 'there')}, your auto-ship order is scheduled for <strong>${escapeHtmlSrv(when)}</strong>. We'll email you an invoice to pay on that date.`,
      sub,
      extraHtml: `<p style="color:#6b7280;font-size:14px">Want to skip this one, swap the items, or stop the plan? Do it before ${escapeHtmlSrv(when)}.</p>`
    })
  });
}

/* The one email the whole crypto auto-ship flow hangs on: it carries the pay
   link. Without it the customer has a scheduled order and no way to pay it, so
   this is the piece to check first if shipments stop confirming. */
async function sendSubscriptionInvoicedEmail(user, sub, order, orderId, checkoutLink) {
  if (!mailer.CONFIGURED || !user || !user.email) return;
  const next = prettyDate(sub.nextRunAt);
  const total = Number(order.total).toFixed(2);
  return mailer.sendMail({
    to: user.email,
    subject: `Your Ever Nova Life auto-ship order is ready to pay — $${total}`,
    text: `Hi ${user.firstName || 'there'},\n\n` +
      `Your scheduled order is prepared. Pay the invoice below with Bitcoin or Lightning and ` +
      `we'll ship it as soon as the payment confirms.\n\n` +
      `Pay here: ${checkoutLink}\n\n` +
      `Order: ${orderId}\nAmount: $${total}\nNext shipment after this one: ${next}\n\n` +
      `Nothing has been taken from you — this invoice is only paid if you choose to pay it.\n\n` +
      `— The Ever Nova Life team`,
    html: autoshipEmailHtml({
      heading: 'Your auto-ship order is ready to pay 🧾',
      intro: `Hi ${escapeHtmlSrv(user.firstName || 'there')}, your scheduled order is prepared. Pay <strong>$${escapeHtmlSrv(total)}</strong> with Bitcoin or Lightning and we'll ship as soon as it confirms.`,
      sub,
      extraHtml: `<p><a href="${escapeHtmlSrv(checkoutLink)}" style="display:inline-block;background:#d4af37;color:#07040f;padding:13px 24px;border-radius:8px;text-decoration:none;font-weight:700">Pay $${escapeHtmlSrv(total)} now</a></p>
        <p style="color:#6b7280;font-size:14px">Order reference: <strong>${escapeHtmlSrv(orderId)}</strong><br>
        Next shipment after this one: <strong>${escapeHtmlSrv(next)}</strong></p>
        <p style="color:#6b7280;font-size:13px">Nothing has been taken from you — this invoice is only paid if you choose to pay it.</p>`
    })
  });
}

async function sendSubscriptionFailedEmail(user, sub, message, paused) {
  if (!mailer.CONFIGURED || !user || !user.email) return;
  const retryLine = paused
    ? `We've paused the plan so nothing else is attempted. Resume it from your account whenever you're ready.`
    : `We'll try again in ${subscriptions.RETRY_DAYS} days.`;
  return mailer.sendMail({
    to: user.email,
    subject: paused ? 'Your Ever Nova Life auto-ship is paused' : 'We couldn\'t prepare your auto-ship order',
    text: `Hi ${user.firstName || 'there'},\n\n` +
      `We couldn't prepare the invoice for your scheduled order, so nothing has been sent to you ` +
      `to pay.\n\n` +
      `Reason given: ${message}\n\n${retryLine}\n\n` +
      `Manage the plan here: ${SITE()}/account.html#autoship\n\nPlan reference: ${sub.id}\n\n` +
      `— The Ever Nova Life team`,
    html: autoshipEmailHtml({
      heading: paused ? 'Auto-ship paused ⏸' : 'We couldn\'t prepare that order',
      intro: `Hi ${escapeHtmlSrv(user.firstName || 'there')}, we weren't able to prepare the invoice for your scheduled order, so there's nothing for you to pay.`,
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
      `Your auto-ship plan (${sub.id}) has been cancelled — there are no further invoices and ` +
      `nothing more will ship.\n\nYou can start a new plan any time at ${SITE()}/products.html\n\n` +
      `— The Ever Nova Life team`,
    html: autoshipEmailHtml({
      heading: 'Auto-ship cancelled',
      intro: `Hi ${escapeHtmlSrv(user.firstName || 'there')}, your plan has been cancelled. <strong>There are no further invoices</strong> and nothing more will ship.`,
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
   requests like /server/.env would leak the BTCPay API key + JWT secret. */
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
