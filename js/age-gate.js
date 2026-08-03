/* ============================================================
   EVER NOVA LIFE — Age verification gate (21+)
   Loaded in <head> on every page, BEFORE anything renders.

   Nobody sees the site until they confirm they are at least 21.
   The lock class goes on <html> synchronously (so there is no
   flash of the page behind the gate), and the gate itself is
   injected as soon as <body> exists.

   A confirmation is remembered for 30 days. Declining does not
   store anything — it shows a dead end and offers a way out.
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'enl_age_verified';
  var TTL_DAYS = 30;
  var LOCK_CLASS = 'enl-age-lock';
  var EXIT_URL = 'https://www.google.com';

  /* ---- storage: localStorage first, sessionStorage as a fallback for
     browsers where it's blocked. Never throw over a storage failure —
     worst case the gate simply asks again. ---- */
  function readStamp() {
    var raw = null;
    try { raw = window.localStorage.getItem(KEY); } catch (e) {}
    if (!raw) { try { raw = window.sessionStorage.getItem(KEY); } catch (e) {} }
    return raw;
  }
  function writeStamp(value) {
    try { window.localStorage.setItem(KEY, value); return; } catch (e) {}
    try { window.sessionStorage.setItem(KEY, value); } catch (e) {}
  }

  function isVerified() {
    var raw = readStamp();
    if (!raw) return false;
    var when = Number(raw);
    if (!isFinite(when) || when <= 0) return false;
    return (Date.now() - when) < TTL_DAYS * 86400000;
  }

  // ?agegate=reset re-opens the gate — useful for checking it still works.
  try {
    if (/[?&]agegate=reset\b/.test(window.location.search)) {
      try { window.localStorage.removeItem(KEY); } catch (e) {}
      try { window.sessionStorage.removeItem(KEY); } catch (e) {}
    }
  } catch (e) {}

  if (isVerified()) return;

  /* Lock immediately — this runs from <head>, so the page never paints. */
  var root = document.documentElement;
  root.className += (root.className ? ' ' : '') + LOCK_CLASS;

  function unlock() {
    writeStamp(String(Date.now()));
    root.className = root.className.replace(/\s*\benl-age-lock\b/g, '');
    var gate = document.getElementById('enlAgeGate');
    if (gate) gate.parentNode.removeChild(gate);
    document.removeEventListener('keydown', trapFocus, true);
  }

  function deny() {
    var card = document.querySelector('#enlAgeGate .enl-age-card');
    if (!card) return;
    card.innerHTML =
      '<div class="enl-age-mark" aria-hidden="true">&#9888;</div>' +
      '<h2>Access restricted</h2>' +
      '<p>You must be at least 21 years old to view this site. Ever Nova Life supplies ' +
      'materials strictly for in-vitro research and laboratory use, and does not sell to ' +
      'anyone under 21.</p>' +
      '<div class="enl-age-actions">' +
      '<a class="enl-age-btn enl-age-btn-primary" href="' + EXIT_URL + '">Leave this site</a>' +
      '</div>' +
      '<p class="enl-age-fine">If you entered your age by mistake, ' +
      '<a href="#" id="enlAgeRetry">go back</a>.</p>';
    var retry = document.getElementById('enlAgeRetry');
    if (retry) retry.addEventListener('click', function (e) { e.preventDefault(); render(); });
  }

  /* Keep the keyboard inside the gate while it's up. */
  function trapFocus(e) {
    if (e.key !== 'Tab') return;
    var gate = document.getElementById('enlAgeGate');
    if (!gate) return;
    var focusable = gate.querySelectorAll('a[href], button');
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!gate.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }

  function render() {
    var card = document.querySelector('#enlAgeGate .enl-age-card');
    if (!card) return;
    card.innerHTML =
      '<div class="enl-age-mark" aria-hidden="true">' +
        '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M20.00 1.00 L21.91 15.38 L27.78 12.22 L24.62 18.09 L39.00 20.00 L24.62 21.91 ' +
        'L27.78 27.78 L21.91 24.62 L20.00 39.00 L18.09 24.62 L12.22 27.78 L15.38 21.91 L1.00 20.00 ' +
        'L15.38 18.09 L12.22 12.22 L18.09 15.38 Z" fill="#e8c766"/></svg>' +
      '</div>' +
      '<p class="enl-age-brand">Ever Nova Life</p>' +
      '<h2 id="enlAgeTitle">Are you 21 or older?</h2>' +
      '<p>This site is intended for qualified researchers and laboratory professionals. ' +
      'All products are supplied strictly for <strong>in-vitro research and laboratory use only</strong> ' +
      '&mdash; not for human or veterinary use, and not for consumption.</p>' +
      '<p>Please confirm that you are at least 21 years of age to continue.</p>' +
      '<div class="enl-age-actions">' +
        '<button type="button" class="enl-age-btn enl-age-btn-primary" id="enlAgeYes">Yes, I am 21 or older</button>' +
        '<button type="button" class="enl-age-btn enl-age-btn-ghost" id="enlAgeNo">No, I am under 21</button>' +
      '</div>' +
      '<p class="enl-age-fine">By entering you confirm you are 21+ and that you will use these ' +
      'materials for laboratory research purposes only. See our ' +
      '<a href="terms.html">Terms</a> and <a href="terms.html#disclaimer">Research-Use Notice</a>.</p>';

    var yes = document.getElementById('enlAgeYes');
    var no = document.getElementById('enlAgeNo');
    if (yes) { yes.addEventListener('click', unlock); yes.focus(); }
    if (no) no.addEventListener('click', deny);
  }

  function mount() {
    if (document.getElementById('enlAgeGate')) return;
    var gate = document.createElement('div');
    gate.id = 'enlAgeGate';
    gate.className = 'enl-age-gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-labelledby', 'enlAgeTitle');
    gate.innerHTML = '<div class="enl-age-card glass"></div>';
    document.body.appendChild(gate);
    render();
    document.addEventListener('keydown', trapFocus, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
