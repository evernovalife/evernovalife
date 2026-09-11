/* ============================================================
   EVER NOVA LIFE — ACH (Finagy / AllayPay) tests

   Finagy is stubbed by a real HTTP server on localhost, so the whole
   path runs for real — token minting, session key, retrieve, the
   status ladder — without a single packet reaching their gateway.
   That is the only way to test the part that actually matters here:
   an ACH order must NOT become a paid order until Finagy says the
   money settled, and the redirect the buyer comes back on must not
   be able to say that on their behalf.

       npm test        (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ---- a stand-in for Finagy ----
   Answers the four endpoints this integration uses. `state` is reachable from
   the tests so one can say "now the bank settled it" between assertions. */
const state = {
  status: 2,                 // what retrieve() reports; 2 = pending
  authorizationId: '6385093616797015619',
  returnCode: '',
  amount: 0,
  sessionKeys: [],           // every key we handed out
  sessionTotals: [],         // and the amount each was minted for
  tokenCalls: 0,
  retrieveCalls: 0,
  voidCalls: 0,
  refundCalls: 0,
  returns: [],               // rows for /queryreturns (one page)
  returnPages: null,         // or several pages of rows, which wins when set
  returnsCursorStuck: false, // hand back the same cursor forever
  returnsCalls: 0,
  settlementPages: [[]],     // pages of /querysettlements rows
  settlementsBodies: [],     // what each /querysettlements request asked for
  reservePages: [[]],        // pages of /queryreserves rows
  refundCreditId: '639246923014123850'   // the credit a refund raises (the live one)
};

/* Every Finagy report pages the same way on staging (2026-09-11): a page with
   rows hands back a Base64 JSON cursor naming its last row — {"ReturnId":21457},
   {"ReserveId":34} — and the report ends only when asking again returns no rows
   and `pageId: null`. */
const reportCursor = (key, base, page) => Buffer.from(JSON.stringify({ [key]: base + page })).toString('base64');
function reportPage(pages, pageId, key, base) {
  const page = pageId ? JSON.parse(Buffer.from(pageId, 'base64').toString('utf8'))[key] - base + 1 : 0;
  const rows = pages[page] || [];
  return { rows, pageId: rows.length ? reportCursor(key, base, page) : null };
}

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const json = obj => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* form-encoded token call */ }

    if (req.url === '/api/token') {
      state.tokenCalls++;
      // Finagy authenticates the token call with Basic, not Bearer.
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Basic ')) { res.writeHead(401); return res.end(); }
      return json({ access_token: 'stub-jwt', expires_in: 300, token_type: 'Bearer' });
    }

    // Everything else must carry the bearer we just issued.
    if ((req.headers.authorization || '') !== 'Bearer stub-jwt') { res.writeHead(401); return res.end(); }

    if (req.url === '/api/hpp/session-keys') {
      const key = 'sess-' + (state.sessionKeys.length + 1);
      state.sessionKeys.push(key);
      state.sessionTotals.push(body.transaction_total);
      return json({ session_key: key });
    }
    if (req.url === '/api/echeck/retrieve') {
      state.retrieveCalls++;
      if (state.status === 0) return json({ successful: false, message: 'Not found', transaction: null });
      return json({
        successful: true,
        transaction: {
          authorizationId: state.authorizationId,
          status: state.status,
          returnCode: state.returnCode,
          amount: state.amount,
          uniqueTranId: body.uniqueTranId || '',
          tranCode: 'D',
          accountNumber: '******1234',
          firstName: 'Test', lastName: 'Buyer'
        }
      });
    }
    if (req.url === '/api/echeck/queryreturns') {
      state.returnsCalls++;
      const pages = state.returnPages || [state.returns];
      if (state.returnsCursorStuck) return json({ successful: true, returns: pages[0], pageId: reportCursor('ReturnId', 21457, 0) });
      const { rows, pageId } = reportPage(pages, body.pageId, 'ReturnId', 21457);
      return json({ successful: true, returns: rows, pageId });
    }
    if (req.url === '/api/echeck/querysettlements') {
      state.settlementsBodies.push(body);
      const { rows, pageId } = reportPage(state.settlementPages, body.pageId, 'SettlementId', 25285);
      return json({ successful: true, settlements: rows, pageId });
    }
    if (req.url === '/api/echeck/queryreserves') {
      const { rows, pageId } = reportPage(state.reservePages, body.pageId, 'ReserveId', 34);
      return json({ successful: true, reserves: rows, pageId });
    }
    if (req.url === '/api/echeck/void') { state.voidCalls++; return json({ successful: true, message: null }); }
    // A refund is a NEW credit transaction with its own id (staging, 2026-09-11).
    if (req.url === '/api/echeck/refund') { state.refundCalls++; return json({ successful: true, message: '', authorizationId: state.refundCreditId }); }

    res.writeHead(404); res.end();
  });
});

// ---- environment BEFORE the app is required ----
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-ach-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-ach';
process.env.ADMIN_EMAILS = 'boss@evernovalife.com';
process.env.ALLOWED_ORIGINS = '*';
process.env.SITE_URL = 'https://enl.test';
process.env.CRON_KEY = 'test-cron-key';
process.env.FINAGY_USER_ID = '1';
process.env.FINAGY_API_KEY = 'API-TEST-KEY';
process.env.ACH_ABANDON_HOURS = '6';
delete process.env.ADMIN_KEY;

let app, finagy, store, auth, server, base, stubBase;

test.before(async () => {
  stub.listen(0);
  await once(stub, 'listening');
  stubBase = `http://127.0.0.1:${stub.address().port}`;
  // finagy.js reads its base URL at module load, so it is set before the require.
  process.env.FINAGY_BASE_URL = stubBase;

  app = require('../server.js');
  finagy = require('../finagy.js');
  store = require('../store.js');
  auth = require('../auth.js');
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) { server.close(); await once(server, 'close'); }
  stub.close(); await once(stub, 'close');
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function api(pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* no JSON body */ }
  return { status: res.status, body: parsed };
}

/* A signed-in buyer with something in the cart, ready to check out. */
let buyer = null;
async function signUpBuyer() {
  if (buyer) return buyer;
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'Test', lastName: 'Buyer', email: 'ach-buyer@example.com', password: 'sup3rsecret!' }
  });
  assert.equal(r.status, 201, 'buyer should register');
  buyer = r.body.token;
  return buyer;
}

