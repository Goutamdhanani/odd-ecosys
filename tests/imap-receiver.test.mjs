import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import tls from 'node:tls';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ImapFlow } from 'imapflow';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-imap-receiver-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = '11'.repeat(32);

const database = await import('../pipeline/database.js');
const { decryptCredential } = await import('../pipeline/credential-vault.js');
let db = database.initDb();
const receivedMessage = Buffer.from([
  'From: "Taylor" <person@recipient.test>',
  'To: sender-alias@example.test, ops@example.test',
  'Subject: Re: Pricing question',
  'Date: Fri, 09 Oct 2026 10:20:00 +0000',
  'Message-ID: <reply-over-imap@recipient.test>',
  'In-Reply-To: <outbound-imap-fixture@example.test>',
  'References: <root-message@example.test> <outbound-imap-fixture@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="fixture-boundary"',
  '',
  '--fixture-boundary',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'I am interested. Please send the pricing details.',
  '--fixture-boundary',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>I am interested. Please send the pricing details.</p>',
  '--fixture-boundary--',
  '',
].join('\r\n'));

db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES(1,'Northstar Studio','person@recipient.test','sent')").run();
db.prepare("INSERT INTO mailboxes(id,email,domain) VALUES(1,'sender@example.test','example.test')").run();
db.prepare("INSERT INTO campaigns(id,name,status) VALUES(1,'IMAP fixture campaign','active')").run();
db.prepare("INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,status,sent_at,subject_snapshot,body_snapshot) VALUES(1,1,1,1,'sent','2026-10-09 09:00:00','Pricing question','A short introduction')").run();
db.prepare("INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json) VALUES(1,1,'sent','2026-10-09 09:00:00',?)")
  .run(JSON.stringify({
    from: 'sender@example.test', to: 'person@recipient.test', subject: 'Pricing question',
    messageId: '<outbound-imap-fixture@example.test>', delivery: 'accepted',
  }));

const commands = [];
const acceptedPasswords = [];
let uidValidity = 777;
const mailboxMessages = new Map([[1, receivedMessage]]);
const testCa = readFileSync(new URL('./support/imap-test-cert.pem', import.meta.url));
const server = tls.createServer({
  key: readFileSync(new URL('./support/imap-test-key.pem', import.meta.url)),
  cert: testCa,
}, socket => {
  socket.write('* OK disposable IMAP fixture ready\r\n');
  let buffered = Buffer.alloc(0);
  let authTag = null;
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (true) {
      const end = buffered.indexOf('\r\n');
      if (end < 0) break;
      const line = buffered.subarray(0, end).toString('utf8');
      buffered = buffered.subarray(end + 2);
      if (authTag) {
        const [, username, password] = Buffer.from(line, 'base64').toString('utf8').split('\0');
        acceptedPasswords.push({ username, password });
        socket.write(authTag + ' OK Authentication successful\r\n');
        authTag = null;
        continue;
      }
      commands.push(line);
      const match = line.match(/^(\S+)\s+(.*)$/);
      if (!match) continue;
      const [, tag, command] = match;
      if (/^CAPABILITY$/i.test(command)) {
        socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN UIDPLUS\r\n' + tag + ' OK CAPABILITY completed\r\n');
      } else if (/^LIST\s+/i.test(command)) {
        socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n' + tag + ' OK LIST completed\r\n');
      } else if (/^AUTHENTICATE PLAIN$/i.test(command)) {
        authTag = tag;
        socket.write('+ continue\r\n');
      } else if (/^(EXAMINE|SELECT)\s+"?INBOX"?$/i.test(command)) {
        const highestUid = Math.max(0, ...mailboxMessages.keys());
        socket.write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* ' + mailboxMessages.size
          + ' EXISTS\r\n* OK [UIDVALIDITY ' + uidValidity + ']\r\n* OK [UIDNEXT ' + (highestUid + 1)
          + ']\r\n' + tag + ' OK [READ-ONLY] INBOX selected\r\n');
      } else if (/^(UID\s+)?FETCH\s+/i.test(command)) {
        const fetchMatch = command.match(/^(?:UID\s+)?FETCH\s+(\d+):(\d+)/i);
        const startUid = fetchMatch ? Number(fetchMatch[1]) : 1;
        const endUid = fetchMatch ? Number(fetchMatch[2]) : Number.MAX_SAFE_INTEGER;
        const matching = [...mailboxMessages.entries()].filter(([uid]) => uid >= startUid && uid <= endUid).sort((a, b) => a[0] - b[0]);
        for (const [index, [uid, source]] of matching.entries()) {
          const prefix = Buffer.from('* ' + (index + 1) + ' FETCH (UID ' + uid + ' FLAGS () BODY[] {' + source.length + '}\r\n');
          const suffix = Buffer.from(')\r\n');
          socket.write(Buffer.concat([prefix, source, suffix]));
        }
        socket.write(tag + ' OK FETCH completed\r\n');
      } else if (/^ENABLE\b/i.test(command) || /^NOOP$/i.test(command)) {
        socket.write(tag + ' OK completed\r\n');
      } else if (/^LOGOUT$/i.test(command)) {
        socket.write('* BYE logging out\r\n' + tag + ' OK LOGOUT completed\r\n');
      } else {
        socket.write(tag + ' BAD unsupported fixture command\r\n');
      }
    }
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const { createImapReceiver } = await import('../pipeline/imap-receiver.js');
const { createImapSyncScheduler } = await import('../pipeline/imap-sync-scheduler.js');
const replyTracker = await import('../pipeline/reply-tracker.js');
const trustedClientFactory = options => {
  const client = new ImapFlow(Object.assign({}, options, {
    tls: Object.assign({}, options.tls, { ca: testCa }),
  }));
  return client;
};
let receiver = createImapReceiver({ db, ingestReply: replyTracker.ingestInboundReply, createClient: trustedClientFactory });
const { server: httpServer, setImapReceiverForTests } = await import('../server.js');
await setImapReceiverForTests(receiver);
if (!httpServer.listening) await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.once('listening', resolve); });
const base = 'http://127.0.0.1:' + httpServer.address().port;

