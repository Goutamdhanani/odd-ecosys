import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-inbox-replies-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const database = await import('../pipeline/database.js');
let db = database.initDb();
db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES(1,'Northstar Studio','person@recipient.test','sent')").run();
db.prepare("INSERT INTO mailboxes(id,email,domain) VALUES(1,'sender@example.test','example.test')").run();
db.prepare("INSERT INTO campaigns(id,name,status) VALUES(1,'Northstar introduction','active')").run();
db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,status,sent_at,subject_snapshot,body_snapshot)
  VALUES(1,1,1,1,'sent',datetime('now','-1 hour'),'Your studio workflow','I noticed the project launch. Would a short conversation help?')`).run();
db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
  VALUES(1,1,'sent',datetime('now','-1 hour'),?)`).run(JSON.stringify({
  from: 'sender@example.test', to: 'person@recipient.test', subject: 'Your studio workflow',
  messageId: '<outbound-inbox-fixture@example.test>', delivery: 'unknown',
}));

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* retain HTTP status for empty responses */ }
  return { status: response.status, body: payload };
}

function reopenDatabase() {
  database.closeDb();
  db = database.initDb();
}

test('inbound replies appear with saved message context, search, and durable read state', async () => {
  const longReply = `I'm interested. The full reply has an important detail: ${'context '.repeat(1200)}`;
  const ingested = await request('/api/replies/ingest', { method: 'POST', body: {
    fromEmail: 'person@recipient.test', toMailboxEmail: 'sender@example.test',
    subject: 'Re: Your studio workflow', body: longReply,
    messageId: '<inbound-inbox-fixture@recipient.test>', inReplyTo: '<outbound-inbox-fixture@example.test>',
  } });
  assert.equal(ingested.status, 200, JSON.stringify(ingested.body));
  const event = db.prepare("SELECT id,meta_json FROM events WHERE event_type='replied' AND lead_id=1").get();
  assert.ok(event);
  assert.equal(JSON.parse(event.meta_json).bodyText, longReply, 'the full accepted inbound text is persisted for review');
  const listed = await request('/api/inbox/replies?unread=true&search=important%20detail');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.pagination.total, 1);
  assert.equal(listed.body.unreadCount, 1);
  assert.equal(listed.body.items[0].id, event.id);
  assert.equal(listed.body.items[0].campaignName, 'Northstar introduction');
  assert.equal(listed.body.items[0].sentiment, 'interested');
  assert.equal(listed.body.items[0].readAt, null);

  const thread = await request(`/api/inbox/replies/${event.id}`);
  assert.equal(thread.status, 200, JSON.stringify(thread.body));
  assert.equal(thread.body.messages.length, 2, 'thread view shows accepted outbound copy and the received reply');
  assert.equal(thread.body.messages[0].type, 'sent');
  assert.equal(thread.body.messages[0].body, 'I noticed the project launch. Would a short conversation help?');
  assert.equal(thread.body.messages[1].type, 'replied');
  assert.equal(thread.body.messages[1].body, longReply);

  const marked = await request(`/api/inbox/replies/${event.id}/read`, { method: 'POST' });
  assert.equal(marked.status, 200);
  assert.ok(marked.body.read_at);
  assert.equal((await request('/api/inbox/replies?unread=true')).body.pagination.total, 0);
  reopenDatabase();
  assert.ok(db.prepare('SELECT read_at FROM reply_inbox_state WHERE event_id=?').get(event.id).read_at,
    'read state survives application database reopen');
  assert.equal((await request(`/api/inbox/replies/${event.id}/unread`, { method: 'POST' })).status, 200);
  assert.equal((await request('/api/inbox/replies?unread=true')).body.pagination.total, 1);
});

test('inbox rejects invalid pagination and missing thread or read-state IDs', async () => {
  assert.equal((await request('/api/inbox/replies?limit=0')).status, 400);
  assert.equal((await request('/api/inbox/replies?unread=maybe')).status, 400);
  assert.equal((await request('/api/inbox/replies/99999')).status, 404);
  assert.equal((await request('/api/inbox/replies/99999/read', { method: 'POST' })).status, 404);
});

test('reply ingestion bounds oversized webhook payloads before persisting them', async () => {
  const before = db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='replied'").get().count;
  const response = await request('/api/replies/ingest', { method: 'POST', body: {
    fromEmail: 'person@recipient.test', toMailboxEmail: 'sender@example.test',
    subject: 'Large message', body: 'x'.repeat(300_000), messageId: '<oversized-inbox-fixture@recipient.test>',
  } });
  assert.equal(response.status, 413);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='replied'").get().count, before,
    'the rejected webhook payload leaves the inbox ledger unchanged');
});

test('unmatched senders remain searchable and their full received message stays readable', async () => {
  const body = 'Out of office. I will return after reviewing this note.';
  const received = await request('/api/replies/ingest', { method: 'POST', body: {
    fromEmail: 'unmatched@sender.test', toMailboxEmail: 'sender@example.test',
    subject: 'Out of office', body, messageId: '<unmatched-inbox-fixture@sender.test>',
  } });
  assert.equal(received.status, 200, JSON.stringify(received.body));
  assert.equal(received.body.leadId, null);
  const listed = await request('/api/inbox/replies?search=unmatched%40sender.test');
  assert.equal(listed.body.pagination.total, 1);
  const opened = await request(`/api/inbox/replies/${listed.body.items[0].id}`);
  assert.equal(opened.body.messages.length, 1);
  assert.equal(opened.body.messages[0].body, body);
});

test('inbox message rendering escapes untrusted subject, sender, and reply content', async () => {
  const { renderInboxMessage } = await import('../js/inbox.js');
  const html = renderInboxMessage({
    type: 'replied', from: '<img src=x onerror=alert(1)>', to: 'sender@example.test',
    recipientAddresses: ['alias@example.test', '<img src=x onerror=alert(2)>'],
    subject: '<script>bad()</script>', body: '<svg onload=alert(1)>', eventAt: new Date().toISOString(),
  });
  assert.doesNotMatch(html, /<script>|<img |<svg /i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&lt;svg onload=/);
  assert.match(html, /alias@example\.test, &lt;img/);
});
