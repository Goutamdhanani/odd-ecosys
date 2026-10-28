import {
  createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { decryptCredential, encryptCredential, hasActiveCredentialKey } from './credential-vault.js';
import { getGoogleClientId } from './google-oauth.js';
import { createTotpUri, decodeBase32, generateTotpSecret, verifyTotpCode } from './totp.js';

const scrypt = promisify(scryptCallback);
const PASSWORD_BYTES = 32;
const PASSWORD_SALT_BYTES = 16;
const SESSION_BYTES = 32;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEMBER_ROLES = new Set(['owner', 'admin', 'operator', 'reviewer']);
const INVITABLE_ROLES = new Set(['admin', 'operator', 'reviewer']);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function equalText(left, right) {
  const leftDigest = createHash('sha256').update(String(left)).digest();
  const rightDigest = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function configuredBootstrapToken() {
  const token = process.env.ODD_AUTH_BOOTSTRAP_TOKEN || '';
  return token.length >= 32 ? token : '';
}

function configuredRecoveryToken() {
  const token = process.env.ODD_AUTH_RECOVERY_TOKEN || '';
  return token.length >= 32 ? token : '';
}

function sessionTtlSeconds() {
  const configured = Number(process.env.ODD_AUTH_SESSION_TTL_SECONDS);
  if (!Number.isInteger(configured)) return SESSION_TTL_SECONDS;
  return Math.min(7 * 24 * 60 * 60, Math.max(60, configured));
}

function authError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function createAuthManager(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      google_sub TEXT,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','reviewer')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
      deactivated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT,
      mfa_secret_enc TEXT,
      mfa_pending_enc TEXT,
      mfa_pending_expires_at INTEGER,
      mfa_pending_failures INTEGER NOT NULL DEFAULT 0,
      mfa_enabled_at INTEGER,
      mfa_last_counter INTEGER NOT NULL DEFAULT -1
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      csrf_hash TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_expiry
      ON auth_sessions(user_id, expires_at);
    CREATE TABLE IF NOT EXISTS auth_login_attempts (
      attempt_key TEXT PRIMARY KEY,
      failures INTEGER NOT NULL,
      window_started_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS auth_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      user_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
      source_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_events(created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS auth_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE,
      token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('admin','operator','reviewer')),
      invited_by INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER,
      accepted_by INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_auth_invitations_email ON auth_invitations(email, expires_at);
    CREATE TABLE IF NOT EXISTS auth_google_nonces (
      nonce_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_auth_google_nonces_expiry ON auth_google_nonces(expires_at);
    CREATE TABLE IF NOT EXISTS auth_mfa_challenges (
      challenge_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      method TEXT NOT NULL CHECK(method IN ('password','google','invitation')),
      source_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_auth_mfa_challenges_user_expiry
      ON auth_mfa_challenges(user_id,expires_at);
    CREATE TABLE IF NOT EXISTS auth_mfa_recovery_codes (
      user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      used_at INTEGER,
      PRIMARY KEY(user_id,code_hash)
    );
  `);

  const userColumns = new Set(db.prepare('PRAGMA table_info(auth_users)').all().map(column => column.name));
  if (!userColumns.has('role')) {
    db.exec("ALTER TABLE auth_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('owner','admin','operator','reviewer'))");
    const legacyMembers = db.prepare('SELECT id FROM auth_users ORDER BY id').all();
    if (legacyMembers.length) {
      db.prepare("UPDATE auth_users SET role='owner' WHERE id=?").run(legacyMembers[0].id);
    }
  }
  if (!userColumns.has('is_active')) {
    db.exec('ALTER TABLE auth_users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1))');
  }
  if (!userColumns.has('deactivated_at')) db.exec('ALTER TABLE auth_users ADD COLUMN deactivated_at TEXT');
  if (!userColumns.has('google_sub')) db.exec('ALTER TABLE auth_users ADD COLUMN google_sub TEXT');
  if (!userColumns.has('mfa_secret_enc')) db.exec('ALTER TABLE auth_users ADD COLUMN mfa_secret_enc TEXT');
  if (!userColumns.has('mfa_pending_enc')) db.exec('ALTER TABLE auth_users ADD COLUMN mfa_pending_enc TEXT');
  if (!userColumns.has('mfa_pending_expires_at')) db.exec('ALTER TABLE auth_users ADD COLUMN mfa_pending_expires_at INTEGER');
  if (!userColumns.has('mfa_pending_failures')) db.exec('ALTER TABLE auth_users ADD COLUMN mfa_pending_failures INTEGER NOT NULL DEFAULT 0');
  if (!userColumns.has('mfa_enabled_at')) db.exec('ALTER TABLE auth_users ADD COLUMN mfa_enabled_at INTEGER');
  if (!userColumns.has('mfa_last_counter')) db.exec('ALTER TABLE auth_users ADD COLUMN mfa_last_counter INTEGER NOT NULL DEFAULT -1');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_google_sub ON auth_users(google_sub) WHERE google_sub IS NOT NULL');
  const ownerRows = db.prepare("SELECT id FROM auth_users WHERE role='owner' ORDER BY id").all();
  if (ownerRows.length === 0) {
    const firstMember = db.prepare('SELECT id FROM auth_users ORDER BY id LIMIT 1').get();
    if (firstMember) db.prepare("UPDATE auth_users SET role='owner' WHERE id=?").run(firstMember.id);
  } else if (ownerRows.length > 1) {
    db.prepare("UPDATE auth_users SET role='admin' WHERE role='owner' AND id<>?").run(ownerRows[0].id);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_single_owner ON auth_users(role) WHERE role='owner'");

  const userCount = db.prepare('SELECT COUNT(*) AS count FROM auth_users');
  const sessionByToken = db.prepare(`
    SELECT s.token_hash, s.csrf_hash, s.user_id, s.expires_at, u.email, u.role
    FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.is_active=1
  `);
  const hashPassword = async password => {
    const salt = randomBytes(PASSWORD_SALT_BYTES);
    const derived = await scrypt(password, salt, PASSWORD_BYTES, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return { salt: salt.toString('hex'), hash: Buffer.from(derived).toString('hex') };
  };

  const failedAttemptByKey = db.prepare(`SELECT failures,window_started_at,locked_until
    FROM auth_login_attempts WHERE attempt_key=?`);
  const saveFailedAttempt = db.prepare(`INSERT INTO auth_login_attempts(attempt_key,failures,window_started_at,locked_until)
    VALUES (?,?,?,?) ON CONFLICT(attempt_key) DO UPDATE SET
    failures=excluded.failures, window_started_at=excluded.window_started_at, locked_until=excluded.locked_until`);
  const updateFailedAttempt = db.transaction(key => {
    // Account at completion, under a write lock, rather than using pre-scrypt snapshots.
    const now = Date.now();
    const previous = failedAttemptByKey.get(key);
    const locked = previous?.locked_until > now;
    const canContinueWindow = previous && (locked || (previous.locked_until === 0
      && now - previous.window_started_at < LOGIN_WINDOW_MS));
    const failures = canContinueWindow ? previous.failures + 1 : 1;
    // Already-admitted failures must neither reset the count nor move an active lock.
    const lockedUntil = locked ? previous.locked_until : failures >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCK_MS : 0;
    saveFailedAttempt.run(key, failures, canContinueWindow ? previous.window_started_at : now, lockedUntil);
  });

  function recordFailedAttempt(key) {
    updateFailedAttempt.immediate(key);
  }

  function newSession(userId) {
    const sessionToken = randomBytes(SESSION_BYTES).toString('base64url');
    const csrfToken = randomBytes(SESSION_BYTES).toString('base64url');
    const now = Date.now();
    const expiresAt = now + sessionTtlSeconds() * 1000;
    db.prepare(`INSERT INTO auth_sessions(token_hash,csrf_hash,user_id,created_at,expires_at)
      VALUES (?,?,?,?,?)`).run(digest(sessionToken), digest(csrfToken), userId, now, expiresAt);
    db.prepare('DELETE FROM auth_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL').run(now);
    return { sessionToken, csrfToken, expiresAt };
  }

  function recordAudit(eventType, userId, remoteAddress) {
    db.prepare('INSERT INTO auth_audit_events(event_type,user_id,source_hash,created_at) VALUES (?,?,?,?)')
      .run(eventType, userId ?? null, digest(remoteAddress || 'unknown'), Date.now());
  }

  function requireMfaAdministrator(actor) {
    if (!actor?.id || !['owner', 'admin'].includes(actor.role)) {
      throw authError('Only active workspace owners and admins can manage MFA.', 403);
    }
    const user = db.prepare(`SELECT id,email,role,is_active,password_salt,password_hash,mfa_secret_enc,
      mfa_pending_enc,mfa_pending_expires_at,mfa_pending_failures,mfa_enabled_at,mfa_last_counter
      FROM auth_users WHERE id=? AND is_active=1`).get(actor.id);
    if (!user || user.role !== actor.role || !['owner', 'admin'].includes(user.role)) {
      throw authError('Active owner or admin account required.', 403);
    }
    return user;
  }

  function normalizeRecoveryCode(value) {
    const normalized = typeof value === 'string' ? value.toUpperCase().replace(/[\s-]/g, '') : '';
    return /^[A-F0-9]{24}$/.test(normalized) ? normalized : '';
  }

  function recoveryCodeHash(value) {
    return digest(`mfa-recovery\0${normalizeRecoveryCode(value)}`);
  }

  function createRecoveryCodes() {
    return Array.from({ length: 10 }, () => {
      const raw = randomBytes(12).toString('hex').toUpperCase();
      return raw.match(/.{6}/g).join('-');
    });
  }

  function replaceRecoveryCodes(userId, codes, now = Date.now()) {
    db.prepare('DELETE FROM auth_mfa_recovery_codes WHERE user_id=?').run(userId);
    const insert = db.prepare('INSERT INTO auth_mfa_recovery_codes(user_id,code_hash,created_at) VALUES (?,?,?)');
    for (const code of codes) insert.run(userId, recoveryCodeHash(code), now);
  }

  function mfaStepupKeys(userId, remoteAddress) {
    return [digest(`mfa-stepup-user\0${userId}`), digest(`mfa-stepup-ip\0${remoteAddress || 'unknown'}`)];
  }

  function checkMfaStepup(userId, remoteAddress) {
    const keys = mfaStepupKeys(userId, remoteAddress);
    const now = Date.now();
    const attempts = keys.map(key => db.prepare(`SELECT failures,window_started_at,locked_until
      FROM auth_login_attempts WHERE attempt_key=?`).get(key));
    if (attempts.some(attempt => attempt?.locked_until > now)) {
      throw authError('Too many security checks. Try again in 15 minutes.', 429);
    }
    return { keys };
  }

  function failMfaStepup(keys, userId, remoteAddress) {
    keys.forEach(key => recordFailedAttempt(key));
    recordAudit('mfa_stepup_denied', userId, remoteAddress);
  }

  function clearMfaStepup(keys) {
    db.prepare(`DELETE FROM auth_login_attempts WHERE attempt_key IN (?,?)`).run(...keys);
  }

  function factorFor(user, code, now = Date.now()) {
    const supplied = typeof code === 'string' ? code.trim() : '';
    if (/^\d{6}$/.test(supplied)) {
      const secret = decodeBase32(decryptCredential(user.mfa_secret_enc));
      const counter = verifyTotpCode(secret, supplied, {
        timestampMs: now,
        lastCounter: Number.isInteger(user.mfa_last_counter) ? user.mfa_last_counter : -1,
      });
      return counter === null ? null : { kind: 'totp', counter };
    }
    const normalized = normalizeRecoveryCode(supplied);
    if (!normalized) return null;
    const codeHash = recoveryCodeHash(normalized);
    const recovery = db.prepare(`SELECT code_hash FROM auth_mfa_recovery_codes
      WHERE user_id=? AND code_hash=? AND used_at IS NULL`).get(user.id, codeHash);
    return recovery ? { kind: 'recovery', codeHash } : null;
  }

  function consumeMfaFactor(userId, factor, now = Date.now()) {
    if (factor.kind === 'totp') {
      const updated = db.prepare(`UPDATE auth_users SET mfa_last_counter=?
        WHERE id=? AND mfa_last_counter<?`).run(factor.counter, userId, factor.counter);
      return updated.changes === 1;
    }
    const updated = db.prepare(`UPDATE auth_mfa_recovery_codes SET used_at=?
      WHERE user_id=? AND code_hash=? AND used_at IS NULL`).run(now, userId, factor.codeHash);
    return updated.changes === 1;
  }

  function mfaStatus(actor) {
    if (!actor?.id) throw authError('Sign-in required.', 401);
    if (!['owner', 'admin'].includes(actor.role)) {
      return {
        eligible: false,
        enabled: false,
        encryptionAvailable: false,
        recoveryCodesRemaining: 0,
        pendingEnrollmentExpiresAt: null,
      };
    }
    const user = requireMfaAdministrator(actor);
    const remaining = db.prepare(`SELECT COUNT(*) AS count FROM auth_mfa_recovery_codes
      WHERE user_id=? AND used_at IS NULL`).get(user.id).count;
    return {
      eligible: true,
      enabled: Boolean(user.mfa_secret_enc && user.mfa_enabled_at),
      configurationValid: Boolean(user.mfa_secret_enc) === Boolean(user.mfa_enabled_at),
      encryptionAvailable: hasActiveCredentialKey(),
      recoveryCodesRemaining: remaining,
      pendingEnrollmentExpiresAt: user.mfa_pending_expires_at && user.mfa_pending_expires_at > Date.now()
        ? user.mfa_pending_expires_at : null,
    };
  }

  function beginMfaEnrollment(actor, remoteAddress) {
    const user = requireMfaAdministrator(actor);
    if (user.mfa_secret_enc || user.mfa_enabled_at) throw authError('Multi-factor sign-in is already enabled or needs operator repair.', 409);
    if (!hasActiveCredentialKey()) {
      throw authError('Set ODD_CREDENTIAL_ENCRYPTION_KEY before enrolling an authenticator. The MFA secret is encrypted at rest with this server-only key.', 503);
    }
    const secret = generateTotpSecret();
    const expiresAt = Date.now() + 10 * 60_000;
    db.prepare(`UPDATE auth_users SET mfa_pending_enc=?,mfa_pending_expires_at=?,mfa_pending_failures=0 WHERE id=?`)
      .run(encryptCredential(secret), expiresAt, user.id);
    recordAudit('mfa_enrollment_started', user.id, remoteAddress);
    return {
      secret,
      otpauthUri: createTotpUri(secret, user.email),
      expiresAt,
    };
  }

  function confirmMfaEnrollment(actor, code, remoteAddress) {
    const user = requireMfaAdministrator(actor);
    const now = Date.now();
    const result = db.transaction(() => {
      const current = db.prepare(`SELECT id,email,mfa_secret_enc,mfa_pending_enc,mfa_pending_expires_at,
        mfa_pending_failures,mfa_last_counter FROM auth_users WHERE id=? AND is_active=1`).get(user.id);
      if (current?.mfa_secret_enc || current?.mfa_enabled_at) throw authError('Multi-factor sign-in is already enabled or needs operator repair.', 409);
      if (!current?.mfa_pending_enc || current.mfa_pending_expires_at <= now) {
        throw authError('Authenticator setup expired. Start enrollment again.', 410);
      }
      if (current.mfa_pending_failures >= 5) {
        db.prepare(`UPDATE auth_users SET mfa_pending_enc=NULL,mfa_pending_expires_at=NULL,mfa_pending_failures=0 WHERE id=?`).run(user.id);
        throw authError('Too many verification attempts. Start authenticator enrollment again.', 429);
      }
      const secret = decodeBase32(decryptCredential(current.mfa_pending_enc));
      const counter = verifyTotpCode(secret, code, { timestampMs: now, lastCounter: current.mfa_last_counter });
      if (counter === null) {
        const attempts = current.mfa_pending_failures + 1;
        db.prepare(`UPDATE auth_users SET mfa_pending_failures=?,
          mfa_pending_enc=CASE WHEN ?>=5 THEN NULL ELSE mfa_pending_enc END,
          mfa_pending_expires_at=CASE WHEN ?>=5 THEN NULL ELSE mfa_pending_expires_at END
          WHERE id=?`).run(attempts, attempts, attempts, user.id);
        recordAudit('mfa_enrollment_denied', user.id, remoteAddress);
        return { invalid: true, attempts };
      }
      const recoveryCodes = createRecoveryCodes();
      const saved = db.prepare(`UPDATE auth_users SET mfa_secret_enc=mfa_pending_enc,mfa_pending_enc=NULL,
        mfa_pending_expires_at=NULL,mfa_pending_failures=0,mfa_enabled_at=?,mfa_last_counter=?
        WHERE id=? AND mfa_secret_enc IS NULL AND mfa_enabled_at IS NULL AND mfa_pending_expires_at>?`).run(now, counter, user.id, now);
      if (saved.changes !== 1) throw authError('Authenticator setup changed. Start enrollment again.', 409);
      replaceRecoveryCodes(user.id, recoveryCodes, now);
      recordAudit('mfa_enabled', user.id, remoteAddress);
      return { enabled: true, recoveryCodes };
    })();
    if (result.invalid) throw authError('Authenticator code was not accepted.', result.attempts >= 5 ? 429 : 400);
    return result;
  }

  function issueMfaChallenge(userId, remoteAddress, method, successAuditType = null) {
    const user = db.prepare(`SELECT id,email,role,is_active,mfa_secret_enc,mfa_enabled_at
      FROM auth_users WHERE id=? AND is_active=1`).get(userId);
    if (!user) throw authError('Sign-in could not be completed.', 401);
    if (Boolean(user.mfa_secret_enc) !== Boolean(user.mfa_enabled_at)) {
      throw authError('Authenticator sign-in configuration is incomplete. Ask a workspace owner to repair MFA before signing in.', 503);
    }
    if (!user.mfa_secret_enc) {
      db.prepare("UPDATE auth_users SET last_login_at=datetime('now') WHERE id=?").run(user.id);
      if (successAuditType !== false) {
        recordAudit(successAuditType || (method === 'google' ? 'google_sign_in' : method === 'invitation' ? 'invitation_accepted' : 'sign_in'), user.id, remoteAddress);
      }
      return { user: { id: user.id, email: user.email, role: user.role }, ...newSession(user.id) };
    }
    const now = Date.now();
    const challengeToken = randomBytes(SESSION_BYTES).toString('base64url');
    const expiresAt = now + 5 * 60_000;
    db.prepare('DELETE FROM auth_mfa_challenges WHERE expires_at<=? OR consumed_at IS NOT NULL').run(now);
    db.prepare(`INSERT INTO auth_mfa_challenges(challenge_hash,user_id,method,source_hash,created_at,expires_at)
      VALUES (?,?,?,?,?,?)`).run(digest(challengeToken), user.id, method, digest(`mfa-challenge-ip\0${remoteAddress || 'unknown'}`), now, expiresAt);
    recordAudit(`${method}_mfa_challenge_issued`, user.id, remoteAddress);
    return {
      mfaRequired: true,
      challengeToken,
      expiresAt,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  function completeMfaChallenge({ challengeToken, code, remoteAddress }) {
    if (typeof challengeToken !== 'string' || challengeToken.length < 32 || challengeToken.length > 128
      || typeof code !== 'string' || code.length > 128) {
      throw authError('Authenticator or recovery code was not accepted.', 401);
    }
    const tokenHash = digest(challengeToken);
    const now = Date.now();
    const issued = db.prepare('SELECT user_id,source_hash FROM auth_mfa_challenges WHERE challenge_hash=?').get(tokenHash);
    if (!issued) throw authError('Authenticator or recovery code was not accepted, or the sign-in challenge expired.', 401);
    const rateKeys = [digest(`mfa-challenge-user\0${issued.user_id}`), issued.source_hash];
    const rateAttempts = rateKeys.map(key => db.prepare(`SELECT failures,window_started_at,locked_until
      FROM auth_login_attempts WHERE attempt_key=?`).get(key));
    if (rateAttempts.some(attempt => attempt?.locked_until > now)) {
      throw authError('Too many authenticator attempts. Try again in 15 minutes.', 429);
    }
    const result = db.transaction(() => {
      const challenge = db.prepare(`SELECT c.user_id,c.method,c.expires_at,c.attempts,c.consumed_at,
        u.id,u.email,u.role,u.is_active,u.mfa_secret_enc,u.mfa_enabled_at,u.mfa_last_counter
        FROM auth_mfa_challenges c JOIN auth_users u ON u.id=c.user_id WHERE c.challenge_hash=?`).get(tokenHash);
      if (!challenge || challenge.consumed_at || challenge.expires_at <= now || challenge.attempts >= 5
        || challenge.is_active !== 1 || !challenge.mfa_secret_enc || !challenge.mfa_enabled_at) return { invalid: true };
      const factor = factorFor(challenge, code, now);
      if (!factor) {
        const attempts = challenge.attempts + 1;
        db.prepare(`UPDATE auth_mfa_challenges SET attempts=?,consumed_at=CASE WHEN ?>=5 THEN ? ELSE consumed_at END
          WHERE challenge_hash=? AND consumed_at IS NULL`).run(attempts, attempts, now, tokenHash);
        rateKeys.forEach(key => recordFailedAttempt(key));
        recordAudit('mfa_challenge_denied', challenge.user_id, remoteAddress);
        return { invalid: true, locked: attempts >= 5 };
      }
      const consumed = db.prepare(`UPDATE auth_mfa_challenges SET consumed_at=?
        WHERE challenge_hash=? AND consumed_at IS NULL AND expires_at>? AND attempts<5`).run(now, tokenHash, now);
      if (consumed.changes !== 1 || !consumeMfaFactor(challenge.user_id, factor, now)) {
        throw authError('Authenticator or recovery code was not accepted.', 401);
      }
      db.prepare("UPDATE auth_users SET last_login_at=datetime('now') WHERE id=?").run(challenge.user_id);
      recordAudit(factor.kind === 'recovery' ? 'mfa_recovery_code_used' : 'mfa_sign_in', challenge.user_id, remoteAddress);
      clearMfaStepup(rateKeys);
      return {
        user: { id: challenge.user_id, email: challenge.email, role: challenge.role },
        ...newSession(challenge.user_id),
      };
    })();
    if (result.invalid) throw authError('Authenticator or recovery code was not accepted, or the sign-in challenge expired.', result.locked ? 429 : 401);
    return result;
  }

  async function regenerateMfaRecoveryCodes(actor, { password, code, remoteAddress }) {
    const user = requireMfaAdministrator(actor);
    if (typeof password !== 'string' || password.length > 128) throw authError('Password or authenticator code was not accepted.', 401);
    const limit = checkMfaStepup(user.id, remoteAddress);
    const derived = Buffer.from(await scrypt(password, Buffer.from(user.password_salt, 'hex'), PASSWORD_BYTES, {
      N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
    }));
    if (!timingSafeEqual(derived, Buffer.from(user.password_hash, 'hex'))) {
      failMfaStepup(limit.keys, user.id, remoteAddress);
      throw authError('Password or authenticator code was not accepted.', 401);
    }
    const recoveryCodes = createRecoveryCodes();
    const now = Date.now();
    const result = db.transaction(() => {
      checkMfaStepup(user.id, remoteAddress);
      const current = db.prepare(`SELECT id,mfa_secret_enc,mfa_enabled_at,mfa_last_counter
        FROM auth_users WHERE id=? AND is_active=1`).get(user.id);
      const factor = current?.mfa_secret_enc && current.mfa_enabled_at ? factorFor(current, code, now) : null;
      if (!factor || !consumeMfaFactor(user.id, factor, now)) return false;
      replaceRecoveryCodes(user.id, recoveryCodes, now);
      clearMfaStepup(limit.keys);
      recordAudit('mfa_recovery_codes_regenerated', user.id, remoteAddress);
      return true;
    }).immediate();
    if (!result) {
      failMfaStepup(limit.keys, user.id, remoteAddress);
      throw authError('Password or authenticator code was not accepted.', 401);
    }
    return { recoveryCodes };
  }

  async function disableMfa(actor, { password, code, remoteAddress }) {
    const user = requireMfaAdministrator(actor);
    if (typeof password !== 'string' || password.length > 128) throw authError('Password or authenticator code was not accepted.', 401);
    const limit = checkMfaStepup(user.id, remoteAddress);
    const derived = Buffer.from(await scrypt(password, Buffer.from(user.password_salt, 'hex'), PASSWORD_BYTES, {
      N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
    }));
    if (!timingSafeEqual(derived, Buffer.from(user.password_hash, 'hex'))) {
      failMfaStepup(limit.keys, user.id, remoteAddress);
      throw authError('Password or authenticator code was not accepted.', 401);
    }
    const now = Date.now();
    const disabled = db.transaction(() => {
      checkMfaStepup(user.id, remoteAddress);
      const current = db.prepare(`SELECT id,mfa_secret_enc,mfa_enabled_at,mfa_last_counter
        FROM auth_users WHERE id=? AND is_active=1`).get(user.id);
      const factor = current?.mfa_secret_enc && current.mfa_enabled_at ? factorFor(current, code, now) : null;
      if (!factor || !consumeMfaFactor(user.id, factor, now)) return false;
      db.prepare(`UPDATE auth_users SET mfa_secret_enc=NULL,mfa_pending_enc=NULL,mfa_pending_expires_at=NULL,
        mfa_pending_failures=0,mfa_enabled_at=NULL,mfa_last_counter=-1 WHERE id=?`).run(user.id);
      db.prepare('DELETE FROM auth_mfa_recovery_codes WHERE user_id=?').run(user.id);
      db.prepare('UPDATE auth_mfa_challenges SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').run(now, user.id);
      clearMfaStepup(limit.keys);
      recordAudit('mfa_disabled', user.id, remoteAddress);
      return true;
    }).immediate();
    if (!disabled) {
      failMfaStepup(limit.keys, user.id, remoteAddress);
      throw authError('Password or authenticator code was not accepted.', 401);
    }
    return { ok: true };
  }

  function currentSession(sessionToken) {
    if (!sessionToken || typeof sessionToken !== 'string' || sessionToken.length > 128) return null;
    const session = sessionByToken.get(digest(sessionToken), Date.now());
    return session ? {
      id: session.user_id, email: session.email, role: session.role,
      csrfHash: session.csrf_hash, expiresAt: session.expires_at,
    } : null;
  }

  function verifyCsrf(session, cookieToken, headerToken) {
    if (!session || !cookieToken || !headerToken || cookieToken !== headerToken) return false;
    return equalText(digest(cookieToken), session.csrfHash);
  }

  function publicStatus(sessionToken) {
    const user = currentSession(sessionToken);
    return {
      authenticated: Boolean(user),
      user: user ? { id: user.id, email: user.email, role: user.role } : null,
      setupRequired: userCount.get().count === 0,
      setupAvailable: userCount.get().count === 0 && Boolean(configuredBootstrapToken()),
      recoveryAvailable: userCount.get().count > 0 && Boolean(configuredRecoveryToken()),
      googleLoginAvailable: Boolean(getGoogleClientId()),
      googleClientId: getGoogleClientId() || null,
    };
  }

  function authorizeOwnerSetup(bootstrapToken, remoteAddress) {
    const expected = configuredBootstrapToken();
    if (!expected) throw authError('First-account setup is disabled. Configure ODD_AUTH_BOOTSTRAP_TOKEN with a private value of at least 32 characters, then restart the service.', 503);
    const now = Date.now();
    const key = digest(`bootstrap\0${remoteAddress || 'unknown'}`);
    const attempt = db.prepare('SELECT failures,window_started_at,locked_until FROM auth_login_attempts WHERE attempt_key=?').get(key);
    if (attempt?.locked_until > now) throw authError('Too many setup attempts. Try again in 15 minutes.', 429);
    if (typeof bootstrapToken !== 'string' || !equalText(bootstrapToken, expected)) {
      recordFailedAttempt(key, attempt, now);
      recordAudit('bootstrap_denied', null, remoteAddress);
      throw authError('Setup token was not accepted.', 403);
    }
    db.prepare('DELETE FROM auth_login_attempts WHERE attempt_key=?').run(key);
  }

  async function bootstrap({ email, password, bootstrapToken, remoteAddress }) {
    authorizeOwnerSetup(bootstrapToken, remoteAddress);
    const normalizedEmail = normalizeEmail(email);
    if (!validEmail(normalizedEmail)) throw authError('Enter a valid email address.', 400);
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      throw authError('Password must be between 12 and 128 characters.', 400);
    }

    const { salt, hash } = await hashPassword(password);
    const create = db.transaction(() => {
      if (userCount.get().count !== 0) throw authError('First-account setup is already complete.', 409);
      const result = db.prepare("INSERT INTO auth_users(email,password_salt,password_hash,role) VALUES (?,?,?,'owner')")
        .run(normalizedEmail, salt, hash);
      recordAudit('account_bootstrapped', Number(result.lastInsertRowid), remoteAddress);
      return { user: { id: Number(result.lastInsertRowid), email: normalizedEmail, role: 'owner' }, ...newSession(Number(result.lastInsertRowid)) };
    });
    return { user: { email: normalizedEmail }, ...create() };
  }

  function attemptKey(email, remoteAddress) {
    return digest(`login\0${email}\0${remoteAddress || 'unknown'}`);
  }

  function ipAttemptKey(remoteAddress) {
    return digest(`login-ip\0${remoteAddress || 'unknown'}`);
  }

  async function login({ email, password, remoteAddress }) {
    const normalizedEmail = normalizeEmail(email);
    const key = attemptKey(normalizedEmail, remoteAddress);
    const ipKey = ipAttemptKey(remoteAddress);
    const now = Date.now();
    const attempt = db.prepare('SELECT failures,window_started_at,locked_until FROM auth_login_attempts WHERE attempt_key=?').get(key);
    const ipAttempt = db.prepare('SELECT failures,window_started_at,locked_until FROM auth_login_attempts WHERE attempt_key=?').get(ipKey);
    if (attempt?.locked_until > now || ipAttempt?.locked_until > now) {
      throw authError('Too many sign-in attempts. Try again in 15 minutes.', 429);
    }

    const user = validEmail(normalizedEmail)
      ? db.prepare('SELECT id,email,password_salt,password_hash,role FROM auth_users WHERE email=? COLLATE NOCASE AND is_active=1').get(normalizedEmail)
      : null;
    let passwordMatches = false;
    if (user && typeof password === 'string' && password.length <= 128) {
      const derived = Buffer.from(await scrypt(password, Buffer.from(user.password_salt, 'hex'), PASSWORD_BYTES, {
        N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
      }));
      passwordMatches = timingSafeEqual(derived, Buffer.from(user.password_hash, 'hex'));
    } else {
      // Keep the unknown-user path close to the password-check path.
      await scrypt(typeof password === 'string' ? password.slice(0, 128) : '', Buffer.alloc(PASSWORD_SALT_BYTES), PASSWORD_BYTES,
        { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    }

    if (!passwordMatches) {
      recordFailedAttempt(key);
      recordFailedAttempt(ipKey);
      recordAudit('sign_in_denied', user?.id ?? null, remoteAddress);
      throw authError('Email or password was not accepted.', 401);
    }

    return db.transaction(() => {
      // A successful in-flight check must not clear a lock acquired during scrypt.
      const completedAt = Date.now();
      if ([key, ipKey].some(attemptKeyValue => failedAttemptByKey.get(attemptKeyValue)?.locked_until > completedAt)) {
        throw authError('Too many sign-in attempts. Try again in 15 minutes.', 429);
      }
      db.prepare('DELETE FROM auth_login_attempts WHERE attempt_key IN (?,?)').run(key, ipKey);
      return issueMfaChallenge(user.id, remoteAddress, 'password', 'sign_in');
    }).immediate();
  }

  async function googleLogin({ email, subject, bootstrapToken, remoteAddress }) {
    const normalizedEmail = normalizeEmail(email);
    if (!validEmail(normalizedEmail) || typeof subject !== 'string' || !subject || subject.length > 255) {
      throw authError('Google sign-in could not be completed.', 401);
    }
    const now = Date.now();
    const loginKey = digest(`google-login\0${normalizedEmail}\0${remoteAddress || 'unknown'}`);
    const ipKey = digest(`google-login-ip\0${remoteAddress || 'unknown'}`);
    const getAttempt = db.prepare('SELECT failures,window_started_at,locked_until FROM auth_login_attempts WHERE attempt_key=?');
    const attempt = getAttempt.get(loginKey);
    const ipAttempt = getAttempt.get(ipKey);
    if (attempt?.locked_until > now || ipAttempt?.locked_until > now) {
      throw authError('Too many sign-in attempts. Try again in 15 minutes.', 429);
    }

    const existingBySubject = db.prepare(`SELECT id,email,role,is_active,google_sub FROM auth_users WHERE google_sub=?`).get(subject);
    const existingByEmail = db.prepare(`SELECT id,email,role,is_active,google_sub FROM auth_users WHERE email=? COLLATE NOCASE`).get(normalizedEmail);
    const initialUserCount = userCount.get().count;
    const existing = existingBySubject || existingByEmail;
    const deny = () => {
      recordFailedAttempt(loginKey);
      recordFailedAttempt(ipKey);
      recordAudit('google_sign_in_denied', existing?.id ?? null, remoteAddress);
      throw authError('No eligible workspace account matches this Google account. Ask an owner for access.', 401);
    };
    if (existingBySubject && existingByEmail && existingBySubject.id !== existingByEmail.id) deny();
    if (existing?.is_active !== undefined && existing.is_active !== 1) deny();
    if (existing?.google_sub && existing.google_sub !== subject) deny();
    if (!existing && initialUserCount > 0) deny();

    let ownerCredentials = null;
    if (!existing && initialUserCount === 0) {
      authorizeOwnerSetup(bootstrapToken, remoteAddress);
      ownerCredentials = await hashPassword(randomBytes(48).toString('base64url'));
    }

    const authorizeGoogleUser = db.transaction(() => {
      let user = db.prepare(`SELECT id,email,role,is_active,google_sub FROM auth_users WHERE google_sub=?`).get(subject);
      const byEmail = db.prepare(`SELECT id,email,role,is_active,google_sub FROM auth_users WHERE email=? COLLATE NOCASE`).get(normalizedEmail);
      if (user && byEmail && user.id !== byEmail.id) return null;
      user ||= byEmail;
      let createdOwner = false;
      if (!user && userCount.get().count === 0 && ownerCredentials) {
        const created = db.prepare(`INSERT INTO auth_users(email,google_sub,password_salt,password_hash,role)
          VALUES (?,?,?,?,'owner')`).run(normalizedEmail, subject, ownerCredentials.salt, ownerCredentials.hash);
        user = { id: Number(created.lastInsertRowid), email: normalizedEmail, role: 'owner', is_active: 1, google_sub: subject };
        createdOwner = true;
      }
      if (!user || user.is_active !== 1 || (user.google_sub && user.google_sub !== subject)) return null;
      if (!user.google_sub) db.prepare('UPDATE auth_users SET google_sub=? WHERE id=? AND google_sub IS NULL').run(subject, user.id);
      const linked = db.prepare('SELECT google_sub FROM auth_users WHERE id=?').get(user.id);
      if (linked?.google_sub !== subject) return null;
      db.prepare('DELETE FROM auth_login_attempts WHERE attempt_key IN (?,?)').run(loginKey, ipKey);
      return {
        user: { id: user.id, email: user.email, role: user.role },
        auditType: createdOwner ? 'google_owner_bootstrapped' : existing?.google_sub ? 'google_sign_in' : 'google_account_linked',
      };
    });
    const authorized = authorizeGoogleUser();
    if (!authorized) deny();
    return issueMfaChallenge(authorized.user.id, remoteAddress, 'google', authorized.auditType);
  }

  function issueGoogleNonce(nonce) {
    if (typeof nonce !== 'string' || nonce.length < 32 || nonce.length > 128) {
      throw authError('Google sign-in could not be started.', 400);
    }
    const now = Date.now();
    const issue = db.transaction(() => {
      db.prepare('DELETE FROM auth_google_nonces WHERE expires_at<=? OR consumed_at IS NOT NULL').run(now - 60_000);
      if (db.prepare('SELECT COUNT(*) AS count FROM auth_google_nonces WHERE expires_at>? AND consumed_at IS NULL').get(now).count >= 1000) {
        throw authError('Google sign-in is busy. Wait a moment and try again.', 429);
      }
      db.prepare('INSERT INTO auth_google_nonces(nonce_hash,expires_at) VALUES (?,?)')
        .run(digest(nonce), now + 5 * 60_000);
    });
    issue();
  }

  function consumeGoogleNonce(nonce) {
    if (typeof nonce !== 'string' || nonce.length < 32 || nonce.length > 128) return false;
    const result = db.prepare(`UPDATE auth_google_nonces SET consumed_at=?
      WHERE nonce_hash=? AND consumed_at IS NULL AND expires_at>?`).run(Date.now(), digest(nonce), Date.now());
    return result.changes === 1;
  }

  function googleTokenAttemptKey(remoteAddress) {
    return digest(`google-token\0${remoteAddress || 'unknown'}`);
  }

  function checkGoogleTokenAttempt(remoteAddress) {
    const key = googleTokenAttemptKey(remoteAddress);
    const attempt = db.prepare('SELECT failures,window_started_at,locked_until FROM auth_login_attempts WHERE attempt_key=?').get(key);
    if (attempt?.locked_until > Date.now()) throw authError('Too many sign-in attempts. Try again in 15 minutes.', 429);
  }

  function recordGoogleTokenFailure(remoteAddress) {
    const key = googleTokenAttemptKey(remoteAddress);
    recordFailedAttempt(key);
    recordAudit('google_token_denied', null, remoteAddress);
  }

  function clearGoogleTokenFailures(remoteAddress) {
    db.prepare('DELETE FROM auth_login_attempts WHERE attempt_key=?').run(googleTokenAttemptKey(remoteAddress));
  }

  async function recover({ email, password, recoveryToken, remoteAddress }) {
    const expected = configuredRecoveryToken();
    if (!expected) throw authError('Operator password recovery is disabled. Configure ODD_AUTH_RECOVERY_TOKEN with a private value of at least 32 characters, then restart the service.', 503);
    const normalizedEmail = normalizeEmail(email);
    if (!validEmail(normalizedEmail)) throw authError('Enter a valid email address.', 400);
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      throw authError('Password must be between 12 and 128 characters.', 400);
    }
    const now = Date.now();
    const ip = remoteAddress || 'unknown';
    const keys = [digest(`recovery-ip\0${ip}`), digest(`recovery\0${normalizedEmail}\0${ip}`)];
    const getAttempt = db.prepare('SELECT failures,window_started_at,locked_until FROM auth_login_attempts WHERE attempt_key=?');
    const attempts = keys.map(key => getAttempt.get(key));
    if (attempts.some(attempt => attempt?.locked_until > now)) {
      throw authError('Too many recovery attempts. Try again in 15 minutes.', 429);
    }
    if (!equalText(recoveryToken || '', expected)) {
      keys.forEach(key => recordFailedAttempt(key));
      recordAudit('password_recovery_denied', null, remoteAddress);
      throw authError('Recovery request was not accepted.', 403);
    }

    db.prepare('DELETE FROM auth_login_attempts WHERE attempt_key IN (?,?)').run(...keys);
    const { salt, hash } = await hashPassword(password);
    const recoverTransaction = db.transaction(() => {
      const user = db.prepare('SELECT id FROM auth_users WHERE email=? COLLATE NOCASE').get(normalizedEmail);
      if (user) {
        db.prepare('UPDATE auth_users SET password_salt=?,password_hash=? WHERE id=?').run(salt, hash, user.id);
        db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now, user.id);
      }
      recordAudit(user ? 'password_recovered' : 'password_recovery_no_account', user?.id, remoteAddress);
    });
    recoverTransaction();
    return { ok: true, message: 'If this account is eligible for recovery, its password has been reset. Sign in with the new password.' };
  }

  function requireMemberManager(actor) {
    if (!actor || !['owner', 'admin'].includes(actor.role)) {
      throw authError('Your workspace role cannot manage members.', 403);
    }
  }

  function memberById(id) {
    return db.prepare(`SELECT id,email,role,is_active,created_at,last_login_at,deactivated_at
      FROM auth_users WHERE id=?`).get(id);
  }

  function publicMember(row) {
    return row ? {
      id: row.id,
      email: row.email,
      role: row.role,
      active: row.is_active === 1,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      deactivatedAt: row.deactivated_at,
    } : null;
  }

  function canManageTarget(actor, target) {
    requireMemberManager(actor);
    if (!target) throw authError('Workspace member was not found.', 404);
    if (actor.id === target.id) throw authError('You cannot change or deactivate your own membership.', 409);
    if (target.role === 'owner') throw authError('The workspace owner cannot be changed or deactivated here.', 409);
    if (actor.role === 'admin' && target.role === 'admin') {
      throw authError('Admins cannot change another admin membership.', 403);
    }
  }

  function listMembers() {
    return db.prepare(`SELECT id,email,role,is_active,created_at,last_login_at,deactivated_at
      FROM auth_users ORDER BY CASE WHEN is_active=1 THEN 0 ELSE 1 END,email COLLATE NOCASE`).all().map(publicMember);
  }

  function listInvitations() {
    const now = Date.now();
    return db.prepare(`SELECT id,email,role,created_at,expires_at,accepted_at,revoked_at,
        invited_by,accepted_by,
        CASE WHEN accepted_at IS NOT NULL THEN 'accepted'
             WHEN revoked_at IS NOT NULL THEN 'revoked'
             WHEN expires_at<=? THEN 'expired' ELSE 'pending' END AS status
      FROM auth_invitations ORDER BY created_at DESC,id DESC LIMIT 100`).all(now).map(row => ({
      id: row.id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      revokedAt: row.revoked_at,
      invitedBy: row.invited_by,
      status: row.status,
    }));
  }

  function createInvitation({ actor, email, role, remoteAddress }) {
    requireMemberManager(actor);
    const normalizedEmail = normalizeEmail(email);
    const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
    if (!validEmail(normalizedEmail)) throw authError('Enter a valid invitation email address.', 400);
    if (!INVITABLE_ROLES.has(normalizedRole)) throw authError('Choose admin, operator, or reviewer.', 400);
    if (actor.role === 'admin' && normalizedRole === 'admin') {
      throw authError('Only the workspace owner can invite another admin.', 403);
    }
    const existing = db.prepare('SELECT id,is_active FROM auth_users WHERE email=? COLLATE NOCASE').get(normalizedEmail);
    if (existing?.is_active === 1) throw authError('An active workspace member already uses that email.', 409);

    const token = randomBytes(SESSION_BYTES).toString('base64url');
    const tokenHash = digest(token);
    const now = Date.now();
    const expiresAt = now + INVITATION_TTL_MS;
    const issue = db.transaction(() => {
      db.prepare(`UPDATE auth_invitations SET revoked_at=?
        WHERE email=? COLLATE NOCASE AND accepted_at IS NULL AND revoked_at IS NULL`).run(now, normalizedEmail);
      const result = db.prepare(`INSERT INTO auth_invitations
        (email,token_hash,role,invited_by,created_at,expires_at)
        VALUES (?,?,?,?,?,?)`).run(normalizedEmail, tokenHash, normalizedRole, actor.id, now, expiresAt);
      recordAudit('member_invited', actor.id, remoteAddress);
      return Number(result.lastInsertRowid);
    });
    const id = issue();
    return { invitation: { id, email: normalizedEmail, role: normalizedRole, expiresAt, token } };
  }

  function cancelInvitation({ actor, invitationId, remoteAddress }) {
    requireMemberManager(actor);
    const id = Number(invitationId);
    if (!Number.isSafeInteger(id) || id < 1) throw authError('Invitation ID is invalid.', 400);
    const invitation = db.prepare(`SELECT id,role,invited_by,accepted_at,revoked_at
      FROM auth_invitations WHERE id=?`).get(id);
    if (!invitation) throw authError('Invitation was not found.', 404);
    if (invitation.accepted_at !== null) throw authError('An accepted invitation cannot be cancelled.', 409);
    if (invitation.revoked_at !== null) return { ok: true, changed: false };
    if (actor.role === 'admin' && (invitation.role === 'admin' || invitation.invited_by !== actor.id)) {
      throw authError('Admins can only cancel their own operator or reviewer invitations.', 403);
    }
    db.prepare('UPDATE auth_invitations SET revoked_at=? WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL')
      .run(Date.now(), id);
    recordAudit('invitation_revoked', actor.id, remoteAddress);
    return { ok: true, changed: true };
  }

  function updateMemberRole({ actor, memberId, role, remoteAddress }) {
    requireMemberManager(actor);
    const id = Number(memberId);
    if (!Number.isSafeInteger(id) || id < 1) throw authError('Member ID is invalid.', 400);
    const nextRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
    if (!MEMBER_ROLES.has(nextRole) || nextRole === 'owner') {
      throw authError('Choose admin, operator, or reviewer.', 400);
    }
    const target = memberById(id);
    canManageTarget(actor, target);
    if (actor.role === 'admin' && nextRole === 'admin') {
      throw authError('Only the workspace owner can assign the admin role.', 403);
    }
    if (target.role === nextRole) return { member: publicMember(target), changed: false };
    db.prepare('UPDATE auth_users SET role=? WHERE id=?').run(nextRole, id);
    recordAudit('member_role_changed', actor.id, remoteAddress);
    return { member: publicMember(memberById(id)), changed: true };
  }

  function deactivateMember({ actor, memberId, remoteAddress }) {
    requireMemberManager(actor);
    const id = Number(memberId);
    if (!Number.isSafeInteger(id) || id < 1) throw authError('Member ID is invalid.', 400);
    const target = memberById(id);
    canManageTarget(actor, target);
    if (target.is_active !== 1) return { member: publicMember(target), changed: false };
    const now = Date.now();
    const deactivate = db.transaction(() => {
      db.prepare('UPDATE auth_users SET is_active=0,deactivated_at=? WHERE id=?').run(new Date(now).toISOString(), id);
      db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now, id);
      recordAudit('member_deactivated', actor.id, remoteAddress);
    });
    deactivate();
    return { member: publicMember(memberById(id)), changed: true };
  }

  async function acceptInvitation({ email, password, invitationToken, remoteAddress }) {
    const normalizedEmail = normalizeEmail(email);
    if (!validEmail(normalizedEmail)) throw authError('Enter the email address that received the invitation.', 400);
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      throw authError('Password must be between 12 and 128 characters.', 400);
    }
    const token = typeof invitationToken === 'string' ? invitationToken : '';
    const now = Date.now();
    const ip = remoteAddress || 'unknown';
    const attemptKeyValue = digest(`invitation-accept\0${ip}`);
    const attempt = db.prepare('SELECT failures,window_started_at,locked_until FROM auth_login_attempts WHERE attempt_key=?').get(attemptKeyValue);
    if (attempt?.locked_until > now) throw authError('Too many invitation attempts. Try again in 15 minutes.', 429);

    if (token.length < 32 || token.length > 128) {
      recordFailedAttempt(attemptKeyValue);
      recordAudit('invitation_accept_denied', null, remoteAddress);
      throw authError('Invitation token or email was not accepted.', 403);
    }
    const invitation = db.prepare(`SELECT id,email,role,expires_at FROM auth_invitations
      WHERE token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL`).get(digest(token));
    if (!invitation || invitation.expires_at <= now || invitation.email.toLowerCase() !== normalizedEmail) {
      recordFailedAttempt(attemptKeyValue);
      recordAudit('invitation_accept_denied', null, remoteAddress);
      throw authError('Invitation token or email was not accepted.', 403);
    }
    db.prepare('DELETE FROM auth_login_attempts WHERE attempt_key=?').run(attemptKeyValue);
    const { salt, hash } = await hashPassword(password);
    const accepted = db.transaction(() => {
      const current = db.prepare(`SELECT id,email,role,expires_at FROM auth_invitations
        WHERE id=? AND token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL`).get(invitation.id, digest(token));
      if (!current || current.expires_at <= Date.now() || current.email.toLowerCase() !== normalizedEmail) {
        throw authError('Invitation token or email was not accepted.', 403);
      }
      const existing = db.prepare('SELECT id,is_active FROM auth_users WHERE email=? COLLATE NOCASE').get(normalizedEmail);
      if (existing?.is_active === 1) throw authError('An active workspace account already uses that email.', 409);
      let userId;
      if (existing) {
        userId = existing.id;
        db.prepare(`UPDATE auth_users SET password_salt=?,password_hash=?,role=?,is_active=1,
          deactivated_at=NULL,last_login_at=datetime('now') WHERE id=?`)
          .run(salt, hash, current.role, userId);
        db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(Date.now(), userId);
      } else {
        const result = db.prepare(`INSERT INTO auth_users(email,password_salt,password_hash,role)
          VALUES (?,?,?,?)`).run(normalizedEmail, salt, hash, current.role);
        userId = Number(result.lastInsertRowid);
      }
      const acceptedAt = Date.now();
      db.prepare('UPDATE auth_invitations SET accepted_at=?,accepted_by=? WHERE id=?')
        .run(acceptedAt, userId, current.id);
      db.prepare(`UPDATE auth_invitations SET revoked_at=? WHERE email=? COLLATE NOCASE
        AND id<>? AND accepted_at IS NULL AND revoked_at IS NULL`).run(acceptedAt, normalizedEmail, current.id);
      recordAudit('invitation_accepted', userId, remoteAddress);
      return {
        user: { id: userId, email: normalizedEmail, role: current.role },
      };
    });
    const result = accepted();
    return issueMfaChallenge(result.user.id, remoteAddress, 'invitation', false);
  }

  function authorize(session, method, pathname) {
    if (!session || !MEMBER_ROLES.has(session.role)) return false;
    const verb = String(method || 'GET').toUpperCase();
    const path = String(pathname || '');
    const readOnlyMethod = ['GET', 'HEAD', 'OPTIONS'].includes(verb);
    // Tenant endpoints perform a second authorization check against the
    // signed PostgreSQL membership context and tenant role. Keep this host
    // boundary limited to known active session roles; never infer tenant
    // privileges from the workspace role.
    if (path === '/api/astra/tenants' || path.startsWith('/api/astra/tenants/')) {
      return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb);
    }
    if (session.role === 'owner') return true;
    if (path.startsWith('/api/workspace/invitations') || /^\/api\/workspace\/members\/\d+/.test(path)) {
      return session.role === 'admin';
    }
    if (path === '/api/workspace/members') return readOnlyMethod;
    if (/^\/api\/qualify\/review\/\d+$/.test(path) && verb === 'POST') return MEMBER_ROLES.has(session.role);
    if (path === '/api/qualify/scoring' && !readOnlyMethod) {
      return ['owner', 'admin'].includes(session.role);
    }
    if (/^\/api\/sending\/mailboxes(?:\/\d+)?$/.test(path) && !readOnlyMethod) {
      return ['owner', 'admin'].includes(session.role);
    }
    if (/^\/api\/sending\/mailboxes\/\d+\/warmup-review$/.test(path) && !readOnlyMethod) {
      return ['owner', 'admin'].includes(session.role);
    }
    if (/^\/api\/sending\/mailboxes\/\d+\/send-test$/.test(path) && !readOnlyMethod) {
      return ['owner', 'admin'].includes(session.role);
    }
    if (['/api/sending/control', '/api/sending/schedule'].includes(path) && !readOnlyMethod) {
      return ['owner', 'admin'].includes(session.role);
    }
    if (path === '/api/sending/imap-sync' && !readOnlyMethod) {
      return ['owner', 'admin'].includes(session.role);
    }
    if (session.role === 'admin' || session.role === 'operator') return true;
    if (session.role === 'reviewer') {
      if (!readOnlyMethod) return false;
      if (/^\/api\/sending\/ab\/assign\//.test(path) || path === '/api/personalize/ollama-test') return false;
      return true;
    }
    return false;
  }

  function logout(sessionToken, remoteAddress) {
    if (!sessionToken) return;
    const tokenHash = digest(sessionToken);
    const session = db.prepare('SELECT user_id FROM auth_sessions WHERE token_hash=? AND revoked_at IS NULL').get(tokenHash);
    db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL')
      .run(Date.now(), tokenHash);
    if (session) recordAudit('sign_out', session.user_id, remoteAddress);
  }

  function auditEvents(limit = 50) {
    const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
    return db.prepare(`SELECT e.event_type,e.created_at,u.email AS account_email
      FROM auth_audit_events e LEFT JOIN auth_users u ON u.id=e.user_id
      ORDER BY e.created_at DESC,e.id DESC LIMIT ?`).all(safeLimit);
  }

  return {
    publicStatus, currentSession, verifyCsrf, bootstrap, login, googleLogin, issueGoogleNonce, consumeGoogleNonce,
    checkGoogleTokenAttempt, recordGoogleTokenFailure, clearGoogleTokenFailures, recover, acceptInvitation,
    mfaStatus, beginMfaEnrollment, confirmMfaEnrollment, completeMfaChallenge,
    regenerateMfaRecoveryCodes, disableMfa,
    listMembers, listInvitations, createInvitation, cancelInvitation, updateMemberRole,
    deactivateMember, authorize, logout, auditEvents,
    recordAuditEvent: recordAudit,
  };
}
