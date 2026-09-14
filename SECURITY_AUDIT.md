# Security Audit — Ever Nova Life (evernovalife.com)

Date: 2026-09-14
Scope: full repository, read-only (Phase 1). Branch audited: `security-audit` (off `main` @ `e44d82a`).
Auditor stance: offensive — findings below are what an attacker would actually exploit, not style/architecture opinions.

---

## Verdict

**CRITICAL ISSUES PRESENT** (one historical git-history secret leak; several HIGH-severity gaps compound it)

---

## Stack Summary

| Layer | What it is |
|---|---|
| Backend framework | Node.js + Express 4.19, one monolithic file (`server/server.js`, 6,209 lines) plus ~15 sibling modules (`auth.js`, `store.js`, `pricing.js`, `products.js`, `promotions.js`, `shipping.js`, `disputes.js`, `inbox.js`, `agent-knowledge.js`, `subscriptions.js`, `loyalty.js`, `btcpay.js`, `zelle.js`, `finagy.js`, `label-design.js`, `outreach.js`, `email.js`, `ratelimit.js`) |
| Language | JavaScript (CommonJS), no TypeScript, no build step |
| Database | **None** — a hand-rolled JSON-file store (`server/data/*.json`) behind `store.js`/`auth.js`, gitignored and never committed |
| Auth | Custom: bcryptjs (cost 10) + jsonwebtoken (HS256), no third-party auth provider (no Clerk/Auth0/Supabase Auth/Firebase) |
| Frontend | Static HTML/CSS/vanilla JS, no framework/bundler, hosted on **GoDaddy shared hosting** behind **Cloudflare** DNS/edge |
| API hosting | **Render** (separate origin from the static site) |
| Payments | **BTCPay Server** (self-hosted, Bitcoin/Lightning) · **Zelle** (manual, no API — admin confirms by hand) · **AllayPay/Finagy** (ACH bank debit; AllayPay is the ISO, Finagy is the gateway; **no webhook** — a cron-triggered poller is the only settlement signal) |
| Other external APIs | Gmail SMTP via `nodemailer` (transactional email) · ElevenLabs Conversational AI (voice/chat widget + a knowledge-base ingestion API) |
| Git remote | `https://github.com/evernovalife/evernovalife.git` — **public repository** |

---

## Executive Summary

| Severity | Count |
|---|---|
| CRITICAL | 1 |
| HIGH | 6 |
| MEDIUM | 4 |
| LOW | 3 |

**The three findings that would cause the most damage today:**

1. **A real `CRON_KEY` sat in plaintext in `AUTO-SHIP.md` in this public GitHub repo for 5 weeks** (2026-08-02 → 2026-09-09). It secures three billing/payout-adjacent triggers. It has already been rotated per the repo's own commit history, but the old value is permanently readable by anyone who clones the repo's history.
2. **`/api/auth/login`, `/api/auth/register`, `/api/auth/forgot`, and all three checkout endpoints (`crypto`/`zelle`/`ach`) have zero rate limiting.** Login is brute-forceable; checkout can be spammed to exhaust real stock counts, email-bomb arbitrary third-party addresses through the store's own Gmail account, and hammer the Finagy ACH gateway — a live concern given the merchant account already has a fraud-related reserve hold per project notes.
3. **The order-lookup rate limiter (and by the same defect, the agent-transcript limiter) shares ONE bucket for the entire site**, because Express `req.ip` is the Render proxy's own address (no `app.set('trust proxy')`). Twelve throwaway POSTs from any single anonymous visitor disables "where is my order" for every real customer for 10 minutes, repeatably, forever, for free.

---

## Findings

### CRITICAL

**C1. `CRON_KEY` committed in plaintext, public repo, live for 5 weeks**
File: `AUTO-SHIP.md` (introduced commit `9357118`, 2026-08-02; removed commit `c68b082`, 2026-09-09)
Exploit: Anyone who cloned or browsed `github.com/evernovalife/evernovalife` between those dates could read the real `CRON_KEY` value and call `POST /api/subscriptions/run-due`, `POST /api/outreach/run`, and `POST /api/ach/poll` (`server/server.js:5571-5575, 5577, 5888, 2924`) as if they were the trusted cron service — triggering the auto-ship billing run, the outreach/nudge sweep, and the ACH settlement poller on demand, repeatedly, from outside.
Status: The key has been rotated (per the removal commit and prior project notes), so the *specific* leaked value is no longer valid — but it remains permanently visible in git history on a public repo, which is itself the CRITICAL condition per standard secret-hygiene practice ("the key has left this machine").
Fix (code): none needed beyond what's already done (rotation) — this is a history/dashboard item, see ROTATE NOW and DASHBOARD/CONFIG below.

