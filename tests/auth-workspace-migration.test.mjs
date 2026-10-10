import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthManager } from '../pipeline/auth-manager.js';

test('legacy single-workspace accounts and sessions migrate in place to owner/admin memberships', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'odd-auth-legacy-'));
  const db = new Database(path.join(directory, 'legacy.db'));
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE auth_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT
      );
      CREATE TABLE auth_sessions (
        token_hash TEXT PRIMARY KEY,
        csrf_hash TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
    `);
    db.prepare('INSERT INTO auth_users(email,password_salt,password_hash) VALUES (?,?,?)')
      .run('owner@example.test', 'old-salt', 'old-hash');
    db.prepare('INSERT INTO auth_users(email,password_salt,password_hash) VALUES (?,?,?)')
      .run('second@example.test', 'old-salt-2', 'old-hash-2');
    const sessionToken = 'persisted-session-token';
    db.prepare('INSERT INTO auth_sessions(token_hash,csrf_hash,user_id,created_at,expires_at) VALUES (?,?,?,?,?)')
      .run(createHash('sha256').update(sessionToken).digest('hex'), createHash('sha256').update('csrf-token').digest('hex'), 1, Date.now(), Date.now() + 60_000);

    const auth = createAuthManager(db);
    const members = auth.listMembers();
    assert.deepEqual(members.map(({ email, role, active }) => ({ email, role, active })), [
      { email: 'owner@example.test', role: 'owner', active: true },
      { email: 'second@example.test', role: 'admin', active: true },
    ]);
    assert.deepEqual(db.prepare('SELECT email,google_sub FROM auth_users ORDER BY id').all(), [
      { email: 'owner@example.test', google_sub: null },
      { email: 'second@example.test', google_sub: null },
    ], 'legacy members retain their accounts and are not automatically linked to a Google identity');
    const session = auth.currentSession(sessionToken);
    assert.equal(session.email, 'owner@example.test');
    assert.equal(session.role, 'owner');
    assert.equal(auth.authorize(session, 'POST', '/api/batches'), true);
    assert.equal(auth.authorize({ role: 'owner' }, 'PUT', '/api/sending/control'), true);
    assert.equal(auth.authorize({ role: 'admin' }, 'PUT', '/api/sending/control'), true);
    assert.equal(auth.authorize({ role: 'operator' }, 'PUT', '/api/sending/control'), false,
      'operators can manage campaigns but cannot change the workspace-wide send safety control');
    assert.equal(auth.authorize({ role: 'reviewer' }, 'GET', '/api/sending/control'), true);
    assert.equal(auth.authorize({ role: 'reviewer' }, 'PUT', '/api/sending/control'), false);
    assert.equal(auth.authorize({ role: 'admin' }, 'PUT', '/api/sending/schedule'), true);
    assert.equal(auth.authorize({ role: 'operator' }, 'PUT', '/api/sending/schedule'), false);
    assert.equal(auth.authorize({ role: 'owner' }, 'POST', '/api/sending/mailboxes'), true);
    assert.equal(auth.authorize({ role: 'operator' }, 'POST', '/api/sending/mailboxes'), false);
    assert.equal(auth.authorize({ role: 'operator' }, 'PATCH', '/api/sending/mailboxes/1'), false);
    assert.equal(auth.authorize({ role: 'operator' }, 'POST', '/api/sending/mailboxes/1/test-smtp'), true,
      'operators can still check an existing mailbox without changing its credentials');
    assert.equal(auth.authorize({ role: 'operator' }, 'POST', '/api/sending/mailboxes/1/send-test'), false,
      'only owners and admins can submit a test message to an external recipient');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get().count, 1,
      'migration retains a still-valid legacy session');
    const migratedAuthColumns = new Set(db.prepare('PRAGMA table_info(auth_users)').all().map(column => column.name));
    for (const column of ['mfa_secret_enc', 'mfa_pending_enc', 'mfa_pending_expires_at', 'mfa_pending_failures', 'mfa_enabled_at', 'mfa_last_counter']) {
      assert.ok(migratedAuthColumns.has(column), `legacy account migration adds ${column}`);
    }
    assert.deepEqual(db.prepare('SELECT mfa_secret_enc,mfa_pending_enc,mfa_enabled_at,mfa_last_counter FROM auth_users WHERE id=1').get(), {
      mfa_secret_enc: null, mfa_pending_enc: null, mfa_enabled_at: null, mfa_last_counter: -1,
    }, 'legacy accounts migrate with MFA disabled and an unused replay counter');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_mfa_challenges').get().count, 0,
      'MFA migration creates its challenge table without invalidating existing sessions');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_users WHERE role='owner'").get().count, 1);
    assert.ok(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='auth_invitations'").get().count === 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
