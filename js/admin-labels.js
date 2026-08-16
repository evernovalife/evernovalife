/* ============================================================
   EVER NOVA LIFE — shipping label renderer (admin only)

   One label = one design (the stock size, the return address,
   which blocks print) + one order (who it goes to, the reference,
   the service bought). The order half is never typed: it is read
   from the stored order, so a label cannot disagree with the sale
   it belongs to.

   The same function builds the on-screen preview and the sheet
   that goes to the printer — a preview that is a different code
   path from the print is a preview that lies. The preview is an
   iframe for exactly that reason: the console's dark theme must
   not leak into a document destined for white 4×6 stock.

   NOT postage. No carrier indicia, nothing prepaid. The barcode
   is the order reference, for picking and for matching a parcel
   back to an order.
   ============================================================ */
(function (window, document) {
  'use strict';

  var MM_PX = 96 / 25.4;          // CSS px per millimetre at 1× zoom

  /* Label stock, mirrored from server/label-design.js. The server is the
     authority — these are here so the console can draw the picker and the
     preview before (or without) a round trip. */
  var SIZES = {
    '4x6': { label: '4 × 6 in (thermal)', widthMm: 101.6, heightMm: 152.4 },
    '4x4': { label: '4 × 4 in', widthMm: 101.6, heightMm: 101.6 },
    '3x4': { label: '3 × 4 in', widthMm: 76.2, heightMm: 101.6 },
    'a6': { label: 'A6 (105 × 148 mm)', widthMm: 105, heightMm: 148 },
    'half': { label: 'Half US Letter (8.5 × 5.5 in)', widthMm: 215.9, heightMm: 139.7 },
    'custom': { label: 'Custom size', widthMm: 101.6, heightMm: 152.4 }
  };

  var DEFAULT = {
    size: '4x6', widthMm: 101.6, heightMm: 152.4, paddingMm: 5, fontScale: 1,
    border: true, showLogo: true, showFrom: true, showBarcode: true, showItems: true,
    showService: true, showDate: true, showEmail: false, showResearchNote: true,
    barcodeSource: 'orderId',
    from: { name: 'Ever Nova Life', line1: '', line2: '', city: '', state: '', postalCode: '', country: 'USA', phone: '' },
    handling: '',
    researchNote: 'For in-vitro research use only. Not for human or veterinary use.',
    footer: ''
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ============================================================
     CODE 39 BARCODE
     Chosen over Code 128 on purpose: an order reference is
     uppercase letters, digits and a dash, which is exactly what
     Code 39 encodes, and its table is short enough to be checked
     by eye. Every scanner reads it. The reference is printed
     underneath in plain type regardless, so a smudged label is
     still a readable label.
     ============================================================ */
  var C39 = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
    '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
    'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn',
    'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
    'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn',
    'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
    'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn',
    'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
    '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn'
  };

  /* Anything Code 39 can't hold becomes a dash rather than being dropped, so
     the printed text and the bars always carry the same number of characters. */
  function c39Clean(value) {
    return String(value == null ? '' : value).toUpperCase()
      .replace(/[^0-9A-Z\-. $/+%]/g, '-')
      .slice(0, 24);
  }

  /* SVG bars, sized to fill `widthMm`. Narrow:wide is 1:3, one narrow unit
     between characters, ten units of quiet zone each side — below that
     scanners start missing the start character. */
  function barcodeSvg(value, widthMm, heightMm) {
    var text = c39Clean(value);
    if (!text) return '';
    var chars = ('*' + text + '*').split('');
    var units = 0, i, j, p;
    for (i = 0; i < chars.length; i++) {
      if (!C39[chars[i]]) return '';
      units += 15 + (i < chars.length - 1 ? 1 : 0);
    }
    var quiet = 10;
    var total = units + quiet * 2;
    var unit = widthMm / total;

    var rects = '', x = quiet * unit;
    for (i = 0; i < chars.length; i++) {
      p = C39[chars[i]];
      for (j = 0; j < 9; j++) {
        var w = (p[j] === 'w' ? 3 : 1) * unit;
        if (j % 2 === 0) {          // even elements are bars, odd are spaces
          rects += '<rect x="' + x.toFixed(3) + '" y="0" width="' + w.toFixed(3) +
            '" height="' + heightMm + '" fill="#000"/>';
        }
        x += w;
      }
      x += unit;                    // inter-character gap
    }
    return '<svg class="bc" viewBox="0 0 ' + widthMm + ' ' + heightMm + '" width="' + widthMm +
      'mm" height="' + heightMm + 'mm" preserveAspectRatio="none" ' +
      'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc(text) + '">' +
      rects + '</svg>';
  }

  /* ============================================================
     THE LABEL
     ============================================================ */

  function addressLines(a) {
    a = a || {};
    var who = String(a.name || ((a.firstName || '') + ' ' + (a.lastName || ''))).trim();
    var cityLine = [a.city, a.state].filter(Boolean).join(', ');
    if (a.postalCode) cityLine = (cityLine ? cityLine + '  ' : '') + a.postalCode;
    var country = String(a.countryCode || a.country || '').trim();
    // US parcels don't name the country; anything else must.
    if (/^(us|usa|united states)$/i.test(country)) country = '';
    return [who, a.institution, a.address || a.line1, a.line2, cityLine, country]
      .map(function (s) { return String(s == null ? '' : s).trim(); })
      .filter(Boolean);
  }

  function fromLines(from) {
    from = from || {};
    var cityLine = [from.city, from.state].filter(Boolean).join(', ');
    if (from.postalCode) cityLine = (cityLine ? cityLine + '  ' : '') + from.postalCode;
    var country = String(from.country || '').trim();
    if (/^(us|usa|united states)$/i.test(country)) country = '';
    return [from.name, from.line1, from.line2, cityLine, country, from.phone]
      .map(function (s) { return String(s == null ? '' : s).trim(); })
      .filter(Boolean);
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  var MARK = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M50 50 L50 0 L54.97 37.99 Z" fill="#000"/><path d="M50 50 L100 50 L62.01 54.97 Z" fill="#000"/>' +
    '<path d="M50 50 L50 100 L45.03 62.01 Z" fill="#000"/><path d="M50 50 L0 50 L37.99 45.03 Z" fill="#000"/>' +
    '<circle cx="50" cy="50" r="6" fill="#000"/></svg>';

  /* One label, as a self-contained block. Everything inside is sized in mm so
     what the preview shows at 4×6 is what the printer puts on 4×6 stock. */
  function labelHtml(order, design) {
    var d = withDefaults(design);
    var o = order || {};
    var inner = d.widthMm - d.paddingMm * 2;
    var to = addressLines(o.shippingAddress);
    var from = fromLines(d.from);
    var barValue = d.barcodeSource === 'tracking' ? (o.tracking || o.orderId) : o.orderId;

    var items = (o.items || []).map(function (i) {
      return esc(i.name) + ' <b>×' + esc(i.quantity) + '</b>';
    });
    var extra = items.length > 6 ? items.length - 6 : 0;
    if (extra) items = items.slice(0, 6);

    return '<div class="lbl' + (d.border ? ' bordered' : '') + '">' +
      '<div class="pad">' +

        (d.showLogo || d.showService
          ? '<div class="top">' +
              (d.showLogo
                ? '<div class="brand">' + MARK + '<span>' + esc(d.from.name || 'Ever Nova Life') + '</span></div>'
                : '<div></div>') +
              (d.showService && (o.shippingLabel || o.shippingMethod)
                ? '<div class="svc">' + esc(o.shippingLabel || o.shippingMethod) + '</div>'
                : '') +
            '</div>'
          : '') +

        (d.showFrom
          ? '<div class="blk from">' +
              '<div class="cap">From</div>' +
              (from.length
                ? '<div class="addr sm">' + from.map(esc).join('<br>') + '</div>'
                : '<div class="addr sm missing">No return address set — add one in Admin → Label designer</div>') +
            '</div>'
          : '') +

        '<div class="blk to">' +
          '<div class="cap">Ship to</div>' +
          (to.length
            ? '<div class="addr big">' + to.map(function (l, i) {
                return i === 0 ? '<b>' + esc(l) + '</b>' : esc(l);
              }).join('<br>') + '</div>'
            : '<div class="addr big missing">This order has no delivery address on it</div>') +
          (d.showEmail && (o.email || o.userEmail)
            ? '<div class="mail">' + esc(o.email || o.userEmail) + '</div>' : '') +
        '</div>' +

        (d.handling ? '<div class="stamp">' + esc(d.handling) + '</div>' : '') +

        (d.showBarcode && barValue
          ? '<div class="bcwrap">' + barcodeSvg(barValue, inner, Math.max(10, d.heightMm * 0.09)) +
              '<div class="bctext">' + esc(c39Clean(barValue)) + '</div>' +
            '</div>'
          : '<div class="bcwrap"><div class="bctext">' + esc(o.orderId || '') + '</div></div>') +

        (d.showItems && items.length
          ? '<div class="blk items">' +
              '<div class="cap">Contents</div>' +
              '<div class="itemlist">' + items.join('<br>') +
                (extra ? '<br>+ ' + extra + ' more line' + (extra === 1 ? '' : 's') : '') +
              '</div>' +
            '</div>'
          : '') +

        '<div class="foot">' +
          (d.showResearchNote && d.researchNote ? '<div class="note">' + esc(d.researchNote) + '</div>' : '') +
          '<div class="meta">' +
            '<span>' + esc(o.orderId || '') + '</span>' +
            (d.showDate ? '<span>' + esc(fmtDate(o.paidAt || o.createdAt)) + '</span>' : '') +
          '</div>' +
          (d.footer ? '<div class="note">' + esc(d.footer) + '</div>' : '') +
        '</div>' +

      '</div>' +
    '</div>';
  }

  /* The stylesheet is written per-design because the page size, the padding and
     the type scale ARE the design — they cannot live in a static file. */
  function labelCss(design) {
    var d = withDefaults(design);
    var s = d.fontScale;
    var base = (3.0 * s).toFixed(2);

    return '@page { size: ' + d.widthMm + 'mm ' + d.heightMm + 'mm; margin: 0; }' +
      '* { box-sizing: border-box; }' +
      'html, body { margin: 0; padding: 0; background: #fff; }' +
      'body { font-family: Arial, Helvetica, sans-serif; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }' +
      '.lbl { width: ' + d.widthMm + 'mm; height: ' + d.heightMm + 'mm; overflow: hidden; ' +
        'background: #fff; position: relative; page-break-after: always; break-after: page; }' +
      '.lbl:last-child { page-break-after: auto; break-after: auto; }' +
      '.lbl.bordered .pad { border: 0.4mm solid #000; }' +
      '.pad { width: 100%; height: 100%; padding: ' + d.paddingMm + 'mm; display: flex; flex-direction: column; ' +
        'gap: ' + (1.6 * s).toFixed(2) + 'mm; font-size: ' + base + 'mm; line-height: 1.25; }' +
      '.top { display: flex; align-items: center; justify-content: space-between; gap: 2mm; ' +
        'border-bottom: 0.3mm solid #000; padding-bottom: ' + (1.4 * s).toFixed(2) + 'mm; }' +
      '.brand { display: flex; align-items: center; gap: 1.6mm; font-weight: 700; ' +
        'letter-spacing: 0.06em; text-transform: uppercase; font-size: ' + (3.1 * s).toFixed(2) + 'mm; }' +
      '.brand svg { width: ' + (5 * s).toFixed(2) + 'mm; height: ' + (5 * s).toFixed(2) + 'mm; flex: 0 0 auto; }' +
      '.svc { border: 0.3mm solid #000; padding: 0.6mm 1.6mm; font-weight: 700; text-transform: uppercase; ' +
        'letter-spacing: 0.05em; font-size: ' + (2.7 * s).toFixed(2) + 'mm; white-space: nowrap; }' +
      '.cap { text-transform: uppercase; letter-spacing: 0.12em; font-size: ' + (2.2 * s).toFixed(2) + 'mm; ' +
        'color: #444; margin-bottom: 0.8mm; }' +
      '.addr.sm { font-size: ' + (2.8 * s).toFixed(2) + 'mm; line-height: 1.3; }' +
      '.addr.big { font-size: ' + (4.4 * s).toFixed(2) + 'mm; line-height: 1.32; }' +
      '.addr.big b { font-size: ' + (5.0 * s).toFixed(2) + 'mm; }' +
      '.addr .missing, .missing { font-style: italic; }' +
      /* The delivery block takes whatever height is left over: on a 4×6 that
         makes it the thing the eye lands on, and it keeps the slack INSIDE the
         two rules rather than leaving a hole between blocks. */
      '.blk.to { border-top: 0.3mm solid #000; border-bottom: 0.3mm solid #000; padding: ' +
        (2 * s).toFixed(2) + 'mm 0; flex: 1 1 auto; }' +
      '.mail { font-size: ' + (2.6 * s).toFixed(2) + 'mm; color: #333; margin-top: 1mm; }' +
      '.stamp { border: 0.5mm solid #000; text-align: center; font-weight: 700; text-transform: uppercase; ' +
        'letter-spacing: 0.08em; padding: 1.2mm; font-size: ' + (3.4 * s).toFixed(2) + 'mm; }' +
      '.bcwrap { text-align: center; margin-top: auto; }' +
      '.bcwrap .bc { display: block; width: 100%; }' +
      '.bctext { font-family: "Courier New", Courier, monospace; font-weight: 700; ' +
        'letter-spacing: 0.18em; font-size: ' + (3.2 * s).toFixed(2) + 'mm; margin-top: 0.8mm; }' +
      '.itemlist { font-size: ' + (2.7 * s).toFixed(2) + 'mm; line-height: 1.35; }' +
      '.foot { border-top: 0.3mm solid #000; padding-top: 1.2mm; }' +
      '.note { font-size: ' + (2.3 * s).toFixed(2) + 'mm; color: #333; line-height: 1.3; }' +
      '.meta { display: flex; justify-content: space-between; gap: 2mm; margin-top: 0.6mm; ' +
        'font-size: ' + (2.3 * s).toFixed(2) + 'mm; color: #444; }';
  }

  /* A complete document — what the print window gets, and what the preview
     iframe gets. One builder, so they can never drift apart. */
  function documentHtml(orders, design, opts) {
    opts = opts || {};
    var list = (orders || []).map(function (o) { return labelHtml(o, design); }).join('');
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>' + esc(opts.title || 'Shipping labels') + '</title>' +
      '<style>' + labelCss(design) + (opts.extraCss || '') + '</style>' +
      '</head><body>' + list + '</body></html>';
  }

  /* Open the sheet and send it to the printer. One order or fifty — the print
     dialog is opened once, because a dialog per parcel is how a packing session
     turns into an afternoon. */
  function printLabels(orders, design, opts) {
    opts = opts || {};
    var list = (orders || []).filter(Boolean);
    if (!list.length) return { ok: false, error: 'Nothing to print.' };

    var w = window.open('', '_blank', 'width=520,height=760');
    if (!w) return { ok: false, error: 'Your browser blocked the print window — allow pop-ups for this page.' };

    w.document.write(documentHtml(list, design, {
      title: list.length === 1 ? 'Label ' + (list[0].orderId || '') : list.length + ' shipping labels'
    }));
    w.document.close();
    w.focus();
    // Give the SVG bars a tick to lay out before the dialog freezes the page.
    w.setTimeout(function () { w.print(); }, 120);
    return { ok: true, count: list.length };
  }

  /* What the designer previews when no real order is loaded. Obvious fake
     names, so a sample label can never be mistaken for a parcel to send. */
  function sampleOrder() {
    return {
      orderId: 'ENL-SAMPLE01',
      createdAt: new Date().toISOString(),
      paidAt: new Date().toISOString(),
      email: 'buyer@example.com',
      shippingLabel: 'Standard',
      shippingMethod: 'standard',
      tracking: '',
      shippingAddress: {
        name: 'Dr Sample Buyer',
        institution: 'Example Research Lab',
        address: '1200 Example Parkway, Suite 300',
        city: 'Austin', state: 'TX', postalCode: '78701', countryCode: 'US'
      },
      items: [
        { name: 'Example Peptide A 5mg', quantity: 2 },
        { name: 'Example Peptide B 10mg', quantity: 1 }
      ]
    };
  }

  function withDefaults(design) {
    var d = Object.assign({}, DEFAULT, design || {});
    d.from = Object.assign({}, DEFAULT.from, (design && design.from) || {});
    var preset = SIZES[d.size] || SIZES['4x6'];
    if (d.size !== 'custom') { d.widthMm = preset.widthMm; d.heightMm = preset.heightMm; }
    d.widthMm = Number(d.widthMm) || preset.widthMm;
    d.heightMm = Number(d.heightMm) || preset.heightMm;
    d.paddingMm = Number(d.paddingMm);
    if (!isFinite(d.paddingMm)) d.paddingMm = 5;
    d.fontScale = Number(d.fontScale) || 1;
    return d;
  }

  /* Does the design still have a usable return address? Carriers need one to
     return an undeliverable parcel, so the console nags until it does. */
  function returnAddressMissing(design) {
    var f = withDefaults(design).from;
    return !(f.line1 && f.city && f.state && f.postalCode);
  }

  window.AdminLabels = {
    SIZES: SIZES,
    DEFAULT: DEFAULT,
    MM_PX: MM_PX,
    labelHtml: labelHtml,
    labelCss: labelCss,
    documentHtml: documentHtml,
    printLabels: printLabels,
    sampleOrder: sampleOrder,
    withDefaults: withDefaults,
    returnAddressMissing: returnAddressMissing,
    barcodeSvg: barcodeSvg,
    c39Clean: c39Clean
  };
})(window, document);
