/* ============================================================
   EVER NOVA LIFE — Finagy ACH gateway (sold to us by AllayPay)

   AllayPay is the ISO that underwrote the merchant account; the
   rails underneath are Finagy (a division of TOSD Corporation).
   Everything in here follows "Transaction Processing Specifications
   for ACH Billing", updated 2026-08-14.

   We use the ACH Hosted Payment Page (HPP), not the direct
   transaction API, so the buyer's routing and account numbers are
   typed into Finagy's page and never touch this server.

   The flow, and why each step exists:

     1. server mints a bearer token   POST /api/token          (5 min life)
     2. server mints a session key    POST /api/hpp/session-keys (5 min life)
     3. browser loads Finagy's script and calls
        redirectToFinagyHostedPage(config) with that session key
     4. buyer enters bank details on Finagy's page and confirms
     5. Finagy redirects back to redirectSuccess with query params

   THE THING TO UNDERSTAND ABOUT THIS GATEWAY:

   There is no webhook. Finagy never calls us. Step 5 is a browser
   redirect carrying UNSIGNED query parameters — anyone can type that
   URL — and even when it is genuine it says `status=PENDING`, which
   is not payment. ACH money moves over days: the file goes to the
   bank that night, settles ~3 business days later, and a return
   (NSF, closed account, "I didn't authorize this") can land up to
   60 days after that.

   So payment is confirmed by ASKING, on a schedule: retrieve() for
   one transaction, querySettlements()/queryReturns() for a day. The
   redirect only tells us a transaction was created; the poller is
   what decides an order is paid. Nothing ships before status 16.

   Env (server/.env):
     FINAGY_BASE_URL      https://token.finagy.com (production) or
                          https://token-staging.finagy.com (testing).
                          Defaults to staging — production has to be
                          asked for by name.
     FINAGY_BASIC_TOKEN   the Basic Token Header Finagy issued, verbatim.
                          Preferred: it cannot be assembled wrongly.
     FINAGY_USER_ID       the Merchant User (e.g. 251) — fallback with…
     FINAGY_API_KEY       …the API key, when only the parts are to hand
     FINAGY_CLIENT_NAME   merchant name shown on Finagy's page, max 16 chars
     FINAGY_SEC_CODE      NACHA Standard Entry Class. WEB for an internet
                          order — do not change without asking Finagy.
     FINAGY_PAYMENT_METHOD  1 = ACH (confirmed from their client.min.js;
                          2 is guaranteed ACH, 3 is cards)
     FINAGY_HPP_SCRIPT    override the browser library. Normally derived from
                          FINAGY_BASE_URL — the two MUST match, see below.
   ============================================================ */

const BASE_URL = (process.env.FINAGY_BASE_URL || 'https://token-staging.finagy.com').replace(/\/+$/, '');
const USER_ID = (process.env.FINAGY_USER_ID || '').trim();
const API_KEY = (process.env.FINAGY_API_KEY || '').trim();
const CLIENT_NAME = (process.env.FINAGY_CLIENT_NAME || 'Ever Nova Life').trim();
const SEC_CODE = (process.env.FINAGY_SEC_CODE || 'WEB').trim().toUpperCase();
/* ---- the browser library, derived from the API host rather than guessed ----

   Finagy ships one build of client.min.js per environment, and each has its
   OWN token host baked in:

       hpp.finagy.com          → token.finagy.com          (production)
       hpp-staging.finagy.com  → token-staging.finagy.com  (staging)
       hpp-qa.finagy.com       → token-qa.finagy.com       (QA)

   Mixing them is a silent failure, and a nasty one. The script validates the
   session key against ITS host, and on a 401 it does this:

       if (401 == response.status) return;

   No throw, no console error, no redirect — the button simply does nothing.
   So loading the production script with a staging key produces a dead checkout
   with zero diagnostics, and the same in reverse on go-live day.

   Deriving the script host from FINAGY_BASE_URL makes the pair impossible to
   mismatch: switching to production moves both at once. Verified against all
   three builds 2026-09-09. FINAGY_HPP_SCRIPT still overrides, for the day they
   change the layout. */
function hppScriptFor(baseUrl) {
  const host = new URL(baseUrl).hostname.replace(/^token/, 'hpp');
  return `https://${host}/v1/client.min.js`;
}
const HPP_SCRIPT = (process.env.FINAGY_HPP_SCRIPT || hppScriptFor(BASE_URL)).trim();
const CURRENCY = process.env.CURRENCY || 'USD';

