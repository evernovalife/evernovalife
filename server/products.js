/* ============================================================
   EVER NOVA LIFE — product store (admin-managed catalog)
   Products used to live only in the static js/products-data.js.
   This store makes them editable at runtime: on first run it SEEDS
   itself from that static catalog (so the built-in 7 are preserved
   exactly), then persists all adds/edits/deletes to a JSON file on
   the DATA_DIR disk (same durable-storage pattern as auth/orders).

   The server prices checkout from THIS store (see pricing.js), and
   the storefront loads it via GET /api/products — so a product added
   here is immediately shown and sellable.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');

// Static catalog = the seed + the category list the admin form offers.
const seedModule = require('../js/products-data.js');
const SEED = Array.isArray(seedModule.PRODUCTS) ? seedModule.PRODUCTS : [];
const CATEGORIES = Array.isArray(seedModule.CATEGORIES) ? seedModule.CATEGORIES : [];
const CAT_NAME_BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c.name]));

const MAX_IMAGE_CHARS = 8 * 1024 * 1024;   // ~8MB data-URL cap (matches the JSON body limit)

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* Fields added to the static catalog AFTER a server has already written its
   products.json. That file is only ever seeded once, so without this a new
   field (e.g. the `coa` block added in the 2026-08 compliance work) would
   never reach an existing deployment and every product page would claim its
   documentation was pending. Backfill is additive only: a value already in
   the store — including one an admin edited — always wins. */
const BACKFILL_FIELDS = ['coa'];

/* ---- One-time price re-sync from the static catalog ----
   products.json is written ONCE, on a server's first run. That means a price
   changed in js/products-data.js afterwards never reaches a live deployment:
   the storefront and checkout both price from THIS store, so the edit looks
   applied in the repo and does nothing to the shop. (That is exactly how the
   Aug 2026 price change was lost.)

   "Seed always wins" isn't the fix either — an admin editing a price in
   admin-products.html has to keep it. So the seed only wins on demand:
   bump SEED_SYNC_VERSION, and the next deploy re-applies the seed's price and
   originalPrice to the BUILT-IN products exactly once, recording the version
   it applied beside the store. No bump → admin edits are never touched.

   HOW TO CHANGE A PRICE: edit js/products-data.js, bump the number below,
   deploy. (Or just edit it in admin-products.html and leave this alone.) */
const SEED_SYNC_VERSION = 2;   // v2 (2026-08-02): MOTS-C → $100, was-price dropped

/* ---- New products added to the static catalog ----
   Same problem as the price sync, one step worse: products.json is written once,
   so a product ADDED to js/products-data.js afterwards never appears on a live
   deployment at all. Bump this and the next deploy appends the seed products
   whose id isn't in the store yet, exactly once.

   The trade-off matches the price sync: a bump also brings back a built-in an
   admin had deleted. Bumping is the only way to publish a new built-in without
   re-entering it in admin-products.html by hand. */
const SEED_ADD_VERSION = 1;    // v1 (2026-08-05): HGH 36 IU (#9)

/* ---- Certificate-of-analysis re-sync ----
   BACKFILL_FIELDS only fills a field that is MISSING from the store. Every
   built-in already ships a `coa` block, so a report published later — a lot
   moving from Pending to Available — never reaches a live deployment: the store
   keeps its old "pending" block and the product page keeps saying no report
   exists while the repo says otherwise.

   Same on-demand shape as the price sync: bump this and the next deploy
   re-applies the seed's `coa` to the BUILT-IN products exactly once. A bump
   also discards a coa block an admin edited by hand, so bump it only when the
   seed is the truth.

   HOW TO PUBLISH A NEW REPORT: drop the file in assets/coa/, fill the `coa`
   block in js/products-data.js, bump the number below, deploy. */
const COA_SYNC_VERSION = 1;    // v1 (2026-08-09): reports published for #4, #8, #9

const SYNC_FILE = path.join(DATA_DIR, 'products.sync.json');
const SYNCED_FIELDS = ['price', 'originalPrice'];

function readSyncFile() {
  try {
    const o = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8'));
    return (o && typeof o === 'object') ? o : {};
  } catch (e) {
    return {};   // never synced (or unreadable) → treat every version as 0
  }
}
function lastVersion(key) {
  const v = Number(readSyncFile()[key]);
  return Number.isFinite(v) ? v : 0;
}
function lastSyncVersion() { return lastVersion('version'); }
/* Merge, don't overwrite: the price sync and the new-product add each record
   their own key in this one file, and either may run without the other. */
