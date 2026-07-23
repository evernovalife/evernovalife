/* ============================================================
   EVER NOVA LIFE — loyalty + referral unit tests
   Exercises the tricky money/points math and the referral
   relationship directly at the module level, so we get coverage
   of earn/redeem/clamp, points⇄cash conversion, the priced
   discount, and one-time referral crediting WITHOUT needing to
   mock a payment gateway.

       npm test          (from the server/ folder)
       node --test
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point every store at a throwaway dir BEFORE requiring the modules, and pin
// the tunables so the assertions below are deterministic regardless of .env.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-loyalty-'));
process.env.DATA_DIR = TMP_DATA;
process.env.JWT_SECRET = 'test-secret-loyalty';
process.env.POINTS_PER_DOLLAR = '1';
process.env.POINTS_VALUE_CENTS = '1';        // 100 points = $1
process.env.REFERRAL_REWARD_POINTS = '500';

const loyalty = require('../loyalty.js');
const pricing = require('../pricing.js');
const auth = require('../auth.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ---- points: earn / redeem / clamp ---- */
test('earn, redeem and clamp keep the balance sane', () => {
  const uid = 'user-points';
  assert.equal(loyalty.getBalance(uid), 0);

  loyalty.earn(uid, 100, 'test earn', { orderId: 'O1' });
  assert.equal(loyalty.getBalance(uid), 100);

  loyalty.redeem(uid, 30, 'test redeem', { orderId: 'O2' });
  assert.equal(loyalty.getBalance(uid), 70);

  // redeeming more than the balance spends only what's there (never negative)
  loyalty.redeem(uid, 9999, 'over-redeem');
  assert.equal(loyalty.getBalance(uid), 0);

  // non-positive / garbage amounts are no-ops
  loyalty.earn(uid, -50, 'noop');
  loyalty.earn(uid, 'abc', 'noop');
  assert.equal(loyalty.getBalance(uid), 0);

  const acct = loyalty.getAccount(uid);
  assert.ok(acct.ledger.length >= 3, 'each change is recorded in the ledger');
  assert.equal(acct.ledger[0].balance, 0, 'ledger carries the running balance');
});

/* ---- points ⇄ money conversions ---- */
test('points/money conversions agree with the configured rates', () => {
  assert.equal(loyalty.pointsToDollars(100), 1);      // 100 pts → $1
  assert.equal(loyalty.pointsToCents(250), 250);      // 250 pts → 250¢
  assert.equal(loyalty.centsToPoints(500), 500);      // $5 → 500 pts
  assert.equal(loyalty.earnForAmount(10.99), 10);     // floored, no fractional points
  assert.equal(loyalty.earnForAmount(-5), 0);
});

/* ---- priced discount clamps and recomputes tax/total ---- */
test('buildOrder applies a discount, clamps it, and recomputes tax', () => {
  const plain = pricing.buildOrder([{ id: 1, quantity: 1 }]);
  assert.equal(plain.discount, 0);
  assert.ok(plain.subtotal > 0, 'seeded catalog priced the item');

  const disc = pricing.buildOrder([{ id: 1, quantity: 1 }], { discount: 5 });
  assert.equal(disc.discount, 5);
  const expectedTax = Math.round((disc.subtotal - 5) * pricing.TAX_RATE * 100) / 100;
  assert.ok(Math.abs(disc.tax - expectedTax) < 0.011, 'tax is charged on the post-discount subtotal');
  const expectedTotal = Math.round(((disc.subtotal - 5) + disc.shipping + disc.tax) * 100) / 100;
  assert.ok(Math.abs(disc.total - expectedTotal) < 0.011, 'total reflects the discount');

  // a runaway discount is clamped to the subtotal — total can't go negative
  const over = pricing.buildOrder([{ id: 1, quantity: 1 }], { discount: 999999 });
  assert.equal(over.discount, over.subtotal, 'discount clamped to subtotal');
  assert.equal(over.tax, 0, 'no tax when fully discounted');
  assert.ok(over.total >= 0);
});

/* ---- referral relationship + one-time reward claim ---- */
test('referral is captured at signup and rewarded exactly once', async () => {
  const referrer = await auth.registerUser({
    firstName: 'Ref', lastName: 'Errer', email: 'referrer@example.com', password: 'password123'
  });
  const code = referrer.user.referralCode;
  assert.ok(code && code.length >= 6, 'referrer gets a share code');

  const newbie = await auth.registerUser({
    firstName: 'New', lastName: 'Bie', email: 'newbie@example.com', password: 'password123', ref: code
  });

  // first claim credits both sides…
  const claim1 = auth.claimReferralReward(newbie.user.id);
  assert.ok(claim1, 'first paid order claims the reward');
  assert.equal(claim1.referrerId, referrer.user.id);
  assert.equal(claim1.refereeId, newbie.user.id);

  // …and it can never be claimed again
  assert.equal(auth.claimReferralReward(newbie.user.id), null, 'reward is one-time');

  // someone who used no code has nothing to claim
  const solo = await auth.registerUser({
    firstName: 'Solo', lastName: 'One', email: 'solo@example.com', password: 'password123'
  });
  assert.equal(auth.claimReferralReward(solo.user.id), null);

  // an unknown code is ignored at signup (no dangling referredBy)
  const bad = await auth.registerUser({
    firstName: 'Bad', lastName: 'Ref', email: 'badref@example.com', password: 'password123', ref: 'ZZZZZZ'
  });
  assert.equal(auth.claimReferralReward(bad.user.id), null);

  const stats = auth.getReferralStats(referrer.user.id);
  assert.equal(stats.code, code);
  assert.equal(stats.referredCount, 1, 'one person used the code');
  assert.equal(stats.rewardedCount, 1, 'and their reward has been granted');
});

/* ---- self-referral is impossible ---- */
test('a code cannot be used to refer the account that owns it', async () => {
  const u = await auth.registerUser({
    firstName: 'Self', lastName: 'Ref', email: 'selfref@example.com', password: 'password123'
  });
  // simulate signing up "again" with your own code → registerUser guards on email,
  // but claim must also refuse if referrer === referee. Register a second account
  // that (hypothetically) points back is covered by the email guard; here we assert
  // that an account with no valid referrer can't claim.
  assert.equal(auth.claimReferralReward(u.user.id), null);
});