/* EXACTLY what collectCheckout() in js/main.js emits — a COMBINED `name` and a
   `postalCode`, not firstName/lastName/zip.

   This fixture used to be written in the API shape, and that is precisely how a
   real bug reached a live sandbox test: hppConfig read `firstName`, `lastName`
   and `zip`, none of which the form produces, so Finagy received three empty
   fields. Their /bank-connect/sessions call answered 400 ("'Last Name' must not
   be empty"), which starved their Ribbit bank-login widget of a session and
   surfaced to the buyer as an unexplained 403. Every unit test passed
   throughout, because they were all testing the shape we assumed. */
const SHIPPING = {
  email: 'ach-buyer@example.com',
  name: 'Test Buyer',
  institution: 'Test Lab',
  researchField: 'Biochemistry',
  address: '1 Research Way',
  city: 'Columbus',
  state: 'OH',
  postalCode: '43215',
  countryCode: 'US'
};

const AUTH_RECORD = { accepted: true, version: 'test', acceptedAt: new Date().toISOString(), text: 'I authorize this order.' };
/* The server checks these itself — a tick-box in a browser is a courtesy to
   honest buyers and nothing at all to anyone posting straight at the API. */
const DECLARATIONS = {
  version: 'test',
  acceptedAt: new Date().toISOString(),
  items: [
    { id: 'terms', accepted: true, text: 'I accept the Terms.' },
    { id: 'age-and-use', accepted: true, text: 'I am 21+ and these will not be consumed.' }
  ]
};

async function placeAchOrder(token, extra = {}) {
  return api('/api/ach/checkout', {
    method: 'POST', token,
    body: {
      items: [{ id: 1, quantity: 1 }],
      shipping: SHIPPING,
      email: SHIPPING.email,
      webAuthorization: AUTH_RECORD,
      declarations: DECLARATIONS,
      allowDuplicate: true,
      ...extra
    }
  });
}

/* ============================================================
   The driver's own arithmetic — no network involved
   ============================================================ */

test('field caps match Finagy\'s documented maximums', () => {
  const { cap, CAP } = finagy._internal;
  assert.equal(CAP.firstName, 12);
  assert.equal(CAP.lastName, 15);
  assert.equal(CAP.redirectSuccess, 64);
  // Over-long values are cut, not passed through to be rejected by their page.
  assert.equal(cap('Bartholomew-Alexander', CAP.firstName).length, 12);
  assert.equal(cap(null, 10), '');
});

test('a redirect URL longer than Finagy allows is refused up front', () => {
  const tooLong = 'https://evernovalife.com/checkout.html?paid=ach&somethingelse=1234567890';
  assert.ok(tooLong.length > 64, 'the fixture has to actually be too long');
  assert.throws(
    () => finagy.hppConfig({
      sessionKey: 'k', orderId: 'ENL-1', shipping: SHIPPING, email: SHIPPING.email,
      redirectSuccess: tooLong, redirectFail: 'https://enl.test/x'
    }),
    /too long for Finagy/
  );
});

test('the real checkout form shape produces a COMPLETE config for Finagy', () => {
  /* The regression guard for the bug above. Finagy rejects the bank-connect
     session outright if lastName or zip_code is empty, and the buyer never
     sees why — so these three fields have to survive the form's own naming. */
  const cfg = finagy.hppConfig({
    sessionKey: 'sess-x', orderId: 'ENL-ABC123', shipping: SHIPPING, email: SHIPPING.email,
    redirectSuccess: 'https://enl.test/checkout.html?paid=ach',
    redirectFail: 'https://enl.test/checkout.html?ach=cancelled'
  });
  assert.equal(cfg.firstName, 'Test', 'a combined `name` must be split');
  assert.equal(cfg.lastName, 'Buyer', 'lastName is REQUIRED by Finagy for a WEB entry');
  assert.equal(cfg.zipCode, '43215', '`postalCode` is what this site actually calls it');
  assert.equal(cfg.address, '1 Research Way');
  assert.equal(cfg.city, 'Columbus');
  // Nothing Finagy needs may be blank.
  for (const f of ['firstName', 'lastName', 'zipCode', 'address', 'city', 'state', 'email']) {
    assert.ok(cfg[f], `${f} must not be empty — Finagy 400s on a blank one`);
  }
});

test('an address in the API shape still works', () => {
  // Order records and direct API callers use these spellings; both must read.
  const cfg = finagy.hppConfig({
    sessionKey: 'k', orderId: 'ENL-1',
    shipping: { firstName: 'Ada', lastName: 'Lovelace', zip: '10001', address: '2 Way', city: 'NY', state: 'NY' },
    email: 'a@b.c',
    redirectSuccess: 'https://enl.test/checkout.html?paid=ach',
    redirectFail: 'https://enl.test/x'
  });
  assert.equal(cfg.firstName, 'Ada');
  assert.equal(cfg.lastName, 'Lovelace');
  assert.equal(cfg.zipCode, '10001');
});

test('a one-word name goes to lastName, the field Finagy requires', () => {
  const { pickName } = finagy._internal;
  assert.deepEqual(pickName({ name: 'Cher' }), { firstName: '', lastName: 'Cher' });
  // Multi-part given names keep their parts; the surname is the last token.
  assert.deepEqual(pickName({ name: 'Maria del Carmen Rodriguez' }),
    { firstName: 'Maria del Carmen', lastName: 'Rodriguez' });
});

test('the HPP config carries our order reference and the WEB entry class', () => {
  const cfg = finagy.hppConfig({
    sessionKey: 'sess-x', orderId: 'ENL-ABC123', shipping: SHIPPING, email: SHIPPING.email,
    redirectSuccess: 'https://enl.test/checkout.html?paid=ach',
    redirectFail: 'https://enl.test/checkout.html?ach=cancelled'
  });
  assert.equal(cfg.clientReferenceId, 'ENL-ABC123');
  assert.equal(cfg.secCode, 'WEB');           // internet-initiated consumer debit
  assert.equal(cfg.state, 'OH');
  assert.equal(cfg.zipCode, '43215');
  // Nothing secret may ride along to the browser.
  assert.ok(!JSON.stringify(cfg).includes('API-TEST-KEY'));
});

test('the status ladder is named the way the rest of the code reads it', () => {
  assert.equal(finagy.statusName(2), 'pending');
  assert.equal(finagy.statusName(4), 'sent_to_bank');
  assert.equal(finagy.statusName(16), 'settled');
  assert.equal(finagy.statusName(24), 'late_return');
  // a settled debit after it has been refunded (Finagy, 2026-09-11)
  assert.equal(finagy.statusName(40), 'refunded');
  assert.equal(finagy.statusName(999), 'unknown');
});

