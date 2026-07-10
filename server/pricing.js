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
 * @returns {{ items, subtotal, shipping, tax, total }}
 * @throws  {Error} if the cart is empty or contains unknown / invalid items
 */
function buildOrder(rawItems) {
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
  const tax = money(subtotal * TAX_RATE);
  const total = money(subtotal + shipping + tax);

  return { items, subtotal, shipping: money(shipping), tax, total };
}

module.exports = { buildOrder, money, FREE_SHIP_THRESHOLD, SHIP_FLAT, TAX_RATE };
