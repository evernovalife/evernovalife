/* ============================================================
   EVER NOVA LIFE — shipping-label design (admin-managed)

   The label the owner sticks on the parcel. Everything on it that
   is ABOUT THE ORDER — who it goes to, the reference, the service
   bought — comes from the order record itself, so a label is never
   typed out by hand and can never disagree with what was sold.
   What is stored here is the part that is the same on every label:
   the size of the stock in the printer, the return address, and
   which blocks are printed at all.

   This is a PACKING/routing label, not postage. It carries no
   carrier indicia and buys nothing — the postage still comes from
   USPS/UPS/FedEx. Its barcode is the order reference, for picking
   and for matching a parcel back to an order.

   Same durable-storage pattern as shipping.js and products.js:
     DATA_DIR/label-design.json

   Admin-only in both directions. The return address is a real
   physical address and the store deliberately does not publish one
   (see terms.html §12 and the payment review), so it is never sent
   to a public route.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'label-design.json');

/* Label stock the owner can actually buy. Dimensions in millimetres because
   that is what CSS @page wants; the inch names are what the box says. */
const SIZES = {
  '4x6': { label: '4 × 6 in (thermal)', widthMm: 101.6, heightMm: 152.4 },
  '4x4': { label: '4 × 4 in', widthMm: 101.6, heightMm: 101.6 },
  '3x4': { label: '3 × 4 in', widthMm: 76.2, heightMm: 101.6 },
  'a6': { label: 'A6 (105 × 148 mm)', widthMm: 105, heightMm: 148 },
  'half': { label: 'Half US Letter (8.5 × 5.5 in)', widthMm: 215.9, heightMm: 139.7 },
  'custom': { label: 'Custom', widthMm: 101.6, heightMm: 152.4 }
};

/* The out-of-the-box label: 4×6 thermal, every block on, no return address
   yet — that is the one thing only the owner can supply, and the console says
   so until it is filled in. */
const SEED = {
  size: '4x6',
  widthMm: 101.6,
  heightMm: 152.4,
  paddingMm: 5,
  fontScale: 1,
  border: true,
  showLogo: true,
  showFrom: true,
  showBarcode: true,
  showItems: true,
  showService: true,
  showDate: true,
  showEmail: false,          // a parcel travels through many hands
  showResearchNote: true,
  barcodeSource: 'orderId',
  from: {
    name: 'Ever Nova Life',
    line1: '',
    line2: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'USA',
    phone: ''
  },
  handling: '',
  researchNote: 'For in-vitro research use only. Not for human or veterinary use.',
  footer: ''
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(FILE)) return clone(SEED);
  try {
    return normalise(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    console.error('[label-design] store unreadable, using the default label:', e.message);
    return clone(SEED);
  }
}

function persist(design) {
  ensureDir();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(design, null, 2));
  fs.renameSync(tmp, FILE);          // atomic on the same filesystem
}

const clone = o => JSON.parse(JSON.stringify(o));
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 80);
const bool = (v, dflt) => (v == null ? dflt : v !== false && v !== 'false' && v !== 0);
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100));
};

/* A stored design made safe to print from. The size drives the physical
   dimensions unless it is 'custom', so a preset can never be saved next to
   dimensions that contradict it — the printer would silently crop instead. */
function normalise(input) {
  const d = { ...SEED, ...(input && typeof input === 'object' ? input : {}) };
  const size = SIZES[d.size] ? d.size : '4x6';
  const preset = SIZES[size];

  const widthMm = size === 'custom' ? clamp(d.widthMm, 40, 305, 101.6) : preset.widthMm;
  const heightMm = size === 'custom' ? clamp(d.heightMm, 40, 305, 152.4) : preset.heightMm;

  const from = { ...SEED.from, ...(d.from && typeof d.from === 'object' ? d.from : {}) };

  return {
    size,
    widthMm,
    heightMm,
    // A padding bigger than a quarter of the label leaves nowhere to print.
    paddingMm: clamp(d.paddingMm, 0, Math.min(20, widthMm / 4), 5),
    fontScale: clamp(d.fontScale, 0.7, 1.6, 1),
    border: bool(d.border, true),
    showLogo: bool(d.showLogo, true),
    showFrom: bool(d.showFrom, true),
    showBarcode: bool(d.showBarcode, true),
    showItems: bool(d.showItems, true),
    showService: bool(d.showService, true),
    showDate: bool(d.showDate, true),
    showEmail: bool(d.showEmail, false),
    showResearchNote: bool(d.showResearchNote, true),
    barcodeSource: d.barcodeSource === 'tracking' ? 'tracking' : 'orderId',
    from: {
      name: str(from.name, 60),
      line1: str(from.line1, 80),
      line2: str(from.line2, 80),
      city: str(from.city, 60),
      state: str(from.state, 30),
      postalCode: str(from.postalCode, 20),
      country: str(from.country, 40),
      phone: str(from.phone, 30)
    },
    handling: str(d.handling, 60),
    researchNote: str(d.researchNote, 200),
    footer: str(d.footer, 120)
  };
}

/** The current label design. */
function get() {
  return load();
}

/** Replace the design. Partial bodies are merged onto what is stored. */
function save(input) {
  const merged = normalise({ ...load(), ...(input && typeof input === 'object' ? input : {}) });
  persist(merged);
  return merged;
}

/** Back to the shipped default, return address included. */
function reset() {
  const seed = clone(SEED);
  persist(seed);
  return seed;
}

module.exports = { get, save, reset, SIZES, SEED };