### HIGH

**H1. No rate limiting on `/api/auth/login`** — **FIXED** (commit `ab21f93`)
File: `server/server.js:180-188`
Exploit: `auth.authenticate()` has no per-account or per-IP attempt cap anywhere in the request path (`server/auth.js:174-184` + no limiter middleware on the route). An attacker can run unlimited password guesses against any known email at whatever throughput bcrypt-cost-10 allows on the attacker's own hardware in parallel (bcrypt only slows the *server's* verify call, not a distributed guesser). No account lockout exists either.
Fix: add `ratelimit.limit({ name: 'login', windowMs: 15*60*1000, max: 8, key: req => normEmail(req.body.email) })` (or IP-keyed with a higher ceiling) ahead of the handler; the codebase already has the exact pattern in `disputeOpenLimiter`/`lookupLimiter`.

**H2. No rate limiting on `/api/auth/register`, `/api/auth/forgot`** — **FIXED** (commit `1e08b7e`)
File: `server/server.js:115-127` (register), `880-916` (forgot)
Exploit: Register has no cap, so an attacker can mass-create accounts, each of which fires a welcome email to the entered address (`sendWelcomeEmail`) and an admin-notify email (`notifyAdminOfSignup`) — spamming both arbitrary third parties and the store owner's inbox through the store's own Gmail SMTP reputation, and squatting on emails the attacker doesn't own (no email verification at signup — ownership is only proven later, if ever, via the reset-password flow). Forgot-password has no cap either: every call sends a real email (`server/server.js:900-909`), so it can be used to email-bomb any address repeatedly at zero cost to the attacker.
Fix: add a per-IP limiter (e.g. 5/hour) to both routes, same pattern as H1.

**H3. No rate limiting on the checkout endpoints — stock-exhaustion DoS, email-bombing, and uncontrolled Finagy calls** — **FIXED** (commit `70dba38`)
File: `server/server.js:1301` (`/api/crypto/checkout`), `2234` (`/api/zelle/checkout`), `2365` (`/api/ach/checkout`) — all `optionalAuth` (guest-allowed), none carry a rate limiter
Exploit: Each call runs `reserveOrderStock(order)` (`server.js:1347, 2400`), which really decrements `stockQty` before any payment happens, and is only released if the resulting invoice later expires unpaid. An attacker can loop checkout with real product ids and never pay, driving stock to zero and denying real customers purchase for as long as the BTCPay/Finagy expiry window holds (tens of minutes to hours). Each call also fires a confirmation email to whatever `body.email` the attacker supplies (`sendCryptoInvoiceEmail`, `sendAchOpenedEmail`, `sendAccountOpenedEmail`) and an admin-notify email — an email-bombing primitive against arbitrary third parties. On the ACH path specifically, every call makes a real outbound call to Finagy's gateway (`finagy.createSessionKey`, `server.js:2406`) — given the project's own notes that the Finagy merchant account already carries a fraud-related reserve hold, uncontrolled hammering of this endpoint is a direct business/underwriting risk, not just a technical one.
Fix: add a per-IP (and, for signed-in buyers, per-account) limiter to all three checkout routes; a modest ceiling (e.g. 10/hour/IP) stops automated abuse without affecting real shoppers.

