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

function publicUser(u) {
  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    createdAt: u.createdAt
  };
}

function signToken(u) {
  return jwt.sign({ sub: u.id, email: u.email }, SECRET, { expiresIn: TOKEN_TTL });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ---- register a new account ---- */
async function registerUser({ firstName, lastName, email, password }) {
  firstName = String(firstName || '').trim();
  lastName = String(lastName || '').trim();
  email = normEmail(email);
  password = String(password || '');

  if (!firstName || !lastName) throw httpError(400, 'First and last name are required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Enter a valid email address.');
  if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');

  const users = loadUsers();
  if (users.some(u => u.email === email)) {
    throw httpError(409, 'An account with that email already exists.');
  }

  const user = {
    id: crypto.randomUUID(),
    firstName,
    lastName,
    email,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    createdAt: new Date().toISOString()
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

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
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
  registerUser,
  authenticate,
  getUserById,
  verifyToken,
  requireAuth
};
