import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const CIPHER_PREFIX = 'oddc1:';

export class CredentialVaultError extends Error {
  constructor(message, statusCode = 503, code = 'credential_vault_unavailable') {
    super(message);
    this.name = 'CredentialVaultError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parseKey(value, label) {
  if (!value) return null;
  const normalized = String(value).trim();
  if (!/^[a-f\d]{64}$/i.test(normalized)) {
    throw new CredentialVaultError(`${label} must be exactly 64 hexadecimal characters.`, 500, 'credential_key_invalid');
  }
  const key = Buffer.from(normalized, 'hex');
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 16), key };
}

function configuredKeys() {
  const active = parseKey(process.env.ODD_CREDENTIAL_ENCRYPTION_KEY, 'ODD_CREDENTIAL_ENCRYPTION_KEY');
  const previous = String(process.env.ODD_CREDENTIAL_PREVIOUS_KEYS || '')
    .split(',').map(value => value.trim()).filter(Boolean)
    .map((value, index) => parseKey(value, `ODD_CREDENTIAL_PREVIOUS_KEYS entry ${index + 1}`));
  const keys = new Map(previous.map(item => [item.id, item]));
  if (active) keys.set(active.id, active);
  return { active, keys };
}

export function hasActiveCredentialKey() {
  return Boolean(configuredKeys().active);
}

export function encryptCredential(value) {
  if (value == null || value === '') return null;
  const { active } = configuredKeys();
  if (!active) {
    throw new CredentialVaultError(
      'Set ODD_CREDENTIAL_ENCRYPTION_KEY before saving mailbox credentials. Generate a private 32-byte key and keep it outside the database.',
      503,
      'credential_encryption_key_required',
    );
  }
  const plaintext = String(value);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', active.key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${CIPHER_PREFIX}${active.id}:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

export function isEncryptedCredential(value) {
  return typeof value === 'string' && value.startsWith(CIPHER_PREFIX);
}

export function decryptCredential(value) {
  if (value == null || value === '') return '';
  if (!isEncryptedCredential(value)) return String(value); // Legacy rows remain readable until an active key is configured.

  const parts = String(value).split(':');
  if (parts.length !== 5 || parts[0] !== 'oddc1') {
    throw new CredentialVaultError('Stored mailbox credential is malformed. Restore a valid credential backup.', 503, 'credential_ciphertext_invalid');
  }
  const [, keyId, ivHex, tagHex, ciphertextHex] = parts;
  if (!/^[a-f\d]{16}$/i.test(keyId) || !/^[a-f\d]{24}$/i.test(ivHex)
    || !/^[a-f\d]{32}$/i.test(tagHex) || !/^(?:[a-f\d]{2})*$/i.test(ciphertextHex)) {
    throw new CredentialVaultError('Stored mailbox credential is malformed. Restore a valid credential backup.', 503, 'credential_ciphertext_invalid');
  }
  const { keys } = configuredKeys();
  const material = keys.get(keyId);
  if (!material) {
    throw new CredentialVaultError('The key needed to decrypt a stored mailbox credential is unavailable. Restore it before connecting or sending.', 503, 'credential_decryption_key_missing');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', material.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialVaultError('A stored mailbox credential failed its integrity check. Restore a valid credential backup.', 503, 'credential_integrity_failed');
  }
}

/** Encrypt legacy values and rewrap old-key ciphertext under the active key atomically. */
export function migrateMailboxCredentials(db) {
  const { active } = configuredKeys();
  if (!active) return { migrated: 0, activeKeyConfigured: false };
  const fields = ['smtp_pass', 'imap_pass'].filter(field =>
    db.prepare('PRAGMA table_info(mailboxes)').all().some(column => column.name === field));
  const rows = db.prepare(`SELECT id,${fields.join(',')} FROM mailboxes ORDER BY id`).all();
  const update = new Map(fields.map(field => [field, db.prepare(`UPDATE mailboxes SET ${field}=? WHERE id=?`)]));
  let migrated = 0;
  db.transaction(() => {
    for (const row of rows) {
      for (const field of fields) {
        const value = row[field];
        if (!value) continue;
        if (isEncryptedCredential(value)) {
          const keyId = value.split(':')[1];
          if (keyId === active.id) {
            // Verify ciphertext before considering the credential migrated.
            decryptCredential(value);
            continue;
          }
        }
        update.get(field).run(encryptCredential(decryptCredential(value)), row.id);
        migrated++;
      }
    }
  })();
  return { migrated, activeKeyConfigured: true };
}

export function getCredentialVaultStatus(db) {
  const { active } = configuredKeys();
  const fields = ['smtp_pass', 'imap_pass'].filter(field =>
    db.prepare('PRAGMA table_info(mailboxes)').all().some(column => column.name === field));
  const nonempty = fields.map(field => `(${field} IS NOT NULL AND ${field} != '')`).join(' OR ');
  const rows = nonempty ? db.prepare(`SELECT ${fields.join(',')} FROM mailboxes WHERE ${nonempty}`).all() : [];
  let encryptedCount = 0;
  let legacyCount = 0;
  let unreadableCount = 0;
  for (const row of rows) {
    for (const field of fields) {
      const value = row[field];
      if (!value) continue;
      if (isEncryptedCredential(value)) {
        encryptedCount++;
        try { decryptCredential(value); } catch { unreadableCount++; }
      } else {
        legacyCount++;
      }
    }
  }
  const status = unreadableCount ? 'key_unavailable'
    : legacyCount ? (active ? 'migration_pending' : 'legacy_plaintext')
      : rows.length ? 'encrypted' : (active ? 'ready' : 'key_required');
  return {
    status,
    activeKeyConfigured: Boolean(active),
    encryptedCredentialCount: encryptedCount,
    legacyCredentialCount: legacyCount,
    unreadableCredentialCount: unreadableCount,
    productionEncryptionRequired: process.env.NODE_ENV === 'production' || process.env.ODD_CREDENTIAL_ENFORCE_ENCRYPTION === 'true',
  };
}