test('a pre-computed Basic header is used verbatim, not reassembled', async () => {
  /* Finagy issues both a numeric Merchant User and a named Username, and their
     own example uses a bare number — so assembling base64(id:key) ourselves is
     a guess. When they hand over the finished header, it must go out exactly as
     given. This is checked against the stub's Authorization header rather than
     by reading the module's internals, because that is what Finagy sees. */
  delete require.cache[require.resolve('../finagy.js')];
  const saved = { ...process.env };
  process.env.FINAGY_BASIC_TOKEN = 'Basic  MjUxOnByZS1jb21wdXRlZA==';   // note the header prefix
  delete process.env.FINAGY_USER_ID;
  delete process.env.FINAGY_API_KEY;

  const seen = [];
  const original = stub.listeners('request')[0];
  const spy = (req, res) => { if (req.url === '/api/token') seen.push(req.headers.authorization); original(req, res); };
  stub.removeAllListeners('request'); stub.on('request', spy);
  try {
    const fresh = require('../finagy.js');
    assert.equal(fresh.CONFIGURED, true, 'the header alone is enough to configure ACH');
    assert.equal(fresh.CREDENTIAL_SOURCE, 'basic-token');
    await fresh.ping();
    assert.equal(seen.at(-1), 'Basic MjUxOnByZS1jb21wdXRlZA==',
      'the value Finagy issued goes out as-is, with any pasted "Basic " prefix tolerated');
  } finally {
    stub.removeAllListeners('request'); stub.on('request', original);
    process.env = saved;
    delete require.cache[require.resolve('../finagy.js')];
    require('../finagy.js');            // restore the module the other tests hold
  }
});

test('the browser script is derived from the API host, never mismatched', () => {
  /* Finagy ships one client.min.js per environment with its own token host
     baked in, and on a session-key 401 the script does `return` — no throw, no
     console error, no redirect. A production script with a staging key is
     therefore a dead button with zero diagnostics, so the pair must be
     impossible to get wrong. */
  const cases = [
    ['https://token.finagy.com',         'https://hpp.finagy.com/v1/client.min.js'],
    ['https://token-staging.finagy.com', 'https://hpp-staging.finagy.com/v1/client.min.js'],
    ['https://token-qa.finagy.com',      'https://hpp-qa.finagy.com/v1/client.min.js']
  ];
  for (const [api, script] of cases) {
    assert.equal(finagy._internal.hppScriptFor(api), script, api + ' must pair with its own script build');
  }
  // And the running module agrees with the host it is actually pointed at.
  assert.equal(new URL(finagy.HPP_SCRIPT).hostname, new URL(finagy.BASE_URL).hostname.replace(/^token/, 'hpp'));
});

test('paymentMethod 1 is plain ACH — 2 is a different, guaranteed-ACH product', () => {
  // Read out of their own client.min.js: case 1 → ach_index, 2 → gach_index,
  // 3 → cc_index. Their worked examples pass 2, which is wrong for us.
  assert.equal(finagy.PAYMENT_METHOD, 1);
});

test('staging is not mistaken for production', () => {
  // The whole suite runs against a localhost stub, which must never look live.
  assert.equal(finagy.IS_PRODUCTION, false);
});

/* ============================================================
   Guards
   ============================================================ */

test('/api/health advertises ACH and says it is not production', async () => {
  const r = await api('/api/health');
  assert.equal(r.body.ach, true);
  assert.equal(r.body.achSandbox, true, 'a non-production base URL must be flagged to the checkout');
  assert.equal(r.body.features.ach, true);
});

test('a non-US state is refused at OUR checkout, in words', async () => {
  /* Found live: a buyer typed a Philippine province into a free-text "State /
     Region" box on a US-only store. It passed our country check, then Finagy
     truncated it to two characters, rejected it, and the buyer saw an
     unexplained failure on a page we do not control. The refusal belongs here,
     where it can be explained. */
  const token = await signUpBuyer();
  const r = await placeAchOrder(token, { shipping: { ...SHIPPING, state: 'BASILAN' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not a U\.S\. state/i);
  assert.match(r.body.error, /BASILAN/, 'name what was wrong, so it can be fixed');

  // A blank one is refused too, and says what to do about it.
  const blank = await placeAchOrder(token, { shipping: { ...SHIPPING, state: '' } });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /select the U\.S\. state/i);

  // DC is a state for this purpose; the territories deliberately are not.
  const dc = await placeAchOrder(token, { shipping: { ...SHIPPING, state: 'DC' } });
  assert.equal(dc.status, 201, 'Washington DC must be accepted');
  const pr = await placeAchOrder(token, { shipping: { ...SHIPPING, state: 'PR' } });
  assert.equal(pr.status, 400, 'territories are not priced and must not slip through');
});

/* AllayPay requires an account behind every bank debit. That is satisfied by
   opening one, not by turning the buyer away — the debit is attributable to a
   named account holder either way, which is what the rule is actually for. */
const WALKIN = { ...SHIPPING, email: 'ach-walkin@example.com' };

test('a signed-out buyer can open an ACH payment, and it lands on an account', async () => {
  const r = await placeAchOrder(undefined, { shipping: WALKIN, email: WALKIN.email });
  assert.equal(r.status, 201, 'checkout works signed out');
  assert.ok(r.body.payToken, 'and carries the token that lets that browser confirm it');

  const account = auth.findByEmail(WALKIN.email);
  assert.ok(account, 'an account exists for the address they entered');
  const mine = store.listOrders(account.id).find(o => o.orderId === r.body.orderId);
  assert.ok(mine, 'the ACH order belongs to it');
  assert.equal(mine.guestCheckout, true);
});

test('a signed-out buyer confirms with their order token, and only their own', async () => {
  const mine = await placeAchOrder(undefined, { shipping: WALKIN, email: WALKIN.email });
  const other = await placeAchOrder(undefined, { shipping: WALKIN, email: WALKIN.email });

  const crossed = await api('/api/ach/confirm', {
    method: 'POST',
    body: { orderId: mine.body.orderId, paymentId: '999', t: other.body.payToken }
  });
  assert.equal(crossed.status, 404, "another order's token confirms nothing");

  const forged = await api('/api/ach/confirm', {
    method: 'POST', body: { orderId: mine.body.orderId, paymentId: '999', t: 'not-a-token' }
  });
  assert.equal(forged.status, 404, 'a made-up token confirms nothing');

  const ok = await api('/api/ach/confirm', {
    method: 'POST',
    body: { orderId: mine.body.orderId, paymentId: '424242', t: mine.body.payToken }
  });
  assert.equal(ok.status, 200, 'their own token does');
  const account = auth.findByEmail(WALKIN.email);
  const stored = store.listOrders(account.id).find(o => o.orderId === mine.body.orderId);
  assert.ok(stored.achReturnedAt, 'the return trip is filed against the order');
  /* The id ends up as whatever Finagy itself reports for this reference — the
     confirm call writes the redirect's payment_id and the sync that follows
     immediately corrects it from the gateway. Either way it is no longer empty,
     which is the whole reason a signed-out browser needs to reach this route. */
  assert.ok(stored.transactionId, 'and so is a transaction id');
});

test('the poller is not open to the public', async () => {
  const anon = await api('/api/ach/poll', { method: 'POST' });
  assert.equal(anon.status, 401);
  const asBuyer = await api('/api/ach/poll', { method: 'POST', token: await signUpBuyer() });
  assert.ok(asBuyer.status === 401 || asBuyer.status === 403, 'an ordinary account is refused');
  const asCron = await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });
  assert.equal(asCron.status, 200);
});

