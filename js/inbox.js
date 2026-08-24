/* ============================================================
   EVER NOVA LIFE — the guest conversation page
   Reached only from a link in an email. The token in the URL is
   the whole credential and it opens exactly one thread, so
   there is nothing to sign into and nothing to remember.
   ============================================================ */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var id = params.get('id') || '';
  var token = params.get('t') || '';

  var elThread = document.getElementById('inboxThread');
  var elComposer = document.getElementById('inboxComposer');
  var elBody = document.getElementById('inboxBody');
  var elSend = document.getElementById('inboxSend');
  var elMsg = document.getElementById('inboxMsg');
  var elSub = document.getElementById('inboxSub');
  var elClosed = document.getElementById('inboxClosed');

  // Same one every other page script uses — see js/support.js:15.
  var API = (window.PEPTIDE_API_BASE || '');
  function api(path) { return API + path; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function say(text, bad) {
    elMsg.textContent = text || '';
    elMsg.className = 'form-msg' + (bad ? ' error' : '');
  }

  function render(thread) {
    elSub.textContent = thread.subject + ' — reference ' + thread.id;
    elThread.innerHTML = (thread.messages || []).map(function (m) {
      var mine = m.from === 'customer';
      return '<article class="inbox-msg ' + (mine ? 'is-mine' : 'is-store') + '">' +
        '<header class="inbox-msg-head">' +
          '<span class="inbox-who">' + (mine ? 'You' : 'Ever Nova Life') + '</span>' +
          '<time datetime="' + esc(m.createdAt) + '">' + esc(when(m.createdAt)) + '</time>' +
        '</header>' +
        '<p class="inbox-msg-body">' + esc(m.body).replace(/\n/g, '<br>') + '</p>' +
      '</article>';
    }).join('');

    var closed = thread.status === 'closed';
    elComposer.hidden = closed;
    elClosed.hidden = !closed;
  }

  function loadThread() {
    return fetch(api('/api/inbox/' + encodeURIComponent(id) + '?t=' + encodeURIComponent(token)))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          elSub.textContent = res.data.error || 'That conversation link is not valid.';
          elThread.innerHTML = '';
          elComposer.hidden = true;
          return null;
        }
        render(res.data.thread);
        return res.data.thread;
      })
      .catch(function () {
        elSub.textContent = 'We could not reach the server. Try again in a moment.';
        return null;
      });
  }

  if (!id || !token) {
    elSub.textContent = 'That conversation link is not valid.';
    elComposer.hidden = true;
  } else {
    loadThread();
  }

  elComposer.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = elBody.value.trim();
    if (!body) return;
    elSend.disabled = true;
    say('Sending…');
    fetch(api('/api/inbox/' + encodeURIComponent(id) + '/messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token, body: body })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) { say(res.data.error || 'That did not send.', true); return; }
        elBody.value = '';
        say('Sent.');
        render(res.data.thread);
      })
      .catch(function () { say('We could not reach the server. Try again in a moment.', true); })
      .then(function () { elSend.disabled = false; });
  });
}());
