import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-replies-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
const { initDb, closeDb } = await import('../pipeline/database.js');
const { ingestInboundReply } = await import('../pipeline/reply-tracker.js');
const db = initDb();
const realFetch = globalThis.fetch;

function seed({ sends = 1 } = {}) {
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (1,'Fixture','person@example.test','sent')").run();
  db.prepare("INSERT INTO mailboxes(id,email,domain) VALUES (1,'sender@example.test','example.test')").run();
  db.prepare("INSERT INTO campaigns(id,name) VALUES (1,'Fixture')").run();
  for (let id = 1; id <= sends; id++) {
    db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,status,sent_at)
      VALUES (?,1,1,1,'sent',?)`).run(id, new Date(Date.now() - id * 60_000).toISOString());
    db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
      VALUES (?,1,'sent',datetime('now'),?)`).run(id, JSON.stringify({
        messageId: `<outbound-${id}@example.test>`,
        from: 'sender@example.test',
        to: 'person@example.test',
      }));
  }
}

beforeEach(() => {
  globalThis.fetch = async () => { throw new Error('Ollama fixture unavailable'); };
  db.exec('DELETE FROM events; DELETE FROM sends; DELETE FROM campaigns; DELETE FROM mailboxes; DELETE FROM lead_emails; DELETE FROM leads; DELETE FROM suppression_list;');
});
after(() => {
  globalThis.fetch = realFetch;
  closeDb();
  delete process.env.ODD_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

test('B20: interested reply matches its In-Reply-To message and remains replied, not won', async () => {
  seed({ sends: 2 });
  const result = await ingestInboundReply({
    fromEmail: 'person@example.test',
    toMailboxEmail: 'sender@example.test',
    body: 'I am interested, please send more info.',
    messageId: '<reply-1@example.test>',
    inReplyTo: '<outbound-1@example.test>',
  });

  assert.equal(result.sendId, 1);
  assert.equal(result.sendAttribution, 'in_reply_to');
  assert.equal(result.sentiment, 'interested');
  assert.equal(result.updatedLeadStatus, 'replied');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=1').get().status, 'replied');
  const event = db.prepare("SELECT * FROM events WHERE event_type='replied'").get();
  assert.equal(event.send_id, 1);
  assert.equal(JSON.parse(event.meta_json).sendAttributionConfidence, 1);
});

test('F066 slice: a stored References chain attributes a reply when In-Reply-To points to a prior inbound message', async () => {
  seed({ sends: 2 });
  const result = await ingestInboundReply({
    fromEmail: 'person@example.test',
    toMailboxEmail: 'sender@example.test',
    body: 'Please send the revised details.',
    messageId: '<reply-followup@example.test>',
    inReplyTo: '<earlier-reply@example.test>',
    references: '<outbound-1@example.test> <earlier-reply@example.test> <outbound-2@example.test>',
  });
  assert.equal(result.sendId, 2);
  assert.equal(result.sendAttribution, 'references');
  assert.equal(result.sendAttributionConfidence, 0.9);
  const metadata = JSON.parse(db.prepare("SELECT meta_json FROM events WHERE event_type='replied'").get().meta_json);
  assert.deepEqual(metadata.references, ['outbound-1@example.test', 'earlier-reply@example.test', 'outbound-2@example.test']);
});

test('F066 slice: References matching multiple sends remains explicitly unattributed', async () => {
  seed({ sends: 2 });
  db.prepare("UPDATE events SET meta_json=replace(meta_json,'outbound-2','outbound-1') WHERE send_id=2 AND event_type='sent'").run();
  const result = await ingestInboundReply({
    fromEmail: 'person@example.test',
    toMailboxEmail: 'sender@example.test',
    body: 'Thanks, I will review this.',
    messageId: '<reply-ambiguous-references@example.test>',
    references: '<outbound-1@example.test>',
  });
  assert.equal(result.sendId, null);
  assert.equal(result.sendAttribution, 'ambiguous_references');
  assert.equal(result.sendAttributionConfidence, null);
});

test('B20: missing message reference with multiple recent sends stays unattributed', async () => {
  seed({ sends: 2 });
  const result = await ingestInboundReply({
    fromEmail: 'person@example.test',
    toMailboxEmail: 'sender@example.test',
    body: 'Thanks, I will review this.',
    messageId: '<reply-ambiguous@example.test>',
  });
  assert.equal(result.sendId, null);
  assert.equal(result.sendAttribution, 'ambiguous_recent_sends');
  assert.equal(db.prepare("SELECT send_id FROM events WHERE event_type='replied'").get().send_id, null);
});

test('B20: a different receiving mailbox cannot be attributed to the matching message ID', async () => {
  seed();
  const result = await ingestInboundReply({
    fromEmail: 'person@example.test',
    toMailboxEmail: 'other@example.test',
    body: 'Thanks, I will review this.',
    inReplyTo: '<outbound-1@example.test>',
  });
  assert.equal(result.sendId, null);
  assert.equal(result.sendAttribution, 'unmatched_reference');
});

test('B20: a unique stored alias resolves to its contact for exact message attribution', async () => {
  seed();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status) VALUES (1,'alias@example.test','unknown')").run();
  const result = await ingestInboundReply({
    fromEmail: ' ALIAS@example.test ',
    toMailboxEmail: 'sender@example.test',
    body: 'I am interested, please send more information.',
    messageId: '<alias-reply@example.test>',
    inReplyTo: '<outbound-1@example.test>',
  });
  assert.equal(result.leadId, 1);
  assert.equal(result.sendId, 1);
  assert.equal(result.sendAttribution, 'in_reply_to');
});

test('B20: a reused alias remains unlinked instead of matching an arbitrary contact', async () => {
  seed();
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (2,'Other fixture','other@example.test','sent')").run();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status) VALUES (1,'shared-alias@example.test','unknown')").run();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status) VALUES (2,'shared-alias@example.test','unknown')").run();
  const result = await ingestInboundReply({
    fromEmail: 'shared-alias@example.test',
    toMailboxEmail: 'sender@example.test',
    body: 'Thanks, I will review this.',
    messageId: '<shared-alias-reply@example.test>',
    inReplyTo: '<outbound-1@example.test>',
  });
  assert.equal(result.leadId, null);
  assert.equal(result.sendId, null);
  assert.equal(db.prepare("SELECT lead_id,send_id FROM events WHERE event_type='replied'").get().lead_id, null);
});

