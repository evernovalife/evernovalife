/* ============================================================
   EVER NOVA LIFE — Shopping Cart
   localStorage persistence · badge sync · toast notifications
   Pricing: free shipping over $100, else $9.99 · 8% tax
   ============================================================ */

const CART_KEY = 'evernovalife_cart';
const WISHLIST_KEY = 'evernovalife_wishlist';
const FREE_SHIP_THRESHOLD = 100;
const SHIP_FLAT = 9.99;
const TAX_RATE = 0.08;

/* ------------------------------------------------------------
   Per-account storage scope
   The cart/wishlist must belong to the signed-in user, not the
   browser — otherwise the next person to sign in on this device
   sees the previous user's items. We derive a stable suffix from
   the user auth.js caches under 'enl_user' (no dependency on the
   Auth object, which isn't loaded on every page). Guests share a
   single 'guest' bucket. Keys are computed on every read/write so
   they always follow whoever is currently signed in.
   ------------------------------------------------------------ */
function currentScope() {
  try {
    const u = JSON.parse(localStorage.getItem('enl_user') || 'null');
    if (u && (u.id || u.email)) return 'u_' + (u.id || u.email);
  } catch (e) { /* storage disabled / bad JSON */ }
  return 'guest';
}
function cartKey() { return CART_KEY + '::' + currentScope(); }
function wishlistKey() { return WISHLIST_KEY + '::' + currentScope(); }

/* One-time cleanup: older builds stored a single un-scoped cart/wishlist
   shared by every user. Remove those legacy keys so their stale contents
   can never leak into a freshly signed-in account. */
(function dropLegacyKeys() {
  try {
    localStorage.removeItem(CART_KEY);
    localStorage.removeItem(WISHLIST_KEY);
  } catch (e) { /* ignore */ }
})();

/* ------------------------------------------------------------
   Server sync (signed-in users)
   The cart also lives on the account server-side, so it follows a
   user across devices/browsers. localStorage stays the instant,
   offline-friendly cache; the server is the source of truth once it
   answers. We read the login token + API base the same way the rest
   of the site does (plain globals set earlier by config.js/auth.js),
   with no hard dependency on script load order.
   ------------------------------------------------------------ */
function authToken() {
  try { return localStorage.getItem('enl_token') || ''; } catch (e) { return ''; }
}
function apiBase() {
  return (typeof window !== 'undefined' && window.PEPTIDE_API_BASE) || '';
}

/* Combine two item lists by product id. mode 'sum' adds quantities (used
   once when absorbing a pre-login guest cart into the account); mode 'max'
   keeps the larger quantity (idempotent — safe to re-run on every sync). */
function mergeItems(base, extra, mode) {
  const out = base.map(i => ({ ...i }));
  (extra || []).forEach(e => {
    const hit = out.find(i => i.id === e.id);
    if (!hit) out.push({ ...e });
    else if (mode === 'sum') hit.quantity += e.quantity;
    else hit.quantity = Math.max(hit.quantity, e.quantity);
  });
  return out;
}

class Cart {
  constructor() {
    this.items = JSON.parse(localStorage.getItem(cartKey()) || '[]');
    this.updateCartCount();
    this._syncFromServer();   // signed in → reconcile with the account cart
  }

  /* ---- persistence ---- */
  save() {
    localStorage.setItem(cartKey(), JSON.stringify(this.items));
    this.updateCartCount();
    this._pushToServer();     // signed in → mirror the change to the account
  }

