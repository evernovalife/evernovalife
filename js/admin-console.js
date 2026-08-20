/* ============================================================
   EVER NOVA LIFE — Admin console (admin.html)
   Dashboard · Orders · Auto-Ship · Customers

   Everything on this page is derived from four API reads:

     GET /api/admin/orders          every order, newest first
     GET /api/admin/users           every account
     GET /api/admin/subscriptions   every auto-ship plan
     GET /api/products              the catalog (for stock)

   The sales figures are computed HERE rather than on the server, on
   purpose: the shop's order history is small enough to sum in the browser
   in a millisecond, and doing it client-side means the dashboard can never
   disagree with the order table on the same page — they are the same
   array. It also means no new endpoint to deploy before the numbers work.
   If the order history ever outgrows one response, that is the moment to
   move this into a /api/admin/stats route, not before.
   ============================================================ */
(function (window, document) {
  'use strict';

  var A = window.Admin;
  var esc = A.esc, money = A.money, num = A.num;

  /* Only a paid order is a sale. Everything else is either still in flight
     (an open invoice, a Zelle transfer nobody has confirmed) or dead. */
  var PAID = 'paid';
  /* Open = money not in (or not all of it), so the order is still a decision:
     confirm it or cancel it. `underpaid` is a crypto invoice that expired with
     a short payment against it — the coins are in the wallet, the order isn't
     paid, and it stays here until someone settles it either way. */
  var OPEN = ['pending', 'awaiting_payment', 'underpaid'];

  /* ---- test orders ----
     Braintree ran in SANDBOX (`BRAINTREE_ENV || 'sandbox'`), and the card
     route stamped an order `paid` the instant the gateway approved it. A test
     card number therefore produced a real-looking paid order carrying no
     money. Cards were removed entirely in Aug 2026 — braintree.js, the
     dependency and POST /api/checkout are gone — so `method: 'card'` can only
     mean an order from that period.

     Those records are excluded from every figure on this console. Counting
     them makes revenue, average order and best-sellers all wrong, and the
     error is permanent because nothing will ever pay them off. They are not
     deleted or hidden away: the order still exists on the server, and Orders →
     All still lists it, flagged, so the books can be explained later. */
  function isTestOrder(o) { return o && o.method === 'card'; }
  function realOrders(list) { return (list || []).filter(function (o) { return !isTestOrder(o); }); }

  var state = {
    orders: null,
    users: null,
    subs: null,
    products: null,
    btcpay: null,         // loaded on demand — it calls out to another host
    hooks: null,          // BTCPay webhook wiring, loaded alongside btcpay
    health: null,         // /api/health — which services the backend actually has
    rates: null,          // shipping methods (what checkout charges for delivery)
    promos: null,         // promotions (what the shop is discounting right now)
    design: null,         // the shipping-label design (admin-only read)
    previewId: '',        // which order the label designer is previewing
    disputes: null,        // customer dispute threads (the queue and its tally)
    disputeId: '',         // which thread the right pane is showing
    disputeThread: null,   // the full thread, loaded when one is opened
    disputeOutcomes: [],   // how a report can be closed, from the list response
    disputeTab: 'awaiting_us',
    range: 30,            // days; 0 = all time
    view: 'dashboard',
    loading: false
  };

  var shell, body;

  /* ============================================================
     DATA
     ============================================================ */

  async function loadAll(opts) {
    opts = opts || {};
    state.loading = true;
    if (!opts.quiet) render();

    // Settled, not all: one failing endpoint should not blank the console.
    var results = await Promise.allSettled([
      A.api('/api/admin/orders'),
      A.api('/api/admin/users'),
      A.api('/api/admin/subscriptions'),
      A.api('/api/products'),
      A.api('/api/health'),
      A.api('/api/shipping'),
      A.api('/api/admin/label-design'),
      A.api('/api/admin/promotions'),
      A.api('/api/admin/disputes')
    ]);
    state.loading = false;

    var authFailed = results.some(function (r) {
      return r.status === 'rejected' && (r.reason.status === 401 || r.reason.status === 403);
    });
    if (authFailed) { renderGate(results[0].reason && results[0].reason.message); return; }

    var offline = results.every(function (r) { return r.status === 'rejected' && r.reason.status === 0; });
    if (offline) {
      body.innerHTML = A.empty('The server is not answering',
        'The backend may be asleep. Wait a few seconds and press Refresh.');
      return;
    }

    state.orders = results[0].status === 'fulfilled' ? (results[0].value.orders || []) : (state.orders || []);
    state.users = results[1].status === 'fulfilled' ? (results[1].value.users || []) : (state.users || []);
    state.subs = results[2].status === 'fulfilled' ? (results[2].value.subscriptions || []) : (state.subs || []);
    state.products = results[3].status === 'fulfilled' ? (results[3].value.products || []) : (state.products || []);
    state.health = results[4].status === 'fulfilled' ? results[4].value : (state.health || null);
    state.rates = results[5].status === 'fulfilled' ? (results[5].value.methods || []) : (state.rates || null);
    state.design = results[6].status === 'fulfilled' ? (results[6].value.design || null) : (state.design || null);
    state.promos = results[7].status === 'fulfilled' ? (results[7].value.promotions || []) : (state.promos || null);
    state.disputes = results[8].status === 'fulfilled' ? (results[8].value.disputes || []) : (state.disputes || []);
    if (results[8].status === 'fulfilled') state.disputeOutcomes = results[8].value.outcomes || [];

    results.forEach(function (r, i) {
      if (r.status === 'rejected' && r.reason.status !== 0) {
        // Health is a diagnostic, not data — its failure is not worth a toast.
        if (i === 4) return;
        // Shipping rates: a 404 just means the backend predates them, and the
        // view says so in place. Anything else is worth a word.
        if (i === 5 && r.reason.status === 404) return;
        // Same for the label design — an older backend simply has no designer,
        // and the view explains that rather than shouting about it.
        if (i === 6 && r.reason.status === 404) return;
        // Promotions: a 404 means the backend predates them; the view says so.
        if (i === 7 && r.reason.status === 404) return;
        // Disputes: a 404 means the backend predates them; the view says so.
        if (i === 8 && r.reason.status === 404) return;
        A.toast(['Orders', 'Users', 'Auto-ship plans', 'Products', 'Health', 'Shipping rates',
          'Label design', 'Promotions', 'Disputes'][i] + ': ' + r.reason.message, 'error');
      }
    });

    render();
  }

  /* ---- derived figures ---- */

  /* The date a sale HAPPENED is the date the money landed, not the date the
     invoice opened — a Zelle order placed on the 30th and confirmed on the
     2nd belongs to the new month. */
  function saleDate(o) { return o.paidAt || o.createdAt; }

  function inWindow(iso, fromMs, toMs) {
    var t = new Date(iso).getTime();
    return !isNaN(t) && t >= fromMs && t < toMs;
  }

  function windowFor(days, endMs) {
    var end = endMs || Date.now();
    if (!days) return { from: 0, to: end, days: 0 };
    return { from: end - days * 86400000, to: end, days: days };
  }

  function summarise(orders, win) {
    var paid = orders.filter(function (o) {
      return o.status === PAID && !isTestOrder(o) &&
        (!win.days || inWindow(saleDate(o), win.from, win.to));
    });
    var revenue = 0, units = 0;
    paid.forEach(function (o) {
      revenue += Number(o.total) || 0;
      (o.items || []).forEach(function (it) { units += Number(it.quantity) || 0; });
    });
    return {
      revenue: revenue,
      orders: paid.length,
      units: units,
      aov: paid.length ? revenue / paid.length : 0,
      list: paid
    };
  }

  function openOrders(orders) {
    return orders.filter(function (o) { return OPEN.indexOf(o.status) !== -1 && !isTestOrder(o); });
  }

  /* Paid, not yet shipped — the fulfilment queue. Sandbox orders are excluded:
     nothing was ever bought, so there is nothing to pack. Oldest first, because
     the person who has waited longest should be packed first. */
  function toShip(orders) {
    return orders.filter(function (o) { return o.status === PAID && !isTestOrder(o); })
      .sort(function (a, b) { return new Date(a.paidAt || a.createdAt) - new Date(b.paidAt || b.createdAt); });
  }

  function topProducts(paidOrders, limit) {
    var byName = {};
    paidOrders.forEach(function (o) {
      (o.items || []).forEach(function (it) {
        var name = it.name || ('#' + it.id);
        var line = Number(it.lineTotal);
        if (!isFinite(line)) line = (Number(it.unitPrice) || 0) * (Number(it.quantity) || 0);
        if (!byName[name]) byName[name] = { name: name, revenue: 0, units: 0 };
        byName[name].revenue += line;
        byName[name].units += Number(it.quantity) || 0;
      });
    });
    return Object.keys(byName).map(function (k) { return byName[k]; })
      .sort(function (a, b) { return b.revenue - a.revenue; })
      .slice(0, limit || 6);
  }

  function methodMix(paidOrders) {
    var by = {};
    paidOrders.forEach(function (o) {
      var m = o.method || 'other';
      if (!by[m]) by[m] = { name: m, revenue: 0, count: 0 };
      by[m].revenue += Number(o.total) || 0;
      by[m].count += 1;
    });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.revenue - a.revenue; });
  }

  /* Bucket revenue into columns for the chart. Under ~5 weeks a bar per day
     is readable; past that the bars get too thin to hit, so they roll up
     into weeks. */
  function series(paidOrders, win) {
    var end = win.days ? win.to : Date.now();
    var start;
    if (win.days) {
      start = win.from;
    } else {
      var earliest = paidOrders.reduce(function (min, o) {
        var t = new Date(saleDate(o)).getTime();
        return (!isNaN(t) && t < min) ? t : min;
      }, end);
      start = Math.min(earliest, end - 13 * 86400000);
    }
    var span = Math.max(1, Math.ceil((end - start) / 86400000));
    var stepDays = span <= 35 ? 1 : (span <= 210 ? 7 : 30);
    var buckets = [];
    for (var t = start; t < end; t += stepDays * 86400000) {
      buckets.push({ from: t, to: Math.min(t + stepDays * 86400000, end), value: 0, count: 0 });
    }
    if (!buckets.length) buckets.push({ from: start, to: end, value: 0, count: 0 });
    paidOrders.forEach(function (o) {
      var t = new Date(saleDate(o)).getTime();
      if (isNaN(t)) return;
      for (var i = 0; i < buckets.length; i++) {
        if (t >= buckets[i].from && t < buckets[i].to) {
          buckets[i].value += Number(o.total) || 0;
          buckets[i].count += 1;
          return;
        }
      }
      if (t >= buckets[buckets.length - 1].to) {
        buckets[buckets.length - 1].value += Number(o.total) || 0;
        buckets[buckets.length - 1].count += 1;
      }
    });
    return { buckets: buckets, stepDays: stepDays };
  }

  /* ============================================================
     CHART — hand-drawn SVG
     No chart library: the page is a static file on shared hosting behind a
     strict cache, and one bar chart is not worth 80KB of dependency.
     ============================================================ */
  function niceCeil(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / mag;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * mag;
  }
  /* Axis money: no cents — a gridline is a scale, not a receipt. */
  function axisMoney(v) {
    if (v >= 1000) return '$' + (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k';
    return '$' + Math.round(v);
  }

  function chart(data) {
    var W = 760, H = 190, padL = 46, padR = 8, padT = 12, padB = 22;
    var buckets = data.buckets;
    var max = buckets.reduce(function (m, b) { return Math.max(m, b.value); }, 0);
    if (max <= 0) {
      return '<div class="chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
        'aria-label="No paid orders in this period">' +
        '<text class="chart-empty" x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle">' +
        'No paid orders in this period</text></svg></div>';
    }

    // Round the top of the scale up to a readable number, so the gridlines
    // land on $200 / $500 / $1k instead of $273.99.
    max = niceCeil(max);

    var plotW = W - padL - padR, plotH = H - padT - padB;
    var slot = plotW / buckets.length;
    var barW = Math.max(2, Math.min(34, slot * 0.62));

    var svg = '<div class="chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'aria-label="Revenue by ' + (data.stepDays === 1 ? 'day' : data.stepDays === 7 ? 'week' : 'month') + '">' +
      '<defs><linearGradient id="admBar" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#6d28d9"/>' +
      '</linearGradient></defs>';

    // horizontal grid + value axis
    for (var g = 0; g <= 3; g++) {
      var y = padT + (plotH / 3) * g;
      var v = max * (1 - g / 3);
      svg += '<line class="chart-grid" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '"/>' +
        '<text class="chart-axis" x="' + (padL - 6) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' +
        esc(axisMoney(v)) + '</text>';
    }

    buckets.forEach(function (b, i) {
      var h = (b.value / max) * plotH;
      var x = padL + slot * i + (slot - barW) / 2;
      var y = padT + plotH - h;
      var label = A.date(new Date(b.from).toISOString()) +
        (data.stepDays > 1 ? '–' + A.date(new Date(b.to - 1).toISOString()) : '') +
        ' · ' + money(b.value) + ' · ' + A.plural(b.count, 'order');
      svg += '<rect class="chart-bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) +
        '" height="' + Math.max(1, h).toFixed(1) + '" rx="2"><title>' + esc(label) + '</title></rect>';
    });

    // date axis: first, middle, last only — more than three labels collide
    [0, Math.floor(buckets.length / 2), buckets.length - 1].filter(function (v, i, arr) {
      return arr.indexOf(v) === i;
    }).forEach(function (i) {
      var b = buckets[i];
      var x = padL + slot * i + slot / 2;
      var anchor = i === 0 ? 'start' : (i === buckets.length - 1 ? 'end' : 'middle');
      svg += '<text class="chart-axis" x="' + x.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + anchor + '">' +
        esc(A.date(new Date(b.from).toISOString())) + '</text>';
    });

    return svg + '</svg></div>';
  }

  /* ============================================================
     RENDER
     ============================================================ */

  var TITLES = {
    dashboard: ['Dashboard', 'Sales, at a glance'],
    orders: ['Orders', 'Every order, and the ones waiting on money'],
    ship: ['To ship', 'Paid orders waiting to go out, with everything you need to pack them'],
    rates: ['Shipping rates', 'What checkout charges for delivery — edit it here, it applies immediately'],
    promos: ['Promotions', 'Deals the shop is running — they apply to the next checkout immediately'],
    labeldesign: ['Label designer', 'Design the parcel label once — every order fills in its own name and address'],
    btcpay: ['BTCPay', 'What the payment server says, next to what we recorded'],
    autoship: ['Auto-Ship', 'Repeating orders and their next invoice'],
    disputes: ['Disputes', 'Problems customers have reported, and how they ended'],
    customers: ['Customers', 'Everyone with an account']
  };

  function render() {
    var t = TITLES[state.view] || TITLES.dashboard;
    shell.title.textContent = t[0];
    shell.subtitle.textContent = t[1];
    shell.barRight.innerHTML =
      (state.view === 'dashboard'
        ? '<div class="seg" id="rangeSeg" role="group" aria-label="Date range">' +
            [[7, '7d'], [30, '30d'], [90, '90d'], [0, 'All']].map(function (r) {
              return '<button type="button" data-range="' + r[0] + '" aria-pressed="' +
                (state.range === r[0]) + '">' + r[1] + '</button>';
            }).join('') +
          '</div>'
        : '') +
      '<button class="btn btn-ghost btn-sm" type="button" id="refreshBtn">' + A.icon('refresh', 'ic') + ' Refresh</button>' +
      A.whoChip();

    if (state.loading && !state.orders) { body.innerHTML = loadingSkeleton(); return; }

    if (state.view === 'orders') renderOrders();
    else if (state.view === 'ship') renderShip();
    else if (state.view === 'rates') renderRates();
    else if (state.view === 'promos') renderPromos();
    else if (state.view === 'labeldesign') renderLabelDesign();
    else if (state.view === 'btcpay') renderBtcpay();
    else if (state.view === 'autoship') renderAutoship();
    else if (state.view === 'disputes') renderDisputes();
    else if (state.view === 'customers') renderCustomers();
    else renderDashboard();

    updateNavTally();
  }

  function loadingSkeleton() {
    return '<div class="kpi-grid">' +
      new Array(5).join('.').split('.').map(function () {
        return '<div class="kpi">' + A.skeleton(2) + '</div>';
      }).join('') +
      '</div><div class="adm-card">' + A.skeleton(6) + '</div>';
  }

  function updateNavTally() {
    var el = document.getElementById('navUnpaid');
    if (el) {
      var n = state.orders ? openOrders(state.orders).length : 0;
      el.textContent = n ? String(n) : '';
    }
    // Settled at BTCPay but unpaid here — the one BTCPay number worth
    // carrying on every screen, because it means someone paid and is waiting.
    var b = document.getElementById('navBtcpay');
    if (b) {
      var stuck = (state.btcpay && state.btcpay.invoices || []).filter(function (i) { return i.needsAttention; }).length;
      b.textContent = stuck ? String(stuck) : '';
    }
    // Paid and not yet out the door — the one number that means "someone is
    // waiting for a parcel", so it rides on every screen.
    var s = document.getElementById('navShip');
    if (s) {
      var n2 = state.orders ? toShip(state.orders).length : 0;
      s.textContent = n2 ? String(n2) : '';
    }
    // Threads where the customer spoke last — the queue that is waiting on us.
    var dq = document.getElementById('navDisputes');
    if (dq) {
      var n3 = (state.disputes || []).filter(function (d) { return d.unreadForAdmin; }).length;
      dq.textContent = n3 ? String(n3) : '';
    }
  }

  function renderGate(message) {
    body.innerHTML = A.gateHtml(message);
    A.bindGate(body, function () { loadAll(); });
  }

  /* A store that can't email is a store where orders arrive in silence: the
     buyer gets no pay link and no receipt, and nobody is told to ship. That
     failure is invisible from the outside — the dashboard just looks quiet —
     so it is said out loud here rather than left to be discovered by a
     customer asking where their order went. */
  function alertsWarning() {
    var h = state.health;
    if (!h) return '';
    var problems = [];
    if (h.email === false) problems.push('no <code>SMTP_USER</code> / <code>SMTP_PASS</code>, so <strong>no email is sent to buyers at all</strong> — no pay links, no receipts');
    if (h.ownerAlerts === false) problems.push('no <code>ADMIN_EMAIL</code>, so <strong>you are not told when an order is placed or paid</strong>');
    if (!problems.length) return '';
    return '<div class="adm-card" style="border-color:rgba(244,63,94,.4);background:rgba(244,63,94,.06)">' +
      '<div class="adm-card-head"><h3>Order notifications are off</h3></div>' +
      '<ul class="adm-note" style="margin:0;padding-left:1.1rem">' +
        problems.map(function (p) { return '<li>' + p + '</li>'; }).join('') +
      '</ul>' +
      '<p class="adm-note" style="margin:.6rem 0 0">Set these in the backend environment (Render → Environment), then redeploy.</p>' +
    '</div>';
  }

  /* ---- DASHBOARD ---- */
  function renderDashboard() {
    var orders = state.orders || [];
    var win = windowFor(state.range);
    var now = summarise(orders, win);

    // Previous window of the same length, for the deltas. Meaningless on
    // "All time", so it isn't shown there.
    var prev = state.range
      ? summarise(orders, windowFor(state.range, win.from))
      : null;

    var open = openOrders(orders);
    var owed = open.reduce(function (s, o) { return s + (Number(o.total) || 0); }, 0);
    var lowStock = (state.products || []).filter(function (p) {
      return p.stockQty !== null && p.stockQty !== undefined && Number(p.stockQty) <= 5;
    }).sort(function (a, b) { return Number(a.stockQty) - Number(b.stockQty); });

    var rangeLabel = state.range ? 'last ' + state.range + ' days' : 'all time';

    body.innerHTML =
      alertsWarning() +
      '<div class="kpi-grid">' +
        kpi('Revenue', money(now.revenue), rangeLabel, delta(now.revenue, prev && prev.revenue), 'gold') +
        kpi('Paid orders', num(now.orders), rangeLabel, delta(now.orders, prev && prev.orders)) +
        kpi('Average order', money(now.aov), now.orders ? 'across ' + A.plural(now.orders, 'order') : 'no orders yet',
            delta(now.aov, prev && prev.aov)) +
        kpi('Units shipped', num(now.units), rangeLabel, delta(now.units, prev && prev.units)) +
        kpi('Awaiting payment', money(owed), A.plural(open.length, 'order') + ' open', '', 'amber') +
      '</div>' +

      '<div class="adm-grid two">' +
        '<div class="adm-card">' +
          '<div class="adm-card-head"><h3>Revenue</h3>' +
            '<span class="hint">paid orders, by ' + (state.range && state.range <= 35 ? 'day' : state.range === 90 ? 'week' : 'period') + '</span>' +
            '<div class="right"><button class="btn btn-ghost btn-sm" type="button" id="csvBtn">' +
              A.icon('download', 'ic') + ' Export CSV</button></div>' +
          '</div>' +
          chart(series(now.list, win)) +
        '</div>' +
        '<div class="adm-card">' +
          '<div class="adm-card-head"><h3>Best sellers</h3><span class="hint">by revenue</span></div>' +
          rankList(topProducts(now.list), function (r) { return money(r.revenue); },
                   function (r) { return A.plural(r.units, 'unit') + ' sold'; },
                   'Nothing sold in this period') +
        '</div>' +
      '</div>' +

      '<div class="adm-grid split">' +
        '<div class="adm-card">' +
          '<div class="adm-card-head"><h3>How they paid</h3><span class="hint">' + esc(rangeLabel) + '</span></div>' +
          rankList(methodMix(now.list).map(function (m) {
            return { name: methodLabel(m.name), revenue: m.revenue, units: m.count };
          }), function (r) { return money(r.revenue); },
             function (r) { return A.plural(r.units, 'order'); },
             'No payments in this period') +
        '</div>' +
        '<div class="adm-card">' +
          '<div class="adm-card-head"><h3>Stock running out</h3>' +
            '<div class="right"><a class="btn btn-ghost btn-sm" href="admin-products.html">Manage stock</a></div></div>' +
          (lowStock.length
            ? '<div class="rank">' + lowStock.slice(0, 6).map(function (p) {
                var qty = Number(p.stockQty);
                return '<div class="rank-row" style="background:' +
                  (qty === 0 ? 'rgba(244,63,94,.12)' : 'rgba(224,165,42,.1)') + '">' +
                  '<span class="rank-name">' + esc(p.name) + '</span>' +
                  '<span class="rank-val" style="color:' + (qty === 0 ? 'var(--accent-coral)' : 'var(--accent-amber)') + '">' +
                  (qty === 0 ? 'sold out' : qty + ' left') + '</span></div>';
              }).join('') + '</div>'
            : A.empty('Stock is healthy', 'Nothing tracked is down to 5 units or fewer.')) +
        '</div>' +
      '</div>' +

      '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Latest orders</h3>' +
          '<div class="right"><a class="btn btn-ghost btn-sm" href="#orders">See all orders</a></div></div>' +
        ordersTable(realOrders(orders).slice(0, 8), { compact: true }) +
      '</div>' +

      // Said once, quietly, at the bottom: the figures above are missing
      // something, and this is what. Silent exclusions are how books stop
      // adding up six months later.
      (orders.length - realOrders(orders).length
        ? '<p class="adm-note" style="margin:0">' +
          A.plural(orders.length - realOrders(orders).length, 'sandbox card order') +
          ' from the retired Braintree gateway ' +
          (orders.length - realOrders(orders).length === 1 ? 'is' : 'are') +
          ' left out of every figure on this page — the gateway ran in test mode, so those orders carry no money. ' +
          'They are still listed under <a href="#orders">Orders → All</a>.</p>'
        : '');

    var seg = document.getElementById('rangeSeg');
    if (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-range]');
        if (!b) return;
        state.range = Number(b.getAttribute('data-range'));
        render();
      });
    }
    var csv = document.getElementById('csvBtn');
    if (csv) csv.addEventListener('click', function () { exportOrders(now.list, rangeLabel); });
  }

  function kpi(label, value, sub, deltaHtml, tone) {
    return '<div class="kpi' + (tone ? ' ' + tone : '') + '">' +
      '<div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-value">' + esc(value) + '</div>' +
      '<div class="kpi-sub">' + esc(sub) + '</div>' +
      (deltaHtml || '') + '</div>';
  }

  /* A percentage move against the previous window. "New" is shown instead of
     +∞ when the previous window was empty, because a first sale is not a
     percentage. */
  function delta(now, before) {
    if (before === null || before === undefined) return '';
    if (!before) return now ? '<span class="kpi-delta up">new</span>' : '';
    var pct = ((now - before) / before) * 100;
    if (Math.abs(pct) < 0.5) return '<span class="kpi-delta flat">no change</span>';
    var up = pct > 0;
    return '<span class="kpi-delta ' + (up ? 'up' : 'down') + '">' +
      A.icon(up ? 'up' : 'down') + Math.abs(pct).toFixed(0) + '% vs previous</span>';
  }

  function rankList(rows, valueFn, subFn, emptyText) {
    if (!rows.length) return A.empty(emptyText);
    var max = rows.reduce(function (m, r) { return Math.max(m, r.revenue); }, 0) || 1;
    return '<div class="rank">' + rows.map(function (r) {
      var pct = Math.max(4, (r.revenue / max) * 100);
      return '<div class="rank-row">' +
        '<span class="rank-fill" style="width:' + pct.toFixed(1) + '%"></span>' +
        '<span class="rank-name">' + esc(r.name) + '</span>' +
        '<span class="rank-val">' + esc(valueFn(r)) + '<br><span class="rank-sub">' + esc(subFn(r)) + '</span></span>' +
        '</div>';
    }).join('') + '</div>';
  }

  function exportOrders(orders, label) {
    var rows = [['Order', 'Placed', 'Paid', 'Status', 'Method', 'Customer', 'Items', 'Subtotal', 'Shipping', 'Tax', 'Total']];
    orders.forEach(function (o) {
      rows.push([
        o.orderId, o.createdAt || '', o.paidAt || '', o.status || '', o.method || '',
        o.userEmail || o.email || '',
        (o.items || []).map(function (i) { return i.name + ' x' + i.quantity; }).join('; '),
        o.subtotal || 0, o.shippingCost || 0, o.tax || 0, o.total || 0
      ]);
    });
    A.downloadCsv('ever-nova-sales-' + String(label).replace(/\s+/g, '-') + '.csv', rows);
    A.toast('Exported ' + A.plural(orders.length, 'order') + '.', 'success');
  }

  /* ---- ORDERS ---- */
  var orderFilter = 'open';

  function renderOrders() {
    var orders = state.orders || [];
    // Paid counts real sales only; All is literally everything the server
    // holds, sandbox orders included, so nothing is invisible from here.
    var cancelled = orders.filter(function (o) { return o.status === 'cancelled'; });
    var counts = {
      open: openOrders(orders).length,
      paid: realOrders(orders).filter(function (o) { return o.status === PAID; }).length,
      cancelled: cancelled.length,
      all: orders.length
    };
    var shown = orderFilter === 'all' ? orders
      : orderFilter === 'paid' ? realOrders(orders).filter(function (o) { return o.status === PAID; })
      : orderFilter === 'cancelled' ? cancelled
      : openOrders(orders);

    body.innerHTML =
      '<div class="adm-card">' +
        '<div class="adm-card-head">' +
          '<h3>Orders</h3>' +
          '<div class="seg" id="orderSeg" role="group" aria-label="Filter orders">' +
            [['open', 'Unpaid (' + counts.open + ')'],
             ['paid', 'Paid (' + counts.paid + ')'],
             /* Cancelled gets its own tab because it is the state most orders
                actually end in: an expired crypto invoice. With only Unpaid and
                Paid on screen, both reading 0, a store full of expired orders
                looks like a store nobody has ever ordered from. */
             ['cancelled', 'Cancelled (' + counts.cancelled + ')'],
             ['all', 'All (' + counts.all + ')']].map(function (f) {
              return '<button type="button" data-filter="' + f[0] + '" aria-pressed="' +
                (orderFilter === f[0]) + '">' + esc(f[1]) + '</button>';
            }).join('') +
          '</div>' +
          '<div class="right"><button class="btn btn-ghost btn-sm" type="button" id="csvAllBtn">' +
            A.icon('download', 'ic') + ' Export CSV</button></div>' +
        '</div>' +
        (orderFilter === 'open'
          ? '<p class="adm-note"><strong>Zelle</strong> orders are the ones that need you: there is no webhook, so ' +
            'nothing tells us the money arrived except your bank. Match the <strong>reference</strong> below against ' +
            'the transfer memo, then mark it paid — that is what emails the customer, credits their points and ' +
            'releases the order. Only confirm money you can actually see. ' +
            '<strong>Crypto</strong> orders sitting at <em>pending</em> settle themselves when the BTCPay invoice is ' +
            'paid; they only need a Cancel if the invoice expired unpaid.' +
            (counts.open === 0 && counts.cancelled
              ? ' <br><strong>Nothing here does not mean nothing happened:</strong> ' +
                A.plural(counts.cancelled, 'order') + ' ended cancelled — see the Cancelled tab.'
              : '') + '</p>'
          : '') +
        (orderFilter === 'cancelled'
          ? '<p class="adm-note">Orders whose payment window closed with nothing received, plus anything cancelled by ' +
            'hand. These <strong>did</strong> come in — the customer reached checkout and their details are below — ' +
            'they just never paid. A run of them on crypto usually means the BTCPay invoice expiry is too short for ' +
            'an on-chain payment to land.</p>'
          : '') +
        ordersTable(shown, { actions: true }) +
      '</div>';

    var seg = document.getElementById('orderSeg');
    if (seg) seg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-filter]');
      if (!b) return;
      orderFilter = b.getAttribute('data-filter');
      render();
    });
    var csv = document.getElementById('csvAllBtn');
    if (csv) csv.addEventListener('click', function () { exportOrders(shown, orderFilter); });
  }

  /* ============================================================
     SHIPPING RATES
     What checkout charges for delivery, as editable data. The fee used to be a
     constant compiled into the pricing code, which meant the published table,
     the browser's arithmetic and the amount actually invoiced were three copies
     kept in step by hand. Saving here changes what the next customer pays.

     A method with `freeOver` set costs nothing once the cart's subtotal reaches
     that figure — 0 means never free.
     ============================================================ */
  function renderRates() {
    var rates = state.rates;

    if (!rates) {
      body.innerHTML = '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Shipping rates are not available</h3></div>' +
        '<p class="adm-note" style="margin:0">This backend does not have the shipping rate table yet — deploy the ' +
        'current <code>server/</code> to Render. Until then checkout charges the built-in flat rate ' +
        '($9.99, free over $100).</p></div>';
      return;
    }

    var enabled = rates.filter(function (m) { return m.enabled; });

    body.innerHTML =
      '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Delivery options</h3>' +
          '<span class="hint">what the customer picks and pays at checkout</span></div>' +
        '<p class="adm-note">Edits apply to the <strong>next</strong> checkout immediately — no deploy needed. ' +
          'Only <strong>enabled</strong> methods are offered; if just one is enabled the checkout shows no picker and ' +
          'simply charges it. Checkout needs at least one enabled method, so the last one cannot be turned off or ' +
          'deleted. <strong>Free over</strong> is the cart subtotal at which that method becomes free — set 0 for never.</p>' +
        '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
          '<th>Method</th><th>Delivery estimate</th><th class="num">Fee</th><th class="num">Free over</th>' +
          '<th>Offered</th><th></th>' +
        '</tr></thead><tbody>' +
        rates.map(rateRow).join('') +
        '</tbody></table></div>' +
      '</div>' +

      '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Add a method</h3>' +
          '<span class="hint">e.g. a cold-chain or Saturday service</span></div>' +
        rateForm('new', { id: '', name: '', eta: '', price: '', freeOver: 0, enabled: true, sort: 50 }) +
      '</div>' +

      (enabled.length === 1
        ? '<p class="adm-note">Right now every order is <strong>' + esc(enabled[0].name) + '</strong> at ' +
          esc(money(enabled[0].price)) +
          (Number(enabled[0].freeOver) > 0 ? ', free over ' + esc(money(enabled[0].freeOver)) : '') +
          '. Enable a second method to give customers a choice at checkout.</p>'
        : '') +

      '<p class="adm-note">The public rate table on <a href="shipping.html" target="_blank" rel="noopener">shipping.html</a> ' +
        'reads from this same list, so it updates itself — nothing to keep in step by hand.</p>';
  }

  /* One row per method, with its own inline form. Editing in place beats a modal
     here: the whole point is comparing the rates against each other. */
  function rateRow(m) {
    return '<tr>' +
      '<td><strong>' + esc(m.name) + '</strong><span class="muted">' + esc(m.id) + '</span></td>' +
      '<td>' + esc(m.eta || '—') + '</td>' +
      '<td class="num">' + esc(money(m.price)) + '</td>' +
      '<td class="num">' + (Number(m.freeOver) > 0 ? esc(money(m.freeOver)) : '<span class="muted">never</span>') + '</td>' +
      '<td><span class="pill ' + (m.enabled ? 'paid' : 'cancelled') + '">' +
        (m.enabled ? 'at checkout' : 'hidden') + '</span></td>' +
      '<td class="actions">' +
        '<button class="btn btn-ghost btn-sm act-rate-edit" data-id="' + esc(m.id) + '">Edit</button> ' +
        '<button class="btn btn-ghost btn-sm act-rate-del" data-id="' + esc(m.id) +
          '" data-name="' + esc(m.name) + '">Delete</button>' +
      '</td>' +
    '</tr>' +
    /* The edit form lives in the table as a hidden sibling row, so opening it
       cannot reorder or reflow the list above it. */
    '<tr class="rate-edit-row" id="rate-edit-' + esc(m.id) + '" hidden>' +
      '<td colspan="6">' + rateForm(m.id, m) + '</td>' +
    '</tr>';
  }

  function rateForm(key, m) {
    var p = 'rate-' + key + '-';
    return '<div class="rate-form">' +
      '<div class="form-field"><label for="' + p + 'name">Name</label>' +
        '<input id="' + p + 'name" type="text" value="' + esc(m.name || '') + '" placeholder="Overnight"></div>' +
      '<div class="form-field"><label for="' + p + 'eta">Delivery estimate</label>' +
        '<input id="' + p + 'eta" type="text" value="' + esc(m.eta || '') + '" placeholder="Next business day"></div>' +
      '<div class="form-field"><label for="' + p + 'price">Fee ($)</label>' +
        '<input id="' + p + 'price" type="number" min="0" step="0.01" value="' + esc(m.price) + '" placeholder="34.99"></div>' +
      '<div class="form-field"><label for="' + p + 'free">Free over ($)</label>' +
        '<input id="' + p + 'free" type="number" min="0" step="1" value="' + esc(m.freeOver || 0) + '" placeholder="0"></div>' +
      '<div class="form-field"><label for="' + p + 'sort">Order</label>' +
        '<input id="' + p + 'sort" type="number" min="0" step="10" value="' + esc(m.sort == null ? 50 : m.sort) + '"></div>' +
      '<label class="form-check rate-enabled"><input id="' + p + 'enabled" type="checkbox" ' +
        (m.enabled !== false ? 'checked' : '') + '> Offer at checkout</label>' +
      '<button class="btn btn-primary act-rate-save" data-key="' + esc(key) + '" data-id="' + esc(m.id || '') + '">' +
        (key === 'new' ? 'Add method' : 'Save') + '</button>' +
    '</div>';
  }

  function toggleRateEdit(id) {
    var row = document.getElementById('rate-edit-' + id);
    if (row) row.hidden = !row.hidden;
  }

  async function saveRate(key, id, btn) {
    var p = 'rate-' + key + '-';
    var val = function (suffix) { var el = document.getElementById(p + suffix); return el ? el.value : ''; };
    var checked = function (suffix) { var el = document.getElementById(p + suffix); return !!(el && el.checked); };
    var payload = {
      id: id || '',
      name: val('name'),
      eta: val('eta'),
      price: Number(val('price')) || 0,
      freeOver: Number(val('free')) || 0,
      sort: Number(val('sort')) || 50,
      enabled: checked('enabled')
    };
    if (!payload.name.trim()) { A.toast('Give the method a name.', 'error'); return; }

    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = 'Saving…';
    try {
      var data = await A.api('/api/shipping', { method: 'POST', body: payload });
      state.rates = data.methods || state.rates;
      A.toast(payload.name + ' saved — it applies to the next checkout.', 'success');
      render();
    } catch (e) {
      A.toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function deleteRate(id, name, btn) {
    if (!window.confirm('Delete the "' + name + '" shipping method?\n\n' +
        'Customers will no longer be able to choose it. Orders already placed keep the fee they were charged.')) return;
    btn.disabled = true;
    try {
      var data = await A.api('/api/shipping/' + encodeURIComponent(id), { method: 'DELETE' });
      state.rates = data.methods || state.rates;
      A.toast(name + ' deleted.', 'success');
      render();
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
  }

  /* ============================================================
     PROMOTIONS
     Scheduled deals, as editable data. Saving here changes what the
     NEXT customer is charged — pricing.js reads the same list, so
     there is nothing to deploy and nothing to keep in step by hand.

     Three tabs off one array: what is running, what is waiting for
     its start date, and what is over. An expired promotion is kept
     rather than deleted, because "run last month's deal again" is
     the most common next thing anyone wants.
     ============================================================ */
  var PROMO_TYPES = [
    ['sale', 'Sale price', 'A product costs less for a while'],
    ['bogo', 'Buy X get Y', 'Buy 1 get 1, buy 2 get 1 — the free units ship free'],
    ['cart', 'Cart discount', 'Money off the whole order over a minimum'],
    ['shipping', 'Free shipping', 'Delivery is free while this runs']
  ];
  var promoTab = 'live';

  function promoState(p) {
    var now = Date.now();
    if (p.enabled === false) return 'off';
    if (p.startsAt && Date.parse(p.startsAt) > now) return 'scheduled';
    if (p.endsAt && Date.parse(p.endsAt) <= now) return 'expired';
    return 'live';
  }

  /* What this promotion actually does, in one line, so the table can be read
     without opening every row. */
  function promoRule(p) {
    if (p.type === 'shipping') return 'Free shipping on every order';
    if (p.type === 'bogo') return 'Buy ' + p.buyQty + ', get ' + p.freeQty + ' free';
    if (p.type === 'cart') {
      /* No `fixed` arm here. The engine's cart phase (server/promotions.js) has
         only a percent branch and an else that means "$ off" — there is no
         "set the order total to $N" rule to describe. The form no longer offers
         it; an older row that stored `fixed` is described the way it is
         actually priced, so this line can't contradict the invoice. */
      var cut = p.mode === 'percent' ? p.value + '% off' : money(p.value) + ' off';
      return cut + ' the order' + (p.minSubtotal > 0 ? ' over ' + money(p.minSubtotal) : '');
    }
    return p.mode === 'percent' ? p.value + '% off'
      : p.mode === 'amount' ? money(p.value) + ' off'
      : 'price set to ' + money(p.value);
  }

  function promoScope(p) {
    if (p.type === 'cart' || p.type === 'shipping') return 'Whole order';
    if (!p.productIds || !p.productIds.length) return 'Every product';
    var names = p.productIds.map(function (id) {
      var hit = (state.products || []).find(function (pr) { return Number(pr.id) === Number(id); });
      return hit ? hit.name : '#' + id;
    });
    return names.join(', ');
  }

  function promoWindow(p) {
    if (!p.startsAt && !p.endsAt) return 'No end date';
    var from = p.startsAt ? A.date(p.startsAt) : 'now';
    var to = p.endsAt ? A.date(p.endsAt) : 'no end';
    return from + ' → ' + to;
  }

  function renderPromos() {
    var promos = state.promos;

    if (!promos) {
      body.innerHTML = '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Promotions are not available</h3></div>' +
        '<p class="adm-note" style="margin:0">This backend does not have promotions yet — deploy the ' +
        'current <code>server/</code> to Render. Until then every order is charged at catalog price.</p></div>';
      return;
    }

    var groups = { live: [], scheduled: [], expired: [], off: [] };
    promos.forEach(function (p) { groups[promoState(p)].push(p); });
    // The off-switch list belongs with whatever else isn't charging anyone.
    groups.expired = groups.expired.concat(groups.off);

    var shown = groups[promoTab] || [];

    body.innerHTML =
      '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Deals</h3>' +
          '<span class="hint">saving one changes what the next customer pays</span></div>' +
        '<div class="seg" id="promoTabs" role="group" aria-label="Promotion state">' +
          [['live', 'Live', groups.live.length],
           ['scheduled', 'Scheduled', groups.scheduled.length],
           ['expired', 'Finished', groups.expired.length]].map(function (t) {
            return '<button type="button" data-ptab="' + t[0] + '" aria-pressed="' + (promoTab === t[0]) + '">' +
              t[1] + ' (' + t[2] + ')</button>';
          }).join('') +
        '</div>' +
        (shown.length
          ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
              '<th>Promotion</th><th>What it does</th><th>Applies to</th><th>When</th><th></th>' +
            '</tr></thead><tbody>' + shown.map(promoRow).join('') + '</tbody></table></div>'
          : '<p class="adm-note" style="margin:0">Nothing here yet.</p>') +
      '</div>' +

      '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Create a promotion</h3>' +
          '<span class="hint">e.g. buy 1 get 1, or 20% off for ten days</span></div>' +
        promoForm('new', { id: '', name: '', badge: '', type: 'sale', productIds: [], mode: 'percent',
                           value: '', buyQty: 1, freeQty: 1, minSubtotal: 0,
                           startsAt: '', endsAt: '', enabled: true, sort: 50 }) +
      '</div>' +

      '<p class="adm-note">Only the <strong>best</strong> deal applies to any one product — a sale and a ' +
        'buy-one-get-one on the same product will not stack, the customer gets whichever is worth more. ' +
        'One cart-wide discount applies on top of that. Repeating <a href="admin.html#autoship">auto-ship</a> ' +
        'invoices are always charged at catalog price.</p>';

    body.querySelectorAll('.promo-form').forEach(syncPromoFields);
  }

  function promoRow(p) {
    var st = promoState(p);
    var pill = st === 'live' ? 'paid' : st === 'scheduled' ? 'pending' : 'cancelled';
    return '<tr>' +
      '<td><strong>' + esc(p.name) + '</strong>' +
        (p.badge ? ' <span class="pill ' + pill + '">' + esc(p.badge) + '</span>' : '') +
        '<span class="muted">' + esc(p.id) + '</span></td>' +
      '<td>' + esc(promoRule(p)) + '</td>' +
      '<td>' + esc(promoScope(p)) + '</td>' +
      '<td>' + esc(promoWindow(p)) + (p.enabled === false ? ' <span class="muted">(switched off)</span>' : '') + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-ghost btn-sm act-promo-edit" data-id="' + esc(p.id) + '">Edit</button> ' +
        '<button class="btn btn-ghost btn-sm act-promo-del" data-id="' + esc(p.id) +
          '" data-name="' + esc(p.name) + '">Delete</button>' +
      '</td>' +
    '</tr>' +
    '<tr class="promo-edit-row" id="promo-edit-' + esc(p.id) + '" hidden>' +
      '<td colspan="5">' + promoForm(p.id, p) + '</td>' +
    '</tr>';
  }

  /* A datetime-local input wants 'YYYY-MM-DDTHH:mm' in LOCAL time; the store
     holds UTC ISO. Convert both ways or the owner sets a start date and the
     form shows a different one back. */
  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fromLocalInput(v) {
    if (!v) return null;
    var t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }

  function promoForm(key, p) {
    var pre = 'promo-' + key + '-';
    var ids = (p.productIds || []).join(',');
    var opts = (state.products || []).map(function (pr) {
      return '<label class="form-check"><input type="checkbox" class="' + pre + 'sku" value="' + esc(pr.id) + '"' +
        ((p.productIds || []).map(Number).indexOf(Number(pr.id)) !== -1 ? ' checked' : '') + '> ' +
        esc(pr.name) + '</label>';
    }).join('');

    return '<div class="promo-form" data-key="' + esc(key) + '">' +
      '<div class="form-field"><label for="' + pre + 'name">Name</label>' +
        '<input id="' + pre + 'name" type="text" value="' + esc(p.name || '') + '" placeholder="Retatrutide — Buy 1 Get 1"></div>' +
      '<div class="form-field"><label for="' + pre + 'badge">Badge on the shop</label>' +
        '<input id="' + pre + 'badge" type="text" maxlength="16" value="' + esc(p.badge || '') + '" placeholder="BUY 1 GET 1"></div>' +
      '<div class="form-field"><label for="' + pre + 'type">Type</label>' +
        '<select id="' + pre + 'type" class="promo-type">' +
          PROMO_TYPES.map(function (t) {
            return '<option value="' + t[0] + '"' + (p.type === t[0] ? ' selected' : '') + '>' + esc(t[1]) + '</option>';
          }).join('') +
        '</select></div>' +

      /* TWO mode selects, one per type, each carrying a single promo-if- class
         so syncPromoFields shows exactly one of them. They are NOT the same
         list: `set the price to` is a per-product rule, and the engine's cart
         phase has no `fixed` branch — offering it there let an owner ask for
         "cart total → $50" and silently get "$50 off". Distinct ids, because a
         duplicate id would make savePromo read whichever one the DOM happened
         to hand back. */
      '<div class="form-field promo-if-sale"><label for="' + pre + 'mode">Discount</label>' +
        '<select id="' + pre + 'mode">' +
          [['percent', '% off'], ['amount', '$ off'], ['fixed', 'set the price to']].map(function (m) {
            return '<option value="' + m[0] + '"' + (p.mode === m[0] ? ' selected' : '') + '>' + esc(m[1]) + '</option>';
          }).join('') +
        '</select></div>' +
      '<div class="form-field promo-if-cart"><label for="' + pre + 'cartmode">Discount</label>' +
        '<select id="' + pre + 'cartmode">' +
          [['percent', '% off'], ['amount', '$ off']].map(function (m) {
            /* A legacy row stored as `fixed` lands on `$ off`, which is what the
               engine was charging for it anyway. */
            return '<option value="' + m[0] + '"' +
              ((p.mode === 'percent' ? 'percent' : 'amount') === m[0] ? ' selected' : '') + '>' + esc(m[1]) + '</option>';
          }).join('') +
        '</select></div>' +
      '<div class="form-field promo-if-sale promo-if-cart"><label for="' + pre + 'value">Amount</label>' +
        '<input id="' + pre + 'value" type="number" min="0" step="0.01" value="' + esc(p.value === '' ? '' : p.value) + '" placeholder="20"></div>' +

      '<div class="form-field promo-if-bogo"><label for="' + pre + 'buy">Buy</label>' +
        '<input id="' + pre + 'buy" type="number" min="1" step="1" value="' + esc(p.buyQty || 1) + '"></div>' +
      '<div class="form-field promo-if-bogo"><label for="' + pre + 'free">Get free</label>' +
        '<input id="' + pre + 'free" type="number" min="0" step="1" value="' + esc(p.freeQty == null ? 1 : p.freeQty) + '"></div>' +

      '<div class="form-field promo-if-cart"><label for="' + pre + 'min">Order must be over ($)</label>' +
        '<input id="' + pre + 'min" type="number" min="0" step="1" value="' + esc(p.minSubtotal || 0) + '"></div>' +

      '<div class="form-field"><label for="' + pre + 'starts">Starts</label>' +
        '<input id="' + pre + 'starts" type="datetime-local" value="' + esc(toLocalInput(p.startsAt)) + '"></div>' +
      '<div class="form-field"><label for="' + pre + 'ends">Ends</label>' +
        '<input id="' + pre + 'ends" type="datetime-local" value="' + esc(toLocalInput(p.endsAt)) + '"></div>' +
      '<div class="form-field"><label for="' + pre + 'sort">Order</label>' +
        '<input id="' + pre + 'sort" type="number" min="0" step="10" value="' + esc(p.sort == null ? 50 : p.sort) + '"></div>' +

      '<div class="form-field promo-if-sale promo-if-bogo promo-skus"><label>Products <span class="hint">none ticked = every product</span></label>' +
        '<div class="promo-sku-list" data-ids="' + esc(ids) + '">' + (opts || '<span class="muted">No products loaded</span>') + '</div></div>' +

      '<label class="form-check"><input id="' + pre + 'enabled" type="checkbox" ' +
        (p.enabled !== false ? 'checked' : '') + '> Running (untick to switch it off without deleting it)</label>' +
      '<button class="btn btn-primary act-promo-save" data-key="' + esc(key) + '" data-id="' + esc(p.id || '') + '">' +
        (key === 'new' ? 'Create promotion' : 'Save') + '</button>' +
    '</div>';
  }

  function togglePromoEdit(id) {
    var row = document.getElementById('promo-edit-' + id);
    if (row) row.hidden = !row.hidden;
  }

  /* Only show the fields the chosen type actually uses — a bogo has no
     percentage and a free-shipping promo has neither. */
  function syncPromoFields(form) {
    var sel = form.querySelector('.promo-type');
    if (!sel) return;
    var type = sel.value;
    form.querySelectorAll('[class*="promo-if-"]').forEach(function (el) {
      el.hidden = !el.classList.contains('promo-if-' + type);
    });
  }

  async function savePromo(key, id, btn) {
    var pre = 'promo-' + key + '-';
    var val = function (s) { var el = document.getElementById(pre + s); return el ? el.value : ''; };
    var checked = function (s) { var el = document.getElementById(pre + s); return !!(el && el.checked); };
    var skus = Array.prototype.slice.call(document.querySelectorAll('.' + pre + 'sku'))
      .filter(function (c) { return c.checked; })
      .map(function (c) { return Number(c.value); });

    /* The form carries a mode select per type; read the one belonging to the
       type actually chosen, so a cart promo can never be saved as `fixed`. */
    var type = val('type');
    var mode = type === 'cart' ? val('cartmode') : val('mode');

    var payload = {
      id: id || '',
      name: val('name'),
      badge: val('badge'),
      type: type,
      productIds: skus,
      mode: mode,
      value: Number(val('value')) || 0,
      buyQty: Number(val('buy')) || 1,
      freeQty: Number(val('free')) || 0,
      minSubtotal: Number(val('min')) || 0,
      startsAt: fromLocalInput(val('starts')),
      endsAt: fromLocalInput(val('ends')),
      sort: Number(val('sort')) || 50,
      enabled: checked('enabled')
    };

    btn.disabled = true;
    try {
      var out = await A.api('/api/admin/promotions', { method: 'POST', body: payload });
      state.promos = out.promotions || [];
      A.toast('Saved — it applies to the next checkout', 'success');
      render();
    } catch (e) {
      A.toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function deletePromo(id, name) {
    if (!confirm('Delete "' + name + '"? Orders already placed keep the price they were charged.')) return;
    try {
      var out = await A.api('/api/admin/promotions/' + encodeURIComponent(id), { method: 'DELETE' });
      state.promos = out.promotions || [];
      A.toast('Deleted', 'success');
      render();
    } catch (e) {
      A.toast(e.message, 'error');
    }
  }

  /* ============================================================
     LABEL DESIGNER
     The parcel label is designed ONCE, here, and then every paid order prints
     itself: the name, the delivery address, the reference, the service bought
     and the contents all come off the order record. Nothing on a label is ever
     retyped, which is the only way the label on the box and the order in the
     books can be guaranteed to agree.

     The preview is an iframe running the same document the printer gets — a
     preview built from different code is a preview that lies about the thing
     you are about to print onto physical stock.
     ============================================================ */

  var LBL = window.AdminLabels;

  function renderLabelDesign() {
    if (!LBL) {
      body.innerHTML = '<div class="adm-card"><p class="adm-note" style="margin:0">' +
        'The label renderer did not load — check that <code>js/admin-labels.js</code> is uploaded.</p></div>';
      return;
    }
    if (!state.design) {
      body.innerHTML = '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>The label designer is not available</h3></div>' +
        '<p class="adm-note" style="margin:0">This backend has no label design store yet — deploy the current ' +
        '<code>server/</code> to Render. The rest of the console works without it; only saving a design needs it.</p>' +
        '</div>';
      return;
    }

    var d = LBL.withDefaults(state.design);
    var queue = toShip(state.orders || []);
    var missing = LBL.returnAddressMissing(d);

    body.innerHTML =
      (missing
        ? '<p class="adm-note" style="color:var(--accent-coral)"><strong>No return address yet.</strong> ' +
          'Carriers need one to return an undeliverable parcel — fill in <em>Return address</em> below. ' +
          'It is stored on the server for the label only and is never shown anywhere on the public site.</p>'
        : '') +

      '<div class="lbl-designer">' +

        '<div class="adm-card lbl-form">' +
          '<div class="adm-card-head"><h3>Label</h3><span class="hint">applies to every label you print</span></div>' +

          '<h4 class="ship-h">Stock &amp; layout</h4>' +
          '<div class="lbl-grid">' +
            field('ld-size', 'Label size',
              '<select id="ld-size">' +
                Object.keys(LBL.SIZES).map(function (k) {
                  return '<option value="' + esc(k) + '"' + (d.size === k ? ' selected' : '') + '>' +
                    esc(LBL.SIZES[k].label) + '</option>';
                }).join('') +
              '</select>') +
            field('ld-w', 'Width (mm)', '<input id="ld-w" type="number" min="40" max="305" step="0.1" value="' +
              esc(d.widthMm) + '"' + (d.size === 'custom' ? '' : ' disabled') + '>') +
            field('ld-h', 'Height (mm)', '<input id="ld-h" type="number" min="40" max="305" step="0.1" value="' +
              esc(d.heightMm) + '"' + (d.size === 'custom' ? '' : ' disabled') + '>') +
            field('ld-pad', 'Inner margin (mm)', '<input id="ld-pad" type="number" min="0" max="20" step="0.5" value="' +
              esc(d.paddingMm) + '">') +
            field('ld-scale', 'Text size', '<input id="ld-scale" type="range" min="0.7" max="1.6" step="0.05" value="' +
              esc(d.fontScale) + '">') +
          '</div>' +

          '<h4 class="ship-h">What prints on it</h4>' +
          '<div class="lbl-checks">' +
            check('ld-border', 'Outline box', d.border) +
            check('ld-showLogo', 'Store name &amp; mark', d.showLogo) +
            check('ld-showFrom', 'Return address', d.showFrom) +
            check('ld-showService', 'Delivery service bought', d.showService) +
            check('ld-showBarcode', 'Barcode', d.showBarcode) +
            check('ld-showItems', 'Contents list', d.showItems) +
            check('ld-showDate', 'Order date', d.showDate) +
            check('ld-showEmail', 'Customer email', d.showEmail) +
            check('ld-showResearchNote', 'Research-use line', d.showResearchNote) +
          '</div>' +
          '<p class="adm-note">The customer\'s email is off by default — a parcel passes through a lot of hands, ' +
            'and the courier does not need it.</p>' +

          '<div class="lbl-grid">' +
            field('ld-barsrc', 'Barcode holds',
              '<select id="ld-barsrc">' +
                '<option value="orderId"' + (d.barcodeSource === 'orderId' ? ' selected' : '') + '>The order reference</option>' +
                '<option value="tracking"' + (d.barcodeSource === 'tracking' ? ' selected' : '') + '>The tracking number (falls back to the reference)</option>' +
              '</select>') +
            field('ld-handling', 'Handling stamp <span class="muted">optional</span>',
              '<input id="ld-handling" type="text" maxlength="60" value="' + esc(d.handling) +
                '" placeholder="FRAGILE — DO NOT FREEZE">') +
          '</div>' +

          '<h4 class="ship-h">Return address</h4>' +
          '<div class="lbl-grid">' +
            field('ld-from-name', 'Name', '<input id="ld-from-name" type="text" value="' + esc(d.from.name) + '">') +
            field('ld-from-line1', 'Street', '<input id="ld-from-line1" type="text" value="' + esc(d.from.line1) +
              '" placeholder="1200 Example Rd, Suite 4">') +
            field('ld-from-line2', 'Street 2 <span class="muted">optional</span>',
              '<input id="ld-from-line2" type="text" value="' + esc(d.from.line2) + '">') +
            field('ld-from-city', 'City', '<input id="ld-from-city" type="text" value="' + esc(d.from.city) + '">') +
            field('ld-from-state', 'State', '<input id="ld-from-state" type="text" value="' + esc(d.from.state) + '">') +
            field('ld-from-postalCode', 'ZIP', '<input id="ld-from-postalCode" type="text" value="' + esc(d.from.postalCode) + '">') +
            field('ld-from-country', 'Country', '<input id="ld-from-country" type="text" value="' + esc(d.from.country) + '">') +
            field('ld-from-phone', 'Phone <span class="muted">optional</span>',
              '<input id="ld-from-phone" type="text" value="' + esc(d.from.phone) + '">') +
          '</div>' +

          '<h4 class="ship-h">Small print</h4>' +
          '<div class="lbl-grid one">' +
            field('ld-note', 'Research-use line',
              '<input id="ld-note" type="text" maxlength="200" value="' + esc(d.researchNote) + '">') +
            field('ld-footer', 'Extra footer line <span class="muted">optional</span>',
              '<input id="ld-footer" type="text" maxlength="120" value="' + esc(d.footer) +
                '" placeholder="Questions? support@evernovalife.com">') +
          '</div>' +

          '<div class="lbl-actions">' +
            '<button class="btn btn-primary act-label-save" type="button">Save design</button>' +
            '<button class="btn btn-ghost act-label-test" type="button">' + A.icon('print', 'ic') + ' Print a test</button>' +
            '<button class="btn btn-ghost act-label-reset" type="button">Reset to default</button>' +
          '</div>' +
          '<p class="adm-note" style="margin:.55rem 0 0">Saving changes every label printed from now on. Labels ' +
            'already printed and stuck on boxes are, of course, unaffected.</p>' +
        '</div>' +

        '<div class="adm-card lbl-preview">' +
          '<div class="adm-card-head"><h3>Preview</h3>' +
            '<span class="hint">actual size ' + esc(d.widthMm) + ' × ' + esc(d.heightMm) + ' mm</span></div>' +
          '<div class="form-field">' +
            '<label for="ld-preview-order">Fill it with</label>' +
            '<select id="ld-preview-order">' +
              '<option value="">A sample order (nothing real)</option>' +
              queue.slice(0, 25).map(function (o) {
                return '<option value="' + esc(o.orderId) + '"' + (state.previewId === o.orderId ? ' selected' : '') + '>' +
                  esc(o.orderId) + ' — ' + esc(((o.shippingAddress || {}).name) || o.email || 'no name') + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<div class="lbl-stage" id="ldStage">' +
            '<iframe id="ldPreview" title="Label preview" sandbox="allow-same-origin"></iframe>' +
          '</div>' +
          '<p class="adm-note" style="margin:.7rem 0 0">This is a packing label, not postage — it carries no ' +
            'carrier barcode and buys nothing. Print it, stick it on the box, then buy the postage label from ' +
            'USPS/UPS/FedEx as usual and put that one alongside it.</p>' +
        '</div>' +

      '</div>';

    updateLabelPreview();
  }

  function field(id, label, control) {
    return '<div class="form-field"><label for="' + esc(id) + '">' + label + '</label>' + control + '</div>';
  }

  function check(id, label, on) {
    return '<label class="form-check"><input id="' + esc(id) + '" type="checkbox"' + (on ? ' checked' : '') + '> ' +
      label + '</label>';
  }

  /* Read the designer back into a design object. The form is the truth while
     the view is open — that is what makes the preview live. */
  function readLabelForm() {
    var v = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    var c = function (id) { var el = document.getElementById(id); return !!(el && el.checked); };
    var size = v('ld-size') || '4x6';
    var preset = LBL.SIZES[size] || LBL.SIZES['4x6'];
    return {
      size: size,
      widthMm: size === 'custom' ? Number(v('ld-w')) || preset.widthMm : preset.widthMm,
      heightMm: size === 'custom' ? Number(v('ld-h')) || preset.heightMm : preset.heightMm,
      paddingMm: Number(v('ld-pad')),
      fontScale: Number(v('ld-scale')) || 1,
      border: c('ld-border'),
      showLogo: c('ld-showLogo'),
      showFrom: c('ld-showFrom'),
      showService: c('ld-showService'),
      showBarcode: c('ld-showBarcode'),
      showItems: c('ld-showItems'),
      showDate: c('ld-showDate'),
      showEmail: c('ld-showEmail'),
      showResearchNote: c('ld-showResearchNote'),
      barcodeSource: v('ld-barsrc') || 'orderId',
      handling: v('ld-handling'),
      researchNote: v('ld-note'),
      footer: v('ld-footer'),
      from: {
        name: v('ld-from-name'), line1: v('ld-from-line1'), line2: v('ld-from-line2'),
        city: v('ld-from-city'), state: v('ld-from-state'), postalCode: v('ld-from-postalCode'),
        country: v('ld-from-country'), phone: v('ld-from-phone')
      }
    };
  }

  /* Which order the preview is filled with: a real one from the queue if the
     owner picked it, otherwise the obviously-fake sample. */
  function previewOrder() {
    var id = state.previewId;
    var o = id && (state.orders || []).find(function (x) { return x.orderId === id; });
    return o || LBL.sampleOrder();
  }

  function updateLabelPreview() {
    var frame = document.getElementById('ldPreview');
    var stage = document.getElementById('ldStage');
    if (!frame || !stage) return;
    var d = LBL.withDefaults(readLabelForm());

    var wPx = d.widthMm * LBL.MM_PX;
    var hPx = d.heightMm * LBL.MM_PX;
    // Fit the label to the column without ever blowing it up past life size.
    var scale = Math.min(1, (stage.clientWidth || 340) / wPx);
    frame.style.width = wPx + 'px';
    frame.style.height = hPx + 'px';
    frame.style.transform = 'scale(' + scale.toFixed(4) + ')';
    stage.style.height = Math.ceil(hPx * scale) + 'px';

    frame.srcdoc = LBL.documentHtml([previewOrder()], d, {
      title: 'Label preview',
      // The label fills the frame exactly; the frame supplies the white.
      extraCss: 'body{display:block}'
    });
  }

  async function saveLabelDesign(btn) {
    var payload = readLabelForm();
    btn.disabled = true;
    var was = btn.textContent;
    btn.textContent = 'Saving…';
    try {
      var data = await A.api('/api/admin/label-design', { method: 'PUT', body: payload });
      state.design = data.design || payload;
      A.toast('Label design saved — every label printed from now on uses it.', 'success');
      render();
    } catch (e) {
      A.toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = was;
    }
  }

  async function resetLabelDesign(btn) {
    if (!window.confirm('Reset the label back to the default design?\n\n' +
        'This clears the return address you entered as well.')) return;
    btn.disabled = true;
    try {
      var data = await A.api('/api/admin/label-design/reset', { method: 'POST' });
      state.design = data.design;
      A.toast('Label reset to the default design.', 'success');
      render();
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
  }

  /* Print labels for one order, or for the whole queue. The design used is
     whatever is SAVED, except in the designer itself, where the point is to see
     the edit you are holding. */
  function printOrderLabels(orders, design) {
    if (!LBL) { A.toast('The label renderer did not load — check js/admin-labels.js.', 'error'); return; }
    var list = (orders || []).filter(Boolean);
    if (!list.length) { A.toast('No orders to label.', 'error'); return; }
    /* The saved design if the backend has one, otherwise the built-in default —
       including the return address. A backend that predates the designer must
       still print a correct label rather than refusing to. */
    var d = design || state.design || LBL.DEFAULT;

    var noAddress = list.filter(function (o) {
      var a = o.shippingAddress || {};
      return !(a.address && a.city);
    });
    if (noAddress.length && !window.confirm(noAddress.length + ' of these orders have no delivery address stored ' +
        '(guest checkouts from before the address was required). Print anyway with that block blank?')) return;

    var res = LBL.printLabels(list, d);
    if (!res.ok) A.toast(res.error, 'error');
  }

  /* ============================================================
     TO SHIP
     The end of the sale, and the only step with no automation behind it. A paid
     order is a promise with a deadline, so this view is built to be worked
     THROUGH rather than read: one card per parcel, everything needed to pack it
     on that card, and the two things that finish it — the tracking number and
     the button that emails it to the customer.
     ============================================================ */
  function renderShip() {
    var orders = state.orders || [];
    var queue = toShip(orders);
    var shipped = orders.filter(function (o) { return o.status === 'shipped' || o.status === 'delivered'; })
      .sort(function (a, b) { return new Date(b.shippedAt || b.paidAt) - new Date(a.shippedAt || a.paidAt); });

    body.innerHTML =
      '<div class="kpi-grid">' +
        kpi('Waiting to ship', num(queue.length), queue.length ? 'someone is waiting' : 'all caught up', '',
            queue.length ? 'amber' : '') +
        kpi('Units to pack', num(queue.reduce(function (s, o) {
          return s + (o.items || []).reduce(function (n, i) { return n + (Number(i.quantity) || 0); }, 0);
        }, 0)), 'across the queue') +
        kpi('Shipped', num(shipped.length), 'all time') +
      '</div>' +
      /* Every parcel in the queue already has a label waiting — it is built
         from the order, so there is nothing to fill in. One dialog for the
         whole queue, because a print dialog per parcel is how packing turns
         into an afternoon. */
      (queue.length
        ? '<div class="ship-bulk">' +
            '<button class="btn btn-primary act-labels-all" type="button">' + A.icon('print', 'ic') +
              ' Print all ' + queue.length + ' shipping label' + (queue.length === 1 ? '' : 's') + '</button>' +
            '<span class="adm-note" style="margin:0">Name, address, reference and contents are filled in from ' +
              'each order. <a href="admin.html#labeldesign">Design the label</a>.</span>' +
          '</div>'
        : '') +
      (queue.length
        ? queue.map(shipCard).join('')
        : '<div class="adm-card">' +
            A.empty('Nothing to ship', 'Paid orders appear here the moment the money confirms.') +
          '</div>') +
      (shipped.length
        ? '<div class="adm-card">' +
            '<div class="adm-card-head"><h3>Already shipped</h3>' +
              '<span class="hint">newest first</span></div>' +
            '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
              '<th>Reference</th><th>Shipped</th><th>Customer</th><th>Items</th><th>Tracking</th>' +
            '</tr></thead><tbody>' +
            shipped.map(function (o) {
              return '<tr>' +
                '<td><span class="ref">' + esc(o.orderId) + '</span></td>' +
                '<td>' + esc(A.date(o.shippedAt, true)) + '<span class="muted">' + esc(A.ago(o.shippedAt)) + '</span></td>' +
                '<td>' + esc(o.email || o.userEmail || '—') + '</td>' +
                '<td>' + esc(itemsText(o.items)) + '</td>' +
                '<td>' + esc([o.carrier, o.tracking].filter(Boolean).join(' · ') || '—') + '</td>' +
              '</tr>';
            }).join('') +
            '</tbody></table></div>' +
          '</div>'
        : '');
  }

  /* One parcel. The address is deliberately shown as a block you can read out
     loud onto a label, not as a table row. */
  function shipCard(o) {
    var a = o.shippingAddress || {};
    var lines = [
      String(a.name || '').trim(),
      String(a.institution || '').trim(),
      String(a.address || '').trim(),
      [a.city, a.state, a.postalCode].filter(Boolean).join(', '),
      String(a.countryCode || a.country || '').trim()
    ].filter(Boolean);

    return '<div class="adm-card">' +
      '<div class="adm-card-head">' +
        '<h3><span class="ref">' + esc(o.orderId) + '</span></h3>' +
        '<span class="hint">paid ' + esc(A.ago(o.paidAt || o.createdAt)) + ' · ' + esc(money(o.total)) + ' · ' +
          esc(methodLabel(o.method)) +
          /* Which delivery service they bought — an Overnight order that sits in
             this queue overnight is a refund waiting to happen. */
          (o.shippingLabel ? ' · <strong>' + esc(o.shippingLabel) + '</strong>' : '') + '</span>' +
        '<div class="right">' +
          '<button class="btn btn-ghost btn-sm act-label" data-id="' + esc(o.orderId) + '">' +
            A.icon('tag', 'ic') + ' Shipping label</button> ' +
          '<button class="btn btn-ghost btn-sm act-slip" data-id="' + esc(o.orderId) + '">' +
            A.icon('print', 'ic') + ' Packing slip</button>' +
        '</div>' +
      '</div>' +
      (o.stockShort
        ? '<p class="adm-note" style="color:var(--accent-coral)">Stock could not be re-taken for this order — check the ' +
          'count on these products before you pack it.</p>'
        : '') +
      '<div class="adm-grid split">' +
        '<div>' +
          '<h4 class="ship-h">Ship to</h4>' +
          '<p class="ship-addr">' + lines.map(esc).join('<br>') + '</p>' +
          '<p class="adm-note" style="margin:0">' +
            esc(o.email || o.userEmail || 'no email') +
            (a.researchField ? ' · ' + esc(a.researchField) : '') +
          '</p>' +
        '</div>' +
        '<div>' +
          '<h4 class="ship-h">Pack</h4>' +
          '<div class="rank">' +
            (o.items || []).map(function (i) {
              return '<div class="rank-row" style="background:var(--adm-surface-2)">' +
                '<span class="rank-name">' + esc(i.name) + '</span>' +
                '<span class="rank-val">×' + esc(i.quantity) + '</span></div>';
            }).join('') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ship-form">' +
        '<div class="form-field">' +
          '<label for="carrier-' + esc(o.orderId) + '">Carrier <span class="muted">optional</span></label>' +
          '<input id="carrier-' + esc(o.orderId) + '" type="text" value="' + esc(o.carrier || '') +
            '" placeholder="USPS, UPS, FedEx…" autocomplete="off">' +
        '</div>' +
        '<div class="form-field">' +
          '<label for="track-' + esc(o.orderId) + '">Tracking number <span class="muted">optional</span></label>' +
          '<input id="track-' + esc(o.orderId) + '" type="text" value="' + esc(o.tracking || '') +
            '" placeholder="9400 1000 0000 0000 0000 00" autocomplete="off">' +
        '</div>' +
        '<button class="btn btn-primary act-ship" data-id="' + esc(o.orderId) + '">Mark shipped &amp; email customer</button>' +
      '</div>' +
      '<p class="adm-note" style="margin:.55rem 0 0">Marking it shipped emails the customer with the tracking number ' +
        'above. Leave the fields blank if there is no number to give them.</p>' +
    '</div>';
  }

  async function markShipped(orderId, btn) {
    var carrier = (document.getElementById('carrier-' + orderId) || {}).value || '';
    var tracking = (document.getElementById('track-' + orderId) || {}).value || '';
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      var data = await A.api('/api/admin/orders/' + encodeURIComponent(orderId) + '/shipped', {
        method: 'POST', body: { carrier: carrier, tracking: tracking }
      });
      A.toast(data.alreadyShipped
        ? orderId + ': tracking updated.'
        : orderId + ' marked shipped — the customer has been emailed.', 'success');
      await loadAll({ quiet: true });
    } catch (e) {
      A.toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* A printable slip for the box. Opened in its own window with its own styles:
     the console's dark theme is not something anyone wants to put through a
     printer, and the slip has to be readable in black and white. */
  function packingSlip(orderId) {
    var o = (state.orders || []).find(function (x) { return x.orderId === orderId; });
    if (!o) { A.toast('That order is no longer loaded — press Refresh.', 'error'); return; }
    var a = o.shippingAddress || {};
    var rows = (o.items || []).map(function (i) {
      return '<tr><td>' + esc(i.name) + '</td><td class="n">' + esc(i.quantity) + '</td></tr>';
    }).join('');
    var addr = [a.name, a.institution, a.address,
      [a.city, a.state, a.postalCode].filter(Boolean).join(', '), a.countryCode || a.country]
      .filter(Boolean).map(esc).join('<br>');

    var w = window.open('', '_blank', 'width=760,height=900');
    if (!w) { A.toast('Your browser blocked the print window.', 'error'); return; }
    w.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>Packing slip ' + esc(o.orderId) + '</title>' +
      '<style>' +
      'body{font:14px/1.5 Arial,Helvetica,sans-serif;color:#111;margin:36px;max-width:620px}' +
      'h1{font-size:18px;margin:0 0 2px}.sub{color:#666;font-size:12px;margin:0 0 22px}' +
      'h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:#666;margin:22px 0 6px}' +
      '.addr{font-size:15px;line-height:1.45}' +
      'table{border-collapse:collapse;width:100%;margin-top:4px}' +
      'th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #ddd}' +
      'th{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#666}' +
      '.n{text-align:right;width:70px}' +
      '.foot{margin-top:26px;padding-top:12px;border-top:1px solid #ddd;color:#666;font-size:11px}' +
      '@media print{body{margin:0}}' +
      '</style></head><body>' +
      '<h1>Ever Nova Life</h1>' +
      '<p class="sub">Packing slip · order ' + esc(o.orderId) + ' · placed ' + esc(A.date(o.createdAt)) +
        (o.shippingLabel ? ' · ' + esc(o.shippingLabel) : '') + '</p>' +
      '<h2>Ship to</h2><div class="addr">' + addr + '</div>' +
      '<h2>Contents</h2><table><thead><tr><th>Item</th><th class="n">Qty</th></tr></thead><tbody>' + rows +
      '</tbody></table>' +
      '<div class="foot">All products are sold strictly for in-vitro research and laboratory use only. ' +
      'Not for human consumption. No prices are shown on this slip.</div>' +
      '</body></html>');
    w.document.close();
    w.focus();
    w.print();
  }

  function addressText(a) {
    if (!a) return '';
    var who = String(a.name || ((a.firstName || '') + ' ' + (a.lastName || ''))).trim();
    return [who, a.institution, a.address, [a.city, a.state, a.postalCode].filter(Boolean).join(' '),
            a.country || a.countryCode]
      .map(function (s) { return String(s || '').trim(); }).filter(Boolean).join(' · ');
  }

  function itemsText(items) {
    if (!items || !items.length) return '—';
    return items.map(function (i) { return i.name + ' ×' + i.quantity; }).join(', ');
  }

  /* How an order was paid, in words.
     `card` is history, not an option: Braintree was removed in Aug 2026 along
     with POST /api/checkout, so nothing can open a card order today. Orders
     stamped `card` predate that and are labelled as such rather than left
     looking like a live payment route. */
  var METHOD_LABELS = { crypto: 'Bitcoin / Lightning', zelle: 'Zelle', card: 'Card (retired)' };
  function methodLabel(m) { return METHOD_LABELS[m] || m || 'unknown'; }

  function ordersTable(orders, opts) {
    opts = opts || {};
    if (!orders.length) {
      return A.empty(opts.actions ? 'Nothing here' : 'No orders yet',
        'Orders appear the moment a customer checks out.');
    }
    var rows = orders.map(function (o) {
      var late = o.status === 'awaiting_payment' && o.expiresAt && new Date(o.expiresAt) < new Date();
      /* Two emails can be on one order: the account it was placed from, and the
         address given at checkout — which is where the receipt goes and who you
         reply to about the shipment. Showing only the account one sends you to
         the wrong inbox, so both appear when they differ. */
      var acct = o.userEmail || '';
      var contact = o.email || '';
      var who = esc(acct || contact || '—') + (o.guest ? ' <span class="muted">guest</span>' : '') +
        (contact && acct && contact.toLowerCase() !== acct.toLowerCase()
          ? '<span class="muted">contact: ' + esc(contact) + '</span>' : '');
      var addr = opts.compact ? '' : '<span class="muted">' + esc(addressText(o.shippingAddress)) + '</span>';
      var actions = '';
      if (opts.actions && OPEN.indexOf(o.status) !== -1) {
        /* On a short-paid order the emphasis is reversed on purpose: the house
           rule is full payment or nothing, so refunding is the normal outcome
           and "mark paid" is the exception you take only after the rest of the
           money has actually arrived. */
        actions = o.status === 'underpaid'
          /* The first button is the one that usually ends this well: the buyer
             is short, not gone, and the link lets them finish without anyone
             sending an email by hand. Cancel-and-refund is the fallback, and
             "paid in full now" only after the rest of the money has landed. */
          /* No pay-link button when the balance is unknowable (BTCPay flagged a
             partial payment but wouldn't say how much) — there is no honest
             amount to bill, and billing the total would charge them twice. */
          /* Reconcile comes first because it fixes the number every other
             button here works from. An order billed twice has money spread
             across two invoices and a stored total that only counts one of
             them — emailing a pay link before fixing that asks the buyer for
             coins already in the wallet. */
          ? (o.method === 'crypto'
              ? '<button class="btn btn-ghost btn-sm act-reconcile" data-id="' + esc(o.orderId) + '">Reconcile</button> '
              : '') +
            (o.canCollect === false ? '' :
              '<button class="btn btn-primary btn-sm act-paylink" data-id="' + esc(o.orderId) +
              '" data-due="' + esc(money(dueOn(o))) + '">Email pay link</button> ') +
            '<button class="btn btn-ghost btn-sm act-cancel" data-id="' + esc(o.orderId) + '">Cancel &amp; refund</button> ' +
            '<button class="btn btn-ghost btn-sm act-paid" data-id="' + esc(o.orderId) +
            '" data-total="' + esc(money(o.total)) + '">Paid in full now</button>'
          : '<button class="btn btn-primary btn-sm act-paid" data-id="' + esc(o.orderId) +
            '" data-total="' + esc(money(o.total)) + '">Mark paid</button> ' +
            '<button class="btn btn-ghost btn-sm act-cancel" data-id="' + esc(o.orderId) + '">Cancel</button>';
      }
      /* A settled order's label is already made — it is this row plus the saved
         design — so it can be printed from here without a detour through To
         ship. Deliberately NOT offered on an unpaid order: a labelled parcel is
         a parcel that gets posted, and the money has not landed yet. */
      if (opts.actions && [PAID, 'shipped', 'delivered'].indexOf(o.status) !== -1 && !isTestOrder(o)) {
        actions += (actions ? ' ' : '') +
          '<button class="btn btn-ghost btn-sm act-label" data-id="' + esc(o.orderId) + '">' +
          A.icon('tag', 'ic') + ' Shipping label</button>';
      }
      /* One purchase that got recorded twice. Only offered where it is
         plausible — a same-buyer, same-cart twin is actually on the books —
         because "remove this order" is not something to have lying around next
         to every row. A shipped order is never offered it: a parcel went out. */
      if (opts.actions && ['shipped', 'delivered'].indexOf(o.status) === -1 && twinOf(o)) {
        actions += (actions ? ' ' : '') +
          '<button class="btn btn-ghost btn-sm act-dupe" data-id="' + esc(o.orderId) + '">Remove duplicate</button>';
      }
      return '<tr>' +
        '<td><span class="ref">' + esc(o.orderId) + '</span>' +
          (o.subscriptionId ? '<span class="muted">auto-ship</span>' : '') +
          /* Say it on the row, not just on the button: two references for one
             purchase is the thing that makes an order list impossible to read. */
          (opts.actions && twinOf(o)
            ? '<span class="muted">same purchase as ' + esc(twinOf(o).orderId) + '</span>' : '') + '</td>' +
        '<td>' + esc(A.date(o.createdAt, true)) + '<span class="muted">' + esc(A.ago(o.createdAt)) + '</span></td>' +
        '<td>' + who + addr + '</td>' +
        '<td>' + esc(itemsText(o.items)) + '</td>' +
        '<td>' + esc(methodLabel(o.method)) +
          (isTestOrder(o) ? '<span class="muted">sandbox — no money taken</span>' : '') + '</td>' +
        '<td><span class="pill ' + esc(o.status || '') + '">' + esc(String(o.status || '').replace('_', ' ')) + '</span>' +
          (isTestOrder(o) ? ' <span class="pill test">test</span>' : '') +
          (late ? ' <span class="pill late">past hold</span>' : '') + '</td>' +
        '<td class="num"><strong>' + esc(money(o.total)) + '</strong>' +
          /* On a short payment the total is the least useful number on the row:
             what matters is how much is still outstanding. */
          (o.status === 'underpaid'
            ? '<span class="muted">' + esc(money(o.paidAmount)) + ' in · ' +
              esc(money(dueOn(o))) + ' short</span>'
            : '') + '</td>' +
        (opts.actions ? '<td class="actions">' + actions + '</td>' : '') +
        '</tr>';
    }).join('');

    return '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
      '<th>Reference</th><th>Placed</th><th>Customer</th><th>Items</th><th>Paid with</th><th>Status</th>' +
      '<th class="num">Total</th>' + (opts.actions ? '<th></th>' : '') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* ============================================================
     BTCPAY
     Loaded only when this view is opened: it makes the server call out to
     another host, which is slow and pointless on a dashboard nobody asked
     to see payment plumbing on.
     ============================================================ */
  var btcpayLoading = false;

  async function loadBtcpay(force) {
    if (btcpayLoading) return;
    if (state.btcpay && !force) return;
    btcpayLoading = true;
    if (state.view === 'btcpay') render();
    try {
      state.btcpay = await A.api('/api/admin/btcpay');
    } catch (e) {
      // A 404 here means the backend predates this panel, which is a
      // deployment fact, not a BTCPay problem — say which.
      state.btcpay = {
        configured: false,
        error: e.status === 404
          ? 'This backend does not have the BTCPay panel yet. Deploy the current server/ to Render.'
          : e.message
      };
    }
    /* Separate call, separate failure: the webhook check needs a permission the
       invoice list doesn't, so losing it must not cost us the invoices. */
    try {
      state.hooks = await A.api('/api/admin/btcpay/webhooks');
    } catch (e) {
      state.hooks = { error: e.status === 404
        ? 'This backend does not have the webhook check yet. Deploy the current server/ to Render.'
        : e.message };
    }
    btcpayLoading = false;
    if (state.view === 'btcpay') render();
    updateNavTally();
  }

  /* BTCPay's invoice states map onto the pills we already have. */
  var INVOICE_PILL = { Settled: 'paid', Processing: 'pending', New: 'pending', Expired: 'cancelled', Invalid: 'cancelled' };

  /* The webhook is the whole automatic half of the store: without a working one
     a paid invoice never becomes a paid order, the buyer never gets a receipt
     and nobody is told to ship. It fails invisibly, so it gets its own card
     that names the exact failure rather than a green tick. */
  function webhookCard() {
    var h = state.hooks;
    if (!h) return '';

    var head = function (title, danger) {
      return '<div class="adm-card"' + (danger ? ' style="border-color:rgba(244,63,94,.45)"' : '') + '>' +
        '<div class="adm-card-head"><h3>' + title + '</h3>' +
        '<span class="hint">what confirms a crypto payment</span></div>';
    };

    if (h.error && !h.webhooks) {
      return head('Webhook — cannot check', !h.missingPermission) +
        '<p class="adm-note">' + esc(h.error) + '</p>' +
        (h.missingPermission
          ? '<p class="adm-note" style="margin:0">BTCPay has no read-only webhook permission, so this check needs ' +
            '<code>' + esc(h.missingPermission) + '</code> on the API key. Payments can still confirm without it — ' +
            'this only means the wiring cannot be <em>verified</em> from here. Check it by hand at ' +
            '<em>BTCPay → Store Settings → Webhooks</em>.</p>'
          : '') +
        '</div>';
    }

    var ours = h.ourWebhook;
    var others = (h.webhooks || []).filter(function (w) { return !w.isOurs; });
    var broken = !ours || !ours.enabled || !h.settledCovered || !h.hasWebhookSecret;

    var lines = '';
    if (!ours) {
      lines += connRow('Status', 'NO webhook points at this server — crypto payments will never confirm themselves');
      lines += connRow('Add this URL in BTCPay', h.expectedUrl || '—');
    } else {
      lines += connRow('Status', ours.enabled ? 'connected' : 'DISABLED in BTCPay — nothing is delivered');
      lines += connRow('URL', ours.url);
      lines += connRow('Events', ours.everything ? 'all events'
        : (ours.specificEvents || []).join(', ') || 'none selected');
      lines += connRow('InvoiceSettled covered', h.settledCovered
        ? 'yes — a paid invoice marks the order paid'
        : 'NO — this webhook is not subscribed to InvoiceSettled, so payments never confirm');
      lines += connRow('Recent failed deliveries', ours.failedRecently
        ? ours.failedRecently + ' of the last ' + (ours.deliveries || []).length +
          ' failed — BTCPay retries, but a run of these means orders are being missed'
        : 'none');
      var last = (ours.deliveries || [])[0];
      if (last) {
        lines += connRow('Last delivery', A.date(last.timestamp ? last.timestamp * 1000 : null, true) +
          (last.success ? ' · accepted' : ' · FAILED' + (last.errorMessage ? ': ' + last.errorMessage : '')));
      }
    }
    if (!h.hasWebhookSecret) {
      lines += connRow('Webhook secret', 'NOT set on this server — every delivery is rejected unverified');
    }
    if (others.length) {
      lines += connRow('Other webhooks on this store', others.map(function (w) { return w.url; }).join(', '));
    }

    return head((broken ? A.icon('alert', 'ic') + ' Webhook — needs attention' : 'Webhook — connected'), broken) +
      '<div class="rank">' + lines + '</div>' +
      (!ours
        ? '<p class="adm-note" style="margin:.6rem 0 0"><strong>Fix:</strong> BTCPay → Store Settings → Webhooks → ' +
          'Create a new webhook. Payload URL <code>' + esc(h.expectedUrl || '') + '</code>, ' +
          'events "Send me all events" (or at least InvoiceSettled, InvoiceExpired, InvoiceInvalid), and copy the ' +
          'secret it shows into <code>BTCPAY_WEBHOOK_SECRET</code> on Render.</p>'
        : '') +
      '</div>';
  }

  function renderBtcpay() {
    var d = state.btcpay;

    if (!d) {
      body.innerHTML = '<div class="adm-card">' + A.skeleton(5) + '</div>';
      loadBtcpay();
      return;
    }

    if (!d.configured || d.reachable === false) {
      body.innerHTML =
        '<div class="adm-card">' +
          '<div class="adm-card-head"><h3>BTCPay is not answering</h3>' +
            '<div class="right"><button class="btn btn-ghost btn-sm" type="button" id="btcRetry">' +
              A.icon('refresh', 'ic') + ' Try again</button></div></div>' +
          '<p class="adm-note">' + esc(d.error || 'Unknown problem.') + '</p>' +
          // A permission error is the one failure with a precise fix, so the
          // fix is written out rather than left as "check your key".
          (d.missingPermission
            ? '<p class="adm-note"><strong>How to fix:</strong> in BTCPay go to ' +
              '<em>Account → Manage Account → API Keys</em>, edit the key this server uses (or make a new one), ' +
              'and tick <code>' + esc(d.missingPermission) + '</code> for this store. ' +
              'Paste the new key into <code>BTCPAY_API_KEY</code> on Render if you created one, then redeploy.</p>'
            : '') +
          (d.baseUrl ? '<p class="adm-note" style="margin:0">Configured server: <strong>' + esc(d.baseUrl) + '</strong>' +
            (d.storeId ? ' · store <code>' + esc(d.storeId) + '</code>' : '') + '</p>'
            : '<p class="adm-note" style="margin:0">Set <code>BTCPAY_URL</code>, <code>BTCPAY_API_KEY</code> and ' +
              '<code>BTCPAY_STORE_ID</code> in the backend environment, then redeploy.</p>') +
        '</div>';
      var r = document.getElementById('btcRetry');
      if (r) r.addEventListener('click', function () { loadBtcpay(true); });
      return;
    }

    var invoices = d.invoices || [];
    var settled = invoices.filter(function (i) { return i.status === 'Settled'; });
    var open = invoices.filter(function (i) { return i.status === 'New' || i.status === 'Processing'; });
    var dead = invoices.filter(function (i) { return i.status === 'Expired' || i.status === 'Invalid'; });
    var stuck = invoices.filter(function (i) { return i.needsAttention; });
    // Expired doesn't mean unpaid: an underpaid or late payment expires too,
    // and that money is already in the wallet.
    var deadWithMoney = dead.filter(function (i) { return Number(i.paidAmount) > 0; });
    var settledValue = settled.reduce(function (s, i) { return s + (Number(i.amount) || 0); }, 0);
    /* Money arrived against this invoice, but not all of it and it never
       settled. Worth acting on WHATEVER our own store believes: an order
       marked paid by hand against a partial payment looks healthy on every
       other screen, which is precisely why it is the row that costs money. */
    var short = invoices.filter(shortHere);

    var rows = invoices.map(function (i) {
      var created = i.createdTime ? new Date(i.createdTime * 1000).toISOString() : '';
      var localPill = !i.orderId ? '<span class="muted">no order id</span>'
        : i.localStatus === 'missing' ? '<span class="pill cancelled">not in our store</span>'
        : '<span class="pill ' + esc(i.localStatus) + '">' + esc(String(i.localStatus).replace('_', ' ')) + '</span>';
      return '<tr' + (i.needsAttention ? ' style="background:rgba(224,165,42,.07)"' : '') + '>' +
        '<td><a href="' + esc(i.checkoutLink || '#') + '" target="_blank" rel="noopener">' +
          esc(String(i.id).slice(0, 10)) + '…</a>' +
          (i.buyerEmail ? '<span class="muted">' + esc(i.buyerEmail) + '</span>' : '') + '</td>' +
        '<td>' + esc(A.date(created, true)) + '<span class="muted">' + esc(A.ago(created)) + '</span></td>' +
        '<td>' + esc(i.itemDesc || '—') + '</td>' +
        '<td class="num">' + esc(money(i.amount)) +
          /* A dead invoice with money against it is the row that costs real
             money to miss, so the amount received is shown next to the amount
             asked for rather than hidden in the detail drawer. */
          (Number(i.paidAmount) > 0 && i.status !== 'Settled'
            ? '<span class="muted">got ' + esc(money(i.paidAmount)) + '</span>'
            : '<span class="muted">' + esc(i.currency || '') + '</span>') + '</td>' +
        '<td><span class="pill ' + esc(INVOICE_PILL[i.status] || '') + '">' + esc(i.status) + '</span>' +
          (i.additionalStatus && i.additionalStatus !== 'None'
            ? '<span class="muted">' + esc(i.additionalStatus) + '</span>' : '') + '</td>' +
        '<td>' + (i.orderId ? '<span class="ref">' + esc(i.orderId) + '</span><br>' : '') + localPill + '</td>' +
        /* The button only exists where there is an order to act on. An invoice
           raised inside BTCPay carries no order id, so "Release order" would
           post an empty reference and simply fail. */
        '<td class="actions">' + (i.orderId && (i.needsAttention || shortHere(i))
          ? (i.status === 'Settled'
              ? '<button class="btn btn-primary btn-sm act-paid" data-id="' + esc(i.orderId) +
                '" data-total="' + esc(money(i.amount)) + '">Release order</button>'
              /* Short-paid. The store ships on full payment only, so releasing
                 it is not offered — collecting the rest is. This is the one
                 place that knows what BTCPay actually received, which is
                 exactly what an order wrongly marked paid is missing. */
              /* Reconcile first: this panel is where a second invoice for the
                 same order becomes visible, and that is exactly the case where
                 THIS row's paid amount is only part of what the buyer sent. */
              : '<button class="btn btn-primary btn-sm act-reconcile" data-id="' + esc(i.orderId) + '">Reconcile</button> ' +
                '<button class="btn btn-ghost btn-sm act-collect" data-id="' + esc(i.orderId) +
                '" data-got="' + esc(Number(i.paidAmount) || 0) +
                '" data-total="' + esc(Number(i.amount) || 0) + '">Collect the rest</button>')
          : (i.status === 'Settled' && !i.orderId
              ? '<span class="muted">raised in BTCPay — no store order</span>' : '')) + '</td>' +
        '</tr>';
    }).join('');

    body.innerHTML =
      '<div class="kpi-grid">' +
        kpi('Settled', num(settled.length), money(settledValue) + ' received', '', 'gold') +
        kpi('Open invoices', num(open.length), 'waiting on payment') +
        kpi('Expired / invalid', num(dead.length),
            deadWithMoney.length ? deadWithMoney.length + ' with money against them' : 'never paid', '',
            deadWithMoney.length ? 'amber' : '') +
        kpi('Needs releasing', num(stuck.length), stuck.length ? 'money in, order not released' : 'everything matches', '',
            stuck.length ? 'amber' : '') +
      '</div>' +

      (short.length
        ? '<div class="adm-card" style="border-color:rgba(224,165,42,.45)">' +
            '<div class="adm-card-head"><h3>' + A.icon('alert', 'ic') + ' ' +
              A.plural(short.length, 'invoice') + ' paid part-way</h3></div>' +
            '<p class="adm-note" style="margin:0">Someone sent money and stopped short of the total — usually ' +
            'their wallet took its network fee out of the amount, or the payment window closed mid-transfer. ' +
            'The coins are in your wallet and the goods are still on the shelf. <strong>Collect the rest</strong> ' +
            'below records what actually arrived and emails the buyer a link that opens a fresh invoice for ' +
            'the difference — it works even on an order this store already calls paid.</p>' +
          '</div>'
        : '') +

      (stuck.length
        ? '<div class="adm-card" style="border-color:rgba(224,165,42,.45)">' +
            '<div class="adm-card-head"><h3>' + A.icon('alert', 'ic') + ' ' +
              A.plural(stuck.length, 'invoice') + ' settled but still unpaid here</h3></div>' +
            '<p class="adm-note" style="margin:0">BTCPay has the money; this server never heard about it — almost ' +
            'always a webhook delivered while the backend was asleep or mid-deploy. The customer has paid and is ' +
            'waiting. <strong>Release order</strong> below marks it paid, emails them and credits their points, ' +
            'exactly as the webhook would have. Check the invoice at BTCPay first.</p>' +
          '</div>'
        : '') +

      '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Connection</h3>' +
          '<div class="right">' +
            '<a class="btn btn-ghost btn-sm" href="' + esc(d.baseUrl) + '" target="_blank" rel="noopener">' +
              A.icon('external', 'ic') + ' Open BTCPay</a>' +
            '<button class="btn btn-ghost btn-sm" type="button" id="btcRefresh">' +
              A.icon('refresh', 'ic') + ' Refresh</button>' +
          '</div></div>' +
        '<div class="rank">' +
          connRow('Server', d.baseUrl) +
          connRow('Store', (d.store && d.store.name ? d.store.name + ' · ' : '') + d.storeId) +
          // Cosmetic-only failure: the invoices still loaded, so say what is
          // missing without implying the panel is broken.
          (d.storeError ? connRow('Store details', d.storeError +
            ' (add btcpay.store.canviewstoresettings to show the store name)') : '') +
          connRow('Invoice currency', (d.store && d.store.defaultCurrency) || d.currency || '—') +
          connRow('Webhook secret', d.hasWebhookSecret ? 'set — payments confirm themselves'
            : 'NOT set — webhooks cannot be verified, so nothing confirms automatically') +
        '</div>' +
      '</div>' +

      webhookCard() +

      '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Recent invoices</h3>' +
          '<span class="hint">straight from BTCPay, newest first</span>' +
          '<div class="right"><button class="btn btn-ghost btn-sm" type="button" id="btcCsv">' +
            A.icon('download', 'ic') + ' Export CSV</button></div></div>' +
        (d.invoiceError ? '<p class="adm-note">' + esc(d.invoiceError) + '</p>' : '') +
        (invoices.length
          ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
            '<th>Invoice</th><th>Created</th><th>Items</th><th class="num">Amount</th>' +
            '<th>BTCPay says</th><th>We say</th><th></th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>'
          : A.empty('No invoices yet', 'They appear here the moment a customer starts a crypto checkout.')) +
      '</div>';

    var rf = document.getElementById('btcRefresh');
    if (rf) rf.addEventListener('click', function () { loadBtcpay(true); });
    var csv = document.getElementById('btcCsv');
    if (csv) csv.addEventListener('click', function () {
      var out = [['Invoice', 'Created', 'Amount', 'Currency', 'BTCPay status', 'Our order', 'Our status', 'Buyer', 'Items']];
      invoices.forEach(function (i) {
        out.push([i.id, i.createdTime ? new Date(i.createdTime * 1000).toISOString() : '', i.amount, i.currency,
                  i.status, i.orderId, i.localStatus, i.buyerEmail, i.itemDesc]);
      });
      A.downloadCsv('ever-nova-btcpay-invoices.csv', out);
    });
  }

  function connRow(label, value) {
    return '<div class="rank-row" style="background:var(--adm-surface-2)">' +
      '<span class="rank-name">' + esc(label) + '</span>' +
      '<span class="rank-val" style="font-weight:600;white-space:normal;max-width:60%">' + esc(value || '—') + '</span></div>';
  }

  /* ---- AUTO-SHIP ---- */
  function renderAutoship() {
    var subs = state.subs || [];
    var active = subs.filter(function (s) { return s.status === 'active'; });
    var due = active.filter(function (s) { return s.scheduledFor && new Date(s.scheduledFor) <= new Date(); });
    // What the plans are worth per month, so the number means something.
    var monthly = active.reduce(function (sum, s) {
      var total = (s.items || []).reduce(function (t, i) {
        return t + (Number(i.unitPrice) || 0) * (Number(i.quantity) || 0);
      }, 0);
      var days = Number(s.intervalDays) || 30;
      return sum + total * (30 / days);
    }, 0);

    var rows = subs.map(function (s) {
      var overdue = s.status === 'active' && s.scheduledFor && new Date(s.scheduledFor) <= new Date();
      var failed = s.failCount ? '<span class="muted">' + s.failCount + ' failed</span>' : '';
      return '<tr>' +
        '<td>' + esc(A.date(s.scheduledFor)) + (overdue ? ' <span class="pill late">due</span>' : '') + '</td>' +
        '<td>' + esc(s.userName || '—') + '<span class="muted">' + esc(s.userEmail || '') + '</span></td>' +
        '<td>' + esc(itemsText(s.items)) + '</td>' +
        '<td>every ' + esc(s.intervalDays) + 'd</td>' +
        '<td class="num">' + esc(String(s.runCount || 0)) + '</td>' +
        '<td><span class="pill ' + esc(s.status) + '">' + esc(s.status) + '</span>' + failed + '</td>' +
        '<td class="actions">' + (s.status === 'active' && !overdue
          ? '<button class="btn btn-ghost btn-sm act-due" data-id="' + esc(s.id) + '">Ship now</button>' : '') + '</td>' +
        '</tr>';
    }).join('');

    body.innerHTML =
      '<div class="kpi-grid">' +
        kpi('Active plans', num(active.length), A.plural(subs.length, 'plan') + ' in total') +
        kpi('Due now', num(due.length), due.length ? 'waiting to be invoiced' : 'nothing overdue', '', due.length ? 'amber' : '') +
        kpi('Recurring value', money(monthly), 'per month, at current prices', '', 'gold') +
      '</div>' +
      '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Plans</h3>' +
          '<div class="right"><button class="btn btn-primary btn-sm" type="button" id="runDueBtn">' +
            A.icon('play', 'ic') + ' Invoice everything due</button></div></div>' +
        '<p class="adm-note">Auto-ship is scheduled <strong>invoicing</strong>, not automatic charging — crypto ' +
          'cannot be debited on a schedule. A due plan opens a fresh invoice and emails the pay link; the order ' +
          'stays unpaid until the customer pays it. This button does by hand what the hourly trigger does on its own.</p>' +
        (subs.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
          '<th>Next ship</th><th>Customer</th><th>Items</th><th>Every</th><th class="num">Sent</th><th>Status</th><th></th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        : A.empty('No auto-ship plans yet', 'They appear when a customer ticks “Auto-ship this order” at checkout.')) +
      '</div>';

    var btn = document.getElementById('runDueBtn');
    if (btn) btn.addEventListener('click', runDue);
  }

  /* ---- CUSTOMERS ---- */
  function renderCustomers() {
    var users = state.users || [];
    var orders = state.orders || [];
    var me = A.currentUser();

    // Spend per account, so the list is worth reading rather than just a
    // signup log.
    var spendBy = {};
    realOrders(orders).filter(function (o) { return o.status === PAID; }).forEach(function (o) {
      var k = (o.userEmail || o.email || '').toLowerCase();
      if (!k) return;
      if (!spendBy[k]) spendBy[k] = { total: 0, count: 0, last: '' };
      spendBy[k].total += Number(o.total) || 0;
      spendBy[k].count += 1;
      var d = saleDate(o);
      if (!spendBy[k].last || String(d) > spendBy[k].last) spendBy[k].last = d;
    });

    var withOrders = users.filter(function (u) { return spendBy[(u.email || '').toLowerCase()]; }).length;

    var rows = users.map(function (u) {
      var name = ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || '—';
      var s = spendBy[(u.email || '').toLowerCase()];
      var isMe = me && me.id === u.id;
      return '<tr>' +
        '<td>' + esc(name) + (u.isAdmin ? ' <span class="pill admin">admin</span>' : '') + '</td>' +
        '<td>' + esc(u.email) + '</td>' +
        '<td>' + esc(A.date(u.createdAt)) + '<span class="muted">' + esc(A.ago(u.createdAt)) + '</span></td>' +
        '<td class="num">' + (s ? esc(String(s.count)) : '0') + '</td>' +
        '<td class="num">' + (s ? '<strong>' + esc(money(s.total)) + '</strong>' : '<span class="muted">—</span>') + '</td>' +
        '<td class="actions">' + (isMe
          ? '<span class="muted">you</span>'
          : '<button class="btn btn-ghost btn-sm act-del-user" data-id="' + esc(u.id) + '" data-name="' + esc(name) + '">Delete</button>') +
        '</td></tr>';
    }).join('');

    body.innerHTML =
      '<div class="kpi-grid">' +
        kpi('Accounts', num(users.length), 'registered') +
        kpi('Have ordered', num(withOrders), users.length ? Math.round((withOrders / users.length) * 100) + '% of accounts' : '') +
        kpi('Guest orders', num(realOrders(orders).filter(function (o) { return o.guest; }).length), 'checked out without an account') +
      '</div>' +
      '<div class="adm-card">' +
        '<div class="adm-card-head"><h3>Accounts</h3>' +
          '<div class="right"><button class="btn btn-ghost btn-sm" type="button" id="csvUsersBtn">' +
            A.icon('download', 'ic') + ' Export CSV</button></div></div>' +
        (users.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
          '<th>Name</th><th>Email</th><th>Signed up</th><th class="num">Orders</th><th class="num">Spent</th><th></th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        : A.empty('No accounts yet')) +
      '</div>';

    var csv = document.getElementById('csvUsersBtn');
    if (csv) csv.addEventListener('click', function () {
      var out = [['Name', 'Email', 'Signed up', 'Admin', 'Paid orders', 'Total spent']];
      users.forEach(function (u) {
        var s = spendBy[(u.email || '').toLowerCase()];
        out.push([((u.firstName || '') + ' ' + (u.lastName || '')).trim(), u.email, u.createdAt || '',
                  u.isAdmin ? 'yes' : 'no', s ? s.count : 0, s ? s.total.toFixed(2) : '0.00']);
      });
      A.downloadCsv('ever-nova-customers.csv', out);
    });
  }

  /* ============================================================
     ACTIONS
     Destructive or money-moving steps keep confirm(): marking an order paid
     emails a real customer and credits real points, and deleting an account
     takes their orders with it. Everything else reports through a toast.
     ============================================================ */

  async function markPaid(orderId, total, btn) {
    /* No reference, nothing to mark. This used to reach the server as
       /api/admin/orders//paid and come back as an unexplained failure. */
    if (!orderId) {
      A.toast('That invoice has no order reference — it was raised inside BTCPay, so there is no order here to release.', 'error');
      return;
    }
    if (!window.confirm('Confirm you have received ' + total + ' for ' + orderId + '?\n\n' +
        'Only do this once the money is actually in your bank account. It marks the order paid, ' +
        'emails the customer, and credits their reward points.')) return;
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = 'Confirming…';
    try {
      var data = await A.api('/api/admin/orders/' + encodeURIComponent(orderId) + '/paid', { method: 'POST' });
      A.toast(data.alreadyPaid ? orderId + ' was already paid.' : orderId + ' is now paid — the customer has been emailed.', 'success');
      await loadAll({ quiet: true });
      // Released from the BTCPay panel? Re-pull it, or the row it was fixing
      // still shows as needing attention.
      if (state.btcpay) await loadBtcpay(true);
      /* A payment confirmed is a parcel to pack, so go straight there rather
         than leaving the order to be found again later. */
      if (!data.alreadyPaid) window.location.hash = 'ship';
    } catch (e) {
      A.toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* An invoice that took money and never settled. Deliberately blind to what
     our own order store says — the dangerous case is the one where the two
     already agree because a human made them agree. */
  function shortHere(i) {
    var got = Number(i.paidAmount) || 0;
    return i.status !== 'Settled' && got > 0 && got < (Number(i.amount) || 0);
  }

  /* Re-open an order at what is genuinely outstanding, and send the buyer a
     link for it. The amount is asked for rather than assumed: BTCPay's figure
     is the right default, but the owner may have taken part of it another way,
     and the number typed here becomes the order's truth. */
  async function collectBalance(orderId, got, total, btn) {
    var suggested = (Number(got) || 0).toFixed(2);
    var typed = window.prompt(
      'How much has actually been received for ' + orderId + '?\n\n' +
      'BTCPay says ' + money(got) + ' of ' + money(total) + '. Correct it if you have taken part of it ' +
      'another way. We will re-open the order for the difference and email the buyer a link to pay it.',
      suggested);
    if (typed === null) return;
    var received = Number(String(typed).replace(/[^0-9.]/g, ''));
    if (!isFinite(received) || received < 0) { A.toast('That is not an amount.', 'error'); return; }
    var due = (Number(total) || 0) - received;
    if (due <= 0) { A.toast('That covers the whole order — nothing to collect.', 'error'); return; }
    if (!window.confirm('Ask the buyer for ' + money(due) + ' on ' + orderId + '?\n\n' +
        'The order goes back to “payment short”, so nothing ships until the rest arrives. ' +
        'They get a link that opens a fresh crypto invoice for exactly ' + money(due) + ' — when it clears, ' +
        'the order marks itself paid and moves to “To ship”.')) return;

    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      var data = await A.api('/api/admin/orders/' + encodeURIComponent(orderId) + '/collect-balance', {
        method: 'POST', body: { received: received }
      });
      if (data.sent) {
        A.toast(orderId + ' re-opened for ' + money(data.due) + ' — link emailed to ' + data.to + '.', 'success');
        btn.textContent = 'Link sent';
      } else {
        window.prompt(data.reason || 'Send this link to the buyer yourself:', data.payUrl);
        btn.textContent = label;
        btn.disabled = false;
      }
      await loadAll({ quiet: true });
      await loadBtcpay(true);
    } catch (e) {
      if (e.data && e.data.payUrl) {
        window.prompt('The order was re-opened but the email did not go out. Send this link by hand:', e.data.payUrl);
      }
      A.toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* What a short-paid order still owes. The server sends `amountDue` on orders
     it will collect for; this falls back to total-minus-received so a backend
     that predates the balance work still shows a sensible figure. */
  function dueOn(o) {
    if (!o) return 0;
    if (typeof o.amountDue === 'number') return o.amountDue;
    return Math.max(0, (Number(o.total) || 0) - (Number(o.paidAmount) || 0));
  }

  /* Re-send the buyer the link that lets them pay the difference themselves.
     They already get one automatically the moment the shortfall is detected —
     this is for the orders that went short before that existed, and for the
     buyer who deleted the email. */
  async function sendPayLink(orderId, due, btn) {
    var o = (state.orders || []).find(function (x) { return x.orderId === orderId; });
    var to = (o && o.email) || 'the buyer';
    if (!window.confirm('Email ' + to + ' a link to pay the outstanding ' + (due || 'balance') +
        ' on ' + orderId + '?\n\n' +
        'The link opens a fresh crypto invoice for exactly that amount and never expires. ' +
        'If they pay it, the order marks itself paid and lands in “To ship” — you do nothing.')) return;
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      var data = await A.api('/api/admin/orders/' + encodeURIComponent(orderId) + '/pay-link', { method: 'POST' });
      if (data.sent) {
        A.toast('Pay link sent to ' + (data.to || to) + '.', 'success');
        btn.textContent = 'Link sent';
      } else {
        /* Nothing to send it to. The link is still the useful part, so put it
           somewhere copyable instead of reporting a failure. */
        window.prompt(data.reason || 'Send this link to the buyer yourself:', data.payUrl);
        btn.disabled = false;
        btn.textContent = label;
      }
    } catch (e) {
      if (e.data && e.data.payUrl) {
        window.prompt('The email did not go out. Copy this link and send it to the buyer yourself:', e.data.payUrl);
      }
      A.toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* Rebuild an order's payment ledger from BTCPay.
     Always previews first. The whole point is that the stored figure is wrong,
     so showing the corrected one BEFORE writing it is what makes this safe to
     click on an order you are not sure about. */
  async function reconcileOrder(orderId, btn) {
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = 'Reading…';
    var path = '/api/admin/orders/' + encodeURIComponent(orderId) + '/reconcile';

    function restore() { btn.disabled = false; btn.textContent = label; }

    function lines(d) {
      return (d.invoices || []).map(function (i) {
        return '  ' + i.invoiceId.slice(0, 12) + '…  billed ' + money(i.billed) +
          '  paid ' + (i.paid === null ? '??' : money(i.paid)) +
          (i.status ? '  (' + i.status + ')' : '');
      }).join('\n');
    }

    var preview;
    try {
      preview = await A.api(path, { method: 'POST', body: { dryRun: true } });
    } catch (e) {
      /* 409 means some invoice would not report an amount. That is the one
         error worth showing in full: the numbers are still useful, they are
         just a floor, and the owner is the one who can go read the rest. */
      if (e.data && e.data.invoices) {
        window.alert('Cannot reconcile ' + orderId + ' safely.\n\n' + e.message + '\n\n' + lines(e.data));
      } else {
        A.toast(e.message, 'error');
      }
      restore();
      return;
    }

    var willBe = preview.frozen
      ? 'status left at "' + preview.before.status + '" (already shipped)'
      : preview.nextStatus
        ? 'status becomes "' + preview.nextStatus + '"'
        : 'status unchanged';

    var ok = window.confirm(
      'Reconcile ' + orderId + ' against BTCPay?\n\n' +
      'Invoices found:\n' + (lines(preview) || '  none') + '\n\n' +
      'Order total:      ' + money(preview.total) + '\n' +
      'Recorded now:     ' + money(preview.before.paidAmount) + '  (' + money(preview.before.due) + ' due)\n' +
      'Actually paid:    ' + money(preview.paid) + '  (' + money(preview.due) + ' due)\n\n' +
      'This replaces the stored figure with BTCPay\'s and ' + willBe + '.'
    );
    if (!ok) { restore(); return; }

    btn.textContent = 'Saving…';
    try {
      var data = await A.api(path, { method: 'POST', body: {} });
      A.toast('Reconciled — ' + money(data.paid) + ' paid, ' + money(data.due) + ' due.', 'success');
      if (data.notes && data.notes.length) window.alert(data.notes.join('\n\n'));
      loadAll();
    } catch (e) {
      A.toast(e.message, 'error');
      restore();
    }
  }

  async function cancelOrder(orderId, btn) {
    var o = (state.orders || []).find(function (x) { return x.orderId === orderId; });
    /* A short-paid order is the one case where cancelling leaves money behind:
       the coins are in the wallet and nothing here can send them back, so the
       prompt names the amount and says whose job that is. */
    var short = o && o.status === 'underpaid';
    var got = short && o.paidAmount ? money(o.paidAmount) : 'what they sent';
    if (!window.confirm(short
        ? 'Cancel ' + orderId + ' and refund ' + got + '?\n\n' +
          'This releases the reserved stock and any held reward points, and marks the order dead. ' +
          'It does NOT move any crypto — you must send ' + got + ' back from your BTCPay wallet yourself.'
        : 'Cancel ' + orderId + '?\n\nUse this when the payment never arrived. ' +
          'It releases the reserved stock and any held reward points. It does not refund anything.')) return;
    btn.disabled = true;
    try {
      await A.api('/api/admin/orders/' + encodeURIComponent(orderId) + '/cancel', { method: 'POST' });
      A.toast(orderId + ' cancelled.', 'success');
      await loadAll({ quiet: true });
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
  }

  /* ---- one purchase, two records ----
     Two orders are the same purchase when the same buyer bought the same items
     for the same money within a day of each other. That is the pattern a
     re-checkout leaves behind (see the 12–13 Aug 2026 pair), and it is specific
     enough that it never fires on someone genuinely reordering next month. */
  function purchaseKey(o) {
    var items = (o.items || []).map(function (i) { return i.id + 'x' + (Number(i.quantity) || 0); })
      .sort().join('|');
    return (String(o.email || o.userEmail || '').toLowerCase()) + '::' + items + '@' +
      (Number(o.total) || 0).toFixed(2);
  }

  var TWIN_WINDOW_MS = 36 * 60 * 60 * 1000;

  /* The OTHER record of this purchase — preferring the older one, since that is
     the original and this is the copy. */
  function twinOf(o) {
    if (!o || isTestOrder(o)) return null;
    var key = purchaseKey(o);
    var at = new Date(o.createdAt).getTime();
    return (state.orders || []).filter(function (x) {
      return x.orderId !== o.orderId && !isTestOrder(x) && purchaseKey(x) === key &&
        Math.abs(new Date(x.createdAt).getTime() - at) < TWIN_WINDOW_MS;
    }).sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); })[0] || null;
  }

  async function removeDuplicate(orderId, btn) {
    var o = (state.orders || []).find(function (x) { return x.orderId === orderId; });
    if (!o) { A.toast('That order is no longer loaded — press Refresh.', 'error'); return; }
    var twin = twinOf(o);
    var earned = Number(o.pointsEarned) || 0;

    if (!window.confirm(
        'Remove ' + orderId + ' from the books?\n\n' +
        (twin ? 'It looks like a second record of the same purchase as ' + twin.orderId +
                ' — same customer, same items, same ' + money(o.total) + '.\n\n' : '') +
        'This takes it off every figure and out of the packing queue' +
        (earned ? ', takes back the ' + earned + ' loyalty points it awarded' : '') +
        ', and puts any stock it was holding back on the shelf.\n\n' +
        'It does NOT move money. Anything the customer actually sent is still in your wallet — ' +
        'decide separately whether any of it goes back.\n\n' +
        'A copy is archived on the server, but it will not appear in this console again.')) return;

    btn.disabled = true;
    btn.textContent = 'Removing…';
    try {
      var data = await A.api('/api/admin/orders/' + encodeURIComponent(orderId), {
        method: 'DELETE',
        body: { duplicateOf: twin ? twin.orderId : '', reason: 'duplicate of the same purchase' }
      });
      var r = data.reversed || {};
      A.toast(orderId + ' removed' + (r.pointsClawedBack ? ' · ' + r.pointsClawedBack + ' points reversed' : '') +
        (r.stockReleased ? ' · stock returned' : '') + '.', 'success');
      await loadAll({ quiet: true });
    } catch (e) {
      A.toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Remove duplicate';
    }
  }

  async function deleteUser(id, name, btn) {
    if (!window.confirm('Delete ' + name + '?\n\nThis permanently removes their account, saved cart and orders. ' +
        'This cannot be undone.')) return;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await A.api('/api/admin/users/' + encodeURIComponent(id), { method: 'DELETE' });
      A.toast(name + ' deleted.', 'success');
      await loadAll({ quiet: true });
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Delete'; }
  }

  async function dueNow(id, btn) {
    if (!window.confirm('Move this plan\'s next shipment to right now?\n\n' +
        'It will be invoiced on the next run — including if you press “Invoice everything due”.')) return;
    btn.disabled = true;
    try {
      await A.api('/api/admin/subscriptions/' + encodeURIComponent(id) + '/due-now', { method: 'POST' });
      A.toast('That plan is now due. Press “Invoice everything due” to send its invoice.', 'success');
      await loadAll({ quiet: true });
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
  }

  async function runDue() {
    if (!window.confirm('Invoice every auto-ship plan that is past its shipment date now?\n\n' +
        'This emails real customers a real bill — the same thing the scheduled trigger does on its own.')) return;
    var btn = document.getElementById('runDueBtn');
    btn.disabled = true;
    btn.textContent = 'Running…';
    try {
      var data = await A.api('/api/subscriptions/run-due', { method: 'POST' });
      A.toast('Ran ' + A.plural(data.due, 'due plan') + ' · ' + data.invoiced + ' invoiced · ' +
        data.failed + ' failed · ' + A.plural(data.reminded, 'reminder') + ' sent.',
        data.failed ? 'error' : 'success');
      await loadAll({ quiet: true });
    } catch (e) {
      A.toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Invoice everything due';
    }
  }

  /* ============================================================
     DISPUTES
     The queue and thread layout live in js/admin-disputes.js — a message
     stream with a composer, attachments and a resolve control is a screen,
     not a section, and this file is already long. This is only the state
     glue: the handlers the view calls back into, wired through the
     delegated click handler below.
     ============================================================ */

  var DSP = window.AdminDisputes;

  function renderDisputes() {
    if (!DSP) {
      body.innerHTML = '<div class="adm-card"><p class="adm-note" style="margin:0">' +
        'The disputes view did not load — check that <code>js/admin-disputes.js</code> is uploaded.</p></div>';
      return;
    }
    DSP.render(state, body, {
      open: openDispute, reply: replyToDispute, resolve: resolveDispute,
      reopen: reopenDispute, tab: setDisputeTab
    });
  }

  function setDisputeTab(tab) { state.disputeTab = tab; render(); }

  async function openDispute(id) {
    state.disputeId = id;
    state.disputeThread = null;
    render();
    try {
      var data = await A.api('/api/admin/disputes/' + encodeURIComponent(id));
      // A second click can land while this one is still in flight — the
      // second click wins, so a stale response must not overwrite it.
      if (state.disputeId !== id) return;
      state.disputeThread = data;
      state.disputeOutcomes = data.outcomes || state.disputeOutcomes;
      render();
      // Opening it IS reading it — mark it and drop the rail tally.
      await A.api('/api/admin/disputes/' + encodeURIComponent(id) + '/read', { method: 'POST' });
      if (state.disputeId !== id) return;
      await loadAll({ quiet: true });
      if (state.disputeId !== id) return;
      render();
    } catch (e) {
      A.toast(e.message, 'error');
      // Leaving disputeId set with no thread strands the pane on a skeleton
      // with no way back — drop the selection so the queue is usable again.
      if (state.disputeId === id) { state.disputeId = ''; render(); }
    }
  }

  async function replyToDispute(id, btn) {
    var box = document.getElementById('dspReply');
    var message = box ? box.value.trim() : '';
    if (!message) { A.toast('Write a reply first.', 'error'); return; }
    btn.disabled = true;
    try {
      var data = await A.api('/api/admin/disputes/' + encodeURIComponent(id) + '/messages',
        { method: 'POST', body: { message: message } });
      state.disputeThread = Object.assign({}, state.disputeThread, { dispute: data.dispute });
      A.toast('Sent. The customer has been emailed a link to it.', 'success');
      await loadAll({ quiet: true });
      render();
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
  }

  async function resolveDispute(id, btn) {
    var sel = document.getElementById('dspOutcome');
    var note = document.getElementById('dspNote');
    var outcome = sel ? sel.value : '';
    if (!outcome) { A.toast('Pick how this ended first.', 'error'); return; }
    if (!window.confirm('Close this report as “' + sel.options[sel.selectedIndex].text + '”?\n\n' +
        'The customer is emailed the outcome. Nothing is refunded or reshipped by this — do that separately.')) return;
    btn.disabled = true;
    try {
      var data = await A.api('/api/admin/disputes/' + encodeURIComponent(id) + '/resolve',
        { method: 'POST', body: { outcome: outcome, note: note ? note.value : '' } });
      state.disputeThread = Object.assign({}, state.disputeThread, { dispute: data.dispute });
      A.toast('Closed, and the customer has been told.', 'success');
      await loadAll({ quiet: true });
      render();
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
  }

  async function reopenDispute(id, btn) {
    btn.disabled = true;
    try {
      var data = await A.api('/api/admin/disputes/' + encodeURIComponent(id) + '/reopen', { method: 'POST' });
      state.disputeThread = Object.assign({}, state.disputeThread, { dispute: data.dispute });
      await loadAll({ quiet: true });
      render();
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
  }

  /* An <img> can't send the bearer token, so the bytes are fetched with it
     and handed to the browser as a blob URL. A.headers() already attaches
     both the bearer token and the admin key — the same auth every other
     admin request uses, so this never depends on which one is active. */
  async function openDisputeAttachment(disputeId, fileId) {
    try {
      var url = (window.PEPTIDE_API_BASE || '') + '/api/admin/disputes/' +
        encodeURIComponent(disputeId) + '/files/' + encodeURIComponent(fileId);
      var res = await fetch(url, { headers: A.headers() });
      if (!res.ok) throw new Error('That attachment could not be loaded.');
      var blob = await res.blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) { A.toast(e.message, 'error'); }
  }

  /* ============================================================
     BOOT
     ============================================================ */
  function readHash() {
    var h = (window.location.hash || '').replace('#', '');
    return TITLES[h] ? h : 'dashboard';
  }

  function init() {
    var mount = document.getElementById('adminShell');
    shell = A.renderShell(mount, { active: readHash(), title: 'Dashboard', subtitle: '' });
    body = shell.body;

    // One delegated listener for the whole console — views are re-rendered
    // wholesale, so per-render listener wiring would leak.
    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.id === 'refreshBtn') { loadAll(); return; }
      if (t.classList.contains('act-paid')) markPaid(t.getAttribute('data-id'), t.getAttribute('data-total'), t);
      else if (t.classList.contains('act-ship')) markShipped(t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-rate-edit')) toggleRateEdit(t.getAttribute('data-id'));
      else if (t.classList.contains('act-rate-save')) saveRate(t.getAttribute('data-key'), t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-rate-del')) deleteRate(t.getAttribute('data-id'), t.getAttribute('data-name'), t);
      else if (t.classList.contains('act-promo-save')) savePromo(t.getAttribute('data-key'), t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-promo-edit')) togglePromoEdit(t.getAttribute('data-id'));
      else if (t.classList.contains('act-promo-del')) deletePromo(t.getAttribute('data-id'), t.getAttribute('data-name'));
      else if (t.hasAttribute('data-ptab')) { promoTab = t.getAttribute('data-ptab'); render(); }
      else if (t.classList.contains('act-slip')) packingSlip(t.getAttribute('data-id'));
      else if (t.classList.contains('act-label')) {
        printOrderLabels((state.orders || []).filter(function (o) { return o.orderId === t.getAttribute('data-id'); }));
      } else if (t.classList.contains('act-labels-all')) {
        printOrderLabels(toShip(state.orders || []));
      } else if (t.classList.contains('act-label-save')) saveLabelDesign(t);
      else if (t.classList.contains('act-label-reset')) resetLabelDesign(t);
      else if (t.classList.contains('act-label-test')) printOrderLabels([previewOrder()], LBL && LBL.withDefaults(readLabelForm()));
      else if (t.classList.contains('act-cancel')) cancelOrder(t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-paylink')) sendPayLink(t.getAttribute('data-id'), t.getAttribute('data-due'), t);
      else if (t.classList.contains('act-collect')) collectBalance(t.getAttribute('data-id'), t.getAttribute('data-got'), t.getAttribute('data-total'), t);
      else if (t.classList.contains('act-reconcile')) reconcileOrder(t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-dupe')) removeDuplicate(t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-del-user')) deleteUser(t.getAttribute('data-id'), t.getAttribute('data-name'), t);
      else if (t.classList.contains('act-due')) dueNow(t.getAttribute('data-id'), t);
      else if (t.hasAttribute('data-dsp-tab')) setDisputeTab(t.getAttribute('data-dsp-tab'));
      else if (t.hasAttribute('data-dsp-open')) openDispute(t.getAttribute('data-dsp-open'));
      else if (t.classList.contains('act-dsp-reply')) replyToDispute(t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-dsp-resolve')) resolveDispute(t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-dsp-reopen')) reopenDispute(t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-dsp-att')) openDisputeAttachment(t.getAttribute('data-dsp'), t.getAttribute('data-file'));
    });

    /* The designer previews live: every keystroke redraws the label from the
       form using the same document the printer gets. Delegated for the same
       reason as the clicks — the view is re-rendered wholesale. */
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (state.view !== 'labeldesign' || !t || !t.id || t.id.indexOf('ld-') !== 0) return;
      if (t.id === 'ld-preview-order') return;      // a select; handled on change
      updateLabelPreview();
    });

    document.addEventListener('change', function (e) {
      var t = e.target;
      var typeSel = e.target.closest('.promo-type');
      if (typeSel) { syncPromoFields(typeSel.closest('.promo-form')); return; }
      if (state.view !== 'labeldesign' || !t || !t.id) return;
      if (t.id === 'ld-preview-order') { state.previewId = t.value; updateLabelPreview(); return; }
      if (t.id.indexOf('ld-') !== 0) return;
      if (t.id === 'ld-size') {
        // Only a custom size has dimensions worth typing; a preset's are fixed
        // by the stock in the printer, so they are shown but locked.
        var custom = t.value === 'custom';
        var preset = (LBL && LBL.SIZES[t.value]) || null;
        var w = document.getElementById('ld-w'), h = document.getElementById('ld-h');
        if (w) { w.disabled = !custom; if (!custom && preset) w.value = preset.widthMm; }
        if (h) { h.disabled = !custom; if (!custom && preset) h.value = preset.heightMm; }
      }
      updateLabelPreview();
    });

    // The preview is scaled to the column, so a resized window has to re-fit it.
    window.addEventListener('resize', function () {
      if (state.view === 'labeldesign') updateLabelPreview();
    });

    window.addEventListener('hashchange', function () {
      state.view = readHash();
      // Keep the rail in step with the view without rebuilding the shell.
      A.$$('.adm-nav a').forEach(function (a) {
        var on = a.getAttribute('href') === 'admin.html#' + state.view;
        a.classList.toggle('active', on);
        if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      });
      render();
    });

    state.view = readHash();

    if (!A.hasCredentials()) { render(); renderGate(); return; }
    loadAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window, document);
