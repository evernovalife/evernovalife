/* ============================================================
   EVER NOVA LIFE — Shopping Cart
   localStorage persistence · badge sync · toast notifications
   Pricing: free shipping over $100, else $9.99 · 8% tax
   ============================================================ */

const CART_KEY = 'evernovalife_cart';
const FREE_SHIP_THRESHOLD = 100;
const SHIP_FLAT = 9.99;
const TAX_RATE = 0.08;

class Cart {
  constructor() {
    this.items = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    this.updateCartCount();
  }

  /* ---- persistence ---- */
  save() {
    localStorage.setItem(CART_KEY, JSON.stringify(this.items));
    this.updateCartCount();
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
   WISHLIST — localStorage list of product ids
   ============================================================ */
const WISHLIST_KEY = 'evernovalife_wishlist';

class Wishlist {
  constructor() {
    this.ids = JSON.parse(localStorage.getItem(WISHLIST_KEY) || '[]').map(Number);
    this.updateBadge();
  }
  save() {
    localStorage.setItem(WISHLIST_KEY, JSON.stringify(this.ids));
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
