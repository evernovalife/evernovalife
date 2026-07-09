/* ============================================================
   EVER NOVA LIFE — client authentication (email + password)
   · Talks to the Node API at /api/auth/*
   · Stores the login token + user in localStorage
   · Wires the login / register / account pages
   · Keeps the header account icon pointing to the right place
   Set window.PEPTIDE_API_BASE if the site and API are on
   different origins (same pattern as checkout in main.js).
   ============================================================ */
(function () {
  const API_BASE = (typeof window !== 'undefined' && window.PEPTIDE_API_BASE) || '';
  const TOKEN_KEY = 'enl_token';
  const USER_KEY = 'enl_user';

  const Auth = {
    getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } },
    getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; } },
    isLoggedIn() { return !!this.getToken(); },

    _save(token, user) {
      try {
        if (token) localStorage.setItem(TOKEN_KEY, token);
        if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
      } catch (e) { /* private mode / storage disabled */ }
    },

    logout() {
      try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch (e) {}
    },

    async _post(path, body) {
      const url = (API_BASE || '') + path;
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch (netErr) {
        throw new Error('Can\'t reach the server' + (API_BASE ? ' at ' + API_BASE : '') +
          '. Make sure the backend (Node app) is running.');
      }
      // Read the body once, as text, so we can handle JSON *and* stray HTML/error pages.
      const raw = await res.text().catch(() => '');
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch (e) { data = null; } // null = not JSON

      if (!res.ok) {
        if (data && data.error) throw new Error(data.error);
        // Non-JSON error response → the API endpoint isn't answering correctly.
        // Surface the status so it's diagnosable (404 = endpoint/route not found,
        // 503 = app not started, 500 = server crash, 405 = wrong method, etc.).
        throw new Error('The sign-in service isn\'t responding correctly (HTTP ' + res.status +
          ' from ' + url + '). The backend Node app may not be running or reachable there.');
      }
      if (!data) throw new Error('The server sent an unexpected response. Is the backend running?');
      return data;
    },

    async register(payload) {
      const data = await this._post('/api/auth/register', payload);
      this._save(data.token, data.user);
      return data;
    },

    async login(payload) {
      const data = await this._post('/api/auth/login', payload);
      this._save(data.token, data.user);
      return data;
    },

    /* Confirm the stored token is still valid and refresh the cached user.
       Returns the user, or null if not signed in / token rejected. */
    async fetchMe() {
      const token = this.getToken();
      if (!token) return null;
      let res;
      try {
        res = await fetch(API_BASE + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
      } catch (e) {
        return this.getUser();   // offline → trust the cached copy
      }
      if (res.status === 401) { this.logout(); return null; }
      const data = await res.json().catch(() => ({}));
      if (data.user) this._save(null, data.user);
      return data.user || null;
    },

    // password reset
    forgot(email) { return this._post('/api/auth/forgot', { email }); },
    reset(token, password) { return this._post('/api/auth/reset', { token, password }); },

    /* This account's orders (newest first). Empty array if signed out,
       offline, or the token was rejected. */
    async orders() {
      const token = this.getToken();
      if (!token) return [];
      try {
        const res = await fetch(API_BASE + '/api/orders', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) return [];
        const data = await res.json().catch(() => ({}));
        return Array.isArray(data.orders) ? data.orders : [];
      } catch (e) { return []; }
    }
  };
  window.Auth = Auth;

  /* ---------- small helpers ---------- */
  function setMsg(el, text, kind) {
    if (!el) return;
    el.className = 'form-msg' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function initials(first, last) {
    return ((first || '').charAt(0) + (last || '').charAt(0)).toUpperCase() || '👤';
  }
  function money(n) { return '$' + (Number(n) || 0).toFixed(2); }
  function orderDate(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
  }
  /* map a stored order status to a badge class + label */
  function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    const known = { paid: 'Paid', pending: 'Pending', cancelled: 'Cancelled',
      processing: 'Processing', shipped: 'Shipped', delivered: 'Delivered' };
    const label = known[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Processing');
    const cls = known[s] ? s : 'processing';
    return { cls, label };
  }
  function orderItemsSummary(items) {
    if (!Array.isArray(items) || !items.length) return '—';
    const parts = items.map(i => `${i.name} ×${i.quantity}`);
    const shown = parts.slice(0, 3).join(', ');
    return parts.length > 3 ? `${shown} +${parts.length - 3} more` : shown;
  }

  /* Fill the account page's Recent Orders card + stat tiles with the
     signed-in user's real orders from the server. */
  async function renderAccountOrders() {
    const box = document.getElementById('recentOrders');
    const orders = await Auth.orders();

    // stat tiles
    const setNum = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setNum('statOrders', orders.length);
    // wishlist count comes from the cart.js Wishlist singleton (loaded first)
    if (window.wishlist && typeof window.wishlist.count === 'function') {
      setNum('statWishlist', window.wishlist.count());
    }
    const spent = orders
      .filter(o => String(o.status).toLowerCase() === 'paid')
      .reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    setNum('statSpent', money(spent));

    if (!box) return;
    if (!orders.length) {
      box.innerHTML = `<p class="text-muted">No orders yet. When you check out while signed in, your orders show up here. <a href="products.html" style="color:var(--accent-purple)">Start shopping →</a></p>`;
      return;
    }
    box.innerHTML = orders.slice(0, 10).map(o => {
      const b = statusBadge(o.status);
      return `<div class="order-row">
        <div><strong>${esc(o.orderId)}</strong> <span class="text-muted">${esc(orderDate(o.createdAt))}</span></div>
        <div class="text-muted">${esc(orderItemsSummary(o.items))}</div>
        <div>${esc(money(o.total))}</div>
        <span class="order-status ${b.cls}">${esc(b.label)}</span>
      </div>`;
    }).join('');
  }

  /* ============================================================
     LOGIN PAGE
     ============================================================ */
  function initLoginPage() {
    const form = document.getElementById('loginForm');
    if (!form) return;
    const msg = form.querySelector('.form-msg');
    const btn = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (form.elements.email.value || '').trim();
      const password = form.elements.password.value || '';
      setMsg(msg, '', '');
      if (!email || !password) { setMsg(msg, 'Please enter your email and password.', 'error'); return; }

      const label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        await Auth.login({ email, password });
        setMsg(msg, '✅ Signed in! Redirecting…', 'success');
        location.href = 'account.html';
      } catch (err) {
        setMsg(msg, err.message, 'error');
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  /* ============================================================
     REGISTER PAGE
     ============================================================ */
  function initRegisterPage() {
    const form = document.getElementById('registerForm');
    if (!form) return;
    const msg = form.querySelector('.form-msg');
    const btn = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const firstName = (form.elements.firstName.value || '').trim();
      const lastName = (form.elements.lastName.value || '').trim();
      const email = (form.elements.email.value || '').trim();
      const password = form.elements.password.value || '';
      const confirm = form.elements.confirmPassword.value || '';
      const agree = form.elements.agree && form.elements.agree.checked;
      setMsg(msg, '', '');

      if (!firstName || !lastName || !email || !password) {
        setMsg(msg, 'Please complete all the fields.', 'error'); return;
      }
      if (password.length < 8) { setMsg(msg, 'Password must be at least 8 characters.', 'error'); return; }
      if (password !== confirm) { setMsg(msg, 'Those passwords don\'t match.', 'error'); return; }
      if (!agree) { setMsg(msg, 'Please agree to the Terms & Privacy Policy.', 'error'); return; }

      const label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Creating account…';
      try {
        await Auth.register({ firstName, lastName, email, password });
        setMsg(msg, '🎉 Account created! Redirecting…', 'success');
        location.href = 'account.html';
      } catch (err) {
        setMsg(msg, err.message, 'error');
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  /* ============================================================
     ACCOUNT PAGE — gate + hydrate with the real user
     ============================================================ */
  async function initAccountPage() {
    if (!document.querySelector('.account-layout')) return;

    // gate: not signed in → go to login (remember where we wanted to be)
    if (!Auth.isLoggedIn()) { location.replace('login.html'); return; }
    const user = await Auth.fetchMe();
    if (!user) { location.replace('login.html'); return; }

    const fullName = ((user.firstName || '') + ' ' + (user.lastName || '')).trim();
    const year = (user.createdAt && new Date(user.createdAt).getFullYear()) || new Date().getFullYear();

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

    set('acctAvatar', initials(user.firstName, user.lastName));
    set('acctGreeting', `Welcome back, ${user.firstName || 'there'} 👋`);
    const sub = document.getElementById('acctSubtitle');
    if (sub) sub.innerHTML = `${esc(user.email)} · Member since ${year}`;
    setVal('acctName', fullName);
    setVal('acctEmail', user.email || '');

    // real orders + stat tiles from the server
    renderAccountOrders();

    // admin accounts get a link to the user-management page
    if (user.isAdmin) {
      const nav = document.querySelector('.account-nav');
      const signOut = document.getElementById('signOutBtn');
      if (nav && !document.getElementById('adminNavLink')) {
        const a = document.createElement('a');
        a.id = 'adminNavLink';
        a.href = 'admin.html';
        a.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V5l-8-3Z"/><path d="M9 12l2 2 4-4"/></svg><span>Admin</span>';
        nav.insertBefore(a, signOut || null);
      }
    }

    // wire Sign Out
    const signOut = document.getElementById('signOutBtn');
    if (signOut) {
      signOut.addEventListener('click', (e) => {
        e.preventDefault();
        Auth.logout();
        location.href = 'login.html';
      });
    }
  }

  /* ============================================================
     FORGOT PASSWORD PAGE — request a reset link
     ============================================================ */
  function initForgotPage() {
    const form = document.getElementById('forgotForm');
    if (!form) return;
    const msg = form.querySelector('.form-msg');
    const btn = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (form.elements.email.value || '').trim();
      setMsg(msg, '', '');
      if (!email) { setMsg(msg, 'Please enter your email.', 'error'); return; }

      const label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const data = await Auth.forgot(email);
        setMsg(msg, (data && data.message) || 'If that email has an account, a reset link is on its way.', 'success');
        form.reset();
      } catch (err) {
        setMsg(msg, err.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  /* ============================================================
     RESET PASSWORD PAGE — set a new password using the emailed token
     ============================================================ */
  function initResetPage() {
    const form = document.getElementById('resetForm');
    if (!form) return;
    const msg = form.querySelector('.form-msg');
    const btn = form.querySelector('button[type="submit"]');
    const token = new URLSearchParams(location.search).get('token') || '';

    if (!token) {
      setMsg(msg, 'This reset link is missing its token. Please use the link from your email, or request a new one.', 'error');
      if (btn) btn.disabled = true;
      return;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = form.elements.password.value || '';
      const confirm = form.elements.confirmPassword.value || '';
      setMsg(msg, '', '');
      if (password.length < 8) { setMsg(msg, 'Password must be at least 8 characters.', 'error'); return; }
      if (password !== confirm) { setMsg(msg, 'Those passwords don\'t match.', 'error'); return; }

      const label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await Auth.reset(token, password);
        setMsg(msg, '✅ Password reset! Redirecting to sign in…', 'success');
        setTimeout(() => { location.href = 'login.html'; }, 1200);
      } catch (err) {
        setMsg(msg, err.message, 'error');
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  /* ============================================================
     GOOGLE buttons — not wired to a provider yet. Rather than a
     dead button, point people to email sign-in for now.
     ============================================================ */
  function wireGoogleButtons() {
    document.querySelectorAll('.oauth-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.auth-card') || document;
        const msg = card.querySelector('.form-msg');
        setMsg(msg, 'Google sign-in isn\'t set up yet — please use your email below.', 'error');
        const email = card.querySelector('input[type="email"]');
        if (email) email.focus();
      });
    });
  }

  /* ============================================================
     HEADER — if signed out, the account icon should lead to login
     ============================================================ */
  function syncHeaderAccount() {
    const icon = document.querySelector('.header-actions a[href="account.html"]');
    if (icon && !Auth.isLoggedIn()) icon.setAttribute('href', 'login.html');
  }

  /* ---------- boot ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    const page = (location.pathname.split('/').pop() || '').toLowerCase();
    if (page === 'login.html') initLoginPage();
    else if (page === 'register.html') initRegisterPage();
    else if (page === 'account.html') initAccountPage();
    else if (page === 'forgot-password.html') initForgotPage();
    else if (page === 'reset-password.html') initResetPage();
    wireGoogleButtons();
    syncHeaderAccount();
  });
})();
