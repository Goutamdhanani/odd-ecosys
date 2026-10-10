# Mailbox credential encryption

The app encrypts new SMTP passwords with AES-256-GCM before saving them in SQLite. The database stores a versioned ciphertext; it does not store the encryption key. The `Settings` page reports only key presence and counts, never key material or passwords.

Generate a key on the Odd Ecosys server and store it in the service environment or a secret manager:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set the output as `ODD_CREDENTIAL_ENCRYPTION_KEY` (64 hexadecimal characters) and restart the application. Keep it backed up separately from the database. Do not put it in source control, chat, logs or the SQLite database. Production SMTP checks and sends refuse legacy plaintext mailbox credentials until the key is configured. Startup encrypts existing mailbox passwords transactionally when it has the active key; with no key it leaves legacy rows untouched so data is preserved, and new password writes are rejected.

For key rotation, set the new key as `ODD_CREDENTIAL_ENCRYPTION_KEY`, set the old key in `ODD_CREDENTIAL_PREVIOUS_KEYS`, and restart. Startup re-encrypts saved values under the new active key. Confirm the Settings page reports zero unavailable credentials before removing the old key from the environment. A missing old key or failed integrity check stops migration without partially rewriting credentials.

Database backups and their matching key backups must be protected together. Losing every key that can decrypt a ciphertext makes that mailbox password unrecoverable; it does not make the mailbox safe to reconnect automatically.