/* ============================================================
   The checkout itself
   ============================================================ */

test('checkout mints a session key for the SERVER-priced total, not the browser\'s', async () => {
  const token = await signUpBuyer();
  const before = state.sessionTotals.length;
  const r = await placeAchOrder(token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.orderId, 'an order reference is returned');
  assert.ok(r.body.hpp && r.body.hpp.sessionKey, 'the HPP config is returned');

  const minted = state.sessionTotals[before];
  assert.equal(minted, r.body.total, 'the session key is bound to the total the server calculated');
  assert.equal(r.body.hpp.clientReferenceId, r.body.orderId);
  assert.equal(r.body.sandbox, true);
});

test('the order opens PENDING — authorizing a debit is not paying', async () => {
  const token = await signUpBuyer();
  const r = await placeAchOrder(token);
  const orders = await api('/api/orders', { token });
  const o = orders.body.orders.find(x => x.orderId === r.body.orderId);
  assert.equal(o.status, 'pending');
  assert.equal(o.method, 'ach');
  assert.equal(o.achStatus, 'opened');
});

test('the API key never reaches the browser', async () => {
  const r = await placeAchOrder(await signUpBuyer());
  assert.ok(!JSON.stringify(r.body).includes('API-TEST-KEY'));
});

/* ============================================================
   The security property this whole design exists for
   ============================================================ */

test('the return URL cannot mark an order paid — only Finagy can', async () => {
  const token = await signUpBuyer();
  state.status = 2;                                   // Finagy: still pending
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  /* This is the attack: Finagy's redirect carries the result in unsigned query
     parameters, so a buyer can replay it saying whatever they like. */
  const r = await api('/api/ach/confirm', {
    method: 'POST', token,
    body: { orderId, paymentId: '111', code: '200', status: 'SETTLED', message: 'paid!' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.settled, false, 'the redirect must not be believed');

  const orders = await api('/api/orders', { token });
  const o = orders.body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'pending', 'the order stays unpaid until the money actually settles');
});

test('a payment id from a different session is refused', async () => {
  const token = await signUpBuyer();
  const placed = await placeAchOrder(token);
  const r = await api('/api/ach/confirm', {
    method: 'POST', token,
    body: { orderId: placed.body.orderId, paymentId: '222', sessionKey: 'sess-belonging-to-someone-else' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /does not belong/i);
});

test('one account cannot confirm another account\'s ACH order', async () => {
  const owner = await signUpBuyer();
  const placed = await placeAchOrder(owner);

  const other = await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'Other', lastName: 'Person', email: 'other-ach@example.com', password: 'sup3rsecret!' }
  });
  const r = await api('/api/ach/confirm', {
    method: 'POST', token: other.body.token,
    body: { orderId: placed.body.orderId, paymentId: '333' }
  });
  assert.equal(r.status, 404, 'someone else\'s order should not even be visible');
});

/* ============================================================
   The status ladder, end to end
   ============================================================ */

test('settled (16) is what pays the order, and only then', async () => {
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  // Still in flight: a poll changes nothing.
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });
  let orders = await api('/api/orders', { token });
  assert.equal(orders.body.orders.find(x => x.orderId === orderId).status, 'pending');

  // Sent to the bank — still not money.
  state.status = 4;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });
  orders = await api('/api/orders', { token });
  const inFlight = orders.body.orders.find(x => x.orderId === orderId);
  assert.equal(inFlight.status, 'pending');
  assert.equal(inFlight.achStatus, 'sent_to_bank');

  // Settled. Now it is a sale.
  state.status = 16;
  state.amount = placed.body.total;
  const poll = await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });
  assert.ok(poll.body.paid >= 1, 'the poll should report the settlement');
  orders = await api('/api/orders', { token });
  const paid = orders.body.orders.find(x => x.orderId === orderId);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.achStatus, 'settled');
  assert.ok(paid.paidAt, 'a paid order records when');
});

test('a return (8) puts the order back and gives the stock up', async () => {
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  state.status = 8;
  state.returnCode = 'R01';                           // insufficient funds
  const poll = await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });
  assert.ok(poll.body.returned >= 1);

  const orders = await api('/api/orders', { token });
  const o = orders.body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'returned');
  assert.equal(o.achReturnCode, 'R01');
  assert.notEqual(o.achLateReturn, true, 'a plain return never settled, so it is not a late one');
  state.returnCode = '';
});

test('a LATE return (24) is flagged and does NOT silently restock a shipped order', async () => {
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  // It settles first...
  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  /* ...and is then pulled back weeks later. A paid order is no longer in the
     poller's open sweep, so this exercises the same code path /confirm uses. */
  state.status = 24;
  state.returnCode = 'R10';                           // "I didn't authorize this"
  await api('/api/ach/confirm', { method: 'POST', token, body: { orderId, paymentId: state.authorizationId } });

  const orders = await api('/api/orders', { token });
  const o = orders.body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'returned');
  assert.equal(o.achLateReturn, true, 'a late return must be marked as such — the parcel may already be gone');
  assert.notEqual(o.stockReleased, true, 'stock must not be invented back onto the shelf');
  state.returnCode = '';
  state.status = 2;
});

