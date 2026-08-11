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

/* ---- Listing-copy re-sync (compliance) ----
   The same write-once problem as the price sync, and the one that matters most:
   a product's name, category and DESCRIPTION are seeded on a server's first run
   and never revisited. So the descriptions were rewritten in js/products-data.js
   during the 2026-07 compliance work, the repo and the static catalog both read
   correctly, and the live API kept serving the pre-2026-07 copy to every visitor
   — including "widely researched for skin remodeling, collagen synthesis and
   tissue regeneration in vitro" on #3, which is exactly the kind of sentence the
   listing is not allowed to make.

   Copy that breaks the rules cannot be left in place because an admin once
   edited that field, so this sync deliberately overwrites: bump the number and
   the next deploy re-applies the seed's name/category/description to every
   BUILT-IN product, once.

   HOW TO CHANGE LISTING COPY: edit js/products-data.js, bump the number below,
   deploy. (Or edit it in admin-products.html and leave this alone.) */
const COPY_SYNC_VERSION = 1;   // v1 (2026-08-10): compliance rewrite + molecular-class categories

/* ---- Retired built-ins ----
   The mirror image of the add sync, and the one that actually matters for a
   delisting: removing a product from js/products-data.js does NOT remove it
   from a live deployment. products.json is written once, so a store that
   already holds the row keeps listing it, pricing it and selling it while the
   repo shows no such product. Put the id here and bump the version, and the
   next deploy deletes it from the store exactly once.

   Ids are never reused — nextId() counts from the highest id in the store, so
   a retired id stays retired even after the row is gone.

   HOW TO RETIRE A PRODUCT: remove it from js/products-data.js, add its id
   below, bump the number, deploy. */
const RETIRED_IDS = [2];       // #2 — reagent SKU delisted 2026-08-11
const RETIRE_VERSION = 1;      // v1 (2026-08-11)

const SYNC_FILE = path.join(DATA_DIR, 'products.sync.json');
const SYNCED_FIELDS = ['price', 'originalPrice'];
const COPY_FIELDS = ['name', 'category', 'categoryName', 'description'];

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

/* Re-apply the seed's listing copy to the built-in products, once per version
   bump. Returns true when something changed (so the caller saves). */
function syncCopyFromSeed(list) {
  if (lastVersion('copyVersion') >= COPY_SYNC_VERSION) return false;
  const seedById = new Map(SEED.map(s => [Number(s.id), s]));
  let changed = false;
  for (const item of list) {
    const seed = seedById.get(Number(item.id));
    if (!seed) continue;                       // admin-added product — not ours to touch
    for (const field of COPY_FIELDS) {
      if (seed[field] === undefined) continue;
      if (item[field] === seed[field]) continue;
      // Loud on purpose: this is the log line that proves the live copy moved.
      console.log(`[products] copy sync v${COPY_SYNC_VERSION} · #${item.id} ${seed.name} · ${field} replaced`);
      item[field] = seed[field];
      changed = true;
    }
  }
  try { recordVersions({ copyVersion: COPY_SYNC_VERSION }); }
  catch (e) { console.error('[products] could not record the copy version:', e.message); }
  return changed;
}

/* Drop retired built-ins from the store, once per version bump.
   Returns true when something was removed (so the caller saves). */
function removeRetiredProducts(list) {
  if (lastVersion('retireVersion') >= RETIRE_VERSION) return false;
  const retired = new Set(RETIRED_IDS.map(Number));
  let changed = false;
  for (let i = list.length - 1; i >= 0; i--) {
    if (!retired.has(Number(list[i].id))) continue;
    // Loud on purpose: a product leaving the shop should be visible in the log.
    console.log(`[products] retire v${RETIRE_VERSION} · #${list[i].id} ${list[i].name} removed`);
    list.splice(i, 1);
    changed = true;
  }
  try { recordVersions({ retireVersion: RETIRE_VERSION }); }
  catch (e) { console.error('[products] could not record the retire version:', e.message); }
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
    try { recordVersions({ version: SEED_SYNC_VERSION, addVersion: SEED_ADD_VERSION, coaVersion: COA_SYNC_VERSION, copyVersion: COPY_SYNC_VERSION, retireVersion: RETIRE_VERSION }); }
    catch (e) { /* re-applying later is harmless */ }
    return SEED.map(p => ({ ...p }));
  }
  try {
    const arr = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    if (!Array.isArray(arr)) return SEED.map(p => ({ ...p }));
    // Persist both fix-ups so they happen once, not on every read.
    const touched = [removeRetiredProducts(arr), addNewSeedProducts(arr), backfillFromSeed(arr),
                     syncCoaFromSeed(arr), syncPricesFromSeed(arr), syncCopyFromSeed(arr)].some(Boolean);
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

/* ---- stock quantity ----
   `stockQty` is OPTIONAL and tri-state on purpose:

     null / undefined → UNTRACKED. Availability is the `inStock` switch alone,
                        which is how every product behaved before counts
                        existed — so nothing changes until a number is entered.
     0                → tracked and sold out.
     n > 0            → tracked, n units left.

   `inStock` stays the master switch: an admin can pull a product with stock
   still on the shelf (a held lot, a documentation problem) and the count is
   left untouched, waiting. Availability needs BOTH. */
const STOCK_MAX = 1000000;

function normalizeStock(v) {
  if (v === null) return null;                     // explicit "stop tracking"
  if (v === undefined || v === '') return undefined;  // "leave as it is"
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(STOCK_MAX, n));
}

