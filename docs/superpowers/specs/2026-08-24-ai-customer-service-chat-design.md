# AI customer-service chat, with escalation to a human

**Date:** 2026-08-24
**Status:** Approved design, not yet implemented
**Scope:** Text chat only. Voice is explicitly out of scope for this spec.

## The problem

The site has one real support channel and one dead one.

The real channel is disputes (`server/disputes.js`): a proper thread system with
attachments, an admin console, acknowledgement emails, and resolve/reopen. It is also
narrow by construction — `disputes.create()` requires a `userId` and an `orderId`, and
every route sits behind `auth.requireAuth`. You must have an account and an order to
use it.

The dead channel is the contact form (`contact.html`), which composes a `mailto:` and
opens the visitor's email client. Nothing reaches the server. Nothing is recorded.
Whether the message was ever sent is unknowable.

That leaves the largest group of visitors — logged-out shoppers with a pre-sale
question about a peptide, a COA, or shipping — with no supported way to ask one. They
either guess, email into a black box, or leave.

## What we are building

An always-available text chat that answers pre-sale product and policy questions from
our own published copy, and hands off to a human when it cannot. The handoff lands in
a real server-side inbox with an admin console tab, not in an email client.

Non-goals for this version:

- Voice. The same agent configuration extends to voice later; nothing here blocks it.
- Order lookup by the agent. See "Guardrails".
- Replacing disputes. A logged-in customer asking about their own order still goes
  through the dispute flow, unchanged.

## Vendor

ElevenLabs Agents, in Chat Mode (text-only, no microphone). The account is on a paid
plan, so the widget can be left on for anonymous traffic without a metering gate.

Three ElevenLabs features carry the design:

- **Knowledge base with RAG** — grounds answers in documents we upload.
- **Webhook tools** — the agent calls our endpoints mid-conversation. There is no
  built-in "escalate to human"; we define one.
- **Post-call webhook** — ElevenLabs POSTs the finished transcript to us.

## Architecture

```
visitor -> <elevenlabs-convai> widget (ElevenLabs CDN)
             |
             |-- RAG knowledge base ......... static policy copy
             |                                (shipping, returns, terms,
             |                                 quality/COA, FAQ, about)
             |
             |-- webhook tool: lookup_product -> GET  /api/agent/product
             |-- webhook tool: escalate ....... POST /api/agent/escalate
             |-- post-call webhook ............ POST /api/agent/transcript
```

### Why products are a live tool, not a knowledge-base document

Products are admin-managed at runtime (`server/products.js`); prices, stock counts and
descriptions change from the admin console. A knowledge-base document is a snapshot,
and a snapshot goes stale silently — the failure mode is the agent confidently quoting
a price we no longer charge, or offering a retired SKU.

Policy copy does not move that way. Shipping terms, returns, the COA library
description and the research-use framing are edited rarely and deliberately. Those are
uploaded to the knowledge base and re-uploaded when edited.

So: **a live tool for anything with a number attached, RAG for prose.**

### Front-end wiring

The widget is configured through a single global in `js/config.js`, following the
existing `ENL_ANALYTICS` pattern — absent or empty means the feature does not load at
all and the site behaves exactly as it does today:

```js
window.ENL_CHAT = { agentId: '' };   // empty = chat off, nothing loads
```

A new `js/chat.js` reads that global, and only then injects the ElevenLabs script tag
and the `<elevenlabs-convai>` element. It must not render before `js/age-gate.js` has
cleared — an un-age-gated visitor should not be talking to the store.

Widget colours are set through the ElevenLabs widget customization options so the
bubble sits inside the site palette (black `#07040f`, gold `#d4af37`, violet
`#7c3aed`) rather than shipping the vendor default blue.

## Guardrails

This is the highest-risk part of the feature. The store sells research peptides under
a no-health-claims policy (see the 2026-08 compliance review). A generative agent that
free-associates about dosing on a live chat is a regulatory problem, not a bug.

1. **Refusal list in the system prompt.** Dosing, administration, route, human or
   animal use, "is it safe", "what does it do for me", diagnosis, treatment,
   comparison to a drug — all refused in one line, followed by an offer to escalate.
2. **Grounded answers only.** The agent answers from RAG documents and tool output. It
   does not answer general questions about peptides from model knowledge. Our
   published copy has already been compliance-reviewed; model knowledge has not.
3. **Transcripts stored on our side.** The post-call webhook writes every conversation
   to our own storage. Audit evidence must not live only in a vendor dashboard we
   could lose access to.
4. **No order-record tool.** Giving an LLM a lookup keyed on customer records is the
   shortest path to disclosing a name, address, or order history to whoever guessed an
   order number. Order questions are pointed at `order-status.html` — which already
   enforces the reference-plus-email pair and is rate-limited — or escalated to a
   human.
5. **Rate limiting.** Per-IP and per-day caps via the existing `server/ratelimit.js`,
   so anonymous traffic cannot run up the bill or grind the agent.

## Escalation

### Routing

- Logged in, asking about their own order: existing dispute flow. Unchanged.
- Everyone else: a new inbox thread.

### server/inbox.js

A new module following the same shape as `disputes.js`: a JSON map behind
`load()`/`save()` helpers, atomic writes, no new dependency, `DATA_DIR/inbox.json`.
The comment at the top of `disputes.js` explains why that shape was chosen, and the
same reasoning applies here.

Thread record:

| Field | Meaning |
|---|---|
| `id` | thread id, generated the way `newDisputeId()` does |
| `createdAt` / `updatedAt` | ISO timestamps |
| `email` | the visitor address, captured by the agent before escalating |
| `name` | optional |
| `subject` | short summary the agent supplies |
| `transcript` | the chat that led to the escalation |
| `messages[]` | each one is `id`, `from` (customer or store), `body`, `at` |
| `status` | `awaiting_us`, `awaiting_them`, or `closed` |
| `unread` | per-side, mirroring `disputes.unreadFor()` |

