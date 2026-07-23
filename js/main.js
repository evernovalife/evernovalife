/* ============================================================
   EVER NOVA LIFE — main.js
   · Photorealistic vial SVG generator  (createVialSVG)
   · Product card builder
   · Page initializers (catalog, detail, cart, checkout, faq…)
   ============================================================ */

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
  const isWater = product.id === 2 || /bacteriostatic\s*water/i.test(product.name || '');

  /* ---- geometry (squat clear vial — matched to reference photo) ---- */
  const cx = 100;
  const bodyW = isWater ? 110 : 100;
  const bodyH = isWater ? 172 : 140;
  const bodyTop = isWater ? 110 : 108;
  const bodyBottom = bodyTop + bodyH;
  const bL = cx - bodyW / 2;
  const bR = cx + bodyW / 2;
  const rBot = 16;

  const neckW = isWater ? 50 : 46;
  const nL = cx - neckW / 2;
  const nR = cx + neckW / 2;

  /* flip-off cap = royal-blue dome stacked on a silver aluminium crimp band */
  const capW = isWater ? 62 : 56;
  const cL = cx - capW / 2;
  const cR = cx + capW / 2;
  const domeTopY = 20, domeBaseY = 44;   // blue dome region
  const bandTopY = 44, bandBotY = 74;    // silver band region

  /* label region */
  const labelTop = isWater ? 156 : 130;
  const labelH = isWater ? 104 : 98;
  const labelBottom = labelTop + labelH;
  const L = f => labelTop + f * labelH;
  const textHalf = bodyW / 2 - 12;

  /* contents (kept minimal — clear vial like the reference) */
  const cakeTop = bodyBottom - (isWater ? 0 : 13);
  const liquidTop = bodyTop + 16;

  /* badge */
  const bw2 = isWater ? 21 : 19;
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

  /* ---- contents markup (minimal — clear vial) ---- */
  let contents;
  if (isWater) {
    contents = `
      <g clip-path="url(#bodyClip_${uid})">
        <rect x="${bL}" y="${liquidTop}" width="${bodyW}" height="${bodyBottom - liquidTop}" fill="url(#liquid_${uid})" opacity="0.5"/>
        <ellipse cx="${cx}" cy="${liquidTop}" rx="${bodyW / 2 - 2}" ry="3" fill="#eff6ff" opacity="0.8"/>
      </g>`;
  } else {
    contents = `
      <g clip-path="url(#bodyClip_${uid})">
        <path d="M ${bL + 2} ${cakeTop} Q ${cx} ${cakeTop - 4} ${bR - 2} ${cakeTop} L ${bR - 2} ${bodyBottom} L ${bL + 2} ${bodyBottom} Z" fill="url(#powder_${uid})" opacity="0.92"/>
        <path d="M ${bL + 2} ${cakeTop} Q ${cx} ${cakeTop - 4} ${bR - 2} ${cakeTop}" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.65"/>
      </g>`;
  }

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
    <linearGradient id="liquid_${uid}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#bcdcff"/>
      <stop offset="45%" stop-color="#eaf4ff"/>
      <stop offset="100%" stop-color="#9cc4f0"/>
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
      <stop offset="0%" stop-color="#4f46e5"/>
      <stop offset="50%" stop-color="#a855f7"/>
      <stop offset="100%" stop-color="#fb7185"/>
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
function createVialPhoto(product) {
  const uid = 'p' + (++_vialCounter);
  const name = product.name || '';
  const nameSize = name.length > 22 ? 13 : name.length > 14 ? 16 : 21;
  // Use the real labelled-vial photo (assets/vials/<id>.png). If it's missing,
  // fall back to the generic vial + generated Aura label overlay below.
  const realSrc = product.image || `assets/vials/${product.id}.png`;
  return `
  <div class="vial-photo">
    <img class="vial-photo-img" src="${realSrc}" alt="${escapeHtml(name)} research vial" loading="lazy"
         onerror="this.onerror=null;this.src='assets/vial.png?v=3';var l=this.parentNode.querySelector('.vial-photo-label');if(l)l.style.display='block'">
    <svg class="vial-photo-label" viewBox="0 0 200 380" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" preserveAspectRatio="none" style="display:none">
      <defs>
        <linearGradient id="brand_${uid}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#6d28d9"/><stop offset="50%" stop-color="#a855f7"/><stop offset="100%" stop-color="#ec4899"/>
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

function createProductCard(product) {
  const badge = product.badge
    ? `<span class="product-badge ${productBadgeClass(product.badge)}">${escapeHtml(product.badge)}</span>`
    : '';
  const oldPrice = product.originalPrice && product.originalPrice > product.price
    ? `<span class="product-price-old">${formatPrice(product.originalPrice)}</span>` : '';
  const stock = product.inStock
    ? `<span class="stock-pill">In stock</span>`
    : `<span class="stock-pill out">Out of stock</span>`;

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
        <button class="btn btn-primary btn-sm" onclick="addToCartById(${product.id}, 1, this)">Add to Cart</button>
        <a class="btn btn-ghost btn-sm" href="product.html?id=${product.id}">View</a>
      </div>
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
  cart.addItem(product, qty);       // existing green toast + badge sync
  pnCartCelebrate(sourceEl);
}

function renderProducts(list, container) {
  if (!container) return;
  if (!list.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🔍</div><h3>No products found</h3><p>Try adjusting your filters or search.</p></div>`;
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
      <div class="category-emoji">${c.emoji}</div>
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
    if (msg) msg.textContent = email ? '🎉 Welcome to the Nest! Check your inbox to confirm.' : '';
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
    burger.addEventListener('click', () => nav.classList.toggle('mobile-open'));
  }
  // active link
  const page = currentPage;
  document.querySelectorAll('.main-nav a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === page || (page === 'index.html' && (href === 'index.html' || href === './' || href === '/'))) {
      a.classList.add('active');
    }
  });
}

