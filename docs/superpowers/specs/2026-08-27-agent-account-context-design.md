# Agent account context for signed-in customers

**Date:** 2026-08-27
**Status:** Approved design, not yet implemented
**Scope:** Signed-in customers only, read-only. Guest order lookup is explicitly out of
scope for this spec.

## The problem

Asked "my package never got delivered", the agent answers that it cannot look up orders
and sends the customer to the order-status page to type in a reference they may not
have. That is not a limitation of the model or of the vendor. It is a sentence we wrote,
in `server/agent-knowledge.js`:

    out += 'You cannot look up orders. Send the customer to the order-status page on\n';

It was the right sentence when it was written. The agent had no way to tell one visitor
from another, so it had no safe way to answer a question about *this* person's order.
The shared secret on `/api/agent/product` and `/api/agent/escalate` proves a request came
from our agent; it says nothing about who the agent is talking to. Without per-visitor
identity, an order-lookup tool behind that secret would be an order-enumeration API
attached to a public chat bubble.

So the missing piece is not a tool. It is identity.

## What we are building

A signed-in customer gets a chat and voice agent that already knows who they are. They
ask "where is my order" and get the answer, with no reference number, no email
confirmation, no second tab.

The agent can read the account and nothing else:

- Orders — status, items, totals, balance outstanding, carrier, tracking, pay link
- Loyalty — points balance and what it is worth
- Auto-ship — active plans and when each next bills
- Cart — what is in it right now

Every state change still belongs to the customer's own hands. The agent hands over a
link; the customer clicks it. Nothing the agent can say cancels an order, spends points,
alters a plan, or charges anything. A hallucinated tool call costs us a wrong sentence,
never a wrong transaction.

Signed-out visitors keep today's behaviour exactly: the agent points them at the
order-status page.

## Why not the two simpler designs

**Pass the session JWT as the dynamic variable.** This is the least code by a wide
margin, and it is the wrong trade. That token *is* the account — it authorizes checkout,
password change, and every other `requireAuth` route. Handing it to ElevenLabs puts a
full-power credential in a vendor's conversation record and, plausibly, in a transcript
on our own disk. One leaked transcript would become account takeover. A credential given
to a third party must be able to do less than the account can.

**Preload the account into the conversation.** ElevenLabs accepts conversation
initiation data, so our server could inject the whole account snapshot up front and skip
the tool call entirely. Simpler at runtime, worse everywhere else: it puts every order
and address into the prompt of *every* conversation — including the great majority that
turn out to be "do you ship to Texas" — so it maximises exposure in exchange for the
convenience of not writing an endpoint. It also freezes the data at connect time, so an
order that flips to shipped mid-conversation is reported wrong.

The chosen design pays one extra endpoint to avoid both.

## Architecture

```
signed-in browser
  |
  |  1. POST /api/agent/account-token      (Authorization: Bearer <session JWT>)
  |     <- { token, ttl }                   scope 'agent-read', 30 min
  |
  |  2. mounts <elevenlabs-convai
  |       dynamic-variables='{"signed_in":"true","first_name":"...","account_token":"..."}'>
  v
ElevenLabs agent
  |
  |  3. webhook tool get_my_account
  |       header x-agent-secret:  <shared secret>     "this is our agent"
  |       header x-account-token: {{account_token}}   "and this is who it is talking to"
  v
POST /api/agent/account  ->  account snapshot
```

The two headers answer two different questions, and both must pass. The shared secret
alone cannot read an account; the account token alone cannot reach the endpoint.

The token travels as a header template, so it is filled in by ElevenLabs' tool layer.
The model never receives it, never has to repeat it, and cannot mangle it — which keeps
it out of the model's own context. It does NOT keep it out of ElevenLabs' post-call
webhook payload: that payload echoes back `conversation_initiation_client_data.
dynamic_variables`, which is where the header was templated from, so the live token
still reaches `POST /api/agent/transcript`. That route redacts `account_token` out of
`conversation_initiation_client_data.dynamic_variables` before writing the transcript
to disk — the raw body is still what the HMAC signature is checked against, only the
stored copy is touched — so the credential does not end up sitting in
`server/data/agent-transcripts/*.json` after the conversation ends.

## The token

Two functions in `server/auth.js`, next to the existing `refToken` helpers:

- `mintAgentToken(user)` — `jwt.sign({ sub: user.id, scope: 'agent-read' }, SECRET, { expiresIn: '30m' })`
- `verifyAgentToken(token)` — verifies, then **requires `scope === 'agent-read'`**, and
  returns the payload or null

The scope check is the point, and it has to run in **both** directions. Session tokens
carry no `scope`, so `verifyAgentToken` rejects one on sight. The reverse is not free:
an account token is a valid JWT signed with the same secret and carrying a `sub`, so
today's `verifyToken` would happily accept it and `requireAuth` would let it through
every account route on the server — which would make the credential we hand to a vendor
strictly more powerful than the one it replaced.