  /* Push the current cart to the account (debounced, fire-and-forget).
     Guests keep to localStorage only. */
  _pushToServer() {
    const token = authToken();
    if (!token || typeof fetch === 'undefined') return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => {
      fetch(apiBase() + '/api/cart', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ items: this.items })
      }).catch(() => { /* offline → localStorage still holds it; next change retries */ });
    }, 450);
  }

  /* Reconcile the local cart with the account cart on the server: pull the
     server cart, fold in anything added before signing in (the guest bucket)
     plus any offline local additions, push the result back if it changed,
     then repaint the page. */
  async _syncFromServer() {
    const token = authToken();
    if (!token || typeof fetch === 'undefined') return;

    // Items added while signed out, waiting to be absorbed into the account.
    let guest = [];
    try { guest = JSON.parse(localStorage.getItem(CART_KEY + '::guest') || '[]'); } catch (e) {}

    let server;
    try {
      const res = await fetch(apiBase() + '/api/cart', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return;                     // 401/500/offline → keep local cache
      const data = await res.json().catch(() => ({}));
      server = Array.isArray(data.items) ? data.items : [];
    } catch (e) {
      return;                                  // network error → keep the local cache
    }

    // server is authoritative; add guest items once (summed), keep local-only
    // additions (max — idempotent so repeated syncs don't inflate quantities).
    let merged = server;
    if (guest.length) merged = mergeItems(merged, guest, 'sum');
    merged = mergeItems(merged, this.items, 'max');

    // Guest items are now absorbed — empty that bucket so they can't merge twice.
    if (guest.length) { try { localStorage.removeItem(CART_KEY + '::guest'); } catch (e) {} }

    const changedServer = JSON.stringify(merged) !== JSON.stringify(server);
    this.items = merged;
    localStorage.setItem(cartKey(), JSON.stringify(this.items));   // refresh cache
    this.updateCartCount();
    if (changedServer) this._pushToServer();

    // let the page (cart / checkout) repaint with the reconciled cart
    try { window.dispatchEvent(new Event('cart:updated')); } catch (e) {}
  }

  /* ---- mutations ---- */
  addItem(product, quantity = 1) {
    const existing = this.items.find(i => i.id === product.id);
    if (existing) {
      existing.quantity += quantity;
    } else {
      this.items.push({
        id: product.id,
        name: product.name,
        price: product.price,
        category: product.categoryName || product.category,
        quantity: quantity
      });
    }
    this.save();
    this.showNotification(`${product.name} added to cart`);
  }

  removeItem(productId) {
    this.items = this.items.filter(i => i.id !== Number(productId));
    this.save();
  }

  updateQuantity(productId, quantity) {
    const item = this.items.find(i => i.id === Number(productId));
    if (!item) return;
    item.quantity = Math.max(1, parseInt(quantity, 10) || 1);
    this.save();
  }

  clearCart() {
    this.items = [];
    this.save();
  }

  /* ---- queries ---- */
  getItemCount() {
    return this.items.reduce((sum, i) => sum + i.quantity, 0);
  }

  getSubtotal() {
    return this.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  }

  getShipping() {
    if (this.items.length === 0) return 0;
    return this.getSubtotal() >= FREE_SHIP_THRESHOLD ? 0 : SHIP_FLAT;
  }

  getTax() {
    return this.getSubtotal() * TAX_RATE;
  }

  getTotal() {
    return this.getSubtotal() + this.getShipping() + this.getTax();
  }

  /* ---- UI sync ---- */
  updateCartCount() {
    const count = this.getItemCount();
    document.querySelectorAll('.cart-badge').forEach(badge => {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    });
  }

  showNotification(msg) {
    // Build (or reuse) a single toast element
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      toast.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span class="toast-msg"></span>';
      document.body.appendChild(toast);
    }
    toast.querySelector('.toast-msg').textContent = msg;
    // restart animation
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }
}

/* ============================================================
   WISHLIST — per-account localStorage list of product ids
   ============================================================ */
class Wishlist {
  constructor() {
    this.ids = JSON.parse(localStorage.getItem(wishlistKey()) || '[]').map(Number);
    this.updateBadge();
  }
  save() {
    localStorage.setItem(wishlistKey(), JSON.stringify(this.ids));
    this.updateBadge();
  }
  has(id) { return this.ids.includes(Number(id)); }
  add(id) { id = Number(id); if (!this.has(id)) { this.ids.push(id); this.save(); } }
  remove(id) { this.ids = this.ids.filter(x => x !== Number(id)); this.save(); }
  toggle(id) { this.has(id) ? this.remove(id) : this.add(id); return this.has(id); }
  count() { return this.ids.length; }
  updateBadge() {
    const n = this.count();
    document.querySelectorAll('.wishlist-badge').forEach(b => {
      b.textContent = n;
      b.style.display = n > 0 ? 'flex' : 'none';
    });
  }
}

/* Global singletons */
const cart = new Cart();
const wishlist = new Wishlist();
if (typeof window !== 'undefined') { window.cart = cart; window.wishlist = wishlist; }
