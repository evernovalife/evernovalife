/* ============================================================
   EVER NOVA LIFE — front-end config
   ONE place to tell the site where your API server lives.
   (The API = the Node app in /server that handles sign in / sign
   up and payments.)

   ▸ SAME origin — the Node app serves BOTH this site and /api
     (e.g. you run `npm start` and open the site it serves):
        leave PROD_API_BASE = '' below.

   ▸ DIFFERENT origin — the site is on one host and the API on
     another (e.g. static site on GoDaddy + API on a GoDaddy
     subdomain, or on Render/Railway): set your API origin, e.g.
        var PROD_API_BASE = 'https://api.evernovalife.com';
     …and add that site's origin to ALLOWED_ORIGINS in server/.env.

   Local testing (opening the file directly, or via a preview
   server that isn't the Node server) auto-points at
   http://localhost:4242 so nothing breaks while you develop.
   ============================================================ */
/* ------------------------------------------------------------
   CUSTOMER SERVICE PHONE
   Shown on Contact (and anywhere else marked data-support-phone).
   Leave BOTH empty and nothing is displayed at all — a contact page
   with a dead or made-up number is worse than one without.

     window.ENL_SUPPORT_PHONE       = '+1 (555) 123-4567';
     window.ENL_SUPPORT_PHONE_HOURS = 'Mon–Fri, 9am–5pm ET';

   The dial link is derived from the number automatically, so write it
   however you want it to READ.
   ------------------------------------------------------------ */
window.ENL_SUPPORT_PHONE = '(561) 954-9253';
window.ENL_SUPPORT_PHONE_HOURS = '';

/* ------------------------------------------------------------
   ANALYTICS  (off until you fill this in)
   Answers the one question the order records can't: of the people
   who reached the checkout, where did the rest of them go?

   Cookieless by design — Plausible and Umami set no cookies and
   store no personal data, so no consent banner is required and no
   advertising network is given a view of who buys research
   materials. Google Analytics would need both.

     provider — 'plausible' | 'umami' | '' (off)
     domain   — the site as registered with the provider
     src      — the script URL. Plausible cloud is the default
                below; self-hosted or Umami needs your own URL,
                e.g. 'https://analytics.example.com/script.js'
     websiteId— Umami only: the site's UUID from its dashboard

   Example (Plausible cloud):
     window.ENL_ANALYTICS = { provider: 'plausible', domain: 'evernovalife.com' };

   Nothing loads and every track() call is a no-op while provider
   is empty, so the site behaves identically until you set it.

   NOTE: only the funnel is measured — page views plus add_to_cart,
   begin_checkout, payment_started. Revenue is NOT sent to the
   provider; the server's order records are the books, and money
   figures don't belong in a third party's dataset.
   ------------------------------------------------------------ */
window.ENL_ANALYTICS = {
  provider: '',                       // ← 'plausible' or 'umami' to turn it on
  domain: 'evernovalife.com',
  src: 'https://plausible.io/js/script.js',
  websiteId: ''                       // Umami only
};

(function () {
  var PROD_API_BASE = 'https://evernova-api.onrender.com';   // ← your Render backend

  // Respect an explicit value if something set it earlier.
  if (typeof window.PEPTIDE_API_BASE === 'string' && window.PEPTIDE_API_BASE) return;

  var l = location;
  if (l.protocol === 'file:') { window.PEPTIDE_API_BASE = 'http://localhost:4242'; return; }
  if (/^(localhost|127\.0\.0\.1)$/.test(l.hostname)) {
    // localhost:4242 = the Node server is also serving this page → same origin.
    // Any other local port (Live Server, etc.) → talk to the Node server on 4242.
    window.PEPTIDE_API_BASE = (l.port === '4242') ? '' : 'http://localhost:4242';
    return;
  }
  window.PEPTIDE_API_BASE = PROD_API_BASE;   // production (your live domain) → your API URL
})();