/* ---- the Basic credential for /api/token ----

   The v3.0 token call authenticates with `Basic base64(UserID:APIKey)`.

   Finagy issues an account with BOTH a numeric "Merchant User" (251) and a
   named "Username" (evernovalifeapi), and their documentation's worked example
   uses a bare number — so which of the two belongs in that pair is genuinely
   ambiguous from the paperwork alone. They also hand over a pre-computed
   "Basic Token Header", which settles it without anyone having to guess.

   FINAGY_BASIC_TOKEN takes precedence when set. It is the value they gave us,
   verbatim, and it cannot be assembled wrongly. FINAGY_USER_ID + FINAGY_API_KEY
   remain the fallback for when the key is rotated and only the parts are to
   hand. */
const BASIC_TOKEN = (process.env.FINAGY_BASIC_TOKEN || '')
  .trim()
  .replace(/^Basic\s+/i, '');            // tolerate them pasting the whole header

/* ---- 1 = ACH. Settled by reading their own client.min.js ----

       switch (+config.paymentMethod) {
         case 1: → ach_index.html    plain ACH          ← us
         case 2: → gach_index.html   GUARANTEED ACH
         case 3: → cc_index.html     credit card
       }

   The parameter table (p.107) was right and every worked example in the same
   document (p.103-105) was wrong. This mattered more than a typo: `2` is a
   different, separately-underwritten product — guaranteed ACH — so following
   their examples would have sent buyers to a payment page for something this
   account may not even be approved for.

   (Case 3 is a credit-card page on the same HPP. Worth knowing exists if the
   card MID ever comes through.)

   Finagy confirmed "use 1" in writing on 2026-09-09, matching what their own
   bundle does. Still an env var, because it is their switch and not ours. */
const PAYMENT_METHOD = Number(process.env.FINAGY_PAYMENT_METHOD || 1);

/* WEB transactions are single or recurring. Every order placed at checkout is
   a single debit; auto-ship raises a NEW authorization each cycle rather than
   standing on one, so it is 'S' here too. */
const WEB_TYPE = 'S';

const CONFIGURED = Boolean(BASIC_TOKEN || (USER_ID && API_KEY));

/* Production is a deliberate switch, never a default. Pointing at
   token.finagy.com moves real money out of real bank accounts. */
const IS_PRODUCTION = /(^|\.)token\.finagy\.com$/i.test(new URL(BASE_URL).hostname);

if (!CONFIGURED) {
  console.warn('[finagy] ACH checkout is off (set FINAGY_BASIC_TOKEN, or FINAGY_USER_ID + FINAGY_API_KEY, in server/.env to turn it on).');
} else if (!IS_PRODUCTION) {
  console.warn(`[finagy] ACH is pointed at ${BASE_URL} — this is the TEST environment. No real money moves.`);
}

/* ============================================================
   Transaction status — the whole point of this integration

   These are the `status` values retrieve() returns (p.64). The
   ladder matters more than the numbers: 2 and 4 mean the money is
   in flight, 16 means it actually arrived, and 8/24 mean it went
   back out again. Only 16 is payment.
   ============================================================ */
const STATUS = {
  0: 'not_found',        // Finagy has no such transaction
  1: 'invalidated',      // rejected before it ever reached the bank
  2: 'pending',          // accepted, waiting for the nightly file
  4: 'sent_to_bank',     // in the ACH network, no answer yet
  8: 'returned',         // the bank sent it back (see returnCode)
  16: 'settled',         // the money is in our account — this is "paid"
  24: 'late_return',     // settled, THEN returned. May already have shipped.
  32: 'voided',          // cancelled before the bank saw it
  40: 'refunded'         // settled, then refunded — the refund is its own credit
                         // transaction. Not in the spec; Finagy, 2026-09-11.
};

/* Which statuses are still moving, so the poller knows what to keep asking
   about. 24 is deliberately terminal-but-loud: it needs a human, not a retry. */
const OPEN_STATUSES = new Set([0, 2, 4]);

function statusName(code) {
  return STATUS[Number(code)] || 'unknown';
}