So `verifyToken` gains one line: a payload carrying any `scope` is not a session token,
and is refused. Both directions are then closed, and any future scoped token gets the
same protection without anyone having to remember it.

It reuses the existing JWT secret rather than introducing another one. A second secret
would be a second thing to configure, a second thing to rotate, and a second thing to
get wrong on a fresh deploy, in exchange for no additional isolation that the scope
claim does not already provide.

**Accepted limitation:** JWTs are not revocable without a server-side token store, which
`auth.js` does not have. A customer who signs out mid-conversation leaves a token that
stays valid until it expires. The 30-minute TTL is the bound on that. This is acceptable
because the exposure is strictly smaller than the exposure that already exists: the same
browser, still signed in, can read all of the same data from the account page with one
click. The agent does not widen the blast radius of a shared or unattended computer.

## Endpoints

### `POST /api/agent/account-token`

Behind `auth.requireAuth`, plus its own rate-limit bucket. Signed-in browsers only; the
agent never calls this.

    -> (no body)
    <- 200 { "success": true, "token": "<jwt>", "ttl": 1800, "firstName": "Sam" }
    <- 401 if not signed in

### `POST /api/agent/account`

Behind `requireAgent` and `agentLimiter` — the existing middleware pair, unchanged —
then the account token from the `x-account-token` header.

    <- 401 { "error": "Not authorised." }        bad or missing shared secret
    <- 401 { "error": "That session has expired. Ask them to sign in again." }
                                                  bad, expired, or wrong-scope token

The expiry message is written to be read aloud, in the style of the `escalate` route's
messages, because the agent will speak it verbatim.

The response:

    {
      "success": true,
      "customer": { "firstName": "Sam" },
      "orders": [
        {
          "orderId": "ENL-XXXXXXXX",
          "createdAt": "2026-08-20T...",
          "status": "shipped",
          "method": "crypto",
          "items": [{ "name": "...", "quantity": 2 }],
          "total": 96.39,
          "paid": 96.39,
          "due": 0,
          "shippingLabel": "Priority",
          "carrier": "USPS",
          "tracking": "...",
          "shippedAt": "2026-08-21T...",
          "city": "Austin", "state": "TX", "country": "US",
          "payUrl": ""
        }
      ],
      "loyalty": { "points": 420, "worth": 4.20 },
      "subscriptions": [ "...subscriptions.publicSubscription()" ],
      "cart": { "items": [{ "name": "...", "quantity": 1, "unitPrice": 48.00 }], "subtotal": 48.00 }
    }

Details that matter:

- **Orders are capped at the 10 most recent.** Everything returned here is liable to end
  up in a transcript, and an unbounded order history is both a large prompt and a large
  thing to leak. Ten covers every real support question; the account page covers the
  rest.
- **`due`, `paid`, and `payUrl` reuse `amountDue()`, `paidSoFar()`, and `canPayBalance()`
  verbatim** — the same functions `/api/orders/lookup` uses. A `payUrl` appears only when
  a fresh invoice for the shortfall is genuinely the right answer. This matters more than
  it looks: the short-paid-order problem is the single most common real support case this
  shop has had, and the agent must offer the same link the balance email offers, never a
  second one it invented.
- **The cart is priced by the same pricing module checkout uses**, so the agent cannot
  quote a total that checkout will then disagree with.
- **Subscriptions go through `subscriptions.publicSubscription()` and are then
  redacted.** That serializer is the right starting point — it already exists for exactly
  this purpose, and a second hand-written view would drift from it — but it returns
  `shippingAddress` and `email` in full, which the address rule below forbids. Both are
  stripped and the address is reduced to city, state, and country, the same reduction the
  orders list gets. The redaction picks the wanted keys rather than deleting the unwanted
  ones: a field added to `publicSubscription` later must then be added here deliberately,
  instead of appearing in a vendor transcript because nobody remembered this file.

## What is deliberately not returned

- **The street address.** City, state, and country only. "Where is my package" is fully
  answerable from the carrier, the tracking number, and the destination city; the street
  line adds nothing to the answer while being the single highest-harm field to leave
  sitting in a vendor's conversation log. This is a deliberate reduction against a
  request for the whole account, and it is the only one.
- **`webAuthorization` and `declarations`.** Audit evidence for the payment processor.
  Not conversational, and not the agent's business.
- **Payment detail.** None exists to return — the shop is crypto and Zelle only, so there
  is no card on file anywhere in the system. Worth stating plainly so nobody adds one to
  this response later by reflex.
- **Anything belonging to anyone else, and any admin flag.** The snapshot is built from
  `payload.sub` and nothing else. No user id, email, or order reference is ever read from
  the request body.

## The widget

`js/chat.js` currently mounts the element with only `agent-id`. It gains one step before
mounting: if `localStorage.enl_token` is present, call the mint endpoint, then set

    dynamic-variables='{"signed_in":"true","first_name":"Sam","account_token":"<jwt>"}'

and if it is absent, set `{"signed_in":"false"}` and mount precisely as today.

