/* ============================================================
   EVER NOVA LIFE — main.js
   · Photorealistic vial SVG generator  (createVialSVG)
   · Product card builder
   · Page initializers (catalog, detail, cart, checkout, faq…)
   ============================================================ */

/* ============================================================
   ANALYTICS — funnel only, cookieless, off by default
   Configured in js/config.js (window.ENL_ANALYTICS). With no
   provider set, nothing is loaded and enlTrack() is a no-op, so
   the site runs exactly as it did before.

   Only the shape of the funnel is sent: which step, which product.
   Never an email, an address, an order reference or a money figure
   — the server's order records are the books, and a third party
   has no business holding any of that.
   ============================================================ */
const enlTrack = (function () {
  const cfg = (typeof window !== 'undefined' && window.ENL_ANALYTICS) || {};
  const provider = String(cfg.provider || '').toLowerCase();
  if (!provider || typeof document === 'undefined') {
    return function noop() {};
  }

  const s = document.createElement('script');
  s.defer = true;
  if (provider === 'plausible') {
    s.src = cfg.src || 'https://plausible.io/js/script.js';
    s.setAttribute('data-domain', cfg.domain || location.hostname);
    // Plausible's queue stub, so events fired before the script lands survive.
    window.plausible = window.plausible || function () {
      (window.plausible.q = window.plausible.q || []).push(arguments);
    };
  } else if (provider === 'umami') {
    s.src = cfg.src || '';
    if (cfg.websiteId) s.setAttribute('data-website-id', cfg.websiteId);
  } else {
    return function noop() {};       // unknown provider — load nothing
  }
  if (s.src) document.head.appendChild(s);

  return function track(event, props) {
    try {
      if (provider === 'plausible' && typeof window.plausible === 'function') {
        window.plausible(event, props ? { props } : undefined);
      } else if (provider === 'umami' && window.umami && typeof window.umami.track === 'function') {
        window.umami.track(event, props || {});
      }
    } catch (e) { /* analytics must never break a checkout */ }
  };
})();
if (typeof window !== 'undefined') window.enlTrack = enlTrack;

/* ---------- helpers ---------- */
function formatPrice(n) {
  return '$' + Number(n).toFixed(2);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ============================================================
   NEST HEXAGON LOGO (reusable inner markup)
   gradId = id of a <linearGradient> defined elsewhere in the doc
   ============================================================ */
function novaLogoMarkup(gradId) {
  return `
    <path d="M20 2.5 C20.9 12.5 27.5 19.1 37.5 20 C27.5 20.9 20.9 27.5 20 37.5 C19.1 27.5 12.5 20.9 2.5 20 C12.5 19.1 19.1 12.5 20 2.5 Z" fill="url(#${gradId})"/>
    <path d="M20 10.5 C20.5 16 24 19.5 29.5 20 C24 20.5 20.5 24 20 29.5 C19.5 24 16 20.5 10.5 20 C16 19.5 19.5 16 20 10.5 Z" fill="url(#${gradId})" opacity="0.8" transform="rotate(45 20 20)"/>`;
}
// back-compat alias (older call sites)
const nestLogoMarkup = novaLogoMarkup;

// ornate faceted compass star (0..100 viewBox); ld/dk = light/dark gradient ids
function compassStar(ld, dk) {
  const D = ['M50.0 50.0 L50.00 0.00 L54.97 37.99 Z','M50.0 50.0 L70.51 29.49 L62.01 45.03 Z','M50.0 50.0 L100.00 50.00 L62.01 54.97 Z','M50.0 50.0 L70.51 70.51 L54.97 62.01 Z','M50.0 50.0 L50.00 100.00 L45.03 62.01 Z','M50.0 50.0 L29.49 70.51 L37.99 54.97 Z','M50.0 50.0 L0.00 50.00 L37.99 45.03 Z','M50.0 50.0 L29.49 29.49 L45.03 37.99 Z'];
  const L = ['M50.0 50.0 L45.03 37.99 L50.00 0.00 Z','M50.0 50.0 L54.97 37.99 L70.51 29.49 Z','M50.0 50.0 L62.01 45.03 L100.00 50.00 Z','M50.0 50.0 L62.01 54.97 L70.51 70.51 Z','M50.0 50.0 L54.97 62.01 L50.00 100.00 Z','M50.0 50.0 L45.03 62.01 L29.49 70.51 Z','M50.0 50.0 L37.99 54.97 L0.00 50.00 Z','M50.0 50.0 L37.99 45.03 L29.49 29.49 Z'];
  return D.map(d => `<path d="${d}" fill="url(#${dk})"/>`).join('') +
         L.map(d => `<path d="${d}" fill="url(#${ld})"/>`).join('') +
         `<circle cx="50" cy="50" r="6" fill="url(#${dk})"/><circle cx="50" cy="50" r="2.6" fill="#f5f3ff"/>`;
}

/* ============================================================
   ⭐ PHOTOREALISTIC VIAL SVG GENERATOR
   viewBox 200 × 340 · navy cap · chrome crimp · glass body
   wraparound white label w/ arched serif text + nest badge
   ============================================================ */
let _vialCounter = 0;
function createVialSVG(product) {
  const uid = 'v' + (++_vialCounter);

  /* ---- geometry (squat clear vial — matched to reference photo) ---- */
  const cx = 100;
  const bodyW = 100;
  const bodyH = 140;
  const bodyTop = 108;
  const bodyBottom = bodyTop + bodyH;
  const bL = cx - bodyW / 2;
  const bR = cx + bodyW / 2;
  const rBot = 16;

  const neckW = 46;
  const nL = cx - neckW / 2;
  const nR = cx + neckW / 2;

  /* flip-off cap = royal-blue dome stacked on a silver aluminium crimp band */
  const capW = 56;
  const cL = cx - capW / 2;
  const cR = cx + capW / 2;
  const domeTopY = 20, domeBaseY = 44;   // blue dome region
  const bandTopY = 44, bandBotY = 74;    // silver band region

  /* label region */
  const labelTop = 130;
  const labelH = 98;
  const labelBottom = labelTop + labelH;
  const L = f => labelTop + f * labelH;
  const textHalf = bodyW / 2 - 12;

  /* contents (kept minimal — clear vial like the reference) */
  const cakeTop = bodyBottom - 13;

  /* badge */
  const bw2 = 19;
  const bt = L(0.15);
  const bh = labelH * 0.33;
  const logoSize = bw2 * 1.7;

  /* ---- glass outline + interior clip (squat: short neck, round shoulder + base) ---- */
  const glassPath =
    `M ${nL} 72
     L ${nR} 72
     L ${nR} 90
     C ${nR + 3} 95 ${bR} 100 ${bR} ${bodyTop}
     L ${bR} ${bodyBottom - rBot}
     Q ${bR} ${bodyBottom} ${bR - rBot} ${bodyBottom}
     L ${bL + rBot} ${bodyBottom}
     Q ${bL} ${bodyBottom} ${bL} ${bodyBottom - rBot}
     L ${bL} ${bodyTop}
     C ${bL} 100 ${nL - 3} 95 ${nL} 90
     Z`;
  const bodyClipPath =
    `M ${bL} ${bodyTop}
     L ${bR} ${bodyTop}
     L ${bR} ${bodyBottom - rBot}
     Q ${bR} ${bodyBottom} ${bR - rBot} ${bodyBottom}
     L ${bL + rBot} ${bodyBottom}
     Q ${bL} ${bodyBottom} ${bL} ${bodyBottom - rBot}
     Z`;

  /* ---- contents markup (minimal — clear vial, lyophilized cake) ---- */
  const contents = `
      <g clip-path="url(#bodyClip_${uid})">
        <path d="M ${bL + 2} ${cakeTop} Q ${cx} ${cakeTop - 4} ${bR - 2} ${cakeTop} L ${bR - 2} ${bodyBottom} L ${bL + 2} ${bodyBottom} Z" fill="url(#powder_${uid})" opacity="0.92"/>
        <path d="M ${bL + 2} ${cakeTop} Q ${cx} ${cakeTop - 4} ${bR - 2} ${cakeTop}" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.65"/>
      </g>`;

  /* ---- arched text baseline paths ---- */
  const topArc = `M ${cx - textHalf} ${L(0.10)} Q ${cx} ${L(0.10) - 7} ${cx + textHalf} ${L(0.10)}`;
  const botArc = `M ${cx - textHalf} ${L(0.96)} Q ${cx} ${L(0.96) + 7} ${cx + textHalf} ${L(0.96)}`;

  /* ---- shield badge ---- */
  const shieldPath =
    `M ${cx - bw2} ${bt + 3}
     Q ${cx - bw2} ${bt} ${cx - bw2 + 3} ${bt}
     L ${cx + bw2 - 3} ${bt}
     Q ${cx + bw2} ${bt} ${cx + bw2} ${bt + 3}
     L ${cx + bw2} ${bt + bh * 0.55}
     Q ${cx + bw2} ${bt + bh * 0.9} ${cx} ${bt + bh}
     Q ${cx - bw2} ${bt + bh * 0.9} ${cx - bw2} ${bt + bh * 0.55}
     Z`;

  /* product name sizing (shrink long names) */
  const name = product.name || '';
  const nameSize = name.length > 22 ? 6 : name.length > 14 ? 7.5 : 9;

  return `
<svg class="vial-svg" viewBox="0 0 200 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(name)} vial">
  <defs>
    <radialGradient id="shadow_${uid}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(0,0,0,0.38)"/>
      <stop offset="60%" stop-color="rgba(0,0,0,0.16)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
    </radialGradient>
    <!-- royal-blue cap -->
    <radialGradient id="capDome_${uid}" cx="38%" cy="26%" r="85%">
      <stop offset="0%" stop-color="#dbeafe"/>
      <stop offset="20%" stop-color="#60a5fa"/>
      <stop offset="48%" stop-color="#2563eb"/>
      <stop offset="78%" stop-color="#1d4ed8"/>
      <stop offset="100%" stop-color="#1e3a8a"/>
    </radialGradient>
    <linearGradient id="capSide_${uid}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#172554"/>
      <stop offset="20%" stop-color="#2563eb"/>
      <stop offset="40%" stop-color="#60a5fa"/>
      <stop offset="58%" stop-color="#3b82f6"/>
      <stop offset="80%" stop-color="#1d4ed8"/>
      <stop offset="100%" stop-color="#172554"/>
    </linearGradient>
    <!-- chrome crimp -->
    <linearGradient id="crimp_${uid}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#6b7280"/>
      <stop offset="12%" stop-color="#d1d5db"/>
      <stop offset="26%" stop-color="#f9fafb"/>
      <stop offset="40%" stop-color="#e5e7eb"/>
      <stop offset="50%" stop-color="#cbd2d9"/>
      <stop offset="60%" stop-color="#eef0f2"/>
      <stop offset="76%" stop-color="#aeb4bd"/>
      <stop offset="90%" stop-color="#6b7280"/>
      <stop offset="100%" stop-color="#4b5563"/>
    </linearGradient>
    <!-- clear glass (translucent cylinder) -->
    <linearGradient id="glassFill_${uid}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#c3d2e2" stop-opacity="0.60"/>
      <stop offset="16%" stop-color="#eef4f9" stop-opacity="0.32"/>
      <stop offset="38%" stop-color="#ffffff" stop-opacity="0.15"/>
      <stop offset="62%" stop-color="#e6edf4" stop-opacity="0.20"/>
      <stop offset="84%" stop-color="#a9b8ca" stop-opacity="0.46"/>
      <stop offset="100%" stop-color="#7c8ca1" stop-opacity="0.60"/>
    </linearGradient>
    <linearGradient id="powder_${uid}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#dbe2ea"/>
      <stop offset="45%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#c2ccd8"/>
    </linearGradient>
    <!-- cylinder curve shading over label -->
    <linearGradient id="labelShade_${uid}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="rgba(0,0,0,0.42)"/>
      <stop offset="14%" stop-color="rgba(0,0,0,0.14)"/>
      <stop offset="30%" stop-color="rgba(0,0,0,0.03)"/>
      <stop offset="50%" stop-color="rgba(255,255,255,0.12)"/>
      <stop offset="70%" stop-color="rgba(0,0,0,0.03)"/>
      <stop offset="86%" stop-color="rgba(0,0,0,0.16)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.44)"/>
    </linearGradient>
    <linearGradient id="nest_${uid}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6d28d9"/>
      <stop offset="50%" stop-color="#a855f7"/>
      <stop offset="100%" stop-color="#d4af37"/>
    </linearGradient>
    <path id="topArc_${uid}" d="${topArc}"/>
    <path id="botArc_${uid}" d="${botArc}"/>
    <clipPath id="bodyClip_${uid}"><path d="${bodyClipPath}"/></clipPath>
    <clipPath id="labelClip_${uid}"><rect x="${bL + 2}" y="${labelTop}" width="${bodyW - 4}" height="${labelH}" rx="4"/></clipPath>
  </defs>

  <!-- ground shadow -->
  <ellipse cx="${cx + 4}" cy="${bodyBottom + 9}" rx="${bodyW * 0.54}" ry="9" fill="url(#shadow_${uid})"/>

  <!-- ===== GLASS BODY ===== -->
  <path d="${glassPath}" fill="url(#glassFill_${uid})"/>
  ${contents}

  <!-- glass reflections -->
  <g clip-path="url(#bodyClip_${uid})">
    <rect x="${bL + bodyW * 0.13}" y="${bodyTop + 5}" width="${bodyW * 0.07}" height="${bodyH - 16}" rx="3" fill="#ffffff" opacity="0.62"/>
    <rect x="${bL + bodyW * 0.24}" y="${bodyTop + 8}" width="${bodyW * 0.028}" height="${bodyH - 28}" rx="2" fill="#ffffff" opacity="0.38"/>
    <rect x="${bR - bodyW * 0.13}" y="${bodyTop + 7}" width="${bodyW * 0.03}" height="${bodyH - 22}" rx="2" fill="#ffffff" opacity="0.50"/>
    <rect x="${bR - bodyW * 0.085}" y="${bodyTop + 7}" width="${bodyW * 0.012}" height="${bodyH - 22}" rx="1" fill="#ffffff" opacity="0.72"/>
  </g>
  <!-- glass rim -->
  <path d="${glassPath}" fill="none" stroke="#ffffff" stroke-opacity="0.40" stroke-width="0.8"/>
  <path d="${glassPath}" fill="none" stroke="#475569" stroke-opacity="0.22" stroke-width="0.5"/>

  <!-- ===== WRAPAROUND WHITE LABEL ===== -->
  <g clip-path="url(#labelClip_${uid})">
    <rect x="${bL + 2}" y="${labelTop}" width="${bodyW - 4}" height="${labelH}" fill="#fcfcfd"/>
    <text font-family="Georgia, 'Times New Roman', serif" font-weight="900" font-size="9" fill="#0f172a" text-anchor="middle"><textPath href="#topArc_${uid}" startOffset="50%">Ever Nova Life</textPath></text>
    <path d="${shieldPath}" fill="#ffffff" stroke="url(#nest_${uid})" stroke-width="1.1"/>
    <svg x="${cx - logoSize / 2}" y="${bt + 2}" width="${logoSize}" height="${logoSize}" viewBox="0 0 40 40">${nestLogoMarkup('nest_' + uid)}</svg>
    <text x="${cx}" y="${L(0.60)}" font-family="Georgia, serif" font-weight="700" font-size="${nameSize}" fill="#1f2937" text-anchor="middle">${escapeHtml(name)}</text>
    <text x="${cx}" y="${L(0.73)}" font-family="Georgia, serif" font-weight="900" font-size="13" fill="#0f172a" text-anchor="middle">${escapeHtml(product.quantity || '')}</text>
    <text x="${cx}" y="${L(0.91)}" font-family="Inter, sans-serif" font-weight="500" font-size="3.9" fill="#64748b" text-anchor="middle">LOT ${escapeHtml(product.lot || '')}</text>
    <rect x="${bL + 2}" y="${labelTop}" width="${bodyW - 4}" height="${labelH}" fill="url(#labelShade_${uid})"/>
    <line x1="${bL + 2}" y1="${labelTop + 0.5}" x2="${bR - 2}" y2="${labelTop + 0.5}" stroke="#94a3b8" stroke-width="0.5" opacity="0.5"/>
    <line x1="${bL + 2}" y1="${labelBottom - 0.5}" x2="${bR - 2}" y2="${labelBottom - 0.5}" stroke="#94a3b8" stroke-width="0.5" opacity="0.5"/>
  </g>

  <!-- ===== SILVER ALUMINIUM CRIMP BAND ===== -->
  <rect x="${cL}" y="${bandTopY}" width="${capW}" height="${bandBotY - bandTopY - 2}" fill="url(#crimp_${uid})"/>
  <!-- flared bottom crimp lip -->
  <ellipse cx="${cx}" cy="${bandBotY - 1}" rx="${capW / 2 + 1.5}" ry="3.4" fill="url(#crimp_${uid})" stroke="#6b7280" stroke-width="0.4"/>
  <!-- chrome speculars -->
  <rect x="${cx - capW * 0.30}" y="${bandTopY}" width="${capW * 0.10}" height="${bandBotY - bandTopY - 2}" fill="#ffffff" opacity="0.55"/>
  <rect x="${cx - capW * 0.08}" y="${bandTopY}" width="1.8" height="${bandBotY - bandTopY - 3}" fill="#ffffff" opacity="0.22"/>
  <rect x="${cx + capW * 0.16}" y="${bandTopY}" width="2.6" height="${bandBotY - bandTopY - 3}" fill="#ffffff" opacity="0.32"/>
  <rect x="${cx + capW * 0.31}" y="${bandTopY}" width="${capW * 0.06}" height="${bandBotY - bandTopY - 2}" fill="#475569" opacity="0.22"/>
  <line x1="${cL + 2}" y1="${bandBotY - 6}" x2="${cR - 2}" y2="${bandBotY - 6}" stroke="#5b6573" stroke-width="0.5" opacity="0.4"/>

  <!-- ===== ROYAL-BLUE FLIP-OFF DOME (on top) ===== -->
  <rect x="${cL}" y="${domeBaseY - 6}" width="${capW}" height="6" fill="url(#capSide_${uid})"/>
  <ellipse cx="${cx}" cy="${domeBaseY}" rx="${capW / 2}" ry="3.2" fill="#1e3a8a"/>
  <path d="M ${cL} ${domeBaseY - 4} C ${cL} ${domeTopY + 3} ${cx - capW * 0.34} ${domeTopY - 3} ${cx} ${domeTopY - 3} C ${cx + capW * 0.34} ${domeTopY - 3} ${cR} ${domeTopY + 3} ${cR} ${domeBaseY - 4} Z" fill="url(#capDome_${uid})"/>
  <ellipse cx="${cx}" cy="${domeTopY + 1}" rx="${capW * 0.26}" ry="2.2" fill="#1e3a8a" opacity="0.32"/>
  <ellipse cx="${cx - capW * 0.16}" cy="${domeTopY + 2}" rx="${capW * 0.20}" ry="4" fill="#dbeafe" opacity="0.88"/>
</svg>`;
}

/* ============================================================
   ⭐ PHOTOREALISTIC VIAL = real photo + Ever Nova Life label overlay
   (overlay covers the stock label; per-product name/qty)
   ============================================================ */
/* Where a built-in product's vial photo lives: a bottle-cropped cut-out in two
   widths — 630×920 (~115KB, as sharp as the master gets) and 420×920 (~58KB) —
   with a quantized .png beside them for the onerror fallback path. The
   full-frame masters stay in assets/vials/_base/; publish.py there mattes and
   crops them. VIAL_V busts Cloudflare when the artwork is replaced — bump it
   whenever the files change, since the filenames never do. */
const VIAL_V = 8;
function vialPhotoSrc(id) {
  return `assets/vials/${id}.webp?v=${VIAL_V}`;
}
function vialPhotoSrcSet(id) {
  return `assets/vials/${id}-sm.webp?v=${VIAL_V} 420w, assets/vials/${id}.webp?v=${VIAL_V} 630w`;
}

/* Every surface — card, product page, cart row, mini-cart thumb — shows this
   one still. Turntable clips used to play on the two big surfaces; they were
   dropped on 2026-08-07 because no build of them survived iOS Safari, which
   decodes no alpha video and drops a CSS mask on a <video>.

   Opts: { width } is the CSS width the bottle is drawn at on this surface, so
   the browser can pick between the two files. The box is sized by HEIGHT in CSS
   (250px card / 560px product page / 86px cart row, aspect 420:920), which
   srcset can't read, so the caller states it. Left off, it defaults to the card.
   A product added through the admin manager has one uploaded image and no
   second width, so it just gets `src`. */
const VIAL_W = { card: 160, detail: 260, thumb: 44 };
function createVialPhoto(product, opts) {
  const uid = 'p' + (++_vialCounter);
  const name = product.name || '';
  const nameSize = name.length > 22 ? 13 : name.length > 14 ? 16 : 21;

  // Use the real labelled-vial photo. A browser too old for WebP (pre-2020)
  // trips the onerror below and lands on the generic vial + label.
  const realSrc = product.image || vialPhotoSrc(product.id);
  const responsive = product.image ? '' :
    ` srcset="${vialPhotoSrcSet(product.id)}" sizes="${(opts && opts.width) || VIAL_W.card}px"`;
  return `
  <div class="vial-photo">
    <img class="vial-photo-img" src="${realSrc}"${responsive} alt="${escapeHtml(name)} research vial" loading="lazy" decoding="async"
         onerror="this.onerror=null;this.removeAttribute('srcset');this.src='assets/vial.png?v=3';this.parentNode.classList.add('vial-fallback');var l=this.parentNode.querySelector('.vial-photo-label');if(l)l.style.display='block'">
    <svg class="vial-photo-label" viewBox="0 0 200 380" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" preserveAspectRatio="none" style="display:none">
      <defs>
        <linearGradient id="brand_${uid}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#6d28d9"/><stop offset="50%" stop-color="#a855f7"/><stop offset="100%" stop-color="#d4af37"/>
        </linearGradient>
        <linearGradient id="sD_${uid}" gradientUnits="userSpaceOnUse" x1="50" y1="2" x2="50" y2="98">
          <stop offset="0%" stop-color="#6d28d9"/><stop offset="50%" stop-color="#a21caf"/><stop offset="100%" stop-color="#c0267e"/>
        </linearGradient>
        <linearGradient id="sL_${uid}" gradientUnits="userSpaceOnUse" x1="50" y1="2" x2="50" y2="98">
          <stop offset="0%" stop-color="#ede9fe"/><stop offset="50%" stop-color="#ffffff"/><stop offset="100%" stop-color="#fce7f3"/>
        </linearGradient>
        <radialGradient id="bgL_${uid}" cx="-10%" cy="48%" r="72%">
          <stop offset="0%" stop-color="#e89acd"/><stop offset="100%" stop-color="#e89acd" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="bgR_${uid}" cx="110%" cy="54%" r="72%">
          <stop offset="0%" stop-color="#eaa0d0"/><stop offset="100%" stop-color="#eaa0d0" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="bgC_${uid}" cx="50%" cy="30%" r="55%">
          <stop offset="0%" stop-color="#fcf8fe" stop-opacity="0.7"/><stop offset="60%" stop-color="#fcf8fe" stop-opacity="0.12"/><stop offset="100%" stop-color="#fcf8fe" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="shade_${uid}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="rgba(40,46,60,0.30)"/>
          <stop offset="14%" stop-color="rgba(40,46,60,0.05)"/>
          <stop offset="50%" stop-color="rgba(255,255,255,0.10)"/>
          <stop offset="86%" stop-color="rgba(40,46,60,0.06)"/>
          <stop offset="100%" stop-color="rgba(40,46,60,0.32)"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="200" height="380" rx="10" fill="#e6dcef"/>
      <rect x="0" y="0" width="200" height="380" rx="10" fill="url(#bgL_${uid})"/>
      <rect x="0" y="0" width="200" height="380" rx="10" fill="url(#bgR_${uid})"/>
      <rect x="0" y="0" width="200" height="380" rx="10" fill="url(#bgC_${uid})"/>
      <svg x="58" y="26" width="84" height="84" viewBox="0 0 100 100">${compassStar('sL_' + uid, 'sD_' + uid)}</svg>
      <text x="100" y="150" font-family="'Helvetica Neue', Arial, sans-serif" font-size="16" letter-spacing="2.6" text-anchor="middle"><tspan fill="#7e22ce" font-weight="500">EVER </tspan><tspan fill="#2e1065" font-weight="800">NOVA</tspan><tspan fill="#7e22ce" font-weight="500"> LIFE</tspan></text>
      <text x="100" y="198" font-family="Georgia, serif" font-weight="700" font-size="${nameSize}" fill="#141414" text-anchor="middle">${escapeHtml(name)}</text>
      <text x="100" y="244" font-family="Georgia, serif" font-weight="900" font-size="32" fill="#101010" text-anchor="middle">${escapeHtml(product.quantity || '')}</text>
      <rect x="66" y="252" width="68" height="4" rx="2" fill="url(#brand_${uid})"/>
      <line x1="40" y1="288" x2="160" y2="288" stroke="#c4b1e0" stroke-width="1"/>
      <text x="100" y="306" font-family="Arial, sans-serif" font-weight="600" font-size="10" fill="#1a1a1a" text-anchor="middle">LOT ${escapeHtml(product.lot || '')}</text>
      <line x1="40" y1="318" x2="160" y2="318" stroke="#c4b1e0" stroke-width="1"/>
      <text x="100" y="341" font-family="Arial, sans-serif" font-weight="600" font-size="9.5" letter-spacing="0.3" fill="#1f2937" text-anchor="middle">For Research Use Only</text>
      <rect x="0" y="0" width="200" height="380" rx="10" fill="url(#shade_${uid})"/>
    </svg>
  </div>`;
}

/* ============================================================
   PRODUCT CARD
   ============================================================ */
function productBadgeClass(badge) {
  if (!badge) return '';
  const b = badge.toLowerCase();
  if (b === 'new') return 'badge-new';
  if (b === 'sale' || b === 'bestseller') return 'badge-sale';
  return '';
}

/* Render the purity meta line. Only append "purity" when the value is an
   actual percentage; blend/reagent labels (e.g. "ID + content") show as-is,
   so we never imply a single purity figure that wasn't reported. */
function purityMeta(purity) {
  const s = String(purity == null ? '' : purity).trim();
  if (!s) return '';
  return /%\s*$/.test(s) ? escapeHtml(s) + ' purity' : escapeHtml(s);
}

/* ---- stock ----
   A product may carry `stockQty`, a live count the admin sets and every order
   draws down (server/products.js). It is deliberately OPTIONAL: absent means
   the count isn't being kept, and availability is the `inStock` switch alone —
   which is how the whole catalog behaved before counts existed.

   Returns { sellable, left, label, cls }; `left` is null when untracked. */
const LOW_STOCK_AT = 5;

function stockInfo(product) {
  if (!product || product.inStock === false) {
    return { sellable: false, left: 0, label: 'Out of stock', cls: 'out' };
  }
  const raw = product.stockQty;
  if (raw === null || raw === undefined || raw === '') {
    return { sellable: true, left: null, label: 'In stock', cls: '' };
  }
  const left = Math.max(0, Math.floor(Number(raw) || 0));
  if (left === 0) return { sellable: false, left: 0, label: 'Out of stock', cls: 'out' };
  /* Naming the number only when it is genuinely low keeps it informative. A
     permanent "23 in stock" is noise, and on a research supplier it invites a
     scarcity reading the catalog has no business making. */
  if (left <= LOW_STOCK_AT) return { sellable: true, left, label: `Only ${left} left`, cls: 'low' };
  return { sellable: true, left, label: 'In stock', cls: '' };
}

function createProductCard(product) {
  const badge = product.badge
    ? `<span class="product-badge ${productBadgeClass(product.badge)}">${escapeHtml(product.badge)}</span>`
    : '';
  const oldPrice = product.originalPrice && product.originalPrice > product.price
    ? `<span class="product-price-old">${formatPrice(product.originalPrice)}</span>` : '';
  const st = stockInfo(product);
  const stock = `<span class="stock-pill ${st.cls}">${st.label}</span>`;

  /* The card must gate on stock the same way the detail page does
     (see productDetailMarkup) — an enabled Add-to-Cart sitting next to an
     "Out of stock" pill puts unfulfillable lines into the cart and carries
     them all the way to a crypto invoice. */
  const addBtn = st.sellable
    ? `<button class="btn btn-primary btn-sm" onclick="addToCartById(${product.id}, 1, this)">Add to Cart</button>`
    : `<button class="btn btn-primary btn-sm" disabled aria-disabled="true" title="Out of stock">Out of Stock</button>`;

  return `
  <article class="product-card glass glass-hover">
    <div class="product-media">
      ${badge}
      <button class="wish-btn ${wishlist.has(product.id) ? 'active' : ''}" data-id="${product.id}" aria-label="Save to wishlist" aria-pressed="${wishlist.has(product.id)}" onclick="toggleWishlist(${product.id}, this)">${iconHeart()}</button>
      <a href="product.html?id=${product.id}" aria-label="${escapeHtml(product.name)}">${createVialPhoto(product)}</a>
    </div>
    <div class="product-info">
      <span class="product-cat">${escapeHtml(product.categoryName)}</span>
      <h3 class="product-name"><a href="product.html?id=${product.id}">${escapeHtml(product.name)}</a></h3>
      <div class="product-meta"><span>${escapeHtml(product.quantity)}</span><span>•</span><span>${purityMeta(product.purity)}</span></div>
      <p class="product-desc">${escapeHtml(product.description.slice(0, 92))}…</p>
      <div class="product-price-row">
        <span class="product-price gradient-text">${formatPrice(product.price)}</span>
        ${oldPrice}
      </div>
      ${stock}
      <div class="product-actions">
        ${addBtn}
        <a class="btn btn-ghost btn-sm" href="product.html?id=${product.id}">View</a>
      </div>
      <a class="product-coa-link" href="product.html?id=${product.id}#coa">${iconCheck()} Certificate of Analysis${
        product.coa && product.coa.status === 'available' ? ''
          : product.coa && product.coa.status === 'not-applicable' ? ' (not applicable)'
          : ' (pending)'}</a>
    </div>
  </article>`;
}

/* ---- celebration helpers (Add-to-Cart pop + fly-to-cart chip) ---- */
function pnReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Pop the source bottle, then fly a brand-gradient chip into the cart icon.
// `sourceEl` may be the Add-to-Cart button (catalog) or any node inside the
// product media; we resolve the nearest bottle + its .vial-photo-img from it.
function pnCartCelebrate(sourceEl) {
  if (pnReducedMotion()) return;

  // optional haptic on supporting devices
  if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }

  // find the media stage relative to the click (card OR detail page)
  let media = null;
  if (sourceEl && sourceEl.closest) {
    media = sourceEl.closest('.product-card, .product-detail-media');
    if (media && media.classList.contains('product-card')) {
      media = media.querySelector('.product-media') || media;
    }
  }
  if (!media) media = document.querySelector('.product-detail-media');
  if (!media) return;

  const img = media.querySelector('.vial-photo .vial-photo-img');
  if (img) {
    img.classList.remove('pn-pop');
    void img.offsetWidth;            // restart the keyframe
    img.classList.add('pn-pop');
    img.addEventListener('animationend', () => img.classList.remove('pn-pop'), { once: true });
  }

  const badge = document.querySelector('.cart-badge');
  if (!img || !badge) return;

  // arc geometry from bottle center → cart badge center (fixed-positioned chip)
  const from = img.getBoundingClientRect();
  const to = badge.getBoundingClientRect();
  const x0 = from.left + from.width / 2 - 9;   // chip is 18px → center it
  const y0 = from.top + from.height * 0.34 - 9;
  const x1 = to.left + to.width / 2 - 9;
  const y1 = to.top + to.height / 2 - 9;
  const xm = (x0 + x1) / 2;
  const ym = Math.min(y0, y1) - 70;            // lift the arc apex upward

  const chip = document.createElement('div');
  chip.className = 'pn-fly-chip';
  chip.style.setProperty('--fly-x0', x0 + 'px');
  chip.style.setProperty('--fly-y0', y0 + 'px');
  chip.style.setProperty('--fly-xm', xm + 'px');
  chip.style.setProperty('--fly-ym', ym + 'px');
  chip.style.setProperty('--fly-x1', x1 + 'px');
  chip.style.setProperty('--fly-y1', y1 + 'px');
  document.body.appendChild(chip);
  chip.addEventListener('animationend', () => {
    chip.remove();
    badge.classList.remove('pn-bump');
    void badge.offsetWidth;
    badge.classList.add('pn-bump');
    badge.addEventListener('animationend', () => badge.classList.remove('pn-bump'), { once: true });
  }, { once: true });
}

