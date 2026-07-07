/* ============================================================
   EVER NOVA LIFE — vial wordmark refresh
   Surgically replaces ONLY the baked "EVER NOVA LIFE" wordmark on
   each product vial photo: covers the old purple wordmark with a
   clean pink strip lifted from just below it (fixed-background trick
   keeps the vial's cylinder shading aligned), then draws a bigger
   PINK wordmark in the same place. Everything else on the label
   (product name, dose, components, info row) is untouched.

   Pristine vials are kept in _base/ and always used as the source so
   re-runs never stack. Geometry is shared across all vials (same base).

   Run:
     node wordmark-vials.js            preview all -> _preview/<id>.png
     node wordmark-vials.js 1          preview vial 1 only
     node wordmark-vials.js --apply    write final <id>.png in place
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const BASE = path.join(HERE, '_base');
const PREVIEW = path.join(HERE, '_preview');
const TMP = path.join(HERE, '_wm');
const W = 672, H = 1586;

const N = (k, d) => process.env[k] != null ? Number(process.env[k]) : d;
const S = (k, d) => process.env[k] != null ? process.env[k] : d;

// --- shared geometry on the base vial (measured) ---
const WM = {
  cx:     N('CX', 338),     // wordmark centre x
  base:   N('BASE_Y', 810), // text baseline y
  fs:     N('FS', 92),      // NOVA size (the hero word)
  fss:    N('FSS', 60),     // EVER / LIFE size (smaller than NOVA)
  ls:     N('LS', 0),       // letter-spacing
  len:    N('LEN', 528),    // fixed width: condenses the tall glyphs to fit label
  // cover plate over the old purple wordmark
  pL:     N('PL', 80),
  pT:     N('PT', 742),
  pW:     N('PW', 514),
  pH:     N('PH', 54),
  delta:  N('DELTA', 58)    // lift clean pink from this many px below
};
// left-to-right wordmark gradient: indigo-blue -> violet -> magenta -> pink
const G0 = S('G0', '#4f46e5');   // EVER  (indigo/blue)
const G1 = S('G1', '#8b2fd6');   // ->    (violet)
const G2 = S('G2', '#c026d3');   // NOVA  (magenta)
const G3 = S('G3', '#ec4899');   // LIFE  (pink)
const OPACITY = N('OPACITY', 1);       // <1 to see what's underneath

function findBrowser() {
  const c = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('No Chrome/Edge found.');
}

function wrapper(vialPath) {
  const url = 'file:///' + vialPath.replace(/\\/g, '/');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    #stage{position:relative;width:${W}px;height:${H}px}
    #vial{position:absolute;top:0;left:0;width:${W}px;height:${H}px}
    /* cover plate: the vial itself, shifted up DELTA px so a clean pink
       strip from below lands over the old wordmark. Page-fixed bg keeps
       the column shading perfectly aligned. Feathered edges hide the seam. */
    #plate{position:absolute;left:${WM.pL}px;top:${WM.pT}px;width:${WM.pW}px;height:${WM.pH}px;
      background-image:url('${url}');background-size:${W}px ${H}px;
      background-attachment:fixed;background-position:0px -${WM.delta}px;
      -webkit-mask-image:linear-gradient(90deg,transparent,#000 9%,#000 91%,transparent),
                         linear-gradient(#000,#000);
      -webkit-mask-composite:source-in;
      mask-image:linear-gradient(90deg,transparent,#000 9%,#000 91%,transparent);}
    #wm{position:absolute;left:0;top:0;opacity:${OPACITY}}
  </style></head><body><div id="stage">
    <img id="vial" src="${url}">
    <div id="plate"></div>
    <svg id="wm" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="wmgrad" gradientUnits="userSpaceOnUse"
            x1="${WM.cx - (WM.len || 480) / 2}" y1="0" x2="${WM.cx + (WM.len || 480) / 2}" y2="0">
          <stop offset="0%"   stop-color="${G0}"/>
          <stop offset="38%"  stop-color="${G1}"/>
          <stop offset="68%"  stop-color="${G2}"/>
          <stop offset="100%" stop-color="${G3}"/>
        </linearGradient>
      </defs>
      <text x="${WM.cx}" y="${WM.base}" text-anchor="middle" fill="url(#wmgrad)"
            ${WM.len > 0 ? `textLength="${WM.len}" lengthAdjust="spacingAndGlyphs"` : ''}
            letter-spacing="${WM.ls}"
            font-family="'Helvetica Neue',Arial,sans-serif" font-size="${WM.fs}">
        <tspan font-size="${WM.fss}" font-weight="600">EVER </tspan><tspan font-weight="800">NOVA</tspan><tspan font-size="${WM.fss}" font-weight="600"> LIFE</tspan>
      </text>
    </svg>
  </div></body></html>`;
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const want = args.filter(a => /^\d+$/.test(a)).map(Number);
  const ids = (want.length ? want : [1,2,3,4,5,6,7,8]);

  fs.mkdirSync(BASE, { recursive: true });
  for (let id = 1; id <= 8; id++) {
    const b = path.join(BASE, id + '.png');
    if (!fs.existsSync(b) && fs.existsSync(path.join(HERE, id + '.png')))
      fs.copyFileSync(path.join(HERE, id + '.png'), b);
  }

  const browser = findBrowser();
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(PREVIEW, { recursive: true });
  const out = [];
  for (const id of ids) {
    const vialPath = path.join(BASE, id + '.png');
    if (!fs.existsSync(vialPath)) continue;
    const wrapPath = path.join(TMP, id + '.html');
    fs.writeFileSync(wrapPath, wrapper(vialPath), 'utf8');
    const outPath = apply ? path.join(HERE, id + '.png') : path.join(PREVIEW, id + '.png');
    execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--default-background-color=00000000',
      '--virtual-time-budget=4000',
      `--window-size=${W},${H}`,
      `--user-data-dir=${path.join(TMP, '_profile')}`,
      `--screenshot=${outPath}`,
      'file:///' + wrapPath.replace(/\\/g, '/')
    ], { stdio: 'ignore' });
    out.push(`  ${path.relative(path.join(HERE,'..','..'), outPath)}`);
  }
  console.log(`\n${apply ? 'APPLIED' : 'PREVIEW'} ${out.length} vial(s):\n` + out.join('\n'));
  console.log(`\nwordmark fs=${WM.fs} len=${WM.len} base_y=${WM.base}  plate ${WM.pL},${WM.pT} ${WM.pW}x${WM.pH} Δ=${WM.delta}`);
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {}
}
main();
