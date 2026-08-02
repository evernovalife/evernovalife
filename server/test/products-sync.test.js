/* ============================================================
   EVER NOVA LIFE — seed price sync tests
   The catalog has two layers: the static seed (js/products-data.js)
   and the runtime store (products.json on the data disk). The store
   is written once, so for a long time a price edited in the seed
   silently never reached a running shop — the storefront and the
   checkout both price from the store.

   SEED_SYNC_VERSION fixes that on demand. What has to hold:

     · a version bump re-applies the seed's price to built-in items
     · it runs ONCE — an admin price set afterwards survives restarts
     · products an admin ADDED are never touched
     · a stale originalPrice can't outlive the price it belonged to
       (a $85 item advertised as "was $49.99" is worse than no change)

   Runs with the built-in Node test runner:
       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-prodsync-'));
process.env.DATA_DIR = TMP_DATA;

const PRODUCTS_FILE = path.join(TMP_DATA, 'products.json');
const SYNC_FILE = path.join(TMP_DATA, 'products.sync.json');

const { PRODUCTS: SEED } = require('../../js/products-data.js');

/* A store as an already-deployed server would have it: seeded long ago, at
   prices that have since moved on in the seed file. Written BEFORE products.js
   is required so the module sees an existing (stale) store, exactly like a
   redeploy onto a persistent disk. */
const STALE = SEED.map(p => ({ ...p, price: 1.23, originalPrice: 2.34 }));
STALE.push({ id: 999, name: 'Admin-Added Kit', category: 'supplies', price: 42.5, originalPrice: 55 });
fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(STALE, null, 2));
fs.rmSync(SYNC_FILE, { force: true });          // never synced

const products = require('../products.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

function stored() {
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
}

test('a stale store is brought back to the seed prices on first read', () => {
  const list = products.listProducts();
  for (const seed of SEED) {
    const live = list.find(p => Number(p.id) === Number(seed.id));
    assert.ok(live, `product ${seed.id} still present`);
    assert.equal(live.price, seed.price, `${seed.name} priced from the seed`);
  }
});

test('the five repriced products are exactly what the catalog says', () => {
  // The prices this sync exists to deliver — spelled out so a bad seed edit
  // fails here rather than on the shop.
  const expected = {
    3: 85,     // GHK-Cu (Copper Peptide)
    4: 125,    // Tesamorelin / Ipamorelin Blend
    6: 130,    // BPC-157 / TB-500 Blend
    7: 150,    // KLOW Blend
    8: 80      // NAD+
  };
  const list = products.listProducts();
  for (const [id, price] of Object.entries(expected)) {
    const live = list.find(p => Number(p.id) === Number(id));
    assert.equal(live.price, price, `#${id} ${live.name} is $${price}`);
  }
});

test('a stale originalPrice is corrected too, so nothing shows an absurd "was" price', () => {
  const list = products.listProducts();
  for (const p of list.filter(p => Number(p.id) !== 999)) {
    if (p.originalPrice != null) {
      assert.ok(p.originalPrice > p.price,
        `${p.name}: "was $${p.originalPrice}" must be above the $${p.price} being charged`);
    }
  }
  const ghk = list.find(p => Number(p.id) === 3);
  assert.equal(ghk.originalPrice, null, 'GHK-Cu carries no was-price in the seed, so it carries none here');
});

test('a product the admin added is left alone', () => {
  const added = products.listProducts().find(p => Number(p.id) === 999);
  assert.equal(added.price, 42.5, 'not in the seed → not the seed\'s business');
  assert.equal(added.originalPrice, 55);
});

test('the sync is written down, and runs only once', () => {
  assert.ok(fs.existsSync(SYNC_FILE), 'the applied version is recorded beside the store');

  // An admin reprices something AFTER the sync — a later read must not undo it.
  const list = stored();
  const ghk = list.find(p => Number(p.id) === 3);
  ghk.price = 91.5;
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(list, null, 2));

  const after = products.listProducts().find(p => Number(p.id) === 3);
  assert.equal(after.price, 91.5, 'the admin price stands; the seed does not claw it back');
});

test('checkout prices from the synced store, not the stale file', () => {
  // pricing.js reads through the same store, which is what makes a wrong price
  // here a wrong CHARGE rather than just a wrong label.
  const { buildOrder } = require('../pricing.js');
  const order = buildOrder([{ id: 7, quantity: 2 }]);   // KLOW Blend @ $150
  assert.equal(order.items[0].unitPrice, 150);
  assert.equal(order.subtotal, 300);
});
