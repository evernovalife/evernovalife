# Agent Account Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the ElevenLabs chat and voice agent answer a signed-in customer's questions about their own orders, points, auto-ship plans and cart, without ever asking for an order reference.

**Architecture:** A signed-in browser trades its session JWT for a short-lived, read-only, scope-marked token and hands that to the widget as a dynamic variable. ElevenLabs' tool layer templates the token into a request header on a new read-only endpoint, so the model never sees or retypes it. That endpoint requires the existing agent shared secret *and* the account token; the account is chosen by the token's subject and by nothing in the request body.

**Tech Stack:** Node 18+, Express, `jsonwebtoken`, `node:test` (built-in runner, no extra deps), vanilla browser JS, ElevenLabs Agents webhook tools.

**Spec:** `docs/superpowers/specs/2026-08-27-agent-account-context-design.md` — read it before Task 1. It carries the reasoning this plan only executes.

## Global Constraints

- **Read-only, always.** No endpoint added by this plan may write anything. No cancel, no pause, no redeem, no add-to-cart.
- **The account comes from the token's `sub` and nothing else.** Never read a user id, email, or order reference out of a request body or query string on these routes.
- **No street address anywhere in an agent response.** City, state, country only. This holds for orders and for subscriptions.
- **Signed-out behaviour must not change.** A visitor with no session gets exactly today's chat.
- **The chat bubble must never fail to mount** because of anything this plan adds. Every new browser-side call degrades to signed-out.
- **The shared-secret env var is `ELEVENLABS_AGENT_SECRET`** (not `AGENT_SECRET` — that is only the local constant name in `server/server.js`).
- **This project's HTML files are UTF-8 with no BOM.** Never edit them with PowerShell `Get-Content`/`Out-File`; it double-encodes every non-ASCII character site-wide. Use Python (`encoding='utf-8', newline=''`) or the Edit tool.
- **Tests run from the `server/` folder:** `npm test`.

---

### Task 1: The scoped agent-read token

**Files:**
- Modify: `server/auth.js` — add the mint/verify pair near `refToken` (around line 295-320), harden `verifyToken` (line 287), extend `module.exports` (line 334)
- Test: `server/test/agent-token.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `auth.mintAgentToken(user)` → `string` — signs `{ sub: user.id, scope: 'agent-read' }`
  - `auth.verifyAgentToken(token)` → `{ sub, scope, iat, exp } | null`
  - `auth.AGENT_TOKEN_TTL_SECONDS` → `number` (1800)
  - `auth.verifyToken(token)` now returns `null` for any payload carrying a `scope` claim

Why this task exists at all: `auth.verifyToken` currently accepts any JWT signed with the server secret that parses. An agent token is exactly that. Without the hardening below, the credential we hand to a third party would open every `requireAuth` route on the server — the opposite of the point.

- [ ] **Step 1: Write the failing test**

Create `server/test/agent-token.test.js`:

```js
/* ============================================================
   EVER NOVA LIFE — the agent's scoped account token
   The token a signed-in browser hands to ElevenLabs. It must be
   strictly weaker than the session token that minted it, in both
   directions: a session token is not accepted as an agent token,
   and an agent token is not accepted as a session token.
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// auth.js reads JWT_SECRET at module load — set it before requiring.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-agent-token-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-agent-token';

const jwt = require('jsonwebtoken');
const auth = require('../auth.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

const USER = { id: 'u_test_1', email: 'someone@example.com' };

test('a minted agent token verifies and carries the account it was minted for', () => {
  const payload = auth.verifyAgentToken(auth.mintAgentToken(USER));
  assert.ok(payload, 'a freshly minted token should verify');
  assert.strictEqual(payload.sub, USER.id);
  assert.strictEqual(payload.scope, 'agent-read');
});

test('a session token is not accepted as an agent token', () => {
  const session = jwt.sign({ sub: USER.id, email: USER.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
  assert.strictEqual(auth.verifyAgentToken(session), null);
});

test('an agent token is not accepted as a session token', () => {
  // The whole point: this token is handed to a third party, so it must not
  // open the routes the session token opens.
  assert.strictEqual(auth.verifyToken(auth.mintAgentToken(USER)), null);
});

test('an expired agent token is refused', () => {
  const stale = jwt.sign({ sub: USER.id, scope: 'agent-read' }, process.env.JWT_SECRET, { expiresIn: '-1s' });
  assert.strictEqual(auth.verifyAgentToken(stale), null);
});

test('garbage, an empty string and a token signed with another secret are refused', () => {
  assert.strictEqual(auth.verifyAgentToken('not-a-token'), null);
  assert.strictEqual(auth.verifyAgentToken(''), null);
  const foreign = jwt.sign({ sub: USER.id, scope: 'agent-read' }, 'a-different-secret', { expiresIn: '30m' });
  assert.strictEqual(auth.verifyAgentToken(foreign), null);
});

test('the advertised TTL is half an hour', () => {
  assert.strictEqual(auth.AGENT_TOKEN_TTL_SECONDS, 1800);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from the `server/` folder:

```bash
node --test test/agent-token.test.js
```

Expected: FAIL — `auth.mintAgentToken is not a function`.

- [ ] **Step 3: Add the mint/verify pair to `server/auth.js`**

Insert immediately after the `verifyRefToken` function (around line 317), before the `requireAuth` comment block:

```js
/* ---- scoped, read-only tokens for the chat agent ----
   The agent is talking to someone this server cannot otherwise identify.
   This token is how the browser says who that is — so it is deliberately
   weaker than the session token that mints it: it is accepted by exactly
   one read-only route, it carries a scope that stops it being spent
   anywhere else, and it is short-lived.

   Short-lived matters more than it looks. A JWT cannot be revoked without
   a server-side token store, which this module does not keep, so signing
   out leaves an already-minted token alive until it expires. This number
   is the whole of that exposure, and it is bounded above by the fact that
   the same still-signed-in browser can read the same data from the
   account page anyway. */
