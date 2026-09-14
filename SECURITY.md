# Security notes — Ever Nova Life

Working reference for how this app protects itself, and what's knowingly still open. See `SECURITY_AUDIT.md` for the full audit history and per-finding detail; this file is the living summary.

## Secrets

- Live secrets exist in exactly two places: `server/.env` on whatever machine runs the server locally (gitignored, never committed — `server/.env.example` in the repo has placeholder names only), and the Render dashboard's environment variables for production.
- `git log` history was swept for every common secret pattern (`sk-`, `sk_live`, `AKIA`, `-----BEGIN`, `ghp_`, `xoxb-`, and every project-specific `KEY=`/`SECRET=`/`TOKEN=` assignment). One real leak was found and is already remediated: `CRON_KEY` sat in plaintext in `AUTO-SHIP.md` from commit `9357118` (2026-08-02) to `c68b082` (2026-09-09), in this **public** repo, and was rotated on removal. The old value stays permanently readable in git history unless it's rewritten — a separate, disruptive decision (breaks every existing clone/fork), not done as part of this audit.
- `.gitignore` covers `.env`, `server/.env`, `server/data/` (the JSON-file "database"). No `.env`, credential, or key file is tracked (`git ls-files` confirmed).
- No `.cursor/mcp.json` or `.cursorrules` exist in this repo.

## Authentication

- Email + password, hand-rolled (`server/auth.js`) — no third-party provider. bcrypt (cost 10) for password hashing; `DUMMY_HASH` equalizes login timing so a wrong email and a wrong password take about the same time.
- Sessions are JWTs (`jsonwebtoken`, HS256), 30-day default TTL (`JWT_TTL`), returned to the client and sent back as `Authorization: Bearer <token>`. **Known accepted risk:** the client stores this in `localStorage` (`js/auth.js`), which is XSS-exfiltratable in principle — no live XSS vector was found in this audit, but there's no cookie-based backstop either. Deferred by explicit decision (2026-09-14): moving to an `httpOnly` cookie needs a dedicated pass, since the GoDaddy-served site and the Render API are different origins (`SameSite=None; Secure` cookies, `cors({ credentials: true })`, and every frontend call site rewired).
- **What is fixed:** every JWT carries a `tokenVersion` claim. Resetting a password bumps the account's stored version and every token signed before that reset stops verifying immediately — a stolen token's usable life is capped at "until the owner resets," not the full 30 days.
- `admin.html`'s "admin key" fallback (`ADMIN_KEY` env var, sent as `x-admin-key`) is also cached in the browser's `localStorage` (`js/admin-core.js`) once entered. Same accepted-risk class as the session token, higher blast radius since it's a single static credential shared by every admin who's used the fallback box. Same deferral.
- Login, registration, and password-reset all give the same response whether or not an email is registered (no user enumeration).
- Admin identity is derived server-side from the verified JWT's email against `ADMIN_EMAILS`/`ADMIN_EMAIL` — never trusted from anything the client sends. `ADMIN_KEY` is a fallback credential, compared in constant time.

## Authorization

- Every ownership-sensitive route scopes its query to `req.user.id` (from the verified JWT) — cart, orders, subscriptions, disputes, inbox threads, loyalty, referrals. None accept a client-supplied `userId`/`accountId`/`role`/`isAdmin` for an authorization decision.
- Signed-out flows (pay-the-balance links, inbox reply links) use HMAC-signed reference tokens (`auth.refToken`/`verifyRefToken`, `crypto.timingSafeEqual`), not the record's raw id — a wrong id and someone else's id are indistinguishable from outside.
- `requireAdmin` gates every `/api/admin/*` route and every product/promotion/shipping/label-design write. `requireCron` gates the three scheduled triggers (`run-due`, `outreach/run`, `ach/poll`) behind a static `CRON_KEY`, falling back to `requireAdmin`.
- The ElevenLabs chat agent gets a separate, deliberately weak credential: a signed-in visitor trades their session JWT for a scoped, read-only, 30-minute token that only opens three narrow routes, behind a server-to-server shared secret (`requireAgent`) the browser never sees.
- Checkout, pricing, shipping fees, promotions, and loyalty discounts are all recomputed server-side on every order (`pricing.js:buildOrder`) — no route trusts a client-supplied price or total.

## Rate limiting

All in `server/ratelimit.js` (in-memory, fixed-window, per-process — resets on deploy/restart, which is an accepted limitation, not a gap: nothing it guards is an account-lockout-grade control).

| Route | Budget | Keyed on |
|---|---|---|
| `POST /api/auth/login` | 8 / 15 min | submitted email |
| `POST /api/auth/register` | 5 / hour | IP |
| `POST /api/auth/forgot` | 5 / 15 min | submitted email |
| `POST /api/crypto/checkout`, `/api/zelle/checkout`, `/api/ach/checkout` | 10 / hour, shared budget | IP |
| `POST /api/orders/lookup` | 12 / 10 min | IP |
| `POST /api/disputes`, `POST /api/disputes/:id/messages` | 6/hour, 30/10min | account |
| `POST /api/inbox/:id/messages` | 20 / 10 min | shared site-wide, deliberately (see the comment above `inboxPostLimiter` in `server.js` for why keying it any other way is worse) |
| Agent routes (`/api/agent/*`) | various, mostly shared-bucket | see inline comments — bounded by a server-to-server secret regardless |

`app.set('trust proxy', 1)` is required for every IP-keyed limiter above to actually be per-visitor rather than one shared bucket — Render sits behind exactly one reverse proxy, so this is safe and is Render's own documented configuration.

## Transport / headers

- `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and HSTS are set both by the API (`server/server.js`, for its own JSON responses) and by a root `.htaccess` (for the GoDaddy-served HTML pages, which is what actually serves `admin.html` in production).
- **No Content-Security-Policy yet.** This site has no bundler and no inline-script audit; a `script-src` strict enough to matter needs every one of its ~30 pages checked by hand first (the ElevenLabs widget, BTCPay's redirect, inline `<script>` tags). Accepted gap, tracked as future work rather than shipped blind.
- CORS: origin allowlist from `ALLOWED_ORIGINS`, no `credentials: true`, so the wildcard-plus-credentials footgun doesn't apply (auth is a Bearer header, not a cookie). **Requires manual verification:** confirm the Render production environment's `ALLOWED_ORIGINS` is actually set to `https://evernovalife.com` and not left at the `.env.example` default of `*`.
- BTCPay and ElevenLabs webhook signatures are both verified (`crypto.timingSafeEqual`) and fail closed when no secret is configured.

## Accepted / open risk (as of 2026-09-14)

| Item | Status | Why |
|---|---|---|
| Session JWT + admin-key fallback in `localStorage` | Deferred, by request | Fixing it properly is a cross-origin cookie migration, not a patch — see Authentication above |
| `nodemailer` HIGH advisory chain | Blocked | The fix needs Node ≥20; unconfirmed whether Render is provisioned for that yet |
| Content-Security-Policy | Deferred | Needs a page-by-page audit this pass didn't have scope for |
| `CRON_KEY` leaked in git history (2026-08-02–2026-09-09) | Accepted | Value already rotated; rewriting public git history is a separate, disruptive decision |
| `ALLOWED_ORIGINS` production value | Unverified | Dashboard setting, can't be checked from the repo |