`first_name` is returned by the mint endpoint alongside the token, rather than read from
the `enl_user` object cached in the browser. The request is already being made, the
server already has the user record in hand, and taking it from the response keeps the
greeting from disagreeing with a stale cache. The prompt must treat an empty
`first_name` as "greet without a name" rather than saying the word "undefined" out loud.

The minted token is cached in `sessionStorage` and reused while it has more than five
minutes left. Without this, every page load in a browsing session mints a new token —
which is wasteful, needlessly widens the number of live credentials, and would make a
sanely-sized rate limit on the mint endpoint fire during ordinary shopping.

The mint call must never be able to cost us the chat bubble. A failure, a timeout, a
401 from an expired session — every one of them falls through to the signed-out
attributes and mounts anyway. The existing age-gate wait and the existing vendor-script
`onerror` teardown are untouched.

The token is minted at mount, not at first question, because the widget's attributes are
read when the element connects.

## The agent configuration

`tools/setup-elevenlabs-agent.js` defines the webhook tools in code and pushes them
through the API. A third joins `lookup_product` and `escalate`:

- **`get_my_account`** — `POST {API_BASE}/api/agent/account`, headers `x-agent-secret`
  (as a stored secret) and `x-account-token: {{account_token}}`. No LLM-supplied
  parameters at all: there is nothing for the model to fill in, which is what makes the
  tool impossible to point at another account.

The refusal lives in two places, and both have to change or the agent will contradict
itself:

- **`docs/AI-CHAT.md` §3** holds the system prompt itself. `setup-elevenlabs-agent.js`
  parses it out of the fenced block in that section — the doc is the source of truth, not
  a description of it. Its ORDERS paragraph ("You cannot look up orders, accounts, or
  addresses") is what actually produced the refusal in the screenshot.
- **`server/agent-knowledge.js`** builds the *Delivery and shipping* knowledge document,
  whose TRACKING AN ORDER section repeats the same instruction to the retrieval layer.

Both lose the refusal and gain a branch on `{{signed_in}}`:

- signed in — call `get_my_account` for any question about their orders, points,
  auto-ship, or cart; greet by `{{first_name}}`; never ask for an order reference from
  someone who is signed in
- signed out — today's behaviour, unchanged: the order-status page, reference plus email
- expired token — the endpoint's 401 message, then offer `escalate`

## Failure modes

| What happens | What the customer gets |
|---|---|
| Not signed in | Today's answer: the order-status page |
| Mint endpoint fails or times out | Chat mounts signed-out; no error surfaced |
| Token expires mid-conversation | "That session has expired. Ask them to sign in again," then escalation is offered |
| Shared secret missing on the server | `requireAgent` fails closed; agent falls back to escalation |
| Customer has no orders | The agent says so and offers the catalogue |
| Vendor script blocked | No bubble at all, exactly as today |

## Abuse and rate limits

The mint endpoint gets its own bucket. It sits behind `requireAuth`, so it is not
anonymously reachable, but a compromised session should not be able to mint tokens
without limit.

`/api/agent/account` uses the existing `agentLimiter`, which is one shared unkeyed budget
for all agent traffic. That is the established pattern for these routes and the reason
`agentAuthFailLimiter` exists separately — failed shared-secret probes are counted
against their own budget so a stranger cannot starve live conversations. Account-token
failures are counted the same way, for the same reason.

## Testing

Added to `server/test/authz.test.js`:

1. A valid session token is rejected as an account token
2. An account token is rejected by a `requireAuth` route
3. An expired account token returns 401
4. A correct account token with a missing or wrong shared secret returns 401
5. Customer A's token returns only customer A's orders
6. A body carrying `userId` or `orderId` cannot influence the response
7. The orders array is capped at 10
8. No street address appears anywhere in the response

Test 8 is a whole-response scan rather than a field check, so that a later change that
starts returning the full address somewhere new fails the test rather than passing it.

## Files touched

- `server/auth.js` — `mintAgentToken` and `verifyAgentToken`, both exported, plus the
  one-line hardening of `verifyToken` that refuses any scoped token
- `server/server.js` — the two endpoints, alongside the existing agent routes
- `server/agent-knowledge.js` — the Delivery document's TRACKING AN ORDER section
- `docs/AI-CHAT.md` — §3 the system prompt (the live source the setup script parses),
  and §5 the tool definitions
- `tools/setup-elevenlabs-agent.js` — the `get_my_account` tool definition
- `js/chat.js` — mint on mount, set `dynamic-variables`
- every HTML page — cache-buster bump for `chat.js`, currently `?v=87`
- `server/test/authz.test.js` — the cases above

## Out of scope

- **Guest order lookup.** The agent asking for reference plus email and reading back one
  order. Deliberately deferred: it is a second endpoint with a second abuse surface and
  prompt logic to choose between two paths, and it is worth building only once the
  signed-in case proves people actually ask.
- **Any write action.** Cancelling, pausing, redeeming, adding to cart.
- **Token revocation on sign-out.** Bounded by the 30-minute TTL, as argued above.