/* A row from /queryreturns EXACTLY as staging sent it on 2026-09-11, for
   639245942322405169 (our order ENL-CERT-S01B, returned R01):

     { authorizationId: '639245942322405169', uniqueTranId: '639245942322405169',
       tranStatus: 1, returnReason: 'R01', dateReturned: '2026-09-10T00:00:00', ... }

   `uniqueTranId` carries Finagy's authorizationId, not the clientReferenceId we
   sent, so looking it up as an order reference matched nothing.

   `tranStatus`, as Finagy defined it on 2026-09-11: 1 = the debit had settled to
   our account and the return is taken back out next business day, 2 = it was
   still pending deposit when returned, 3 = a Notification of Change, which is
   information only. This row says 1 for a debit whose settlement row has no
   settleDate — hand-made sandbox data — so lateness is still read from our own
   record, never from this field. */
function liveReturnRow({ authorizationId, amount, returnReason, tranStatus = 1 }) {
  return {
    authorizationId, merchantId: '83', dateReturned: '2026-09-10T00:00:00',
    uniqueTranId: authorizationId, routing: '642260020', accountNumber: '************8563',
    checkNumber: null, name: 'Test Buyer', amount, returnAmount: amount,
    tranStatus, returnReason, convenienceFee: null, addenda: ''
  };
}

test('the returns feed reaches a PAID order, keyed the way the live feed keys it', async () => {
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245942322405169';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  /* Paid orders leave the per-order sweep, so the returns feed is the only thing
     that can see this one now — and retrieve has not caught up. */
  state.returns = [liveReturnRow({ authorizationId: state.authorizationId, amount: placed.body.total, returnReason: 'R10' })];
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  const orders = await api('/api/orders', { token });
  const o = orders.body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'returned', 'a return on a shipped order must not go unnoticed');
  assert.equal(o.achReturnCode, 'R10');
  assert.equal(o.achLateReturn, true, 'we had counted it as paid, so the parcel may already be gone');

  state.returns = [];
  state.authorizationId = sharedId;
  state.status = 2;
});

test('a return on a debit we never counted as paid is not a late one, whatever tranStatus says', async () => {
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245942322405170';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  // At the bank, not settled — then the bank sends it back (the live R01 case).
  state.status = 4;
  state.returns = [liveReturnRow({ authorizationId: state.authorizationId, amount: placed.body.total, returnReason: 'R01', tranStatus: 1 })];
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  const orders = await api('/api/orders', { token });
  const o = orders.body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'returned');
  assert.equal(o.achReturnCode, 'R01');
  assert.notEqual(o.achLateReturn, true, 'it never settled, so nothing shipped against it');

  state.returns = [];
  state.authorizationId = sharedId;
  state.status = 2;
});

/* ---- Notifications of Change ----
   A NOC means the receiving bank corrected a detail of the entry (C01 = account
   number, C02 = routing number, C05 = account type…) and let the debit THROUGH.
   Finagy lists NOCs in the same returns report, with tranStatus 3. */

test('a Notification of Change is known by tranStatus 3, or by a NACHA C-code', () => {
  /* C-codes only ever appear on a NOC and never on a return, so they decide it
     even when tranStatus does not — staging has already sent one tranStatus that
     disagreed with the rest of its own data. */
  const cases = [
    [{ tranStatus: 3, returnReason: 'C01' }, true],
    [{ tranStatus: '3', returnReason: '' }, true],
    [{ tranStatus: 1, returnReason: 'C05' }, true],
    [{ tranStatus: 1, returnReason: 'R01' }, false],
    [{ tranStatus: 2, returnReason: 'R10' }, false],
    [{}, false]
  ];
  for (const [row, want] of cases) {
    assert.equal(finagy.isNotificationOfChange(row), want, JSON.stringify(row));
  }
});

test('a Notification of Change does not return a payment that is still on its way', async () => {
  /* Read as a return, a NOC released the order's stock and dropped it out of the
     poller's sweep — and then the debit settled anyway, paying for a dead order. */
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245942322405171';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  state.status = 4;
  state.returns = [liveReturnRow({ authorizationId: state.authorizationId, amount: placed.body.total, returnReason: 'C01', tranStatus: 3 })];
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  let o = (await api('/api/orders', { token })).body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'pending', 'a correction notice is not a return');

  state.returns = [];
  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });
  o = (await api('/api/orders', { token })).body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'paid', 'the debit went through, so the order must still be able to pay');

  state.authorizationId = sharedId;
  state.status = 2;
});

test('a Notification of Change on a PAID order is noted, not treated as a late return', async () => {
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245942322405172';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  state.returns = [liveReturnRow({ authorizationId: state.authorizationId, amount: placed.body.total, returnReason: 'C01', tranStatus: 3 })];
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  const o = (await api('/api/orders', { token })).body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'paid', 'the money stayed with us — nothing to flag');
  assert.notEqual(o.achLateReturn, true);
  assert.equal(o.achNocCode, 'C01', 'the notice is kept on the order for staff to see');

  state.returns = [];
  state.authorizationId = sharedId;
  state.status = 2;
});

/* ---- paging ----
   Andrii Seniv, 2026-09-11: `pageId` is not a page number but a Base64 cursor
   naming the last row of the page, and the only end marker is asking for the
   next page and getting `pageId: null` back. */

test('a return on the second page of the report is still found', async () => {
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245942322405173';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  state.status = 4;
  state.returnPages = [
    [liveReturnRow({ authorizationId: '639245000000000001', amount: 12.5, returnReason: 'R02', tranStatus: 2 })],
    [liveReturnRow({ authorizationId: state.authorizationId, amount: placed.body.total, returnReason: 'R01', tranStatus: 2 })]
  ];
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  const o = (await api('/api/orders', { token })).body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'returned', 'the sweep must read past page one');
  assert.equal(o.achReturnCode, 'R01');

  state.returnPages = null;
  state.authorizationId = sharedId;
  state.status = 2;
});

test('a report cursor that never runs out cannot hang the poller', { timeout: 15_000 }, async () => {
  /* Staging really does this, on querysettlements with excludeReturnedItems=false:
     page 2 hands back {"SettlementId":0,"ReturnId":0,"ReserveId":0}, and sending
     that starts the report over. The same fault on the returns report must end
     the sweep and say so, not spin the cron job forever. */
  state.returns = [liveReturnRow({ authorizationId: '639245000000000002', amount: 3, returnReason: 'R02', tranStatus: 2 })];
  state.returnsCursorStuck = true;
  const before = state.returnsCalls;

  const poll = await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  assert.equal(poll.status, 200);
  assert.ok(state.returnsCalls - before <= 3, `asked for the report ${state.returnsCalls - before} times`);
  assert.ok(poll.body.errors.some(e => e.scope === 'returns'), 'an unfinished report is reported, not swallowed');

  state.returnsCursorStuck = false;
  state.returns = [];
});