function addToCartById(id, qty = 1, sourceEl = null) {
  const product = getProductById(id);
  if (!product) return;
  /* Belt-and-braces against a stale catalog: the buttons are disabled when a
     product is out of stock, but the live catalog can repaint under an already
     open page, so refuse here too rather than trusting the markup. Goes through
     stockInfo, not `inStock` alone — a product whose COUNT has reached zero is
     just as unsellable as one the admin switched off. */
  const st = stockInfo(product);
  if (!st.sellable) {
    cart.showNotification(`${product.name} is out of stock`);
    return;
  }
  if (st.left !== null && qty > st.left) {
    cart.showNotification(`Only ${st.left} left of ${product.name}`);
    qty = st.left;
  }
  cart.addItem(product, qty);       // existing green toast + badge sync
  pnCartCelebrate(sourceEl);
  enlTrack('add_to_cart', { product: product.name, category: product.categoryName || product.category || '' });
}

function renderProducts(list, container) {
  if (!container) return;
  if (!list.length) {
    /* The empty state has to offer the way out — a shopper who filtered
       themselves into nothing otherwise has to work out which of five
       controls did it. The button is only wired on the catalog page. */
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">${iconSearchOff()}</div>
      <h3>No products match those filters</h3>
      <p>Widen the price range, clear a category, or search a different term.</p>
      <button type="button" class="btn btn-primary btn-sm" id="clearFiltersEmpty">Clear all filters</button>
    </div>`;
    return;
  }
  container.innerHTML = list.map(createProductCard).join('');
}

/* ============================================================
   HOMEPAGE — featured products + categories
   ============================================================ */
function displayFeaturedProducts() {
  const grid = document.getElementById('featuredProducts');
  if (grid) renderProducts(getFeaturedProducts(), grid);
}

function displayCategories() {
  const grid = document.getElementById('categoriesGrid');
  if (!grid) return;
  grid.innerHTML = CATEGORIES.map(c => `
    <a class="category-card glass glass-hover" href="products.html?category=${c.key}">
      <div class="category-icon">${categoryIcon(c.icon)}</div>
      <h3>${c.name}</h3>
      <p>${c.blurb}</p>
      <div class="category-count">${getCategoryCount(c.key)} product${getCategoryCount(c.key) === 1 ? '' : 's'}</div>
    </a>`).join('');
}

/* ============================================================
   NEWSLETTER (demo)
   ============================================================ */
function initNewsletter() {
  const form = document.getElementById('newsletterForm');
  if (!form) return;
  form.addEventListener('submit', e => {
    e.preventDefault();
    const msg = form.querySelector('.newsletter-msg');
    const email = form.querySelector('input[type="email"]').value.trim();
    if (msg) msg.textContent = email ? 'Welcome to the Nest — check your inbox to confirm.' : '';
    form.reset();
  });
}

/* ============================================================
   SEARCH overlay
   ============================================================ */
function initSearch() {
  const trigger = document.getElementById('searchBtn');
  const overlay = document.getElementById('searchOverlay');
  if (!overlay) return;
  const input = overlay.querySelector('input');
  if (trigger) {
    trigger.addEventListener('click', () => {
      overlay.classList.add('open');
      setTimeout(() => input && input.focus(), 50);
    });
  }
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  const form = overlay.querySelector('form');
  if (form) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const q = input.value.trim();
      window.location.href = 'products.html' + (q ? '?search=' + encodeURIComponent(q) : '');
    });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') overlay.classList.remove('open'); });
}

/* ============================================================
   HEADER — mobile menu + active link
   ============================================================ */
function initHeader() {
  const burger = document.getElementById('hamburger');
  const nav = document.getElementById('mainNav');
  if (burger && nav) {
    if (!nav.id) nav.id = 'mainNav';
    burger.setAttribute('aria-controls', nav.id);
    burger.setAttribute('aria-expanded', 'false');

    /* One place decides the open state so the button's announced state, the
       class and every way of closing stay in agreement. The old version only
       toggled the class: the menu announced itself as collapsed while open,
       and nothing but a second tap on the button could shut it — not Escape,
       not tapping the page, not even following a link in it. */
    const setOpen = open => {
      nav.classList.toggle('mobile-open', open);
      burger.setAttribute('aria-expanded', String(open));
    };
    burger.addEventListener('click', e => {
      e.stopPropagation();
      setOpen(!nav.classList.contains('mobile-open'));
      if (nav.classList.contains('mobile-open')) {
        const first = nav.querySelector('a');
        if (first) first.focus();
      }
    });
    nav.addEventListener('click', e => { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('click', e => {
      if (!nav.classList.contains('mobile-open')) return;
      if (nav.contains(e.target) || burger.contains(e.target)) return;
      setOpen(false);
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !nav.classList.contains('mobile-open')) return;
      setOpen(false);
      burger.focus();
    });
  }
  // active link — aria-current carries it for screen readers; .active is only paint
  const page = currentPage;
  document.querySelectorAll('.main-nav a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === page || (page === 'index.html' && (href === 'index.html' || href === './' || href === '/'))) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    }
  });
}

/* ============================================================
   PRODUCTS PAGE — filters + sort + URL params
   ============================================================ */
function initProductsPage() {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;
  /* Describe the whole catalog to a crawler, not the filtered view — the
     filters are a reading of the page, and a search engine should see the
     shelf rather than whichever slice this visitor happened to pick. */
  initCatalogSchema(PRODUCTS);
  const params = new URLSearchParams(location.search);
  const urlCat = params.get('category');
  const urlSearch = params.get('search');

  const sortSelect = document.getElementById('sortSelect');
  const searchInput = document.getElementById('catalogSearch');
  const priceRange = document.getElementById('priceRange');
  const priceVal = document.getElementById('priceValue');
  const stockOnly = document.getElementById('inStockOnly');
  const countEl = document.getElementById('resultCount');
  const catBoxes = () => Array.from(document.querySelectorAll('.cat-filter'));

  const chipsEl = document.getElementById('activeFilters');
  const priceMax = priceRange ? Number(priceRange.max) : 0;

  /* ---- read the whole filter state out of the URL, not just on first load.
     Everything the shopper touches goes back into the query string (below), so
     a filtered catalog is a link they can send, and Back walks the filters
     instead of leaving the page. ---- */
  function readStateFromUrl() {
    const p = new URLSearchParams(location.search);
    const cats = (p.get('category') || '').split(',').filter(Boolean);
    catBoxes().forEach(cb => { cb.checked = cats.includes(cb.value); });
    if (searchInput) searchInput.value = p.get('search') || '';
    if (sortSelect && p.get('sort')) sortSelect.value = p.get('sort');
    if (priceRange) priceRange.value = p.get('max') || priceRange.max;
    if (stockOnly) stockOnly.checked = p.get('stock') === '1';
  }
  readStateFromUrl();
  // legacy single-value ?category=x links still land on the right box
  if (urlCat && !catBoxes().some(cb => cb.checked)) {
    catBoxes().forEach(cb => { if (cb.value === urlCat) cb.checked = true; });
  }
  if (urlSearch && searchInput && !searchInput.value) searchInput.value = urlSearch;

  function writeStateToUrl() {
    const p = new URLSearchParams();
    const cats = catBoxes().filter(cb => cb.checked).map(cb => cb.value);
    if (cats.length) p.set('category', cats.join(','));
    const q = (searchInput?.value || '').trim();
    if (q) p.set('search', q);
    if (sortSelect && sortSelect.value && sortSelect.value !== 'featured') p.set('sort', sortSelect.value);
    if (priceRange && Number(priceRange.value) < priceMax) p.set('max', priceRange.value);
    if (stockOnly && stockOnly.checked) p.set('stock', '1');
    const qs = p.toString();
    const url = location.pathname + (qs ? '?' + qs : '');
    /* replaceState, not push: dragging the price slider would otherwise stack
       a hundred history entries and make Back useless. */
    try { history.replaceState(null, '', url); } catch (e) { /* file:// */ }
  }

  /* Chips for what is currently narrowing the list. On a phone the sidebar is
     collapsed by default, so without these there is no way to see — or undo —
     a filter that is hiding products. */
  function renderChips() {
    if (!chipsEl) return;
    const chips = [];
    catBoxes().filter(cb => cb.checked).forEach(cb => {
      const label = (cb.parentElement.textContent || cb.value).trim();
      chips.push({ label, kind: 'cat', value: cb.value });
    });
    const q = (searchInput?.value || '').trim();
    if (q) chips.push({ label: `“${q}”`, kind: 'search' });
    if (priceRange && Number(priceRange.value) < priceMax) {
      chips.push({ label: `Under ${formatPrice(Number(priceRange.value))}`, kind: 'price' });
    }
    if (stockOnly && stockOnly.checked) chips.push({ label: 'In stock only', kind: 'stock' });

    if (!chips.length) { chipsEl.innerHTML = ''; chipsEl.hidden = true; return; }
    chipsEl.hidden = false;
    chipsEl.innerHTML =
      chips.map(c => `<button type="button" class="filter-chip" data-kind="${c.kind}"${
        c.value ? ` data-value="${escapeHtml(c.value)}"` : ''
      } aria-label="Remove filter ${escapeHtml(c.label)}">${escapeHtml(c.label)}<span aria-hidden="true">&times;</span></button>`).join('') +
      `<button type="button" class="filter-chip chip-clear" data-kind="all">Clear all</button>`;
  }

  function clearFilter(kind, value) {
    if (kind === 'all') {
      catBoxes().forEach(cb => { cb.checked = false; });
      if (searchInput) searchInput.value = '';
      if (priceRange) priceRange.value = priceRange.max;
      if (stockOnly) stockOnly.checked = false;
    } else if (kind === 'cat') {
      catBoxes().forEach(cb => { if (cb.value === value) cb.checked = false; });
    } else if (kind === 'search' && searchInput) { searchInput.value = ''; }
    else if (kind === 'price' && priceRange) { priceRange.value = priceRange.max; }
    else if (kind === 'stock' && stockOnly) { stockOnly.checked = false; }
    apply();
  }

  if (chipsEl) {
    chipsEl.addEventListener('click', e => {
      const b = e.target.closest('.filter-chip');
      if (b) clearFilter(b.dataset.kind, b.dataset.value);
    });
  }

  function apply() {
    let list = PRODUCTS.slice();
    // category
    const checked = catBoxes().filter(cb => cb.checked).map(cb => cb.value);
    if (checked.length) list = list.filter(p => checked.includes(p.category));
    // search
    const q = (searchInput?.value || '').trim().toLowerCase();
    if (q) list = list.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.categoryName.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q));
    // price
    if (priceRange) {
      const max = Number(priceRange.value);
      list = list.filter(p => p.price <= max);
      if (priceVal) priceVal.textContent = formatPrice(max);
    }
    // stock
    if (stockOnly && stockOnly.checked) list = list.filter(p => p.inStock);
    // sort
    const sort = sortSelect?.value || 'featured';
    if (sort === 'price-low') list.sort((a, b) => a.price - b.price);
    else if (sort === 'price-high') list.sort((a, b) => b.price - a.price);
    else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => (b.featured === a.featured) ? 0 : b.featured ? 1 : -1);

    renderProducts(list, grid);
    if (countEl) countEl.textContent = `${list.length} product${list.length === 1 ? '' : 's'}`;
    renderChips();
    writeStateToUrl();

    // the empty state offers the only escape from a filter set that hides everything
    const emptyBtn = document.getElementById('clearFiltersEmpty');
    if (emptyBtn) emptyBtn.addEventListener('click', () => clearFilter('all'));
  }

  catBoxes().forEach(cb => cb.addEventListener('change', apply));
  sortSelect && sortSelect.addEventListener('change', apply);
  searchInput && searchInput.addEventListener('input', apply);
  priceRange && priceRange.addEventListener('input', apply);
  stockOnly && stockOnly.addEventListener('change', apply);
  // Back/Forward past our replaceState (or a pasted link) re-reads the state
  window.addEventListener('popstate', () => { readStateFromUrl(); apply(); });

  const clearBtn = document.getElementById('clearFiltersBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => clearFilter('all'));
  if (searchInput && !searchInput.getAttribute('aria-label')) {
    searchInput.setAttribute('aria-label', 'Search the catalog');
  }

  /* Mobile filter toggle. Below the 1024px breakpoint the sidebar is stacked
     ABOVE the results, so leaving it open pushed the first product a full
     screen down on a phone — it starts collapsed there and the Filters button
     (which only exists at that size) opens it. Resizing past the breakpoint
     drops the class, since the desktop layout has a column for it. */
  const ftBtn = document.getElementById('filterToggle');
  const sidebar = document.getElementById('filtersSidebar');
  if (ftBtn && sidebar) {
    const narrow = window.matchMedia('(max-width: 1024px)');
    const syncSidebar = () => sidebar.classList.toggle('collapsed', narrow.matches);
    syncSidebar();
    narrow.addEventListener ? narrow.addEventListener('change', syncSidebar)
                            : narrow.addListener(syncSidebar);   // older Safari
    ftBtn.addEventListener('click', () => sidebar.classList.toggle('collapsed'));
  }

  // expose the re-filter so the catalog can repaint after products load from the API
  window._applyProductFilters = apply;
  apply();
}

/* ============================================================
   DYNAMIC CATALOG — products are admin-managed on the server.
   We render instantly from the built-in static catalog, then pull
   the live catalog from the API and repaint (so admin adds/edits
   show up). Falls back to static silently if the API is unreachable.
   ============================================================ */
function loadProducts() {
  if (typeof fetch === 'undefined' || !Array.isArray(window.PRODUCTS)) return;
  fetch(API_BASE + '/api/products')
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (!data || !Array.isArray(data.products) || !data.products.length) return;
      // Mutate the SAME array in place so the getProductById/getFeatured…
      // helpers (which close over it) see the live data.
      window.PRODUCTS.length = 0;
      window.PRODUCTS.push(...data.products);
      /* The cart caches the price each item was added at. Now that the live
         catalog is here, correct those caches BEFORE anything repaints — an
         old cart otherwise shows a total the server will not honour. */
      if (window.cart && typeof window.cart.syncPrices === 'function') {
        window.cart.syncPrices(window.PRODUCTS);
      }
      rerenderProducts();
    })
    .catch(() => { /* offline / cold start → keep the static catalog */ });
}

function rerenderProducts() {
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (page === '' || page === 'index.html') {
    displayFeaturedProducts();
    displayCategories();
  } else if (page === 'products.html') {
    if (typeof window._applyProductFilters === 'function') window._applyProductFilters();
    else initProductsPage();
  } else if (page === 'product.html') {
    initProductDetailPage();
  } else if (page === 'cart.html') {
    // These two price from the cart, so they have to repaint when the
    // catalog lands — otherwise the page keeps showing the old figure.
    if (typeof renderCartPage === 'function') renderCartPage();
  } else if (page === 'checkout.html') {
    const summary = document.getElementById('orderSummary');
    if (summary && typeof renderOrderSummary === 'function') renderOrderSummary(summary, true);
  }
}

/* ============================================================
   PRODUCT DETAIL PAGE
   ============================================================ */
/* ============================================================
   CERTIFICATE OF ANALYSIS — shown on every product page
   Every listed material carries its lot's third-party report here, so a
   buyer never has to go looking for it. What's printed is exactly what the
   report says (see products-data.js). Where a report has not been published
   for the current batch we say so plainly rather than implying one exists.
   ============================================================ */
function coaRow(label, value) {
  if (!value) return '';
  return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
}

/* `opts.modal` drops the id: the quick-view modal renders this same panel, and
   two #coa targets on one document would make the fragment ambiguous. */
function coaPanel(product, opts = {}) {
  const coa = product && product.coa;
  const idAttr = opts.modal ? '' : ' id="coa"';

  /* Some items will never have a COA — a plain laboratory consumable is not a
     peptide, so identity and purity analysis does not apply. Calling that
     "pending" would imply a report is coming, so it gets its own state rather
     than being lumped in with the unreleased lots. */
  if (coa && coa.status === 'not-applicable') {
    return `
      <section class="coa-panel glass"${idAttr}>
        <div class="coa-head">
          <h2>Certificate of Analysis</h2>
          <span class="coa-status coa-status-na">Not applicable</span>
        </div>
        <p class="coa-note">${escapeHtml(coa.note ||
          'This item is a laboratory reagent; peptide identity and purity analysis does not apply to it.')}</p>
        <p class="coa-note">Every peptide lot we list is documented — browse the published reports in the
           <a href="quality.html#coa-library">COA Library</a>.</p>
      </section>`;
  }

  if (!coa || coa.status !== 'available') {
    const note = (coa && coa.note) ||
      'An independent laboratory report for the current batch of this item has not been published yet.';
    return `
      <section class="coa-panel glass"${idAttr}>
        <div class="coa-head">
          <h2>Certificate of Analysis</h2>
          <span class="coa-status coa-status-pending">Pending</span>
        </div>
        <p class="coa-note">${escapeHtml(note)}</p>
        <p class="coa-note">Need it before you order? <a href="contact.html?subject=coa">Request the report</a>
           and we'll send it as soon as it is released, or browse every published report in the
           <a href="quality.html#coa-library">COA Library</a>.</p>
      </section>`;
  }

  return `
    <section class="coa-panel glass"${idAttr}>
      <div class="coa-head">
        <h2>Certificate of Analysis</h2>
        <span class="coa-status coa-status-available">Available</span>
      </div>
      <p class="coa-note">Third-party analysis of the batch supplied for this listing, issued by
         ${escapeHtml(coa.lab || 'an independent laboratory')}.</p>
      ${coa.note ? `<p class="coa-note coa-scope">${escapeHtml(coa.note)}</p>` : ''}
      <table class="specs-table coa-table"><tbody>
        ${coaRow('Laboratory', coa.lab)}
        ${coaRow('Report ID', coa.reportId)}
        ${coaRow('Batch analyzed', coa.batch)}
        ${coaRow('Method', coa.method)}
        ${coaRow('Sample received', coa.testDate)}
        ${coaRow('Report issued', coa.reportDate)}
        ${coaRow('Purity', coa.purity)}
        ${coaRow('Measured content', coa.content)}
      </tbody></table>
      ${coaDocument(coa)}
      <div class="coa-actions">
        ${coa.file ? `<a class="btn btn-primary btn-sm coa-file-link" href="${escapeHtml(coa.file)}" target="_blank" rel="noopener" hidden>Open full report</a>` : ''}
        ${coaVerifyLink(coa)}
        <a class="btn btn-ghost btn-sm" href="quality.html#coa-library">All published reports</a>
      </div>
    </section>`;
}

/* ---- the document itself ----
   "Viewable" means you can look at the certificate, not read a description of
   it. The figure starts empty and hidden; revealCoaDocument() finds whichever
   file is actually on the server and fills it in — an image renders inline
   (click for full size), a PDF gets an embedded viewer with a link fallback. */
function coaDocument(coa) {
  if (!coa.file) return '';
  /* On the detail page the document itself is shown in the gallery above, so
     the panel keeps only the data table and actions — no second copy. */
  return `<figure class="coa-doc" hidden data-gallery-owned></figure>`;
}

/* Whatever format the lab sent is fine. We try the configured path first, then
   the usual alternatives on the same base name, so dropping in a PNG works
   even though the catalog says .pdf. */
const COA_FILE_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];

function coaFileCandidates(file) {
  const base = String(file).replace(/\.[a-z0-9]+$/i, '');
  const list = [file].concat(COA_FILE_EXTS.map(ext => base + ext));
  return list.filter((v, i) => list.indexOf(v) === i);   // dedupe, keep order
}

/* Does this file actually exist?
   Images are probed by LOADING them, not with fetch(HEAD): fetch throws on
   file:// (so the report vanished when the site was opened straight off disk)
   and some static hosts don't answer HEAD. An <img> probe works everywhere and
   warms the cache for the render that follows. PDFs can't load in an <img>, so
   those still use HEAD — and simply stay hidden if it's blocked. */
function coaFileExists(url) {
  if (/\.pdf($|\?)/i.test(url)) {
    return fetch(url, { method: 'HEAD' }).then(r => r.ok).catch(() => false);
  }
  return new Promise(resolve => {
    const probe = new Image();
    probe.onload = () => resolve(probe.naturalWidth > 0);
    probe.onerror = () => resolve(false);
    probe.src = url;
  });
}

function coaDocumentMarkup(url, coa) {
  const src = escapeHtml(url);
  const label = escapeHtml(
    `Certificate of analysis, report ${coa.reportId || ''}, batch ${coa.batch || ''}`.trim());

  const inner = /\.pdf($|\?)/i.test(url)
    ? `<object class="coa-doc-pdf" data="${src}" type="application/pdf" aria-label="${label}">
         <p class="coa-note">Your browser can't display the PDF inline —
            <a href="${src}" target="_blank" rel="noopener">open the report in a new tab</a>.</p>
       </object>`
    : `<a href="${src}" target="_blank" rel="noopener" class="coa-doc-zoom">
         <img class="coa-doc-img" src="${src}" alt="${label}" loading="lazy" decoding="async">
         <span class="coa-doc-hint">Click to view full size</span>
       </a>`;

  return `${inner}<figcaption class="coa-doc-cap">Original report as issued by
    ${escapeHtml(coa.lab || 'the laboratory')}.</figcaption>`;
}

/* Prefer a deep link straight to the archived report
   (verify.janoshik.com/tests/<task>-<compound>_<size>_<KEY> — the key is
   printed on the report itself). Without one, send people to the verification
   form and tell them the task number to type in, rather than to a homepage
   that does nothing.

   The lab is not always Janoshik — the Ipamorelin / CJC-1295 report is from
   Ozcanium Analytics, which has no task-number lookup. Sending its verification
   code to janoshik.com/verify would fail on the first click, so a non-Janoshik
   report links to its own issuing lab instead. */
function coaVerifyLink(coa) {
  const deep = coa.verifyUrl && /\/tests\//.test(coa.verifyUrl);
  if (deep) {
    return `<a class="btn btn-ghost btn-sm" href="${escapeHtml(coa.verifyUrl)}" target="_blank" rel="noopener">Verify ${escapeHtml(coa.reportId || '')} at ${escapeHtml(hostOf(coa.verifyUrl))}</a>`;
  }
  if (!coa.reportId) return '';
  if (!coa.lab || /janoshik/i.test(coa.lab)) {
    return `<a class="btn btn-ghost btn-sm" href="https://janoshik.com/verify" target="_blank" rel="noopener">Verify ${escapeHtml(coa.reportId)} at janoshik.com</a>`;
  }
  if (!coa.verifyUrl) return '';
  return `<a class="btn btn-ghost btn-sm" href="${escapeHtml(coa.verifyUrl)}" target="_blank" rel="noopener">Verify ${escapeHtml(coa.reportId)} with ${escapeHtml(coa.lab)}</a>`;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
}

/* Only show the report once it's actually on the server. A dead link or a
   broken image is worse than none, and this way the document appears by
   itself the moment the file is uploaded — no code change needed.
   Candidates are tried in order and we stop at the first one that exists. */
async function revealCoaDocument(root, coa) {
  const scope = root || document;
  const link = scope.querySelector('.coa-file-link');
  const fig = scope.querySelector('.coa-doc');
  if (!link || !coa || !coa.file) return;

  for (const url of coaFileCandidates(coa.file)) {
    const ok = await coaFileExists(url);
    if (!ok) continue;
    link.href = url;
    link.hidden = false;
    // only render the inline figure where there is no gallery to own the document
    if (fig && !scope.querySelector('.detail-view-coa')) {
      fig.innerHTML = coaDocumentMarkup(url, coa);
      fig.hidden = false;
    }

    /* Gallery (product detail page): fill the COA view + its thumbnail and
       let them out of hiding. A PDF can't be shown in an <img>, so there the
       thumb opens the file directly rather than switching the view. */
    const view = scope.querySelector('.detail-view-coa');
    const thumb = scope.querySelector('.detail-thumb-coa');
    if (view && thumb) {
      const isPdf = /\.pdf($|\?)/i.test(url);
      thumb.hidden = false;
      if (isPdf) {
        thumb.dataset.view = '';
        thumb.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
        thumb.querySelector('img').replaceWith(Object.assign(document.createElement('span'), { textContent: 'PDF' }));
      } else {
        view.querySelector('.detail-coa-img').src = url;
        thumb.querySelector('img').src = url;
      }
    }
    return;
  }
}

/* Thumbnail switching for the detail gallery. Delegated, so it works no matter
   when the COA thumb is revealed. */
function initDetailGallery(root) {
  const thumbs = root.querySelector('.detail-thumbs');
  if (thumbs) {
    thumbs.addEventListener('click', (e) => {
      const btn = e.target.closest('.detail-thumb');
      if (!btn || !btn.dataset.view) return;
      root.querySelectorAll('.detail-thumb').forEach(t => t.classList.toggle('is-active', t === btn));
      root.querySelectorAll('.detail-view').forEach(v =>
        v.classList.toggle('is-active', v.classList.contains('detail-view-' + btn.dataset.view)));
    });
  }
  const coaView = root.querySelector('.detail-view-coa');
  if (coaView) {
    coaView.addEventListener('click', () => {
      const img = coaView.querySelector('.detail-coa-img');
      if (img && img.src) openCoaLightbox(img.src, img.alt);
    });
  }
}

/* Set a <meta> by attribute+value, creating it if the page doesn't carry one. */
function setMetaContent(attr, key, value) {
  if (!value) return;
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', value);
}

/* ---- previous / next product ----
   Browsing the catalog shouldn't mean bouncing back to the grid between every
   item. Arrows sit at the edges of the viewport and wrap around the catalog,
   so there is never a dead end. Reads window.PRODUCTS (mutated in place by
   loadProducts) so the order matches whatever the server actually serves. */
/* Edge arrows to the previous / next product. `root` is whatever should own
   them — the detail page's container, or the modal element (they are
   position: fixed either way, so they pin to the viewport edges).
   Re-rendered on every swap, since which product is next changes. */
function renderProductNav(root, product) {
  const list = Array.isArray(window.PRODUCTS) ? window.PRODUCTS : [];
  root.querySelectorAll('.pdt-nav').forEach(el => el.remove());
  if (list.length < 2) return;
  const i = list.findIndex(p => Number(p.id) === Number(product.id));
  if (i === -1) return;

  const prev = list[(i - 1 + list.length) % list.length];
  const next = list[(i + 1) % list.length];
  const chevron = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  /* The href stays a real product URL in both hosts, so ctrl/middle-click still
     opens a tab; in the modal the click handler swaps in place instead. */
  const arrow = (p, dir, label) => `
    <a class="pdt-nav pdt-nav-${dir}" href="product.html?id=${p.id}" data-pdt-nav="${dir}"
       aria-label="${label}: ${escapeHtml(p.name)}" title="${escapeHtml(p.name)}">
      ${chevron(dir === 'prev' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6')}
      <span class="pdt-nav-name">${escapeHtml(p.name)}</span>
    </a>`;

  root.insertAdjacentHTML('beforeend',
    arrow(prev, 'prev', 'Previous product') + arrow(next, 'next', 'Next product'));

  // ← / → also move, but never while typing or with a modifier held
  if (!renderProductNav._keys) {
    renderProductNav._keys = true;
    document.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('.coa-lightbox')) return;   // lightbox is open
      const box = productModalOpen();
      const scope = box || document;
      const el = scope.querySelector(e.key === 'ArrowLeft' ? '.pdt-nav-prev' : '.pdt-nav-next');
      if (!el) return;
      // In the modal, stay in the modal.
      if (box) pdModalGo(new URL(el.href, location.href).searchParams.get('id'));
      else location.href = el.getAttribute('href');
    });
  }
}

/* ---- COA lightbox ----
   A report is only useful if you can read the small print, so the overlay
   opens fit-to-screen and a second click switches to 1:1 in a scrollable
   frame — centred on wherever you clicked. Esc or the backdrop closes it. */
function openCoaLightbox(src, alt) {
  const box = document.createElement('div');
  box.className = 'coa-lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', alt || 'Certificate of analysis');
  box.innerHTML = `
    <button type="button" class="coa-lightbox-close" aria-label="Close">&times;</button>
    <div class="coa-lightbox-scroll">
      <img class="coa-lightbox-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt || '')}">
    </div>
    <p class="coa-lightbox-hint">Click the report to zoom · Esc to close</p>`;

  const scroll = box.querySelector('.coa-lightbox-scroll');
  const img = box.querySelector('.coa-lightbox-img');

  const close = () => {
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('coa-lightbox-open');
    box.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  // zoom toggles between fit-to-screen and natural size, keeping the clicked
  // point under the cursor so you land on the row you were aiming at
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    const zoomed = box.classList.toggle('is-zoomed');
    if (!zoomed) return;
    const r = img.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    scroll.scrollLeft = fx * scroll.scrollWidth - scroll.clientWidth / 2;
    scroll.scrollTop  = fy * scroll.scrollHeight - scroll.clientHeight / 2;
  });

  box.addEventListener('click', close);                       // backdrop
  box.querySelector('.coa-lightbox-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.classList.add('coa-lightbox-open');
  document.body.appendChild(box);
  box.querySelector('.coa-lightbox-close').focus();
}

/* ============================================================
   PRODUCT DETAIL — one markup builder, two hosts
   The detail view is rendered both by product.html (its own page, which is what
   search engines and shared links get) and by the quick-view modal below. Both
   read from here so a change lands in both places; `opts.modal` only trims what
   does not belong in an overlay (the in-page #coa anchor, the id attribute that
   would then be duplicated).
   ============================================================ */
function productDetailMarkup(product, opts = {}) {
  const modal = !!opts.modal;
  const specsRows = Object.entries(product.specs || {})
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('');
  const oldPrice = product.originalPrice > product.price
    ? `<span class="detail-price-old">${formatPrice(product.originalPrice)}</span>` : '';
  const badge = product.badge ? `<span class="product-badge ${productBadgeClass(product.badge)}" style="position:static;display:inline-block">${escapeHtml(product.badge)}</span>` : '';
  const st = stockInfo(product);

  /* Gallery: the vial and its certificate are two views of the same panel,
     switched by the thumbnails underneath — so the report is visible right
     beside the product instead of below the fold. The COA view and its thumb
     stay hidden until revealCoaDocument() confirms the file is on the server. */
  const vialSrc = product.image || vialPhotoSrc(product.id);
  const heading = modal
    ? `<h2 class="pd-modal-title">${escapeHtml(product.name)}</h2>`
    : `<h1>${escapeHtml(product.name)}</h1>`;
  /* In the modal a fragment link would leave the overlay and scroll the page
     behind it, so the same affordance scrolls the panel instead. */
  const coaLink = modal
    ? `<button type="button" class="pd-coa-jump">Certificate of Analysis</button>`
    : `<a href="#coa">Certificate of Analysis</a>`;

  return `
    <div class="product-detail-side">
      <div class="product-detail-media glass">
        <div class="detail-view detail-view-vial is-active">${createVialPhoto(product, { width: VIAL_W.detail })}</div>
        <button type="button" class="detail-view detail-view-coa" hidden>
          <img class="detail-coa-img" alt="Certificate of analysis for ${escapeHtml(product.name)}">
          <span class="coa-doc-hint">Click to zoom</span>
        </button>
      </div>
      <div class="detail-thumbs">
        <button type="button" class="detail-thumb is-active" data-view="vial" aria-label="View the vial">
          <img src="${vialSrc}" alt="" loading="lazy" decoding="async" onerror="this.src='assets/vial.png?v=3'">
        </button>
        <button type="button" class="detail-thumb detail-thumb-coa" data-view="coa" hidden aria-label="View the certificate of analysis">
          <img alt="">
        </button>
      </div>
      ${coaPanel(product, { modal })}
    </div>
    <div class="product-detail-info">
      <span class="product-cat">${escapeHtml(product.categoryName)}</span> ${badge}
      ${heading}
      <div class="product-meta"><span>${escapeHtml(product.quantity)}</span><span>•</span><span>${purityMeta(product.purity)}</span><span>•</span><span>Lot ${escapeHtml(product.lot)}</span></div>
      <div class="detail-price-row">
        <span class="detail-price gradient-text">${formatPrice(product.price)}</span>
        ${oldPrice}
        <span class="stock-pill ${st.cls}">${st.label}</span>
      </div>
      <p class="detail-desc">${escapeHtml(product.description)}</p>
      <div class="qty-selector">
        <span>Quantity</span>
        <div class="qty-control">
          <button type="button" class="qty-minus" aria-label="Decrease">&minus;</button>
          <input type="number" class="qty-input" value="1" min="1"${st.left ? ` max="${st.left}"` : ''}
                 inputmode="numeric" aria-label="Quantity"${st.sellable ? '' : ' disabled'}>
          <button type="button" class="qty-plus" aria-label="Increase">+</button>
        </div>
        ${st.left !== null && st.sellable ? `<span class="qty-limit">${st.left} available</span>` : ''}
      </div>
      <div class="detail-cta">
        <button class="btn btn-primary btn-lg detail-add-btn" ${st.sellable ? '' : 'disabled aria-disabled="true"'}>${st.sellable ? 'Add to Cart' : 'Out of Stock'}</button>
        ${modal
          ? `<a class="btn btn-ghost btn-lg" href="product.html?id=${product.id}">Full details</a>`
          : `<a class="btn btn-ghost btn-lg" href="cart.html">View Cart</a>`}
      </div>
      <table class="specs-table"><tbody>${specsRows}</tbody></table>
      <div class="trust-badges-inline">
        <span>${iconCheck()} ${coaLink}</span>
        <span>${iconShield()} Third-party tested</span>
        <span>${iconTruck()} Tracked U.S. dispatch</span>
        <span>${iconBox()} In-vitro research use only</span>
      </div>
    </div>`;
}

/* Bring the markup to life. Everything is scoped to `root` (classes, not ids)
   so a modal opened over a page that already has a detail view cannot capture
   the other one's buttons. */
function wireProductDetail(root, product) {
  initDetailGallery(root);
  revealCoaDocument(root, product.coa);   // show the report only if the file is there

  /* Quantity controls. The ceiling is the smaller of the usual 99 and whatever
     stock is left, so the buyer can't build a line the checkout will only
     reject after they have filled in an address. The server re-checks and is
     authoritative — this just stops the pointless round trip. */
  const stock = stockInfo(product);
  const capacity = stock.left === null ? 99 : Math.min(99, stock.left);
  const qtyInput = root.querySelector('.qty-input');
  const clamp = () => {
    let v = parseInt(qtyInput.value, 10);
    if (isNaN(v) || v < 1) v = 1;
    if (v > capacity) v = capacity;
    qtyInput.value = v;
    return v;
  };
  root.querySelector('.qty-minus').addEventListener('click', () => { qtyInput.value = Math.max(1, (parseInt(qtyInput.value, 10) || 1) - 1); });
  root.querySelector('.qty-plus').addEventListener('click', () => {
    const next = Math.min(capacity, (parseInt(qtyInput.value, 10) || 1) + 1);
    qtyInput.value = next;
    const note = root.querySelector('.qty-limit');
    if (note && stock.left !== null && next >= capacity) note.classList.add('at-limit');
  });
  qtyInput.addEventListener('change', clamp);
  root.querySelector('.detail-add-btn').addEventListener('click', (e) => {
    if (!stockInfo(product).sellable) return;    // catalog may have repainted under us
    cart.addItem(product, clamp());
    pnCartCelebrate(e.currentTarget);   // resolves to .product-detail-media via fallback
  });

  const jump = root.querySelector('.pd-coa-jump');
  if (jump) {
    jump.addEventListener('click', () => {
      const panel = root.querySelector('.coa-panel');
      if (panel) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  // Detail vial: click/tap to play a one-shot wobble + shine (re-triggerable).
  // Not a link here, so a full keyframe is safe. Wrapper keeps pn-float; the
  // keyframe runs on the inner img + ::before shine, toggled via .pn-poke.
  const detailVial = root.querySelector('.product-detail-media .vial-photo');
  if (detailVial) {
    detailVial.setAttribute('role', 'button');
    detailVial.setAttribute('tabindex', '0');
    detailVial.setAttribute('aria-label', `Inspect ${product.name} vial`);
    const pokeVial = () => {
      detailVial.classList.remove('pn-poke');
      void detailVial.offsetWidth;          // force reflow so the animation replays
      detailVial.classList.add('pn-poke');
    };
    detailVial.addEventListener('click', pokeVial);
    detailVial.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pokeVial(); }
    });
    // animationend fires for both pn-poke (img) and pn-shine (::before);
    // strip the class once either ends so the next click can replay (idempotent).
    detailVial.addEventListener('animationend', (e) => {
      if (e.animationName === 'pn-poke' || e.animationName === 'pn-shine') {
        detailVial.classList.remove('pn-poke');
      }
    });
  }
}

/* ============================================================
   PRODUCT QUICK-VIEW MODAL
   Clicking a product opens it in place instead of navigating away, so a browse
   → look → back loop costs no page loads and the catalog keeps its scroll
   position and filters.

   product.html is NOT replaced: it stays the canonical, crawlable page, the
   cards keep real hrefs, and a modifier- or middle-click still opens a tab. The
   modal pushes a history entry with the product's real URL, so Back closes it
   and a reload or a shared link lands on the full page.
   ============================================================ */
let pdModalRestoreFocus = null;

function productModalOpen() {
  return document.querySelector('.pd-modal');
}

function openProductModal(id) {
  const product = getProductById(id);
  // Unknown id (a catalog the API hasn't loaded yet) — let the page handle it.
  if (!product) { location.href = `product.html?id=${id}`; return false; }

  closeProductModal({ silent: true });
  pdModalRestoreFocus = document.activeElement;

  const box = document.createElement('div');
  box.className = 'pd-modal';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', `${product.name} — product details`);
  box.innerHTML = `
    <div class="pd-modal-backdrop"></div>
    <div class="pd-modal-panel glass" role="document">
      <button type="button" class="pd-modal-close" aria-label="Close">&times;</button>
      <div class="product-detail pd-modal-body"></div>
    </div>`;

  const body = box.querySelector('.pd-modal-body');
  body.innerHTML = productDetailMarkup(product, { modal: true });
  document.body.appendChild(box);
  document.body.classList.add('pd-modal-open');
  wireProductDetail(body, product);
  /* The arrows hang off the modal, not the body, so they sit above the backdrop
     and survive a swap of the content underneath them. */
  renderProductNav(box, product);

  box.querySelector('.pd-modal-close').addEventListener('click', () => closeProductModal());
  box.querySelector('.pd-modal-backdrop').addEventListener('click', () => closeProductModal());
  document.addEventListener('keydown', pdModalKey);

  /* The COA lightbox listens on document too and would otherwise close the
     modal underneath it, so Esc is handled in the lightbox's favour there. */
  try {
    history.pushState({ pdModal: product.id }, '', `product.html?id=${product.id}`);
  } catch (e) { /* file:// or a blocked history API — the modal still works */ }

  box.querySelector('.pd-modal-close').focus();
  return true;
}

/* Move to another product without tearing the overlay down: the panel keeps its
   place and only its contents change, which is the whole point of browsing in a
   modal. The URL is REPLACED, not pushed, so Back still closes the modal instead
   of walking back through every product that was looked at. */
function pdModalGo(id) {
  const box = productModalOpen();
  const product = getProductById(id);
  if (!box || !product) return false;

  const body = box.querySelector('.pd-modal-body');
  body.innerHTML = productDetailMarkup(product, { modal: true });
  wireProductDetail(body, product);
  renderProductNav(box, product);
  box.setAttribute('aria-label', `${product.name} — product details`);
  box.scrollTop = 0;

  try {
    history.replaceState({ pdModal: product.id }, '', `product.html?id=${product.id}`);
  } catch (e) { /* history blocked — the swap still stands */ }
  return true;
}

function pdModalKey(e) {
  if (e.key === 'Escape') {
    if (document.querySelector('.coa-lightbox')) return;   // lightbox closes first
    closeProductModal();
    return;
  }
  if (e.key !== 'Tab') return;

  /* Keep Tab inside the dialog. aria-modal="true" tells assistive tech the rest
     of the page is inert, but it does nothing to the actual tab order — without
     this, tabbing off the last control lands on the header behind the backdrop
     and the buyer is editing a page they cannot see. */
  const box = productModalOpen();
  if (!box || document.querySelector('.coa-lightbox')) return;
  const focusable = Array.from(box.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => el.offsetParent !== null || el === document.activeElement);
  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* `silent` skips the history rewind (used when replacing one modal with
   another); `fromPopstate` means the browser already moved us back. */
function closeProductModal(opts = {}) {
  const box = productModalOpen();
  if (!box) return;
  box.remove();
  document.body.classList.remove('pd-modal-open');
  document.removeEventListener('keydown', pdModalKey);
  if (pdModalRestoreFocus && pdModalRestoreFocus.focus) {
    try { pdModalRestoreFocus.focus(); } catch (e) {}
  }
  pdModalRestoreFocus = null;
  if (opts.silent || opts.fromPopstate) return;
  if (history.state && history.state.pdModal) history.back();
}

/* Card image, product name, "View", mini-cart and wishlist rows all point at
   product.html?id=N — intercepting the link itself covers every one of them,
   including cards rendered later from the API. */
function initProductQuickView() {
  // On product.html the full page IS the detail view; related products there
  // should navigate rather than stack a modal over an identical layout.
  if (currentPage.toLowerCase() === 'product.html') return;

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // open-in-new-tab
    const link = e.target.closest && e.target.closest('a[href*="product.html?id="]');
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
    const id = new URL(link.href, location.href).searchParams.get('id');
    if (!id) return;
    if (link.closest('.pd-modal')) {
      // Inside the overlay, only the prev/next arrows act — "Full details" leaves.
      if (link.hasAttribute('data-pdt-nav') && pdModalGo(id)) e.preventDefault();
      return;
    }
    /* A #coa link means "show me the certificate" — open the modal and switch
       the gallery to the report once it has been revealed. */
    const wantsCoa = /#coa$/.test(link.getAttribute('href') || '');
    if (!openProductModal(id)) return;
    e.preventDefault();
    if (wantsCoa) pdShowCoaWhenReady();
  });

  window.addEventListener('popstate', () => {
    if (productModalOpen()) closeProductModal({ fromPopstate: true });
  });
}

/* The COA thumb only exists once revealCoaDocument() has confirmed the file is
   on the server, which is a network round-trip after the modal opens. Poll
   briefly rather than guess a delay, and give up quietly if there is no report. */
function pdShowCoaWhenReady(tries = 20) {
  const thumb = document.querySelector('.pd-modal .detail-thumb-coa:not([hidden])');
  if (thumb) { thumb.click(); return; }
  if (tries <= 0) return;
  setTimeout(() => pdShowCoaWhenReady(tries - 1), 100);
}

function initProductDetailPage() {
  const root = document.getElementById('productDetail');
  if (!root) return;
  const id = new URLSearchParams(location.search).get('id') || 1;
  const product = getProductById(id);
  if (!product) {
    root.innerHTML = `<div class="empty-state"><div class="empty-icon">${iconFileQuestion()}</div><h3>Product not found</h3><p>This item may have been removed.</p><a class="btn btn-primary" href="products.html">Browse Catalog</a></div>`;
    return;
  }
  document.title = `${product.name} — Ever Nova Life`;

  /* The page ships with generic placeholders ("Product", "Detail") because it
     is one static file serving every SKU. Name the actual product here, so the
     breadcrumb, the shared-link preview and the canonical URL all agree with
     the BreadcrumbList JSON-LD below. */
  const crumb = document.getElementById('detailCrumb');
  if (crumb) crumb.textContent = product.name;

  const pageUrl = `https://evernovalife.com/product.html?id=${product.id}`;
  setMetaContent('property', 'og:title', `${product.name} — Ever Nova Life`);
  setMetaContent('name', 'twitter:title', `${product.name} — Ever Nova Life`);
  setMetaContent('property', 'og:description', product.description);
  setMetaContent('name', 'twitter:description', product.description);
  setMetaContent('name', 'description', product.description);
  setMetaContent('property', 'og:url', pageUrl);
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) canonical.href = pageUrl;

  // structured data for rich search results
  injectJSONLD(productSchema(product, pageUrl), 'ld-product');
  injectJSONLD({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://evernovalife.com/' },
      { '@type': 'ListItem', position: 2, name: 'Products', item: 'https://evernovalife.com/products.html' },
      { '@type': 'ListItem', position: 3, name: product.name }
    ]
  }, 'ld-breadcrumb');

  root.innerHTML = productDetailMarkup(product);
  wireProductDetail(root, product);
  renderProductNav(root, product);
  enlTrack('view_item', { product: product.name, category: product.categoryName || '' });

  // related products
  const relatedGrid = document.getElementById('relatedProducts');
  if (relatedGrid) {
    const related = PRODUCTS.filter(p => p.id !== product.id && p.category === product.category)
      .concat(PRODUCTS.filter(p => p.id !== product.id && p.category !== product.category))
      .slice(0, 3);
    renderProducts(related, relatedGrid);
  }
}

/* ============================================================
   CART PAGE
   ============================================================ */
function renderCartPage() {
  const root = document.getElementById('cartRoot');
  if (!root) return;

  if (cart.items.length === 0) {
    root.innerHTML = `
      <div class="empty-state glass">
        <div class="empty-icon">${iconCartOutline()}</div>
        <h3>Your nest is empty</h3>
        <p>Browse our research peptides and add something to get started.</p>
        <a class="btn btn-primary" href="products.html">Shop Products</a>
      </div>`;
    return;
  }

  const rows = cart.items.map(cartRowMarkup).join('');

  root.innerHTML = `
    <div class="cart-layout">
      <div class="cart-items">${rows}</div>
      <aside class="order-summary glass" id="orderSummary"></aside>
    </div>`;

  renderOrderSummary(document.getElementById('orderSummary'), true);
  bindCartControls();
}

function cartRowMarkup(item) {
  const product = getProductById(item.id) || item;
  const name = escapeHtml(item.name);
  const st = stockInfo(product);
  const cap = st.left === null ? 99 : Math.min(99, st.left);

  /* Stock can fall between adding to the cart and coming back to it — the count
     is server-side and other people buy. Say so on the line rather than letting
     checkout be the first place they hear about it. */
  let warn = '';
  if (!st.sellable) warn = `<p class="cart-row-warn">${iconAlert()} Out of stock — remove this line to continue.</p>`;
  else if (st.left !== null && item.quantity > st.left) warn = `<p class="cart-row-warn">${iconAlert()} Only ${st.left} left — lower the quantity to continue.</p>`;

  return `
    <div class="cart-row glass${warn ? ' has-warn' : ''}" data-id="${item.id}">
      <div class="cart-row-media">${createVialPhoto(product, { width: VIAL_W.thumb })}</div>
      <div class="cart-row-info">
        <span class="product-cat">${escapeHtml(item.category || '')}</span>
        <h4><a href="product.html?id=${item.id}">${name}</a></h4>
        <div class="cart-price gradient-text">${formatPrice(item.price)}</div>
        ${warn}
      </div>
      <div class="cart-row-controls">
        <div class="qty-control">
          <button type="button" class="cart-minus" data-id="${item.id}" aria-label="Decrease quantity of ${name}">&minus;</button>
          <input type="number" class="cart-qty" data-id="${item.id}" value="${item.quantity}"
                 min="1" max="${cap}" step="1" inputmode="numeric" aria-label="Quantity of ${name}">
          <button type="button" class="cart-plus" data-id="${item.id}" aria-label="Increase quantity of ${name}"${item.quantity >= cap ? ' disabled' : ''}>+</button>
        </div>
        <button class="cart-remove" data-id="${item.id}" aria-label="Remove ${name} from cart">${iconTrash()} Remove</button>
      </div>
    </div>`;
}

/* Update one line and the totals in place.
   The old code called renderCartPage() after every ± tap, which threw away and
   rebuilt the whole page: focus left the button being clicked (so a second tap
   went nowhere on a keyboard), the scroll position jumped on long carts, and
   every vial image was re-decoded. Removing a line is the only case that still
   needs a full repaint, and only when it empties the cart. */
function patchCartRow(id) {
  const item = cart.items.find(i => i.id === Number(id));
  const row = document.querySelector(`.cart-row[data-id="${id}"]`);
  if (!item || !row) { renderCartPage(); return; }

  const st = stockInfo(getProductById(item.id) || item);
  const cap = st.left === null ? 99 : Math.min(99, st.left);

  const qty = row.querySelector('.cart-qty');
  if (qty) {
    if (String(qty.value) !== String(item.quantity)) qty.value = item.quantity;
    qty.max = cap;
  }
  const plus = row.querySelector('.cart-plus');
  if (plus) plus.disabled = item.quantity >= cap;

  /* The over-stock warning is edited in place, not re-rendered with the row —
     replacing the node here would throw away the focus that patching exists to
     keep (see the note on bindCartControls). */
  let warn = row.querySelector('.cart-row-warn');
  let text = '';
  if (!st.sellable) text = 'Out of stock — remove this line to continue.';
  else if (st.left !== null && item.quantity > st.left) text = `Only ${st.left} left — lower the quantity to continue.`;
  if (text) {
    if (!warn) {
      warn = document.createElement('p');
      warn.className = 'cart-row-warn';
      row.querySelector('.cart-row-info').appendChild(warn);
    }
    warn.innerHTML = iconAlert() + ' ' + escapeHtml(text);
  } else if (warn) { warn.remove(); }
  row.classList.toggle('has-warn', !!text);

  renderOrderSummary(document.getElementById('orderSummary'), true);
}

function bindCartControls() {
  const root = document.getElementById('cartRoot');
  if (!root || root._cartBound) return;
  root._cartBound = true;

  /* Delegated once on the container, so rows added by a later server sync are
     already live without another pass of addEventListener. */
  root.addEventListener('click', e => {
    const btn = e.target.closest('.cart-plus, .cart-minus, .cart-remove');
    if (!btn) return;
    const id = btn.dataset.id;
    const item = cart.items.find(i => i.id === Number(id));
    if (!item) return;

    if (btn.classList.contains('cart-remove')) {
      const name = item.name;
      cart.removeItem(id);
      const row = btn.closest('.cart-row');
      if (!cart.items.length) { renderCartPage(); }
      else {
        if (row) row.remove();
        renderOrderSummary(document.getElementById('orderSummary'), true);
      }
      cart.showNotification(`${name} removed from cart`);
      return;
    }

    const up = btn.classList.contains('cart-plus');
    if (up) {
      const st = stockInfo(getProductById(item.id) || item);
      const cap = st.left === null ? 99 : Math.min(99, st.left);
      if (item.quantity >= cap) {
        cart.showNotification(st.left === null
          ? `99 is the most you can order of ${item.name}`
          : `Only ${st.left} left of ${item.name}`);
        return;
      }
    }
    const next = item.quantity + (up ? 1 : -1);
    if (next < 1) {                       // stepping below 1 is a removal
      const name = item.name;
      cart.removeItem(id);
      const row = btn.closest('.cart-row');
      if (!cart.items.length) renderCartPage();
      else {
        if (row) row.remove();
        renderOrderSummary(document.getElementById('orderSummary'), true);
      }
      cart.showNotification(`${name} removed from cart`);
      return;
    }
    cart.updateQuantity(id, next);
    patchCartRow(id);
  });

  root.addEventListener('change', e => {
    const inp = e.target.closest('.cart-qty');
    if (!inp) return;
    cart.updateQuantity(inp.dataset.id, inp.value);
    patchCartRow(inp.dataset.id);
  });
}

function renderOrderSummary(el, withCheckoutBtn) {
  if (!el) return;
  const ship = cart.getShipping();
  const remaining = FREE_SHIP_THRESHOLD - cart.getSubtotal();
  el.innerHTML = `
    <h3>Order Summary</h3>
    <div class="summary-row"><span>Subtotal (${cart.getItemCount()} items)</span><span>${formatPrice(cart.getSubtotal())}</span></div>
    <div class="summary-row"><span>Shipping</span><span>${ship === 0 ? 'FREE' : formatPrice(ship)}</span></div>
    <div class="summary-row"><span>Tax (${taxRateLabel()})</span><span>${formatPrice(cart.getTax())}</span></div>
    <div class="summary-row total"><span>Total</span><span>${formatPrice(cart.getTotal())}</span></div>
    ${remaining > 0 ? `<p class="summary-note"><span class="summary-note-ic">${iconTruckLine()}</span>Add ${formatPrice(remaining)} more for free shipping</p>` : `<p class="summary-note"><span class="summary-note-ic">${iconCheckCircle()}</span>Free shipping unlocked</p>`}
    ${withCheckoutBtn ? `<a class="btn btn-primary btn-block" href="${checkoutHref()}">Proceed to Checkout</a>` : ''}
    ${withCheckoutBtn && !isSignedIn()
      ? `<p class="summary-note">An account is required to check out — you'll be asked to sign in or register next.</p>` : ''}
    <p class="summary-note"><span class="summary-note-ic">${iconLock()}</span>Secure checkout · Research use only</p>`;
}

/* The rate label has to follow TAX_RATE in cart.js. It was written as a
   literal "8%" next to a figure computed from the constant, so changing the
   rate would have printed a number that contradicted its own label. */
function taxRateLabel() {
  const r = (typeof TAX_RATE === 'number' ? TAX_RATE : 0.08) * 100;
  return (Math.round(r * 100) / 100) + '%';
}

/* ---- account state, read straight from storage (auth.js isn't loaded on
   every page, but the token it writes is always there). ---- */
function isSignedIn() {
  try { return !!(localStorage.getItem('enl_token') || ''); } catch (e) { return false; }
}

/* Checkout requires an account, so send signed-out buyers to sign in first
   and bring them straight back. */
function checkoutHref() {
  return isSignedIn() ? 'checkout.html' : 'login.html?next=checkout.html';
}

/* ============================================================
   CHECKOUT PAGE
   Two payment paths, neither of which takes money on this page:
     · Bitcoin / Lightning — our backend opens a BTCPay invoice and
       we redirect to it; the buyer pays on BTCPay's hosted page
     · Zelle — the buyer transfers from their own bank; we just
       place the order and show them the details
   Both are priced entirely on the server. Nothing resembling a
   payment credential is ever handled here.
   ============================================================ */
const API_BASE = (typeof window !== 'undefined' && window.PEPTIDE_API_BASE) || '';

/* ============================================================
   HEADER AUTH — show the signed-in user's name in the top bar,
   plus an Admin button when the account is an admin. Runs on
   every page (main.js is loaded everywhere) and reads the user
   auth.js caches in localStorage, then refreshes it in the
   background so name/admin status stay current without re-login.
   ============================================================ */
function readEnlUser() {
  try { return JSON.parse(localStorage.getItem('enl_user') || 'null'); } catch (e) { return null; }
}
function readEnlToken() {
  try { return localStorage.getItem('enl_token') || ''; } catch (e) { return ''; }
}

function renderHeaderAuth() {
  const actions = document.querySelector('.header-actions');
  if (!actions) return;
  const user = readEnlUser();
  const token = readEnlToken();
  const acctLink = actions.querySelector('a[aria-label="Account"]');

  // remove anything we injected before, so re-running never duplicates
  actions.querySelectorAll('.header-user, .header-admin-btn').forEach(el => el.remove());

  if (!token || !user) {
    if (acctLink) acctLink.setAttribute('href', 'login.html');   // signed out → sign in
    return;
  }
  if (acctLink) acctLink.setAttribute('href', 'account.html');

  const name = (user.firstName || '').trim() || String(user.email || '').split('@')[0] || 'Account';
  const nameLink = document.createElement('a');
  nameLink.className = 'header-user';
  nameLink.href = 'account.html';
  nameLink.title = 'My account';
  nameLink.textContent = 'Hi, ' + name;
  if (acctLink) actions.insertBefore(nameLink, acctLink);
  else actions.insertBefore(nameLink, actions.firstChild);

  if (user.isAdmin) {
    const admin = document.createElement('a');
    admin.className = 'header-admin-btn';
    admin.href = 'admin.html';
    admin.title = 'Admin — manage users';
    admin.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V5l-8-3Z"/><path d="M9 12l2 2 4-4"/></svg><span>Admin</span>';
    actions.insertBefore(admin, nameLink);
  }
}

/* Confirm the token with the backend and refresh the cached user, so the
   header (name + admin button) reflects the truth without a re-login. */
function refreshHeaderUser() {
  const token = readEnlToken();
  if (!token || typeof fetch === 'undefined') return;
  fetch(API_BASE + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })
    .then(res => {
      if (res.status === 401) {   // token expired/invalid → drop it, show signed-out
        try { localStorage.removeItem('enl_token'); localStorage.removeItem('enl_user'); } catch (e) {}
        renderHeaderAuth();
        return null;
      }
      return res.ok ? res.json() : null;
    })
    .then(data => {
      if (data && data.user) {
        try { localStorage.setItem('enl_user', JSON.stringify(data.user)); } catch (e) {}
        renderHeaderAuth();
      }
    })
    .catch(() => { /* offline → keep whatever the cache showed */ });
}

/* The login token auth.js stores, so a signed-in buyer's order gets tied
   to their account. Empty for guests (guest checkout still works). Read
   from localStorage directly since auth.js isn't loaded on checkout.html. */
function authHeader() {
  let token = '';
  try { token = localStorage.getItem('enl_token') || ''; } catch (e) {}
  return token ? { Authorization: 'Bearer ' + token } : {};
}

function checkoutSetMsg(text, kind) {
  const msg = document.getElementById('checkoutMsg');
  if (!msg) return;
  msg.className = 'form-msg' + (kind ? ' ' + kind : '');
  /* A payment failing is not something to find out about by looking — assertive
     so it interrupts, polite for the ordinary progress lines. */
  msg.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  msg.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  msg.textContent = text || '';
}

/* read the contact + shipping fields the backend needs */
function collectCheckout(form) {
  const v = name => (form.elements[name] && form.elements[name].value || '').trim();
  const cc = v('country');
  return {
    email: v('email'),
    name: (v('firstName') + ' ' + v('lastName')).trim(),
    // Required research qualification — recorded with the order.
    institution: v('institution'),
    researchField: v('researchField'),
    address: v('address'),
    city: v('city'),
    state: v('state'),
    postalCode: v('postalCode'),
    // We ship to the U.S. only, so this is always 'US'. The field is still read
    // (rather than hardcoded blindly) so the form stays the single source of
    // truth — and the server re-checks it either way.
    countryCode: /^[A-Z]{2}$/.test(cc) ? cc : 'US'
  };
}

/* ============================================================
   LOYALTY POINTS — redeem at checkout
   Signed-in buyers with a points balance can apply it as money off.
   The discount is folded into the invoice amount, but the SERVER
   re-prices authoritatively; it holds the points when the order opens
   and hands them back if the invoice is never paid. State lives in
   window._enlRedeem so the summary and the pay button agree.
   ============================================================ */
function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }
function enlRedeem() { return window._enlRedeem || { points: 0, discount: 0 }; }

/* Checkout totals mirroring the server's pricing (server stays authoritative
   for the actual charge). The discount lowers the taxable subtotal; free
   shipping is still decided on the pre-discount subtotal. */
function checkoutTotals() {
  /* Prefer the server's own numbers when it has quoted this cart — they are
     the ones the invoice will use, down to how shipping and tax round. */
  const q = window._enlQuote;
  const subtotal = round2(q ? q.subtotal : cart.getSubtotal());
  const discount = round2(Math.min(enlRedeem().discount || 0, subtotal));
  const shipping = round2(q ? q.shipping : cart.getShipping());
  // Which service the fee is for, so the summary can say "Shipping (Overnight)".
  const shippingLabel = (q && q.shippingLabel) || (cart.getShippingLabel ? cart.getShippingLabel() : '');
  const taxable = round2(Math.max(0, subtotal - discount));
  const tax = round2(taxable * TAX_RATE);
  return { subtotal, discount, shipping, shippingLabel, taxable, tax, total: round2(taxable + shipping + tax) };
}

/* The checkout line items, as their own function so a fresh server quote can
   repaint them instead of leaving old per-line prices under a corrected total. */
function renderCheckoutLineItems() {
  const el = document.getElementById('checkoutItems');
  if (!el) return;
  if (cart.items.length === 0) {
    el.innerHTML = `<p class="text-muted">Your cart is empty. <a href="products.html" style="color:var(--accent-purple)">Add products</a> to continue.</p>`;
    return;
  }
  el.innerHTML = cart.items.map(i =>
    `<div class="summary-row"><span>${escapeHtml(i.name)} × ${i.quantity}</span><span>${formatPrice(i.price * i.quantity)}</span></div>`).join('');
}

/* The published rate table on shipping.html, drawn from the same source that
   charges the customer. It used to be hand-written HTML, which is how the page
   came to advertise an Expedited and an Overnight service the checkout had no
   way to sell. The static rows in the page stay as the offline fallback. */
async function renderPublicRateTable() {
  const tbody = document.getElementById('rateRows');
  if (!tbody || typeof fetch === 'undefined') return;
  let methods;
  try {
    const res = await fetch(API_BASE + '/api/shipping');
    if (!res.ok) return;                              // keep the static rows
    const d = await res.json().catch(() => null);
    methods = d && d.success && Array.isArray(d.methods) ? d.methods : null;
  } catch (e) { return; }
  if (!methods || !methods.length) return;

  /* A method with a free-shipping threshold is TWO rows for the reader — what it
     costs, and the condition under which it costs nothing — because that is the
     question they came to the page with. */
  const rows = [];
  methods.forEach(m => {
    rows.push(`<tr><td>${escapeHtml(m.name)}</td><td>${escapeHtml(m.eta || '—')}</td>` +
      `<td>${formatPrice(Number(m.price) || 0)}</td></tr>`);
    if (Number(m.freeOver) > 0) {
      rows.push(`<tr><td>Free ${escapeHtml(m.name)} (orders over ${formatPrice(Number(m.freeOver))})</td>` +
        `<td>${escapeHtml(m.eta || '—')}</td><td>FREE</td></tr>`);
    }
  });
  tbody.innerHTML = rows.join('');
}

/* ============================================================
   DELIVERY SPEED
   The rates are owner-editable data now (admin → Shipping), so the
   options here are whatever the server says is enabled — the page
   never hard-codes a fee, and the amount charged is decided by the
   server from the method id alone.
   ============================================================ */
function enlShipChoice() {
  return (window.ENLShipping && window.ENLShipping.choice()) || '';
}

/* Load the enabled methods and preselect one. The server names the default so
   the browser can't pick the cheapest by accident (or on purpose). */
async function loadShippingMethods() {
  if (typeof fetch === 'undefined' || !window.ENLShipping) return null;
  let saved = '';
  try { saved = sessionStorage.getItem('enl_ship_method') || ''; } catch (e) {}
  try {
    const res = await fetch(API_BASE + '/api/shipping');
    if (!res.ok) return null;                       // older backend → flat rate as before
    const d = await res.json().catch(() => null);
    if (!d || !d.success || !Array.isArray(d.methods) || !d.methods.length) return null;
    const valid = saved && d.methods.some(m => m.id === saved) ? saved : (d.defaultMethod || d.methods[0].id);
    window.ENLShipping.setRates(d.methods, valid);
    return d;
  } catch (e) {
    return null;                                    // offline → flat rate as before
  }
}

/* One radio per enabled method. Rendered only when there is a real choice to
   make: a single method is not a decision, it's just a line on the bill. */
function renderShippingOptions(el) {
  if (!el || !window.ENLShipping) return;
  const rates = window.ENLShipping.rates();
  if (!rates || rates.length < 2) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const chosen = enlShipChoice();
  const subtotal = cart.getSubtotal();

  /* No step number on this heading: the section is hidden when there is only
     one service, and a numbered step that vanishes leaves a gap in the count. */
  el.innerHTML = `
    <h3 class="form-section-title">Delivery speed</h3>
    <div class="ship-options" role="radiogroup" aria-label="Delivery speed">
      ${rates.map(m => {
        const free = Number(m.freeOver) > 0 && subtotal >= Number(m.freeOver);
        const cost = free ? 'FREE' : formatPrice(Number(m.price) || 0);
        const note = !free && Number(m.freeOver) > 0
          ? `free over ${formatPrice(Number(m.freeOver))}` : '';
        return `<label class="ship-option${m.id === chosen ? ' selected' : ''}">
          <input type="radio" name="shipMethod" value="${escapeHtml(m.id)}" ${m.id === chosen ? 'checked' : ''}>
          <span class="ship-option-main">
            <span class="ship-option-name">${escapeHtml(m.name)}</span>
            ${m.eta ? `<span class="ship-option-eta">${escapeHtml(m.eta)}</span>` : ''}
          </span>
          <span class="ship-option-cost">${cost}${note ? `<span class="ship-option-note">${note}</span>` : ''}</span>
        </label>`;
      }).join('')}
    </div>`;

  el.querySelectorAll('input[name="shipMethod"]').forEach(input => {
    input.addEventListener('change', () => onShippingMethodChange(input.value, el));
  });
}

/* A new service means a new total, and the total has to come from the server —
   so re-quote, then repaint. Remembered for this tab only: a method chosen days
   ago shouldn't quietly upgrade a later order. */
async function onShippingMethodChange(id, el) {
  window.ENLShipping.setChoice(id);
  try { sessionStorage.setItem('enl_ship_method', id); } catch (e) {}
  renderShippingOptions(el);
  await loadCheckoutQuote();
  renderCheckoutSummary(document.getElementById('checkoutSummary'));
  renderCheckoutLineItems();
}

/* Ask the server what this cart actually costs.
   /api/quote runs the same buildOrder() the BTCPay invoice is built from, so
   whatever it returns is what the customer will be asked to pay. Its unit
   prices are written back into the cart, which makes the page's own totals
   agree with the invoice by construction rather than by coincidence.

   Offline or on an older backend (404) this simply does nothing and the cart's
   cached prices stand — the same behaviour as before the quote existed. */
async function loadCheckoutQuote() {
  if (!cart.items.length || typeof fetch === 'undefined') return null;
  try {
    const res = await fetch(API_BASE + '/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart.items.map(i => ({ id: i.id, quantity: i.quantity })),
        // Which delivery service, never its price — the server owns the rate.
        shippingMethod: enlShipChoice()
      })
    });
    if (!res.ok) return null;              // 400/404/409 → keep the local figures
    const q = await res.json().catch(() => null);
    if (!q || !q.success || !Array.isArray(q.items)) return null;

    window._enlQuote = q;
    cart.syncPrices(q.items.map(i => ({ id: i.id, name: i.name, price: i.unitPrice })));
    return q;
  } catch (e) {
    return null;                            // network error → cached prices stand
  }
}

/* Pull the signed-in buyer's points balance so we can offer redemption. */
async function loadCheckoutLoyalty() {
  let token = '';
  try { token = localStorage.getItem('enl_token') || ''; } catch (e) {}
  if (!token) return;
  try {
    const res = await fetch(API_BASE + '/api/loyalty', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return;
    const d = await res.json().catch(() => null);
    if (d && d.success) {
      window._enlLoyalty = {
        balance: Number(d.balance) || 0,
        dollarValue: Number(d.dollarValue) || 0,
        valueCents: Number(d.valueCents) > 0 ? Number(d.valueCents) : 1,
        perDollar: Number(d.perDollar) || 1
      };
    }
  } catch (e) { /* offline → no redeem control, checkout still works */ }
}

/* Render the checkout order summary (with the points-redeem control when the
   buyer is signed in and has a balance). Replaces renderOrderSummary here so
   the discount line + redeem toggle live in one place. */
function renderCheckoutSummary(el) {
  if (!el) return;
  const t = checkoutTotals();
  const loy = window._enlLoyalty;
  let signedIn = false;
  try { signedIn = !!(localStorage.getItem('enl_token') || ''); } catch (e) {}
  const canRedeem = signedIn && loy && loy.balance > 0 && t.subtotal > 0;
  const redeemActive = (enlRedeem().points || 0) > 0;
  const maxRedeem = canRedeem ? Math.min(loy.dollarValue, t.subtotal) : 0;

  el.innerHTML = `
    <div class="summary-row"><span>Subtotal (${cart.getItemCount()} items)</span><span>${formatPrice(t.subtotal)}</span></div>
    <div class="summary-row"><span>Shipping${t.shippingLabel ? ` (${escapeHtml(t.shippingLabel)})` : ''}</span><span>${t.shipping === 0 ? 'FREE' : formatPrice(t.shipping)}</span></div>
    ${t.discount > 0 ? `<div class="summary-row discount"><span>Points discount</span><span>−${formatPrice(t.discount)}</span></div>` : ''}
    <div class="summary-row"><span>Tax (${taxRateLabel()})</span><span>${formatPrice(t.tax)}</span></div>
    <div class="summary-row total"><span>Total</span><span>${formatPrice(t.total)}</span></div>
    ${canRedeem ? `
      <label class="loyalty-redeem-row">
        <input type="checkbox" id="redeemPoints" ${redeemActive ? 'checked' : ''}>
        <span>Use my <strong>${loy.balance} points</strong> (−${formatPrice(maxRedeem)})</span>
      </label>` : ''}
    ${redeemActive ? `<p class="summary-note">Points come off your <strong>Bitcoin / Lightning</strong> total. You'll still earn points on this order.</p>` : ''}
    <p class="summary-note"><span class="summary-note-ic">${iconLock()}</span>Secure checkout · Research use only</p>`;

  const chk = document.getElementById('redeemPoints');
  if (chk) chk.addEventListener('change', () => onRedeemToggle(chk.checked));

  // The auto-ship terms quote the order total, so keep them in step with it.
  updateAutoshipTerms();
}

/* Toggle points redemption on/off, then re-price everything: the summary, the
   pay button's amount, and which payment options still apply. */
function onRedeemToggle(checked) {
  const loy = window._enlLoyalty;
  if (checked && loy) {
    const subtotal = cart.getSubtotal();
    const discount = round2(Math.min(loy.dollarValue, subtotal));
    const valueCents = loy.valueCents > 0 ? loy.valueCents : 1;
    const points = Math.round((discount * 100) / valueCents);   // points matching the applied discount
    window._enlRedeem = { points, discount };
  } else {
    window._enlRedeem = { points: 0, discount: 0 };
  }
  renderCheckoutSummary(document.getElementById('checkoutSummary'));
  updateAltPayVisibility();
}

/* Keep the crypto button showing the amount it will actually invoice, so the
   discount and the button can never disagree. */
function updatePayButtonAmount() {
  const amt = document.getElementById('payBtnAmount');
  if (amt) amt.textContent = formatPrice(checkoutTotals().total);
}

/* Show or hide each payment option. Crypto is the primary path and handles
   everything — points discounts and auto-ship included. Zelle steps aside for
   both: the money arrives by hand, so there's no invoice to discount, and no
   way to schedule a repeat. Each option also respects what the server said it
   has configured (/api/health → window._cryptoAvailable / _zelleAvailable). */
function updateAltPayVisibility() {
  const wrap = document.getElementById('altPaySection');
  const crypto = document.getElementById('cryptoPaySection');
  const zelle = document.getElementById('zellePaySection');
  const divider = document.querySelector('#altPaySection .alt-pay-divider');
  const none = document.getElementById('noPayMethods');
  /* The authorization box belongs to the pay buttons — it authorizes THIS
     purchase — so it appears and disappears with them. */
  const auth = document.querySelector('.web-auth-box');

  // Nothing to pay for yet. This is re-checked on every call rather than
  // decided once at init: a signed-in buyer's cart arrives from their ACCOUNT
  // a moment after the page renders (a phone starts with an empty local
  // cache), and hiding the payment block permanently on that first empty
  // reading leaves them looking at their items with no way to pay.
  if (cart.items.length === 0) {
    if (wrap) wrap.style.display = 'none';
    if (auth) auth.style.display = 'none';
    return;
  }

  const zelleBlocked = (enlRedeem().points || 0) > 0 || autoshipSelection().enabled;

  const showCrypto = window._cryptoAvailable !== false;
  const showZelle = window._zelleAvailable !== false && !zelleBlocked;
  if (crypto) crypto.style.display = showCrypto ? '' : 'none';
  if (zelle) zelle.style.display = showZelle ? '' : 'none';
  // The divider only earns its place when there's something on both sides of it.
  if (divider) divider.style.display = (showCrypto && showZelle) ? '' : 'none';
  if (none) none.style.display = (showCrypto || showZelle) ? 'none' : '';
  if (wrap) wrap.style.display = '';
  // Only ask for the authorization when there is in fact a way to pay.
  if (auth) auth.style.display = (showCrypto || showZelle) ? '' : 'none';
  updatePayButtonAmount();
}

/* ============================================================
   AUTO-SHIP — opt in at checkout
   Ticking the box turns this order into a standing one: the same
   items every N days. Crypto can't be debited on a schedule, so
   each repeat arrives as an emailed invoice the buyer chooses to
   pay — which makes the terms easier to state honestly, not harder.
   The server schedules it; all this does is collect the choice.
   ============================================================ */
const AUTOSHIP_MIN_DAYS = 7;
const AUTOSHIP_MAX_DAYS = 180;

/* What the buyer has chosen, clamped. The server clamps again — this is only
   so the terms text on screen matches what will actually happen. */
function autoshipSelection() {
  const box = document.getElementById('autoshipCheck');
  const days = document.getElementById('autoshipDays');
  if (!box || !box.checked) return { enabled: false, intervalDays: 30 };
  const n = Math.round(Number(days && days.value));
  const intervalDays = Number.isFinite(n)
    ? Math.min(AUTOSHIP_MAX_DAYS, Math.max(AUTOSHIP_MIN_DAYS, n))
    : 30;
  return { enabled: true, intervalDays };
}

/* Spell out the repeat: how much, how often, starting when, and how to stop it.
   Shown before payment, not after. The one thing to keep unmissable is that
   nothing is ever taken automatically — that's the whole difference between
   this and a card subscription, and it's in the buyer's favour. */
function updateAutoshipTerms() {
  const el = document.getElementById('autoshipTerms');
  if (!el) return;
  const sel = autoshipSelection();
  const total = formatPrice(checkoutTotals().total);
  const every = sel.intervalDays === 1 ? 'day' : `${sel.intervalDays} days`;
  const first = new Date(Date.now() + sel.intervalDays * 86400000)
    .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  el.innerHTML =
    `We'll prepare these items <strong>every ${escapeHtml(every)}</strong> and email you a ` +
    `Bitcoin / Lightning invoice for <strong>about ${escapeHtml(total)}</strong>, starting ` +
    `<strong>${escapeHtml(first)}</strong>. <strong>Nothing is ever charged automatically</strong> — ` +
    `each shipment goes out once you pay its invoice, so skipping one costs you nothing. ` +
    `Prices are the rate in effect on each shipment date. We'll remind you 3 days beforehand, and you can ` +
    `change the frequency, skip a shipment, pause or cancel any time from ` +
    `<a href="account.html#autoship">your account</a> — no minimum, no cancellation fee.`;

  document.querySelectorAll('.autoship-preset').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.days) === sel.intervalDays);
  });
}

