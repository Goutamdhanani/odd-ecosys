import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMailboxCard } from '../js/mailboxes.js';

function mailbox(overrides = {}) {
  return {
    id: 7,
    email: 'sender@example.test',
    domain: 'example.test',
    warmup_status: 'warming',
    health_score: 84,
    daily_limit: 40,
    today_sent: 0,
    today_reserved: 0,
    imap_configured: true,
    imap_last_sync_attempt_at: '2026-10-10T04:00:00.000Z',
    imap_last_sync_success_at: '2026-10-10T04:00:00.000Z',
    imap_last_sync_error: null,
    imap_last_sync_fetched: 6,
    imap_last_sync_imported: 3,
    imap_last_sync_duplicates: 1,
    imap_last_sync_skipped: 2,
    imap_last_sync_cursor_uid: 19,
    ...overrides,
  };
}

test('mailbox card shows persisted inbound sync counts and opens the received Inbox', () => {
  const html = renderMailboxCard(mailbox());
  assert.match(html, /Last successful sync/);
  assert.match(html, /3 new/);
  assert.match(html, /1 already recorded/);
  assert.match(html, /2 skipped/);
  assert.match(html, /href="#inbox"[^>]*>View Inbox/);
});

test('mailbox card explains missing IMAP setup and safely renders sync failures', () => {
  const unconfigured = renderMailboxCard(mailbox({ imap_configured: false, imap_last_sync_success_at: null }));
  assert.match(unconfigured, /IMAP is not configured/);
  assert.match(unconfigured, /href="#inbox"/);

  const failed = renderMailboxCard(mailbox({
    imap_last_sync_success_at: null,
    imap_last_sync_error: '<img src=x onerror=alert(1)>',
  }));
  assert.match(failed, /Last sync attempt failed/);
  assert.doesNotMatch(failed, /<img src=x/);
  assert.match(failed, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