const AGENT_TOKEN_TTL_SECONDS = Number(process.env.AGENT_TOKEN_TTL_SECONDS) || 30 * 60;
const AGENT_SCOPE = 'agent-read';

function mintAgentToken(u) {
  return jwt.sign({ sub: u.id, scope: AGENT_SCOPE }, SECRET, { expiresIn: AGENT_TOKEN_TTL_SECONDS });
}

function verifyAgentToken(token) {
  try {
    const payload = jwt.verify(String(token || ''), SECRET);
    return payload && payload.scope === AGENT_SCOPE ? payload : null;
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 4: Harden `verifyToken` in the same file**

Replace the existing `verifyToken` (line 287):

```js
function verifyToken(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    /* A session token carries no scope. Anything that does was minted for one
       narrow job and handed to somebody else — see mintAgentToken — so it must
       not be spendable here. Without this line the token we give a third party
       would open every requireAuth route on the server. */
    if (payload && payload.scope) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 5: Export the new functions**

In the `module.exports` block (line 334), add these three entries beside `verifyToken`:

```js
  verifyToken,
  mintAgentToken,
  verifyAgentToken,
  AGENT_TOKEN_TTL_SECONDS,
```

- [ ] **Step 6: Run the new test and the existing suite**

```bash
node --test test/agent-token.test.js
npm test
```

Expected: the new file PASSES all six tests, and `test/authz.test.js` still passes in full. If any existing authz test breaks, the `verifyToken` change is the suspect — a session token must still verify, because it has no `scope`.

- [ ] **Step 7: Commit**

```bash
git add server/auth.js server/test/agent-token.test.js
git commit -m "feat(auth): scoped read-only token for the chat agent

A session token authorizes checkout and a password change, so it must
never be the thing handed to a vendor. This mints a separate token that
opens exactly one read-only route, scoped and short-lived.

The scope check runs both ways. verifyToken now refuses any payload
carrying a scope, because an agent token is otherwise a valid session
token signed with the same secret."
```

---

### Task 2: The mint endpoint

**Files:**
- Modify: `server/server.js` — add beside the existing agent routes, after `requireAgent` (around line 2578) and before `app.get('/api/agent/product')`
- Test: `server/test/authz.test.js` — add env setup at the top and a new test block at the end

**Interfaces:**
- Consumes: `auth.mintAgentToken`, `auth.AGENT_TOKEN_TTL_SECONDS` from Task 1.
- Produces: `POST /api/agent/account-token` → `200 { success: true, token, ttl, firstName }` for a signed-in caller, `401 { error }` otherwise. Task 5 (the widget) calls this; Task 3's tests use it to obtain a token.

- [ ] **Step 1: Give the test file the agent shared secret**

`server/test/authz.test.js` sets env before requiring the app. Add one line beside the other `process.env` assignments near line 28, just above `delete process.env.ADMIN_KEY`:

```js
process.env.ELEVENLABS_AGENT_SECRET = 'test-agent-secret';
```

Without it `requireAgent` fails closed — correctly — and every agent test in this plan gets a 401 for the wrong reason.

- [ ] **Step 2: Write the failing tests**

Append to `server/test/authz.test.js`:

```js
/* ============================================================
   The chat agent's account context
   ============================================================ */

/* Like api(), but for the agent's own routes: the shared secret proves the
   caller is our agent, and x-account-token says who it is talking to. */
async function agentApi(pathname, { secret = 'test-agent-secret', accountToken, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['x-agent-secret'] = secret;
  if (accountToken !== undefined) headers['x-account-token'] = accountToken;
  const res = await fetch(base + pathname, {
    method: 'POST', headers, body: JSON.stringify(body || {})
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* no JSON body */ }
  return { status: res.status, body: parsed };
}

/* A registered account plus a freshly minted agent token for it. */
async function signedInWithAgentToken(email, firstName = 'Sam') {
  const reg = await register(email, 'password123', firstName, 'Tester');
  const mint = await api('/api/agent/account-token', { method: 'POST', token: reg.body.token });
  return { sessionToken: reg.body.token, agentToken: mint.body.token, mint };
}

test('a signed-in browser can mint an agent token, and an anonymous one cannot', async () => {
  const { mint } = await signedInWithAgentToken('agent-mint@example.com', 'Sam');
  assert.strictEqual(mint.status, 200);
  assert.ok(mint.body.token, 'a token should come back');
  assert.strictEqual(mint.body.ttl, 1800);
  assert.strictEqual(mint.body.firstName, 'Sam');

  const anon = await api('/api/agent/account-token', { method: 'POST' });
  assert.strictEqual(anon.status, 401);
});

test('the minted agent token cannot be spent as a session token', async () => {
  const { agentToken } = await signedInWithAgentToken('agent-replay@example.com');
  // Two ordinary account routes, both behind requireAuth. Neither may open.
  const orders = await api('/api/orders', { token: agentToken });
  assert.strictEqual(orders.status, 401);
  const cart = await api('/api/cart', { token: agentToken });
  assert.strictEqual(cart.status, 401);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
node --test test/authz.test.js
```

Expected: FAIL — the mint returns 404 (no such route), so `mint.body.token` is undefined.

- [ ] **Step 4: Add the endpoint**

In `server/server.js`, immediately after the `requireAgent` function closes (around line 2578) and before the `agentProductView` comment block:

```js
/* ---- the browser's half of the agent's identity ----
   A signed-in visitor trades their session token for one that can do a
   great deal less: read this one account, read-only, for half an hour.
   That is what reaches ElevenLabs. The session token never does — it
   authorizes checkout and a password change, and it would sit in a vendor's
   conversation record for thirty days.

   The limiter runs BEFORE requireAuth so an anonymous flood is capped too,
   and it is sized for real browsing: js/chat.js caches the token in
   sessionStorage and only re-mints in the last five minutes of its life, so
   an ordinary shopping session mints once or twice, not once per page. */
const agentTokenMintLimiter = ratelimit.limit({
  name: 'agent-token-mint',
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'Too many chat sessions from this connection. Wait a few minutes and try again.'
});

app.post('/api/agent/account-token', agentTokenMintLimiter, auth.requireAuth, (req, res) => {
  res.json({
    success: true,
    token: auth.mintAgentToken(req.user),
    ttl: auth.AGENT_TOKEN_TTL_SECONDS,
    /* Returned rather than read from the browser's cached enl_user: the
       request is already being made, this server already holds the record,
       and a greeting taken from here cannot disagree with a stale cache. */
    firstName: req.user.firstName || ''
  });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test test/authz.test.js
```

Expected: PASS, both new tests, and everything already in the file.

- [ ] **Step 6: Commit**

```bash
git add server/server.js server/test/authz.test.js
git commit -m "feat(agent): endpoint to mint a signed-in visitor's agent token

The browser asks for this at chat mount and hands the result to the
widget. Rate-limited ahead of the auth check so anonymous probes are
capped as well."
```

---

### Task 3: The account endpoint, orders only

**Files:**
- Modify: `server/server.js` — helpers and route after the mint endpoint from Task 2
- Test: `server/test/authz.test.js` — append

**Interfaces:**
- Consumes: `auth.verifyAgentToken`, `auth.getUserById`; the existing `round2`, `paidSoFar`, `amountDue`, `canPayBalance`, `payLinkFor` helpers (`server/server.js:1511-1575`); the existing `requireAgent` and `agentLimiter` middleware; `agentApi()` and `signedInWithAgentToken()` from Task 2's tests.
- Produces:
  - `POST /api/agent/account` → `200 { success: true, customer, orders }`
  - `agentPlace(address)` → `{ city, state, country }` — Task 4 reuses this for subscriptions
  - `buildAccountSnapshot(user)` → the response object — Task 4 extends it
  - `AGENT_MAX_ORDERS` = `10`

- [ ] **Step 1: Write the failing tests**

Append to `server/test/authz.test.js`:

```js
test('the account endpoint needs BOTH the shared secret and a valid account token', async () => {
  const { agentToken } = await signedInWithAgentToken('agent-both@example.com');

  // Right token, no shared secret.
  const noSecret = await agentApi('/api/agent/account', { secret: null, accountToken: agentToken });
  assert.strictEqual(noSecret.status, 401);

  // Right token, wrong shared secret.
  const wrongSecret = await agentApi('/api/agent/account', { secret: 'wrong-secret', accountToken: agentToken });
  assert.strictEqual(wrongSecret.status, 401);

  // Right shared secret, no account token.
  const noToken = await agentApi('/api/agent/account', {});
  assert.strictEqual(noToken.status, 401);

  // Right shared secret, a session token where an account token belongs.
  const { sessionToken } = await signedInWithAgentToken('agent-session-swap@example.com');
  const swapped = await agentApi('/api/agent/account', { accountToken: sessionToken });
  assert.strictEqual(swapped.status, 401);

  // Both correct.
  const ok = await agentApi('/api/agent/account', { accountToken: agentToken });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.customer.firstName, 'Sam');
  assert.ok(Array.isArray(ok.body.orders));
});

test('one customer\'s agent token never returns another customer\'s orders', async () => {
  const alice = await signedInWithAgentToken('agent-alice@example.com', 'Alice');
  const bob = await signedInWithAgentToken('agent-bob@example.com', 'Bob');

  const asAlice = await agentApi('/api/agent/account', { accountToken: alice.agentToken });
  assert.strictEqual(asAlice.status, 200);
  assert.strictEqual(asAlice.body.customer.firstName, 'Alice');

  const asBob = await agentApi('/api/agent/account', { accountToken: bob.agentToken });
  assert.strictEqual(asBob.body.customer.firstName, 'Bob');
});

test('nothing in the request body can steer which account is read', async () => {
  const alice = await signedInWithAgentToken('agent-steer-a@example.com', 'Alice');
  const bob = await signedInWithAgentToken('agent-steer-b@example.com', 'Bob');

  // Bob's token, Alice's identifiers in the body. The token wins, every time.
  const res = await agentApi('/api/agent/account', {
    accountToken: bob.agentToken,
    body: { userId: 'anything', email: 'agent-steer-a@example.com', orderId: 'ENL-AAAAAAAA' }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.customer.firstName, 'Bob');
});

test('an expired account token is refused with a sentence the agent can read out', async () => {
  const jwtLib = require('jsonwebtoken');
  const stale = jwtLib.sign({ sub: 'u_nobody', scope: 'agent-read' }, process.env.JWT_SECRET, { expiresIn: '-1s' });
  const res = await agentApi('/api/agent/account', { accountToken: stale });
  assert.strictEqual(res.status, 401);
  assert.match(res.body.error, /sign in again/i);
});

test('at most the ten most recent orders come back, newest first', async () => {
  const reg = await register('agent-cap@example.com');
  const userId = reg.body.user.id;
  const mint = await api('/api/agent/account-token', { method: 'POST', token: reg.body.token });

  /* Seeded through the store directly rather than through checkout: a real
     order needs a live payment provider, and what is under test here is the
     cap and the ordering, not how an order comes into being. Same process,
     same DATA_DIR, so this is the store the app is reading. */
  const store = require('../store.js');
  for (let n = 1; n <= 12; n++) {
    store.addOrder(userId, {
      orderId: 'ENL-CAP' + String(n).padStart(5, '0'),
      createdAt: '2026-08-' + String(n).padStart(2, '0') + 'T00:00:00.000Z',
      status: 'paid',
      method: 'crypto',
      items: [{ id: 1, name: 'Test item', unitPrice: 10, quantity: 1, lineTotal: 10 }],
      total: 10,
      email: 'agent-cap@example.com',
      shippingAddress: null
    });
  }

  const res = await agentApi('/api/agent/account', { accountToken: mint.body.token });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.orders.length, 10);
  assert.strictEqual(res.body.orders[0].orderId, 'ENL-CAP00012');
  assert.strictEqual(res.body.orders[9].orderId, 'ENL-CAP00003');
});

test('no street address appears anywhere in the account response', async () => {
  const { agentToken } = await signedInWithAgentToken('agent-address@example.com');
  const res = await agentApi('/api/agent/account', { accountToken: agentToken });
  assert.strictEqual(res.status, 200);
  /* Scanning the whole serialized response rather than named fields, so that a
     later change which starts returning the address somewhere new fails here
     instead of passing. */
  const text = JSON.stringify(res.body);
  assert.ok(!/"(address1|address2|street|line1|line2)"/i.test(text),
    'the response must not carry a street address in any field');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test test/authz.test.js
```

Expected: FAIL — `/api/agent/account` does not exist, so the "both correct" case is 404, not 200.

- [ ] **Step 3: Add the helpers and the route**

In `server/server.js`, after the mint endpoint added in Task 2:

```js
/* Everything returned to the agent can end up spoken aloud, written to
   agent-transcripts/ on this disk, and stored in the vendor's conversation
   log. Ten orders answers every real support question; an unbounded history
   is just a bigger thing to leak. */
const AGENT_MAX_ORDERS = 10;

/* City and state, never the street line. "Where is my package" is fully
   answerable from the carrier, the tracking number and the destination city,
   and the street line is the highest-harm field in that transcript. */
function agentPlace(address) {
  const a = address || {};
  return {
    city: String(a.city || ''),
    state: String(a.state || ''),
    country: String(a.country || 'US')
  };
}

/* paidSoFar/amountDue/canPayBalance rather than a second opinion about the
   same numbers: the short-paid order is this shop's most common real support
   case, and the agent must offer the SAME pay-the-balance link the email
   offers, never a second invoice for goods already partly paid for. */
function agentOrderView(o) {
  return {
    orderId: o.orderId,
    createdAt: o.createdAt,
    status: o.status,
    method: o.method || '',
    items: (o.items || []).map(i => ({ name: i.name, quantity: i.quantity })),
    total: round2(o.total),
    paid: paidSoFar(o),
    due: amountDue(o),
    shippingLabel: o.shippingLabel || '',
    carrier: o.carrier || '',
    tracking: o.tracking || '',
    shippedAt: o.shippedAt || '',
    ...agentPlace(o.shippingAddress),
    payUrl: canPayBalance(o) ? payLinkFor(o.orderId) : ''
  };
}

function buildAccountSnapshot(user) {
  const orders = store.listOrders(user.id)
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, AGENT_MAX_ORDERS)
    .map(agentOrderView);

  return {
    customer: { firstName: user.firstName || '' },
    orders
  };
}

/* ---- the visitor's own account, read-only ----
   TWO credentials answering two different questions: the shared secret says
   "this is our agent", and the account token says "and this is who it is
   talking to". Neither is sufficient alone.

   The account is chosen by the token's subject and by nothing else. No id,
   email or order reference is read from the body — a chat agent asking for
   an account by name is exactly the hole this design exists to avoid. */
app.post('/api/agent/account', requireAgent, agentLimiter, (req, res) => {
  const payload = auth.verifyAgentToken(req.get('x-account-token') || '');
  if (!payload) {
    // Read out loud by the agent, so it has to be a sentence.
    return res.status(401).json({
      error: 'That session has expired. Ask them to sign in again on the site, then start a new chat.'
    });
  }

  const user = auth.getUserById(payload.sub);
  if (!user) return res.status(401).json({ error: 'That account no longer exists.' });

  res.json({ success: true, ...buildAccountSnapshot(user) });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS, all five new tests plus everything already there.

- [ ] **Step 5: Commit**

```bash
git add server/server.js server/test/authz.test.js
git commit -m "feat(agent): read-only account endpoint, orders

Two credentials, two questions: the shared secret says this is our agent,
the account token says who it is talking to. The account is chosen by the
token's subject and by nothing in the request body.

City and state only - everything here can end up in a vendor transcript,
and the street line answers no question that the tracking number doesn't."
```

---

### Task 4: Loyalty, auto-ship and cart in the snapshot

**Files:**
- Modify: `server/server.js` — extend `buildAccountSnapshot`, add two view helpers beside `agentOrderView`
- Test: `server/test/authz.test.js` — append

**Interfaces:**
- Consumes: `buildAccountSnapshot` and `agentPlace` from Task 3; the already-required `loyalty`, `subscriptions`, `store` and `productStore` modules (`server/server.js:25-28`).
- Produces: the same endpoint, now also returning `loyalty`, `subscriptions` and `cart`.

Two traps this task exists to avoid, both of which look like the obvious implementation:

1. `subscriptions.publicSubscription()` returns `shippingAddress` **in full**, plus the account email. Pick the wanted fields; do not delete the unwanted ones, or the next field added to that serializer lands in a vendor transcript by default.
2. `buildOrder()` from `pricing.js` is the natural way to price a cart and is the wrong tool here: it **throws** on an unpublished or out-of-stock line (`server/pricing.js:59-60`). A cart holding one pulled product must still be describable, so price line by line off the catalogue instead.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/authz.test.js`:

```js
test('the account response carries points, auto-ship and the cart', async () => {
  const { sessionToken, agentToken } = await signedInWithAgentToken('agent-full@example.com');

  // Put something in the cart through the ordinary route first.
  const products = await api('/api/products');
  const first = products.body.products[0];
  await api('/api/cart', {
    method: 'PUT', token: sessionToken,
    body: { items: [{ id: first.id, name: first.name, price: first.price, quantity: 2 }] }
  });

  const res = await agentApi('/api/agent/account', { accountToken: agentToken });
  assert.strictEqual(res.status, 200);

  assert.strictEqual(typeof res.body.loyalty.points, 'number');
  assert.strictEqual(typeof res.body.loyalty.worth, 'number');
  assert.ok(Array.isArray(res.body.subscriptions));

  assert.strictEqual(res.body.cart.items.length, 1);
  assert.strictEqual(res.body.cart.items[0].quantity, 2);
  // Priced off the live catalogue, not off whatever the browser saved.
  assert.strictEqual(res.body.cart.items[0].unitPrice, first.price);
  assert.strictEqual(res.body.cart.subtotal, Math.round(first.price * 2 * 100) / 100);
});

test('a cart line the browser mispriced is corrected from the catalogue', async () => {
  const { sessionToken, agentToken } = await signedInWithAgentToken('agent-cart-price@example.com');
  const products = await api('/api/products');
  const first = products.body.products[0];

  // A browser claiming this costs a dollar. The agent must not repeat that.
  await api('/api/cart', {
    method: 'PUT', token: sessionToken,
    body: { items: [{ id: first.id, name: 'Something cheap', price: 1, quantity: 1 }] }
  });

  const res = await agentApi('/api/agent/account', { accountToken: agentToken });
  assert.strictEqual(res.body.cart.items[0].unitPrice, first.price);
  assert.strictEqual(res.body.cart.items[0].name, first.name);
});

test('a cart holding an unknown product still returns, flagged unavailable', async () => {
  const { sessionToken, agentToken } = await signedInWithAgentToken('agent-cart-ghost@example.com');
  await api('/api/cart', {
    method: 'PUT', token: sessionToken,
    body: { items: [{ id: 999999, name: 'Ghost', price: 10, quantity: 1 }] }
  });

  // buildOrder() would throw here. This endpoint must not.
  const res = await agentApi('/api/agent/account', { accountToken: agentToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.cart.items.length, 1);
  assert.strictEqual(res.body.cart.items[0].available, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test test/authz.test.js
```

Expected: FAIL — `Cannot read properties of undefined (reading 'points')`.

- [ ] **Step 3: Add the two view helpers**

In `server/server.js`, immediately after `agentOrderView`:

```js
/* publicSubscription() carries the full shipping address and the account
   email. Pick the fields the agent needs rather than deleting the ones it
   must not have: a field added to that serializer later then has to be added
   here deliberately, instead of arriving in a vendor's transcript because
   nobody remembered this file. */
function agentSubscriptionView(s) {
  const p = subscriptions.publicSubscription(s) || {};
  return {
    id: p.id,
    status: p.status,
    items: (p.items || []).map(i => ({ name: i.name, quantity: i.quantity })),
    intervalDays: p.intervalDays,
    nextRunAt: p.nextRunAt || '',
    paymentLabel: p.paymentLabel || '',
    ...agentPlace(p.shippingAddress)
  };
}

/* Priced off the live catalogue, never off what the browser saved into the
   cart — a price that has moved since would otherwise be quoted by the agent
   and then contradicted by checkout.

   buildOrder() is the obvious tool and the wrong one: it THROWS on a line
   that is unpublished or out of stock, and a cart holding one pulled product
   must still be describable. Unavailable lines come back flagged instead. */
function agentCartView(userId) {
  const items = store.getCart(userId).map(line => {
    const product = productStore.getProduct(line.id);
    const available = Boolean(product) &&
      productStore.isPublished(product) &&
      product.inStock !== false &&
      productStore.isAvailable(product);
    return {
      name: (product && product.name) || line.name || '',
      quantity: line.quantity,
      unitPrice: product ? round2(product.price) : 0,
      available
    };
  });
  const subtotal = round2(items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0));
  return { items, subtotal };
}
```

- [ ] **Step 4: Extend `buildAccountSnapshot`**

Replace the `return` block of `buildAccountSnapshot` with:

```js
  const points = loyalty.getBalance(user.id);

  return {
    customer: { firstName: user.firstName || '' },
    orders,
    loyalty: { points, worth: round2(loyalty.pointsToDollars(points)) },
    subscriptions: subscriptions.listForUser(user.id).map(agentSubscriptionView),
    cart: agentCartView(user.id)
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS. The address-scan test from Task 3 now also covers the subscription view — if `shippingAddress` leaked through `publicSubscription`, that test fails here.

- [ ] **Step 6: Commit**

```bash
git add server/server.js server/test/authz.test.js
git commit -m "feat(agent): points, auto-ship and cart in the account snapshot

The cart is priced from the catalogue rather than from what the browser
saved, so the agent cannot quote a total checkout will disagree with.
buildOrder() would have been the obvious way to do that and throws on an
unavailable line - a cart holding a pulled product still has to be
describable.

Subscriptions are picked field by field out of publicSubscription(),
which returns the full shipping address."
```

---

### Task 5: The widget hands the token to ElevenLabs

**Files:**
- Modify: `js/chat.js` — the `mount()` function and its callers
- Modify: every `*.html` at the repo root — `chat.js?v=87` → `chat.js?v=93`
- Test: manual, in a browser (there is no browser test harness in this repo)

**Interfaces:**
- Consumes: `POST /api/agent/account-token` from Task 2.
- Produces: an `<elevenlabs-convai>` element carrying `dynamic-variables` with `signed_in`, `first_name` and `account_token`. Task 6's tool config templates `{{account_token}}` out of it.

The one rule that outranks the feature: **the bubble must still mount**. A failed mint, a timeout, an expired session, a `sessionStorage` that throws in private mode — all of them fall through to the signed-out attributes and mount anyway.

- [ ] **Step 1: Replace the body of `mount()` in `js/chat.js`**

The current `mount()` (line 36) sets one attribute and appends. Replace the whole function, and add the two helpers above it:

```js
  /* The token is minted per browsing session, not per page. Without the
     cache, every page load mints another live credential and an ordinary
     shopping session would trip any sanely-sized limit on the endpoint.
     Re-minted in the last five minutes of its life so a conversation
     starting now does not expire mid-sentence. */
  var TOKEN_KEY = 'enl_agent_token';
  var REMINT_MARGIN_MS = 5 * 60 * 1000;

  function cachedToken() {
    try {
      var raw = sessionStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      if (!saved || !saved.token || !saved.expiresAt) return null;
      if (saved.expiresAt - Date.now() < REMINT_MARGIN_MS) return null;
      return saved;
    } catch (e) { return null; }   // private mode, quota, corrupt JSON
  }

  /* Resolves to the identity attributes, ALWAYS. Every failure path here
     resolves signed-out rather than rejecting, because nothing about this
     feature is worth costing the visitor their chat bubble. */
  function identity() {
    var out = { signed_in: 'false' };
    var sessionToken = '';
    try { sessionToken = localStorage.getItem('enl_token') || ''; } catch (e) {}
    if (!sessionToken || typeof fetch === 'undefined') return Promise.resolve(out);

    var saved = cachedToken();
    if (saved) {
      return Promise.resolve({
        signed_in: 'true',
        first_name: saved.firstName || '',
        account_token: saved.token
      });
    }

    var base = (typeof window.PEPTIDE_API_BASE === 'string') ? window.PEPTIDE_API_BASE : '';
    return fetch(base + '/api/agent/account-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sessionToken }
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.token) return out;
        try {
          sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
            token: data.token,
            firstName: data.firstName || '',
            expiresAt: Date.now() + (Number(data.ttl) || 1800) * 1000
          }));
        } catch (e) {}   // caching is an optimisation, not a requirement
        return {
          signed_in: 'true',
          first_name: data.firstName || '',
          account_token: data.token
        };
      })
      .catch(function () { return out; });
  }

  function mount() {
    if (loaded) return;
    loaded = true;

    identity().then(function (vars) {
      var el = document.createElement('elevenlabs-convai');
      el.setAttribute('agent-id', cfg.agentId);
      /* Read by the widget when the element connects, so it has to be set
         before the append — which is why the mint is awaited here rather
         than at the visitor's first question. */
      el.setAttribute('dynamic-variables', JSON.stringify(vars));
      document.body.appendChild(el);

      var s = document.createElement('script');
      s.src = WIDGET_SRC;
      s.async = true;
      s.type = 'text/javascript';
      s.onerror = function () {
        // The vendor is unreachable or blocked. Take both the element and
        // the failed script tag back out so there is no dead furniture left
        // in the page.
        if (el.parentNode) el.parentNode.removeChild(el);
        if (s.parentNode) s.parentNode.removeChild(s);
      };
      document.head.appendChild(s);
    });
  }
```

- [ ] **Step 2: Check the file parses**

```bash
node --check js/chat.js
```

Expected: no output (success). A syntax error here would silently kill the bubble on every page.

- [ ] **Step 3: Bump the cache-buster on every page**

Cloudflare caches JS for four hours, so the `?v=` is the only thing that makes a browser fetch the new file. From the repo root:

```bash
python -c "
import glob, io
for f in glob.glob('*.html'):
    s = io.open(f, encoding='utf-8', newline='').read()
    n = s.replace('chat.js?v=87', 'chat.js?v=93')
    if n != s:
        io.open(f, 'w', encoding='utf-8', newline='').write(n)
        print('bumped', f)
"
grep -l "chat.js?v=87" *.html || echo "no stragglers"
```

Expected: every page that loads `chat.js` reports bumped, then `no stragglers`.

- [ ] **Step 4: Verify in a browser, signed out**

Serve the site and open any page with the browser console open. Signed out:

- The chat bubble appears exactly as before.
- `document.querySelector('elevenlabs-convai').getAttribute('dynamic-variables')` is `{"signed_in":"false"}`.
- No request to `/api/agent/account-token` in the network tab.

- [ ] **Step 5: Verify in a browser, signed in**

Sign in, reload:

- One `POST /api/agent/account-token` returning 200.
- `document.querySelector('elevenlabs-convai').getAttribute('dynamic-variables')` contains `"signed_in":"true"`, the first name, and a JWT.
- Reload again: **no second mint** — the token comes from `sessionStorage`.
- `sessionStorage.removeItem('enl_agent_token')` then reload: one mint again.

- [ ] **Step 6: Verify the degradation path**

With the server stopped (or the API base pointed at a dead port), reload a page while signed in. The bubble must still mount, with `signed_in":"false"`. If it does not appear at all, stop and fix — this is the constraint that outranks the feature.

- [ ] **Step 7: Commit**

```bash
git add js/chat.js *.html
git commit -m "feat(chat): hand the agent a signed-in visitor's identity

Mints a scoped read-only token at mount and passes it to the widget as a
dynamic variable, cached in sessionStorage so a browsing session mints
once rather than once per page.

Every failure path resolves signed-out and mounts anyway. Nothing about
this is worth costing a visitor their chat bubble."
```

---

### Task 6: Teach the agent it can now look, and deploy

**Files:**
- Modify: `docs/AI-CHAT.md` — §3 the system prompt (parsed live by the setup script), §5 the tool definitions, §8 the go-live checklist
- Modify: `server/agent-knowledge.js:270-273` — the Delivery document's TRACKING AN ORDER section
- Modify: `tools/setup-elevenlabs-agent.js:131-200` — add the third tool config

**Interfaces:**
- Consumes: `POST /api/agent/account` from Tasks 3-4; the `dynamic-variables` from Task 5.
- Produces: nothing further depends on this.

The refusal in the screenshot lives in **two** places and both have to change, or the prompt and the retrieved knowledge document will contradict each other and the model will follow whichever it read last.

- [ ] **Step 1: Replace the ORDERS paragraph in the system prompt**

In `docs/AI-CHAT.md` §3, inside the fenced block, replace:

```
ORDERS
You cannot look up orders, accounts, or addresses. Someone asking about
an existing order should be pointed at the order-status page on the site,
where they enter their reference and email address. If they need more
than that, escalate.
```

with:

```
ORDERS AND ACCOUNTS
Whether you can look this up depends on {{signed_in}}.

If {{signed_in}} is "true", the person is signed in on the site and you
can read their account. Call get_my_account for anything about their
orders, delivery, points, auto-ship plans or cart. Never ask a signed-in
person for an order reference or their email address — you already have
their account. Greet them by {{first_name}} if it is not empty; if it is
empty, greet them without a name.

If {{signed_in}} is anything else, you cannot look up orders, accounts or
addresses. Point them at the order-status page on the site, where they
enter their reference and the email address they ordered with. If they
cannot find the reference, escalate.

If get_my_account says the session has expired, read that sentence back
to them and offer to escalate.

You can only READ. You cannot cancel an order, pause an auto-ship, spend
points, or change anything. When someone asks for a change, tell them
where on the site to do it, or escalate.

If an order is short-paid, get_my_account returns a payUrl. Give them
that link and no other. Never suggest paying again from scratch.
```

- [ ] **Step 2: Verify the prompt still parses**

The setup script reads §3 out of the doc and refuses a prompt under 500 characters. From the repo root:

```bash
node -e "
const fs=require('fs');
const md=fs.readFileSync('docs/AI-CHAT.md','utf8').replace(/\r\n/g,'\n');
const s=md.split(/^## 3\. /m)[1];
const m=/\`\`\`\n([\s\S]*?)\`\`\`/.exec(s);
if(!m) throw new Error('§3 fence not found');
const p=m[1].trim();
console.log('prompt lines:', p.split('\n').length, 'chars:', p.length);
if(!/get_my_account/.test(p)) throw new Error('the new tool is not in the prompt');
if(/You cannot look up orders, accounts, or addresses\./.test(p)) throw new Error('the old refusal is still there');
console.log('ok');
"
```

Expected: a line count, a character count well over 500, then `ok`.

- [ ] **Step 3: Update the knowledge document**

In `server/agent-knowledge.js`, replace lines 270-273:

```js
  out += 'You cannot look up orders. Send the customer to the order-status page on\n';
  out += 'the site, where they enter their order reference and the email address\n';
  out += 'they used. If they cannot find the reference, escalate to a person.\n';
```

with:

```js
  out += 'A signed-in customer\'s order can be read with the get_my_account tool —\n';
  out += 'use it rather than asking them for a reference they should not need.\n';
  out += 'Anyone not signed in goes to the order-status page on the site, where they\n';
  out += 'enter their order reference and the email address they used. If they cannot\n';
  out += 'find the reference, escalate to a person.\n';
```

- [ ] **Step 4: Add the tool definition**

In `tools/setup-elevenlabs-agent.js`, inside `toolConfigs()`, append a third entry to the returned array (after the `escalate` object, before the closing `]`):

```js
    {
      type: 'webhook',
      name: 'get_my_account',
      description:
        'Read the account of the person you are talking to: their recent orders and delivery status, ' +
        'their points balance, their auto-ship plans and their cart. Call this for ANY question about ' +
        'their own order, delivery, points, plans or cart — but only when {{signed_in}} is "true". ' +
        'Never ask a signed-in person for an order reference; this tool already knows who they are. ' +
        'It is read-only: it cannot cancel, pause, redeem or change anything.',
      response_timeout_secs: 10,
      api_schema: {
        url: `${API_BASE}/api/agent/account`,
        method: 'POST',
        /* Two headers, two questions. The shared secret says the call came
           from our agent; the account token says which visitor it is for.
           The token is templated in by ElevenLabs, so the model never sees
           it, cannot retype it wrongly, and cannot put it in the transcript.

           There are deliberately NO parameters for the model to fill in:
           nothing it can say points this tool at a different account. */
        request_headers: {
          ...headers,
          'x-account-token': '{{account_token}}'
        }
      }
    }
```

- [ ] **Step 5: Document the tool in §5**

In `docs/AI-CHAT.md` §5, after the `escalate` subsection, add:

````markdown
### `get_my_account`

Read-only. Returns the signed-in visitor's recent orders (status, items, totals,
balance outstanding, carrier, tracking, and a pay-the-balance link when one is
genuinely owed), their points balance, their auto-ship plans and their cart.

    POST {API_BASE}/api/agent/account
    x-agent-secret:  <ELEVENLABS_AGENT_SECRET>
    x-account-token: {{account_token}}

No request parameters. The account is chosen by the token and by nothing else,
which is what makes the tool impossible to point at somebody else's orders.

`{{account_token}}` is set by `js/chat.js` at widget mount, from
`POST /api/agent/account-token`, which a signed-in browser calls with its own
session token. The token is scoped `agent-read`, expires in 30 minutes, and is
refused by every `requireAuth` route on the server.

Addresses come back as city, state and country only. There is no street line in
this response, deliberately — see the design doc.
````

- [ ] **Step 6: Push the configuration with a dry run first**

```bash
node tools/setup-elevenlabs-agent.js --api-base https://evernova-api.onrender.com --dry-run
```

Expected: three tools listed, `get_my_account` among them, and the prompt line count from Step 2. Then run it for real without `--dry-run`.

- [ ] **Step 7: Verify end to end against the live agent**

Signed in on the site, open the chat and ask "where is my order". Expected: it answers from the account without asking for a reference. Then sign out, reload, ask the same thing: it points at the order-status page.

Check `server/data/agent-transcripts/` afterwards and confirm no street address and no JWT appears in the stored transcript.

- [ ] **Step 8: Note the deploy order in the go-live checklist**

Add to `docs/AI-CHAT.md` §8:

```markdown
- Deploy the server BEFORE uploading `js/chat.js`. The browser will call
  `/api/agent/account-token` as soon as the new file lands, and Cloudflare caches
  JS for four hours — uploading the asset before the API exists binds a
  4-hour-cached file to an endpoint that 404s.
- `ELEVENLABS_AGENT_SECRET` must be set on the server, or `requireAgent` fails
  closed and `get_my_account` returns 401 to every conversation.
```

- [ ] **Step 9: Run the whole suite and commit**

```bash
cd server && npm test && cd ..
git add docs/AI-CHAT.md server/agent-knowledge.js tools/setup-elevenlabs-agent.js
git commit -m "feat(agent): let the agent read a signed-in customer's account

The refusal lived in two places - the system prompt in docs/AI-CHAT.md §3
and the Delivery knowledge document - and both are replaced with a branch
on {{signed_in}}. The tool takes no model-supplied parameters at all, so
nothing the visitor says can point it at another account."
```

---

## Verification

After Task 6, the following must all hold:

- `cd server && npm test` passes, including every new test in `test/agent-token.test.js` and `test/authz.test.js`.
- Signed out, the chat behaves exactly as it did before this plan.
- Signed in, "where is my order" is answered without a reference being asked for.
- An agent token returns 401 from `/api/orders` and `/api/cart`.
- No street address and no JWT appears in a stored transcript.
