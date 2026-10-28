import { Auth, Inbox, Sending, fmtNum, relTime } from './api.js';
import { escapeHtml, icon, notify } from './ui.js';

let searchTimer = null;

const inboxControlId = value => {
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
};

const sentimentLabel = value => ({
  interested: 'Interested', not_interested: 'Not interested', out_of_office: 'Out of office',
  wrong_person: 'Wrong person', unsubscribe_request: 'Unsubscribe', unclassified: 'Needs review',
  classification_pending: 'Classifying',
}[value] || value || 'Unclassified');

export function renderInboxMessage(message) {
  const outgoing = message.type === 'sent';
  const person = outgoing ? (message.from || 'Your mailbox') : (message.from || 'Unknown sender');
  const recipients = Array.isArray(message.recipientAddresses) && message.recipientAddresses.length
    ? message.recipientAddresses.join(', ')
    : (message.to || 'your mailbox');
  return `<article class="inbox-message ${outgoing ? 'is-outgoing' : 'is-incoming'}">
    <div class="inbox-message-head"><div><strong>${outgoing ? 'Sent' : 'Received'}</strong><span>${escapeHtml(person)}</span></div><time>${escapeHtml(relTime(message.eventAt))}</time></div>
    <div class="inbox-message-addresses">To ${escapeHtml(recipients)}</div>
    <h3>${escapeHtml(message.subject || '(no subject)')}</h3>
    <div class="inbox-message-body">${escapeHtml(message.body || '(Message body was not captured for this older reply.)')}</div>
  </article>`;
}

