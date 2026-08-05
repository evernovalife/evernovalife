/* ============================================================
   EVER NOVA LIFE — seed ADD tests

   Sibling problem to products-sync.test.js. products.json is written once, so
   a product ADDED to the static catalog after a deployment's first run never
   appears on that shop at all — worse than a stale price, because the item is
   simply missing rather than wrong.

   SEED_ADD_VERSION fixes that on demand. What has to hold:

     · a bump appends seed products the store has never seen
     · it runs ONCE — an admin who then deletes one keeps it deleted
     · products already in the store are not duplicated or rewritten
     · an added product is priceable, so it can actually be checked out

   Runs with the built-in Node test runner:
       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-prodadd-'));
process.env.DATA_DIR = TMP_DATA;

const PRODUCTS_FILE = path.join(TMP_DATA, 'products.json');
const SYNC_FILE = path.join(TMP_DATA, 'products.sync.json');

const { PRODUCTS: SEED } = require('../../js/products-data.js');
const NEW_ID = 9;                                  // HGH 36 IU — the v1 addition

/* A store as a shop deployed before #9 existed would have it: every OTHER seed
   product, already price-synced, plus something the admin added themselves.
   Written before products.js is required, exactly like a redeploy onto a disk. */
const BEFORE = SEED.filter(p => Number(p.id) !== NEW_ID).map(p => ({ ...p }));
BEFORE.push({ id: 999, name: 'Admin-Added Kit', category: 'supplies', price: 42.5, originalPrice: 55 });
fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(BEFORE, null, 2));
fs.writeFileSync(SYNC_FILE, JSON.stringify({ version: 99 }));   // prices already current

const products = require('../products.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

function stored() {
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
}

test('a product added to the seed reaches a store that predates it', () => {
  const live = products.listProducts().find(p => Number(p.id) === NEW_ID);
  const seed = SEED.find(p => Number(p.id) === NEW_ID);
  assert.ok(live, `#${NEW_ID} is served`);
  assert.equal(live.name, seed.name);
  assert.equal(live.price, seed.price);
  assert.ok(stored().some(p => Number(p.id) === NEW_ID), 'and is persisted, not just returned');
});

test('nothing else moves: no duplicates, no rewrites', () => {
  const list = products.listProducts();
  const ids = list.map(p => Number(p.id));
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.equal(ids.length, SEED.length + 1, 'the seed plus the admin-added kit');
  const added = list.find(p => Number(p.id) === 999);
  assert.equal(added.price, 42.5, 'an admin-added product is not the seed\'s business');
});

test('the add is written down, and runs only once', () => {
  assert.ok(Number(JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')).addVersion) >= 1,
    'the applied add version is recorded');
  assert.equal(Number(JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')).version), 99,
    'and it did not clobber the price-sync version beside it');

  // The admin deletes the new product AFTER the add — a later read must respect that.
  fs.writeFileSync(PRODUCTS_FILE,
    JSON.stringify(stored().filter(p => Number(p.id) !== NEW_ID), null, 2));
  assert.equal(products.listProducts().find(p => Number(p.id) === NEW_ID), undefined,
    'a deleted product stays deleted until the version is bumped again');
});

test('an added product can be checked out at its seed price', () => {
  // Restore it (the previous test deleted it) and price an order through the
  // same store checkout uses — a product that lists but cannot be priced is
  // still broken.
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(BEFORE.concat([{ ...SEED.find(p => Number(p.id) === NEW_ID) }]), null, 2));
  const { buildOrder } = require('../pricing.js');
  const seed = SEED.find(p => Number(p.id) === NEW_ID);
  const order = buildOrder([{ id: NEW_ID, quantity: 2 }]);
  assert.equal(order.items[0].unitPrice, seed.price);
  assert.equal(order.subtotal, Number((seed.price * 2).toFixed(2)));
});