/* Show the panel to signed-in buyers, and the "sign in first" note to guests. */
function initAutoshipCheckout() {
  const box = document.getElementById('autoshipBox');
  if (!box) return;
  box.style.display = '';

  let signedIn = false;
  try { signedIn = !!(localStorage.getItem('enl_token') || ''); } catch (e) {}

  const toggle = document.getElementById('autoshipCheck');
  const detail = document.getElementById('autoshipDetail');
  const guest = document.getElementById('autoshipGuestHint');
  const days = document.getElementById('autoshipDays');

  if (!signedIn) {
    // A standing order needs an account to manage and cancel it.
    if (toggle) toggle.closest('.autoship-toggle').style.display = 'none';
    if (guest) guest.style.display = '';
    return;
  }

  const sync = () => {
    if (detail) detail.style.display = toggle && toggle.checked ? '' : 'none';
    updateAutoshipTerms();
    updateAltPayVisibility();
  };

  if (toggle) toggle.addEventListener('change', sync);
  if (days) {
    days.addEventListener('input', updateAutoshipTerms);
    // Clamp only on blur, so typing "9" on the way to "90" isn't fought.
    days.addEventListener('blur', () => {
      days.value = autoshipSelection().intervalDays;
      updateAutoshipTerms();
    });
  }
  document.querySelectorAll('.autoship-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      if (days) days.value = btn.dataset.days;
      updateAutoshipTerms();
    });
  });

  sync();
}

