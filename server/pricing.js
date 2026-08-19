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
const promotions = require('./promotions.js');

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
 * @param {{ discount?: number, shippingMethod?: string, noPromos?: boolean }} [opts]
 *        `discount` is an order-level discount in DOLLARS (loyalty-points
 *        redemption, and only that). Always clamped here to
 *        [0, subtotal - promoDiscount], so the browser can never push the charge
 *        below zero or redeem against money a promotion already took off.
 *        `shippingMethod` picks WHICH service; its fee always comes from the
 *        rate table, never from the browser.
 *        `noPromos` skips the promotion engine entirely and prices at catalog —
 *        auto-ship invoices use it, so a ten-day sale can't follow a repeating
 *        plan around for its lifetime.
 *
 *        Free shipping is decided on the POST-PROMOTION subtotal — after both
 *        the per-line promo prices and the cart-wide `promoDiscount`, i.e. what
 *        the store actually took. A $110 cart discounted to $88 does not clear a
 *        $100 `freeOver`. The loyalty `discount` is NOT part of that test: points
 *        are the customer spending a reward, not the store lowering its price,
 *        and they only lower the taxable base.
 * @returns {{ items, subtotal, promoDiscount, promos, discount, shipping,
 *             shippingMethod, shippingLabel, tax, total }}
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
      lineTotal: money(unitPrice * quantity),
      /* Carried for the promotion engine only: a bogo can hand out a free unit
         only if there is one on the shelf after the paid units are taken.
         null = untracked, which is unlimited. */
      stockLeft: left
    };
  });

  /* Promotions reprice the lines before anything is summed, so every payment
     path — crypto, Zelle, the balance link, /api/quote — charges the same
     figure without any of them knowing promotions exist. `noPromos` is for
     auto-ship: a repeating plan bills at catalog price, because a ten-day sale
     must not follow a subscriber around for the life of their plan. */
  const promo = opts.noPromos
    ? { items: items.map(i => ({ ...i, paidQuantity: i.quantity, listUnitPrice: i.unitPrice, promoId: '' })),
        promoDiscount: 0, promos: [], freeShipping: false }
    : promotions.apply(items);

  const priced = promo.items.map(({ stockLeft, ...line }) => line);   // stockLeft was input-only
  const subtotal = money(priced.reduce((sum, i) => sum + i.lineTotal, 0));

  /* Two discounts, kept apart on purpose. `promoDiscount` is the shop's own
     cart-wide deal; `discount` is loyalty points and keeps the meaning every
     existing caller already reads. Points can only be spent against what the
     promotion left behind.

     `promoDiscount` is settled BEFORE shipping because the free-shipping
     threshold is tested against it — see below. */
  const promoDiscount = money(Math.max(0, Math.min(promo.promoDiscount, subtotal)));

  /* The browser sends a shipping METHOD, never a fee. The rate table decides
     what that method costs and whether this subtotal clears its free-shipping
     threshold, so a tampered client can at worst pick a cheaper service that
     the store is already offering. An unknown or disabled id resolves to the
     cheapest enabled method rather than failing the checkout.

     The threshold is measured on the POST-promotion subtotal — what the store
     actually took, not what the goods list for. That means BOTH kinds of promo:
     `subtotal` is already at per-line promo prices, and `promoDiscount` (the
     cart-wide deal) comes off before the figure is handed to the rate table.
     Reading the pre-`promoDiscount` subtotal here used to let a 20%-off-cart
     promo carry a $109.99 order over a $100 `freeOver` while the store only
     took $87.99.

     Loyalty points are deliberately NOT subtracted: they are the customer
     spending a reward, not the store discounting the goods.

     A shipping promo zeroes the FEE only — the chosen service is still the
     one the buyer picked, and `shippingMethod`/`shippingLabel` are what the
     order record and the parcel label print, so "Overnight" must not become
     a fabricated "Free shipping" line. */
  const base = resolveShipping(opts.shippingMethod, money(subtotal - promoDiscount));
  const ship = promo.freeShipping ? { ...base, fee: 0 } : base;

  const discount = money(Math.max(0, Math.min(Number(opts.discount) || 0, subtotal - promoDiscount)));
  const taxable = money(subtotal - promoDiscount - discount);
  const tax = money(taxable * TAX_RATE);
  const total = money(taxable + ship.fee + tax);

  return {
    items: priced, subtotal, discount,
    promoDiscount,
    promos: promo.promos,
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
