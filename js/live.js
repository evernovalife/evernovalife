/* ============================================================
   EVER NOVA LIFE — the live channel
   One connection, shared. A reply should land the instant it is written,
   so the pages that care subscribe here instead of each waiting out its
   own poll.

   This is the FAST path, never the only one. Hosts recycle connections,
   phones sleep radios, and a stream can die without saying so — every
   caller keeps its own slower poll underneath. If this file never
   connects at all, nothing breaks; it just goes back to being as quick
   as the poll was.

   EventSource cannot send an Authorization header, so the credential has
   to be in the URL — and a JWT must never be, because URLs reach server
   logs, proxy logs and browser history. The server mints a single-use
   ticket good for sixty seconds instead; that is what travels.
   ============================================================ */
(function (window, document) {
  'use strict';

  var API = (window.PEPTIDE_API_BASE || '');
  var handlers = [];
  var source = null;
  var retryMs = 3000;              // grows on repeated failure, never hammers
  var RETRY_MAX = 60000;
  var stopped = false;

  function token() {
    try { return window.localStorage.getItem('enl_token') || ''; } catch (e) { return ''; }
  }

  function emit(payload) {
    for (var i = 0; i < handlers.length; i++) {
      /* One bad subscriber must not silence the others. */
      try { handlers[i](payload); } catch (e) { /* keep going */ }
    }
  }

  async function connect() {
    if (stopped || source || !token() || typeof window.EventSource !== 'function') return;
    var ticket;
    try {
      var res = await fetch(API + '/api/events/ticket', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token() }
      });
      if (!res.ok) return schedule();            // signed out, or an older server
      ticket = (await res.json()).ticket;
    } catch (e) {
      return schedule();                          // offline: the poll carries on
    }
    if (!ticket) return schedule();

    try {
      source = new window.EventSource(API + '/api/events?ticket=' + encodeURIComponent(ticket));
    } catch (e) {
      return schedule();
    }

    source.addEventListener('open', function () { retryMs = 3000; });
    source.addEventListener('message', function (e) {
      var payload = null;
      try { payload = JSON.parse(e.data); } catch (err) { return; }
      if (payload) emit(payload);
    });
    source.addEventListener('error', function () {
      /* The browser retries a dropped stream on its own, but a ticket is
         single-use — so the connection has to be rebuilt from scratch. */
      try { source.close(); } catch (err) {}
      source = null;
      schedule();
    });
  }

  function schedule() {
    if (stopped) return;
    window.setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX);
  }

  function start() {
    stopped = false;
    connect();
    /* A tab that was asleep may be holding a stream the server has long
       since dropped. Coming back is the moment to find out. */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || source) return;
      retryMs = 3000;
      connect();
    });
  }

  window.Live = {
    /* handler(payload) — payload.type is 'dispute-reply', 'dispute-resolved',
       'dispute-message' or 'dispute-opened', each with orderId and disputeId. */
    on: function (fn) {
      if (typeof fn !== 'function') return;
      handlers.push(fn);
      if (!source) start();
    },
    /* Exposed for the mechanical check, and for a page that wants to stop. */
    stop: function () {
      stopped = true;
      if (source) { try { source.close(); } catch (e) {} source = null; }
    },
    connected: function () { return !!source; }
  };
})(window, document);