/* ---- Crypto (BTCPay) confirmation shown when the buyer is redirected
   back to checkout.html?paid=crypto after paying. `ref` is what we stashed
   before the redirect, so the confirmation can name the order and repeat the
   auto-ship terms they agreed to. ---- */
function showCryptoConfirmation(ref) {
  cart.clearCart();
  const wrap = document.getElementById('checkoutMain');
  if (!wrap) return;
  const sub = ref && ref.subscription;

  // Be straight about auto-ship either way: confirm the schedule when it's set
  // up, and say so plainly when it wasn't — never leave them assuming a repeat
  // order exists when it doesn't.
  let autoshipNote = '';
  if (sub) {
    const when = new Date(sub.nextRunAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const every = sub.intervalDays === 1 ? 'day' : `${sub.intervalDays} days`;
    autoshipNote = `<p class="text-muted"><span class="summary-note-ic">${iconRepeat()}</span><strong>Auto-ship is on.</strong> We'll prepare these items again every
      ${escapeHtml(every)} — next on <strong>${escapeHtml(when)}</strong> — and email you an invoice to pay each time,
      with a reminder 3 days before. Nothing is ever charged automatically.
      Change, skip or cancel any time in <a href="account.html#autoship" style="color:var(--accent-purple)">your account</a>.</p>`;
  } else if (ref && ref.autoshipFailed) {
    autoshipNote = `<p class="text-muted"><span class="summary-note-ic">${iconAlert()}</span>Your order went through, but we couldn't set up the auto-ship
      schedule. <strong>No repeating order has been created.</strong> You can start one from
      <a href="account.html#autoship" style="color:var(--accent-purple)">your account</a>, or contact us and we'll sort it out.</p>`;
  }

  wrap.innerHTML = `
    <div class="empty-state glass">
      <div class="empty-icon">${iconCheckCircle()}</div>
      <h3>Payment received — welcome to the Nest!</h3>
      <p>Thank you! Your crypto payment has been received${ref && ref.orderId
        ? ` — your order reference is <strong>${escapeHtml(ref.orderId)}</strong>` : ''}.
        On-chain payments may take a few minutes to fully confirm.</p>
      ${autoshipNote}
      <p class="text-muted">Once the transaction settles we'll ship to the address you provided. Keep your order reference for your records.</p>
      <a class="btn btn-primary" href="index.html">Back to Home</a>
    </div>`;
}

/* The server refuses a second, identical order while the first is still
   unpaid (409 + duplicateOf), because two live orders for one cart is how a
   payment ends up split across both. Offer the obvious thing first — go and
   finish the order they already have — and only then the deliberate override.

   Returns 'retry' to place it anyway, 'abort' otherwise. May navigate away. */
async function handleDuplicateOrder(body) {
  const due = Number(body.due) || 0;
  const finish = body.payUrl
    ? `\n\nPress OK to go and pay the ${formatPrice(due)} still owed on ${body.duplicateOf}.`
    : `\n\nThe payment details for ${body.duplicateOf} are in your email.`;
  const goFinish = window.confirm((body.error || 'You already have this order open.') + finish);
  if (goFinish) {
    if (body.payUrl) window.location.href = body.payUrl;
    return 'abort';
  }
  return window.confirm(
    `Place a SECOND, separate order for the same items?\n\n` +
    `You would owe both ${body.duplicateOf} and this new one — two payments, two parcels.`
  ) ? 'retry' : 'abort';
}

/* validate the form, open a BTCPay invoice on our server, then send the
   buyer to the hosted crypto checkout. Prices come from the server — the
   browser sends what it WANTS applied (points, a repeat interval) and the
   server decides what actually happens. */
async function submitCryptoOrder(form, btn) {
  if (cart.items.length === 0) { checkoutSetMsg('Your cart is empty.', 'error'); return; }
  if (!validateCheckout(form)) { checkoutSetMsg('Please complete the highlighted fields first.', 'error'); return; }
  checkoutSetMsg('');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Opening secure crypto checkout…';
  try {
    const checkout = collectCheckout(form);
    const payload = {
      items: cart.items.map(i => ({ id: i.id, quantity: i.quantity })),
      shipping: checkout,
      shippingMethod: enlShipChoice(),           // the service; the server sets its price
      email: checkout.email,
      pointsToRedeem: enlRedeem().points || 0,   // server clamps to the real balance
      autoship: autoshipSelection(),
      webAuthorization: webAuthorizationRecord(), // signature for this transaction
      declarations: declarationsRecord()          // terms + age/use conditions of sale
    };
    const post = () => fetch(API_BASE + '/api/crypto/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(payload)
    });
    let res = await post();
    let body = await res.json().catch(() => ({}));
    if (res.status === 409 && body.duplicateOf) {
      if (await handleDuplicateOrder(body) !== 'retry') {
        checkoutSetMsg(body.error, 'error');
        btn.disabled = false;
        btn.innerHTML = original;
        return;
      }
      payload.allowDuplicate = true;
      res = await post();
      body = await res.json().catch(() => ({}));
    }
    if (!res.ok || !body.checkoutLink) throw new Error(body.error || 'Could not start crypto checkout.');
    /* The last thing measurable from the browser. What happens after this is
       a wallet we can't see — whether it was paid is the server's to know. */
    enlTrack('payment_started', { method: 'crypto', items: cart.items.length });
    // Remember the order so we can show a proper confirmation on redirect back.
    // The subscription rides along because the confirmation is rendered after a
    // full page navigation, with none of this scope left.
    try {
      sessionStorage.setItem('enl_crypto_order', JSON.stringify({
        orderId: body.orderId,
        invoiceId: body.invoiceId,
        subscription: body.subscription || null,
        autoshipFailed: !!body.autoshipFailed
      }));
    } catch (e) {}
    window.location.href = body.checkoutLink;   // → hosted BTCPay invoice
  } catch (err) {
    console.error('[crypto checkout]', err);
    checkoutSetMsg((err && err.message) || 'Could not start crypto checkout. Please try again.', 'error');
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

/* ============================================================
   ZELLE — manual bank transfer
   There's no Zelle API to redirect to: the buyer sends the money
   themselves from their own banking app. So all this does is place
   the order (priced on the server) and then show them exactly who
   to pay, how much, and what memo to put on it. The order stays
   unpaid until the store owner confirms the transfer landed.
   ============================================================ */

/* The screen the buyer works from while they make the transfer. Deliberately
   plain and copyable — they're about to retype these details into a banking
   app, and a typo in the memo is what makes an order hard to match. */
function showZelleInstructions(body) {
  const wrap = document.getElementById('checkoutMain');
  cart.clearCart();
  if (!wrap) return;
  const inst = body.instructions || {};
  const amount = formatPrice(Number(inst.amount != null ? inst.amount : body.total) || 0);
  const hours = Number(inst.windowHours) || 24;

  wrap.innerHTML = `
    <div class="zelle-instructions glass">
      <div class="empty-icon">${iconBank()}</div>
      <h3>Almost done — send your Zelle payment</h3>
      <p>Your order <strong>${escapeHtml(body.orderId || '')}</strong> is placed and held for
         <strong>${escapeHtml(String(hours))} hours</strong>. Nothing has been charged — send the transfer
         below from your bank's app or website (look for <em>"Send money with Zelle"</em>).</p>

      <dl class="zelle-details">
        <div><dt>Send to</dt><dd><span class="zelle-value">${escapeHtml(inst.recipient || '')}</span>
          <button type="button" class="btn btn-ghost btn-sm zelle-copy" data-copy="${escapeHtml(inst.recipient || '')}">Copy</button>
          <span class="zelle-sub">${escapeHtml(inst.recipientName || '')}${inst.bank ? ' · ' + escapeHtml(inst.bank) : ''}</span></dd></div>
        <div><dt>Amount</dt><dd><span class="zelle-value">${escapeHtml(amount)}</span>
          <span class="zelle-sub">exact amount, please</span></dd></div>
        <div><dt>Memo</dt><dd><span class="zelle-value">${escapeHtml(inst.memo || body.orderId || '')}</span>
          <button type="button" class="btn btn-ghost btn-sm zelle-copy" data-copy="${escapeHtml(inst.memo || body.orderId || '')}">Copy</button>
          <span class="zelle-sub">this is how we match your payment to your order</span></dd></div>
      </dl>

      <p class="text-muted">We check payments by hand, so this isn't instant: you'll get an email as soon as
         the money lands, and we ship after that. If anything looks wrong, reply to your order email and
         quote <strong>${escapeHtml(body.orderId || '')}</strong> — please don't send a second transfer.</p>
      <a class="btn btn-primary" href="index.html">Back to Home</a>
    </div>`;

  wrap.querySelectorAll('.zelle-copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy') || '';
      try {
        await navigator.clipboard.writeText(text);
        const was = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = was; }, 1600);
      } catch (e) {
        // No clipboard permission (or an insecure origin) — the value is on
        // screen anyway, so just get out of the way.
        btn.textContent = 'Copy by hand';
      }
    });
  });
}