function recordVersions(patch) {
  ensureDir();
  const tmp = SYNC_FILE + '.tmp';
  const next = { ...readSyncFile(), ...patch, appliedAt: new Date().toISOString() };
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, SYNC_FILE);
}
function recordSyncVersion(v) { recordVersions({ version: v }); }

/* Re-apply seed pricing to the built-in products, once per version bump.
   Returns true when something actually changed (so the caller saves). */
function syncPricesFromSeed(list) {
  if (lastSyncVersion() >= SEED_SYNC_VERSION) return false;
  const seedById = new Map(SEED.map(s => [Number(s.id), s]));
  let changed = false;
  for (const item of list) {
    const seed = seedById.get(Number(item.id));
    if (!seed) continue;                       // admin-added product — not ours to touch
    for (const field of SYNCED_FIELDS) {
      const want = seed[field] === undefined ? null : seed[field];
      const have = item[field] === undefined ? null : item[field];
      if (want === have) continue;
      // Loud on purpose: a price moving on its own should be visible in the log.
      console.log(`[products] seed sync v${SEED_SYNC_VERSION} · #${item.id} ${item.name} · ${field}: ${have} → ${want}`);
      item[field] = want;
      changed = true;
    }
  }
  try { recordSyncVersion(SEED_SYNC_VERSION); }
  catch (e) { console.error('[products] could not record the sync version:', e.message); }
  return changed;
}

/* Append seed products the store has never seen, once per version bump.
   Returns true when something was added (so the caller saves). */
function addNewSeedProducts(list) {
  if (lastVersion('addVersion') >= SEED_ADD_VERSION) return false;
  const have = new Set(list.map(p => Number(p.id)));
  let changed = false;
  for (const seed of SEED) {
    if (have.has(Number(seed.id))) continue;
    console.log(`[products] seed add v${SEED_ADD_VERSION} · #${seed.id} ${seed.name}`);
    list.push({ ...seed });
    changed = true;
  }
  try { recordVersions({ addVersion: SEED_ADD_VERSION }); }
  catch (e) { console.error('[products] could not record the add version:', e.message); }
  return changed;
}

/* Re-apply the seed's certificate-of-analysis block to the built-in products,
   once per version bump. Returns true when something changed (so we save). */
function syncCoaFromSeed(list) {
  if (lastVersion('coaVersion') >= COA_SYNC_VERSION) return false;
  const seedById = new Map(SEED.map(s => [Number(s.id), s]));
  let changed = false;
  for (const item of list) {
    const seed = seedById.get(Number(item.id));
    if (!seed || seed.coa === undefined) continue;   // admin-added product — not ours to touch
    const want = JSON.stringify(seed.coa);
    if (JSON.stringify(item.coa === undefined ? null : item.coa) === want) continue;
    const was = (item.coa && item.coa.status) || 'none';
    const now = seed.coa.status || 'none';
    // Loud on purpose: documentation status changing is worth seeing in the log.
    console.log(`[products] coa sync v${COA_SYNC_VERSION} · #${item.id} ${item.name} · ${was} → ${now}`);
    item.coa = JSON.parse(want);
    changed = true;
  }
  try { recordVersions({ coaVersion: COA_SYNC_VERSION }); }
  catch (e) { console.error('[products] could not record the coa version:', e.message); }
  return changed;
}

function backfillFromSeed(list) {
  const seedById = new Map(SEED.map(s => [Number(s.id), s]));
  let changed = false;
  for (const item of list) {
    const seed = seedById.get(Number(item.id));
    if (!seed) continue;
    for (const field of BACKFILL_FIELDS) {
      if (item[field] === undefined && seed[field] !== undefined) {
        item[field] = seed[field];
        changed = true;
      }
    }
  }
  return changed;
}

/* Read the catalog. First run (no file yet) seeds from the static
   catalog and writes it, so the built-in products survive as editable rows. */
function load() {
  ensureDir();
  if (!fs.existsSync(PRODUCTS_FILE)) {
    try { save(SEED); } catch (e) { /* fall through to in-memory seed */ }
    // A store written from the seed IS at the current versions — nothing to re-apply.
    try { recordVersions({ version: SEED_SYNC_VERSION, addVersion: SEED_ADD_VERSION, coaVersion: COA_SYNC_VERSION }); }
    catch (e) { /* re-applying later is harmless */ }
    return SEED.map(p => ({ ...p }));
  }
  try {
    const arr = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    if (!Array.isArray(arr)) return SEED.map(p => ({ ...p }));
    // Persist both fix-ups so they happen once, not on every read.
    const touched = [addNewSeedProducts(arr), backfillFromSeed(arr), syncCoaFromSeed(arr),
                     syncPricesFromSeed(arr)].some(Boolean);
    if (touched) {
      try { save(arr); } catch (e) { console.error('[products] seed fix-ups not saved:', e.message); }
    }
    return arr;
  } catch (e) {
    console.error('[products] store unreadable, using seed:', e.message);
    return SEED.map(p => ({ ...p }));
  }
}
function save(list) {
  ensureDir();
  const tmp = PRODUCTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, PRODUCTS_FILE);   // atomic on the same filesystem
}

