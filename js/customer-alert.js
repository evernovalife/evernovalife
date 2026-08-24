/* ============================================================
   EVER NOVA LIFE — telling a customer their report was answered
   The report page announces a reply, but only while the customer is
   standing on it. Someone waiting on a missing parcel is far more
   likely to be browsing the shop, or nowhere at all — so the answer
   has to find them wherever they are on the site.

   Reuses GET /api/disputes, which already reports unreadForCustomer
   per thread. No new endpoint, and no customer records travel: the
   summaries carry counts and an order reference, nothing else.

   Deliberately quiet in three ways:
     · silent on support.html, where the thread itself announces —
       otherwise reading a reply raises a toast about the reply
       being read;
     · once per session per thread, so walking between shop pages
       does not re-announce the same answer;
     · a customer with no reports at all stops asking after the
       first check of the session. Most visitors have never opened
       one, and billing them an API call per page buys nothing.
   ============================================================ */
(function (window, document) {
  'use strict';

  var API = (window.PEPTIDE_API_BASE || '');
  var SEEN_PREFIX = 'enl_reply_seen:';   // + dispute id
  var NONE_KEY = 'enl_no_disputes';      // timestamp of a check that found none
  /* The "nothing to watch" answer EXPIRES. It began as a permanent session flag
     and that was a bug with teeth: a visitor who browsed the shop before opening
     a report cached "none", and the reply notification then never fired again
     for the rest of the session. A flag that can only ever be wrong in the
     silent direction is the wrong shape — this one heals itself. */
  var NONE_TTL = 5 * 60 * 1000;
  var POLL_MS = 60000;                   // slow: a shop page is not a chat window

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* js/auth.js is only on the account and sign-in pages, so the session is
     read straight from storage the way main.js does for the header. */
  function token() {
    try { return window.localStorage.getItem('enl_token') || ''; } catch (e) { return ''; }
  }
  function ss(key) { try { return window.sessionStorage.getItem(key); } catch (e) { return null; } }
  function ssSet(key, v) { try { window.sessionStorage.setItem(key, v); } catch (e) { /* private mode */ } }

  function recentlyEmpty() {
    var at = Number(ss(NONE_KEY));
    return Number.isFinite(at) && at > 0 && (Date.now() - at) < NONE_TTL;
  }

  /* The report page runs its own announcement against the open thread. */
  function onReportPage() {
    return /(^|\/)support\.html$/i.test(window.location.pathname);
  }

  async function unreadThreads() {
    var t = token();
    if (!t) return [];
    try {
      var res = await fetch(API + '/api/disputes', { headers: { Authorization: 'Bearer ' + t } });
      if (!res.ok) return [];                    // signed out, older server — stay quiet
      var data = await res.json();
      var all = (data && data.disputes) || [];
      if (!all.length) { ssSet(NONE_KEY, String(Date.now())); return []; }
      /* Seeing even one thread proves the cache wrong — clear it rather than
         trusting a flag set before this visitor had any reports. */
      try { window.sessionStorage.removeItem(NONE_KEY); } catch (e) {}
      return all.filter(function (d) { return d.unreadForCustomer; });
    } catch (e) {
      return [];                                  // offline: never disturb the shop
    }
  }

  /* ---- a dot on the header's account icon ---- */
  function paintDot(on) {
    var link = document.querySelector('.header-actions a[aria-label="Account"]');
    if (!link) return false;
    var dot = link.querySelector('.acct-dot');
    if (!on) { if (dot) dot.remove(); return true; }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'acct-dot';
      dot.setAttribute('aria-label', 'You have a reply waiting');
      link.appendChild(dot);
    }
    return true;
  }
  /* main.js builds the header and may finish after us. */
  function paintDotWhenReady(on, tries) {
    if (paintDot(on) || (tries || 0) > 6) return;
    window.setTimeout(function () { paintDotWhenReady(on, (tries || 0) + 1); }, 350);
  }

  /* ---- the toast ---- */
  function toast(thread) {
    if (document.querySelector('.reply-toast')) return;   // one at a time
    var el = document.createElement('div');
    el.className = 'reply-toast';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<a href="support.html?order=' + encodeURIComponent(thread.orderId) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/></svg>' +
        '<span><b>Ever Nova Life replied</b><br>about order ' + esc(thread.orderId) + '</span>' +
      '</a>' +
      '<button type="button" class="reply-toast-x" aria-label="Dismiss">&times;</button>';

    el.querySelector('.reply-toast-x').addEventListener('click', function () { el.remove(); });
    document.body.appendChild(el);
    // Slides away on its own; the dot on the account icon is what persists.
    window.setTimeout(function () { if (el.parentNode) el.remove(); }, 12000);
  }

  async function check() {
    if (!token()) { paintDotWhenReady(false); return; }
    var unread = await unreadThreads();
    paintDotWhenReady(unread.length > 0);
    if (!unread.length) return;

    /* Announce each answered report once a session. The dot stays regardless,
       so a dismissed toast never means a lost reply. */
    for (var i = 0; i < unread.length; i++) {
      /* Keyed to the REPLY, not the thread. Keying on the dispute id alone
         meant the first answer toasted and every answer after it on that
         thread was silently skipped for the rest of the session — which is
         exactly why this stopped appearing. lastAt changes per message. */
      var key = SEEN_PREFIX + unread[i].id + ':' + (unread[i].lastAt || '');
      if (ss(key)) continue;
      ssSet(key, '1');
      toast(unread[i]);
      break;                                     // one at a time, oldest first
    }
  }

  var timer = null;
  function startPolling() {
    stopPolling();
    if (document.hidden) return;
    timer = window.setInterval(function () { if (!recentlyEmpty()) check(); }, POLL_MS);
  }
  function stopPolling() { if (timer) { window.clearInterval(timer); timer = null; } }

  function init() {
    if (onReportPage() || !token()) return;
    /* A visitor who has never opened a report is the common case, so a recent
       "none" answer is reused rather than asking again on every page. It goes
       stale on purpose — see NONE_TTL. */
    if (recentlyEmpty()) { paintDotWhenReady(false); return; }

    check();
    startPolling();
    /* The instant path. The poll above stays as the floor: a stream can die
       without saying so, and a notification that depends on one socket is a
       notification that goes quiet. */
    if (window.Live) {
      window.Live.on(function (ev) {
        if (ev && (ev.type === 'dispute-reply' || ev.type === 'dispute-resolved')) check();
      });
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPolling();
      else { check(); startPolling(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.CustomerAlert = { onReportPage: onReportPage, NONE_KEY: NONE_KEY, SEEN_PREFIX: SEEN_PREFIX };
})(window, document);
