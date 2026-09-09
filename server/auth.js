/* ============================================================
   EVER NOVA LIFE — authentication module
   Real accounts: bcrypt-hashed passwords + JWT session tokens.
   Users are persisted to a JSON file store (server/data/users.json)
   so there are no native build steps. The store is deliberately
   isolated behind load/save helpers, so you can swap it for a real
   database later without touching the route handlers.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// DATA_DIR is overridable via env so it can point at a persistent disk in
// production (e.g. a Render disk mounted at /var/data). Defaults to ./data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const TOKEN_TTL = process.env.JWT_TTL || '30d';
const BCRYPT_ROUNDS = 10;
const RESET_TTL_MS = 60 * 60 * 1000;   // password-reset links valid for 1 hour
/* The same machinery carries the "set your password" link for an account we
   opened during checkout. That link is not a reply to somebody asking for it a
   minute ago — it sits in an order email that may not be opened until the
   parcel arrives, so an hour would make it useless. */
const SETUP_TTL_MS = Number(process.env.PASSWORD_SETUP_TTL_DAYS || 14) * 24 * 60 * 60 * 1000;

/* ---- signing secret ----
   Prefer an explicit JWT_SECRET. If it's missing we fall back to a
   random per-process secret so dev still works — but tokens then die
   on restart, so we warn loudly. Always set JWT_SECRET in production. */
let SECRET = process.env.JWT_SECRET || '';
const CONFIGURED = !!SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] JWT_SECRET not set — using a random dev secret. ' +
    'Existing logins will break on restart. Set JWT_SECRET in server/.env for production.');
}

/* A valid dummy hash to compare against when an email is unknown, so a
   wrong email and a wrong password take about the same time (reduces
   account-enumeration signal). */
const DUMMY_HASH = bcrypt.hashSync('unused-placeholder-password', BCRYPT_ROUNDS);

/* ---- tiny JSON-file user store (read-through + atomic write) ---- */
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
}
function loadUsers() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || [];
  } catch (e) {
    console.error('[auth] users store unreadable, starting empty:', e.message);
    return [];
  }
}
function saveUsers(users) {
  ensureStore();
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);   // atomic on the same filesystem
}

const normEmail = e => String(e || '').trim().toLowerCase();

/* ---- admin accounts ----
   The "boss" accounts are designated by email via ADMIN_EMAILS (a comma-
   separated list), falling back to the single ADMIN_EMAIL already used for
   signup notifications. Whoever signs in with one of these emails is an admin
   and can manage/delete users. */
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
  .split(',').map(e => normEmail(e)).filter(Boolean);
const ADMIN_ENABLED = ADMIN_EMAILS.length > 0;
function isAdminEmail(email) { return ADMIN_EMAILS.includes(normEmail(email)); }

function publicUser(u) {
  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    createdAt: u.createdAt,
    referralCode: u.referralCode || '',   // this account's own share code
    isAdmin: isAdminEmail(u.email)   // lets the UI show admin tools for this account
  };
}

/* ---- referral codes ----
   Each account gets a short, human-shareable code. Alphabet omits easily
   confused characters (0/O, 1/I) so codes read cleanly over the phone / in
   print. Codes are unique across all accounts. */
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genReferralCode(users) {
  const taken = new Set(users.map(u => String(u.referralCode || '').toUpperCase()));
  for (let attempt = 0; attempt < 50; attempt++) {
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) code += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
    if (!taken.has(code)) return code;
  }
  return 'R' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);  // fallback
}
const normCode = c => String(c || '').trim().toUpperCase();

