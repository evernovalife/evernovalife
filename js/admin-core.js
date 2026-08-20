/* ============================================================
   EVER NOVA LIFE — Admin console runtime
   Shared by admin.html (dashboard / orders / auto-ship / customers)
   and admin-products.html (catalog).

   Everything here used to be copy-pasted into each admin page: the
   escaping, the money formatter, the header builder, the admin-key
   fallback. Two copies of an auth header is one copy too many, so this
   file is the single place that knows how to talk to the API as an admin.

   Loaded as a plain script (no modules — these pages are static files on
   shared hosting), so it publishes one global: `Admin`.
   ============================================================ */
(function (window, document) {
  'use strict';

  var API = (window.PEPTIDE_API_BASE || '');
  var KEY_STORE = 'enl_admin_key';

  /* ---- identity ----
     Two ways in, in priority order:
       1. a signed-in admin account (Bearer token) — the normal path;
       2. an ADMIN_KEY typed into the fallback box — for a fresh machine,
          or when the admin account itself is what's broken.
     `key` is remembered so a reload doesn't ask again. */
  var key = '';
  try { key = window.localStorage.getItem(KEY_STORE) || ''; } catch (e) { key = ''; }

  function token() {
    try { return window.localStorage.getItem('enl_token') || ''; } catch (e) { return ''; }
  }
  function currentUser() {
    try { return JSON.parse(window.localStorage.getItem('enl_user') || 'null'); } catch (e) { return null; }
  }
  function setKey(k) {
    key = k || '';
    try { k ? window.localStorage.setItem(KEY_STORE, k) : window.localStorage.removeItem(KEY_STORE); } catch (e) {}
  }
  function headers(extra) {
    var h = extra || {};
    var t = token();
    if (t) h['Authorization'] = 'Bearer ' + t;
    if (key) h['x-admin-key'] = key;
    return h;
  }
  /* Is there anything to authenticate WITH? Not "are we authorised" — only
     the server decides that. This just avoids firing six requests that are
     all going to 401 on a signed-out browser. */
  function hasCredentials() { return !!(token() || key); }

  /* ---- fetch ----
     One wrapper so every call fails the same way. A network error and a
     401 read very differently to the person at the keyboard, so they are
     separated here rather than collapsed into "something went wrong". */
  function ApiError(message, status, data) {
    this.name = 'ApiError';
    this.message = message;
    this.status = status || 0;
    this.data = data || {};
  }
  ApiError.prototype = Object.create(Error.prototype);

  async function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: headers(opts.headers ? Object.assign({}, opts.headers) : {}) };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    var res;
    try {
      res = await window.fetch(API + path, init);
    } catch (e) {
      throw new ApiError("Can't reach the server. If the backend sleeps on idle, give it a moment and retry.", 0);
    }
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(data.error || 'Not authorised. Sign in with the admin account, or use an admin key.', res.status, data);
    }
    if (!res.ok) throw new ApiError(data.error || 'That request failed.', res.status, data);
    return data;
  }

  /* ---- formatting ---- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    var v = Number(n) || 0;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  /* Compact money for a KPI tile — $12.4k reads at a glance where
     $12,431.90 does not, and the exact figure is one hover away. */
  function moneyShort(n) {
    var v = Number(n) || 0;
    if (Math.abs(v) >= 1000000) return '$' + (v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1) + 'M';
    if (Math.abs(v) >= 10000) return '$' + (v / 1000).toFixed(1) + 'k';
    return money(v);
  }
  function num(n) { return (Number(n) || 0).toLocaleString('en-US'); }
  function date(iso, withTime) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d)) return String(iso);
      return withTime
        ? d.toLocaleString('en-US', { month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' })
        : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
    } catch (e) { return String(iso); }
  }
  /* "3 days ago" for a list where the exact minute doesn't matter. */
  function ago(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 2592000) return Math.round(s / 86400) + 'd ago';
    return date(iso);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* ---- icons ----
     Same policy as the storefront: line-art SVG, never emoji. Emoji render
     as a different picture on every OS and read as a consumer app. */
  var ICONS = {
    dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM13 7h8V3h-8zM3 21h8v-4H3z"/>',
    orders: '<path d="M6 2 4 6v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6l-2-4z"/><path d="M4 6h16"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3.5-6 7-6s7 2 7 6"/><path d="M17 4a4 4 0 0 1 0 8"/><path d="M21 21c0-3-1.5-4.8-4-5.6"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
    truck: '<path d="M3 17V6h11v11"/><path d="M14 9h4l3 3v5h-7"/><circle cx="7" cy="18.5" r="1.8"/><circle cx="17" cy="18.5" r="1.8"/>',
    tag: '<path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    percent: '<path d="M19 5 5 19"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    download: '<path d="M12 3v12"/><path d="m7 12 5 5 5-5"/><path d="M4 21h16"/>',
    up: '<path d="m5 15 7-7 7 7"/>',
    down: '<path d="m5 9 7 7 7-7"/>',
    alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    play: '<path d="m6 3 14 9-14 9z"/>',
    home: '<path d="M3 12l9-9 9 9"/><path d="M9 21V12h6v9"/>',
    print: '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>',
    bitcoin: '<path d="M8 6h6a3 3 0 0 1 0 6H8z"/><path d="M8 12h7a3 3 0 0 1 0 6H8z"/><path d="M8 6v12"/><path d="M11 3v3"/><path d="M11 18v3"/><path d="M14.5 3v3"/><path d="M14.5 18v3"/>',
    external: '<path d="M14 3h7v7"/><path d="M21 3 10 14"/><path d="M20 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>'
  };
  function icon(name, cls) {
    var body = ICONS[name];
    if (!body) return '';
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  /* ---- toasts ---- */
  var toastHost = null;
  function toast(message, kind, ms) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'adm-toasts';
      document.body.appendChild(toastHost);
    }
    var el = document.createElement('div');
    el.className = 'adm-toast' + (kind ? ' ' + kind : '');
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.textContent = message;
    toastHost.appendChild(el);
    window.setTimeout(function () {
      el.style.opacity = '0';
      window.setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    }, ms || (kind === 'error' ? 6500 : 3800));
    return el;
  }

  /* ---- small DOM helpers ---- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function on(root, selector, event, fn) {
    root.addEventListener(event, function (e) {
      var t = e.target.closest ? e.target.closest(selector) : null;
      if (t && root.contains(t)) fn.call(t, e, t);
    });
  }
  function skeleton(rows) {
    var s = '<div class="adm-skeleton">';
    for (var i = 0; i < (rows || 3); i++) s += '<i style="width:' + (100 - i * 12) + '%"></i>';
    return s + '</div>';
  }
  function empty(title, body) {
    return '<div class="adm-empty"><strong>' + esc(title) + '</strong>' + (body ? esc(body) : '') + '</div>';
  }

  /* ---- CSV ----
     Sales questions that a dashboard can't answer (per-state totals, a
     quarter's figures for an accountant) all end in a spreadsheet, so
     every table that matters can hand one over. */
  function toCsv(rows) {
    return rows.map(function (r) {
      return r.map(function (cell) {
        var s = String(cell == null ? '' : cell);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
  }
  function downloadCsv(filename, rows) {
    // BOM so Excel opens UTF-8 without mangling the product names.
    var blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---- shell ----
     The rail and the top bar are identical on every admin page, so they are
     built here from one nav definition. `active` is the page's own key. */
  var NAV = [
    { key: 'dashboard', href: 'admin.html#dashboard', label: 'Dashboard', icon: 'dashboard' },
    { key: 'orders', href: 'admin.html#orders', label: 'Orders', icon: 'orders', tally: 'navUnpaid' },
    { key: 'ship', href: 'admin.html#ship', label: 'To ship', icon: 'box', tally: 'navShip' },
    { key: 'rates', href: 'admin.html#rates', label: 'Shipping rates', icon: 'truck' },
    { key: 'promos', href: 'admin.html#promos', label: 'Promotions', icon: 'percent' },
    { key: 'labeldesign', href: 'admin.html#labeldesign', label: 'Label designer', icon: 'tag' },
    { key: 'btcpay', href: 'admin.html#btcpay', label: 'BTCPay', icon: 'bitcoin', tally: 'navBtcpay' },
    { key: 'autoship', href: 'admin.html#autoship', label: 'Auto-Ship', icon: 'repeat' },
    { key: 'disputes', href: 'admin.html#disputes', label: 'Disputes', icon: 'chat', tally: 'navDisputes' },
    { key: 'customers', href: 'admin.html#customers', label: 'Customers', icon: 'users' },
    { key: 'products', href: 'admin-products.html', label: 'Products', icon: 'box' },
    { key: 'labels', href: 'labels.html', label: 'Vial labels', icon: 'print' }
  ];

  var BRAND_MARK = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<defs><linearGradient id="admStar" gradientUnits="userSpaceOnUse" x1="50" y1="2" x2="50" y2="98">' +
    '<stop offset="0%" stop-color="#c4b5fd"/><stop offset="50%" stop-color="#a78bfa"/><stop offset="100%" stop-color="#8b5cf6"/>' +
    '</linearGradient></defs>' +
    '<path d="M50 50 L50 0 L54.97 37.99 Z" fill="url(#admStar)"/><path d="M50 50 L100 50 L62.01 54.97 Z" fill="url(#admStar)"/>' +
    '<path d="M50 50 L50 100 L45.03 62.01 Z" fill="url(#admStar)"/><path d="M50 50 L0 50 L37.99 45.03 Z" fill="url(#admStar)"/>' +
    '<circle cx="50" cy="50" r="6" fill="url(#admStar)"/><circle cx="50" cy="50" r="2.6" fill="#f5f3ff"/></svg>';

  function renderShell(mount, opts) {
    opts = opts || {};
    var active = opts.active || '';
    var links = NAV.map(function (n) {
      var isActive = n.key === active;
      return '<a href="' + n.href + '"' + (isActive ? ' class="active" aria-current="page"' : '') + '>' +
        icon(n.icon) + '<span>' + esc(n.label) + '</span>' +
        (n.tally ? '<em class="tally" id="' + n.tally + '"></em>' : '') + '</a>';
    }).join('');

    mount.innerHTML =
      '<aside class="adm-side">' +
        '<a class="adm-brand" href="index.html">' + BRAND_MARK +
          '<span class="brand-lines"><b>Ever Nova Life</b><span>Admin</span></span>' +
        '</a>' +
        '<div class="adm-nav-label">Manage</div>' +
        '<nav class="adm-nav" aria-label="Admin sections">' + links + '</nav>' +
        '<div class="adm-side-foot"><a href="index.html">← Back to the store</a></div>' +
      '</aside>' +
      '<div class="adm-main">' +
        '<div class="adm-bar">' +
          '<div><h1 id="admTitle">' + esc(opts.title || '') + '</h1>' +
          '<div class="sub" id="admSubtitle">' + esc(opts.subtitle || '') + '</div></div>' +
          '<div class="adm-bar-right" id="admBarRight"></div>' +
        '</div>' +
        '<main class="adm-body" id="admBody"></main>' +
      '</div>';

    // The brand block needs its two lines stacked; done here so the CSS
    // file doesn't need a rule for a wrapper that only exists in JS.
    var lines = mount.querySelector('.brand-lines');
    if (lines) lines.setAttribute('style', 'display:block');

    document.body.classList.add('adm');
    return {
      body: mount.querySelector('#admBody'),
      barRight: mount.querySelector('#admBarRight'),
      title: mount.querySelector('#admTitle'),
      subtitle: mount.querySelector('#admSubtitle')
    };
  }

  /* Who am I, as a chip for the top bar. */
  function whoChip() {
    var u = currentUser();
    if (u && u.email) return '<span class="adm-who"><i></i>' + esc(u.email) + '</span>';
    if (key) return '<span class="adm-who"><i></i>admin key</span>';
    return '<span class="adm-who off"><i></i>signed out</span>';
  }

  /* The signed-out / not-an-admin panel. Every admin page shows the same
     one, including the key fallback, so there is exactly one place that
     explains how to get in. */
  function gateHtml(message) {
    var u = currentUser();
    var lead = message || (u
      ? 'You are signed in as ' + esc(u.email) + ', which is not an admin account.'
      : 'Sign in with the admin account to open the console.');
    return '<div class="adm-gate"><div class="adm-card">' +
      '<h3>Admin sign-in required</h3>' +
      '<p class="adm-note" style="margin-top:.6rem">' + lead + '</p>' +
      '<a class="btn btn-primary btn-sm" href="login.html">Sign in</a>' +
      '<form id="admKeyForm" style="margin-top:1.25rem">' +
        '<label class="kpi-label" for="admKeyInput" style="display:block;margin-bottom:.35rem">or use an admin key</label>' +
        '<div style="display:flex;gap:.5rem;flex-wrap:wrap">' +
          '<input type="password" id="admKeyInput" autocomplete="off" placeholder="Paste your admin key" style="flex:1;min-width:200px">' +
          '<button class="btn btn-ghost btn-sm" type="submit">Use key</button>' +
        '</div>' +
      '</form></div></div>';
  }

  /* Wire the gate's key form. `onOk` runs after a key is accepted. */
  function bindGate(root, onOk) {
    var form = root.querySelector('#admKeyForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = form.querySelector('#admKeyInput');
      var k = (input.value || '').trim();
      if (!k) { toast('Enter your admin key.', 'error'); return; }
      setKey(k);
      onOk();
    });
    var input = form.querySelector('#admKeyInput');
    if (input && key) input.value = key;
  }

  window.Admin = {
    API: API,
    api: api,
    ApiError: ApiError,
    headers: headers,
    token: token,
    currentUser: currentUser,
    setKey: setKey,
    getKey: function () { return key; },
    hasCredentials: hasCredentials,
    esc: esc, money: money, moneyShort: moneyShort, num: num,
    date: date, ago: ago, plural: plural,
    icon: icon, toast: toast,
    $: $, $$: $$, on: on,
    skeleton: skeleton, empty: empty,
    downloadCsv: downloadCsv,
    renderShell: renderShell, whoChip: whoChip, gateHtml: gateHtml, bindGate: bindGate
  };
})(window, document);
