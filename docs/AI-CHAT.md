# The chat agent — setup guide

This is the document the owner follows to stand the chat agent up in the
ElevenLabs dashboard, and the exact text it runs on. It is not code, and none
of it is exercised by `npm test` — that is exactly why it is written down
here rather than typed into the dashboard from memory once and forgotten.

## 1. What this is

The bubble in the corner of the site is a text-only ElevenLabs agent. It
answers questions from our own published pages and from a live catalog
lookup, and when it cannot help — or is asked something it must refuse — it
hands the conversation to a person. That handoff opens a thread in
`admin.html#inbox`. Nothing about the agent's design lets it look up an
order, an account, or anyone's address; it only ever sees the catalog and the
words the visitor types to it.

**Who feeds that inbox, today.** Chat escalations, and nothing else.
`contact.html` is still a plain `mailto:` form — it has never been wired to
`/api/inbox`, and writing it that it "reaches the same queue" would be
untrue. It also means that until `agentId` is set (§2, and it ships empty)
the inbox has no producers at all and the tab stays empty. Pointing the
contact form at the same threads is a sensible follow-on, and deliberately
not done here: it is the owner's call, not a side effect of shipping chat.

## 2. The secrets, and where each goes

**Read this before the table.** "Where" means two different places depending
on which server you mean, and getting it wrong is the most likely way to
lose an afternoon here.

- **Locally**, the server reads `server/.env` through `dotenv`.
- **In production, there is no `.env` file at all.** `server/.env` is
  git-ignored (`server/.gitignore`), so it is never deployed. The live API
  runs on Render, and Render supplies environment variables from its own
  dashboard — **Environment → Add Environment Variable**, the same place
  `BTCPAY_WEBHOOK_SECRET` and the SMTP settings already live. See
  `DEPLOY-RENDER.md`. Render injects them straight into `process.env`, and
  `dotenv` simply finds no file and does nothing, which is fine.

So every row below means: **`server/.env` for local development, and the
Render dashboard for the live site.** Set both — they are separate stores
and neither copies from the other. Changing a value on Render restarts the
service; the agent will 401 until that restart finishes.

If the agent is refused in production with a correct-looking secret, this
is almost always the cause: the value is in `server/.env` on your machine
and was never added on Render.

| Variable | Where | What it is |
|---|---|---|
| `ELEVENLABS_API_KEY` | `server/.env` locally; **Render dashboard** for production — though see the note, this one is optional in production | Your ElevenLabs account key. This server's code does not read it — nothing in `server/*.js` references it. Keep it in `server/.env` anyway so it lives with the other secrets rather than in a note somewhere, and use it yourself when uploading or updating the knowledge base via ElevenLabs' own API or CLI. Because the running server never reads it, you do not strictly need it on Render at all. |
| `ELEVENLABS_AGENT_SECRET` | `server/.env` locally, **Render dashboard** for production, **and** each webhook tool's header configuration in the ElevenLabs dashboard | The shared secret the agent presents on every tool call, as the `x-agent-secret` header. The server checks this on both `/api/agent/product` and `/api/agent/escalate` and refuses the request outright if it is missing, wrong, or not yet configured — there is no "open while testing" mode. All three places must hold the same value. |
| `ELEVENLABS_WEBHOOK_SECRET` | `server/.env` locally, **Render dashboard** for production, **and** the post-call webhook configuration in the ElevenLabs dashboard | The HMAC key ElevenLabs signs the finished-conversation webhook with. The server verifies this signature before writing anything to disk. All three places must hold the same value. |
| `agentId` (`window.ENL_CHAT.agentId`) | `js/config.js` | The agent's id. This one is meant to be public — it ends up in the page source of every page that loads the bubble, by design. Leave it empty and the whole feature is inert: no script tag is added, no element is mounted, no request is made. See §7 for the companion `version` value. |

**On the agent being public.** ElevenLabs' embeddable chat widget only works
against an agent that has authentication disabled — that is not a shortcut
taken here, it is a requirement of the widget itself. This is fine by
design: the agent id being visible in page source grants no access to
anything sensitive. The two secrets that actually matter —
`ELEVENLABS_AGENT_SECRET` and `ELEVENLABS_WEBHOOK_SECRET` — never appear in
the browser. They live in the agent's server-side tool configuration inside
the ElevenLabs dashboard, in `server/.env` locally, and in Render's
environment for the live site. Do not "fix" this later by flipping the
agent to private; that will simply break the widget.