/* ============================================================
   PRODUCTS PAGE — filters + sort + URL params
   ============================================================ */
function initProductsPage() {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;
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

  if (urlSearch && searchInput) searchInput.value = urlSearch;
  if (urlCat) {
    catBoxes().forEach(cb => { if (cb.value === urlCat) cb.checked = true; });
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
  }

  catBoxes().forEach(cb => cb.addEventListener('change', apply));
  sortSelect && sortSelect.addEventListener('change', apply);
  searchInput && searchInput.addEventListener('input', apply);
  priceRange && priceRange.addEventListener('input', apply);
  stockOnly && stockOnly.addEventListener('change', apply);

  // mobile filter toggle
  const ftBtn = document.getElementById('filterToggle');
  const sidebar = document.getElementById('filtersSidebar');
  if (ftBtn && sidebar) ftBtn.addEventListener('click', () => sidebar.classList.toggle('collapsed'));

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
  }
}

/* ============================================================
   PRODUCT DETAIL PAGE
   ============================================================ */
function initProductDetailPage() {
  const root = document.getElementById('productDetail');
  if (!root) return;
  const id = new URLSearchParams(location.search).get('id') || 1;
  const product = getProductById(id);
  if (!product) {
    root.innerHTML = `<div class="empty-state"><div class="empty-icon">😕</div><h3>Product not found</h3><p>This item may have been removed.</p><a class="btn btn-primary" href="products.html">Browse Catalog</a></div>`;
    return;
  }
  document.title = `${product.name} — Ever Nova Life`;

  // structured data for rich search results
  injectJSONLD({
    '@context': 'https://schema.org', '@type': 'Product',
    name: product.name, description: product.description,
    sku: product.lot, category: product.categoryName,
    brand: { '@type': 'Brand', name: 'Ever Nova Life' },
    offers: {
      '@type': 'Offer', url: location.href, priceCurrency: 'USD',
      price: product.price.toFixed(2),
      availability: 'https://schema.org/' + (product.inStock ? 'InStock' : 'OutOfStock')
    }
  }, 'ld-product');
  injectJSONLD({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://evernovalife.com/' },
      { '@type': 'ListItem', position: 2, name: 'Products', item: 'https://evernovalife.com/products.html' },
      { '@type': 'ListItem', position: 3, name: product.name }
    ]
  }, 'ld-breadcrumb');

  const specsRows = Object.entries(product.specs)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('');
  const oldPrice = product.originalPrice > product.price
    ? `<span class="detail-price-old">${formatPrice(product.originalPrice)}</span>` : '';
  const badge = product.badge ? `<span class="product-badge ${productBadgeClass(product.badge)}" style="position:static;display:inline-block">${escapeHtml(product.badge)}</span>` : '';

  root.innerHTML = `
    <div class="product-detail-media glass">${createVialPhoto(product)}</div>
    <div class="product-detail-info">
      <span class="product-cat">${escapeHtml(product.categoryName)}</span> ${badge}
      <h1>${escapeHtml(product.name)}</h1>
      <div class="product-meta"><span>${escapeHtml(product.quantity)}</span><span>•</span><span>${purityMeta(product.purity)}</span><span>•</span><span>Lot ${escapeHtml(product.lot)}</span></div>
      <div class="detail-price-row">
        <span class="detail-price gradient-text">${formatPrice(product.price)}</span>
        ${oldPrice}
        <span class="stock-pill ${product.inStock ? '' : 'out'}">${product.inStock ? 'In stock' : 'Out of stock'}</span>
      </div>
      <p class="detail-desc">${escapeHtml(product.description)}</p>
      <div class="qty-selector">
        <span>Quantity</span>
        <div class="qty-control">
          <button type="button" id="qtyMinus" aria-label="Decrease">−</button>
          <input type="text" id="qtyInput" value="1" inputmode="numeric" aria-label="Quantity">
          <button type="button" id="qtyPlus" aria-label="Increase">+</button>
        </div>
      </div>
      <div class="detail-cta">
        <button class="btn btn-primary btn-lg" id="detailAddBtn" ${product.inStock ? '' : 'disabled'}>Add to Cart</button>
        <a class="btn btn-ghost btn-lg" href="cart.html">View Cart</a>
      </div>
      <table class="specs-table"><tbody>${specsRows}</tbody></table>
      <div class="trust-badges-inline">
        <span>${iconCheck()} <a href="quality.html#coa-library">Lot documentation</a></span>
        <span>${iconShield()} Third-party tested</span>
        <span>${iconTruck()} Tracked U.S. dispatch</span>
        <span>${iconBox()} In-vitro research use only</span>
      </div>
    </div>`;

  // quantity controls
  const qtyInput = document.getElementById('qtyInput');
  const clamp = () => { let v = parseInt(qtyInput.value, 10); if (isNaN(v) || v < 1) v = 1; if (v > 99) v = 99; qtyInput.value = v; return v; };
  document.getElementById('qtyMinus').addEventListener('click', () => { qtyInput.value = Math.max(1, (parseInt(qtyInput.value, 10) || 1) - 1); });
  document.getElementById('qtyPlus').addEventListener('click', () => { qtyInput.value = Math.min(99, (parseInt(qtyInput.value, 10) || 1) + 1); });
  qtyInput.addEventListener('change', clamp);
  document.getElementById('detailAddBtn').addEventListener('click', (e) => {
    cart.addItem(product, clamp());
    pnCartCelebrate(e.currentTarget);   // resolves to .product-detail-media via fallback
  });

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
        <div class="empty-icon">🪺</div>
        <h3>Your nest is empty</h3>
        <p>Browse our research peptides and add something to get started.</p>
        <a class="btn btn-primary" href="products.html">Shop Products</a>
      </div>`;
    return;
  }

  const rows = cart.items.map(item => {
    const product = getProductById(item.id) || item;
    return `
    <div class="cart-row glass" data-id="${item.id}">
      <div class="cart-row-media">${createVialPhoto(product)}</div>
      <div class="cart-row-info">
        <span class="product-cat">${escapeHtml(item.category || '')}</span>
        <h4><a href="product.html?id=${item.id}">${escapeHtml(item.name)}</a></h4>
        <div class="cart-price gradient-text">${formatPrice(item.price)}</div>
      </div>
      <div class="cart-row-controls">
        <div class="qty-control">
          <button type="button" class="cart-minus" data-id="${item.id}">−</button>
          <input type="text" class="cart-qty" data-id="${item.id}" value="${item.quantity}" inputmode="numeric">
          <button type="button" class="cart-plus" data-id="${item.id}">+</button>
        </div>
        <button class="cart-remove" data-id="${item.id}">${iconTrash()} Remove</button>
      </div>
    </div>`;
  }).join('');

  root.innerHTML = `
    <div class="cart-layout">
      <div class="cart-items">${rows}</div>
      <aside class="order-summary glass" id="orderSummary"></aside>
    </div>`;

  renderOrderSummary(document.getElementById('orderSummary'), true);
  bindCartControls();
}

function bindCartControls() {
  document.querySelectorAll('.cart-plus').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id; const item = cart.items.find(i => i.id === Number(id));
    cart.updateQuantity(id, item.quantity + 1); renderCartPage();
  }));
  document.querySelectorAll('.cart-minus').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id; const item = cart.items.find(i => i.id === Number(id));
    cart.updateQuantity(id, item.quantity - 1); renderCartPage();
  }));
  document.querySelectorAll('.cart-qty').forEach(inp => inp.addEventListener('change', () => {
    cart.updateQuantity(inp.dataset.id, inp.value); renderCartPage();
  }));
  document.querySelectorAll('.cart-remove').forEach(b => b.addEventListener('click', () => {
    cart.removeItem(b.dataset.id); renderCartPage();
  }));
}

function renderOrderSummary(el, withCheckoutBtn) {
  if (!el) return;
  const ship = cart.getShipping();
  const remaining = FREE_SHIP_THRESHOLD - cart.getSubtotal();
  el.innerHTML = `
    <h3>Order Summary</h3>
    <div class="summary-row"><span>Subtotal (${cart.getItemCount()} items)</span><span>${formatPrice(cart.getSubtotal())}</span></div>
    <div class="summary-row"><span>Shipping</span><span>${ship === 0 ? 'FREE' : formatPrice(ship)}</span></div>
    <div class="summary-row"><span>Tax (8%)</span><span>${formatPrice(cart.getTax())}</span></div>
    <div class="summary-row total"><span>Total</span><span>${formatPrice(cart.getTotal())}</span></div>
    ${remaining > 0 ? `<p class="summary-note">Add ${formatPrice(remaining)} more for FREE shipping 🚚</p>` : `<p class="summary-note">🎉 You've unlocked free shipping!</p>`}
    <div class="promo-row"><input type="text" placeholder="Promo code"><button class="btn btn-ghost btn-sm">Apply</button></div>
    ${withCheckoutBtn ? `<a class="btn btn-primary btn-block" href="checkout.html">Proceed to Checkout</a>` : ''}
    <p class="summary-note">🔒 Secure checkout · Research use only</p>`;
}

/* ============================================================
   CHECKOUT PAGE  — real payment via Braintree Drop-in
   The browser renders Braintree's Drop-in (cards / PayPal /
   Venmo) to get a payment nonce, then our backend prices the
   cart server-side and runs the sale. Card data never touches
   this page (Braintree-hosted iframes → PCI scope SAQ A).
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
  msg.textContent = text || '';
}

/* read the contact + shipping fields the backend needs */
function collectCheckout(form) {
  const v = name => (form.elements[name] && form.elements[name].value || '').trim();
  const cc = v('country');
  return {
    email: v('email'),
    name: (v('firstName') + ' ' + v('lastName')).trim(),
    address: v('address'),
    city: v('city'),
    state: v('state'),
    postalCode: v('postalCode'),
    // only forward a 2-letter code; "OTHER"/blank → let PayPal collect it
    countryCode: /^[A-Z]{2}$/.test(cc) ? cc : ''
  };
}

/* dynamically load the Braintree Drop-in script */
function loadBraintreeDropin() {
  return new Promise((resolve, reject) => {
    if (window.braintree && window.braintree.dropin) return resolve(window.braintree.dropin);
    const s = document.createElement('script');
    s.src = 'https://js.braintreegateway.com/web/dropin/1.43.0/js/dropin.min.js';
    s.onload = () => (window.braintree && window.braintree.dropin)
      ? resolve(window.braintree.dropin)
      : reject(new Error('Braintree Drop-in failed to initialise.'));
    s.onerror = () => reject(new Error('Could not load the secure checkout.'));
    document.head.appendChild(s);
  });
}

/* ============================================================
   LOYALTY POINTS — redeem at checkout
   Signed-in buyers with a points balance can apply it as money off.
   The discount is folded into the amount we ask Braintree to charge,
   but the SERVER re-prices authoritatively and only spends the points
   once the charge succeeds. State lives in window._enlRedeem so the
   summary, the pay button and the Drop-in amount all agree.
   ============================================================ */
let _dropinInstance = null;   // current Braintree Drop-in (so we can rebuild it)
let _redeemBusy = false;      // guard against overlapping rebuilds

function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }
function enlRedeem() { return window._enlRedeem || { points: 0, discount: 0 }; }

/* Checkout totals mirroring the server's pricing (server stays authoritative
   for the actual charge). The discount lowers the taxable subtotal; free
   shipping is still decided on the pre-discount subtotal. */
function checkoutTotals() {
  const subtotal = round2(cart.getSubtotal());
  const discount = round2(Math.min(enlRedeem().discount || 0, subtotal));
  const shipping = round2(cart.getShipping());
  const taxable = round2(Math.max(0, subtotal - discount));
  const tax = round2(taxable * TAX_RATE);
  return { subtotal, discount, shipping, taxable, tax, total: round2(taxable + shipping + tax) };
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
    <div class="summary-row"><span>Shipping</span><span>${t.shipping === 0 ? 'FREE' : formatPrice(t.shipping)}</span></div>
    ${t.discount > 0 ? `<div class="summary-row discount"><span>Points discount</span><span>−${formatPrice(t.discount)}</span></div>` : ''}
    <div class="summary-row"><span>Tax (8%)</span><span>${formatPrice(t.tax)}</span></div>
    <div class="summary-row total"><span>Total</span><span>${formatPrice(t.total)}</span></div>
    ${canRedeem ? `
      <label class="loyalty-redeem-row">
        <input type="checkbox" id="redeemPoints" ${redeemActive ? 'checked' : ''}>
        <span>Use my <strong>${loy.balance} points</strong> (−${formatPrice(maxRedeem)})</span>
      </label>` : ''}
    ${redeemActive ? `<p class="summary-note">Points apply to <strong>card payment</strong>. You'll still earn points on this order.</p>` : ''}
    <p class="summary-note">🔒 Secure checkout · Research use only</p>`;

  const chk = document.getElementById('redeemPoints');
  if (chk) chk.addEventListener('change', () => onRedeemToggle(chk.checked));
}

/* Toggle points redemption on/off, then re-price everything: summary, the
   crypto option (hidden while points are applied), and the Drop-in amount. */
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
  const form = document.getElementById('checkoutForm');
  renderCheckoutSummary(document.getElementById('checkoutSummary'));
  updateCryptoForRedeem();
  refreshPayment(form);
}

/* Crypto can't apply a points discount, so hide that option while points are
   applied. Also respects the /api/health check (window._cryptoAvailable). */
function updateCryptoForRedeem() {
  const sec = document.getElementById('cryptoPaySection');
  if (!sec) return;
  const active = (enlRedeem().points || 0) > 0;
  sec.style.display = (window._cryptoAvailable !== false && !active) ? '' : 'none';
}

/* Rebuild the Drop-in so the PayPal/Venmo amount matches the discounted total
   (card charges are server-priced regardless). Guarded so rapid toggles queue. */
async function refreshPayment(form) {
  if (_redeemBusy) return;
  _redeemBusy = true;
  const container = document.getElementById('dropin-container');
  const payBtn = document.getElementById('payBtn');
  const loading = document.getElementById('dropinLoading');
  try {
    if (_dropinInstance) {
      try { await _dropinInstance.teardown(); } catch (e) { /* already gone */ }
      _dropinInstance = null;
    }
    if (container) container.innerHTML = '';
    if (payBtn) payBtn.style.display = 'none';
    if (loading) { loading.className = 'form-hint'; loading.style.display = ''; loading.textContent = 'Updating secure checkout…'; }
    await renderBraintreeDropin(form);
  } finally {
    _redeemBusy = false;
  }
}

function showOrderConfirmation(transactionId, pointsEarned) {
  cart.clearCart();
  const earned = Number(pointsEarned) || 0;
  const wrap = document.getElementById('checkoutMain');
  if (wrap) {
    wrap.innerHTML = `
      <div class="empty-state glass">
        <div class="empty-icon">✅</div>
        <h3>Payment received — welcome to the Nest!</h3>
        <p>Thank you. Your payment was processed securely by Braintree (a PayPal service).${transactionId
          ? ` Your transaction reference is <strong>${escapeHtml(transactionId)}</strong>.` : ''}</p>
        ${earned > 0 ? `<p class="text-muted">🎉 You earned <strong>${earned} reward points</strong> on this order — see your balance in <a href="account.html" style="color:var(--accent-purple)">your account</a>.</p>` : ''}
        <p class="text-muted">We've recorded your order and will ship to the address you provided. Keep your transaction reference for your records.</p>
        <a class="btn btn-primary" href="index.html">Back to Home</a>
      </div>`;
  }
}

/* ---- Crypto (BTCPay) confirmation shown when the buyer is redirected
   back to checkout.html?paid=crypto after paying. ---- */
function showCryptoConfirmation(ref) {
  cart.clearCart();
  const wrap = document.getElementById('checkoutMain');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="empty-state glass">
      <div class="empty-icon">✅</div>
      <h3>Payment received — welcome to the Nest!</h3>
      <p>Thank you! Your crypto payment has been received${ref && ref.orderId
        ? ` — your order reference is <strong>${escapeHtml(ref.orderId)}</strong>` : ''}.
        On-chain payments may take a few minutes to fully confirm.</p>
      <p class="text-muted">Once the transaction settles we'll ship to the address you provided. Keep your order reference for your records.</p>
      <a class="btn btn-primary" href="index.html">Back to Home</a>
    </div>`;
}

