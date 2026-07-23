/* ============================================================
   EVER NOVA LIFE — server-side pricing (authoritative)
   Mirrors js/cart.js rules, but prices come from the catalog
   (js/products-data.js) — NOT from the browser. This is what
   stops a tampered client from changing what gets charged.
     · free shipping over $100, else $9.99
     · 8% tax
   ============================================================ */
// Price from the admin-managed product store (seeded from the static catalog),
// so products added or edited in the admin are priced correctly at checkout.
const { findProductById: getProductById } = require('./products.js');

const FREE_SHIP_THRESHOLD = 100;
const SHIP_FLAT = 9.99;
const TAX_RATE = 0.08;

const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Build an authoritative order from a client-supplied cart.
 * @param {Array<{id:number|string, quantity:number|string}>} rawItems
 * @param {{ discount?: number }} [opts] optional order-level discount in DOLLARS
 *        (e.g. loyalty-points redemption). Always clamped to [0, subtotal] here,
 *        so the browser can never push the charge below zero or discount more
 *        than was actually purchased. Free-shipping is decided on the pre-discount
 *        subtotal (what was actually bought); the discount lowers the taxable base.
 * @returns {{ items, subtotal, discount, shipping, tax, total }}
 * @throws  {Error} if the cart is empty or contains unknown / invalid items
 */
function buildOrder(rawItems, opts = {}) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('Cart is empty.');
  }

  const items = rawItems.map(raw => {
    const product = getProductById(raw && raw.id);
    if (!product) throw new Error(`Unknown product id: ${raw && raw.id}`);
    if (product.inStock === false) throw new Error(`Out of stock: ${product.name}`);

    const quantity = parseInt(raw.quantity, 10);
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 999) {
      throw new Error(`Invalid quantity for ${product.name}.`);
    }

    const unitPrice = money(product.price);
    return {
      id: product.id,
      name: product.name,
      unitPrice,
      quantity,
      lineTotal: money(unitPrice * quantity)
    };
  });

  const subtotal = money(items.reduce((sum, i) => sum + i.lineTotal, 0));
  const shipping = subtotal >= FREE_SHIP_THRESHOLD ? 0 : SHIP_FLAT;
  // clamp the discount to [0, subtotal] — never trust the caller with a raw value
  const discount = money(Math.max(0, Math.min(Number(opts.discount) || 0, subtotal)));
  const taxable = money(subtotal - discount);
  const tax = money(taxable * TAX_RATE);
  const total = money(taxable + shipping + tax);

  return { items, subtotal, discount, shipping: money(shipping), tax, total };
}

module.exports = { buildOrder, money, FREE_SHIP_THRESHOLD, SHIP_FLAT, TAX_RATE };