## 3. The system prompt

Paste this into the agent's system prompt field exactly as written. Nothing
in it should be softened, shortened, or made to sound friendlier — this text
is the only thing standing between a generative model and a health claim on
a live customer conversation.

```
You are the assistant for Ever Nova Life, a supplier of peptides for
in-vitro laboratory research. You answer questions about the catalogue,
prices, stock, shipping, returns, documentation and lot certificates.

WHAT YOU ANSWER FROM
Answer only from the documents in your knowledge base and from the
lookup_product tool. If the answer is not in either, say you don't have
it and offer to put the person in touch with someone who does. Never
answer from general knowledge about peptides.

WHAT YOU NEVER DISCUSS
Every product here is for laboratory research use only. You must refuse,
in one short sentence, any question about:
  - dosing, quantities to take, schedules, or cycles
  - how to administer anything, by any route
  - use in or on humans or animals
  - whether something is safe, effective, or beneficial
  - treating, preventing, curing, or diagnosing any condition
  - comparisons to medicines or supplements
  - personal results, before-and-afters, or what to expect

Refuse like this: "That's outside what I can help with — these materials
are supplied for laboratory research only. I can put you in touch with a
person if you have a question about an order or our documentation."

Do not soften it, do not add a caveat and then answer anyway, and do not
speculate about what a researcher "might" do. If someone rephrases the
question, refuse again.

ORDERS
You cannot look up orders, accounts, or addresses. Someone asking about
an existing order should be pointed at the order-status page on the site,
where they enter their reference and email address. If they need more
than that, escalate.

PRICES AND STOCK
Always call lookup_product. Never state a price or stock level from
memory or from the knowledge base.

HANDING OFF TO A PERSON
Escalate when: you refused something and they still need help; the
knowledge base does not cover it; they ask for a human; or they sound
frustrated. Ask for their email address first, then call escalate with a
short subject line and a plain summary of what they need. Read the
reference number back to them.

If the escalate tool fails, tell them to email support@evernovalife.com
directly, and give them that address.

TONE
Brief and plain. No exclamation marks, no emoji, no sales language. If
you don't know, say so in one sentence.
```

## 4. Knowledge-base contents

Upload these pages to the agent's knowledge base:

- `shipping.html`
- `returns.html`
- `terms.html`
- `privacy.html`
- `quality.html`
- `faq.html`
- `about.html`
- `research-accounts.html`

Re-upload a page any time its content changes — the agent only knows what
was in the knowledge base at upload time; it does not fetch these pages
live.

**`products.html` is deliberately not on this list.** Prices and stock
change, sometimes several times a day, and the agent is required to call
`lookup_product` for both rather than answer from anything it read — so a
catalog page in the knowledge base could only ever go stale and contradict
what `lookup_product` returns. Keep pricing and availability out of the
knowledge base entirely and let the tool be the only source for it.

**Never upload `inbox.html` or any admin page** (`admin.html`,
`admin-products.html`, and the rest). `inbox.html` is a private, per-thread
guest page — it only means anything with the signed link and thread id
appended to its URL, and putting it in the knowledge base would hand the
model a template for other people's private conversations. The admin pages
are the shop's own console and have no place in anything a visitor-facing
agent can read from.

## 5. Tool definitions

Two tools, both webhook-type tools in the ElevenLabs dashboard, both send
`x-agent-secret: <ELEVENLABS_AGENT_SECRET>` as a header.

### `lookup_product`

- **Method / URL:** `GET https://<api-host>/api/agent/product?q={query}`
- **Header:** `x-agent-secret: <ELEVENLABS_AGENT_SECRET>`
- **Parameters:**

  | Name | Type | Required | Description for the agent |
  |---|---|---|---|
  | `query` | string | yes | The product name or part of it, as the visitor said it |

