import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-smtp-api-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
db.prepare("INSERT INTO mailboxes(id,email,domain,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure) VALUES (1,'sender@example.test','example.test',NULL,NULL,NULL,NULL,0)").run();

let rejectAuth = false;
let smtpConnections = 0;
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  logger: false,
  onConnect(_session, callback) { smtpConnections++; callback(); },
  onAuth(_auth, _session, callback) {
    if (rejectAuth) { const error = new Error('Authentication refused'); error.responseCode = 535; callback(error); }
    else callback(null, { user: 'fixture' });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });

const { server } = await import('../server.js');
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
  delete process.env.ODD_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

async function updateSmtp({ host = null, port = null, user = null, pass = null } = {}) {
  db.prepare('UPDATE mailboxes SET smtp_host=?,smtp_port=?,smtp_user=?,smtp_pass=? WHERE id=1').run(host, port, user, pass);
}

async function post(route, payload) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  return { status: response.status, body: await response.json() };
}

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

  rejectAuth = true;
  const revoked = await post('/api/sending/mailboxes/1/test-smtp');
  assert.equal(revoked.body.ok, false);
  assert.equal(revoked.body.configured, true);
  assert.ok(revoked.body.code);
  assert.doesNotMatch(JSON.stringify(revoked.body), /fixture-only/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});