/* ============================================================
   Auth — API v3.0 (JWT). v2.0 sends the username, password and API
   key in the body of every call; v3.0 trades them once for a bearer
   token, which is both what Finagy recommends and one fewer place
   for a credential to end up in a log.

   The token lives 300 seconds. It is cached and reused, with a
   margin, because a checkout makes two calls back to back and there
   is no reason to mint a token for each.
   ============================================================ */
let cachedToken = null;         // { token, expiresAt }
let inFlightToken = null;       // de-dupes concurrent checkouts

const TOKEN_MARGIN_MS = 30_000; // refresh half a minute early

async function getToken() {
  if (!CONFIGURED) throw new Error('Finagy is not configured (set FINAGY_BASIC_TOKEN, or FINAGY_USER_ID + FINAGY_API_KEY).');

  if (cachedToken && cachedToken.expiresAt - TOKEN_MARGIN_MS > Date.now()) {
    return cachedToken.token;
  }
  // Two checkouts landing in the same tick must not mint two tokens.
  if (inFlightToken) return inFlightToken;

  inFlightToken = (async () => {
    const creds = BASIC_TOKEN || Buffer.from(`${USER_ID}:${API_KEY}`, 'utf8').toString('base64');

    /* MULTIPART, and only multipart. This is the one call in the whole API that
       does not take JSON, and it is fussier than the documentation makes clear:
       their example uses `curl -F`, which is multipart/form-data, and the
       endpoint answers 415 to both application/json AND
       application/x-www-form-urlencoded. Verified against staging 2026-09-09.

       A 415 here reads exactly like a credential problem if you are not looking
       for it — the request is rejected before anything is authenticated — so
       the shape of this body is load-bearing. FormData lets fetch set the
       boundary itself; setting Content-Type by hand would break it. */
    const form = new FormData();
    form.append('grant_type', 'client_credentials');

    const res = await request('/api/token', {
      method: 'POST',
      headers: {
        'api-version': '3.0',
        'Authorization': `Basic ${creds}`
      },
      body: form,
      // never send the bearer we are in the middle of fetching
      noAuth: true
    });

    const token = res && res.access_token;
    if (!token) throw new Error('Finagy returned no access_token.');
    const ttl = Number(res.expires_in) || 300;
    cachedToken = { token, expiresAt: Date.now() + ttl * 1000 };
    return token;
  })();

  try {
    return await inFlightToken;
  } finally {
    inFlightToken = null;
  }
}

/** Drop the cached token — called when Finagy answers 401, so the next call
    re-authenticates instead of replaying a token the server has forgotten. */
function forgetToken() { cachedToken = null; }

/* ============================================================
   One HTTP helper for the whole client.

   Errors carry `.status` so callers can tell "your key is wrong"
   (401/403) from "this transaction doesn't exist" (404) from "the
   host is down" (0). A 403 from Finagy almost always means the
   PRODUCT is not enabled on the account rather than the key being
   bad — their docs say so explicitly — and that distinction is the
   difference between a support ticket and a wild goose chase.
   ============================================================ */
async function request(path, { method = 'POST', headers = {}, body, noAuth = false, retryOn401 = true } = {}) {
  const h = {
    'accept': 'application/json',
    'api-version': '3.0',
    ...headers
  };
  if (!noAuth) h.Authorization = `Bearer ${await getToken()}`;

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, { method, headers: h, body });
  } catch (netErr) {
    const err = new Error(`Could not reach Finagy at ${BASE_URL}.`);
    err.status = 0;
    throw err;
  }

  /* An expired or revoked token looks exactly like bad credentials. Retry
     once with a fresh one before deciding the keys are wrong — otherwise a
     token that aged out between two calls fails a live checkout. */
  if (res.status === 401 && !noAuth && retryOn401) {
    forgetToken();
    return request(path, { method, headers, body, noAuth, retryOn401: false });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(finagyErrorMessage(res.status, text));
    err.status = res.status;
    err.detail = text.slice(0, 500);
    throw err;
  }

  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { raw: text }; }
}