- **Response:** `{ success: true, products: [ { id, name, price, currency,
  inStock, url } ] }`, at most 5 rows. `inStock` reflects the store's real
  availability — the admin's in-stock switch and the stock count both have
  to say yes, not just one of them. Unpublished, draft, and retired products
  never appear here; the agent sees exactly what an anonymous storefront
  visitor would see. **There is no `sku` field on this response** — a
  product record on this store does not carry one, so do not configure the
  tool to expect it.
- **Errors:** a 401 with `{ error: "Not authorised." }` if the header is
  missing or wrong.

### `escalate`

- **Method / URL:** `POST https://<api-host>/api/agent/escalate`
- **Header:** `x-agent-secret: <ELEVENLABS_AGENT_SECRET>`
- **Body parameters:**

  | Name | Type | Required | Description for the agent |
  |---|---|---|---|
  | `email` | string | yes | The visitor's email address, which you must ask for before calling this |
  | `name` | string | no | The visitor's name |
  | `subject` | string | yes | A short line describing what they need |
  | `body` | string | yes | A plain summary of the question in your own words |
  | `transcript` | array of `{role, text, at}` | no | The conversation so far |

- **Response on success:** `{ success: true, reference: "MSG-...",
  message: "<a sentence>" }`. The `message` field is written to be read
  aloud — have the agent say that sentence back to the visitor rather than
  composing its own, and read the reference number out of `reference` (or
  straight from the sentence — they're the same value).

  **The sentence has two forms, and which one you get depends on your own
  SMTP settings.** The acknowledgement email is the ONLY delivery of the
  link to the thread, so the server refuses to promise one it cannot send:

  | SMTP configured (`SMTP_USER` + `SMTP_PASS` set) | `message` |
  |---|---|
  | yes | `A person has it. The reference is MSG-..., and a confirmation is on its way to <email>.` |
  | no | `A person has it — quote the reference MSG-... if you get in touch again.` |

  This is exactly why the agent must read `message` rather than compose its
  own line. With no mailer configured, nothing will arrive in the visitor's
  inbox and the reference they were told to keep is the only way back to the
  conversation — an agent that invents "check your email" there has stranded
  them. Configure SMTP before going live (see `server/README.md`); the
  no-mailer sentence is a safety net, not the intended experience.
- **Response on failure:** a 4xx with `{ error: "<a sentence>" }` — for
  example, an invalid email, an empty message, or too many open threads
  already on that address. The agent should read that sentence to the
  visitor, not invent its own wording. If the call fails outright (network
  error, no response at all), fall back to the system prompt's instruction:
  tell them to email support@evernovalife.com directly.

## 6. Post-call webhook

- **Method / URL:** `POST https://<api-host>/api/agent/transcript`
- **Signing secret:** `ELEVENLABS_WEBHOOK_SECRET`

The server expects the signature in an `elevenlabs-signature` header shaped
like `t=<unix-seconds>,v0=<hex>`, computed as HMAC-SHA256 over
`` `${t}.${raw request body}` `` keyed with `ELEVENLABS_WEBHOOK_SECRET`, and
it rejects anything where `t` is more than 30 minutes away from the
server's clock in either direction (a captured signature cannot be replayed
later, and a slow or fast clock on either side is the failure mode to watch
for if this starts rejecting good calls). This is what this server checks
today — ElevenLabs' signature scheme is theirs to change, so when wiring
this up, confirm the current format against ElevenLabs' own webhook
documentation before assuming the above still matches.

On a verified call, the raw payload is written to
`server/data/agent-transcripts/` as one JSON file per conversation, timestamp
and conversation id in the filename. This is kept independently of whatever
ElevenLabs' own dashboard retains, so a finished conversation stays
recoverable even without access to that vendor account.

## 7. Widget appearance

In the ElevenLabs dashboard's widget appearance settings:

- Accent color: `#7c3aed`
- Surface color: `#07040f`
- Mode: text-only / chat (no voice)
- Bubble label: **"Questions?"** — not anything that implies a person is
  already typing, since nobody is until the conversation is escalated.

`js/config.js` carries a second value alongside `agentId`:

```
window.ENL_CHAT = { agentId: 'agent_xxxxxxxxxxxx', version: '1.2.3' };
```