test('a voided transaction (32) cancels the order and releases what it held', async () => {
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  state.status = 32;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  const orders = await api('/api/orders', { token });
  const o = orders.body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'cancelled');
  assert.equal(o.achStatus, 'voided');
  state.status = 2;
});

test('a debit refunded (40) before we saw it settle closes the order instead of waiting forever', async () => {
  /* A refund made in Finagy's own portal between two polls. Status 40 used to be
     'unknown', which the sync reads as "still moving": the order stayed pending,
     held its stock and was re-asked about every 30 minutes for ever. */
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  state.status = 40;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  const o = (await api('/api/orders', { token })).body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'cancelled');
  assert.equal(o.achStatus, 'refunded');
  state.status = 2;
});

test('an unreachable gateway leaves the order alone rather than killing it', async () => {
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  // Finagy has never heard of it — the normal state right after a redirect.
  state.status = 0;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  const orders = await api('/api/orders', { token });
  const o = orders.body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'pending', 'a young order that Finagy cannot see yet is not cancelled');
  state.status = 2;
});

/* ============================================================
   Resuming an unpaid payment

   A Finagy session key lives five minutes. Every ordinary
   interruption outlasts it, and before this route existed an
   interrupted buyer was stranded: order open, stock held, duplicate
   guard refusing a second attempt, nowhere to go. Found by the very
   first sandbox test.
   ============================================================ */

test('an interrupted bank payment can be picked up again with a fresh key', async () => {
  const token = await signUpBuyer();
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;
  const firstKey = placed.body.hpp.sessionKey;

  /* A genuinely interrupted buyer never submitted anything, so Finagy has NO
     transaction for this reference. That distinction is the whole point: if a
     transaction DOES exist, resuming would reuse a uniqueTranId and Finagy
     rejects it as a duplicate (see the test below). */
  state.status = 0;

  const r = await api(`/api/ach/${orderId}/resume`, { method: 'POST', token, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.hpp && r.body.hpp.sessionKey, 'a config comes back');
  assert.notEqual(r.body.hpp.sessionKey, firstKey, 'the key must be NEW — the old one is what expired');
  assert.equal(r.body.hpp.clientReferenceId, orderId, 'and still points at the same order');
  assert.equal(r.body.total, placed.body.total, 'for the same amount — never re-priced');
  state.status = 2;
});

test('the duplicate-order refusal hands back a working way in', async () => {
  const token = await signUpBuyer();
  state.status = 2;
  const first = await placeAchOrder(token);

  // The same cart again, without the allowDuplicate override the fixture sets.
  const dup = await api('/api/ach/checkout', {
    method: 'POST', token,
    body: {
      items: [{ id: 1, quantity: 1 }], shipping: SHIPPING, email: SHIPPING.email,
      webAuthorization: AUTH_RECORD, declarations: DECLARATIONS
    }
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.duplicateOf, first.body.orderId);
  assert.equal(dup.body.payKind, 'ach-resume', 'a bank order is resumed, not paid off or looked up in an email');
  assert.ok(dup.body.payUrl.includes('resume='), 'and the link actually goes somewhere');
  assert.ok(!/payment details are in your email/.test(dup.body.error),
    'never tell an ACH buyer to check an email that has no way back in');
});

test('a payment already at the bank is NOT resumable — that would debit twice', async () => {
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  // The buyer got as far as a real transaction, and it is on its way.
  state.status = 4;
  await api('/api/ach/confirm', { method: 'POST', token, body: { orderId, paymentId: state.authorizationId } });

  const r = await api(`/api/ach/${orderId}/resume`, { method: 'POST', token, body: {} });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already in progress/i);
  state.status = 2;
});

test('resume refuses when Finagy already holds a transaction we never heard about', async () => {
  /* The real case, from the first successful live run: the buyer was bounced to
     redirectFail, so /confirm never ran and `transactionId` stayed empty — while
     Finagy already held a transaction against that reference at status 1.

     Resuming would resend the same clientReferenceId, and a uniqueTranId must be
     unique ("error code 4: Transaction is duplicated"). The buyer would get a
     dead page. So resume asks Finagy rather than trusting our own record. */
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  // Finagy invalidated it; nothing told us, exactly as in production.
  state.status = 1;

  const r = await api(`/api/ach/${orderId}/resume`, { method: 'POST', token, body: {} });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already submitted/i);
  assert.match(r.body.error, /cannot be reused/i, 'say WHY, so they place a new order instead of retrying');
  assert.equal(r.body.achStatus, 'invalidated');

  // …and the lookup files what it learned rather than leaving the order lying.
  const orders = await api('/api/orders', { token });
  const o = orders.body.orders.find(x => x.orderId === orderId);
  assert.equal(o.status, 'cancelled');
  assert.equal(o.achStatus, 'invalidated');
  state.status = 2;
});

test('a paid order cannot be reopened for payment', async () => {
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  const r = await api(`/api/ach/${orderId}/resume`, { method: 'POST', token, body: {} });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already paid/i);
  state.status = 2;
});

test('resuming needs proof — a bare order reference is not enough', async () => {
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);

  // No signed token, no session: a stranger who guesses a reference gets nothing.
  const anon = await api(`/api/ach/${placed.body.orderId}/resume`, { method: 'POST', body: {} });
  assert.equal(anon.status, 404);

  // Nor does a different account.
  const other = await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'Nosy', lastName: 'Person', email: 'nosy-ach@example.com', password: 'sup3rsecret!' }
  });
  const wrong = await api(`/api/ach/${placed.body.orderId}/resume`, { method: 'POST', token: other.body.token, body: {} });
  assert.equal(wrong.status, 404);
});

/* ============================================================
   Admin
   ============================================================ */

let adminToken = null;
async function signUpAdmin() {
  if (adminToken) return adminToken;
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { firstName: 'Boss', lastName: 'Person', email: 'boss@evernovalife.com', password: 'sup3rsecret!' }
  });
  assert.equal(r.status, 201, 'admin should register');
  adminToken = r.body.token;
  return adminToken;
}

