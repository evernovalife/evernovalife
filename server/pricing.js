/* ============================================================
   EVER NOVA LIFE — server-side pricing (authoritative)
   Mirrors js/cart.js rules, but prices come from the catalog
   (js/products-data.js) — NOT from the browser. This is what
   stops a tampered client from changing what gets charged.
     · shipping from the admin-managed rate table (shipping.js);
       the browser sends only WHICH method, never its price
     · 8% tax
   ============================================================ */
// Price from the admin-managed product store (seeded from the static catalog),
// so products added or edited in the admin are priced correctly at checkout.
const { findProductById: getProductById, availableQty, isPublished } = require('./products.js');
const shippingRates = require('./shipping.js');

/* Kept as the last-resort figures only. The live rate comes from shipping.js,
   which seeds itself with these; they exist so a shipping store that cannot be
   read at all still charges postage rather than shipping for free. */
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
    /* Hidden means "not on the shop", so it cannot be bought either — a cart
       saved before the product was pulled must not walk it through checkout. */
    if (!isPublished(product)) throw new Error(`No longer available: ${product.name}`);
    if (product.inStock === false) throw new Error(`Out of stock: ${product.name}`);

    const quantity = parseInt(raw.quantity, 10);
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 999) {
      throw new Error(`Invalid quantity for ${product.name}.`);
    }

    /* Where the product carries a stock COUNT, the line can't exceed it. This
       is the friendly early rejection — products.reserveStock re-checks and is
       the one that actually decides, since only it can check and take in the
       same turn. */
    const left = availableQty(product);
    if (left === 0) throw new Error(`Out of stock: ${product.name}`);
    if (left !== null && quantity > left) {
      throw new Error(`Only ${left} left of ${product.name} — please lower the quantity.`);
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

  /* The browser sends a shipping METHOD, never a fee. The rate table decides
     what that method costs and whether this subtotal clears its free-shipping
     threshold, so a tampered client can at worst pick a cheaper service that
     the store is already offering. An unknown or disabled id resolves to the
     cheapest enabled method rather than failing the checkout. */
  const ship = resolveShipping(opts.shippingMethod, subtotal);

  // clamp the discount to [0, subtotal] — never trust the caller with a raw value
  const discount = money(Math.max(0, Math.min(Number(opts.discount) || 0, subtotal)));
  const taxable = money(subtotal - discount);
  const tax = money(taxable * TAX_RATE);
  const total = money(taxable + ship.fee + tax);

  return {
    items, subtotal, discount,
    shipping: money(ship.fee),
    // Carried through so the invoice, the order record and the packing queue
    // all say which service was bought — "shipping $19.99" alone doesn't.
    shippingMethod: ship.id,
    shippingLabel: ship.label,
    tax, total
  };
}

/* Ask the rate table; fall back to the compiled-in flat rate only if the store
   has nothing to offer, so a broken shipping.json overcharges nobody and
   undercharges nobody either. */
function resolveShipping(methodId, subtotal) {
  try {
    const { method, fee } = shippingRates.quote(methodId, subtotal);
    if (method) {
      return { id: method.id, label: method.name, fee: money(fee) };
    }
  } catch (e) {
    console.error('[pricing] shipping rates unreadable, using the flat fallback:', e.message);
  }
  return {
    id: 'standard',
    label: 'Standard',
    fee: subtotal >= FREE_SHIP_THRESHOLD ? 0 : SHIP_FLAT
  };
}

module.exports = { buildOrder, money, FREE_SHIP_THRESHOLD, SHIP_FLAT, TAX_RATE };