function finagyErrorMessage(status, text) {
  if (status === 401) return 'Finagy rejected our credentials.';
  if (status === 403) return 'Finagy refused this call — the product is probably not enabled on our merchant account.';
  if (status === 404) return 'Finagy has no record of that transaction.';
  // Their 400 body is RFC7231-shaped: { title, errors: { field: [msg] } }
  if (status === 400) {
    try {
      const j = JSON.parse(text);
      const fields = j && j.errors
        ? Object.entries(j.errors).map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`).join('; ')
        : '';
      return `Finagy rejected the request. ${fields || (j && j.title) || ''}`.trim();
    } catch { /* fall through */ }
  }
  return `Finagy returned HTTP ${status}. ${String(text).slice(0, 200)}`;
}

function jsonBody(obj) {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

/* ============================================================
   HPP — the buyer-facing half
   ============================================================ */

/* Field caps straight out of the parameter table on p.106-107. They are
   enforced HERE rather than trusted, because Finagy's page silently mangles or
   rejects an over-long value and the failure surfaces as a dead checkout with
   no message. firstName at 12 and lastName at 15 are shorter than plenty of
   real names — that is Finagy's limit, not ours, and truncating beats a 400. */
const CAP = {
  clientName: 16,
  sessionKey: 36,
  redirectSuccess: 64,
  redirectFail: 64,
  firstName: 12,
  lastName: 15,
  email: 64,
  address: 50,
  zipCode: 10,
  city: 20,
  state: 2,
  clientReferenceId: 64
};

function cap(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/* ---- reading an address that comes in more than one shape ----

   This site's checkout form produces a COMBINED `name` and a `postalCode`
   (see collectCheckout in js/main.js); the API and the order records also
   carry `firstName`/`lastName`/`zip` in places. Finagy needs the parts, and
   needs the zip: an empty `zip_code` is a 400 from
   /api/hpp/transactions/ach/bank-connect/sessions, which then starves their
   Ribbit bank-login widget of a session and surfaces to the buyer as an
   unexplained 403.

   That is exactly what the first live sandbox attempt hit, and it was silent
   in every unit test because the fixtures were written in the API shape rather
   than the one the real form emits. Read every spelling, and prefer the
   canonical one. */
function pickName(shipping) {
  const s = shipping || {};
  const first = String(s.firstName || '').trim();
  const last = String(s.lastName || '').trim();
  if (first || last) return { firstName: first, lastName: last };

  const parts = String(s.name || s.fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  /* One word goes in lastName, not firstName: lastName is the field Finagy
     actually requires for a WEB entry, and their page will prompt for the
     other. Guessing the wrong half is worse than leaving one blank. */
  if (parts.length === 1) return { firstName: '', lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

function pickPostalCode(shipping) {
  const s = shipping || {};
  return String(s.postalCode || s.zip || s.zipCode || s.postcode || '').trim();
}

/**
 * Mint a session key for one checkout.
 *
 * The amount is the ONLY thing this call carries, so it is the only thing
 * Finagy can enforce — which is exactly why it is priced on this server from
 * the catalog and never taken from the browser.
 *
 * The key lives 5 minutes and is single-session. Mint it as late as possible
 * (immediately before handing the config to the browser) or the buyer walks
 * into an expired key while they are still reading the page.
 */
async function createSessionKey(amount) {
  if (!CONFIGURED) throw new Error('Finagy is not configured (missing keys in server/.env).');

  const total = Number(amount);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('Refusing to open an ACH payment for nothing — there is no amount owed.');
  }
  // Their validator wants at most two decimal places; a float like 96.39000001
  // out of our own arithmetic is a 400 nobody would guess at.
  const transaction_total = Number(total.toFixed(2));

  const res = await request('/api/hpp/session-keys', {
    method: 'POST',
    ...jsonBody({ transaction_total })
  });

  const key = res && res.session_key;
  if (!key) throw new Error('Finagy returned no session key.');
  return { sessionKey: key, amount: transaction_total, expiresInSeconds: 300 };
}

/**
 * The config object the browser hands to redirectToFinagyHostedPage().
 *
 * Nothing secret is in here: the session key is single-use, short-lived and
 * already bound to an amount Finagy stored server-side. The API key never
 * leaves this process.
 *
 * `clientReferenceId` is our order reference. It is the only thread tying
 * Finagy's transaction back to our order, so it is not optional and it is not
 * decorative — see docs/ALLAYPAY-ACH.md for the open question about whether it
 * becomes the transaction's uniqueTranId.
 */
function hppConfig({ sessionKey, orderId, shipping, email, redirectSuccess, redirectFail }) {
  const s = shipping || {};

  /* Their page will not accept a redirect URL over 64 characters, and it does
     not say so — it just fails. Better to know at checkout time. */
  for (const [field, url] of [['redirectSuccess', redirectSuccess], ['redirectFail', redirectFail]]) {
    if (String(url || '').length > CAP[field]) {
      throw new Error(`The ACH return URL is too long for Finagy (${field} must be ${CAP[field]} characters or fewer).`);
    }
  }

  const who = pickName(s);
  return {
    clientName: cap(CLIENT_NAME, CAP.clientName),
    sessionKey: cap(sessionKey, CAP.sessionKey),
    redirectSuccess,
    redirectFail,
    firstName: cap(who.firstName, CAP.firstName),
    lastName: cap(who.lastName, CAP.lastName),
    email: cap(email || s.email, CAP.email),
    address: cap(s.address || s.line1, CAP.address),
    zipCode: cap(pickPostalCode(s), CAP.zipCode),
    city: cap(s.city, CAP.city),
    state: cap(s.state, CAP.state).toUpperCase(),
    clientReferenceId: cap(orderId, CAP.clientReferenceId),
    secCode: SEC_CODE,
    paymentMethod: PAYMENT_METHOD
  };
}

/* ============================================================
   Reading back what actually happened
   ============================================================ */

/**
 * One transaction, by our reference or Finagy's.
 *
 * `authorizationId` is Finagy's own id; `uniqueTranId` is ours. Either is
 * accepted, and both are now known quantities rather than guesses — Finagy
 * confirmed on 2026-09-09 that:
 *
 *   · the `payment_id` on the redirect IS the transaction's authorizationId
 *   · the `clientReferenceId` we send in the HPP config BECOMES its uniqueTranId
 *
 * That second one is what makes this integration safe. It means an order can
 * always be found by OUR OWN reference, so a buyer who closes the tab before
 * the redirect — taking the payment_id with them — still gets their payment
 * matched to their order by the poller. Without it, that money would arrive
 * attached to nothing.
 *
 * Returns a normalised shape rather than Finagy's, so the numeric status is
 * named exactly once, here.
 */
async function retrieveTransaction({ uniqueTranId, authorizationId } = {}) {
  if (!uniqueTranId && !authorizationId) {
    throw new Error('retrieveTransaction needs a uniqueTranId or an authorizationId.');
  }
  const payload = {};
  if (uniqueTranId) payload.uniqueTranId = String(uniqueTranId);
  if (authorizationId) payload.authorizationId = String(authorizationId);

  const res = await request('/api/echeck/retrieve', { method: 'POST', ...jsonBody(payload) });
  const t = (res && res.transaction) || null;

  if (!t) {
    return {
      found: false,
      successful: Boolean(res && res.successful),
      message: (res && res.message) || 'Not found',
      status: 0,
      statusName: 'not_found'
    };
  }

  const status = Number(t.status);
  return {
    found: true,
    successful: true,
    status,
    statusName: statusName(status),
    open: OPEN_STATUSES.has(status),
    settled: status === 16,
    returned: status === 8 || status === 24,
    lateReturn: status === 24,
    voided: status === 32,
    refunded: status === 40,
    invalidated: status === 1,
    authorizationId: t.authorizationId ? String(t.authorizationId) : '',
    uniqueTranId: t.uniqueTranId || '',
    // Their NACHA return code (R01 insufficient funds, R10 not authorized, …)
    returnCode: t.returnCode || '',
    amount: Number(t.amount) || 0,
    tranCode: t.tranCode || '',
    // last four only — Finagy masks it and there is no reason for us to hold more
    accountNumber: t.accountNumber || '',
    name: [t.firstName, t.lastName].filter(Boolean).join(' ').trim(),
    raw: t
  };
}

/**
 * Everything that settled in a date range.
 *
 * The per-transaction retrieve is the primary read; this is the safety net for
 * the payment whose order we somehow lost track of — a redirect that never
 * came back, a transaction created against a reference we can't match. Finagy
 * warns that settlements are finalised at end-of-day, so a query for today run
 * too early misses rows.
 *
 * Paging trap (staging, 2026-09-11): with excludeReturnedItems=false a returned
 * row comes back on page 2 as well, with the cursor
 * {"SettlementId":0,"ReturnId":0,"ReserveId":0} — and sending that cursor starts
 * the report over, so it never reaches `pageId: null`. With
 * excludeReturnedItems=true it pages and ends normally — so read the whole
 * report through queryAllSettlements(), which asks for exactly that.
 */
async function querySettlements({ start, end, excludeReturnedItems = false, pageId } = {}) {
  const payload = {
    start: isoDay(start),
    end: isoDay(end, true),
    excludeReturnedItems: Boolean(excludeReturnedItems)
  };
  if (pageId) payload.pageId = pageId;
  const res = await request('/api/echeck/querysettlements', { method: 'POST', ...jsonBody(payload) });
  return {
    settlements: Array.isArray(res && res.settlements) ? res.settlements : [],
    pageId: (res && res.pageId) || '',
    message: (res && res.message) || ''
  };
}

/**
 * Everything the bank sent back in a date range.
 *
 * Finagy finalises returns by 11am ET, so asking about today before then can
 * miss one — the poller queries yesterday for exactly that reason.
 */
async function queryReturns({ start, end, pageId } = {}) {
  const payload = { start: isoDay(start), end: isoDay(end, true) };
  if (pageId) payload.pageId = pageId;
  const res = await request('/api/echeck/queryreturns', { method: 'POST', ...jsonBody(payload) });
  return {
    returns: Array.isArray(res && res.returns) ? res.returns : [],
    pageId: (res && res.pageId) || '',
    message: (res && res.message) || ''
  };
}

/** Everything held back from our deposits in a date range — the reserve.
    Not in the spec document; Finagy enabled it for us on 2026-09-10. Same
    start / end / pageId shape as the other two reports. */
async function queryReserves({ start, end, pageId } = {}) {
  const payload = { start: isoDay(start), end: isoDay(end, true) };
  if (pageId) payload.pageId = pageId;
  const res = await request('/api/echeck/queryreserves', { method: 'POST', ...jsonBody(payload) });
  return {
    reserves: Array.isArray(res && res.reserves) ? res.reserves : [],
    pageId: (res && res.pageId) || '',
    message: (res && res.message) || ''
  };
}

/**
 * Every row of one report, following its cursor to the end.
 *
 * `pageId` is not a page number (Andrii Seniv, Finagy, 2026-09-11). It is a
 * Base64 cursor naming the last row of the page it came with — staging's
 * decode to {"ReturnId":21457} and {"ReserveId":34} — so a page holding rows
 * always hands one back, and the ONLY end marker is asking for the next page and
 * getting `pageId: null`.
 *
 * Two guards, because one of their reports already never reaches null (see
 * querySettlements): a cursor we have already sent means the report has started
 * over, and a page cap bounds anything else. Either way `complete` is false, so
 * the caller can say rows may be missing rather than keep quiet.
 */
async function readAllPages(fetchPage, key, maxPages = 20) {
  const rows = [];
  const sent = new Set();
  let pageId;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(pageId);
    if (res.pageId && sent.has(res.pageId)) return { rows, complete: false };
    rows.push(...res[key]);
    if (!res.pageId) return { rows, complete: true };
    sent.add(res.pageId);
    pageId = res.pageId;
  }
  return { rows, complete: false };
}

async function queryAllReturns({ start, end, maxPages } = {}) {
  const { rows, complete } = await readAllPages(pageId => queryReturns({ start, end, pageId }), 'returns', maxPages);
  return { returns: rows, complete };
}

/* Returned items are left out on purpose: they are in queryAllReturns() already,
   and including them is the one setting under which this report never ends. */
async function queryAllSettlements({ start, end, maxPages } = {}) {
  const { rows, complete } = await readAllPages(
    pageId => querySettlements({ start, end, excludeReturnedItems: true, pageId }), 'settlements', maxPages);
  return { settlements: rows, complete };
}

async function queryAllReserves({ start, end, maxPages } = {}) {
  const { rows, complete } = await readAllPages(pageId => queryReserves({ start, end, pageId }), 'reserves', maxPages);
  return { reserves: rows, complete };
}

/**
 * Is this returns-report row a Notification of Change rather than a return?
 *
 * `tranStatus` on a returns row is its own scale, not the retrieve() ladder.
 * Finagy's definitions (Andrii Seniv, 2026-09-11):
 *
 *   1  the debit had settled to our bank account; the returned amount is taken
 *      back out of it on the next business day
 *   2  the debit was still pending deposit when it came back; the money never
 *      reached our account
 *   3  a Notification of Change — "for information only"
 *
 * A NOC is the receiving bank correcting a detail of the entry (C01 account
 * number, C02 routing number, C05 account type…) while letting the debit
 * THROUGH. Treated as a return it would kill an order that is being paid.
 *
 * NACHA change codes (C01–C14) never appear on a real return, so a C-code
 * decides it even when tranStatus does not: staging has already sent a
 * tranStatus that contradicts the rest of its own data.
 */
function isNotificationOfChange(row) {
  if (!row) return false;
  return Number(row.tranStatus) === 3 || /^C\d{2}$/i.test(String(row.returnReason || '').trim());
}

/** A returns-report row in words: what happened to the money. */
function returnKind(row) {
  if (isNotificationOfChange(row)) return 'notification_of_change';
  const t = Number(row && row.tranStatus);
  if (t === 1) return 'returned_after_settlement';
  if (t === 2) return 'returned_before_settlement';
  return 'returned';
}

/** A Date/ISO string as the day boundary Finagy's date-range queries expect. */
function isoDay(value, endOfDay = false) {
  const d = value instanceof Date ? new Date(value) : new Date(value || Date.now());
  if (!Number.isFinite(d.getTime())) throw new Error('Invalid date for a Finagy query.');
  if (endOfDay) d.setUTCHours(23, 59, 59, 0); else d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/* ============================================================
   Undoing a debit

   Two different operations, and using the wrong one loses money:

     void    only works the same day, before the merchant bank's
             cutoff, while the transaction is still sitting in our
             batch. Nothing ever leaves the buyer's account.
     refund  raises a NEW credit for the full original amount, and
             only works once the debit has gone to the bank. It
             cannot reverse a credit, and it cannot do part of an
             amount — a partial refund has to be a manual credit.
   ============================================================ */
async function voidTransaction(authorizationId) {
  if (!authorizationId) throw new Error('voidTransaction needs an authorizationId.');
  const res = await request('/api/echeck/void', {
    method: 'POST', ...jsonBody({ authorizationId: String(authorizationId) })
  });
  return { successful: Boolean(res && res.successful), message: (res && res.message) || '' };
}

async function refundTransaction(authorizationId) {
  if (!authorizationId) throw new Error('refundTransaction needs an authorizationId.');
  const res = await request('/api/echeck/refund', {
    method: 'POST', ...jsonBody({ authorizationId: String(authorizationId) })
  });
  return {
    successful: Boolean(res && res.successful),
    message: (res && res.message) || '',
    authorizationId: (res && res.authorizationId) || String(authorizationId)
  };
}

/** Is this routing number real, and can it take an ACH debit at all?
    Cheap pre-flight; Finagy answers from the ABA list. */
async function queryInstitution(routing) {
  const res = await request('/api/echeck/queryinstitution', {
    method: 'POST', ...jsonBody({ routing: String(routing) })
  });
  return {
    successful: Boolean(res && res.successful),
    bank: (res && res.bank) || '',
    achEligible: Boolean(res && res.achEligible),
    rtpEligible: Boolean(res && res.rtpEligible),
    message: (res && res.message) || ''
  };
}

/** Does the token endpoint answer with these keys? Used by the admin console,
    because "ACH is configured" and "ACH works" are different claims. */
async function ping() {
  forgetToken();
  await getToken();
  return { ok: true, baseUrl: BASE_URL, production: IS_PRODUCTION };
}

/* Which of the two credential shapes is in play. Names the SOURCE only — never
   the value — so the admin console can answer "did it pick up the header
   Finagy sent, or is it assembling one?" without printing a secret. */
const CREDENTIAL_SOURCE = BASIC_TOKEN ? 'basic-token' : (USER_ID && API_KEY ? 'user-id+api-key' : 'none');

module.exports = {
  CONFIGURED,
  IS_PRODUCTION,
  CREDENTIAL_SOURCE,
  BASE_URL,
  CURRENCY,
  CLIENT_NAME,
  SEC_CODE,
  WEB_TYPE,
  PAYMENT_METHOD,
  HPP_SCRIPT,
  STATUS,
  OPEN_STATUSES,
  statusName,
  createSessionKey,
  hppConfig,
  retrieveTransaction,
  querySettlements,
  queryReturns,
  queryAllReturns,
  queryAllSettlements,
  queryReserves,
  queryAllReserves,
  isNotificationOfChange,
  returnKind,
  queryInstitution,
  voidTransaction,
  refundTransaction,
  ping,
  // exported for tests
  _internal: { cap, CAP, isoDay, finagyErrorMessage, forgetToken, hppScriptFor, pickName, pickPostalCode }
};