test('the ACH admin panel is admin-only and reports the environment', async () => {
  const asBuyer = await api('/api/admin/ach', { token: await signUpBuyer() });
  assert.ok(asBuyer.status === 401 || asBuyer.status === 403, 'an ordinary account is refused');

  const r = await api('/api/admin/ach', { token: await signUpAdmin() });
  assert.equal(r.status, 200);
  assert.equal(r.body.configured, true);
  assert.equal(r.body.production, false);
  assert.equal(r.body.ok, true, 'the stub answers /api/token, so the credentials check should pass');
  assert.equal(r.body.secCode, 'WEB');
  // The panel must describe the setup without printing the key that runs it.
  assert.ok(!JSON.stringify(r.body).includes('API-TEST-KEY'));
});

test('a settled debit is refunded once — the admin button cannot raise a second credit', async () => {
  /* Staging, 2026-09-11: refunding settled 639245589443869934 raised credit
     639246923014123850, and the ORIGINAL debit now reads status 40 (it read 0
     until Finagy corrected a sandbox settlement they had entered by hand). The
     button used to treat everything that was not 2 as refundable, so a second
     press would have asked Finagy to refund an already-refunded debit. */
  const token = await signUpBuyer();
  const admin = await signUpAdmin();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245589443869934';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  const before = state.refundCalls;
  const first = await api(`/api/admin/ach/${orderId}/refund`, { method: 'POST', token: admin });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.action, 'refund', 'settled money comes back by refund, not void');
  assert.equal(state.refundCalls, before + 1);

  state.status = 40;
  const second = await api(`/api/admin/ach/${orderId}/refund`, { method: 'POST', token: admin });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(state.refundCalls, before + 1, 'Finagy must not be asked to refund it again');

  state.authorizationId = sharedId;
  state.status = 2;
});

test('a debit already refunded in Finagy is refused even though our record still says paid', async () => {
  /* The live case: 639245589443869934 was refunded straight against the API, so
     order ENL-MTU5U6TG never heard. Any refund done in Finagy's portal leaves an
     order in the same place, and only Finagy's status 40 can say so. */
  const token = await signUpBuyer();
  const admin = await signUpAdmin();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245589443869936';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;

  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  state.status = 40;
  const refunds = state.refundCalls;
  const r = await api(`/api/admin/ach/${orderId}/refund`, { method: 'POST', token: admin });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.achStatus, 'refunded', 'staff are told it was refunded, not that the status is unknown');
  assert.equal(state.refundCalls, refunds, 'Finagy must not be asked to refund it again');

  state.authorizationId = sharedId;
  state.status = 2;
});

test('a debit on its way to the bank is neither voided nor refunded', async () => {
  // Status 4: too late to void, too early to refund. Finagy refuses both, so we do not ask.
  const token = await signUpBuyer();
  const admin = await signUpAdmin();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245589443869935';
  state.status = 4;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;
  await api('/api/ach/confirm', { method: 'POST', token, body: { orderId, paymentId: state.authorizationId } });

  const voids = state.voidCalls;
  const refunds = state.refundCalls;
  const r = await api(`/api/admin/ach/${orderId}/refund`, { method: 'POST', token: admin });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /sent to the bank/i, 'say why, and what to do instead');
  assert.equal(state.voidCalls, voids);
  assert.equal(state.refundCalls, refunds);

  state.authorizationId = sharedId;
  state.status = 2;
});

/* ---- a bank order is never settled or cancelled by hand ----
   Finagy decides whether the money moved. "Mark paid" on a debit that has not
   settled ships goods against money that can still bounce, and "Cancel" on one
   Finagy is still collecting closes the order while the buyer is debited anyway. */

async function adminOrder(orderId) {
  const r = await api('/api/admin/orders', { token: await signUpAdmin() });
  return r.body.orders.find(o => o.orderId === orderId);
}

test('a bank payment cannot be marked paid by hand — only a settlement pays it', async () => {
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);

  const r = await api(`/api/admin/orders/${placed.body.orderId}/paid`, { method: 'POST', token: await signUpAdmin() });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal((await adminOrder(placed.body.orderId)).status, 'pending');
});

test('cancelling a bank order Finagy is still collecting is refused — it has to be voided', async () => {
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245946244424790';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;
  await api('/api/ach/confirm', { method: 'POST', token, body: { orderId, paymentId: state.authorizationId } });

  const voids = state.voidCalls;
  const r = await api(`/api/admin/orders/${orderId}/cancel`, { method: 'POST', token: await signUpAdmin() });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /void/i, 'point at the tool that actually stops the debit');
  assert.equal((await adminOrder(orderId)).status, 'pending');
  assert.equal(state.voidCalls, voids, 'refusing must not quietly void either');

  state.authorizationId = sharedId;
});

test('a bank order Finagy never received can still be cancelled', async () => {
  const token = await signUpBuyer();
  state.status = 2;
  const placed = await placeAchOrder(token);

  state.status = 0;                                   // the buyer never finished Finagy's page
  const r = await api(`/api/admin/orders/${placed.body.orderId}/cancel`, { method: 'POST', token: await signUpAdmin() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await adminOrder(placed.body.orderId)).status, 'cancelled');
  state.status = 2;
});

/* ---- an order that has shipped stays shipped ----
   syncAchOrder used to mark ANY settled order paid unless it already said
   "paid" — and /api/ach/confirm will run it for the buyer at any time. */

test('a shipped bank order is not put back in the packing queue when its buyer confirms again', async () => {
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245589443869941';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;
  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });
  const shipped = await api(`/api/admin/orders/${orderId}/shipped`, { method: 'POST', token: await signUpAdmin(), body: { carrier: 'USPS', tracking: '9400' } });
  assert.equal(shipped.status, 200, JSON.stringify(shipped.body));

  await api('/api/ach/confirm', { method: 'POST', token, body: { orderId, paymentId: state.authorizationId } });

  assert.equal((await adminOrder(orderId)).status, 'shipped', 'a parcel that went out must not be queued to go out again');
  state.authorizationId = sharedId;
  state.status = 2;
});

test('a late return on an order that has already SHIPPED is flagged', async () => {
  // The case the returns sweep exists for — and it skipped every shipped order.
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245589443869942';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;
  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });
  await api(`/api/admin/orders/${orderId}/shipped`, { method: 'POST', token: await signUpAdmin(), body: { carrier: 'USPS', tracking: '9401' } });

  state.returns = [liveReturnRow({ authorizationId: state.authorizationId, amount: placed.body.total, returnReason: 'R10', tranStatus: 1 })];
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  const o = await adminOrder(orderId);
  assert.equal(o.status, 'returned', 'the money came back out after the parcel left');
  assert.equal(o.achLateReturn, true);

  state.returns = [];
  state.authorizationId = sharedId;
  state.status = 2;
});

