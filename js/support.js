/* ============================================================
   EVER NOVA LIFE — support.html
   One order, one thread. The page has two shapes: the form that
   opens a report, and the conversation once one exists.

   Reached as support.html?order=ENL-… from the order row on the
   account page and from the notification email, so the order
   reference — never a dispute id — is what the URL carries. The
   customer knows their order reference; they have no reason to
   know a DSP- id.
   ============================================================ */
(function (window, document) {
  'use strict';

  var API = (window.PEPTIDE_API_BASE || '');
  var POLL_MS = 20000;

  var state = {
    orderId: '', dispute: null, order: null, reasons: [], pending: [], pendingReply: [], timer: null,
    // Set once the customer asks to escalate a resolved thread, so the poll
    // re-rendering that thread leaves the open-report form on screen.
    startingNew: false,
    // One generation counter + outstanding-read count per file input, so a
    // submit can be blocked while reads are in flight and a read from a
    // superseded selection can be told apart from the current one.
    pendingAttach: { gen: 0, busy: 0 },
    pendingReplyAttach: { gen: 0, busy: 0 }
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function token() { return window.Auth && window.Auth.getToken ? window.Auth.getToken() : ''; }

  async function api(path, opts) {
    opts = opts || {};
    var headers = {};
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    var res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) {
      var err = new Error((data && data.error) || 'Something went wrong. Try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---- attachments: read to base64 in the browser, capped before we ask
     the server to refuse them.

     Reading is async and the customer can submit before it finishes, so
     each selection is stamped with its own generation number on `info`
     (either state.pendingAttach or state.pendingReplyAttach). A read whose
     generation no longer matches `info.gen` by the time it lands — because
     the customer picked a different set of files before the first set
     finished reading — is a stale read and is dropped instead of landing
     in the (by then unrelated) bucket. While any read for the CURRENT
     generation is still outstanding, `info.busy` is > 0, the matching
     submit button is disabled, and the message element says so — so a
     report can never be sent with a photo it hasn't finished reading. ---- */
  var MAX_FILES = 3;
  var MAX_BYTES = 2 * 1024 * 1024;
  /* The whole request has to fit under the server's 12 MB JSON body limit, and
     base64 is 4/3 of the bytes: the advertised three 2 MB photos are already
     ~8.4 MB of characters. 9 MB clears that with room for the message and the
     JSON around it, and refuses the rest HERE — a body the server bounces
     costs the customer everything they attached and everything they typed. */
  var MAX_TOTAL_CHARS = 9 * 1024 * 1024;

  function attachedChars(bucket) {
    var total = 0;
    for (var i = 0; i < bucket.length; i++) total += String(bucket[i].data || '').length;
    return total;
  }
  var TOO_MUCH = 'Those photos are too big to send together — swap one for a smaller version, or send fewer.';

  function readFiles(input, bucket, previewEl, msgEl, submitBtn, info) {
    var files = Array.prototype.slice.call(input.files || []);
    var gen = ++info.gen;      // supersedes any reads still in flight from the previous selection
    info.busy = 0;
    bucket.length = 0;
    previewEl.innerHTML = '';
    submitBtn.disabled = false;

    var notices = [];
    function render() {
      var parts = notices.slice();
      if (info.busy > 0) parts.push('Attaching ' + info.busy + (info.busy === 1 ? ' photo…' : ' photos…'));
      // Told at selection time, not after a minute of typing and a rejected send.
      var overall = info.busy === 0 && attachedChars(bucket) > MAX_TOTAL_CHARS;
      if (overall) parts.push(TOO_MUCH);
      msgEl.textContent = parts.join(' ');
      submitBtn.disabled = info.busy > 0 || overall;
    }

    if (files.length > MAX_FILES) {
      notices.push('Attach at most ' + MAX_FILES + ' photos.');
      input.value = '';
      render();
      return;
    }

    var toRead = files.filter(function (f) {
      if (f.size > MAX_BYTES) {
        notices.push('Each photo has to be under 2 MB — ' + f.name + ' is bigger.');
        return false;
      }
      return true;
    });

    info.busy = toRead.length;
    render();

    toRead.forEach(function (f) {
      var reader = new FileReader();
      reader.onload = function () {
        if (gen !== info.gen) return;   // a later selection replaced this one — discard
        bucket.push({ name: f.name, data: String(reader.result || '') });
        var img = document.createElement('img');
        img.src = String(reader.result || '');
        img.alt = f.name;
        previewEl.appendChild(img);
        info.busy--;
        render();
      };
      reader.onerror = function () {
        if (gen !== info.gen) return;   // superseded — nothing to surface any more
        notices.push('Could not read ' + f.name + ' — try a different photo.');
        info.busy--;
        render();
      };
      reader.readAsDataURL(f);
    });
  }

  /* ---- rendering ---- */
  /* The same names and chips the account page uses. This page used to print
     the raw status straight from the record, so a customer read
     "awaiting_payment" while account.html called the same order
     "Awaiting payment" — one order, two vocabularies, and one of them
     internal. */
  function statusChip(status) {
    var s = String(status || '').toLowerCase();
    var known = {
      paid: 'Paid', pending: 'Pending', cancelled: 'Cancelled',
      processing: 'Processing', shipped: 'Shipped', delivered: 'Delivered',
      awaiting_payment: 'Awaiting payment',
      underpaid: 'Payment short'
    };
    var label = known[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Processing');
    var cls = known[s] ? s.replace(/_/g, '-') : 'processing';
    return '<span class="order-status ' + esc(cls) + '">' + esc(label) + '</span>';
  }

  function orderCard(o) {
    if (!o) return '';
    var items = (o.items || []).map(function (i) {
      var paid = (i.paidQuantity == null) ? i.quantity : i.paidQuantity;
      /* A BOGO line ships more than it bills, so both numbers earn their place. */
      var qty = (paid !== i.quantity) ? (i.quantity + ' sent · ' + paid + ' billed') : ('×' + i.quantity);
      return '<li>' + esc(i.name) + ' <span class="text-muted">' + esc(qty) + '</span></li>';
    }).join('');
    var track = [o.carrier, o.tracking].filter(Boolean).join(' · ');
    return '<div class="sup-order-head">' +
        '<span class="sup-order-ref">' + esc(o.orderId) + '</span>' +
        statusChip(o.status) +
      '</div>' +
      '<ul class="sup-order-items">' + items + '</ul>' +
      (track ? '<p class="sup-order-track"><span class="text-muted">Tracking</span> ' + esc(track) + '</p>' : '');
  }

  function messageHtml(d, m) {
    if (m.from === 'system') {
      return '<div class="sup-msg system">' + esc(m.body) + '</div>';
    }
    var atts = (m.attachments || []).map(function (a) {
      // Expired photos keep their place in the conversation so it still reads
      // honestly — a message saying "see the photo" above nothing would leave
      // the customer wondering whether it ever sent.
      if (a.expiredAt) {
        return '<span class="sup-att expired">' + esc(a.name) + ' — photo removed</span>';
      }
      return '<button type="button" class="sup-att" data-file="' + esc(a.id) + '">' + esc(a.name) + '</button>';
    }).join('');
    return '<div class="sup-msg ' + (m.from === 'admin' ? 'theirs' : 'mine') + '">' +
      '<div class="sup-msg-head">' + (m.from === 'admin' ? 'Ever Nova Life' : 'You') +
        ' · ' + esc(new Date(m.createdAt).toLocaleString()) + '</div>' +
      '<div class="sup-msg-body">' + esc(m.body).replace(/\n/g, '<br>') + '</div>' +
      (atts ? '<div class="sup-atts">' + atts + '</div>' : '') +
      '</div>';
  }

  /* ---- "they replied" ----
     The thread already refreshes on its own every 20 seconds, but a silent
     refresh is not an announcement: a customer waiting on a missing parcel is
     usually on another tab. So a new reply raises a banner they can click, and
     changes the document title, which is the only part of this that reaches a
     tab nobody is looking at. */
  var lastSeenId = null;          // newest message id the reader has been shown
  var baseTitle = document.title;

  function newestRealId(d) {
    for (var i = d.messages.length - 1; i >= 0; i--) {
      var m = d.messages[i];
      if (m.from === 'customer' || m.from === 'admin') return m.id;
    }
    return null;
  }
  function newestIsTheirs(d) {
    for (var i = d.messages.length - 1; i >= 0; i--) {
      var m = d.messages[i];
      if (m.from === 'customer' || m.from === 'admin') return m.from === 'admin';
    }
    return false;
  }

  function markRead() {
    document.title = baseTitle;
    var b = $('supNew');
    if (b) b.hidden = true;
  }

  function announceReply() {
    var b = $('supNew');
    if (b) b.hidden = false;
    /* Only the title is conditional: a tab the reader is focused on does not
       need its name changed, but the banner shows either way. */
    if (document.hasFocus && document.hasFocus()) return;
    /* The count is deliberately not tracked across replies — "they replied" is
       the whole message, and a growing number would only be read as noise. */
    document.title = '(1) ' + baseTitle;
  }

  /* Setting scrollTop from scrollHeight in the same tick as the innerHTML
     write reads a height the browser has not laid out yet, so the view lands
     on the message BEFORE the new one. Wait a frame and scroll to the last
     element itself rather than computing a number. */
  function scrollToNewest() {
    var stream = $('supStream');
    if (!stream) return;
    window.requestAnimationFrame(function () {
      var last = stream.lastElementChild;
      if (last && last.scrollIntoView) last.scrollIntoView({ block: 'end' });
      else stream.scrollTop = stream.scrollHeight;
    });
  }

  function renderThread() {
    var d = state.dispute;
    $('supOpenForm').hidden = true;
    $('supThread').hidden = false;
    $('supStream').innerHTML = d.messages.map(function (m) { return messageHtml(d, m); }).join('');
    scrollToNewest();

    /* First render just establishes where we are; only a LATER change counts as
       news, or opening the page would announce a reply the reader is looking at. */
    var newest = newestRealId(d);
    if (lastSeenId !== null && newest !== lastSeenId && newestIsTheirs(d)) {
      /* Announce it, full stop. `document.hidden` was the test here and it is
         only true for a genuinely hidden tab — a second window side by side is
         "visible" but unwatched, which is both how this gets tested and how a
         customer actually leaves the page sitting. Being told about something
         already on screen is mildly redundant; not being told is the bug. */
      announceReply();
    }
    lastSeenId = newest;

    var closed = d.status === 'resolved';
    if (!closed) state.startingNew = false;
    $('supReplyForm').hidden = closed;
    $('supClosed').hidden = !closed;
    if (closed) {
      /* A resolved thread used to be a dead end: the reply form is gone, and
         the order row on the account page links straight back HERE — so the
         one path a wrong outcome needs, opening a new report, was unreachable
         from the page the customer is sent to. The server has always accepted
         a new thread on a resolved order; this is the control that asks for
         one, and the closed conversation stays on screen so they can read
         what was decided while they write the new report. */
      $('supClosed').innerHTML = '<p><strong>This report is closed.</strong> ' +
        (d.outcomeNote ? esc(d.outcomeNote) + ' ' : '') +
        'If it still is not settled, open a new report on this order — this conversation stays here.</p>' +
        '<p><button type="button" class="btn btn-ghost btn-sm" id="supStartNew">Open a new report on this order</button></p>';
    }
    var h1 = document.querySelector('#main h1');
    if (h1) h1.textContent = closed ? 'Your report' : 'Your report';
    $('supIntro').textContent = closed
      ? 'This report is resolved.'
      : (d.status === 'awaiting_us' ? 'We have your report and will reply here.' : 'We have replied — your turn.');

    // Last, so it owns the intro line and the form's visibility: a poll that
    // re-renders the thread must not close a form the customer is typing in.
    if (closed && state.startingNew) renderOpenForm(true);
  }

  /* `keepThread` is the escalation path off a resolved thread — the form is
     revealed alongside the closed conversation rather than replacing it. */
  function renderOpenForm(keepThread) {
    if (!keepThread) $('supThread').hidden = true;
    $('supOpenForm').hidden = false;
    // On the escalation path this runs again on every 20-second poll, so the
    // reason the customer picked is carried across the rebuild — rebuilding
    // the list under them would quietly reset the field they had answered.
    var sel = $('supReason');
    var chosen = sel.value;
    sel.innerHTML = '<option value="">Choose one…</option>' +
      state.reasons.map(function (r) { return '<option value="' + esc(r.code) + '">' + esc(r.label) + '</option>'; }).join('');
    if (chosen) sel.value = chosen;
    var h1open = document.querySelector('#main h1');
    if (h1open && !keepThread) h1open.textContent = 'Report a problem';
    $('supIntro').textContent = keepThread
      ? 'Tell us what is still wrong and we will open a new report on this order.'
      : 'Tell us what went wrong and we will answer here.';
  }

  /* ---- loading ---- */
  async function load(quiet) {
    try {
      var mine = await api('/api/disputes');
      state.reasons = mine.reasons || [];
      var existing = (mine.disputes || []).find(function (d) { return d.orderId === state.orderId; });
      // The newest thread on this order wins: a resolved one and a later open
      // one can both exist, and the open one is the live conversation.
      if (existing) {
        var full = await api('/api/disputes/' + encodeURIComponent(existing.id));
        state.dispute = full.dispute;
        state.order = full.order;
        $('supOrder').hidden = false;
        $('supOrder').innerHTML = orderCard(state.order);
        renderThread();
        if (!quiet) api('/api/disputes/' + encodeURIComponent(existing.id) + '/read', { method: 'POST' }).catch(function () { });
      } else {
        state.dispute = null;
        renderOpenForm();
      }
    } catch (e) {
      if (e.status === 401) { showGate(); return; }
      $('supIntro').textContent = e.message;
    }
  }

  /* A background tab polling forever is a battery and a bandwidth cost for
     nothing, so the timer only runs while the page is actually visible. */
  function startPolling() {
    stopPolling();
    if (document.hidden || !state.dispute) return;
    state.timer = window.setInterval(function () { load(true); }, POLL_MS);
  }
  function stopPolling() { if (state.timer) { window.clearInterval(state.timer); state.timer = null; } }

  /* ---- actions ---- */
  /* ---- "we've got it" ----
     Sending a report used to just swap the form for the thread, with no
     acknowledgement at all. This is the moment a worried customer most needs
     to be told something definite: it arrived, this is what it is about, and
     here is where the answer will appear.

     The photo count is deliberate. A report whose images silently failed to
     attach is the worst outcome this page has, and seeing "2 photos" is the
     customer's own proof that the evidence went with it. */
  var sentRestoreFocus = null;

  function closeSent() {
    var box = document.querySelector('.supdialog');
    if (!box) return;
    document.removeEventListener('keydown', sentKey);
    document.body.classList.remove('adminalert-open');
    box.remove();
    if (sentRestoreFocus && sentRestoreFocus.focus) { try { sentRestoreFocus.focus(); } catch (e) {} }
  }

  function sentKey(e) {
    if (e.key === 'Escape') { closeSent(); return; }
    if (e.key !== 'Tab') return;
    /* aria-modal marks the rest of the page inert for assistive tech but does
       nothing to the tab order — without this, tabbing off the last control
       lands behind the backdrop on a page the reader cannot see. */
    var box = document.querySelector('.supdialog');
    if (!box) return;
    var f = Array.prototype.slice.call(box.querySelectorAll('a[href], button:not([disabled])'));
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function showSent(orderId, photos) {
    sentRestoreFocus = document.activeElement;
    var box = document.createElement('div');
    box.className = 'supdialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Your report has been sent');
    /* The ORDER reference, never the DSP- id: the customer knows the order
       they placed and has no reason to learn an internal thread id. */
    box.innerHTML =
      '<div class="supdialog-panel">' +
        '<h2>Your report has been sent</h2>' +
        '<p>We have your report about order <strong>' + esc(orderId) + '</strong>.' +
          (photos ? ' ' + photos + ' photo' + (photos === 1 ? '' : 's') + ' went with it.' : '') + '</p>' +
        '<p>We will reply on this page, and email you when there is an answer. ' +
          'Nothing else is needed from you for now.</p>' +
        '<button type="button" class="btn btn-primary supdialog-ok">See your report</button>' +
      '</div>';

    box.addEventListener('click', function (e) {
      if (e.target === box) closeSent();
      if (e.target.closest && e.target.closest('.supdialog-ok')) closeSent();
    });

    document.body.appendChild(box);
    document.body.classList.add('adminalert-open');
    document.addEventListener('keydown', sentKey);
    var ok = box.querySelector('.supdialog-ok');
    if (ok) ok.focus();
  }

  async function submitOpen(e) {
    e.preventDefault();
    var msg = $('supOpenMsg');
    var btn = e.target.querySelector('button[type=submit]');
    // Belt and braces alongside the disabled button: a photo that is still
    // being read must never be silently missing from what gets sent.
    if (state.pendingAttach.busy > 0) { msg.textContent = 'Still attaching your photos — one moment.'; return; }
    if (attachedChars(state.pending) > MAX_TOTAL_CHARS) { msg.textContent = TOO_MUCH; return; }
    msg.textContent = '';
    btn.disabled = true;
    try {
      var data = await api('/api/disputes', {
        method: 'POST',
        body: {
          orderId: state.orderId,
          reason: $('supReason').value,
          message: $('supMessage').value,
          attachments: state.pending.slice()
        }
      });
      state.dispute = data.dispute;
      state.order = data.order || state.order;
      state.startingNew = false;
      /* The site-wide watcher caches "this visitor has no reports" for the
         session so the shop is not billed an API call per page. Opening one
         makes that cache a lie — and a stale lie means the reply notification
         never fires again all session, which is exactly how it went missing. */
      try { window.sessionStorage.removeItem('enl_no_disputes'); } catch (e) {}
      $('supOrder').hidden = false;
      $('supOrder').innerHTML = orderCard(state.order);
      state.pending.length = 0;
      $('supPreviews').innerHTML = '';
      renderThread();
      startPolling();
      /* Counted from what the server stored, not from what we tried to send —
         so the number the customer reads is the number that actually arrived. */
      var stored = (data.dispute.messages[0] || {}).attachments || [];
      showSent(data.dispute.orderId, stored.length);
    } catch (e2) {
      msg.textContent = e2.message;
      btn.disabled = false;
    }
  }

  async function submitReply(e) {
    e.preventDefault();
    var msg = $('supReplyMsg');
    var btn = e.target.querySelector('button[type=submit]');
    // Belt and braces alongside the disabled button: a photo that is still
    // being read must never be silently missing from what gets sent.
    if (state.pendingReplyAttach.busy > 0) { msg.textContent = 'Still attaching your photos — one moment.'; return; }
    if (attachedChars(state.pendingReply) > MAX_TOTAL_CHARS) { msg.textContent = TOO_MUCH; return; }
    msg.textContent = '';
    btn.disabled = true;
    try {
      var data = await api('/api/disputes/' + encodeURIComponent(state.dispute.id) + '/messages', {
        method: 'POST',
        body: { message: $('supReply').value, attachments: state.pendingReply.slice() }
      });
      state.dispute = data.dispute;
      $('supReply').value = '';
      state.pendingReply.length = 0;
      $('supReplyPreviews').innerHTML = '';
      renderThread();
    } catch (e2) {
      msg.textContent = e2.message;
    }
    btn.disabled = false;
  }

  /* An <img> can't send the bearer token, so an attachment is fetched with
     it and handed to the browser as a blob. */
  async function openAttachment(fileId) {
    try {
      var headers = {};
      var t = token();
      if (t) headers.Authorization = 'Bearer ' + t;
      var res = await fetch(API + '/api/disputes/' + encodeURIComponent(state.dispute.id) +
        '/files/' + encodeURIComponent(fileId), { headers: headers });
      if (!res.ok) throw new Error('That photo could not be loaded.');
      window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
    } catch (e) {
      // supReplyMsg lives inside the reply form, which is hidden on a
      // resolved thread — writing a failure there would be invisible on
      // exactly the threads a customer is most likely to be re-reading.
      // supIntro is on-screen in both states.
      var closed = state.dispute && state.dispute.status === 'resolved';
      $(closed ? 'supIntro' : 'supReplyMsg').textContent = e.message;
    }
  }

  /* The gate's Sign in button, built here so it carries the order back.
     login.html?next=support.html alone drops the ?order=…, and signing in
     lands the customer on the empty state with nothing to report against.
     js/auth.js reads `next` through URLSearchParams (so one layer of
     encoding is undone for it) and only honours a bare same-site page name
     with an optional query — which "support.html?order=ENL-…" is. */
  function showGate() {
    var link = $('supGateLink');
    if (link && state.orderId) {
      link.href = 'login.html?next=' +
        encodeURIComponent('support.html?order=' + encodeURIComponent(state.orderId));
    }
    $('supGate').hidden = false;
    $('supIntro').textContent = '';
  }

  /* ---- boot ---- */
  /* The shell's height is the viewport minus whatever the sticky header
     actually occupies. Measured rather than hardcoded: the announcement bar
     above the nav wraps at some widths, and a guessed constant would put the
     composer under the header on exactly those. */
  function measureHeader() {
    var h = document.querySelector('.site-header');
    if (!h) return;
    var box = h.getBoundingClientRect();
    document.documentElement.style.setProperty('--enl-hdr', Math.round(box.bottom) + 'px');
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    state.orderId = (params.get('order') || '').trim();
    if (!state.orderId) {
      $('supIntro').innerHTML = 'Open a report from one of <a href="account.html">your orders</a>.';
      return;
    }
    if (!window.Auth || !window.Auth.isLoggedIn || !window.Auth.isLoggedIn()) {
      showGate(); return;
    }

    $('supOpenForm').addEventListener('submit', submitOpen);
    $('supReplyForm').addEventListener('submit', submitReply);
    $('supFiles').addEventListener('change', function () {
      readFiles(this, state.pending, $('supPreviews'), $('supOpenMsg'),
        $('supOpenForm').querySelector('button[type=submit]'), state.pendingAttach);
    });
    $('supReplyFiles').addEventListener('change', function () {
      readFiles(this, state.pendingReply, $('supReplyPreviews'), $('supReplyMsg'),
        $('supReplyForm').querySelector('button[type=submit]'), state.pendingReplyAttach);
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var b = e.target.closest('.sup-att');
      if (b) { openAttachment(b.getAttribute('data-file')); return; }
      if (e.target.closest('#supStartNew')) {
        state.startingNew = true;
        renderOpenForm(true);
        $('supReason').focus();
      }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopPolling(); return; }
      /* Back on the tab: the title has done its job, so stop shouting. The
         banner stays until clicked — it is what scrolls them to the reply. */
      document.title = baseTitle;
      load(true);
      startPolling();
    });
    var newBanner = $('supNew');
    if (newBanner) {
      newBanner.addEventListener('click', function () {
        markRead();
        var stream = $('supStream');
        if (stream) stream.scrollTop = stream.scrollHeight;
      });
    }

    measureHeader();
    window.addEventListener('resize', measureHeader);

    /* One row until it needs more, so the composer stays the size of what is
       actually being written. */
    var reply = $('supReply');
    if (reply) {
      reply.addEventListener('input', function () {
        reply.style.height = 'auto';
        reply.style.height = Math.min(reply.scrollHeight, 128) + 'px';
      });
    }

    /* Instant when the stream is up, poll underneath when it is not. */
    if (window.Live) {
      window.Live.on(function (ev) {
        if (!ev || !state.dispute) return;
        if (ev.disputeId !== state.dispute.id) return;
        if (ev.type === 'dispute-reply' || ev.type === 'dispute-resolved') load(true);
      });
    }

    load().then(startPolling);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window, document);