/* validate the form, place the order on our server, then show the transfer
   details. Prices come from the server — the browser never names the amount. */
async function submitZelleOrder(form, btn) {
  if (cart.items.length === 0) { checkoutSetMsg('Your cart is empty.', 'error'); return; }
  if (!validateCheckout(form)) { checkoutSetMsg('Please complete the highlighted fields first.', 'error'); return; }
  checkoutSetMsg('');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Placing your order…';
  try {
    const checkout = collectCheckout(form);
    const payload = {
      items: cart.items.map(i => ({ id: i.id, quantity: i.quantity })),
      shipping: checkout,
      shippingMethod: enlShipChoice(),           // the service; the server sets its price
      email: checkout.email,
      webAuthorization: webAuthorizationRecord(), // signature for this transaction
      declarations: declarationsRecord()          // terms + age/use conditions of sale
    };
    const post = () => fetch(API_BASE + '/api/zelle/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(payload)
    });
    let res = await post();
    let body = await res.json().catch(() => ({}));
    /* Two identical open Zelle references are two ways to credit the wrong one
       — the transfer is matched to an order by eye, off the memo. */
    if (res.status === 409 && body.duplicateOf) {
      if (await handleDuplicateOrder(body) !== 'retry') {
        checkoutSetMsg(body.error, 'error');
        btn.disabled = false;
        btn.innerHTML = original;
        return;
      }
      payload.allowDuplicate = true;
      res = await post();
      body = await res.json().catch(() => ({}));
    }
    if (!res.ok || !body.success) throw new Error(body.error || 'Could not place your Zelle order.');
    enlTrack('payment_started', { method: 'zelle', items: cart.items.length });
    showZelleInstructions(body);
  } catch (err) {
    console.error('[zelle checkout]', err);
    checkoutSetMsg((err && err.message) || 'Could not place your Zelle order. Please try again.', 'error');
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

/* Replace the checkout form with a sign-in / register prompt. The cart is
   untouched — it's synced to the account on sign-in, so nothing is lost. */
function showCheckoutAccountGate() {
  const wrap = document.getElementById('checkoutMain');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="empty-state glass">
      <div class="empty-icon">${iconLock()}</div>
      <h3>An account is required to check out</h3>
      <p>Ever Nova Life supplies materials for in-vitro research only, and every order must be
         tied to a verified account holder. Please sign in, or create an account — it takes a minute
         and your cart will be waiting.</p>
      <div class="detail-cta" style="justify-content:center">
        <a class="btn btn-primary btn-lg" href="register.html?next=checkout.html">Create an account</a>
        <a class="btn btn-ghost btn-lg" href="login.html?next=checkout.html">Sign in</a>
      </div>
      <p class="text-muted" style="margin-top:1rem">Ordering also requires an approved
         <a href="research-accounts.html" style="color:var(--accent-purple)">research account</a>.</p>
    </div>`;
}

function initCheckoutPage() {
  // Returning from the hosted BTCPay crypto checkout after paying.
  if (new URLSearchParams(location.search).get('paid') === 'crypto') {
    let ref = null;
    try { ref = JSON.parse(sessionStorage.getItem('enl_crypto_order') || 'null'); } catch (e) {}
    try { sessionStorage.removeItem('enl_crypto_order'); } catch (e) {}
    showCryptoConfirmation(ref);
    return;
  }

  // An account is required to order: every purchase has to be attributable to a
  // verified buyer we can contact and keep records for. Enforced on the server
  // too — this only saves a signed-out visitor from filling in the whole form.
  if (!isSignedIn()) { showCheckoutAccountGate(); return; }

  enlTrack('begin_checkout', { items: cart.items.length });

  window._enlRedeem = { points: 0, discount: 0 };
  window._cryptoAvailable = true;
  window._zelleAvailable = true;
  const summary = document.getElementById('checkoutSummary');
  renderCheckoutSummary(summary);
  // pull the signed-in points balance, then re-render so the redeem control appears
  loadCheckoutLoyalty().then(() => renderCheckoutSummary(summary));
  /* Rates first, then the quote: the quote's shipping figure depends on which
     method is selected, so asking in the other order prices the cart twice and
     shows the wrong fee in between. */
  const shipBox = document.getElementById('shippingOptions');
  loadShippingMethods()
    .then(() => {
      renderShippingOptions(shipBox);
      return loadCheckoutQuote();
    })
    .then(() => {
      renderCheckoutSummary(summary);
      renderCheckoutLineItems();
    });

  renderCheckoutLineItems();

  const form = document.getElementById('checkoutForm');
  if (!form) return;

  // a checkout form should never reload the page on Enter
  form.addEventListener('submit', e => e.preventDefault());

  // clear a field's error as the user fixes it
  form.querySelectorAll('.form-field input, .form-field select, .form-field textarea').forEach(inp => {
    inp.addEventListener('input', () => setFieldError(inp.closest('.form-field'), ''));
    inp.addEventListener('change', () => setFieldError(inp.closest('.form-field'), ''));
  });
  /* Every required tick-box, not just the first — the research-use consent and
     the web order authorization are both mandatory, and only checking one of
     them let an unauthorized order through. */
  form.querySelectorAll('.form-check input[type="checkbox"][required]').forEach(box => {
    box.addEventListener('change', () => {
      const row = box.closest('.form-check');
      if (row) row.classList.toggle('invalid', !box.checked);
    });
  });

  /* The authorization text carries links (Terms, Returns, Privacy) inside its
     <label>. Without this, opening one of them also toggles the box — so a
     buyer reading the terms silently un-authorizes their own order. */
  const authBox = form.querySelector('.web-auth-box');
  if (authBox) authBox.querySelectorAll('a').forEach(a => a.addEventListener('click', e => e.stopPropagation()));

  const cryptoBtn = document.getElementById('cryptoPayBtn');
  const zelleBtn = document.getElementById('zellePayBtn');

  /* Wire the payment controls unconditionally, even with an empty cart.
     updateAltPayVisibility() hides the block until there's something to buy,
     and re-runs when the cart syncs down from the account — so the buttons
     have to already be listening by then. Returning early here (the old
     behaviour) left a synced-in cart with visible items and dead buttons. */
  initAutoshipCheckout();
  updatePayButtonAmount();

  if (cryptoBtn) cryptoBtn.addEventListener('click', () => submitCryptoOrder(form, cryptoBtn));
  if (zelleBtn) zelleBtn.addEventListener('click', () => submitZelleOrder(form, zelleBtn));

  // Ask the server which payment methods it actually has keys for, and drop the
  // ones it doesn't, so a buyer is never offered a button that can only fail.
  // (Zelle also steps aside for points/auto-ship — see updateAltPayVisibility.)
  fetch(API_BASE + '/api/health')
    .then(r => r.json())
    .then(h => {
      window._cryptoAvailable = !(h && h.crypto === false);
      window._zelleAvailable = !(h && h.zelle === false);
      updateAltPayVisibility();
    })
    .catch(() => { /* leave visible; a click will surface any real error */ });
}

/* ============================================================
   FAQ accordion
   ============================================================ */
function initFAQPage() {
  document.querySelectorAll('.faq-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const open = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
      if (!open) item.classList.add('open');
    });
  });
}

/* ============================================================
   CONTACT form (demo)
   ============================================================ */
function initContactForm() {
  const form = document.getElementById('contactForm');
  if (!form) return;
  form.addEventListener('submit', e => {
    e.preventDefault();
    const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const name = val('cf-name');
    const email = val('cf-email');
    const subject = val('cf-subject') || 'Website inquiry';
    const message = val('cf-message');
    const body = `From: ${name}${email ? ' <' + email + '>' : ''}\n\n${message}`;
    const href = 'mailto:support@evernovalife.com'
      + '?subject=' + encodeURIComponent(subject)
      + '&body=' + encodeURIComponent(body);
    const msg = document.getElementById('contactMsg');
    if (msg) {
      msg.className = 'form-msg success';
      msg.innerHTML = 'Opening your email app to send this to <strong>support@evernovalife.com</strong>. ' +
        'If nothing opens, please email us directly at that address.';
    }
    // Actually hand the message off to the user's email client — nothing is
    // silently dropped or falsely marked as "sent".
    window.location.href = href;
  });
}

/* ============================================================
   Generic demo-form handler (login/register)
   ============================================================ */
function initDemoForms() {
  document.querySelectorAll('form[data-demo]').forEach(form => {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const msg = form.querySelector('.form-msg');
      if (msg) { msg.className = 'form-msg success'; msg.textContent = form.dataset.demo; }
    });
  });
}

/* ============================================================
   inline icons
   ============================================================ */
function iconCheck() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`; }
function iconShield() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`; }
function iconTruck() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`; }
function iconBox() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></svg>`; }
function iconTrash() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`; }
function iconHeart() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21.2l7.7-7.6 1.1-1.1a5.5 5.5 0 0 0 0-7.9z"/></svg>`; }

