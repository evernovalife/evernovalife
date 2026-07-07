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
(function () {
  var PROD_API_BASE = '';   // ← set your API origin here for production (or leave '')

  // Respect an explicit value if something set it earlier.
  if (typeof window.PEPTIDE_API_BASE === 'string' && window.PEPTIDE_API_BASE) return;

  var l = location;
  if (l.protocol === 'file:') { window.PEPTIDE_API_BASE = 'http://localhost:4242'; return; }
  if (/^(localhost|127\.0\.0\.1)$/.test(l.hostname) && l.port !== '4242') {
    window.PEPTIDE_API_BASE = 'http://localhost:4242'; return;
  }
  window.PEPTIDE_API_BASE = PROD_API_BASE;   // production: '' (same origin) or your API URL
})();
