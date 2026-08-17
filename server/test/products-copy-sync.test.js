/* ============================================================
   EVER NOVA LIFE — listing-copy + COA sync tests

   The store (products.json on the data disk) is written once, so anything
   edited in the seed afterwards has to be pushed on demand or it never
   reaches a running shop. Two of those on-demand syncs carry claims a buyer
   reads BEFORE paying, which is why they get their own tests:

     · COPY_SYNC_VERSION — name, category, description, and (since v2) the
       stated purity, quantity and specs table
     · COA_SYNC_VERSION  — the certificate block, including the scope note

   What has to hold:

     · a bump re-applies the seed's copy, purity, specs and coa to built-ins
     · `specs` is an object, so it must be compared BY VALUE and stored as a
       COPY — handing the store the seed's own object would let a later admin
       edit mutate the seed every other product is synced against
     · products an admin ADDED are never touched

   Runs with the built-in Node test runner:
       npm test          (from the server/ folder)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enl-copysync-'));
process.env.DATA_DIR = TMP_DATA;

const PRODUCTS_FILE = path.join(TMP_DATA, 'products.json');
const SYNC_FILE = path.join(TMP_DATA, 'products.sync.json');

const { PRODUCTS: SEED } = require('../../js/products-data.js');
const seedById = id => SEED.find(p => Number(p.id) === Number(id));

/* A store as a long-running deployment would have it: seeded before the
   catalog was re-tested, so it still carries the OLD purity figure, the old
   specs table and the old certificate — the state that had the live shop
   claiming a purity its own published report contradicted. */
const STALE = SEED.map(p => ({
  ...p,
  purity: 'stale purity',
  specs: { 'Stale Spec': 'from an older deploy' },
  coa: { status: 'pending' }
}));
STALE.push({
  id: 999,
  name: 'Admin-Added Kit',
  category: 'supplies',
  price: 42.5,
  purity: 'admin purity',
  specs: { 'Admin Spec': 'entered by hand' }
});
fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(STALE, null, 2));
fs.rmSync(SYNC_FILE, { force: true });          // never synced

const products = require('../products.js');

test.after(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('a stale store gets the seed purity and specs back on first read', () => {
  const list = products.listProducts();
  for (const seed of SEED) {
    const live = list.find(p => Number(p.id) === Number(seed.id));
    assert.ok(live, `product ${seed.id} still present`);
    assert.equal(live.purity, seed.purity, `${seed.name}: stated purity comes from the seed`);
    assert.deepEqual(live.specs, seed.specs, `${seed.name}: specs table comes from the seed`);
  }
});

test('the re-tested lots serve the figures their certificate actually reports', () => {
  // Spelled out so a bad seed edit fails here rather than on the shop, where
  // the number sits next to the report that contradicts it.
  const list = products.listProducts();
  const reta = list.find(p => Number(p.id) === 1);
  assert.equal(reta.purity, '99.938%');
  assert.equal(reta.specs['Purity (HPLC)'], '99.938%');
  assert.equal(reta.coa.reportId, 'ATL-38532');
  assert.equal(reta.coa.status, 'available');

  const blend = list.find(p => Number(p.id) === 6);
  assert.equal(blend.coa.reportId, 'ATL-38533');
  assert.match(blend.coa.content, /8\.93 mg/, 'the measured BPC-157 content is carried through');
  assert.match(blend.coa.note, /below the 10mg/, 'and so is the note saying it is under label');
});

test('a certificate block is replaced, not merely filled in when missing', () => {
  const list = products.listProducts();
  for (const p of list.filter(p => Number(p.id) !== 999)) {
    assert.notEqual(p.coa.status, 'pending',
      `${p.name}: a "pending" block must not outlive the report that was published`);
  }
});

test('the specs the store holds are a copy — an edit cannot reach back into the seed', () => {
  const live = products.listProducts().find(p => Number(p.id) === 1);
  const before = seedById(1).specs['Purity (HPLC)'];
  live.specs['Purity (HPLC)'] = 'tampered';
  assert.equal(seedById(1).specs['Purity (HPLC)'], before,
    'the seed every other product syncs against is untouched');
});

test('a product the admin added is left alone', () => {
  const added = products.listProducts().find(p => Number(p.id) === 999);
  assert.equal(added.purity, 'admin purity', 'not in the seed → not the seed\'s business');
  assert.deepEqual(added.specs, { 'Admin Spec': 'entered by hand' });
});

test('the sync runs once — an admin edit made afterwards survives a restart', () => {
  assert.ok(fs.existsSync(SYNC_FILE), 'the applied version is recorded beside the store');

  const list = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  const reta = list.find(p => Number(p.id) === 1);
  reta.purity = '99.9% (admin)';
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(list, null, 2));

  const after = products.listProducts().find(p => Number(p.id) === 1);
  assert.equal(after.purity, '99.9% (admin)', 'the admin value stands; the seed does not claw it back');
});