/** Units a buyer can actually take right now. null = unlimited (untracked). */
function availableQty(p) {
  if (!p || p.inStock === false) return 0;
  const q = p.stockQty;
  if (q === null || q === undefined) return null;
  const n = Number(q);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

/** Is this product sellable at all? Mirrors availableQty for the boolean case. */
function isAvailable(p) {
  const q = availableQty(p);
  return q === null ? true : q > 0;
}

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
    /* `published` is the shop-window switch, and it is NOT the same as
       `inStock`. A listed-but-unavailable product still has a page, a price
       and a COA a buyer can read while waiting for the next lot. An
       unpublished one is not on the site at all — the right state for a
       listing being drafted, a lot pulled from sale, or a SKU retired.

       Default true, and only an explicit `false` hides: every product that
       existed before this field stays visible. */
    published: data.published === undefined ? (existing.published !== false) : data.published !== false,
    badge: (data.badge == null || data.badge === '') ? (existing.badge || null) : str(data.badge, 40),
    featured: data.featured === undefined ? !!existing.featured : !!data.featured
  };

  /* Stock count. Absent from the payload = keep whatever the store already has
     (so an edit that never touches the field cannot silently wipe a count, and
     an old admin build that doesn't send it stays harmless). */
  const stock = normalizeStock(data.stockQty);
  if (stock !== undefined) rec.stockQty = stock;
  else if (existing.stockQty !== undefined) rec.stockQty = existing.stockQty;

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

/* ---- stock: set, reserve, release ----

   WHEN STOCK MOVES. Not at "paid" — every payment method here confirms later
   (a BTCPay invoice the buyer still has to fund, a Zelle transfer that arrives
   by hand), so counting down only on settlement would let the last vial be
   promised to three people at once. Stock is taken when the order is OPENED
   and handed back if the order dies unpaid. Same shape as the loyalty-points
   hold in server.js — see reserveLoyaltyPoints/refundReservedPoints.

   WHY IT IS SAFE. load() and save() are synchronous fs calls and node runs one
   turn at a time, so the read-check-write below cannot interleave with another
   request. Nothing may `await` between the check and the save. */

/** Set (or clear, with null) the count for one product. Returns the record. */
function setStock(id, qty) {
  const list = load();
  const i = list.findIndex(p => Number(p.id) === Number(id));
  if (i === -1) return null;
  const n = normalizeStock(qty === '' ? null : qty);
  if (n === undefined) { const e = new Error('Enter a whole number, or leave it blank for untracked.'); e.status = 400; throw e; }
  if (n === null) delete list[i].stockQty;
  else list[i].stockQty = n;
  save(list);
  return list[i];
}

/** Is this product on the shop at all? Absent = yes, so nothing predating
 *  the field ever disappears. */
function isPublished(p) { return !p || p.published !== false; }

/** Show or hide one product. Its own writer so the admin list can flip a
 *  product without round-tripping the whole record (and its image data-URL). */
function setPublished(id, value) {
  const list = load();
  const i = list.findIndex(p => Number(p.id) === Number(id));
  if (i === -1) return null;
  list[i].published = value !== false;
  save(list);
  return list[i];
}

/**
 * Take stock for an order, all-or-nothing.
 * @param {Array<{id, quantity}>} items
 * @returns {Array<{id, quantity}>} what was actually decremented (tracked lines
 *          only) — store it on the order so a later release knows what to undo.
 * @throws  {Error} status 409 if any line can't be filled; NOTHING is decremented.
 */
function reserveStock(items) {
  const list = load();
  const wanted = [];

  for (const raw of (items || [])) {
    const i = list.findIndex(p => Number(p.id) === Number(raw.id));
    if (i === -1) { const e = new Error(`Unknown product id: ${raw && raw.id}`); e.status = 400; throw e; }
    const p = list[i];
    const qty = Math.max(1, Math.floor(Number(raw.quantity) || 0));
    const have = availableQty(p);

    if (have === 0) { const e = new Error(`${p.name} is out of stock.`); e.status = 409; throw e; }
    if (have === null) continue;                       // untracked — nothing to take
    if (qty > have) {
      const e = new Error(`Only ${have} left of ${p.name} — please lower the quantity.`);
      e.status = 409;
      throw e;
    }
    wanted.push({ index: i, id: Number(p.id), quantity: qty });
  }

  // every line checked out — now commit them together
  wanted.forEach(w => { list[w.index].stockQty = Math.max(0, Number(list[w.index].stockQty) - w.quantity); });
  if (wanted.length) save(list);
  return wanted.map(w => ({ id: w.id, quantity: w.quantity }));
}

/**
 * Put reserved stock back (an expired invoice, a cancelled order, a checkout
 * that threw after reserving). Only touches products still tracked: if an admin
 * switched one to untracked in the meantime, there is no count to credit.
 * @param {Array<{id, quantity}>} reserved
 */
function releaseStock(reserved) {
  if (!Array.isArray(reserved) || !reserved.length) return 0;
  const list = load();
  let changed = 0;
  for (const r of reserved) {
    const p = list.find(x => Number(x.id) === Number(r.id));
    if (!p || p.stockQty === undefined || p.stockQty === null) continue;
    const back = Math.max(0, Math.floor(Number(r.quantity) || 0));
    if (!back) continue;
    p.stockQty = Math.min(STOCK_MAX, Number(p.stockQty) + back);
    changed++;
  }
  if (changed) save(list);
  return changed;
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
  deleteProduct,
  // visibility
  isPublished,
  setPublished,
  // stock
  availableQty,
  isAvailable,
  setStock,
  reserveStock,
  releaseStock
};
