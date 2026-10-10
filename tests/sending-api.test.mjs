import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-smtp-api-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = '1'.repeat(64);
process.env.PORT = '0';
delete process.env.HOST;

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
db.prepare("INSERT INTO mailboxes(id,email,domain,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure) VALUES (1,'sender@example.test','example.test',NULL,NULL,NULL,NULL,0)").run();

let rejectAuth = false;
let smtpConnections = 0;
const smtpAcceptedMessages = [];
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  logger: false,
  onConnect(_session, callback) { smtpConnections++; callback(); },
  onAuth(_auth, _session, callback) {
    if (rejectAuth) { const error = new Error('Authentication refused'); error.responseCode = 535; callback(error); }
    else callback(null, { user: 'fixture' });
  },
  onData(stream, _session, callback) {
    let raw = '';
    stream.on('data', chunk => { raw += chunk; });
    stream.on('end', () => { smtpAcceptedMessages.push(raw); callback(null, 'Synthetic sink accepted'); });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });

const { server } = await import('../server.js');
const sendingEngine = await import('../pipeline/sending-engine.js');
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const address = server.address();
assert.equal(address.address, '127.0.0.1', 'development server must bind to loopback by default');
const base = `http://127.0.0.1:${address.port}`;

after(async () => {
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => smtp.close(resolve)),
  ]);
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function updateSmtp({ host = null, port = null, user = null, pass = null } = {}) {
  db.prepare('UPDATE mailboxes SET smtp_host=?,smtp_port=?,smtp_user=? WHERE id=1').run(host, port, user);
  sendingEngine.updateMailbox(1, { smtp_pass: pass });
}

async function post(route, payload) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  return { status: response.status, body: await response.json() };
}

test('B06: personalization API reports Bedrock as disabled without probing AWS credentials', async () => {
  const response = await fetch(`${base}/api/personalize/status`);
  const status = await response.json();
  assert.equal(response.status, 200);
  assert.equal(status.providers.bedrock.status, 'disabled');
  assert.equal(status.providers.bedrock.enabled, false);
  assert.equal(status.providers.bedrock.credentials, 'not_checked');
  assert.equal(status.providers.bedrock.modelId, 'us.anthropic.claude-sonnet-5');
  assert.doesNotMatch(JSON.stringify(status.providers), /AKIA|secret|token/i);
});

test('B05: DNS verification API reports observed domain DNSBL evidence and unknown sender IP', async () => {
  const saved = {
    resolve4: dns.promises.resolve4,
    resolveTxt: dns.promises.resolveTxt,
    resolveMx: dns.promises.resolveMx,
  };
  const fixtureIp = '93.184.216.34';
  dns.promises.resolve4 = async name => {
    if (name === 'example.test') return [fixtureIp];
    if (name === '34.216.184.93.zen.spamhaus.org') return ['127.255.255.254'];
    const error = new Error('not listed in synthetic fixture');
    error.code = 'ENOTFOUND';
    throw error;
  };
  dns.promises.resolveTxt = async () => {
    const error = new Error('no TXT record in synthetic fixture');
    error.code = 'ENOTFOUND';
    throw error;
  };
  dns.promises.resolveMx = async () => {
    const error = new Error('no MX record in synthetic fixture');
    error.code = 'ENODATA';
    throw error;
  };
  try {
    const verification = await post('/api/sending/mailboxes/1/verify-dns');
    assert.equal(verification.status, 200);
    assert.equal(verification.body.ok, true);
    assert.deepEqual(verification.body.domain_a_records, [fixtureIp]);
    assert.equal(verification.body.domain_dnsbl_status, 'unavailable');
    assert.equal(verification.body.blacklist_status, 'unavailable');
    assert.equal(verification.body.blacklisted, null);
    assert.equal(verification.body.domain_blacklisted, null);
    assert.equal(verification.body.sender_ip, null);
    assert.equal(verification.body.sender_ip_status, 'unknown');
    const zen = verification.body.dnsbl_checks.find(check => check.blocklist === 'zen.spamhaus.org');
    assert.equal(zen.checked_ip, fixtureIp);
    assert.equal(zen.subject_type, 'domain_apex_ipv4');
    assert.equal(zen.outcome, 'unavailable');
    assert.equal(zen.error, 'DNSBL_QUERY_NOT_PERMITTED');

    const fleetResponse = await fetch(`${base}/api/sending/mailboxes`);
    const fleet = await fleetResponse.json();
    assert.equal(fleetResponse.status, 200);
    assert.equal(fleet[0].domain_dnsbl_status, 'unavailable');
    assert.equal(fleet[0].domain_blacklisted, null);
    assert.equal(Object.hasOwn(fleet[0], 'blacklisted'), false);
    assert.equal(fleet[0].sender_ip_status, 'unknown');
    assert.equal(fleet[0].sender_reputation_status, 'unknown');
  } finally {
    dns.promises.resolve4 = saved.resolve4;
    dns.promises.resolveTxt = saved.resolveTxt;
    dns.promises.resolveMx = saved.resolveMx;
  }
});