Reused directly from disputes rather than reinvented: the message length cap, the
open-thread cap per email address, `deriveStatus()`, `markRead()`, `summarize()`.

### Endpoints

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/agent/product` | agent shared secret |
| `POST` | `/api/agent/escalate` | agent shared secret |
| `POST` | `/api/agent/transcript` | HMAC signature from ElevenLabs |
| `GET` | `/api/inbox/:id` | `?t=` guest token |
| `POST` | `/api/inbox/:id/messages` | `?t=` guest token |
| `GET` | `/api/admin/inbox` | `requireAdmin` |
| `POST` | `/api/admin/inbox/:id/messages` | `requireAdmin` |
| `POST` | `/api/admin/inbox/:id/close` | `requireAdmin` |

### Guest access without an account

The guest reply page reuses the mechanism already proven by the pay-the-balance link:
`auth.refToken(scope, value)` and `auth.verifyRefToken()` in `server/auth.js` — a
truncated HMAC over `scope:value`, compared with `timingSafeEqual`.

A new page `inbox.html?id=<threadId>&t=<token>` lets a guest read the reply and write
back, with no account. The comment above `orderFromPayToken()` in `server.js` states
the security property this inherits: the token unlocks exactly one thread, and can
neither move money nor reveal an account.

The link is delivered by the acknowledgement email, reusing `server/email.js` and the
dispute-email templates as the model.

### Admin console

One new entry in the `NAV` array in `js/admin-core.js`:

```js
{ key: 'inbox', href: 'admin.html#inbox', label: 'Inbox', icon: 'chat', tally: 'navInbox' },
```

The console is hash-routed and re-renders views wholesale through one delegated click
listener in `js/admin-console.js`, so the inbox view is a render function plus
`act-inbox-*` cases in the existing switch. The `navInbox` tally follows `navDisputes`,
and the dashboard summary gains an inbox count next to `waitingThreads`.

Reply notifications reuse the existing `admin-alert.js` watcher, which already polls
for incoming dispute replies.

## Data flow, end to end

1. A visitor opens a product page, clicks the chat bubble, and asks whether a peptide
   ships to their state.
2. The agent answers from the shipping document in RAG.
3. The visitor asks the current price and whether it is in stock.
4. The agent calls `lookup_product`, gets the live price and `stockQty`, and answers.
5. The visitor asks a dosing question.
6. The agent refuses in one line and offers to put them in touch with a person.
7. The visitor accepts and gives an email address.
8. The agent calls `escalate`. A thread is created with the transcript attached, status
   `awaiting_us`. An acknowledgement email goes out carrying the tokenized link.
9. The admin console tally increments and `admin-alert.js` raises a toast.
10. The owner replies from `admin.html#inbox`. The guest gets an email and can answer
    at `inbox.html?id=...&t=...`.
11. When the conversation ends, ElevenLabs POSTs the full transcript to
    `/api/agent/transcript`, it is HMAC-verified, and it is stored.

## Error handling

- **ElevenLabs unreachable, or the script blocked.** The widget never appears. No
  layout shift, no error surfaced to the visitor, and `contact.html` remains reachable.
- **The escalation endpoint fails mid-conversation.** The agent apologises and gives
  the support email address in text — hard-coded in the prompt, so it survives our
  server being down.
- **Bad or expired guest token.** The same response as a bad pay token: a plain "that
  link is not valid", with no distinction between a wrong token and a missing thread.
- **Transcript webhook signature mismatch.** Rejected with 401 and logged. Never
  stored.
- **Rate limit hit.** The tool returns a refusal the agent can read out, rather than an
  HTTP error the model has to interpret.

## Testing

The existing suite is `node:test` under `server/test/`, run with `npm test` in
`server/`, and `server.js` exports the app so routes are testable without listening.

- `server/test/inbox.test.js` — create, append, status derivation, caps, guest token
  accept and reject, and admin-only routes rejecting a non-admin.
- Agent endpoints tested with a stubbed shared secret; the transcript webhook tested
  with both a correct and a tampered HMAC.
- The server-side work — steps 1 and 4 of the build order — is fully testable with no
  ElevenLabs account and no network. Steps 2, 3 and 5 are front-end and get the
  mechanical check-script treatment the earlier support features used.

## Build order

1. `server/inbox.js` plus routes and tests. Stands alone and closes the mailto gap
   even if the AI is never switched on.
2. Admin `#inbox` tab, tally, and dashboard count.
3. `inbox.html` guest page and acknowledgement email.
4. `/api/agent/*` endpoints — product lookup, escalate, HMAC transcript.
5. `js/chat.js`, the `ENL_CHAT` config switch, and the widget embed; cache-buster
   `?v=86` becomes `?v=87`.
6. ElevenLabs dashboard configuration: system prompt, knowledge-base upload, tool
   wiring, widget colours. Needs the account login and an API key in `server/.env`.

## Configuration added

`server/.env`:

- `ELEVENLABS_API_KEY` — server-side only, never sent to the browser.
- `ELEVENLABS_AGENT_SECRET` — shared secret the agent presents on tool calls.
- `ELEVENLABS_WEBHOOK_SECRET` — HMAC key for the transcript webhook.

`js/config.js`:

- `window.ENL_CHAT = { agentId: '' }` — the public agent id. Empty means off.

## Open questions for implementation

None blocking. The exact request and response shape of the ElevenLabs webhook-tool
contract, and the post-call webhook signature scheme, should be read from the vendor
documentation at implementation time rather than assumed from this document.