const str = (v, max) => String(v == null ? '' : v).slice(0, max || 500);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/* Build a clean product record from admin input. `existing` (on edit)
   supplies fallbacks — notably the image, which is kept when the form
   doesn't send a new one. */
function sanitize(data, existing) {
  data = data || {};
  existing = existing || {};
  const category = str(data.category, 40).trim() || existing.category || '';

  const specs = {};
  const rawSpecs = data.specs && typeof data.specs === 'object' ? data.specs : (existing.specs || {});
  Object.keys(rawSpecs).slice(0, 24).forEach(k => {
    const key = str(k, 60).trim();
    if (key) specs[key] = str(rawSpecs[k], 240);
  });

  const rec = {
    name: str(data.name, 200).trim(),
    category,
    categoryName: CAT_NAME_BY_KEY[category] || str(data.categoryName, 80) || category,
    price: Math.max(0, num(data.price)),
    originalPrice: (data.originalPrice == null || data.originalPrice === '')
      ? (existing.originalPrice != null ? existing.originalPrice : null)
      : Math.max(0, num(data.originalPrice)),
    purity: str(data.purity != null ? data.purity : existing.purity, 80),
    quantity: str(data.quantity != null ? data.quantity : existing.quantity, 80),
    lot: str(data.lot != null ? data.lot : existing.lot, 80),
    description: str(data.description != null ? data.description : existing.description, 5000),
    specs,
    inStock: data.inStock === undefined ? (existing.inStock !== false) : data.inStock !== false,
    badge: (data.badge == null || data.badge === '') ? (existing.badge || null) : str(data.badge, 40),
    featured: data.featured === undefined ? !!existing.featured : !!data.featured
  };

  /* Certificate of analysis. Free-form on purpose (the fields differ between a
     single peptide and a blend), but carried through every edit — losing it
     would silently drop the COA from the product page. */
  const rawCoa = (data.coa && typeof data.coa === 'object') ? data.coa
               : (existing.coa && typeof existing.coa === 'object' ? existing.coa : null);
  if (rawCoa) {
    const coa = {};
    Object.keys(rawCoa).slice(0, 24).forEach(k => {
      const key = str(k, 60).trim();
      if (key) coa[key] = str(rawCoa[k], 500);
    });
    rec.coa = coa;
  }

  // image: use a newly-supplied one, else keep the existing image (if any)
  let image = existing.image;
  if (typeof data.image === 'string' && data.image.trim()) image = data.image.trim();
  if (data.image === null) image = undefined;   // explicit clear
  if (image !== undefined) rec.image = image;

  return rec;
}

function validate(rec) {
  if (!rec.name) return 'A product name is required.';
  if (!(rec.price >= 0)) return 'Price must be a number (0 or more).';
  if (rec.image && rec.image.length > MAX_IMAGE_CHARS) return 'That image is too large. Use a smaller one.';
  return null;
}

/* ---- public API ---- */
function listProducts() { return load(); }

function getProduct(id) {
  const n = Number(id);
  return load().find(p => Number(p.id) === n) || null;
}
// Alias used by pricing.js
const findProductById = getProduct;

function nextId(list) {
  return list.reduce((max, p) => Math.max(max, Number(p.id) || 0), 0) + 1;
}

function addProduct(data) {
  const list = load();
  const rec = sanitize(data, {});
  const err = validate(rec);
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  rec.id = nextId(list);
  list.push(rec);
  save(list);
  return rec;
}

function updateProduct(id, data) {
  const list = load();
  const i = list.findIndex(p => Number(p.id) === Number(id));
  if (i === -1) return null;
  const rec = sanitize(data, list[i]);
  const err = validate(rec);
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  rec.id = Number(id);
  list[i] = rec;
  save(list);
  return rec;
}

function deleteProduct(id) {
  const list = load();
  const i = list.findIndex(p => Number(p.id) === Number(id));
  if (i === -1) return null;
  const [removed] = list.splice(i, 1);
  save(list);
  return removed;
}

module.exports = {
  CATEGORIES,
  listProducts,
  getProduct,
  findProductById,
  addProduct,
  updateProduct,
  deleteProduct
};
