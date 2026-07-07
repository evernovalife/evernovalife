/* ============================================================
   EVER NOVA LIFE — Label PNG builder
   Rasterizes each print-label SVG to a high-res, print-ready PNG
   using headless Chrome. Transparent background, exact physical
   dimensions at the chosen DPI.
     · peptide vials : 1.75" x 0.875"
     · water vial    : 2.5"  x 1.25"
   Run:  node build-pngs.js
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DPI = 600;                 // 300 = standard print; 600 = extra crisp
const MM_PER_IN = 25.4;
const HERE = __dirname;
const OUT = path.join(HERE, 'png');
const TMP = path.join(OUT, '_wrappers');

// physical label sizes (millimeters) by format — match your vial supplier
const SIZE = {
  peptide: { w: 30, h: 46 },   // portrait label (matches the vial)
  water:   { w: 30, h: 46 }    // same portrait format for the water vial
};
const mmToPx = mm => Math.round(mm / MM_PER_IN * DPI);

// every product label file + its physical format
const LABELS = [
  { file: 'retatrutide.html',            format: 'peptide' },
  { file: 'bacteriostatic-water.html',   format: 'water'   },
  { file: 'ghk-cu.html',                 format: 'peptide' },
  { file: 'tesamorelin-ipamorelin.html', format: 'peptide' },
  { file: 'mots-c.html',                 format: 'peptide' },
  { file: 'bpc-tb500.html',              format: 'peptide' },
  { file: 'klow.html',                   format: 'peptide' },
  { file: 'nad.html',                    format: 'peptide' }
];

// locate Chrome (fall back to Edge — both render identically)
function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Edge found.');
}

// pull the outer <svg class="label-svg"> ... </svg> (greedy → includes nested logo svg)
function extractSvg(html) {
  const m = html.match(/<svg class="label-svg"[\s\S]*<\/svg>/);
  if (!m) throw new Error('label-svg not found');
  return m[0];
}

function wrapperHtml(svg, wPx, hPx) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    #stage>svg{display:block;width:${wPx}px;height:${hPx}px}
  </style></head><body><div id="stage">${svg}</div></body></html>`;
}

function main() {
  const browser = findBrowser();
  fs.mkdirSync(TMP, { recursive: true });
  const results = [];

  for (const { file, format } of LABELS) {
    const slug = file.replace(/\.html$/, '');
    const html = fs.readFileSync(path.join(HERE, file), 'utf8');
    const svg = extractSvg(html);

    const wPx = mmToPx(SIZE[format].w);
    const hPx = mmToPx(SIZE[format].h);

    const wrapPath = path.join(TMP, slug + '.html');
    fs.writeFileSync(wrapPath, wrapperHtml(svg, wPx, hPx), 'utf8');

    const outPath = path.join(OUT, slug + '.png');
    execFileSync(browser, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',   // transparent
      '--virtual-time-budget=3000',
      `--window-size=${wPx},${hPx}`,
      `--user-data-dir=${path.join(TMP, '_profile-' + slug)}`,
      `--screenshot=${outPath}`,
      'file:///' + wrapPath.replace(/\\/g, '/')
    ], { stdio: 'ignore' });

    const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
    results.push(`  ${slug}.png  —  ${wPx}x${hPx}px  (${SIZE[format].w}x${SIZE[format].h}mm @ ${DPI}dpi)  ${kb}KB`);
  }

  console.log('\nBuilt ' + results.length + ' label PNGs in print-labels/png/\n');
  console.log(results.join('\n'));

  // tidy up the temp wrappers/profile (best-effort — headless Chrome can briefly
  // keep a lock on its profile dir on Windows, so never let cleanup fail the build)
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.log('\n(note: temp folder ' + TMP + ' left behind — safe to delete manually)');
  }
}

main();