function signToken(u) {
  return jwt.sign({ sub: u.id, email: u.email }, SECRET, { expiresIn: TOKEN_TTL });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ---- register a new account ----
   `ref` (optional) is a referral code shared by an existing account. When it
   matches a real, different account we record who referred this user; the
   reward for BOTH sides is granted later, on this user's first paid order
   (see claimReferralReward). Storing it here just remembers the relationship. */
async function registerUser({ firstName, lastName, email, password, ref }) {
  firstName = String(firstName || '').trim();
  lastName = String(lastName || '').trim();
  email = normEmail(email);
  password = String(password || '');

  if (!firstName || !lastName) throw httpError(400, 'First and last name are required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Enter a valid email address.');
  if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');

  const users = loadUsers();
  const clash = users.find(u => u.email === email);
  if (clash) {
    /* An account we opened for them at checkout is one they have never signed
       into, so a bare "already exists" reads as a mistake rather than an
       instruction. Point at the one door that works — and deliberately NOT at
       claiming it with a new password here: the email behind it was never
       verified, and that account already holds real orders. The reset link
       going to the inbox is what proves the claim. */
    throw httpError(409, clash.passwordSet === false
      ? 'You already have an account from a previous order. Use "Forgot password" to set a password for it.'
      : 'An account with that email already exists.');
  }

  // Resolve the referral code (if any) to an existing, different account.
  let referredBy = '';
  const refCode = normCode(ref);
  if (refCode) {
    const referrer = users.find(u => normCode(u.referralCode) === refCode);
    if (referrer && referrer.email !== email) referredBy = referrer.referralCode;
  }

  const user = {
    id: crypto.randomUUID(),
    firstName,
    lastName,
    email,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    passwordSet: true,
    createdAt: new Date().toISOString(),
    referralCode: genReferralCode(users),
    ...(referredBy ? { referredBy } : {})
  };
  users.push(user);
  saveUsers(users);

  return { user: publicUser(user), token: signToken(user) };
}

/* ---- verify an email + password ---- */
async function authenticate({ email, password }) {
  email = normEmail(email);
  password = String(password || '');

  const users = loadUsers();
  const user = users.find(u => u.email === email);
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) throw httpError(401, 'Incorrect email or password.');

  return { user: publicUser(user), token: signToken(user) };
}

function getUserById(id) {
  const u = loadUsers().find(x => x.id === id);
  return u ? publicUser(u) : null;
}

/* Look up an account by email (public fields only), or null. Used at checkout
   to decide whether the buyer already has an account behind the address they
   typed. It answers with no credential involved, so nothing that reaches the
   browser may depend on it — see resolveCheckoutBuyer in server.js, which
   attaches the order but never issues a session. */
function findByEmail(email) {
  const u = loadUsers().find(x => x.email === normEmail(email));
  return u ? publicUser(u) : null;
}

/* ---- the account behind a checkout that had nobody signed in ----
   Every order must belong to an account holder (the card/ACH underwriting
   requires it), but making a buyer stop and register loses the sale. So the
   account is opened FOR them, from the email they were typing anyway.

   Two deliberate refusals here:
     · no password is chosen, and none can be guessed — the hash is over 32
       random bytes that are thrown away, so this account cannot be signed into
       until its owner sets a password from the emailed link;
     · no session token is minted (the caller cannot ask for one). The email
       address is unverified at this point, and handing out a 30-day session
       for an unverified address is how a stranger reads somebody else's
       order history.

   Returns the public user plus a long-lived setup token — the same shape a
   password reset uses, so reset-password.html needs no new page. */
async function createCheckoutAccount({ email, firstName, lastName }) {
  email = normEmail(email);
  firstName = String(firstName || '').trim() || 'Customer';
  lastName = String(lastName || '').trim() || '—';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Enter a valid email address.');

  const users = loadUsers();
  if (users.some(u => u.email === email)) throw httpError(409, 'An account with that email already exists.');

  const setupToken = crypto.randomBytes(32).toString('hex');
  const user = {
    id: crypto.randomUUID(),
    firstName,
    lastName,
    email,
    // Unguessable and unrecorded: there is no password, and this makes sure
    // there is no shared default one either.
    passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_ROUNDS),
    passwordSet: false,
    createdVia: 'checkout',
    createdAt: new Date().toISOString(),
    referralCode: genReferralCode(users),
    resetTokenHash: hashToken(setupToken),
    resetTokenExpires: new Date(Date.now() + SETUP_TTL_MS).toISOString()
  };
  users.push(user);
  saveUsers(users);

  return { user: publicUser(user), setupToken };
}

