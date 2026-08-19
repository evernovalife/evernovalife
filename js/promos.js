/* ============================================================
   EVER NOVA LIFE — promotions, in the browser
   A DISPLAY mirror of server/promotions.js. It decorates the live
   catalog in place — product.price becomes the promo price and
   product.originalPrice keeps the list price — so the existing
   card, detail and cart code shows the deal without knowing
   promotions exist (createProductCard already renders
   `product-price-old` whenever originalPrice is higher).

   Nothing here is trusted by the server. POST /api/quote re-prices
   every checkout from the catalog and the promotion store, and the
   invoice is built from the server's own arithmetic — a stale or
   tampered copy of this file changes what is DISPLAYED, never what
   is charged.
   ============================================================ */
(function (window) {
  'use strict';

  var ACTIVE = [];          // the active promotions, as the server reported them
  var loaded = false;

  var money = function (n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; };

  function apiBase() {
    return window.PEPTIDE_API_BASE || '';
  }

  /** Fetch the running promotions. Resolves to [] on any failure — no deals
      showing is always better than a wrong price on a card. */
  function load() {
    if (typeof fetch === 'undefined') return Promise.resolve([]);
    return fetch(apiBase() + '/api/promotions')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        ACTIVE = (data && Array.isArray(data.promotions)) ? data.promotions : [];
        loaded = true;
        return ACTIVE;
      })
      .catch(function () { ACTIVE = []; loaded = true; return ACTIVE; });
  }

  function list() { return ACTIVE; }
  function isLoaded() { return loaded; }

  function covers(promo, id) {
    var ids = promo.productIds || [];
    return !ids.length || ids.map(Number).indexOf(Number(id)) !== -1;
  }

  /* Mirrors salePrice() in server/promotions.js. Returns null when the deal
     would not actually lower the price. */
  function salePrice(promo, unitPrice) {
    var next;
    if (promo.mode === 'percent') next = unitPrice * (1 - promo.value / 100);
    else if (promo.mode === 'amount') next = unitPrice - promo.value;
    else next = promo.value;
    next = money(Math.max(0, next));
    return next < unitPrice ? next : null;
  }

  /** Free units a bogo would hand out for this quantity, ignoring stock —
      the browser does not know the shelf, and the server caps it anyway. */
  function freeUnitsFor(productId, quantity) {
    var best = 0;
    ACTIVE.forEach(function (p) {
      if (p.type !== 'bogo' || !covers(p, productId)) return;
      var free = Math.floor(quantity / (p.buyQty || 1)) * (p.freeQty || 0);
      if (free > best) best = free;
    });
    return best;
  }

  /* Decorate the catalog in place. `list` is window.PRODUCTS, mutated by
     loadProducts() — the same array getProductById() closes over, so every
     page that renders from it picks the promo price up automatically,
     including cart.syncPrices(). */
  function decorate(products) {
    if (!Array.isArray(products)) return products;

    products.forEach(function (p) {
      /* The pre-promotion selling price, and the catalog's own "was" price.
         originalPrice belongs to whoever merchandised the product, not to us:
         a promotion borrows the field while it runs and hands it back when it
         ends. Discount from the current selling price (p.price), not from the
         was-price — that matches the server, which applies salePrice to the
         catalog price, so the struck figure here matches the invoice's
         listUnitPrice. */
      var priorWas = p.promo ? (p.promo.wasPrice || null) : (p.originalPrice || null);
      var listPrice = money(p.promo ? p.promo.listPrice : p.price);
      var bestSale = null;      // { promo, unit, saving }
      var bestBogo = null;      // { promo, saving }

      ACTIVE.forEach(function (promo) {
        if (!covers(promo, p.id)) return;
        if (promo.type === 'sale') {
          var unit = salePrice(promo, listPrice);
          if (unit === null) return;
          var saving = money(listPrice - unit);
          if (!bestSale || saving > bestSale.saving) bestSale = { promo: promo, unit: unit, saving: saving };
        } else if (promo.type === 'bogo' && promo.freeQty > 0) {
          // Saving on ONE buyQty-sized set, which is what a card can honestly show.
          var per = money((promo.freeQty / promo.buyQty) * listPrice);
          if (!bestBogo || per > bestBogo.saving) bestBogo = { promo: promo, saving: per };
        }
      });

      var winner = null;
      if (bestSale && bestBogo) winner = bestSale.saving >= bestBogo.saving ? bestSale : bestBogo;
      else winner = bestSale || bestBogo;

      if (!winner) {
        // A promotion that ended between two page loads must not leave a
        // struck-through promo price behind — but a merchandising markdown
        // that predates the promotion (the catalog's own originalPrice) is
        // not ours to erase, so hand it back instead of deleting it.
        if (p.promo) {
          p.price = listPrice;
          if (priorWas) p.originalPrice = priorWas; else delete p.originalPrice;
          delete p.promo;
        }
        return;
      }

      p.price = winner.unit !== undefined ? winner.unit : listPrice;
      p.originalPrice = listPrice;
      p.promo = {
        id: winner.promo.id,
        badge: winner.promo.badge || (winner.promo.type === 'bogo' ? 'BUY 1 GET 1' : 'SALE'),
        type: winner.promo.type,
        endsAt: winner.promo.endsAt || null,
        buyQty: winner.promo.buyQty || 1,
        freeQty: winner.promo.freeQty || 0,
        listPrice: listPrice,     // what one unit cost before this promotion
        wasPrice: priorWas        // the catalog's own markdown, handed back on clear
      };
    });

    return products;
  }

  /** The best cart-wide promo for this subtotal, or null. */
  function cartPromo(subtotal) {
    var best = null;
    ACTIVE.forEach(function (p) {
      if (p.type !== 'cart') return;
      if (Number(subtotal) < Number(p.minSubtotal || 0)) return;
      var raw = p.mode === 'percent' ? subtotal * (p.value / 100) : p.value;
      var saving = money(Math.min(Math.max(0, raw), subtotal));
      if (saving > 0 && (!best || saving > best.saving)) best = { name: p.name, saving: saving };
    });
    return best;
  }

  function freeShipping() {
    return ACTIVE.some(function (p) { return p.type === 'shipping'; });
  }

  window.Promos = {
    load: load, list: list, isLoaded: isLoaded, decorate: decorate,
    cartPromo: cartPromo, freeShipping: freeShipping, freeUnitsFor: freeUnitsFor
  };
})(window);