/* ---- line-art glyphs that replaced the emoji ----
   Emoji were doing icon work in the empty states, category cards and order
   summary. Every platform draws them differently and they read as consumer-app
   decoration, which undercuts a page whose whole argument is laboratory
   documentation. These are the same 24px stroke set as the rest of the site. */
function svgLine(paths, extra) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra || ''}>${paths}</svg>`;
}
function iconSearchOff() { return svgLine(`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/><path d="M8.5 8.5l5 5"/><path d="m13.5 8.5-5 5"/>`); }
function iconCartOutline() { return svgLine(`<circle cx="9" cy="20" r="1.4"/><circle cx="18.5" cy="20" r="1.4"/><path d="M2 3h3l2.4 11.6a1.8 1.8 0 0 0 1.8 1.4h8.4a1.8 1.8 0 0 0 1.8-1.4L21.5 7H6"/>`); }
function iconFileQuestion() { return svgLine(`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M10.3 12.6a1.8 1.8 0 1 1 2.4 2.2c-.5.3-.7.7-.7 1.2"/><path d="M12 18.6h.01"/>`); }
function iconCheckCircle() { return svgLine(`<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>`); }
function iconBank() { return svgLine(`<path d="M3 9.5 12 4l9 5.5"/><path d="M4.5 9.8V19"/><path d="M9.5 9.8V19"/><path d="M14.5 9.8V19"/><path d="M19.5 9.8V19"/><path d="M2.5 19h19"/>`); }
function iconLock() { return svgLine(`<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>`); }
function iconTruckLine() { return svgLine(`<path d="M1.5 5.5h13v10h-13z"/><path d="M14.5 9h4l3 3v3.5h-7z"/><circle cx="6" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>`); }
function iconRepeat() { return svgLine(`<path d="M3 11.5a6.5 6.5 0 0 1 6.5-6.5H19"/><path d="m16 2 3 3-3 3"/><path d="M21 12.5a6.5 6.5 0 0 1-6.5 6.5H5"/><path d="m8 22-3-3 3-3"/>`); }
function iconAlert() { return svgLine(`<path d="M10.3 3.6 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5"/><path d="M12 17.3h.01"/>`); }

