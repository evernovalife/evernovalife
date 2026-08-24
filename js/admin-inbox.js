/* ============================================================
   EVER NOVA LIFE — admin: the inbox
   Where a chat escalation lands when the person asking has no
   account and no order — mostly the chat bubble handing a
   question to a person. Same split as the dispute view
   (js/admin-disputes.js): a queue on the left, one thread on the
   right, a composer pinned under it — with fewer states, since a
   thread here only ever moves through waiting-on-us, waiting-on-
   them, closed.

   It lives in its own file for the same reason admin-disputes.js
   does: admin-console.js is already long, and a message stream
   with a composer is a screen, not a section.

   Talks to /api/admin/inbox through the console's state glue.
   Rendered wholesale on every state change, like every other view
   here — so no listeners are wired in this file; the console's
   delegated handler calls back in. `handlers` is accepted to match
   the shape admin-disputes.js's render(state, body, handlers) call
   site uses, but — same as there — the actual wiring is by class
   name in the console's delegated click listener, not through this
   argument.
   ============================================================ */
(function (window, document) {
  'use strict';
  var A = window.Admin;

  var STATUS_LABEL = {
    awaiting_us: 'Waiting on us',
    awaiting_them: 'Waiting on them',
    closed: 'Closed'
  };

  /* The dispute queue's chip colors already say exactly what these three
     states mean — gold for "ours to answer", violet for "sent, waiting on
     them", green for "done" — so this borrows those classes instead of
     asking for three new color rules that would only repeat them. */
  var STATUS_CHIP_CLASS = {
    awaiting_us: 'dsp-awaiting_us',
    awaiting_them: 'dsp-awaiting_customer',
    closed: 'dsp-resolved'
  };

  function who(t) {
    return t.email + (t.name ? ' — ' + t.name : '');
  }

  function queueRow(t, activeId) {
    return '<button type="button" class="dsp-row' + (t.id === activeId ? ' active' : '') +
      (t.unreadForAdmin ? ' unread' : '') + '" data-ibx-open="' + A.esc(t.id) + '">' +
      '<div class="dsp-row-top"><strong>' + A.esc(t.subject) + '</strong>' +
        '<span class="dsp-when">' + A.esc(A.ago(t.lastAt)) + '</span></div>' +
      '<div class="dsp-row-who">' + A.esc(who(t)) + '</div>' +
      '<span class="dsp-chip ' + (STATUS_CHIP_CLASS[t.status] || '') + '">' +
        A.esc(STATUS_LABEL[t.status] || t.status) + '</span>' +
      '</button>';
  }

  /* The chat that preceded the handoff — text an LLM relayed from an
     anonymous visitor, so it is escaped exactly like everything else here.
     Collapsed by default: it is context for the reply, not the reply. */
  function transcriptHtml(lines) {
    if (!lines || !lines.length) return '';
    return '<details class="dsp-order">' +
      '<summary>Chat before the handoff (' + lines.length + ' line' + (lines.length === 1 ? '' : 's') + ')</summary>' +
      lines.map(function (line) {
        return '<p class="muted" style="margin:.35rem 0 0">' +
          '<strong>' + (line.role === 'agent' ? 'Assistant' : 'Visitor') + ':</strong> ' +
          A.esc(line.text) + '</p>';
      }).join('') +
      '</details>';
  }

  function bubble(m) {
    var side = m.from === 'store' ? 'ours' : 'theirs';
    return '<div class="dsp-group ' + side + '">' +
      '<div class="dsp-avatar" aria-hidden="true">' + (m.from === 'store' ? 'E' : 'V') + '</div>' +
      '<div class="dsp-group-body">' +
        '<div class="dsp-msg-head">' + (m.from === 'store' ? 'Us' : 'Them') + '</div>' +
        '<div class="dsp-bubble"><div class="dsp-msg-body">' + A.esc(m.body).replace(/\n/g, '<br>') + '</div></div>' +
        '<div class="dsp-when">' + A.esc(A.date(m.createdAt, true)) + '</div>' +
      '</div>' +
    '</div>';
  }

  function streamHtml(messages) {
    return '<div class="dsp-stream" role="log" aria-live="polite" aria-relevant="additions">' +
      (messages || []).map(bubble).join('') +
      '</div>';
  }

  function closedNote(t) {
    return '<div class="dsp-resolved"><div>Closed ' + A.esc(A.date(t.closedAt, true)) + '.' +
      ' They were told to email support to reopen it.</div></div>';
  }

  function composer(t) {
    return '<div class="dsp-composer">' +
      '<textarea id="ibxReply" rows="3" maxlength="4000" placeholder="Write a reply…"></textarea>' +
      '<button type="button" class="btn btn-primary btn-sm act-ibx-reply" data-id="' + A.esc(t.id) + '">Send</button>' +
      '<button type="button" class="btn btn-ghost btn-sm act-ibx-close" data-id="' + A.esc(t.id) + '">Close</button>' +
      '</div>';
  }

  function threadPane(state) {
    var t = state.inboxThread;
    if (!state.inboxId) {
      return '<div class="dsp-pane empty">' + A.empty('No conversation open', 'Pick one from the queue on the left.') + '</div>';
    }
    if (!t) return '<div class="dsp-pane">' + A.skeleton(4) + '</div>';

    return '<div class="dsp-pane">' +
      '<div class="dsp-order">' +
        '<div class="dsp-order-head"><strong>' + A.esc(t.subject) + '</strong>' +
          '<span class="muted">' + A.esc(who(t)) + '</span></div>' +
      '</div>' +
      transcriptHtml(t.transcript) +
      streamHtml(t.messages) +
      (t.status === 'closed' ? closedNote(t) : composer(t)) +
      '</div>';
  }

  function render(state, body) {
    var list = state.inbox;
    if (!list) { body.innerHTML = A.skeleton(6); return; }
    if (!list.length) {
      body.innerHTML = A.empty('Nothing waiting', 'Questions escalated from the chat land here.');
      return;
    }
    body.innerHTML =
      '<div class="dsp-wrap">' +
        '<div class="dsp-queue">' +
          list.map(function (t) { return queueRow(t, state.inboxId); }).join('') +
        '</div>' +
        threadPane(state) +
      '</div>';
  }

  window.AdminInbox = { render: render };
})(window, document);