test('B01: SMTP API returns empty, partial and invalid configuration without success records or network probes', async () => {
  const emptyCheck = await post('/api/sending/mailboxes/1/test-smtp');
  assert.equal(emptyCheck.status, 200);
  assert.equal(emptyCheck.body.ok, false);
  assert.equal(emptyCheck.body.code, 'SMTP_NOT_CONFIGURED');

  await updateSmtp({ host: '127.0.0.1', port: smtp.server.address().port, user: 'fixture' });
  const partialCheck = await post('/api/sending/mailboxes/1/test-smtp');
  assert.equal(partialCheck.body.code, 'SMTP_INCOMPLETE_CONFIG');
  assert.equal(partialCheck.body.configured, false);
  const partialSend = await post('/api/sending/mailboxes/1/send-test', { toEmail: 'recipient@example.test' });
  assert.equal(partialSend.body.ok, false);
  assert.equal(partialSend.body.code, 'SMTP_INCOMPLETE_CONFIG');

  await updateSmtp({ host: 'https://127.0.0.1', port: smtp.server.address().port, user: 'fixture', pass: 'fixture-only' });
  const malformedHost = await post('/api/sending/mailboxes/1/test-smtp');
  assert.equal(malformedHost.body.code, 'SMTP_INVALID_CONFIG');
  await updateSmtp({ host: '127.0.0.1', port: 70000, user: 'fixture', pass: 'fixture-only' });
  const invalidPort = await post('/api/sending/mailboxes/1/test-smtp');
  assert.equal(invalidPort.body.code, 'SMTP_INVALID_CONFIG');
  assert.equal(smtpConnections, 0, 'incomplete or malformed SMTP settings must not open a socket');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('B01: SMTP API succeeds only after a real loopback handshake and reports rejected credentials as failure', async () => {
  await updateSmtp({ host: '127.0.0.1', port: smtp.server.address().port, user: 'fixture', pass: 'fixture-only' });
  const valid = await post('/api/sending/mailboxes/1/test-smtp');
  assert.equal(valid.status, 200);
  assert.equal(valid.body.ok, true);
  assert.equal(valid.body.configured, true);
  assert.ok(smtpConnections > 0);
  assert.match(db.prepare('SELECT smtp_pass FROM mailboxes WHERE id=1').get().smtp_pass, /^oddc1:/,
    'mailbox passwords are encrypted in SQLite before the SMTP client reads them');
  const fleet = await (await fetch(`${base}/api/sending/mailboxes`)).json();
  assert.equal(Object.hasOwn(fleet[0], 'smtp_pass'), false);
  assert.equal(fleet[0].smtp_configured, true);
  assert.doesNotMatch(JSON.stringify(fleet), /fixture-only|oddc1:/,
    'mailbox API responses never expose encrypted or plaintext credentials');
  const credentialStatus = await (await fetch(`${base}/api/sending/credential-storage`)).json();
  assert.equal(credentialStatus.status, 'encrypted');
  assert.equal(credentialStatus.activeKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(credentialStatus), new RegExp(process.env.ODD_CREDENTIAL_ENCRYPTION_KEY));

  const testSend = await post('/api/sending/mailboxes/1/send-test', {
    toEmail: 'vault-test-recipient@synthetic.test', subject: 'Encrypted credential test', body: 'Loopback sink accepted this test message.',
  });
  assert.equal(testSend.status, 200, JSON.stringify(testSend.body));
  assert.equal(testSend.body.ok, true);
  assert.equal(smtpAcceptedMessages.length, 1);
  assert.match(smtpAcceptedMessages[0], /Loopback sink accepted this test message/,
    'actual SMTP DATA acceptance proves the worker-side credential reader decrypts the mailbox password');

  rejectAuth = true;
  const revoked = await post('/api/sending/mailboxes/1/test-smtp');
  assert.equal(revoked.body.ok, false);
  assert.equal(revoked.body.configured, true);
  assert.ok(revoked.body.code);
  assert.doesNotMatch(JSON.stringify(revoked.body), /fixture-only/);
  const testEvent = db.prepare("SELECT meta_json FROM events WHERE event_type='sent'").get();
  assert.ok(testEvent, 'successful synthetic SMTP acceptance records one test-send event');
  assert.equal(JSON.parse(testEvent.meta_json).test_send, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1,
    'handshake success/failure alone does not create send events');
});

test('mailbox credentials are not saved when encryption key is missing', async () => {
  const previous = process.env.ODD_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.ODD_CREDENTIAL_ENCRYPTION_KEY;
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get().n;
    const result = await post('/api/sending/mailboxes', {
      email: 'new-sender@synthetic.test', smtp_host: '127.0.0.1', smtp_user: 'fixture', smtp_pass: 'must-not-persist',
    });
    assert.equal(result.status, 503);
    assert.match(result.body.error, /ODD_CREDENTIAL_ENCRYPTION_KEY/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get().n, before,
      'key configuration failure happens before DNS checks or mailbox writes');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mailboxes WHERE smtp_pass='must-not-persist'").get().n, 0);
  } finally {
    process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = previous;
  }
});
