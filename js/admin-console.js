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
      A.api('/api/health')
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

    results.forEach(function (r, i) {
      if (r.status === 'rejected' && r.reason.status !== 0) {
        // Health is a diagnostic, not data — its failure is not worth a toast.
        if (i === 4) return;
        A.toast(['Orders', 'Users', 'Auto-ship plans', 'Products'][i] + ': ' + r.reason.message, 'error');
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
    btcpay: ['BTCPay', 'What the payment server says, next to what we recorded'],
    autoship: ['Auto-Ship', 'Repeating orders and their next invoice'],
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
    else if (state.view === 'btcpay') renderBtcpay();
    else if (state.view === 'autoship') renderAutoship();
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
        actions = '<button class="btn btn-primary btn-sm act-paid" data-id="' + esc(o.orderId) +
          '" data-total="' + esc(money(o.total)) + '">Mark paid</button> ' +
          '<button class="btn btn-ghost btn-sm act-cancel" data-id="' + esc(o.orderId) + '">Cancel</button>';
      }
      return '<tr>' +
        '<td><span class="ref">' + esc(o.orderId) + '</span>' +
          (o.subscriptionId ? '<span class="muted">auto-ship</span>' : '') + '</td>' +
        '<td>' + esc(A.date(o.createdAt, true)) + '<span class="muted">' + esc(A.ago(o.createdAt)) + '</span></td>' +
        '<td>' + who + addr + '</td>' +
        '<td>' + esc(itemsText(o.items)) + '</td>' +
        '<td>' + esc(methodLabel(o.method)) +
          (isTestOrder(o) ? '<span class="muted">sandbox — no money taken</span>' : '') + '</td>' +
        '<td><span class="pill ' + esc(o.status || '') + '">' + esc(String(o.status || '').replace('_', ' ')) + '</span>' +
          (isTestOrder(o) ? ' <span class="pill test">test</span>' : '') +
          (late ? ' <span class="pill late">past hold</span>' : '') + '</td>' +
        '<td class="num"><strong>' + esc(money(o.total)) + '</strong></td>' +
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
        '<td class="actions">' + (i.needsAttention
          ? '<button class="btn btn-primary btn-sm act-paid" data-id="' + esc(i.orderId) +
            '" data-total="' + esc(money(i.amount)) + '">' +
            (i.status === 'Settled' ? 'Release order' : 'Mark paid anyway') + '</button>' : '') + '</td>' +
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
    } catch (e) {
      A.toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function cancelOrder(orderId, btn) {
    if (!window.confirm('Cancel ' + orderId + '?\n\nUse this when the payment never arrived. ' +
        'It releases the reserved stock and any held reward points. It does not refund anything.')) return;
    btn.disabled = true;
    try {
      await A.api('/api/admin/orders/' + encodeURIComponent(orderId) + '/cancel', { method: 'POST' });
      A.toast(orderId + ' cancelled.', 'success');
      await loadAll({ quiet: true });
    } catch (e) { A.toast(e.message, 'error'); btn.disabled = false; }
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
      else if (t.classList.contains('act-cancel')) cancelOrder(t.getAttribute('data-id'), t);
      else if (t.classList.contains('act-del-user')) deleteUser(t.getAttribute('data-id'), t.getAttribute('data-name'), t);
      else if (t.classList.contains('act-due')) dueNow(t.getAttribute('data-id'), t);
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
