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
    },

    /* Loyalty points balance + ledger + conversion rates, or null. */
    async loyalty() {
      const token = this.getToken();
      if (!token) return null;
      try {
        const res = await fetch(API_BASE + '/api/loyalty', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) return null;
        return await res.json().catch(() => null);
      } catch (e) { return null; }
    },

    /* Referral code, invite link + stats, or null. */
    async referral() {
      const token = this.getToken();
      if (!token) return null;
      try {
        const res = await fetch(API_BASE + '/api/referral', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) return null;
        return await res.json().catch(() => null);
      } catch (e) { return null; }
    },

    /* ---- auto-ship (repeating orders) ---- */

    /* This account's plans, or null when we can't reach the server. Note the
       difference from [] — "no plans" and "couldn't ask" render differently. */
    async subscriptions() {
      const token = this.getToken();
      if (!token) return null;
      try {
        const res = await fetch(API_BASE + '/api/subscriptions', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) return null;
        return await res.json().catch(() => null);
      } catch (e) { return null; }
    },

    /* Change a plan (frequency, pause/resume, skip the next shipment, items).
       Throws with the server's message so the UI can show exactly what went
       wrong — these actions change what a customer gets charged, so a silent
       failure is not acceptable. */
    async updateSubscription(id, patch) {
      const token = this.getToken();
      if (!token) throw new Error('Please sign in again.');
      const res = await fetch(API_BASE + '/api/subscriptions/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(patch || {})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'That change could not be saved.');
      return data.subscription;
    },

    /* Cancel a plan for good. */
    async cancelSubscription(id) {
      const token = this.getToken();
      if (!token) throw new Error('Please sign in again.');
      const res = await fetch(API_BASE + '/api/subscriptions/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'That plan could not be cancelled.');
      return data.subscription;
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
      processing: 'Processing', shipped: 'Shipped', delivered: 'Delivered',
      awaiting_payment: 'Awaiting payment',   // Zelle: placed, money not in yet
      underpaid: 'Payment short' };           // crypto: some money in, not all
    const label = known[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Processing');
    const cls = known[s] ? s.replace(/_/g, '-') : 'processing';
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
    /* Every status a sale can be in AFTER the money landed — an order that has
       shipped is still money they spent, and dropping it once it left the
       warehouse would make this total shrink over time. */
    const PAID_STATES = ['paid', 'shipped', 'delivered'];
    const spent = orders
      .filter(o => PAID_STATES.includes(String(o.status).toLowerCase()))
      .reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    setNum('statSpent', money(spent));

    if (!box) return;
    if (!orders.length) {
      box.innerHTML = `<p class="text-muted">No orders yet. When you check out while signed in, your orders show up here. <a href="products.html" style="color:var(--accent-purple)">Start shopping →</a></p>`;
      return;
    }
    box.innerHTML = orders.slice(0, 10).map(o => {
      const b = statusBadge(o.status);
      // The tracking number is the whole reason someone opens this page after
      // ordering, so it sits on the row rather than in an email they may have
      // lost.
      const track = [o.carrier, o.tracking].filter(Boolean).join(' · ');
      /* An order that came up short is the one row here with something left to
         do on it. The server sends the link only for orders that can actually
         be topped up, so its presence IS the condition — the page never has to
         work out whether a balance is collectable. */
      const owe = o.payUrl && o.amountDue > 0
        ? `<div><a class="btn btn-primary btn-sm" href="${esc(o.payUrl)}">Pay the remaining ${esc(money(o.amountDue))}</a></div>`
        : '';
      return `<div class="order-row">
        <div><strong>${esc(o.orderId)}</strong> <span class="text-muted">${esc(orderDate(o.createdAt))}</span></div>
        <div class="text-muted">${esc(orderItemsSummary(o.items))}${track ? `<br><span class="text-muted">Tracking: ${esc(track)}</span>` : ''}</div>
        <div>${esc(money(o.total))}</div>
        <span class="order-status ${b.cls}">${esc(b.label)}</span>
        ${owe}
      </div>`;
    }).join('');
  }

  /* Short, human label for a loyalty ledger reason + its sign. */
  function ledgerRow(e) {
    const sign = e.delta > 0 ? '+' : '';
    const cls = e.delta > 0 ? 'earn' : 'redeem';
    return `<div class="ledger-row">
      <div><span class="ledger-reason">${esc(e.reason || (e.delta > 0 ? 'Points earned' : 'Points redeemed'))}</span>
        <span class="text-muted"> · ${esc(orderDate(e.ts))}</span></div>
      <div class="ledger-delta ${cls}">${sign}${Number(e.delta) || 0}</div>
    </div>`;
  }

  /* Fill the Reward Points card (balance, cash value, recent history) and the
     Points stat tile. Silently leaves defaults if the API is unreachable. */
  async function renderAccountRewards() {
    const data = await Auth.loyalty();
    if (!data) return;
    const bal = Number(data.balance) || 0;
    const setNum = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setNum('statPoints', bal);
    setNum('loyaltyBalance', bal);
    const val = document.getElementById('loyaltyValue');
    if (val) val.textContent = bal > 0 ? ` · worth ${money(data.dollarValue)}` : '';

    const per = Number(data.perDollar) || 1;
    const blurb = document.getElementById('loyaltyBlurb');
    if (blurb) blurb.textContent =
      `Earn ${per === 1 ? '1 point' : per + ' points'} for every $1 spent, and redeem points for money off at checkout.`;

    const ledgerBox = document.getElementById('loyaltyLedger');
    if (ledgerBox) {
      const ledger = Array.isArray(data.ledger) ? data.ledger : [];
      ledgerBox.innerHTML = ledger.length
        ? ledger.slice(0, 8).map(ledgerRow).join('')
        : `<p class="text-muted">No points activity yet. Your first order will start your balance.</p>`;
    }
  }

  /* Fill the Refer a Friend card (code, copy-link button, stats). */
  async function renderReferral() {
    const data = await Auth.referral();
    if (!data) return;
    const codeInput = document.getElementById('referralCode');
    if (codeInput) codeInput.value = data.code || '';

    const blurb = document.getElementById('referralBlurb');
    if (blurb && data.rewardPoints) {
      blurb.textContent = `Share your code — when a friend places their first order, you both earn ${data.rewardPoints} reward points.`;
    }

    const stats = document.getElementById('referralStats');
    if (stats) {
      const n = Number(data.referredCount) || 0;
      stats.textContent = n
        ? `${n} friend${n === 1 ? '' : 's'} joined with your code · ${Number(data.rewardedCount) || 0} completed a first order.`
        : 'No referrals yet — share your link to get started.';
    }

    const btn = document.getElementById('copyReferralBtn');
    if (btn && !btn._wired) {
      btn._wired = true;
      btn.addEventListener('click', async () => {
        const link = data.link || (location.origin + '/register.html?ref=' + (data.code || ''));
        let ok = false;
        try { await navigator.clipboard.writeText(link); ok = true; }
        catch (e) {
          // fallback: select the code field so the user can copy manually
          if (codeInput) { codeInput.focus(); codeInput.select(); }
        }
        const label = btn.textContent;
        btn.textContent = ok ? '✓ Copied!' : 'Press Ctrl+C';
        setTimeout(() => { btn.textContent = label; }, 1600);
      });
    }
  }

  /* ============================================================
     AUTO-SHIP CARD — the customer's own controls over repeating
     orders. Every action here changes what they get billed for, so
     each one confirms out loud and re-reads the plan from the
     server rather than guessing at the new state.
     ============================================================ */

  function everyPhrase(days) {
    const n = Number(days) || 0;
    return n === 1 ? 'every day' : `every ${n} days`;
  }

  /* "March 14, 2026" — the shipment date, spelled out so there's no ambiguity
     about day/month order for international customers. */
  function longDate(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function subscriptionCard(s) {
    const status = String(s.status || 'active').toLowerCase();
    const itemsTotal = (s.items || []).reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);
    const rows = (s.items || []).map(i =>
      `<li><span>${esc(i.name)}</span><span class="qty">× ${esc(i.quantity)}</span></li>`).join('');

    const headline = status === 'active'
      ? `Next shipment ${esc(longDate(s.nextRunAt))}`
      : (status === 'paused' ? 'Paused — nothing scheduled' : 'Cancelled');

    const failed = Number(s.failCount) || 0;
    const alert = failed > 0
      ? `<p class="sub-alert">We couldn't prepare your last shipment${s.lastError ? ` (${esc(s.lastError)})` : ''}.
         ${status === 'paused'
           ? 'The plan is paused — nothing was billed. Resume it here when you\'re ready.'
           : 'We\'ll try again automatically.'}</p>`
      : '';

    const controls = status === 'cancelled' ? '' : `
      <div class="sub-every">
        <label for="every-${esc(s.id)}">Repeat every</label>
        <input type="number" id="every-${esc(s.id)}" class="sub-days" value="${esc(s.intervalDays)}" min="7" max="180" step="1" inputmode="numeric">
        <span>days</span>
        <button type="button" class="btn btn-ghost btn-sm" data-action="interval" data-id="${esc(s.id)}">Save</button>
      </div>
      <div class="sub-actions">
        ${status === 'active'
          ? `<button type="button" class="btn btn-ghost" data-action="skip" data-id="${esc(s.id)}">Skip next shipment</button>
             <button type="button" class="btn btn-ghost" data-action="pause" data-id="${esc(s.id)}">Pause</button>`
          : `<button type="button" class="btn btn-primary" data-action="resume" data-id="${esc(s.id)}">Resume</button>`}
        <button type="button" class="btn btn-ghost" data-action="cancel" data-id="${esc(s.id)}">Cancel plan</button>
      </div>`;

    return `<div class="sub-item is-${esc(status)}" data-sub="${esc(s.id)}">
      <div class="sub-item-head">
        <span class="sub-next">${headline}</span>
        <span class="sub-status ${esc(status)}">${esc(status.charAt(0).toUpperCase() + status.slice(1))}</span>
      </div>
      <p class="sub-meta">${esc(everyPhrase(s.intervalDays))} · ${esc(s.paymentLabel || 'Bitcoin / Lightning invoice')}${
        s.runCount ? ` · ${s.runCount} shipment${s.runCount === 1 ? '' : 's'} sent` : ''} · ${esc(s.id)}</p>
      <ul class="sub-items">${rows}</ul>
      <p class="sub-meta">≈ ${esc(money(itemsTotal))} in products per shipment, plus shipping and tax at the rates in effect on the day.</p>
      ${alert}
      ${controls}
    </div>`;
  }

  /* Fill the Auto-Ship card and wire its buttons (delegated, so a re-render
     never stacks handlers). */
  async function renderAutoship() {
    const box = document.getElementById('autoshipList');
    if (!box) return;
    const data = await Auth.subscriptions();

    if (!data) {
      box.innerHTML = `<p class="text-muted">We couldn't load your auto-ship plans right now. Please refresh the page.</p>`;
      return;
    }

    const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
    // Cancelled plans are history — keep them out of the way unless they're all there is.
    const live = subs.filter(s => s.status !== 'cancelled');
    const show = live.length ? live : subs;

    if (!show.length) {
      box.innerHTML = `<p class="text-muted">No auto-ship plans yet. Tick <strong>“Auto-ship this order”</strong> at checkout and we'll reorder the same items on the schedule you choose. <a href="products.html" style="color:var(--accent-purple)">Browse products →</a></p>`;
      return;
    }

    box.innerHTML = `<div class="sub-list">${show.map(subscriptionCard).join('')}</div>`;

    if (!box._wired) {
      box._wired = true;
      box.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (btn) onAutoshipAction(btn);
      });
    }
  }

  async function onAutoshipAction(btn) {
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    const msg = document.getElementById('autoshipMsg');
    if (!id || !action) return;

    // Cancelling stops a service the customer is relying on — always ask first.
    if (action === 'cancel' &&
        !window.confirm('Cancel this auto-ship plan? Nothing more will ship and you won\'t be invoiced again. This can\'t be undone — you\'d need to start a new plan.')) {
      return;
    }

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    setMsg(msg, '', '');

    try {
      let done = '';
      if (action === 'cancel') {
        await Auth.cancelSubscription(id);
        done = 'Auto-ship cancelled. You won\'t be invoiced again.';
      } else if (action === 'skip') {
        const s = await Auth.updateSubscription(id, { skipNext: true });
        done = `Skipped. Your next shipment is now ${longDate(s.nextRunAt)}.`;
      } else if (action === 'pause') {
        await Auth.updateSubscription(id, { status: 'paused' });
        done = 'Paused. Nothing will ship or be invoiced until you resume.';
      } else if (action === 'resume') {
        const s = await Auth.updateSubscription(id, { status: 'active' });
        done = `Resumed. Your next shipment is ${longDate(s.nextRunAt)}.`;
      } else if (action === 'interval') {
        const input = document.getElementById('every-' + id);
        const days = input ? Number(input.value) : NaN;
        if (!Number.isFinite(days) || days < 7 || days > 180) {
          throw new Error('Choose between 7 and 180 days.');
        }
        const s = await Auth.updateSubscription(id, { intervalDays: days });
        done = `Updated — now shipping ${everyPhrase(s.intervalDays)}.`;
      }
      setMsg(msg, '✅ ' + done, 'success');
      await renderAutoship();       // re-read from the server; never assume
    } catch (err) {
      setMsg(msg, err.message || 'That change could not be saved.', 'error');
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* Where to land after signing in / registering. Pages that need an account
     (checkout) send the user here with ?next=checkout.html. Only a bare
     same-site page name is honoured — never an absolute or protocol-relative
     URL, so this can't be used to bounce someone off-site. */
  function nextTarget(fallback) {
    const raw = (new URLSearchParams(location.search).get('next') || '').trim();
    return /^[a-z0-9_-]+\.html(\?[^#]*)?(#.*)?$/i.test(raw) ? raw : fallback;
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
        location.href = nextTarget('account.html');
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

    // Referral: capture ?ref=CODE from the invite link. We keep it and hand it
    // to the register API; if it matches a real account the new user (and their
    // referrer) earn bonus points on the first order.
    const refCode = (new URLSearchParams(location.search).get('ref') || '').trim();
    const refNote = document.getElementById('refNote');
    if (refCode && refNote) {
      refNote.textContent = `🎁 You were invited! You'll both earn bonus reward points once you place your first order.`;
      refNote.style.display = '';
    }

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
        await Auth.register({ firstName, lastName, email, password, ref: refCode || undefined });
        setMsg(msg, '🎉 Account created! Redirecting…', 'success');
        location.href = nextTarget('account.html');
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
    // loyalty points + referral + auto-ship cards (independent — each no-ops if offline)
    renderAccountRewards();
    renderReferral();
    renderAutoship();

    // admin accounts: reveal the Admin section of the nav (Manage Users + Products)
    if (user.isAdmin) {
      const adminGroup = document.getElementById('adminNavGroup');
      if (adminGroup) adminGroup.style.display = '';
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
    syncHeaderAccount();
  });
})();