export async function renderInbox(container) {
  let imapMailboxes = [];
  try {
    const mailboxes = await Sending.mailboxes();
    imapMailboxes = (Array.isArray(mailboxes) ? mailboxes : []).filter(mailbox => mailbox.imap_configured);
  } catch { /* Reply history remains useful while mailbox settings are unavailable. */ }
  let imapSyncSettings = { enabled: false, intervalMinutes: 10, mailboxes: [] };
  let canManageImapSync = false;
  try {
    const [settings, auth] = await Promise.all([Sending.imapSync(), Auth.status()]);
    imapSyncSettings = settings;
    canManageImapSync = ['owner', 'admin'].includes(auth.user?.role);
  } catch { /* Inbox remains readable if sync-control status is unavailable. */ }
  let state = { search: '', unreadOnly: false, items: [], total: 0, unreadCount: 0, hasMore: false, selectedId: null, thread: null, loading: false, error: null };
  container.innerHTML = `<section class="inbox-view">
    <header class="inbox-page-head"><div><span class="eyebrow">CONVERSATIONS</span><h1 class="section-title">Inbox, from the signal you received.</h1><p class="section-sub">Webhook replies and messages you manually retrieve from a configured mailbox.</p></div><div class="inbox-actions"><label><span class="sr-only">Mailbox to synchronize</span><select class="filter-select" data-inbox-mailbox ${imapMailboxes.length ? '' : 'disabled'}><option value="">${imapMailboxes.length ? 'Choose an IMAP mailbox' : 'No IMAP mailbox configured'}</option>${imapMailboxes.map(mailbox => {
      const id = inboxControlId(mailbox.id);
      return id === null ? '' : `<option value="${id}">${escapeHtml(mailbox.email)}</option>`;
    }).join('')}</select></label><button type="button" class="btn btn-primary btn-sm" data-inbox-sync ${imapMailboxes.length ? '' : 'disabled'}>Sync Inbox</button><button type="button" class="btn btn-ghost btn-sm" data-inbox-backfill ${imapMailboxes.length ? '' : 'disabled'}>Import older</button><button type="button" class="btn btn-ghost btn-sm" data-inbox-refresh>${icon('refresh', 15)} Refresh</button></div></header>
    <aside class="inbox-source-note"><span>${icon('activity', 16)}</span><p><strong>Manual IMAP sync:</strong> uses verified TLS and a read-only INBOX pass. The first sync imports at most 25 recent messages; later syncs use a saved UID cursor. Use <em>Import older</em> to retrieve previous messages in bounded batches. Provider read flags stay unchanged. Automatic sync is off until a workspace owner or admin enables it below. Configure a mailbox under <a href="#mailboxes">Mailboxes</a>.</p></aside>
    <section class="inbox-auto-sync" aria-labelledby="inbox-auto-sync-heading">
      <div><span class="eyebrow">INCOMING MAIL</span><h2 id="inbox-auto-sync-heading">Automatic inbox sync</h2><p>Sync configured mailboxes sequentially every 5–60 minutes. It uses the same verified TLS and read-only UID cursor as manual sync. Failures back off automatically.</p>
        <p class="inbox-auto-sync-status" data-inbox-auto-status role="status" aria-live="polite"></p></div>
      ${canManageImapSync ? `<form data-inbox-auto-form><label class="inbox-auto-enable"><input type="checkbox" name="enabled" ${imapSyncSettings.enabled ? 'checked' : ''}> Enable automatic sync</label><label>Interval<select name="intervalMinutes">${[5, 10, 15, 30, 60].map(value => `<option value="${value}" ${Number(imapSyncSettings.intervalMinutes) === value ? 'selected' : ''}>Every ${value} minutes</option>`).join('')}</select></label><button class="btn btn-ghost btn-sm" type="submit">Save sync settings</button><p class="inbox-auto-form-error" data-inbox-auto-error role="alert"></p></form>` : '<p class="inbox-auto-sync-readonly">Only workspace owners and admins can change automatic sync settings.</p>'}
    </section>
    <p class="inbox-sync-status" data-inbox-sync-status role="status" aria-live="polite"></p>
    <div class="inbox-workspace">
      <section class="glass-panel inbox-list-panel" aria-label="Received replies">
        <header class="inbox-list-head"><div><h2>Replies</h2><span data-inbox-count>Loading…</span></div><span class="inbox-unread-count" data-inbox-unread>— unread</span></header>
        <div class="inbox-tools"><label><span class="sr-only">Search replies</span><input class="filter-input" type="search" data-inbox-search placeholder="Search sender, subject, message…" value=""></label><button class="btn btn-ghost btn-sm" data-inbox-unread-toggle type="button" aria-pressed="false">Unread only</button></div>
        <div class="inbox-reply-list" data-inbox-list aria-live="polite"><div class="loading-state"><div class="spinner"></div><span>Loading replies…</span></div></div>
        <div class="inbox-list-footer" data-inbox-footer></div>
      </section>
      <section class="glass-panel inbox-thread-panel" data-inbox-thread aria-label="Selected reply thread"><div class="inbox-thread-empty"><span>${icon('mail', 24)}</span><h2>Choose a reply</h2><p>Open a conversation to review the received message and matching accepted-send history.</p></div></section>
    </div>
  </section>`;

  const listNode = container.querySelector('[data-inbox-list]');
  const footerNode = container.querySelector('[data-inbox-footer]');
  const threadNode = container.querySelector('[data-inbox-thread]');
  const syncButton = container.querySelector('[data-inbox-sync]');
  const backfillButton = container.querySelector('[data-inbox-backfill]');
  const syncStatus = container.querySelector('[data-inbox-sync-status]');
  const autoSyncStatus = container.querySelector('[data-inbox-auto-status]');
  const formatAutoSyncStatus = settings => {
    const mailboxes = Array.isArray(settings.mailboxes) ? settings.mailboxes : [];
    if (!settings.enabled) return 'Automatic sync is off. Manual inbox sync remains available.';
    const state = settings.running ? 'A sync cycle is running.' : `Syncing every ${settings.intervalMinutes} minutes.`;
    const recent = mailboxes.map(mailbox => mailbox.lastError
      ? `${mailbox.email}: ${mailbox.lastError}`
      : mailbox.lastSuccessAt ? `${mailbox.email}: last synced ${relTime(mailbox.lastSuccessAt)}` : `${mailbox.email}: waiting for first sync`);
    return `${state}${recent.length ? ` ${recent.join(' · ')}` : ' No IMAP mailboxes are configured.'}`;
  };
  autoSyncStatus.textContent = formatAutoSyncStatus(imapSyncSettings);
  const drawList = () => {
    container.querySelector('[data-inbox-count]').textContent = `${fmtNum(state.total)} ${state.total === 1 ? 'reply' : 'replies'}`;
    container.querySelector('[data-inbox-unread]').textContent = `${fmtNum(state.unreadCount)} unread`;
    container.querySelector('[data-inbox-unread-toggle]').setAttribute('aria-pressed', String(state.unreadOnly));
    if (state.error) {
      listNode.innerHTML = `<div class="inbox-empty"><h3>Replies could not load</h3><p>${escapeHtml(state.error)}</p><button type="button" class="btn btn-ghost btn-sm" data-inbox-retry>Try again</button></div>`;
      listNode.querySelector('[data-inbox-retry]')?.addEventListener('click', loadReplies);
      footerNode.innerHTML = '';
      return;
    }
    if (!state.items.length) {
      listNode.innerHTML = `<div class="inbox-empty"><span>${icon('mail', 22)}</span><h3>${state.unreadOnly ? 'No unread replies' : 'No replies received yet'}</h3><p>${state.search ? 'Try a different search.' : 'Webhook-ingested replies appear here with the contact and campaign evidence the system actually saved.'}</p></div>`;
    } else {
      listNode.innerHTML = state.items.map(item => {
        const id = inboxControlId(item.id);
        const selectedId = inboxControlId(state.selectedId);
        return `<button type="button" class="inbox-reply-row ${item.readAt ? '' : 'is-unread'} ${id !== null && selectedId === id ? 'is-selected' : ''}" data-inbox-reply="${id ?? ''}" ${id === null ? 'aria-disabled="true"' : ''}>
        <span class="inbox-reply-row-top"><strong>${escapeHtml(item.businessName)}</strong><time>${escapeHtml(relTime(item.eventAt))}</time></span>
        <span class="inbox-reply-row-email">${escapeHtml(item.fromEmail || item.contactEmail || 'Unknown sender')}</span>
        <span class="inbox-reply-row-subject">${escapeHtml(item.subject)}</span>
        <span class="inbox-reply-row-snippet">${escapeHtml(item.snippet || 'No message preview captured.')}</span>
        <span class="inbox-reply-row-bottom"><span class="inbox-sentiment is-${escapeHtml(item.sentiment)}">${escapeHtml(sentimentLabel(item.sentiment))}</span><span>${escapeHtml(item.campaignName || 'No campaign attribution')}</span></span>
      </button>`;
      }).join('');
      listNode.querySelectorAll('[data-inbox-reply]').forEach(button => button.addEventListener('click', () => {
        const id = inboxControlId(button.dataset.inboxReply);
        if (id !== null) openReply(id);
      }));
    }
    footerNode.innerHTML = state.hasMore ? `<button type="button" class="btn btn-ghost btn-sm" data-inbox-more>Load older replies</button>` : '';
    footerNode.querySelector('[data-inbox-more]')?.addEventListener('click', () => loadReplies({ append: true }));
  };
  const loadReplies = async ({ append = false } = {}) => {
    state.error = null;
    if (!append) listNode.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading replies…</span></div>`;
    try {
      const result = await Inbox.replies({ search: state.search, unread: state.unreadOnly, limit: 50, offset: append ? state.items.length : 0 });
      state.items = append ? [...state.items, ...(result.items || [])] : (result.items || []);
      state.total = result.pagination?.total || 0;
      state.unreadCount = result.unreadCount || 0;
      state.hasMore = result.pagination?.hasMore === true;
      drawList();
    } catch (error) {
      state.error = error.message;
      drawList();
    }
  };
  const drawThread = () => {
    const thread = state.thread;
    if (!thread) {
      threadNode.innerHTML = `<div class="inbox-thread-empty"><span>${icon('mail', 24)}</span><h2>Choose a reply</h2><p>Open a conversation to review the received message and matching accepted-send history.</p></div>`;
      return;
    }
    const reply = thread.reply;
    threadNode.innerHTML = `<header class="inbox-thread-head"><div><span class="eyebrow">${escapeHtml(reply.campaignName || 'INBOUND REPLY')}</span><h2>${escapeHtml(reply.businessName)}</h2><p>${escapeHtml(reply.contactEmail || reply.fromEmail || 'Unknown contact')} · ${escapeHtml(reply.receivedTo || reply.toMailboxEmail || 'Unknown mailbox')}</p></div><button type="button" class="btn btn-ghost btn-sm" data-inbox-read-toggle>${reply.readAt ? 'Mark unread' : 'Mark read'}</button></header>
      <div class="inbox-thread-meta"><span class="inbox-sentiment is-${escapeHtml(reply.sentiment)}">${escapeHtml(sentimentLabel(reply.sentiment))}</span><span>${escapeHtml(reply.sendAttribution === 'unmatched' ? 'No sent message matched' : `Matched by ${reply.sendAttribution.replaceAll('_', ' ')}`)}</span><time>${escapeHtml(relTime(reply.eventAt))}</time></div>
      <div class="inbox-thread-messages">${thread.messages.length ? thread.messages.map(renderInboxMessage).join('') : renderInboxMessage({ type: 'replied', from: reply.fromEmail, to: reply.receivedTo || reply.toMailboxEmail, recipientAddresses: reply.recipientAddresses, subject: reply.subject, body: reply.snippet, eventAt: reply.eventAt })}</div>`;
    threadNode.querySelector('[data-inbox-read-toggle]')?.addEventListener('click', async () => {
      try {
        if (reply.readAt) await Inbox.markUnread(reply.id); else await Inbox.markRead(reply.id);
        await openReply(reply.id, { markRead: false });
        await loadReplies();
      } catch (error) { notify(error.message, 'error'); }
    });
  };
  const openReply = async (id, { markRead = true } = {}) => {
    state.selectedId = id;
    state.thread = null;
    threadNode.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading conversation…</span></div>`;
    drawList();
    try {
      if (markRead) await Inbox.markRead(id);
      state.thread = await Inbox.thread(id);
      drawThread();
      if (markRead) await loadReplies();
    } catch (error) {
      threadNode.innerHTML = `<div class="inbox-empty"><h3>Conversation could not load</h3><p>${escapeHtml(error.message)}</p></div>`;
    }
  };

  container.querySelector('[data-inbox-refresh]').addEventListener('click', loadReplies);
  const syncMailbox = async ({ backfill = false } = {}) => {
    const mailboxId = inboxControlId(container.querySelector('[data-inbox-mailbox]').value);
    if (mailboxId === null) {
      syncStatus.textContent = 'Choose a configured IMAP mailbox first.';
      return;
    }
    syncButton.disabled = true;
    backfillButton.disabled = true;
    syncButton.textContent = backfill ? 'Sync Inbox' : 'Reading Inbox…';
    backfillButton.textContent = backfill ? 'Reading older…' : 'Import older';
    syncStatus.textContent = 'Connecting with verified TLS and reading the mailbox without changing provider read flags…';
    try {
      const result = await Sending.syncImap(mailboxId, { limit: 25, backfill });
      const importedText = `Fetched ${result.fetched}; imported ${result.imported} new; ${result.duplicates} already present; ${result.skipped} skipped.`;
      syncStatus.textContent = backfill
        ? `${importedText} ${result.hasOlderMessages ? `Older history remains before UID ${result.olderMessagesBeforeUid}.` : 'No older history remains.'} Provider read flags were left unchanged.`
        : `${importedText} Cursor is at UID ${result.cursorUid}. ${result.initialBackfillTruncated ? 'The first sync was capped at 25 recent messages; use Import older to retrieve earlier messages. ' : ''}Provider read flags were left unchanged.`;
      await loadReplies();
    } catch (error) {
      syncStatus.textContent = error.message || 'Inbox sync failed.';
    } finally {
      syncButton.disabled = false;
      backfillButton.disabled = false;
      syncButton.textContent = 'Sync Inbox';
      backfillButton.textContent = 'Import older';
    }
  };
  syncButton.addEventListener('click', () => syncMailbox());
  backfillButton.addEventListener('click', () => syncMailbox({ backfill: true }));
  container.querySelector('[data-inbox-auto-form]')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const errorNode = form.querySelector('[data-inbox-auto-error]');
    errorNode.textContent = '';
    button.disabled = true;
    try {
      imapSyncSettings = await Sending.setImapSync({
        enabled: form.elements.enabled.checked,
        intervalMinutes: Number(form.elements.intervalMinutes.value),
      });
      autoSyncStatus.textContent = formatAutoSyncStatus(imapSyncSettings);
      notify(imapSyncSettings.enabled ? 'Automatic inbox sync enabled.' : 'Automatic inbox sync paused.', 'success');
    } catch (error) {
      errorNode.textContent = error.message || 'Sync settings could not be saved.';
    } finally {
      button.disabled = false;
    }
  });
  container.querySelector('[data-inbox-unread-toggle]').addEventListener('click', async () => {
    state.unreadOnly = !state.unreadOnly;
    await loadReplies();
  });
  container.querySelector('[data-inbox-search]').addEventListener('input', event => {
    clearTimeout(searchTimer);
    state.search = event.currentTarget.value.trim();
    searchTimer = setTimeout(() => loadReplies(), 180);
  });
  await loadReplies();
}
