/* ============================================================
   EVER NOVA LIFE — what is waiting for the owner
   The admin console's rail tallies only help someone already inside
   it. The owner browsing their own storefront — the likeliest place
   to be — had no way to learn a customer was waiting, which is how a
   real dispute sat unseen. This asks once per sign-in and says so.

   Two surfaces, deliberately:
     · a dialog, once per sign-in, dismissed and gone — loud enough to
       be seen, rare enough not to be clicked away unread;
     · a count on the header's Admin button, which stays.

   Silent when nothing is waiting. An "all clear" pop-up would train
   the eye to dismiss this one without reading it, which is exactly
   the failure it exists to prevent.

   Loads on every storefront page after main.js, which builds the header
   this badges. It does NOT depend on js/auth.js — that file is only on the
   account and sign-in pages, and the owner is usually somewhere else.
   ============================================================ */
(function (window, document) {
  'use strict';

  var API = (window.PEPTIDE_API_BASE || '');
  /* Held in sessionStorage and cleared on sign-out, so "once per sign-in"
     holds both across browser sessions and within one tab. */
  var SEEN_KEY = 'enl_admin_alert_seen';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  /* Read the session straight out of localStorage rather than through Auth.
     js/auth.js is only loaded on the account and sign-in pages — most of the
     storefront does not have it, and those are exactly the pages the owner is
     browsing when this needs to fire. main.js reads the same two keys the same
     way for the header it builds. */
  function token() {
    try { return window.localStorage.getItem('enl_token') || ''; } catch (e) { return ''; }
  }
  function currentUser() {
    try { return JSON.parse(window.localStorage.getItem('enl_user') || 'null'); } catch (e) { return null; }
  }

  function admin() {
    if (!token()) return null;
    var u = currentUser();
    return (u && u.isAdmin) ? u : null;
  }

  async function fetchSummary() {
    var t = token();
    if (!t) return null;
    try {
      var res = await fetch(API + '/api/admin/summary', {
        headers: { Authorization: 'Bearer ' + t }
      });
      if (!res.ok) return null;      // stale token, older server — stay quiet
      return await res.json();
    } catch (e) {
      return null;                   // offline: never block the storefront
    }
  }

  /* ---- the badge on the header's Admin button ---- */
  function paintBadge(total) {
    var btn = document.querySelector('.header-admin-btn');
    if (!btn) return false;
    var badge = btn.querySelector('.admin-badge');
    if (!total) { if (badge) badge.remove(); return true; }
    if (!badge) {
      badge = document.createElement('em');
      badge.className = 'admin-badge';
      btn.appendChild(badge);
    }
    badge.textContent = String(total);
    badge.setAttribute('aria-label', plural(total, 'item') + ' waiting');
    return true;
  }

  /* main.js builds the header, and may finish after us if it is waiting on
     its own /api/auth/me refresh. Retry a few times rather than racing it. */
  function paintBadgeWhenReady(total, tries) {
    if (paintBadge(total) || (tries || 0) > 6) return;
    window.setTimeout(function () { paintBadgeWhenReady(total, (tries || 0) + 1); }, 350);
  }

  /* ---- the dialog ---- */
  var ICON = {
    disputes: '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
    orders: '<path d="M6 2 4 6v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6l-2-4z"/><path d="M4 6h16"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
    alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[name] + '</svg>';
  }

  function rowsFor(s) {
    var rows = [];
    if (s.disputes) {
      rows.push({ icon: 'disputes', href: 'admin.html#disputes',
        text: plural(s.disputes, 'customer') + ' waiting on a reply' });
    }
    if (s.unpaidOrders) {
      rows.push({ icon: 'orders', href: 'admin.html#orders',
        text: plural(s.unpaidOrders, 'order') + ' waiting on payment' });
    }
    if (s.toShip) {
      rows.push({ icon: 'box', href: 'admin.html#ship',
        text: plural(s.toShip, 'parcel') + ' to pack' });
    }
    if (s.lowStock) {
      rows.push({ icon: 'alert', href: 'admin-products.html',
        text: plural(s.lowStock, 'product') + ' low or out of stock' });
    }
    /* Storage only speaks up once it matters, at the same percentage that
       sends the warning email — the threshold comes from the server so the
       pop-up can never disagree with the inbox. */
    if (s.storageAlertPct && s.storagePct >= s.storageAlertPct) {
      rows.push({ icon: 'alert', href: 'admin.html#disputes',
        text: 'Dispute photo storage is ' + s.storagePct + '% full' });
    }
    return rows;
  }

  var restoreFocus = null;

  function close() {
    var box = document.querySelector('.adminalert');
    if (!box) return;
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('adminalert-open');
    box.remove();
    if (restoreFocus && restoreFocus.focus) { try { restoreFocus.focus(); } catch (e) {} }
  }

  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    /* aria-modal tells assistive tech the rest of the page is inert but does
       nothing to the tab order — without this, tabbing off the last control
       lands behind the backdrop on a page you cannot see. */
    var box = document.querySelector('.adminalert');
    if (!box) return;
    var f = Array.prototype.slice.call(box.querySelectorAll('a[href], button:not([disabled])'));
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function open(rows) {
    restoreFocus = document.activeElement;
    var box = document.createElement('div');
    box.className = 'adminalert';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'What is waiting for you');
    box.innerHTML =
      '<div class="adminalert-panel">' +
        '<h2>Waiting for you</h2>' +
        '<ul class="adminalert-list">' +
          rows.map(function (r) {
            return '<li><a href="' + esc(r.href) + '">' + icon(r.icon) +
              '<span>' + esc(r.text) + '</span></a></li>';
          }).join('') +
        '</ul>' +
        '<button type="button" class="btn btn-ghost adminalert-dismiss">Not now</button>' +
      '</div>';

    box.addEventListener('click', function (e) {
      // Backdrop click closes; a click inside the panel must not.
      if (e.target === box) close();
      if (e.target.closest && e.target.closest('.adminalert-dismiss')) close();
    });

    document.body.appendChild(box);
    document.body.classList.add('adminalert-open');
    document.addEventListener('keydown', onKey);
    var firstLink = box.querySelector('a[href]');
    if (firstLink) firstLink.focus();
  }

  /* ---- a reply arriving while the owner is already here ----
     The dialog above is a sign-in summary: it answers "what did I walk into?"
     once and then gets out of the way. It says nothing about a customer who
     replies twenty minutes later, which is the case that actually needs
     catching — so the count is watched, and a RISE raises a toast.

     A rise, not a non-zero total: re-announcing the same backlog every minute
     would train the eye to ignore this within an hour. */
  var POLL_MS = 60000;
  var lastWaiting = null;
  var timer = null;

  function replyToast(added) {
    if (document.querySelector('.reply-toast')) return;      // one at a time
    var el = document.createElement('div');
    el.className = 'reply-toast';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<a href="admin.html#disputes">' +
        icon('disputes') +
        '<span><b>' + (added === 1 ? 'A customer replied' : added + ' customers replied') + '</b>' +
        '<br>waiting on an answer</span>' +
      '</a>' +
      '<button type="button" class="reply-toast-x" aria-label="Dismiss">&times;</button>';
    el.querySelector('.reply-toast-x').addEventListener('click', function () { el.remove(); });
    document.body.appendChild(el);
    window.setTimeout(function () { if (el.parentNode) el.remove(); }, 12000);
  }

  async function poll() {
    var data = await fetchSummary();
    if (!data) return;
    var waiting = Number(data.disputes) || 0;
    var total = waiting + (Number(data.unpaidOrders) || 0) +
                (Number(data.toShip) || 0) + (Number(data.lowStock) || 0);
    paintBadgeWhenReady(total);
    if (lastWaiting !== null && waiting > lastWaiting) replyToast(waiting - lastWaiting);
    lastWaiting = waiting;
  }

  function startPolling() {
    stopPolling();
    if (document.hidden) return;
    timer = window.setInterval(poll, POLL_MS);
  }
  function stopPolling() { if (timer) { window.clearInterval(timer); timer = null; } }

  async function init() {
    if (!admin()) return;
    var data = await fetchSummary();
    if (!data) return;

    var rows = rowsFor(data);
    paintBadgeWhenReady(rows.length ? (data.disputes + data.unpaidOrders + data.toShip + data.lowStock) : 0);

    /* The first reading is the baseline, never news — otherwise every page load
       would announce a backlog the owner has already seen. */
    lastWaiting = Number(data.disputes) || 0;
    startPolling();
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPolling();
      else { poll(); startPolling(); }
    });
    if (window.Live) {
      window.Live.on(function (ev) {
        if (ev && (ev.type === 'dispute-message' || ev.type === 'dispute-opened')) poll();
      });
    }

    if (!data.anythingWaiting || !rows.length) return;

    /* sessionStorage, not localStorage: it empties when the browser session
       ends, so a fresh visit shows this again without any file having to
       remember to clear a flag. Sign-out clears it too (auth.js and main.js),
       which covers signing out and back in within one tab. */
    var seen;
    try { seen = window.sessionStorage.getItem(SEEN_KEY); } catch (e) { seen = null; }
    if (seen) return;
    try { window.sessionStorage.setItem(SEEN_KEY, String(Date.now())); } catch (e) { /* private mode */ }
    open(rows);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Exposed for the mechanical check and for a manual re-open while testing.
  window.AdminAlert = { rowsFor: rowsFor, SEEN_KEY: SEEN_KEY };
})(window, document);