/* ---- Check with Finagy ----
   The poller never re-reads a PAID order, so a refund made in Finagy's own
   portal is invisible to us. The live order ENL-MTU5U6TG is in exactly that
   state: refunded straight against the API, still "paid" here. */

test('Check with Finagy picks up a refund made outside our console on a paid order', async () => {
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245589443869937';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;
  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  state.status = 40;
  const r = await api(`/api/admin/ach/${orderId}/sync`, { method: 'POST', token: await signUpAdmin() });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const o = await adminOrder(orderId);
  assert.equal(o.status, 'cancelled', 'a refunded sale is not a paid one');
  assert.equal(o.achStatus, 'refunded');

  state.authorizationId = sharedId;
  state.status = 2;
});

test('a refund keeps the id of the credit it raised', async () => {
  /* The credit comes back with uniqueTranId null, so nothing Finagy sends later
     can name the order it belongs to. The only record of the link is the id the
     refund call returns — which used to be thrown away. */
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245589443869938';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;
  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  const r = await api(`/api/admin/ach/${orderId}/refund`, { method: 'POST', token: await signUpAdmin() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await adminOrder(orderId)).achRefundTransactionId, '639246923014123850');

  state.authorizationId = sharedId;
  state.status = 2;
});

/* ---- the three Finagy reports, in the console ----
   SALE-08/09/10 on the certification sheet. Rows exactly as staging sent them. */

function liveSettlementRow({ authorizationId, amount, transactionCode = 'D', settleDate = '2026-09-10T00:00:00', returnDate = null, returnReasonCode = null }) {
  return {
    authorizationId, merchantId: '83', settleDate, uniqueTranId: authorizationId, routing: '642260020',
    accountNumber: '************4906', checkNumber: null, name: 'Test Buyer', amount, convenienceFee: null,
    transactionCode, returnDate, returnReasonCode
  };
}
const LIVE_RESERVE_ROW = {
  merchantId: '83', merchantLegalName: 'Ever NovA Life', merchantDBAName: 'Ever NovA Life',
  debitAdjustment: 100, debitReason: '', currentReserveBalance: 100, reserveDate: '2026-09-10T18:48:38'
};

test('the Finagy admin routes refuse an ordinary account', async () => {
  const token = await signUpBuyer();
  const reports = await api('/api/admin/ach/reports', { token });
  assert.ok(reports.status === 401 || reports.status === 403, 'reports');
  const sync = await api('/api/admin/ach/ENL-NOPE/sync', { method: 'POST', token });
  assert.ok(sync.status === 401 || sync.status === 403, 'sync');
});

test('a return row is labelled by what happened to the money', () => {
  const cases = [
    [{ tranStatus: 1, returnReason: 'R01' }, 'returned_after_settlement'],
    [{ tranStatus: 2, returnReason: 'R10' }, 'returned_before_settlement'],
    [{ tranStatus: 3, returnReason: 'C01' }, 'notification_of_change'],
    [{ tranStatus: 1, returnReason: 'C02' }, 'notification_of_change'],
    [{ returnReason: 'R02' }, 'returned']
  ];
  for (const [row, want] of cases) assert.equal(finagy.returnKind(row), want, JSON.stringify(row));
});

test('the reports read every page of settlements, returns and reserves, tied to our orders', async () => {
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245589443869939';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;
  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });

  state.settlementPages = [
    [liveSettlementRow({ authorizationId: '639245000000000010', amount: 9 })],
    [liveSettlementRow({ authorizationId: state.authorizationId, amount: placed.body.total })]
  ];
  state.returnPages = [
    [liveReturnRow({ authorizationId: '639245000000000011', amount: 4, returnReason: 'R02', tranStatus: 2 })],
    [liveReturnRow({ authorizationId: state.authorizationId, amount: placed.body.total, returnReason: 'C01', tranStatus: 3 })]
  ];
  state.reservePages = [[LIVE_RESERVE_ROW]];
  state.settlementsBodies = [];

  const r = await api('/api/admin/ach/reports?start=2026-09-01&end=2026-09-13', { token: await signUpAdmin() });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.equal(r.body.settlements.length, 2, 'both pages of settlements');
  assert.equal(r.body.settlements.find(s => s.authorizationId === state.authorizationId).orderId, orderId);
  assert.ok(state.settlementsBodies.every(b => b.excludeReturnedItems === true),
    'with returned items included, staging never reaches the end of this report');

  assert.equal(r.body.returns.length, 2, 'both pages of returns');
  const ours = r.body.returns.find(x => x.authorizationId === state.authorizationId);
  assert.equal(ours.orderId, orderId);
  assert.equal(ours.kind, 'notification_of_change');

  assert.equal(r.body.reserves.length, 1);
  assert.equal(r.body.reserveBalance, 100);
  assert.deepEqual([r.body.settlementsComplete, r.body.returnsComplete, r.body.reservesComplete], [true, true, true]);

  state.settlementPages = [[]];
  state.returnPages = null;
  state.reservePages = [[]];
  state.authorizationId = sharedId;
  state.status = 2;
});

test('a refund credit in the settlements report is tied back to its order', async () => {
  const token = await signUpBuyer();
  const sharedId = state.authorizationId;
  state.authorizationId = '639245589443869940';
  state.refundCreditId = '639246923014123851';
  state.status = 2;
  const placed = await placeAchOrder(token);
  const orderId = placed.body.orderId;
  state.status = 16;
  state.amount = placed.body.total;
  await api('/api/ach/poll', { method: 'POST', headers: { 'x-cron-key': 'test-cron-key' } });
  await api(`/api/admin/ach/${orderId}/refund`, { method: 'POST', token: await signUpAdmin() });

  // The credit carries no reference of ours — only its own authorizationId.
  state.settlementPages = [[liveSettlementRow({ authorizationId: '639246923014123851', amount: placed.body.total, transactionCode: 'C' })]];
  const r = await api('/api/admin/ach/reports?start=2026-09-01&end=2026-09-13', { token: await signUpAdmin() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settlements[0].orderId, orderId);

  state.settlementPages = [[]];
  state.refundCreditId = '639246923014123850';
  state.authorizationId = sharedId;
  state.status = 2;
});

test('a report range that is not a real range is refused in words', async () => {
  const admin = await signUpAdmin();
  const bad = await api('/api/admin/ach/reports?start=yesterday&end=2026-09-13', { token: admin });
  assert.equal(bad.status, 400);
  const backwards = await api('/api/admin/ach/reports?start=2026-09-13&end=2026-09-01', { token: admin });
  assert.equal(backwards.status, 400);
});