/* validate the form, open a BTCPay invoice on our server, then send the
   buyer to the hosted crypto checkout. Prices come from the server. */
async function submitCryptoOrder(form, btn) {
  if (cart.items.length === 0) { checkoutSetMsg('Your cart is empty.', 'error'); return; }
  if (!validateCheckout(form)) { checkoutSetMsg('Please complete the highlighted fields first.', 'error'); return; }
  checkoutSetMsg('');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Opening secure crypto checkout…';
  try {
    const checkout = collectCheckout(form);
    const res = await fetch(API_BASE + '/api/crypto/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        items: cart.items.map(i => ({ id: i.id, quantity: i.quantity })),
        shipping: checkout,
        email: checkout.email
      })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.checkoutLink) throw new Error(body.error || 'Could not start crypto checkout.');
    // remember the order so we can show a proper confirmation on redirect back
    try { sessionStorage.setItem('enl_crypto_order', JSON.stringify({ orderId: body.orderId, invoiceId: body.invoiceId })); } catch (e) {}
    window.location.href = body.checkoutLink;   // → hosted BTCPay invoice
  } catch (err) {
    console.error('[crypto checkout]', err);
    checkoutSetMsg((err && err.message) || 'Could not start crypto checkout. Please try again.', 'error');
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

/* run the sale on our server (priced server-side) using the Drop-in nonce */
async function submitOrder(form, payload) {
  const checkout = collectCheckout(form);
  const res = await fetch(API_BASE + '/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({
      items: cart.items.map(i => ({ id: i.id, quantity: i.quantity })),
      shipping: checkout,
      email: checkout.email,
      nonce: payload.nonce,
      deviceData: payload.deviceData,
      pointsToRedeem: enlRedeem().points || 0    // server clamps to the real balance
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) throw new Error(body.error || 'Payment could not be completed.');
  return body;
}

/* validate the form, ask the Drop-in for a payment nonce, then charge it */
async function onPay(instance, form, payBtn) {
  if (cart.items.length === 0) { checkoutSetMsg('Your cart is empty.', 'error'); return; }
  if (!validateCheckout(form)) { checkoutSetMsg('Please complete the highlighted fields first.', 'error'); return; }
  checkoutSetMsg('');
  payBtn.disabled = true;
  payBtn.textContent = 'Processing…';
  try {
    const payload = await instance.requestPaymentMethod();
    checkoutSetMsg('Finalising your payment…', 'success');
    const body = await submitOrder(form, payload);
    showOrderConfirmation(body.transactionId, body.pointsEarned);
  } catch (err) {
    console.error('[checkout pay]', err);
    const noMethod = /no payment method/i.test((err && err.message) || '');
    checkoutSetMsg(
      noMethod ? 'Please choose a payment method above first.'
               : ((err && err.message) || 'Payment could not be completed. Please try again.'),
      'error'
    );
    payBtn.disabled = false;
    payBtn.innerHTML = 'Pay <span id="payBtnAmount">' + escapeHtml(formatPrice(checkoutTotals().total)) + '</span>';
  }
}

async function renderBraintreeDropin(form) {
  const loading = document.getElementById('dropinLoading');
  const container = document.getElementById('dropin-container');
  const payBtn = document.getElementById('payBtn');
  if (!container) return;

  try {
    // 1) get a client token from our backend
    let tokRes;
    try {
      tokRes = await fetch(API_BASE + '/api/client-token');
    } catch (netErr) {
      throw new Error('Can\'t reach the payment server' +
        (API_BASE ? ' at ' + API_BASE : '') + '. Make sure it\'s running (npm start in /server).');
    }
    const tok = await tokRes.json().catch(() => ({}));
    if (tokRes.status === 500) {
      throw new Error(tok.error || 'Payment server has no Braintree keys yet — set up server/.env, then restart it.');
    }
    if (!tokRes.ok || !tok.clientToken) {
      throw new Error(tok.error || ('Payment server returned HTTP ' + tokRes.status + '.'));
    }

    // 2) load the Drop-in and create the instance (cards + PayPal + Venmo)
    const dropin = await loadBraintreeDropin();
    const amount = checkoutTotals().total.toFixed(2);   // reflects any points discount
    const currency = tok.currency || 'USD';
    const baseOpts = { authorization: tok.clientToken, container: '#dropin-container', dataCollector: true };

    let instance;
    try {
      instance = await dropin.create({
        ...baseOpts,
        paypal: { flow: 'checkout', amount: amount, currency: currency },
        venmo: { allowDesktop: true }
      });
    } catch (e) {
      // PayPal/Venmo not enabled on this merchant account → fall back to cards only
      console.warn('[checkout] PayPal/Venmo unavailable, using cards only:', e && e.message);
      instance = await dropin.create(baseOpts);
    }

    _dropinInstance = instance;   // remember it so a points-toggle can rebuild it

    if (loading) loading.style.display = 'none';
    if (payBtn) {
      const amt = document.getElementById('payBtnAmount');
      if (amt) amt.textContent = formatPrice(checkoutTotals().total);
      payBtn.style.display = 'block';
      // assign (not addEventListener) so a Drop-in rebuild can't stack handlers
      payBtn.onclick = () => onPay(instance, form, payBtn);
    }
  } catch (err) {
    console.error('[checkout]', err);
    if (loading) {
      loading.className = 'form-msg error';
      loading.textContent = err.message || 'Payment is temporarily unavailable.';
    }
  }
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

  window._enlRedeem = { points: 0, discount: 0 };
  window._cryptoAvailable = true;
  const summary = document.getElementById('checkoutSummary');
  renderCheckoutSummary(summary);
  // pull the signed-in points balance, then re-render so the redeem control appears
  loadCheckoutLoyalty().then(() => renderCheckoutSummary(summary));

  // line items in summary
  const lineItems = document.getElementById('checkoutItems');
  if (lineItems) {
    if (cart.items.length === 0) {
      lineItems.innerHTML = `<p class="text-muted">Your cart is empty. <a href="products.html" style="color:var(--accent-purple)">Add products</a> to continue.</p>`;
    } else {
      lineItems.innerHTML = cart.items.map(i =>
        `<div class="summary-row"><span>${escapeHtml(i.name)} × ${i.quantity}</span><span>${formatPrice(i.price * i.quantity)}</span></div>`).join('');
    }
  }

  const form = document.getElementById('checkoutForm');
  if (!form) return;

  // a checkout form should never reload the page on Enter
  form.addEventListener('submit', e => e.preventDefault());

  // clear a field's error as the user fixes it
  form.querySelectorAll('.form-field input, .form-field select, .form-field textarea').forEach(inp => {
    inp.addEventListener('input', () => setFieldError(inp.closest('.form-field'), ''));
    inp.addEventListener('change', () => setFieldError(inp.closest('.form-field'), ''));
  });
  const consent = form.querySelector('.form-check input[required]');
  if (consent) consent.addEventListener('change', () => { const r = consent.closest('.form-check'); if (r) r.classList.toggle('invalid', !consent.checked); });

  // crypto (BTCPay) — works independently of the card Drop-in
  const cryptoSection = document.getElementById('cryptoPaySection');
  const cryptoBtn = document.getElementById('cryptoPayBtn');

  // empty cart → don't bother loading the payment form
  if (cart.items.length === 0) {
    const loading = document.getElementById('dropinLoading');
    if (loading) loading.textContent = 'Add items to your cart to check out.';
    if (cryptoSection) cryptoSection.style.display = 'none';
    return;
  }

  if (cryptoBtn && cryptoSection) {
    cryptoBtn.addEventListener('click', () => submitCryptoOrder(form, cryptoBtn));
    // hide the crypto option if the server says BTCPay isn't configured yet
    // (and keep it hidden while points are being redeemed — see updateCryptoForRedeem)
    fetch(API_BASE + '/api/health')
      .then(r => r.json())
      .then(h => { window._cryptoAvailable = !(h && h.crypto === false); updateCryptoForRedeem(); })
      .catch(() => { /* leave visible; a click will surface any real error */ });
  }

  renderBraintreeDropin(form);
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
    root.innerHTML = `<div class="empty-state glass"><div class="empty-icon">💜</div><h3>Your wishlist is empty</h3><p>Tap the heart on any product to save it here for later.</p><a class="btn btn-primary" href="products.html">Browse Products</a></div>`;
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
      <span class="mini-cart-thumb">${createVialPhoto(p)}</span>
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
   FORM VALIDATION (checkout)
   ============================================================ */
function setFieldError(field, msg) {
  if (!field) return;
  field.classList.toggle('invalid', !!msg);
  let e = field.querySelector('.field-error');
  if (msg) {
    if (!e) { e = document.createElement('div'); e.className = 'field-error'; field.appendChild(e); }
    e.textContent = msg;
  } else if (e) { e.remove(); }
}

function validateCheckout(form) {
  let firstInvalid = null;
  form.querySelectorAll('.form-field').forEach(field => {
    const input = field.querySelector('input, select, textarea');
    if (!input) return;
    const val = (input.value || '').trim();
    let msg = '';
    if (input.hasAttribute('required') && !val) msg = 'This field is required.';
    else if (val && input.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) msg = 'Enter a valid email address.';
    else if (val) {
      const ph = input.placeholder || '';
      if (ph.indexOf('4242') > -1 && val.replace(/\D/g, '').length < 13) msg = 'Enter a valid card number.';
      else if (ph === 'MM/YY' && !/^\d{2}\/\d{2}$/.test(val)) msg = 'Use MM/YY format.';
      else if (ph === '123' && !/^\d{3,4}$/.test(val)) msg = 'Enter 3–4 digits.';
    }
    setFieldError(field, msg);
    if (msg && !firstInvalid) firstInvalid = input;
  });
  // consent checkbox (.form-check)
  const consent = form.querySelector('.form-check input[required]');
  const consentRow = consent ? consent.closest('.form-check') : null;
  if (consent && !consent.checked) {
    if (consentRow) consentRow.classList.add('invalid');
    if (!firstInvalid) firstInvalid = consent;
  } else if (consentRow) { consentRow.classList.remove('invalid'); }
  if (firstInvalid) firstInvalid.focus();
  return !firstInvalid;
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

  switch (currentPage) {
    case 'products.html': initProductsPage(); break;
    case 'product.html': initProductDetailPage(); break;
    case 'cart.html': renderCartPage(); break;
    case 'checkout.html': initCheckoutPage(); break;
    case 'faq.html': initFAQPage(); break;
    case 'contact.html': initContactForm(); break;
    case 'wishlist.html': renderWishlistPage(); break;
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
      if (lineItems && cart.items.length) {
        lineItems.innerHTML = cart.items.map(i =>
          `<div class="summary-row"><span>${escapeHtml(i.name)} × ${i.quantity}</span><span>${formatPrice(i.price * i.quantity)}</span></div>`).join('');
      }
    }
  });
});

if (typeof window !== 'undefined') {
  window.createVialSVG = createVialSVG;
  window.createProductCard = createProductCard;
  window.addToCartById = addToCartById;
  window.toggleWishlist = toggleWishlist;
}
