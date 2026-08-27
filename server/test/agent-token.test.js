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
