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
      msgEl.textContent = parts.join(' ');
      submitBtn.disabled = info.busy > 0;
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
  function orderCard(o) {
    if (!o) return '';
    var items = (o.items || []).map(function (i) {
      var paid = (i.paidQuantity == null) ? i.quantity : i.paidQuantity;
      var qty = (paid !== i.quantity) ? (i.quantity + ' sent · ' + paid + ' billed') : ('×' + i.quantity);
      return '<li>' + esc(i.name) + ' <span class="text-muted">' + esc(qty) + '</span></li>';
    }).join('');
    var track = [o.carrier, o.tracking].filter(Boolean).join(' · ');
    return '<h2>Order ' + esc(o.orderId) + '</h2>' +
      '<ul>' + items + '</ul>' +
      '<p class="text-muted">' + esc(o.status || '') +
        (track ? ' · Tracking: ' + esc(track) : '') + '</p>';
  }

  function messageHtml(d, m) {
    if (m.from === 'system') {
      return '<div class="sup-msg system">' + esc(m.body) + '</div>';
    }
    var atts = (m.attachments || []).map(function (a) {
      return '<button type="button" class="sup-att" data-file="' + esc(a.id) + '">' + esc(a.name) + '</button>';
    }).join('');
    return '<div class="sup-msg ' + (m.from === 'admin' ? 'theirs' : 'mine') + '">' +
      '<div class="sup-msg-head">' + (m.from === 'admin' ? 'Ever Nova Life' : 'You') +
        ' · ' + esc(new Date(m.createdAt).toLocaleString()) + '</div>' +
      '<div class="sup-msg-body">' + esc(m.body).replace(/\n/g, '<br>') + '</div>' +
      (atts ? '<div class="sup-atts">' + atts + '</div>' : '') +
      '</div>';
  }

  function renderThread() {
    var d = state.dispute;
    $('supOpenForm').hidden = true;
    $('supThread').hidden = false;
    $('supStream').innerHTML = d.messages.map(function (m) { return messageHtml(d, m); }).join('');
    $('supStream').scrollTop = $('supStream').scrollHeight;

    var closed = d.status === 'resolved';
    $('supReplyForm').hidden = closed;
    $('supClosed').hidden = !closed;
    if (closed) {
      $('supClosed').innerHTML = '<p><strong>This report is closed.</strong> ' +
        (d.outcomeNote ? esc(d.outcomeNote) + ' ' : '') +
        'If it still isn\'t settled, <a href="account.html">open a new report</a> from the order.</p>';
    }
    $('supIntro').textContent = closed
      ? 'This report is resolved.'
      : (d.status === 'awaiting_us' ? 'We have your report and will reply here.' : 'We have replied — your turn.');
  }

  function renderOpenForm() {
    $('supThread').hidden = true;
    $('supOpenForm').hidden = false;
    $('supReason').innerHTML = '<option value="">Choose one…</option>' +
      state.reasons.map(function (r) { return '<option value="' + esc(r.code) + '">' + esc(r.label) + '</option>'; }).join('');
    $('supIntro').textContent = 'Tell us what went wrong and we will answer here.';
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
      if (e.status === 401) { $('supGate').hidden = false; $('supIntro').textContent = ''; return; }
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
  async function submitOpen(e) {
    e.preventDefault();
    var msg = $('supOpenMsg');
    var btn = e.target.querySelector('button[type=submit]');
    // Belt and braces alongside the disabled button: a photo that is still
    // being read must never be silently missing from what gets sent.
    if (state.pendingAttach.busy > 0) { msg.textContent = 'Still attaching your photos — one moment.'; return; }
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
      $('supOrder').hidden = false;
      $('supOrder').innerHTML = orderCard(state.order);
      state.pending.length = 0;
      $('supPreviews').innerHTML = '';
      renderThread();
      startPolling();
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

  /* ---- boot ---- */
  function init() {
    var params = new URLSearchParams(window.location.search);
    state.orderId = (params.get('order') || '').trim();
    if (!state.orderId) {
      $('supIntro').innerHTML = 'Open a report from one of <a href="account.html">your orders</a>.';
      return;
    }
    if (!window.Auth || !window.Auth.isLoggedIn || !window.Auth.isLoggedIn()) {
      $('supGate').hidden = false; $('supIntro').textContent = ''; return;
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
      var b = e.target.closest && e.target.closest('.sup-att');
      if (b) openAttachment(b.getAttribute('data-file'));
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPolling(); else { load(true); startPolling(); }
    });

    load().then(startPolling);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window, document);
