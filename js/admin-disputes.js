/* ============================================================
   EVER NOVA LIFE — admin: dispute threads
   The Disputes view: a queue on the left, one thread on the right
   with the order it is about sitting above the conversation.

   It lives in its own file because admin-console.js is already
   long, and a message stream with a composer, image previews and
   a resolve control is a screen, not a section.

   Talks to /api/admin/disputes. Rendered wholesale on every state
   change, like every other view here — so no listeners are wired
   in this file; the console's delegated handler calls back in.
   ============================================================ */
(function (window, document) {
  'use strict';
  var A = window.Admin;

  var TABS = [
    { key: 'awaiting_us', label: 'Awaiting us' },
    { key: 'awaiting_customer', label: 'Awaiting customer' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'all', label: 'All' }
  ];

  var STATUS_LABEL = {
    awaiting_us: 'Waiting on us',
    awaiting_customer: 'Waiting on them',
    resolved: 'Resolved'
  };

  function filtered(list, tab) {
    list = list || [];
    if (tab === 'all') return list;
    return list.filter(function (d) { return d.status === tab; });
  }

  function queueRow(d, activeId) {
    return '<button type="button" class="dsp-row' + (d.id === activeId ? ' active' : '') +
      (d.unreadForAdmin ? ' unread' : '') + '" data-dsp-open="' + A.esc(d.id) + '">' +
      '<div class="dsp-row-top"><strong>' + A.esc(d.orderId) + '</strong>' +
        '<span class="dsp-when">' + A.esc(A.ago(d.lastAt)) + '</span></div>' +
      '<div class="dsp-row-who">' + A.esc(d.customerEmail || '') + '</div>' +
      '<div class="dsp-row-why">' + A.esc(d.reasonLabel || '') + '</div>' +
      '<span class="dsp-chip dsp-' + A.esc(d.status) + '">' + A.esc(STATUS_LABEL[d.status] || d.status) + '</span>' +
      '</button>';
  }

  function orderCard(order) {
    if (!order) {
      return '<div class="dsp-order muted">That order is no longer in the books.</div>';
    }
    var items = (order.items || []).map(function (i) {
      var shipped = i.quantity;
      var paid = (i.paidQuantity == null) ? i.quantity : i.paidQuantity;
      // A BOGO line ships more than it bills, so both numbers earn their place.
      var qty = (paid !== shipped) ? (shipped + ' shipped · ' + paid + ' billed') : ('×' + shipped);
      return '<li>' + A.esc(i.name) + ' <span class="muted">' + A.esc(qty) + '</span></li>';
    }).join('');
    var track = [order.carrier, order.tracking].filter(Boolean).join(' · ');
    return '<div class="dsp-order">' +
      '<div class="dsp-order-head"><strong>' + A.esc(order.orderId) + '</strong>' +
        '<span class="muted">' + A.esc(A.date(order.createdAt)) + '</span>' +
        '<span class="dsp-chip">' + A.esc(order.status || '') + '</span>' +
        '<span>' + A.esc(A.money(order.total)) + '</span></div>' +
      '<ul class="dsp-order-items">' + items + '</ul>' +
      (track ? '<div class="muted">Tracking: ' + A.esc(track) + '</div>' : '') +
      '</div>';
  }

  /* An <img src> can't carry an Authorization header, and putting the admin
     key in a query string would leak it into browser history and referrers.
     So an attachment is a button: the console's delegated handler fetches
     the bytes with the same headers every other admin request uses, and
     opens them as a blob URL. */
  function attachmentsHtml(disputeId, list) {
    if (!list || !list.length) return '';
    return '<div class="dsp-atts">' + list.map(function (a) {
      // The record outlives the file. Rendering a button here would send the
      // owner to a 404 for something that expired exactly as intended.
      if (a.expiredAt) {
        return '<span class="dsp-att expired" title="Removed ' + A.esc(A.date(a.expiredAt)) + '">' +
          A.esc(a.name) + ' — photo removed</span>';
      }
      return '<button type="button" class="dsp-att act-dsp-att" data-dsp="' + A.esc(disputeId) +
        '" data-file="' + A.esc(a.id) + '">' + A.icon('download') + A.esc(a.name) + '</button>';
    }).join('') + '</div>';
  }

  function messageHtml(disputeId, m) {
    if (m.from === 'system') {
      return '<div class="dsp-msg system">' + A.esc(m.body) +
        ' <span class="dsp-when">' + A.esc(A.date(m.createdAt)) + '</span></div>';
    }
    return '<div class="dsp-msg ' + (m.from === 'admin' ? 'ours' : 'theirs') + '">' +
      '<div class="dsp-msg-head">' + A.esc(m.from === 'admin' ? 'Us' : (m.authorEmail || 'Customer')) +
        ' <span class="dsp-when">' + A.esc(A.date(m.createdAt)) + '</span></div>' +
      '<div class="dsp-msg-body">' + A.esc(m.body).replace(/\n/g, '<br>') + '</div>' +
      attachmentsHtml(disputeId, m.attachments) +
      '</div>';
  }

  function mb(n) {
    var v = Number(n) || 0;
    return v >= 1024 * 1024
      ? (v / (1024 * 1024)).toFixed(0) + ' MB'
      : Math.max(1, Math.round(v / 1024)) + ' KB';
  }

  /* How full the photo allowance is, with the control that frees it. Amber at
     the same threshold that sends the email, so the screen and the inbox never
     disagree about whether this is a problem yet. */
  function storageLine(state) {
    var s = state.storage;
    if (!s) return '';
    var warn = s.pct >= ((s.alertPct) || 80);
    return '<div class="dsp-storage' + (warn ? ' warn' : '') + '">' +
      '<span>' + A.esc(mb(s.usedBytes)) + ' of ' + A.esc(mb(s.ceilingBytes)) +
        ' · ' + A.esc(String(s.pct)) + '%</span>' +
      '<button type="button" class="btn btn-ghost btn-sm act-dsp-sweep">Run cleanup</button>' +
      '</div>';
  }

  function liveAttachmentCount(d) {
    var n = 0;
    (d.messages || []).forEach(function (m) {
      (m.attachments || []).forEach(function (a) { if (!a.expiredAt) n++; });
    });
    return n;
  }

  function resolveBox(d, outcomes) {
    if (d.status === 'resolved') {
      var label = (outcomes.find(function (o) { return o.code === d.outcome; }) || {}).label || d.outcome;
      return '<div class="dsp-resolved">' +
        '<div><strong>Resolved:</strong> ' + A.esc(label) +
          (d.outcomeNote ? ' — ' + A.esc(d.outcomeNote) : '') + '</div>' +
        '<button type="button" class="btn btn-sm act-dsp-reopen" data-id="' + A.esc(d.id) + '">Reopen</button>' +
        '</div>';
    }
    return '<div class="dsp-resolve">' +
      '<select id="dspOutcome" aria-label="How did this end?">' +
        '<option value="">How did this end?</option>' +
        outcomes.map(function (o) { return '<option value="' + A.esc(o.code) + '">' + A.esc(o.label) + '</option>'; }).join('') +
      '</select>' +
      '<input type="text" id="dspNote" placeholder="Note for the record (optional)" maxlength="1000">' +
      '<button type="button" class="btn btn-sm act-dsp-resolve" data-id="' + A.esc(d.id) + '">Resolve</button>' +
      '</div>';
  }

  function threadPane(state) {
    var t = state.disputeThread;
    if (!state.disputeId) {
      return '<div class="dsp-pane empty">' + A.empty('No report open', 'Pick one from the queue on the left.') + '</div>';
    }
    if (!t) return '<div class="dsp-pane">' + A.skeleton(4) + '</div>';

    var d = t.dispute;
    var outcomes = state.disputeOutcomes || [];
    return '<div class="dsp-pane">' +
      orderCard(t.order) +
      resolveBox(d, outcomes) +
      (liveAttachmentCount(d)
        ? '<div class="dsp-strip">' +
            '<span class="muted">' + A.esc(String(liveAttachmentCount(d))) + ' photo(s) stored on this report</span>' +
            '<button type="button" class="btn btn-ghost btn-sm act-dsp-strip" data-id="' + A.esc(d.id) + '">Remove photos</button>' +
          '</div>'
        : '') +
      '<div class="dsp-stream">' + d.messages.map(function (m) { return messageHtml(d.id, m); }).join('') + '</div>' +
      (d.status === 'resolved'
        ? '<p class="muted">This report is closed. Reopen it to reply.</p>'
        : '<div class="dsp-composer">' +
            '<textarea id="dspReply" rows="3" maxlength="4000" placeholder="Write a reply…"></textarea>' +
            '<button type="button" class="btn btn-primary btn-sm act-dsp-reply" data-id="' + A.esc(d.id) + '">Send</button>' +
          '</div>') +
      '</div>';
  }

  function render(state, body) {
    var list = state.disputes;
    if (!list) { body.innerHTML = A.skeleton(6); return; }
    /* The storage figure belongs above the empty state, not inside the queue:
       an empty queue is exactly when photos left behind by deleted or
       long-resolved reports are the only thing on the disk, and the line was
       unreachable there. */
    if (!list.length) {
      body.innerHTML = storageLine(state) +
        A.empty('No reports yet',
          'When a customer reports a problem with an order, the thread lands here.');
      return;
    }
    var rows = filtered(list, state.disputeTab);
    body.innerHTML =
      '<div class="dsp-wrap">' +
        storageLine(state) +
        '<div class="dsp-queue">' +
          '<div class="seg dsp-tabs" role="group" aria-label="Filter reports">' +
            TABS.map(function (t) {
              var n = filtered(list, t.key).length;
              return '<button type="button" data-dsp-tab="' + t.key + '" aria-pressed="' +
                (state.disputeTab === t.key) + '">' + A.esc(t.label) + (n ? ' (' + n + ')' : '') + '</button>';
            }).join('') +
          '</div>' +
          (rows.length
            ? rows.map(function (d) { return queueRow(d, state.disputeId); }).join('')
            : '<p class="muted">Nothing in this tab.</p>') +
        '</div>' +
        threadPane(state) +
      '</div>';
  }

  window.AdminDisputes = { render: render };
})(window, document);