/* Category glyphs — keyed by CATEGORIES[].icon in products-data.js. */
function categoryIcon(name) {
  const set = {
    helix:   `<path d="M8 3c0 4 8 5 8 9s-8 5-8 9"/><path d="M16 3c0 4-8 5-8 9s8 5 8 9"/><path d="M9.2 7h5.6"/><path d="M9.2 17h5.6"/>`,
    bolt:    `<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"/>`,
    lattice: `<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5"/><path d="M12 12v9"/>`,
    layers:  `<path d="M12 2.5 2.5 7.5 12 12.5l9.5-5z"/><path d="m2.5 12.5 9.5 5 9.5-5"/><path d="m2.5 17 9.5 5 9.5-5"/>`,
    flask:   `<path d="M9 2.5h6"/><path d="M10 2.5v6.8L4.8 19a2 2 0 0 0 1.8 3h10.8a2 2 0 0 0 1.8-3L14 9.3V2.5"/><path d="M7.4 15h9.2"/>`
  };
  return svgLine(set[name] || set.flask);
}

/* ============================================================
   WISHLIST UI
   ============================================================ */
function toggleWishlist(id, btn) {
  const active = wishlist.toggle(id);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('.wish-btn[data-id="' + id + '"]').forEach(b => {
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
    // heart burst (pop + radiating ring) only when newly SAVED
    if (active && !reduce) {
      b.classList.remove('pn-burst');
      void b.offsetWidth;            // restart the keyframes
      b.classList.add('pn-burst');
      b.addEventListener('animationend', () => b.classList.remove('pn-burst'), { once: true });
    }
  });
  if (active && navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
  const p = getProductById(id);
  cart.showNotification((active ? 'Saved ' : 'Removed ') + (p ? p.name : 'item') + (active ? ' to wishlist' : ' from wishlist'));
  if (currentPage === 'wishlist.html') renderWishlistPage();
}

function renderWishlistPage() {
  const root = document.getElementById('wishlistRoot');
  if (!root) return;
  const items = wishlist.ids.map(getProductById).filter(Boolean);
  if (!items.length) {
    root.innerHTML = `<div class="empty-state glass"><div class="empty-icon">${iconHeart()}</div><h3>Your wishlist is empty</h3><p>Tap the heart on any product to save it here for later.</p><a class="btn btn-primary" href="products.html">Browse Products</a></div>`;
    return;
  }
  root.innerHTML = `<div class="products-grid">${items.map(createProductCard).join('')}</div>`;
}

/* ============================================================
   HEADER EXTRAS — wishlist icon + mini-cart dropdown (injected)
   ============================================================ */
function renderMiniCart(panel) {
  if (!cart.items.length) {
    panel.innerHTML = `<div class="mini-cart-empty">Your cart is empty</div><a class="btn btn-ghost btn-block btn-sm" href="products.html">Shop now</a>`;
    return;
  }
  const rows = cart.items.map(i => {
    const p = getProductById(i.id) || i;
    return `<a class="mini-cart-row" href="product.html?id=${i.id}">
      <span class="mini-cart-thumb">${createVialPhoto(p, { width: VIAL_W.thumb })}</span>
      <span class="mini-cart-info"><strong>${escapeHtml(i.name)}</strong><small>${i.quantity} × ${formatPrice(i.price)}</small></span>
    </a>`;
  }).join('');
  panel.innerHTML = `
    <div class="mini-cart-items">${rows}</div>
    <div class="mini-cart-foot">
      <div class="mini-cart-subtotal"><span>Subtotal</span><span>${formatPrice(cart.getSubtotal())}</span></div>
      <a class="btn btn-primary btn-block btn-sm" href="cart.html">View Cart</a>
    </div>`;
}

function initHeaderExtras() {
  const actions = document.querySelector('.header-actions');
  if (!actions) return;
  const cartLink = actions.querySelector('a[href="cart.html"]');
  if (!cartLink) return;

  // wishlist icon (before cart)
  if (!actions.querySelector('.wishlist-link')) {
    const wl = document.createElement('a');
    wl.href = 'wishlist.html';
    wl.className = 'icon-btn wishlist-link';
    wl.setAttribute('aria-label', 'Wishlist');
    wl.innerHTML = iconHeart() + '<span class="wishlist-badge">0</span>';
    actions.insertBefore(wl, cartLink);
  }

  // mini-cart dropdown wrapping the cart link
  if (!document.getElementById('miniCart')) {
    const wrap = document.createElement('div');
    wrap.className = 'mini-cart-wrap';
    cartLink.parentNode.insertBefore(wrap, cartLink);
    wrap.appendChild(cartLink);
    const panel = document.createElement('div');
    panel.className = 'mini-cart glass';
    panel.id = 'miniCart';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Cart preview');
    wrap.appendChild(panel);
    const open = () => { renderMiniCart(panel); wrap.classList.add('open'); };
    wrap.addEventListener('mouseenter', open);
    wrap.addEventListener('mouseleave', () => wrap.classList.remove('open'));
    cartLink.addEventListener('focus', open);
    wrap.addEventListener('focusout', e => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('open'); });
  }
  wishlist.updateBadge();
}

