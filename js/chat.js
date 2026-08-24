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

  var WIDGET_SRC = 'https://unpkg.com/@elevenlabs/convai-widget-embed';
  var loaded = false;

  function mount() {
    if (loaded) return;
    loaded = true;

    var el = document.createElement('elevenlabs-convai');
    el.setAttribute('agent-id', cfg.agentId);
    document.body.appendChild(el);

    var s = document.createElement('script');
    s.src = WIDGET_SRC;
    s.async = true;
    s.type = 'text/javascript';
    s.onerror = function () {
      // The vendor is unreachable or blocked. Take the element back
      // out so there is no dead furniture on the page.
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    document.head.appendChild(s);
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
