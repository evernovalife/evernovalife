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

/* Read the catalog. First run (no file yet) seeds from the static
   catalog and writes it, so the built-in products survive as editable rows. */
function load() {
  ensureDir();
  if (!fs.existsSync(PRODUCTS_FILE)) {
    try { save(SEED); } catch (e) { /* fall through to in-memory seed */ }
    return SEED.map(p => ({ ...p }));
  }
  try {
    const arr = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : SEED.map(p => ({ ...p }));
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