/* All accounts (public fields only), newest first — for the admin view. */
function listUsers() {
  return loadUsers()
    .map(publicUser)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/* Permanently delete an account by id. Returns the deleted (public) user,
   or null if no account had that id. The caller is responsible for cleaning
   up related data (cart/orders). */
function deleteUser(id) {
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  const [removed] = users.splice(idx, 1);
  saveUsers(users);
  return publicUser(removed);
}

/* ---- password reset ----
   We store only a HASH of the reset token (like a password), so a leaked
   user store can't be used to reset accounts. The plaintext token goes out
   in the email link only. */
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

/* Create a reset token for an email. Returns { token, user } if the account
   exists, or null if it doesn't — the caller responds identically either way
   so we never reveal which emails are registered. */
async function createResetToken(email) {
  email = normEmail(email);
  const users = loadUsers();
  const user = users.find(u => u.email === email);
  if (!user) return null;

  const token = crypto.randomBytes(32).toString('hex');
  user.resetTokenHash = hashToken(token);
  user.resetTokenExpires = new Date(Date.now() + RESET_TTL_MS).toISOString();
  saveUsers(users);
  return { token, user: publicUser(user) };
}

/* Complete a reset: validate the token (exists + not expired), set the new
   password, and clear the token so it can't be reused. */
async function resetPassword(token, newPassword) {
  newPassword = String(newPassword || '');
  if (!token) throw httpError(400, 'Missing reset token.');
  if (newPassword.length < 8) throw httpError(400, 'Password must be at least 8 characters.');

  const wanted = hashToken(token);
  const users = loadUsers();
  const user = users.find(u => u.resetTokenHash === wanted);
  const expired = user && (!user.resetTokenExpires ||
    new Date(user.resetTokenExpires).getTime() < Date.now());
  if (!user || expired) {
    throw httpError(400, 'This reset link is invalid or has expired. Please request a new one.');
  }

  user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  user.passwordSet = true;          // a checkout-made account is now a real one
  delete user.resetTokenHash;
  delete user.resetTokenExpires;
  saveUsers(users);
  return { user: publicUser(user) };
}

/* ---- referral queries + reward claim ---- */

/* Look up an account by its share code (public fields only), or null. */
function findByReferralCode(code) {
  code = normCode(code);
  if (!code) return null;
  const u = loadUsers().find(x => normCode(x.referralCode) === code);
  return u ? publicUser(u) : null;
}

/* This account's referral summary. Lazily assigns a code to legacy accounts
   that predate the feature, so every account can share as soon as it looks. */
function getReferralStats(userId) {
  const users = loadUsers();
  const me = users.find(x => x.id === userId);
  if (!me) return { code: '', referredCount: 0, rewardedCount: 0 };
  if (!me.referralCode) { me.referralCode = genReferralCode(users); saveUsers(users); }
  const code = normCode(me.referralCode);
  let referredCount = 0, rewardedCount = 0;
  for (const u of users) {
    if (normCode(u.referredBy) === code) {
      referredCount++;
      if (u.referralRewarded) rewardedCount++;
    }
  }
  return { code: me.referralCode, referredCount, rewardedCount };
}

/* Claim the referral reward for `userId`, exactly once, when they complete
   their first paid order. Returns { referrerId, refereeId } if a reward should
   now be granted to both sides (the caller does the actual points crediting),
   or null if there's nothing to reward (no referrer, self-referral, or already
   rewarded). Marking rewarded here makes it idempotent against repeated calls
   (e.g. a webhook fired twice). */
function claimReferralReward(userId) {
  const users = loadUsers();
  const me = users.find(x => x.id === userId);
  if (!me || me.referralRewarded) return null;
  const code = normCode(me.referredBy);
  if (!code) return null;
  const referrer = users.find(x => normCode(x.referralCode) === code);
  if (!referrer || referrer.id === me.id) return null;
  me.referralRewarded = true;
  saveUsers(users);
  return { referrerId: referrer.id, refereeId: me.id };
}

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

/* ---- signed references for links that arrive by email ----
   Some links have to work with nobody signed in: "pay the rest of order X"
   lands in an inbox, gets opened on a phone hours later, and may belong to a
   guest who has no account to sign into. A session token can't carry that, so
   the unguessable URL is the credential.

   HMAC of scope + value under the server's own secret. No storage and no
   expiry table, which means a token minted today is still the token for an
   order raised last week — the stuck orders that already exist get a working
   link without a migration. The scope prefix stops a token for one purpose
   being replayed as another. */
function refToken(scope, value) {
  return crypto.createHmac('sha256', SECRET)
    .update(String(scope) + ':' + String(value))
    .digest('hex')
    .slice(0, 32);
}

function verifyRefToken(scope, value, token) {
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(refToken(scope, value));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

/* Express middleware: require a valid "Authorization: Bearer <token>"
   header, then attach the (public) user to req.user. */
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const payload = match && verifyToken(match[1]);
  if (!payload) return res.status(401).json({ error: 'Not signed in.' });

  const user = getUserById(payload.sub);
  if (!user) return res.status(401).json({ error: 'Account no longer exists.' });

  req.user = user;
  next();
}

module.exports = {
  CONFIGURED,
  ADMIN_ENABLED,
  isAdminEmail,
  registerUser,
  createCheckoutAccount,
  authenticate,
  getUserById,
  findByEmail,
  listUsers,
  deleteUser,
  createResetToken,
  resetPassword,
  findByReferralCode,
  getReferralStats,
  claimReferralReward,
  verifyToken,
  mintAgentToken,
  verifyAgentToken,
  AGENT_TOKEN_TTL_SECONDS,
  refToken,
  verifyRefToken,
  requireAuth
};