**H4. Site-wide shared-bucket rate limiter lets one anonymous visitor disable order-lookup for everyone** — **FIXED** (commit `90bf777`)
File: `server/ratelimit.js:26-28` (`clientKey` falls back to `req.ip`) + `server/server.js:1877-1882` (`lookupLimiter` — no `key` override) + `server/server.js:3858-3863` (`agentTranscriptLimiter` — same defect, lower-impact target)
Exploit: This server never calls `app.set('trust proxy')` (confirmed absent repo-wide), so on Render `req.ip` is the platform proxy's own address — **identical for every visitor**. `lookupLimiter` has no `key:` override, so its "12 requests / 10 minutes" cap is one bucket shared by the entire site's guest traffic, not per-visitor. Any single anonymous actor can send 12 throwaway `POST /api/orders/lookup` requests and lock every real customer out of "where is my order" for 10 minutes — and repeat this indefinitely at ~72 requests/hour to keep the feature permanently disabled. The same defect exists on `agentTranscriptLimiter`, with lower impact (it only blocks ElevenLabs' own transcript-save webhook, which is itself HMAC-verified). Note this is the *opposite* mistake from the one the code's own extensive comments correctly reason through for `inboxPostLimiter`/`agentLimiter` (deliberately left unkeyed with a documented rationale) — `lookupLimiter` appears to have been missed by that same review.
Fix: key `lookupLimiter` on something that actually varies per attacker attempt — e.g. the submitted `orderId` is attacker-controlled and cheap to vary, so IP-keying is moot regardless; the real fix is `app.set('trust proxy', 1)` (Render sits behind exactly one hop) so `req.ip` becomes the real client address again, which also fixes every other IP-keyed limiter in the file at once. Test that this doesn't break the "shared bucket by design" routes that were deliberately built around the *absence* of trust proxy.

**H5. Session JWT and the ADMIN_KEY fallback credential both live in `localStorage`**
File: `js/auth.js:12,22-23` (JWT), `js/admin-core.js:18,27,37` (`ADMIN_KEY`)
Exploit: The 30-day session JWT (`server/auth.js:21,109-111`) is stored in `localStorage`, readable by any script that ever executes on the page — standard XSS-exfiltration risk, and no cookie-based protection (`httpOnly`/`Secure`/`SameSite`) exists as a backstop. No live XSS injection point was found in this review (see MEDIUM/no-findings below), so this is a defense-in-depth gap, not a demonstrated exploit chain today. More serious: `admin-core.js` persists the **static, non-expiring `ADMIN_KEY`** fallback credential in `localStorage` too — a single leaked value (via any future XSS, a shared/public machine, or a malicious browser extension) grants full admin API access indefinitely, for every admin who ever used the fallback box.
Fix: move the session token to an `httpOnly; Secure; SameSite=None` cookie (requires the API and site to cooperate cross-origin, which they already must for CORS); at minimum, stop persisting `ADMIN_KEY` client-side at all — require it to be re-entered per session, or retire the key-fallback path in favor of admin accounts only.

**H6. `nodemailer` has an actively-exploitable HIGH-severity advisory chain**
File: `server/package.json:21` (`"nodemailer": "^6.10.1"`, resolves to a version `<=9.1.0` per `npm audit`)
Exploit: The installed range is vulnerable to SMTP/header command injection via unsanitized transport options, a `jsonTransport` bypass of the `disableFileAccess`/`disableUrlAccess` guards, an OAuth2 TLS-certificate-validation bypass enabling credential interception, and a message-level `raw` option bypass enabling arbitrary file read / full-response SSRF from the mail-sending path. This module sends every transactional email in the app (welcome, password reset, order/invoice, dispute, admin-notify) with content partially drawn from user-supplied fields (email address, shipping name, dispute reason) — several of these advisories are reachable through exactly that kind of usage.
Fix: `npm audit fix --force` → `nodemailer@10.0.10` (breaking major-version bump; smoke-test `server/email.js` and every call site afterward, since v10 changed some transport option shapes).

### MEDIUM

**M1. No security headers anywhere in the stack**
File: `server/server.js`, `server/app.js` (no `helmet`, no manual `res.set` for security headers); no `.htaccess` in the repo root for the GoDaddy-served static site
Exploit: No `X-Frame-Options`/`frame-ancestors` means `admin.html`/`admin-products.html` can be iframed by an attacker-controlled page for clickjacking against an already-authenticated admin session. No CSP means any future XSS (none found today, but this is the mitigating layer for one that appears tomorrow) has no containment. No HSTS leaves a protocol-downgrade window on first visit before Cloudflare's edge TLS engages.
Fix: add `helmet()` to `server/server.js` with a CSP that allow-lists the ElevenLabs widget script origin and BTCPay's checkout origin, plus `frame-ancestors 'none'` (or `'self'` if any page legitimately frames itself); add the Apache equivalent via `.htaccess` for the static GoDaddy site, since that's the layer actually serving those files in production.

**M2. Password reset does not invalidate previously-issued session tokens**
File: `server/auth.js:291-311` (`resetPassword`) vs. `server/auth.js:109-111` (`signToken` — payload is only `{ sub, email }`, no version/epoch field)
Exploit: A JWT is stateless and carries no session-version claim. If a session token is ever stolen (H5) and the account holder responds by resetting their password, the stolen token **remains valid for up to 30 days regardless** — resetting the password does not revoke it, because nothing server-side ties token validity to password/version state.
Fix: add a `tokenVersion` field to the user record, embed it in the JWT payload, bump it on password reset, and check it in `verifyToken`/`requireAuth`.

**M3. `ALLOWED_ORIGINS` defaults to `*` — verify production value**
File: `server/server.js:44-51`, `server/.env.example:20`
This can't be verified from the repository — it depends on the `ALLOWED_ORIGINS` environment variable actually set on Render. The code itself correctly rejects any origin not on the list once one is configured (not a wildcard-plus-credentials pattern, since auth uses a Bearer header, not cookies), so this is a config-verification item, not a code defect. See DASHBOARD/CONFIG below.

**M4. `qs` / `body-parser` MODERATE DoS advisories (transitive, via Express)**
File: `server/package.json` (transitive dependency of `express@^4.19.2`)
Exploit: `qs` 2.2.5–6.15.3 has an array-limit bypass and a `isBuffer`-triggered DoS; `body-parser` <=1.20.6 has a size-limit bypass — both reachable through any request Express parses.
Fix: `npm audit fix` (non-breaking).

### LOW

**L1. `requireAdmin`/`requireCron` static-key comparisons are not constant-time**
File: `server/server.js:773` (`key === ADMIN_KEY`), `server/server.js:5573` (`key === CRON_KEY`)
Exploit: theoretical timing side-channel to recover the key byte-by-byte; impractical over a real network given jitter, but inconsistent with the rest of the codebase, which correctly uses `crypto.timingSafeEqual` for every other secret comparison (`auth.js:392-395`, `server.js:3553-3557`).
Fix: wrap both comparisons in the same length-checked `timingSafeEqual` pattern already used elsewhere in this file.

**L2. `X-Powered-By: Express` not disabled**
File: `server/server.js` (no `app.disable('x-powered-by')` anywhere)
Exploit: trivial framework fingerprinting only.
Fix: `app.disable('x-powered-by')` near the top of `server.js`.

**L3. `agent-knowledge.js` file-ingestion has no explicit decoded-length cap of its own**
File: `server/agent-knowledge.js:138-152` (`addFile`)
Not independently exploitable — bounded by the global `express.json({ limit: '12mb' })` (`server.js:61-64`) and gated behind `requireAdmin`. Noted for completeness only; no fix required unless the global body limit is ever raised for another route without this one being reconsidered.

---

## No findings (checked, nothing to report)

- **SQL injection** — N/A, no SQL database anywhere in the stack (JSON-file store only).
- **Supabase/Postgres RLS** — N/A, not used.
- **Command injection** — no `child_process`/`exec`/`spawn` calls anywhere in `server/*.js` (verified by grep across the full server directory).
- **Path traversal** — every file-write path that incorporates user input (dispute attachments, agent-transcript ids, product images) either allowlists characters and truncates length, or resolves through a server-generated id rather than a client-supplied filename.
- **XSS (client + server-rendered email)** — every interpolation point sampled across `js/*.js` and every HTML-email builder in `server/server.js` passes through an escaping helper (`esc()`/`escapeHtml()` client-side, `escapeHtmlSrv()` server-side) before insertion; dispute/inbox message *bodies* are deliberately excluded from outbound emails entirely rather than risked.
- **SSRF** — `agent-knowledge.js`'s URL-ingestion route forwards the admin-supplied URL to ElevenLabs' own API as a parameter; this server never fetches it directly, so it cannot be used to reach cloud metadata or internal addresses.
- **IDOR / authorization** — every ownership-sensitive route reviewed (cart, orders, subscriptions, disputes, inbox, pay-balance links) scopes its query to `req.user.id` (derived from the verified JWT) or an HMAC-signed reference token; none trust a client-supplied `userId`/`accountId`/`role`/`isAdmin` field for an authorization decision.
- **Price/value trust** — `pricing.js:buildOrder` recomputes every line item, shipping fee, promotion, tax, and loyalty discount from server-side state on every payment path; no route accepts a client-supplied price or total.
- **File uploads** — dispute-photo uploads are magic-byte sniffed (not trusted by declared MIME/extension), size-capped per file and in aggregate, and never trust the client filename for the on-disk path; product images and admin uploads follow the same base64-JSON pattern with a size ceiling.
- **AI/LLM (ElevenLabs agent)** — the browser trades its session JWT for a scoped, read-only, 30-minute token (`mintAgentToken`) that can only reach three narrow, non-destructive routes (`/api/agent/account`, `/api/agent/product`, `/api/agent/escalate`), all behind a server-to-server shared secret (`requireAgent`) plus rate limiting; the knowledge base the agent draws on is admin-curated only (customers cannot inject content into it). No destructive tool is reachable by the model without an independent server-side authorization check.
- **Cookies** — N/A as an attack surface; the app uses Bearer-token auth, not cookies, so `httpOnly`/`Secure`/`SameSite` cookie flags don't apply (see H5 for the corresponding localStorage risk instead).
- **User enumeration** — login, register, and forgot-password all give identical or near-identical responses regardless of whether the email exists (`auth.js:42-45` dummy-hash timing equalization on login, `auth.js:276-287` + `server.js:880-916` identical response on forgot).
- **Webhook signature verification** — BTCPay webhook (`btcpay.js:309-321`) and the ElevenLabs transcript webhook (`server.js:3876`, `verifyAgentSignature`) both fail closed (reject when no secret is configured) and use `crypto.timingSafeEqual`.
- **Dependencies beyond nodemailer/qs/body-parser** — `npm audit --omit=dev` reports exactly those three vulnerable packages; everything else in the 6-package direct dependency tree is clean.
- **Debug/verbose errors** — the global Express error handler logs `err.stack` server-side only and returns a fixed generic JSON message to the client on every route, including non-admin ones.
- **Source maps** — none in the app's own code; the only `.map` file in the repo is a third-party dependency artifact under `node_modules`, which is itself blocked from being served.

---

## ROTATE NOW

| Credential | Why | Where to rotate |
|---|---|---|
| `CRON_KEY` | Real value was committed to `AUTO-SHIP.md` in this **public** repo for 5 weeks (2026-08-02 to 2026-09-09). Project history shows it was already rotated on removal — **verify** the current value in Render is different from the old leaked one and that every external caller (the cron service hitting `/api/subscriptions/run-due`, `/api/outreach/run`, `/api/ach/poll`) was updated to match. | Render → environment variables (`CRON_KEY`), and whatever external scheduler holds the `x-cron-key` header |

No other real (non-placeholder) secret was found in git history — every other hit on `JWT_SECRET=`, `ADMIN_KEY=`, `BRAINTREE_PRIVATE_KEY=`, `ELEVENLABS_API_KEY=`, `FINAGY_BASIC_TOKEN=`, `BTCPAY_WEBHOOK_SECRET=`, `SMTP_PASS=` across full history resolved to either an empty placeholder or documentation example text (`<long random string>`, `replace-with-your-private-key`, etc.), not a real value.

**Separate decision needed from you:** the leaked `CRON_KEY` stays permanently readable in git history unless it's rewritten (`git filter-repo`/BFG) and force-pushed. That's a disruptive, hard-to-reverse action on a public repo (breaks every existing clone/fork) — I did not do this and won't without you explicitly asking for it. Given the key is already rotated, the practical risk of leaving history as-is is low; flagging so you can decide rather than assuming.

---

## DASHBOARD / CONFIG CHANGES

- **Render**: confirm `ALLOWED_ORIGINS` is set to `https://evernovalife.com` (not `*`) in the production environment (M3).
- **Render**: confirm `CRON_KEY` was actually rotated in the live environment, not just in the repo's docs (see ROTATE NOW).
- **Render**: confirm HTTPS is enforced for the API's custom domain (Render defaults to this, but worth a one-time check).
- **Cloudflare**: confirm "Always Use HTTPS" and HSTS are enabled at the edge for evernovalife.com (per prior project notes, Cloudflare is authoritative for DNS here).
- **GoDaddy**: no `.htaccess` currently sets any security headers for the static site (M1) — this is a code/file change (add `.htaccess`), not a dashboard toggle, but it's GoDaddy-side rather than Render-side.
- **AllayPay/Finagy**: given the account's existing reserve hold (per project notes), prioritize closing H3 (rate-limit the ACH checkout path) before any further volume — this is as much a merchant-underwriting risk as a security one.

---

## Remediation Plan (impact ÷ effort, highest first)

1. **H4** — add `app.set('trust proxy', 1)` — one line, fixes the site-wide DoS on order-lookup immediately (verify it doesn't regress the intentionally-shared-bucket routes).
2. **H1/H2/H3** — add rate limiters to login/register/forgot/checkout using the `ratelimit.js` pattern already in the codebase — mechanical, low-risk, highest fraud/abuse payoff.
3. **H6/M4** — `npm audit fix` (qs/body-parser, non-breaking) now; schedule `npm audit fix --force` (nodemailer major bump) with a test pass on `server/email.js`.
4. **M1** — add `helmet()` + a GoDaddy `.htaccess` — one dependency, broad defense-in-depth payoff.
5. **L1/L2** — two one-line fixes (`timingSafeEqual`, `x-powered-by`) — do alongside the above.
6. **H5/M2** — session-token architecture change (cookie migration and/or token versioning) — highest effort, most invasive; schedule as a deliberate follow-up rather than bundling with the mechanical fixes above.
7. **ROTATE NOW + DASHBOARD/CONFIG items** — outside the codebase; action on your side, any time, independent of the above.

---

Phase 1 complete, awaiting approval.
