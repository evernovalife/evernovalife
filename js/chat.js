/* ============================================================
   EVER NOVA LIFE — the chat bubble
   Loads the ElevenLabs agent widget. Two conditions gate it,
   both deliberate:

     · ENL_CHAT.agentId must be set. Empty means the feature
       does not exist — no script tag, no element, no requests.
     · The age gate must have been cleared first. Someone who
       has not confirmed they are old enough to be here should
       not be in a conversation with the shop.

   If the vendor script fails to load, nothing happens: no
   bubble, no layout shift, no error in the visitor's face. The
   contact page is still there.
   ============================================================ */
(function () {
  'use strict';

  var cfg = window.ENL_CHAT || {};
  if (!cfg.agentId) return;

  // cfg.version pins the widget bundle. Left empty, the URL below resolves
  // to whatever @elevenlabs/convai-widget-embed publishes next on unpkg —
  // fine while you're setting the agent up, but this script also runs on
  // checkout.html and pay.html, the two pages where money changes hands, so
  // once a version is known to work, set it in js/config.js and the shop
  // stops inheriting the vendor's latest release automatically. Only a
  // plain version token (letters, digits, dots, hyphens) is accepted here —
  // anything else is ignored rather than concatenated into the URL.
  var PKG = '@elevenlabs/convai-widget-embed';
  var rawVersion = cfg.version || '';
  var safeVersion = /^[0-9A-Za-z.\-]+$/.test(rawVersion) ? rawVersion : '';
  var WIDGET_SRC = 'https://unpkg.com/' + PKG + (safeVersion ? '@' + safeVersion : '');
  var loaded = false;

  /* The token is minted per browsing session, not per page. Without the
     cache, every page load mints another live credential and an ordinary
     shopping session would trip any sanely-sized limit on the endpoint.
     Re-minted in the last five minutes of its life so a conversation
     starting now does not expire mid-sentence. */
  var TOKEN_KEY = 'enl_agent_token';
  var REMINT_MARGIN_MS = 5 * 60 * 1000;

  function cachedToken() {
    try {
      var raw = sessionStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      if (!saved || !saved.token || !saved.expiresAt) return null;
      if (saved.expiresAt - Date.now() < REMINT_MARGIN_MS) return null;
      return saved;
    } catch (e) { return null; }   // private mode, quota, corrupt JSON
  }

  /* Resolves to the identity attributes, ALWAYS. Every failure path here
     resolves signed-out rather than rejecting, because nothing about this
     feature is worth costing the visitor their chat bubble. */
  function identity() {
    var out = { signed_in: 'false' };
    var sessionToken = '';
    try { sessionToken = localStorage.getItem('enl_token') || ''; } catch (e) {}
    if (!sessionToken || typeof fetch === 'undefined') return Promise.resolve(out);

    var saved = cachedToken();
    if (saved) {
      return Promise.resolve({
        signed_in: 'true',
        first_name: saved.firstName || '',
        account_token: saved.token
      });
    }

    var base = (typeof window.PEPTIDE_API_BASE === 'string') ? window.PEPTIDE_API_BASE : '';
    return fetch(base + '/api/agent/account-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sessionToken }
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.token) return out;
        try {
          sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
            token: data.token,
            firstName: data.firstName || '',
            expiresAt: Date.now() + (Number(data.ttl) || 1800) * 1000
          }));
        } catch (e) {}   // caching is an optimisation, not a requirement
        return {
          signed_in: 'true',
          first_name: data.firstName || '',
          account_token: data.token
        };
      })
      .catch(function () { return out; });
  }

  function mount() {
    if (loaded) return;
    loaded = true;

    identity().then(function (vars) {
      var el = document.createElement('elevenlabs-convai');
      el.setAttribute('agent-id', cfg.agentId);
      /* Read by the widget when the element connects, so it has to be set
         before the append — which is why the mint is awaited here rather
         than at the visitor's first question. */
      el.setAttribute('dynamic-variables', JSON.stringify(vars));
      document.body.appendChild(el);

      var s = document.createElement('script');
      s.src = WIDGET_SRC;
      s.async = true;
      s.type = 'text/javascript';
      s.onerror = function () {
        // The vendor is unreachable or blocked. Take both the element and
        // the failed script tag back out so there is no dead furniture left
        // in the page.
        if (el.parentNode) el.parentNode.removeChild(el);
        if (s.parentNode) s.parentNode.removeChild(s);
      };
      document.head.appendChild(s);
    });
  }

  // js/age-gate.js puts LOCK_CLASS ('enl-age-lock') on <html> synchronously
  // from <head>, and removes it in unlock() with no event dispatched. If the
  // visitor was already verified on a prior visit, the class is never added
  // at all. Either way, "class absent" means "cleared to proceed".
  function ageGateCleared() {
    return !document.documentElement.classList.contains('enl-age-lock');
  }

  function start() {
    if (ageGateCleared()) { mount(); return; }
    // Poll briefly rather than racing the gate's own script — no event is
    // dispatched on unlock, so polling is the only signal available here.
    var tries = 0;
    var timer = window.setInterval(function () {
      if (ageGateCleared()) { window.clearInterval(timer); mount(); }
      else if (++tries > 120) window.clearInterval(timer);   // two minutes, then give up
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