/* ============================================================
   JSON-LD structured data (injected on product detail)
   ============================================================ */
function injectJSONLD(obj, id) {
  let s = document.getElementById(id);
  if (!s) { s = document.createElement('script'); s.type = 'application/ld+json'; s.id = id; document.head.appendChild(s); }
  s.textContent = JSON.stringify(obj);
}

/* ============================================================
   PRODUCT STRUCTURED DATA
   One description of a SKU, used by the product page and by the
   catalog's ItemList, so the two can never drift apart.

   Availability comes from stockInfo(), not from `inStock` alone —
   a SKU counted down to zero is unbuyable, and telling a search
   engine otherwise sends people to a page they can't order from.

   No aggregateRating and no review: there are none, and inventing
   them is a manual action from Google as well as a lie. Purity and
   form ride along as additionalProperty rather than as claims.
   ============================================================ */
const SITE_ORIGIN = 'https://evernovalife.com/';

function productSchema(product, pageUrl) {
  const st = stockInfo(product);
  const url = pageUrl || `${SITE_ORIGIN}product.html?id=${product.id}`;
  const specs = product.specs || {};
  const props = Object.keys(specs)
    .filter(k => specs[k])
    .map(k => ({ '@type': 'PropertyValue', name: k, value: String(specs[k]) }));

  /* A year out is the convention for a price with no planned end date; without
     it Google reports the offer as missing priceValidUntil. */
  const validUntil = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': url + '#product',
    name: product.name,
    description: product.description,
    image: SITE_ORIGIN + `assets/vials/${product.id}.webp`,
    sku: product.lot || `ENL-${product.id}`,
    productID: String(product.id),
    category: product.categoryName || '',
    brand: { '@type': 'Brand', name: 'Ever Nova Life' },
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'USD',
      price: Number(product.price).toFixed(2),
      priceValidUntil: validUntil,
      itemCondition: 'https://schema.org/NewCondition',
      availability: 'https://schema.org/' + (st.sellable ? 'InStock' : 'OutOfStock'),
      seller: { '@type': 'Organization', name: 'Ever Nova Life', '@id': SITE_ORIGIN + '#org' }
    }
  };
  if (props.length) schema.additionalProperty = props;
  return schema;
}

/* The catalog page paints its grid from the live API, so describe the same
   list to a crawler. products.html also carries a baked copy of this in its
   markup (tools/build-jsonld.js) for the crawl that never runs the JS —
   same @id on both, so they are one node rather than two competing ones. */
function initCatalogSchema(list) {
  if (!Array.isArray(list) || !list.length) return;
  injectJSONLD({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': SITE_ORIGIN + 'products.html#catalog',
    name: 'Ever Nova Life research materials',
    numberOfItems: list.length,
    itemListElement: list.map((p, i) => {
      // The list already declares the context; repeating it per item is noise.
      const { '@context': _ctx, ...item } = productSchema(p);
      return { '@type': 'ListItem', position: i + 1, item };
    })
  }, 'ld-catalog');
}

/* ============================================================
   BREADCRUMB STRUCTURED DATA
   Every interior page already paints a breadcrumb; only the product page
   described it to a search engine. This reads the trail that is already on
   the page (so the two can never disagree) and publishes it as BreadcrumbList.
   The product page emits its own — richer, with the product name — so it is
   left alone.
   ============================================================ */
function initBreadcrumbSchema() {
  if (document.getElementById('ld-breadcrumb')) return;
  const bc = document.querySelector('.breadcrumb');
  if (!bc) return;

  const ORIGIN = 'https://evernovalife.com/';
  const items = [];
  Array.from(bc.children).forEach(el => {
    const text = (el.textContent || '').trim();
    if (!text || text === '/') return;                 // the separators
    const entry = { '@type': 'ListItem', position: items.length + 1, name: text };
    const href = el.getAttribute('href');
    if (href) entry.item = ORIGIN + href.replace(/^\.?\//, '');
    items.push(entry);
  });
  if (items.length < 2) return;                        // a single crumb isn't a trail
  injectJSONLD({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items }, 'ld-breadcrumb');
}

/* ============================================================
   FORM VALIDATION (checkout)
   ============================================================ */
function setFieldError(field, msg) {
  if (!field) return;
  field.classList.toggle('invalid', !!msg);
  const input = field.querySelector('input, select, textarea');
  let e = field.querySelector('.field-error');
  if (msg) {
    if (!e) {
      e = document.createElement('div');
      e.className = 'field-error';
      /* Tie the message to its field: aria-invalid marks the control as failing
         and aria-describedby makes the reason part of what gets read out, so the
         error is not just a red line a sighted user happens to see. */
      e.id = 'fe-' + (input && input.name ? input.name : Math.random().toString(36).slice(2, 8));
      field.appendChild(e);
    }
    e.textContent = msg;
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', e.id);
    }
  } else if (e) {
    if (input) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
    e.remove();
  }
}

function validateCheckout(form) {
  let firstInvalid = null;
  form.querySelectorAll('.form-field').forEach(field => {
    const input = field.querySelector('input, select, textarea');
    if (!input) return;
    const val = (input.value || '').trim();
    /* Card-number / MM-YY / CVC checks used to live here, keyed off the Braintree
       placeholders. Cards were removed in the 2026-08-08 crypto-only rebuild, so
       those branches could never fire again. What is left is what the buyer
       actually fills in, plus a US ZIP check (we ship US-only). */
    let msg = '';
    const label = (field.querySelector('label')?.textContent || '').trim().replace(/\s*\*$/, '');
    if (input.hasAttribute('required') && !val) {
      msg = label ? `${label} is required.` : 'This field is required.';
    } else if (val && input.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) {
      msg = 'Enter a valid email address, e.g. name@lab.com.';
    } else if (val && input.name === 'postalCode' && !/^\d{5}(-\d{4})?$/.test(val)) {
      msg = 'Enter a 5-digit US ZIP code.';
    }
    setFieldError(field, msg);
    if (msg && !firstInvalid) firstInvalid = input;
  });
  /* Required tick-boxes (.form-check): the research-use confirmation AND the
     web order authorization. Both are conditions of the sale, so both are
     checked — an order may not be placed with either one untouched. */
  form.querySelectorAll('.form-check input[type="checkbox"][required]').forEach(box => {
    const row = box.closest('.form-check');
    if (!box.checked) {
      if (row) row.classList.add('invalid');
      if (!firstInvalid) firstInvalid = box;
    } else if (row) { row.classList.remove('invalid'); }
  });
  if (firstInvalid) firstInvalid.focus();
  return !firstInvalid;
}

/* ============================================================
   WEB ORDER AUTHORIZATION
   The buyer's electronic signature, captured at the moment they
   place the order: the exact wording they were shown, the version
   of that wording, and when they agreed. Stored with the order so
   a disputed transaction can be answered with what was actually on
   screen. Bump WEB_AUTH_VERSION whenever the copy in
   checkout.html #webAuthText changes.
   ============================================================ */
const WEB_AUTH_VERSION = '2026-08-14';

function webAuthorizationRecord() {
  const box = document.getElementById('webAuthCheck');
  if (!box || !box.checked) return null;      // validateCheckout already blocked this
  const el = document.getElementById('webAuthText');
  return {
    accepted: true,
    version: WEB_AUTH_VERSION,
    acceptedAt: new Date().toISOString(),
    text: (el ? el.textContent : '').replace(/\s+/g, ' ').trim()
  };
}

/* ============================================================
   BUYER DECLARATIONS
   The conditions of sale for this product category: acceptance of
   the Terms, and the age / non-consumption / qualified-professional
   statement. Captured the same way as the authorization above —
   the exact wording shown, its version, and when it was ticked —
   because an unstored tick-box is not evidence of anything.
   Bump DECLARATIONS_VERSION whenever the copy in checkout.html
   #termsText or #ageUseText changes.
   ============================================================ */
const DECLARATIONS_VERSION = '2026-08-14';

const DECLARATION_FIELDS = [
  { id: 'terms', box: 'termsCheck', text: 'termsText' },
  { id: 'age-and-use', box: 'ageUseCheck', text: 'ageUseText' }
];

function declarationsRecord() {
  const at = new Date().toISOString();
  const items = DECLARATION_FIELDS.map(f => {
    const box = document.getElementById(f.box);
    if (!box || !box.checked) return null;    // validateCheckout already blocked this
    const el = document.getElementById(f.text);
    return {
      id: f.id,
      accepted: true,
      text: (el ? el.textContent : '').replace(/\s+/g, ' ').trim()
    };
  });
  if (items.some(i => !i)) return null;
  return { version: DECLARATIONS_VERSION, acceptedAt: at, items };
}

/* ============================================================
   CUSTOMER SERVICE PHONE
   The number lives in js/config.js so it can be changed in one
   place. Any element marked `data-support-phone` stays hidden
   until a real number is configured — we would rather show no
   phone number than a placeholder someone actually dials.
   ============================================================ */
function initSupportPhone() {
  const raw = String(window.ENL_SUPPORT_PHONE || '').trim();
  const hours = String(window.ENL_SUPPORT_PHONE_HOURS || '').trim();
  if (!raw) return;                       // nothing configured → leave it hidden

  /* tel: wants digits (and a leading +) only; the visible text keeps whatever
     formatting the owner wrote. A bare 10-digit US number gets +1. */
  let dial = raw.replace(/[^\d+]/g, '');
  if (!dial.startsWith('+')) dial = (dial.length === 10 ? '+1' : '+') + dial;

  document.querySelectorAll('[data-support-phone-link]').forEach(a => {
    a.setAttribute('href', 'tel:' + dial);
    a.textContent = raw;
  });
  document.querySelectorAll('[data-support-phone-hours]').forEach(el => {
    el.textContent = hours ? ' — ' + hours : '';
  });
  document.querySelectorAll('[data-support-phone]').forEach(el => {
    /* The containers are laid out differently per page (flex row on Contact,
       inline inside a table cell on About), so restore the stylesheet's own
       display rather than forcing one. */
    el.style.display = '';
  });
}

/* ============================================================
   BOOT
   ============================================================ */
const currentPage = (location.pathname.split('/').pop() || 'index.html') || 'index.html';

/* ============================================================
   HOVER LIFE — springy cursor-follow tilt on the vial stage
   Delegated on document (cards are re-rendered via innerHTML).
   Writes --pn-tx / --pn-ty (deg) on the hovered .product-media;
   CSS consumes them only while pn-float is paused (hover/focus),
   so this never fights the float. Skipped for reduced-motion and
   coarse (touch) pointers; max ~6deg; resets to 0 on leave so the
   .18s CSS transition springs it back. GPU-cheap (transform only).
   ============================================================ */
function initVialTilt() {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (reduce || coarse) return;

  const MAX = 6; // degrees
  let frame = 0;

  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const stage = e.target.closest && e.target.closest('.product-media, .product-detail-media');
    if (!stage) return;
    if (frame) return;                     // throttle to one write per frame
    frame = requestAnimationFrame(() => {
      frame = 0;
      const r = stage.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width  - 0.5; // -0.5..0.5
      const py = (e.clientY - r.top)  / r.height - 0.5;
      stage.style.setProperty('--pn-tx', (px * MAX * 2).toFixed(2) + 'deg');   // rotateY (left/right)
      stage.style.setProperty('--pn-ty', (-py * MAX * 2).toFixed(2) + 'deg');  // rotateX (up/down)
      if (stage.classList.contains('product-detail-media')) {                   // cursor-follow key light (detail only)
        stage.style.setProperty('--mx', (px * 100 + 50).toFixed(1) + '%');
        stage.style.setProperty('--my', (py * 100 + 50).toFixed(1) + '%');
      }
    });
  }, { passive: true });

  document.addEventListener('pointerout', (e) => {
    const stage = e.target.closest && e.target.closest('.product-media, .product-detail-media');
    if (!stage) return;
    // only reset when the pointer has actually left the stage
    if (e.relatedTarget && stage.contains(e.relatedTarget)) return;
    stage.style.setProperty('--pn-tx', '0deg');
    stage.style.setProperty('--pn-ty', '0deg');
    if (stage.classList.contains('product-detail-media')) {                     // settle the key light home
      stage.style.setProperty('--mx', '50%');
      stage.style.setProperty('--my', '34%');
    }
  }, { passive: true });
}

document.addEventListener('DOMContentLoaded', () => {
  initHeader();
  initHeaderExtras();
  renderHeaderAuth();     // paint name/admin from cache instantly…
  refreshHeaderUser();    // …then confirm with the server in the background
  displayFeaturedProducts();
  displayCategories();
  initNewsletter();
  initSearch();
  initDemoForms();
  initVialTilt();
  initProductQuickView();   // clicking a product opens it in place, not a new page
  initBreadcrumbSchema();
  initSupportPhone();       // reveals the phone blocks only when one is configured

  switch (currentPage) {
    case 'products.html': initProductsPage(); break;
    case 'product.html': initProductDetailPage(); break;
    case 'cart.html': renderCartPage(); break;
    case 'checkout.html': initCheckoutPage(); break;
    case 'faq.html': initFAQPage(); break;
    case 'contact.html': initContactForm(); break;
    case 'wishlist.html': renderWishlistPage(); break;
    case 'shipping.html': renderPublicRateTable(); break;
  }

  // pull the live (admin-managed) catalog and repaint product views
  loadProducts();

  // When the cart finishes syncing with the account (server), repaint any
  // cart-driven view so it reflects the reconciled items.
  window.addEventListener('cart:updated', () => {
    if (currentPage === 'cart.html') {
      renderCartPage();
    } else if (currentPage === 'checkout.html') {
      const summary = document.getElementById('checkoutSummary');
      if (summary) renderCheckoutSummary(summary);
      const lineItems = document.getElementById('checkoutItems');
      if (lineItems) {
        lineItems.innerHTML = cart.items.length
          ? cart.items.map(i =>
              `<div class="summary-row"><span>${escapeHtml(i.name)} × ${i.quantity}</span><span>${formatPrice(i.price * i.quantity)}</span></div>`).join('')
          : `<p class="text-muted">Your cart is empty. <a href="products.html" style="color:var(--accent-purple)">Add products</a> to continue.</p>`;
      }
      // The cart that just arrived is what decides whether there's anything to
      // pay for — so the payment block and its amount follow it, in both
      // directions. Without this an account cart syncing down leaves the buyer
      // looking at their items with the pay buttons still hidden.
      updateAltPayVisibility();
    }
  });
});

if (typeof window !== 'undefined') {
  window.createVialSVG = createVialSVG;
  window.createProductCard = createProductCard;
  window.addToCartById = addToCartById;
  window.toggleWishlist = toggleWishlist;
}