after(async () => {
  await new Promise(resolve => httpServer.close(resolve));
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, options = {}) {
  const response = await fetch(base + route, Object.assign({
    method: options.method || 'GET',
    ...(options.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
  }));
  let payload = {};
  try { payload = await response.json(); } catch { /* preserve status for non-JSON responses */ }
  return { status: response.status, body: payload };
}

test('mailbox API encrypts IMAP credentials and excludes ciphertext from fleet responses', async () => {
  const port = server.address().port;
  db.prepare("INSERT INTO mailboxes(id,email,domain) VALUES(2,'other@example.test','example.test')").run();
  const updated = await request('/api/sending/mailboxes/1', {
    method: 'PATCH',
    body: { imap_host: 'localhost', imap_port: port, imap_user: 'fixture-user', imap_pass: 'private-fixture-password', imap_secure: true, imap_aliases: ['sender-alias@example.test'] },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const collision = await request('/api/sending/mailboxes/2', {
    method: 'PATCH', body: { imap_aliases: ['sender-alias@example.test'] },
  });
  assert.equal(collision.status, 409, 'an alias cannot route to two mailbox identities');
  const malformed = await request('/api/sending/mailboxes/2', {
    method: 'PATCH', body: { imap_aliases: ['not-an-email'] },
  });
  assert.equal(malformed.status, 400);
  const stored = db.prepare('SELECT imap_pass FROM mailboxes WHERE id=1').get().imap_pass;
  assert.match(stored, /^oddc1:/);
  assert.equal(decryptCredential(stored), 'private-fixture-password');
  database.closeDb();
  db = database.initDb();
  receiver = createImapReceiver({ db, ingestReply: replyTracker.ingestInboundReply, createClient: trustedClientFactory });
  await setImapReceiverForTests(receiver);
  assert.equal(decryptCredential(db.prepare('SELECT imap_pass FROM mailboxes WHERE id=1').get().imap_pass), 'private-fixture-password',
    'encrypted IMAP credentials survive a database reopen');
  const fleet = await request('/api/sending/mailboxes');
  assert.equal(fleet.status, 200);
  assert.equal(fleet.body[0].imap_configured, true);
  const configuredMailbox = fleet.body.find(mailbox => mailbox.id === 1);
  assert.deepEqual(configuredMailbox.imap_aliases, ['sender-alias@example.test']);
  assert.equal(Object.hasOwn(configuredMailbox, 'imap_pass'), false);
  assert.doesNotMatch(JSON.stringify(fleet.body), /private-fixture-password|oddc1:/);
});

test('verified TLS test and manual intake persist a multipart reply without changing remote unread state', async () => {
  const tested = await receiver.testMailbox(1);
  assert.deepEqual(tested, {
    ok: true, mailboxId: 1, email: 'sender@example.test', folder: 'INBOX',
    messageCount: 1, tlsVerified: true, tlsMode: 'implicit_tls',
  });
  assert.deepEqual(acceptedPasswords.at(-1), { username: 'fixture-user', password: 'private-fixture-password' });

  const syncResponse = await request('/api/sending/mailboxes/1/sync-imap', {
    method: 'POST', body: { limit: 10 },
  });
  assert.equal(syncResponse.status, 200, JSON.stringify(syncResponse.body));
  const synced = syncResponse.body;
  assert.equal(synced.fetched, 1);
  assert.equal(synced.imported, 1);
  assert.equal(synced.duplicates, 0);
  assert.equal(synced.remoteReadStateChanged, false);
  assert.equal(synced.cursorUid, 1);
  const mailboxFleetAfterReceive = await request('/api/sending/mailboxes');
  assert.equal(mailboxFleetAfterReceive.status, 200);
  const receivedMailbox = mailboxFleetAfterReceive.body.find(mailbox => mailbox.id === 1);
  assert.equal(receivedMailbox.imap_last_sync_imported, 1);
  assert.equal(receivedMailbox.imap_last_sync_fetched, 1);
  assert.equal(receivedMailbox.imap_last_sync_cursor_uid, 1);
  assert.equal(receivedMailbox.imap_last_sync_success_at !== null, true);
  assert.doesNotMatch(JSON.stringify(mailboxFleetAfterReceive.body), /private-fixture-password|oddc1:/);
  const schedulerStatusAfterReceive = await request('/api/sending/imap-sync');
  assert.equal(schedulerStatusAfterReceive.status, 200);
  assert.deepEqual(schedulerStatusAfterReceive.body.mailboxes.find(mailbox => mailbox.mailboxId === 1).lastResult, {
    fetched: 1, imported: 1, duplicates: 0, skipped: 0, cursorUid: 1,
  });
  assert.equal(db.prepare('SELECT imap_uid_validity, imap_last_uid FROM mailboxes WHERE id=1').get().imap_uid_validity, '777');
  assert.equal(db.prepare('SELECT imap_last_uid FROM mailboxes WHERE id=1').get().imap_last_uid, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='replied'").get().n, 1);
  const persistedReferences = JSON.parse(db.prepare("SELECT meta_json FROM events WHERE event_type='replied'").get().meta_json).references;
  assert.deepEqual(persistedReferences, ['root-message@example.test', 'outbound-imap-fixture@example.test']);

  const inbox = await request('/api/inbox/replies?search=pricing');
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  assert.equal(inbox.body.pagination.total, 1);
  assert.equal(inbox.body.items[0].fromEmail, 'person@recipient.test');
  assert.equal(inbox.body.items[0].toMailboxEmail, 'sender@example.test');
  assert.equal(inbox.body.items[0].receivedTo, 'sender-alias@example.test');
  assert.deepEqual(inbox.body.items[0].recipientAddresses, ['sender-alias@example.test', 'ops@example.test']);
  assert.equal(inbox.body.items[0].sendAttribution, 'in_reply_to');
  assert.equal(inbox.body.items[0].sentiment, 'interested');
  assert.equal(inbox.body.items[0].readAt, null);
  const thread = await request('/api/inbox/replies/' + inbox.body.items[0].id);
  assert.match(thread.body.messages.at(-1).body, /Please send the pricing details/);
  assert.equal(thread.body.messages.at(-1).to, 'sender-alias@example.test');
  assert.deepEqual(thread.body.messages.at(-1).recipientAddresses, ['sender-alias@example.test', 'ops@example.test']);
  assert.match(thread.body.messages.find(message => message.type === 'replied').eventAt, /^2026-10-09 10:20:00/);
  assert.match(thread.body.messages.find(message => message.type === 'replied').body, /Please send the pricing details/);

  const repeated = await receiver.syncMailbox(1, { limit: 10 });
  assert.equal(repeated.fetched, 0, 'a saved UID cursor avoids refetching the same inbox window');
  assert.equal(repeated.imported, 0);
  assert.equal(repeated.duplicates, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='replied'").get().n, 1);

  const newReply = Buffer.from(receivedMessage.toString('utf8')
    .replace('reply-over-imap@recipient.test', 'second-reply-over-imap@recipient.test')
    .replace('10:20:00', '10:25:00')
    .replace('I am interested. Please send the pricing details.', 'Thanks, please share two times for a call.')
    .replace('<p>I am interested. Please send the pricing details.</p>', '<p>Thanks, please share two times for a call.</p>'));
  mailboxMessages.set(2, newReply);
  const incremental = await receiver.syncMailbox(1, { limit: 10 });
  assert.equal(incremental.fetched, 1);
  assert.equal(incremental.imported, 1);
  assert.equal(incremental.cursorUid, 2);
  assert.ok(commands.some(command => /UID FETCH 2:2/i.test(command)), 'incremental sync requests only UIDs after the stored cursor');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='replied'").get().n, 2);

  database.closeDb();
  db = database.initDb();
  receiver = createImapReceiver({ db, ingestReply: replyTracker.ingestInboundReply, createClient: trustedClientFactory });
  const afterRestart = await receiver.syncMailbox(1, { limit: 10 });
  assert.equal(afterRestart.fetched, 0, 'the mailbox cursor persists across process/database restart');
  assert.equal(afterRestart.cursorUid, 2);

  uidValidity = 778;
  const afterUidValidityReset = await receiver.syncMailbox(1, { limit: 10 });
  assert.equal(afterUidValidityReset.uidValidityChanged, true);
  assert.equal(afterUidValidityReset.fetched, 2, 'a changed UIDVALIDITY triggers a bounded recent backfill');
  assert.equal(afterUidValidityReset.duplicates, 2, 'Message-ID deduplication makes reset backfill replay-safe');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='replied'").get().n, 2);
  assert.equal(db.prepare('SELECT imap_uid_validity FROM mailboxes WHERE id=1').get().imap_uid_validity, '778');

  const thirdReply = Buffer.from(receivedMessage.toString('utf8')
    .replace('reply-over-imap@recipient.test', 'third-reply-over-imap@recipient.test')
    .replace('10:20:00', '10:30:00')
    .replace('I am interested. Please send the pricing details.', 'A failed local save must be retried safely.')
    .replace('<p>I am interested. Please send the pricing details.</p>', '<p>A failed local save must be retried safely.</p>'));
  mailboxMessages.set(3, thirdReply);
  const failingReceiver = createImapReceiver({
    db,
    ingestReply: async () => { throw new Error('disposable persistence failure'); },
    createClient: trustedClientFactory,
  });
  await assert.rejects(failingReceiver.syncMailbox(1, { limit: 10 }), error => error.statusCode === 503);
  assert.equal(db.prepare('SELECT imap_last_uid FROM mailboxes WHERE id=1').get().imap_last_uid, 2,
    'a persistence failure leaves the cursor before the unsaved message');
  const recovered = await receiver.syncMailbox(1, { limit: 10 });
  assert.equal(recovered.fetched, 1);
  assert.equal(recovered.imported, 1);
  assert.equal(recovered.cursorUid, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='replied'").get().n, 3);

  uidValidity = 779;
  const resetWithBoundedInitialSync = await receiver.syncMailbox(1, { limit: 1 });
  assert.equal(resetWithBoundedInitialSync.fetched, 1);
  assert.equal(resetWithBoundedInitialSync.initialBackfillTruncated, true);
  assert.equal(resetWithBoundedInitialSync.hasOlderMessages, true);
  const olderBatch = await receiver.syncMailbox(1, { limit: 1, backfill: true });
  assert.equal(olderBatch.backfill, true);
  assert.equal(olderBatch.fetched, 1);
  assert.equal(olderBatch.duplicates, 1);
  assert.equal(olderBatch.hasOlderMessages, true);
  const oldestBatch = await receiver.syncMailbox(1, { limit: 1, backfill: true });
  assert.equal(oldestBatch.fetched, 1);
  assert.equal(oldestBatch.duplicates, 1);
  assert.equal(oldestBatch.hasOlderMessages, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='replied'").get().n, 3);
  assert.equal(db.prepare('SELECT imap_backfill_before_uid FROM mailboxes WHERE id=1').get().imap_backfill_before_uid, 0);

  for (let uid = 4; uid <= 7; uid++) {
    mailboxMessages.set(uid, Buffer.from(receivedMessage.toString('utf8')
      .replace('reply-over-imap@recipient.test', `bulk-${uid}-reply@recipient.test`)
      .replace('I am interested. Please send the pricing details.', `Synthetic incremental reply ${uid}.`)
      .replace('<p>I am interested. Please send the pricing details.</p>', `<p>Synthetic incremental reply ${uid}.</p>`)));
  }
  const boundedIncremental = await receiver.syncMailbox(1, { limit: 2 });
  assert.equal(boundedIncremental.fetched, 2);
  assert.equal(boundedIncremental.cursorUid, 5);
  assert.equal(boundedIncremental.moreNewMessages, true, 'a backlog is carried forward instead of skipped');
  const drainedIncremental = await receiver.syncMailbox(1, { limit: 2 });
  assert.equal(drainedIncremental.fetched, 2);
  assert.equal(drainedIncremental.cursorUid, 7);
  assert.equal(drainedIncremental.moreNewMessages, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='replied'").get().n, 7);

  const scheduler = createImapSyncScheduler({
    db,
    receiver,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  scheduler.setSettings({ enabled: true, intervalMinutes: 5 }, { id: 1, role: 'owner' });
  mailboxMessages.set(8, Buffer.from(receivedMessage.toString('utf8')
    .replace('reply-over-imap@recipient.test', 'scheduled-sync-reply@recipient.test')
    .replace('I am interested. Please send the pricing details.', 'Scheduled IMAP sync imported this reply.')
    .replace('<p>I am interested. Please send the pricing details.</p>', '<p>Scheduled IMAP sync imported this reply.</p>')));
  const continuousCycle = await scheduler.runOnce();
  assert.equal(continuousCycle.ok, true);
  assert.equal(continuousCycle.mailboxes[0].imported, 1);
  assert.ok(db.prepare('SELECT last_success_at FROM imap_sync_mailbox_state WHERE mailbox_id=1').get().last_success_at);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='replied'").get().n, 8);
  scheduler.stop();

  const commandsUpper = commands.join('\n').toUpperCase();
  assert.match(commandsUpper, /EXAMINE\s+"?INBOX/);
  assert.match(commandsUpper, /BODY\.PEEK\[\]/);
  assert.doesNotMatch(commandsUpper, /\bSTORE\b|\\SEEN/);
});

test('untrusted IMAP certificates fail closed before credentials are accepted', async () => {
  const defaultReceiver = createImapReceiver({ db, ingestReply: replyTracker.ingestInboundReply });
  await assert.rejects(defaultReceiver.testMailbox(1), error => {
    assert.match(error.message, /IMAP connection failed/);
    assert.doesNotMatch(error.message, /private-fixture-password|fixture-user/);
    return error.statusCode === 502;
  });
  assert.equal(acceptedPasswords.length, 14, 'the invalid-certificate connection must not authenticate');
});