test('B20: Ollama failure produces unclassified engagement, never invented interest or a win', async () => {
  seed();
  const result = await ingestInboundReply({
    fromEmail: 'person@example.test',
    toMailboxEmail: 'sender@example.test',
    body: 'Thanks for reaching out. I will think about it.',
    inReplyTo: '<outbound-1@example.test>',
  });
  assert.equal(result.sentiment, 'unclassified');
  assert.equal(result.classification.source, 'unavailable');
  assert.equal(result.classification.confidence, null);
  assert.equal(result.updatedLeadStatus, 'replied');
  assert.notEqual(db.prepare('SELECT status FROM leads WHERE id=1').get().status, 'won');
});

test('B20: repeated inbound Message-ID is idempotent', async () => {
  seed();
  const reply = {
    fromEmail: 'person@example.test',
    toMailboxEmail: 'sender@example.test',
    body: 'I am interested; how much does it cost?',
    messageId: '<reply-once@example.test>',
    inReplyTo: '<outbound-1@example.test>',
  };
  const first = await ingestInboundReply(reply);
  const second = await ingestInboundReply({ ...reply, body: 'unsubscribe' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.sentiment, 'interested');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='replied'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM suppression_list').get().n, 0);
});

test('B20: explicit unsubscribe is persisted and suppresses the contact', async () => {
  seed();
  const result = await ingestInboundReply({
    fromEmail: 'person@example.test',
    toMailboxEmail: 'sender@example.test',
    body: 'Please unsubscribe and remove me.',
    messageId: '<unsubscribe-1@example.test>',
    inReplyTo: '<outbound-1@example.test>',
  });
  assert.equal(result.sentiment, 'unsubscribe_request');
  assert.equal(result.updatedLeadStatus, 'disqualified');
  assert.equal(db.prepare('SELECT reason FROM suppression_list WHERE email=?').get('person@example.test').reason, 'unsubscribe_request');
});