`version` pins the vendor widget bundle
(`@elevenlabs/convai-widget-embed`) to a specific npm version. Left empty,
the loader resolves to whatever that package publishes next on unpkg —
convenient while the agent is still being set up, but this same script also
loads on `checkout.html` and `pay.html`, the two pages where money changes
hands, so leaving it unpinned once live means those pages silently start
running whatever the vendor ships next, untested. The value is only used if
it matches `/^[0-9A-Za-z.\-]+$/` (letters, digits, dots, hyphens); anything
else is ignored and the loader falls back to the unpinned URL.

## 8. Go-live checklist

Work through this in order. Each line says what to do and how to tell it
actually worked.

- [ ] **Secrets set on Render, not just locally.** `ELEVENLABS_AGENT_SECRET`
      and `ELEVENLABS_WEBHOOK_SECRET` are set in the **Render dashboard**
      (Environment → Add Environment Variable), and Render has finished the
      restart that follows. `server/.env` is git-ignored and never deployed,
      so a value that exists only there does not exist in production — see
      §2. Confirm against the LIVE API host, not localhost: call
      `/api/agent/product?q=test` with the correct `x-agent-secret` header
      and expect `200` with a `products` array; with the header wrong or
      missing, expect `401`. A `401` with a secret you believe is correct
      means it is set locally and not on Render.
- [ ] **Knowledge base uploaded.** All eight pages from §4 are in the
      agent's knowledge base, and `products.html` is not. Confirm by asking
      the agent something only answerable from one of the eight (a returns
      or shipping policy question) and getting a correct answer back.
- [ ] **Both tools wired and tested from the dashboard's test panel.** Each
      tool call is configured with the URL, method, header, and parameter
      schema from §5. Confirm by using ElevenLabs' own tool test panel to
      fire each one directly (not through a live chat) and checking the
      response shape matches §5 — a real product row for `lookup_product`, a
      reference number and message for `escalate`.
- [ ] **Transcript webhook verified.** The post-call webhook from §6 is
      configured with `ELEVENLABS_WEBHOOK_SECRET`. Confirm by ending one
      test conversation and checking that a new file appears in
      `server/data/agent-transcripts/` with a matching timestamp — and check
      the server log for `[agent] transcript rejected: signature mismatch`,
      which means the secret in the ElevenLabs dashboard does not match the
      one the running server has — Render's environment in production,
      `server/.env` locally.
- [ ] **`agentId` set in `js/config.js`.** `window.ENL_CHAT.agentId` holds
      the real agent id, not the placeholder. Confirm by opening the site
      with the browser console open — the `elevenlabs-convai` element and
      its script tag should be in the DOM, and no console error about a
      failed script load.
- [ ] **Widget version pinned.** `window.ENL_CHAT.version` is set to the
      exact `@elevenlabs/convai-widget-embed` version you tested against,
      not left empty. This matters because the same loader script runs on
      `checkout.html` and `pay.html` — leaving it unpinned means those two
      payment pages start pulling in whatever the vendor publishes next,
      sight unseen. Confirm by viewing the page source and checking the
      widget's `<script src>` includes `@<version>`.
- [ ] **Assets uploaded to the host before the HTML.** If any `.js` or
      `.css` file changed as part of this setup, it was uploaded to GoDaddy
      *before* the HTML that references its `?v=` cache-buster. Cloudflare
      caches those assets for four hours, so uploading them out of order
      binds the old file to the new version query string for up to four
      hours. Confirm with a never-used `?bust=` query on the asset URL and
      check the `cf-cache-status` response header if anything looks stale.
- [ ] **A real escalation walked end to end.** From the live site: open the
      bubble, ask a question the agent should refuse (see §3), confirm it
      refuses in one sentence and offers a person, accept, give a real email
      address, and confirm three things land: the acknowledgement email
      with a working `inbox.html` link, the thread showing up in
      `admin.html#inbox` with the chat transcript attached, and — after
      replying from the admin side — a reply email reaching that address
      with the guest link showing the reply.

**Note on this checklist:** it was written but not executed as part of this
task — there is no ElevenLabs account configured in this environment to run
it against. The owner should be the one to walk it the first time the agent
is actually configured, in the order given above.
