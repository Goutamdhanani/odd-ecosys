import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-credential-vault-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
delete process.env.ODD_CREDENTIAL_ENCRYPTION_KEY;
delete process.env.ODD_CREDENTIAL_PREVIOUS_KEYS;
delete process.env.ODD_CREDENTIAL_ENFORCE_ENCRYPTION;

const database = await import('../pipeline/database.js');
let db = database.initDb();
const vault = await import('../pipeline/credential-vault.js');
const engine = await import('../pipeline/sending-engine.js');

after(() => {
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('SMTP credentials migrate, encrypt, rotate, remain private, and fail closed without required keys', async () => {
  db.prepare(`INSERT INTO mailboxes(id,email,domain,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES(1,'sender@synthetic.test','synthetic.test','127.0.0.1',1,'sender@synthetic.test','legacy-password',0)`).run();
  assert.equal(engine.getMailboxCredentialStorageStatus().status, 'legacy_plaintext');

  await assert.rejects(engine.addMailbox({
    email: 'new@synthetic.test', smtp_host: '127.0.0.1', smtp_user: 'new@synthetic.test', smtp_pass: 'must-not-be-saved',
  }), error => error.code === 'credential_encryption_key_required' && error.statusCode === 503);
  assert.throws(() => engine.updateMailbox(1, { smtp_pass: 'replacement-not-saved' }),
    error => error.code === 'credential_encryption_key_required');
  assert.equal(db.prepare('SELECT smtp_pass FROM mailboxes WHERE id=1').get().smtp_pass, 'legacy-password');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get().n, 1,
    'missing key rejects new mailbox credentials before a DNS lookup or row insertion');

  const keyA = 'a'.repeat(64);
  process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = keyA;
  database.closeDb();
  db = database.initDb();
  let saved = db.prepare('SELECT smtp_pass FROM mailboxes WHERE id=1').get().smtp_pass;
  assert.match(saved, /^oddc1:/, 'startup migration encrypts the legacy password in place');
  assert.equal(vault.decryptCredential(saved), 'legacy-password');
  assert.equal(engine.getMailboxCredentialStorageStatus().status, 'encrypted');

  engine.updateMailbox(1, { smtp_pass: 'updated-password' });
  saved = db.prepare('SELECT smtp_pass FROM mailboxes WHERE id=1').get().smtp_pass;
  assert.match(saved, /^oddc1:/);
  assert.doesNotMatch(saved, /updated-password|legacy-password/);
  assert.equal(vault.decryptCredential(saved), 'updated-password');
  const mailboxResponse = engine.getMailboxFleet()[0];
  assert.equal(Object.hasOwn(mailboxResponse, 'smtp_pass'), false);
  assert.equal(mailboxResponse.smtp_configured, true);
  assert.doesNotMatch(JSON.stringify(mailboxResponse), /updated-password|legacy-password/);

  const keyB = 'b'.repeat(64);
  process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = keyB;
  process.env.ODD_CREDENTIAL_PREVIOUS_KEYS = keyA;
  database.closeDb();
  db = database.initDb();
  saved = db.prepare('SELECT smtp_pass FROM mailboxes WHERE id=1').get().smtp_pass;
  const keyBId = vault.encryptCredential('rotation-check').split(':')[1];
  assert.equal(saved.split(':')[1], keyBId, 'startup rotation rewraps old ciphertext under the active key');
  delete process.env.ODD_CREDENTIAL_PREVIOUS_KEYS;
  assert.equal(vault.decryptCredential(saved), 'updated-password', 'the migrated value opens with only the new active key');

  const unchangedCiphertext = saved;
  process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = 'c'.repeat(64);
  assert.throws(() => vault.migrateMailboxCredentials(db), error => error.code === 'credential_decryption_key_missing');
  assert.equal(db.prepare('SELECT smtp_pass FROM mailboxes WHERE id=1').get().smtp_pass, unchangedCiphertext,
    'failed rotation is transactional and leaves recoverable ciphertext untouched');

  process.env.ODD_CREDENTIAL_ENFORCE_ENCRYPTION = 'true';
  delete process.env.ODD_CREDENTIAL_ENCRYPTION_KEY;
  db.prepare("UPDATE mailboxes SET smtp_pass='legacy-unencrypted' WHERE id=1").run();
  const blockedLegacy = await engine.testMailboxSmtp(1);
  assert.equal(blockedLegacy.ok, false);
  assert.equal(blockedLegacy.code, 'SMTP_CREDENTIAL_ENCRYPTION_REQUIRED');
  assert.equal(blockedLegacy.configured, false, 'production strict mode refuses a legacy plaintext password before opening SMTP');
});
