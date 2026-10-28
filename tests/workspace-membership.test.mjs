import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-workspace-members-'));
process.env.ODD_DB_PATH = path.join(directory, 'workspace.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'fixture-private-bootstrap-token-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetch(`${base}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual',
  });
  return {
    status: response.status,
    body: (response.headers.get('content-type') || '').includes('json') ? await response.json() : await response.text(),
    setCookie: response.headers.get('set-cookie') || '',
  };
}

function authCookies(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session, 'successful account operations issue a session cookie');
  assert.ok(csrf, 'successful account operations issue a CSRF cookie');
  return { cookie: `odd_session=${session}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

async function bootstrapOwner() {
  await request('/api/auth/status');
  const existing = db.prepare('SELECT COUNT(*) AS count FROM auth_users WHERE email=? COLLATE NOCASE').get('owner@example.test').count > 0;
  if (existing) {
    const login = await request('/api/auth/login', {
      method: 'POST', body: { email: 'owner@example.test', password: 'Owner-fixture-password-9!' },
    });
    assert.equal(login.status, 200);
    return authCookies(login.setCookie);
  }
  const response = await request('/api/auth/bootstrap', {
    method: 'POST',
    body: {
      email: 'owner@example.test',
      password: 'Owner-fixture-password-9!',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.user.role, 'owner');
  return authCookies(response.setCookie);
}

async function invite(actor, email, role) {
  return request('/api/workspace/invitations', {
    method: 'POST', cookie: actor.cookie, csrf: actor.csrf, body: { email, role },
  });
}

async function accept(invitation, email, password = 'Member-fixture-password-8!') {
  return request('/api/auth/invitations/accept', {
    method: 'POST', body: { email, password, invitationToken: invitation.token },
  });
}

test('workspace invitations are hashed, expiring and single-use; reviewer and operator roles are enforced', async () => {
  const owner = await bootstrapOwner();
  const invalidRole = await invite(owner, 'owner-attack@example.test', 'owner');
  assert.equal(invalidRole.status, 400, 'owner status cannot be granted through an invitation');

  const issued = await invite(owner, 'operator@example.test', 'operator');
  assert.equal(issued.status, 201);
  const invitation = issued.body.invitation;
  assert.equal(invitation.email, 'operator@example.test');
  assert.equal(invitation.role, 'operator');
  assert.equal(invitation.token.length, 43);
  const stored = db.prepare('SELECT token_hash,expires_at FROM auth_invitations WHERE id=?').get(invitation.id);
  assert.equal(stored.token_hash, createHash('sha256').update(invitation.token).digest('hex'));
  assert.notEqual(stored.token_hash, invitation.token);
  assert.ok(stored.expires_at > Date.now());
  const listed = await request('/api/workspace/invitations', { cookie: owner.cookie });
  assert.equal(listed.status, 200);
  assert.equal('token' in listed.body.invitations[0], false, 'listing never returns the one-time token');

  const wrongEmail = await accept(invitation, 'someone-else@example.test');
  assert.equal(wrongEmail.status, 403);
  const concurrentAccepts = await Promise.all([
    accept(invitation, invitation.email),
    accept(invitation, invitation.email),
  ]);
  assert.deepEqual(concurrentAccepts.map(row => row.status).sort(), [201, 403], 'only one concurrent token redemption wins');
  const operatorResult = concurrentAccepts.find(row => row.status === 201);
  const operator = authCookies(operatorResult.setCookie);
  const { createAuthManager } = await import('../pipeline/auth-manager.js');
  const roleChecks = createAuthManager(db);
  assert.equal(roleChecks.authorize({ role: 'operator' }, 'PATCH', '/api/sending/mailboxes/1'), false,
    'IMAP settings and credentials are owner/admin-managed');
  assert.equal(roleChecks.authorize({ role: 'operator' }, 'POST', '/api/sending/mailboxes/1/warmup-review'), false,
    'operators cannot approve mailbox campaign-sending readiness');
  assert.equal(roleChecks.authorize({ role: 'admin' }, 'POST', '/api/sending/mailboxes/1/warmup-review'), true,
    'admins can review mailbox campaign-sending readiness');
  assert.equal(roleChecks.authorize({ role: 'operator' }, 'POST', '/api/sending/mailboxes/1/warmup-review'), false,
    'operators cannot approve mailbox campaign-sending readiness');
  assert.equal(roleChecks.authorize({ role: 'admin' }, 'POST', '/api/sending/mailboxes/1/warmup-review'), true,
    'admins can review mailbox campaign-sending readiness');
  assert.equal(roleChecks.authorize({ role: 'operator' }, 'POST', '/api/sending/mailboxes/1/test-imap'), true,
    'operators can verify a configured mailbox without changing its settings');
  assert.equal(roleChecks.authorize({ role: 'operator' }, 'POST', '/api/sending/mailboxes/1/sync-imap'), true,
    'operators can run manual read-only intake');
  assert.equal(roleChecks.authorize({ role: 'operator' }, 'GET', '/api/sending/imap-sync'), true,
    'operators can inspect automatic inbox-sync status');
  assert.equal(roleChecks.authorize({ role: 'operator' }, 'PUT', '/api/sending/imap-sync'), false,
    'only owners and admins can enable background mailbox access');
  assert.equal(operatorResult.body.user.role, 'operator');
  assert.equal((await request('/api/auth/status', { cookie: operator.cookie })).body.user.role, 'operator');

  assert.equal((await request('/api/workspace/members', { cookie: operator.cookie })).status, 200);
  assert.equal((await request('/api/workspace/invitations', { cookie: operator.cookie })).status, 403);
  assert.equal((await invite(operator, 'denied@example.test', 'reviewer')).status, 403);
  assert.equal((await accept(invitation, invitation.email)).status, 403, 'accepted tokens cannot be replayed');
  const operatorWrite = await request('/api/batches', {
    method: 'POST', cookie: operator.cookie, csrf: operator.csrf, body: { name: 'Operator-created fixture' },
  });
  assert.equal(operatorWrite.status, 201, 'operators can use product actions behind existing send safeguards');

  const reviewerInvite = (await invite(owner, 'reviewer@example.test', 'reviewer')).body.invitation;
  const reviewerResult = await accept(reviewerInvite, reviewerInvite.email);
  assert.equal(reviewerResult.status, 201);
  const reviewer = authCookies(reviewerResult.setCookie);
  assert.equal(reviewerResult.body.user.role, 'reviewer');
  assert.equal(roleChecks.authorize({ role: 'reviewer' }, 'POST', '/api/sending/mailboxes/1/test-imap'), false);
  assert.equal(roleChecks.authorize({ role: 'reviewer' }, 'POST', '/api/sending/mailboxes/1/sync-imap'), false);
  assert.equal(roleChecks.authorize({ role: 'reviewer' }, 'PUT', '/api/sending/imap-sync'), false);
  assert.equal((await request('/api/batches', { cookie: reviewer.cookie })).status, 200, 'reviewers retain read access');
  const batchesBefore = db.prepare('SELECT COUNT(*) AS count FROM batches').get().count;
  const reviewerWrite = await request('/api/batches', {
    method: 'POST', cookie: reviewer.cookie, csrf: reviewer.csrf, body: { name: 'Reviewer write must fail' },
  });
  assert.equal(reviewerWrite.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM batches').get().count, batchesBefore);
  assert.equal((await invite(reviewer, 'no-access@example.test', 'operator')).status, 403);

  const expiredInvite = (await invite(owner, 'expired@example.test', 'reviewer')).body.invitation;
  db.prepare('UPDATE auth_invitations SET expires_at=0 WHERE id=?').run(expiredInvite.id);
  assert.equal((await accept(expiredInvite, expiredInvite.email)).status, 403);
  const expiration = (await request('/api/workspace/invitations', { cookie: owner.cookie })).body.invitations
    .find(row => row.id === expiredInvite.id);
  assert.equal(expiration.status, 'expired');
  assert.ok(db.prepare("SELECT COUNT(*) AS count FROM auth_audit_events WHERE event_type='member_invited'").get().count >= 3);
});

test('admin limits, immediate role changes, deactivation and invitation-based reactivation preserve identity history', async () => {
  const owner = await bootstrapOwner();
  const adminInvitation = (await invite(owner, 'admin@example.test', 'admin')).body.invitation;
  const adminResult = await accept(adminInvitation, adminInvitation.email);
  assert.equal(adminResult.status, 201);
  const admin = authCookies(adminResult.setCookie);
  assert.equal(adminResult.body.user.role, 'admin');
  assert.equal((await invite(admin, 'second-admin@example.test', 'admin')).status, 403);

  const memberInvitation = (await invite(admin, 'operator2@example.test', 'operator')).body.invitation;
  const memberResult = await accept(memberInvitation, memberInvitation.email);
  assert.equal(memberResult.status, 201);
  const member = authCookies(memberResult.setCookie);
  const memberId = memberResult.body.user.id;

  const ownerRoleChange = await request('/api/workspace/members/1', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { role: 'operator' },
  });
  assert.equal(ownerRoleChange.status, 409, 'an admin cannot demote the owner');
  const selfRemoval = await request(`/api/workspace/members/${adminResult.body.user.id}`, {
    method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf,
  });
  assert.equal(selfRemoval.status, 409, 'an administrator cannot invalidate their own active operation');

  const demoted = await request(`/api/workspace/members/${memberId}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { role: 'reviewer' },
  });
  assert.equal(demoted.status, 200);
  assert.equal((await request('/api/auth/status', { cookie: member.cookie })).body.user.role, 'reviewer');
  const demotedWrite = await request('/api/batches', {
    method: 'POST', cookie: member.cookie, csrf: member.csrf, body: { name: 'Demoted operator write' },
  });
  assert.equal(demotedWrite.status, 403, 'existing sessions use the current persisted role');

  const reactivatedRole = await request(`/api/workspace/members/${memberId}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { role: 'operator' },
  });
  assert.equal(reactivatedRole.status, 200);
  const removed = await request(`/api/workspace/members/${memberId}`, {
    method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.member.active, false);
  assert.equal((await request('/api/batches', { cookie: member.cookie })).status, 401, 'deactivation revokes existing sessions');
  assert.equal(db.prepare('SELECT is_active FROM auth_users WHERE id=?').get(memberId).is_active, 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=? AND revoked_at IS NOT NULL').get(memberId).count >= 1);

  const reactivationInvite = (await invite(owner, 'operator2@example.test', 'reviewer')).body.invitation;
  const reactivated = await accept(reactivationInvite, reactivationInvite.email, 'Reactivated-fixture-password-7!');
  assert.equal(reactivated.status, 201);
  assert.equal(reactivated.body.user.id, memberId, 'reactivation preserves the original member identity');
  assert.equal(reactivated.body.user.role, 'reviewer');
  assert.equal(db.prepare('SELECT is_active,role,deactivated_at FROM auth_users WHERE id=?').get(memberId).is_active, 1);
  assert.equal((await request('/api/workspace/members', { cookie: owner.cookie })).body.members.find(row => row.id === memberId).active, true);

  const ownerDeactivate = await request('/api/workspace/members/1', {
    method: 'DELETE', cookie: owner.cookie, csrf: owner.csrf,
  });
  assert.equal(ownerDeactivate.status, 409, 'the sole owner cannot be removed without a separately implemented ownership transfer');
  for (const eventType of ['member_invited', 'invitation_accepted', 'member_role_changed', 'member_deactivated']) {
    assert.ok(db.prepare('SELECT COUNT(*) AS count FROM auth_audit_events WHERE event_type=?').get(eventType).count > 0, `${eventType} is audited`);
  }
});
