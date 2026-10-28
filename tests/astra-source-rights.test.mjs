import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { copyFile, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readAstraSourceRights } from '../pipeline/astra-source-rights.js';
import { astraR20UpHashes, validateAstraR20Fixture } from './support/astra-r20-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qaRoot = path.join(root, '.runner', 'astra-qa');
const fixtureInput = process.env.ASTRA_QA_FIXTURE_PATH;
const fixturePath = fixtureInput ? path.resolve(fixtureInput) : null;

test('source-rights helper projects only persisted permitted, revoked, expired and unavailable states', async () => {
  const tenantId = '10000000-0000-4000-8000-000000000001';
  const sourceIds = [
    '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000004',
  ];
  const [permittedId, expiredId, revokedId, missingId] = sourceIds;
  const persisted = new Map([
    [permittedId, { sourceId: permittedId, sourceUrl: 'https://permitted.example.test/', rightsPolicy: 'licensed', rightsExpiresAt: null, rightsAttested: true, robotsAllowed: true, expired: false, revokedAt: null, revocationEventId: null, reason: null }],
    [expiredId, { sourceId: expiredId, sourceUrl: 'https://expired.example.test/', rightsPolicy: 'licensed', rightsExpiresAt: new Date(0), rightsAttested: true, robotsAllowed: true, expired: true, revokedAt: null, revocationEventId: null, reason: null }],
    [revokedId, { sourceId: revokedId, sourceUrl: 'https://revoked.example.test/', rightsPolicy: 'licensed', rightsExpiresAt: null, rightsAttested: true, robotsAllowed: true, expired: false, revokedAt: new Date(), revocationEventId: randomUUID(), reason: 'withdrawn' }],
  ]);
  const client = { query: async (_sql, values) => ({ rows: values[1].map(id => persisted.get(id)).filter(Boolean) }) };
  const rights = await readAstraSourceRights(client, tenantId, sourceIds);
  assert.deepEqual(sourceIds.map(id => rights.get(id).status), ['permitted', 'expired', 'revoked', 'unavailable']);
  assert.deepEqual(sourceIds.map(id => rights.get(id).usable), [true, false, false, false]);
  assert.equal(rights.get(missingId).found, false);
});

test('source-rights expiry uses the later of database time and the supplied audit clock', async () => {
  const tenantId = '10000000-0000-4000-8000-000000000001';
  const sourceId = '20000000-0000-4000-8000-000000000001';
  const at = new Date('2026-10-26T08:00:00.000Z');
  let queryText;
  let queryValues;
  const client = { query: async (sql, values) => {
    queryText = sql;
    queryValues = values;
    return { rows: [{ sourceId, sourceUrl: 'https://expired.example.test/', rightsPolicy: 'licensed',
      rightsExpiresAt: new Date('2026-10-26T08:30:00.000Z'), rightsAttested: true, robotsAllowed: true,
      expired: true, revokedAt: null, revocationEventId: null, reason: null }] };
  } };

  const rights = await readAstraSourceRights(client, tenantId, [sourceId], { at });
  assert.match(queryText, /GREATEST\(statement_timestamp\(\),\s*\$3::timestamptz\)/);
  assert.equal(queryValues[2], at);
  assert.equal(rights.get(sourceId).status, 'expired');
  assert.equal(rights.get(sourceId).usable, false);
});

test('R20 fixture validator accepts only a contained synthetic fixture with pinned metadata before any DB is opened', async t => {
  const scratchRoot = mkdtempSync(path.join(os.tmpdir(), 'astra-r20-fixture-validator-'));
  const canonicalDir = path.join(scratchRoot, '.runner', 'astra-qa', 'r20-source-rights');
  const migrationDir = path.join(scratchRoot, 'migrations', 'astra');
  await mkdir(canonicalDir, { recursive: true });
  await mkdir(migrationDir, { recursive: true });
  try {
    const sourceMigrationDir = path.join(root, 'migrations', 'astra');
    const migrationFiles = (await readdir(sourceMigrationDir)).filter(name => /^\d{3}-.+\.up\.sql$/.test(name)).sort();
    assert.equal(migrationFiles.length, 37);
    for (const file of migrationFiles) await copyFile(path.join(sourceMigrationDir, file), path.join(migrationDir, file));
    const suffix = '12ab34cd';
    const databaseName = `odd_astra_qa_r20_source_rights_${suffix}`;
    const port = 49876;
    const makeUrl = role => `postgresql://${role}:synthetic-only@127.0.0.1:${port}/${databaseName}`;
    const valid = {
      mode: 'disposable-synthetic-qa', clusterFixture: '/var/tmp/odd-astra-qa-pg-synthetic-validator',
      parentPreviewFixture: '/var/tmp/odd-astra-preview-pg-synthetic-validator',
      binary: '/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/postgresql/16/bin',
      libraryPath: '/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/x86_64-linux-gnu', databaseName, port,
      clockAlignmentMode: 'monitored-disposable-process-only',
      label: 'r20-source-rights', connectionString: makeUrl(`astra_qa_app_r20_source_rights_${suffix}`),
      workerConnectionString: makeUrl(`astra_qa_worker_r20_source_rights_${suffix}`), contextSecret: randomBytes(32).toString('hex'),
      migrations: migrationFiles.map((file, index) => ({ file, sha256: astraR20UpHashes[index] })),
      previewClockOffsetSeconds: 0, realData: false,
    };
    const canonicalPath = path.join(canonicalDir, 'pg.json');
    const writeFixture = fixture => writeFile(canonicalPath, JSON.stringify(fixture));
    await writeFixture(valid);
    const accepted = await validateAstraR20Fixture({ root: scratchRoot, fixturePath: canonicalPath });
    assert.equal(accepted.label, 'r20-source-rights');
    const legacy = { ...valid };
    delete legacy.clockAlignmentMode;
    await writeFixture(legacy);
    assert.equal((await validateAstraR20Fixture({ root: scratchRoot, fixturePath: canonicalPath })).label, 'r20-source-rights', 'clock alignment metadata remains optional');

    const invalidCases = [
      ['wrong mode', { ...valid, mode: 'production' }],
      ['real data enabled', { ...valid, realData: true }],
      ['wrong label', { ...valid, label: 'r18-suite' }],
      ['metadata port mismatch', { ...valid, port: port + 1 }],
      ['database mismatch', { ...valid, databaseName: 'odd_astra_qa_unrelated_12345678' }],
      ['wrong role pair', { ...valid, workerConnectionString: valid.connectionString }],
      ['connection query options', { ...valid, connectionString: `${valid.connectionString}?sslmode=disable` }],
      ['unpinned migration hash', { ...valid, migrations: valid.migrations.map((entry, index) => index === 0 ? { ...entry, sha256: '0'.repeat(64) } : entry) }],
      ['wrong clock alignment mode', { ...valid, clockAlignmentMode: 'arbitrary-clock-mode' }],
      ['clock offset out of range', { ...valid, previewClockOffsetSeconds: 86401 }],
      ['clock offset not an integer', { ...valid, previewClockOffsetSeconds: 1.5 }],
    ];
    for (const [name, fixture] of invalidCases) {
      await writeFixture(fixture);
      await t.test(name, async () => {
        await assert.rejects(() => validateAstraR20Fixture({ root: scratchRoot, fixturePath: canonicalPath }));
      });
    }
    const escapedPath = path.join(scratchRoot, 'outside-qa', 'pg.json');
    await mkdir(path.dirname(escapedPath), { recursive: true });
    await writeFile(escapedPath, JSON.stringify(valid));
    await t.test('escaped fixture path', async () => {
      await assert.rejects(() => validateAstraR20Fixture({ root: scratchRoot, fixturePath: escapedPath }));
    });
    t.diagnostic('Validator negatives used a temporary synthetic copy of the 37 pinned UP files and metadata-only fake credentials; no database connection was opened and the real named fixture was not read or modified.');
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
});

test('source rights revocations persist, remain append-only, and enforce tenant and role boundaries', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to .runner/astra-qa/r20-source-rights/pg.json for the fresh disposable synthetic 33-migration fixture.',
}, async t => {
  assert.ok(fixturePath, 'fixture path is required');
  const [canonicalQaRoot, canonicalFixture] = await Promise.all([realpath(qaRoot), realpath(fixturePath)]);
  const relative = path.relative(canonicalQaRoot, canonicalFixture);
  assert.equal(path.isAbsolute(relative), false, 'fixture must remain below repository QA root');
  assert.equal(relative.split(path.sep).join('/'), 'r20-source-rights/pg.json', 'only the canonical named fixture is accepted');
  const fixture = await validateAstraR20Fixture({ root, fixturePath: canonicalFixture });

  const keep = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'astra-source-rights-'));
  process.env.ODD_DB_PATH = path.join(scratch, 'auth.sqlite');
  process.env.NODE_ENV = 'test';
  process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
  process.env.ODD_AUTH_BOOTSTRAP_TOKEN = randomBytes(24).toString('hex');
  process.env.ODD_AUTH_COOKIE_SECURE = 'false';
  process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1';
  process.env.ASTRA_DATABASE_URL = fixture.connectionString;
  process.env.ASTRA_WORKER_DATABASE_URL = fixture.workerConnectionString;
  process.env.ASTRA_CONTEXT_SECRET = fixture.contextSecret;
  process.env.ASTRA_TENANT_MODE = '1'; process.env.ASTRA_LEGACY_OFFER_BRIDGE = '1';
  process.env.LOCAL_PREVIEW = '1'; process.env.ASTRA_LIVE_ACTIONS = 'disabled';
  process.env.ASTRA_GLOBAL_PROVIDER_DECISION = 'unapproved';

  let server;
  let closeDb;
  let setupStore;
  let workerStore;
  try {
    await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
    ({ server } = await import('../server.js'));
    const database = await import('../pipeline/database.js');
    ({ closeDb } = database);
    const authDb = database.initDb();
    const { createAuthManager } = await import('../pipeline/auth-manager.js');
    const auth = createAuthManager(authDb);
    const isolatedAuthSequence = 1_000_000_000 + randomBytes(4).readUInt32BE(0);
    authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
    authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(isolatedAuthSequence);
    const { createAstraTenantStore } = await import('../pipeline/astra-tenant-store.js');
    if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let json = {};
      try { json = await response.json(); } catch { /* status assertion carries the useful failure */ }
      return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: json };
    }
    const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: {
      email: `astra-rights-${randomBytes(6).toString('hex')}@example.test`, password: 'Synthetic-source-rights-9!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    } });
    assert.equal(bootstrap.status, 201, bootstrap.body.error);
    const ownerId = Number(bootstrap.body.user.id);
    const sid = bootstrap.setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
    const csrfCookie = bootstrap.setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
    assert.ok(sid && csrfCookie);
    const owner = { cookie: `odd_session=${sid}; odd_csrf=${csrfCookie}`, csrf: decodeURIComponent(csrfCookie) };
    const tenantResult = await request('/api/astra/tenants', { method: 'POST', ...owner, body: { name: `Source rights ${randomUUID().slice(0, 8)}` } });
    const foreignTenantResult = await request('/api/astra/tenants', { method: 'POST', ...owner, body: { name: `Foreign rights ${randomUUID().slice(0, 8)}` } });
    assert.equal(tenantResult.status, 201, tenantResult.body.error);
    assert.equal(foreignTenantResult.status, 201, foreignTenantResult.body.error);
    const tenantId = tenantResult.body.tenant.id;
    const foreignTenantId = foreignTenantResult.body.tenant.id;

    async function addMember(role) {
      const email = `rights-${role}-${randomBytes(6).toString('hex')}@example.test`;
      const globalInvite = auth.createInvitation({ actor: { id: ownerId, role: 'owner' }, email, role: 'reviewer' }).invitation;
      const accepted = await auth.acceptInvitation({ email, password: 'Synthetic-member-pass-9!', invitationToken: globalInvite.token, remoteAddress: '127.0.0.1' });
      const userId = String(authDb.prepare('SELECT id FROM auth_users WHERE email = ?').get(email).id);
      const session = { cookie: `odd_session=${accepted.sessionToken}; odd_csrf=${accepted.csrfToken}`, csrf: accepted.csrfToken };
      const invite = await request(`/api/astra/tenants/${tenantId}/memberships/invitations`, { method: 'POST', ...owner, body: { email, role } });
      assert.equal(invite.status, 201, invite.body.error);
      const joined = await request('/api/astra/invitations/accept', { method: 'POST', ...session, body: { token: invite.body.token } });
      assert.equal(joined.status, 200, joined.body.error);
      return { ...session, userId };
    }
    const admin = await addMember('admin');
    const operator = await addMember('operator');
    const reviewer = await addMember('reviewer');

    async function capture(targetTenantId, label) {
      const result = await request(`/api/astra/tenants/${targetTenantId}/research/snapshots`, { method: 'POST', ...owner, body: {
        sourceUrl: `https://${label}-${randomUUID().slice(0, 8)}.example.test/about`, rightsPolicy: 'synthetic_fixture', rightsAttested: true,
        robotsAllowed: true, html: `<html><title>${label} fixture</title><h1>Synthetic evidence</h1></html>`, mediaType: 'text/html; charset=utf-8',
      } });
      assert.equal(result.status, 201, result.body.error);
      return result.body.data.evidence;
    }
    const ownerEvidence = await capture(tenantId, 'owner');
    const adminEvidence = await capture(tenantId, 'admin');
    const operatorEvidence = await capture(tenantId, 'operator');
    const reviewerEvidence = await capture(tenantId, 'reviewer');
    const foreignEvidence = await capture(foreignTenantId, 'foreign');
    const rightsRoute = id => `/api/astra/tenants/${tenantId}/research/sources/${id}/rights`;
    const revokeRoute = id => `/api/astra/tenants/${tenantId}/research/sources/${id}/rights-revocations`;

    const initial = await request(rightsRoute(ownerEvidence.sourceId), { cookie: owner.cookie });
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.data, {
      sourceId: ownerEvidence.sourceId, sourceUrl: ownerEvidence.sourceUrl, rightsPolicy: 'synthetic_fixture',
      rightsExpiresAt: null, effectiveRightsStatus: 'permitted', usable: true, revokedAt: null, revocationEventId: null, reason: null,
    });
    const unknown = await request(rightsRoute(randomUUID()), { cookie: owner.cookie });
    const foreign = await request(rightsRoute(foreignEvidence.sourceId), { cookie: owner.cookie });
    assert.equal(unknown.status, 404);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, unknown.body, 'foreign and missing source responses do not reveal existence');
    assert.equal((await request(rightsRoute(ownerEvidence.sourceId), { cookie: reviewer.cookie })).status, 200);

    const noCsrf = await request(revokeRoute(ownerEvidence.sourceId), { method: 'POST', cookie: owner.cookie, body: { reason: 'synthetic withdrawal', idempotencyKey: randomUUID() } });
    assert.equal(noCsrf.status, 403, 'CSRF protection rejects revocation without the verified token');
    const writeBody = { reason: 'Rights were withdrawn by the synthetic source owner.', idempotencyKey: `source-rights-${randomUUID()}` };
    const operatorDenied = await request(revokeRoute(operatorEvidence.sourceId), { method: 'POST', ...operator, body: { ...writeBody, idempotencyKey: randomUUID() } });
    const reviewerDenied = await request(revokeRoute(reviewerEvidence.sourceId), { method: 'POST', ...reviewer, body: { ...writeBody, idempotencyKey: randomUUID() } });
    assert.equal(operatorDenied.status, 403);
    assert.equal(reviewerDenied.status, 403);
    assert.equal((await request(rightsRoute(operatorEvidence.sourceId), { cookie: operator.cookie })).body.data.usable, true);
    assert.equal((await request(rightsRoute(reviewerEvidence.sourceId), { cookie: reviewer.cookie })).body.data.usable, true);

    const spoofed = await request(revokeRoute(ownerEvidence.sourceId), { method: 'POST', ...owner, body: { ...writeBody, actorId: '999' } });
    assert.equal(spoofed.status, 400);
    const badReason = await request(revokeRoute(ownerEvidence.sourceId), { method: 'POST', ...owner, body: { reason: ' ', idempotencyKey: randomUUID() } });
    assert.equal(badReason.status, 400);
    const tooLong = await request(revokeRoute(ownerEvidence.sourceId), { method: 'POST', ...owner, body: { reason: 'x'.repeat(1001), idempotencyKey: randomUUID() } });
    assert.equal(tooLong.status, 400);
    const foreignWrite = await request(revokeRoute(foreignEvidence.sourceId), { method: 'POST', ...owner, body: { ...writeBody, idempotencyKey: randomUUID() } });
    assert.equal(foreignWrite.status, 404);

    const evidenceContent = async evidenceId => request(`/api/astra/tenants/${tenantId}/research/evidence/${evidenceId}/content`, { cookie: owner.cookie });
    const beforeHistory = await evidenceContent(ownerEvidence.id);
    assert.equal(beforeHistory.status, 200);
    const retryBody = { reason: 'The rights holder withdrew permission.', idempotencyKey: `concurrent-${randomUUID()}` };
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => request(revokeRoute(ownerEvidence.sourceId), { method: 'POST', ...owner, body: retryBody })));
    assert.deepEqual(concurrent.map(x => x.status).sort(), [200, 200, 200, 200, 200, 201]);
    const events = new Set(concurrent.map(x => x.body.data.revocationEventId));
    assert.equal(events.size, 1, 'concurrent idempotent retries share exactly one immutable event');
    assert.equal(concurrent.filter(x => x.body.data.duplicate === false).length, 1);
    assert.equal(concurrent.filter(x => x.body.data.duplicate === true).length, 5);
    const conflict = await request(revokeRoute(ownerEvidence.sourceId), { method: 'POST', ...owner, body: { ...retryBody, reason: 'Different reason with same idempotency key.' } });
    assert.equal(conflict.status, 409);
    const readRevoked = await request(rightsRoute(ownerEvidence.sourceId), { cookie: owner.cookie });
    assert.equal(readRevoked.status, 200);
    assert.equal(readRevoked.body.data.effectiveRightsStatus, 'revoked');
    assert.equal(readRevoked.body.data.usable, false);
    assert.equal(readRevoked.body.data.revocationEventId, [...events][0]);
    assert.equal(readRevoked.body.data.reason, retryBody.reason);
    const afterHistory = await evidenceContent(ownerEvidence.id);
    assert.equal(afterHistory.body.data.contentBase64, beforeHistory.body.data.contentBase64, 'captured historical evidence bytes remain unchanged');

    const adminWrite = await request(revokeRoute(adminEvidence.sourceId), { method: 'POST', ...admin, body: { reason: 'Admin test revocation.', idempotencyKey: `admin-${randomUUID()}` } });
    assert.equal(adminWrite.status, 201, adminWrite.body.error);
    assert.equal((await request(rightsRoute(adminEvidence.sourceId), { cookie: admin.cookie })).body.data.effectiveRightsStatus, 'revoked');

    setupStore = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
    const appMutation = await setupStore.withTenant({ tenantId, userId: String(ownerId) }, async db => {
      const errors = [];
      for (const [sql, values] of [
        ['UPDATE astra.research_source_rights_revocations SET reason = $3 WHERE tenant_id = $1::uuid AND id = $2::uuid', [tenantId, [...events][0], 'attempted mutation']],
        ['DELETE FROM astra.research_source_rights_revocations WHERE tenant_id = $1::uuid AND id = $2::uuid', [tenantId, [...events][0]]],
      ]) {
        await db.query('SAVEPOINT expected_privilege_denial');
        try { await db.query(sql, values); errors.push(null); }
        catch (error) { errors.push(error.code); await db.query('ROLLBACK TO SAVEPOINT expected_privilege_denial'); }
        await db.query('RELEASE SAVEPOINT expected_privilege_denial');
      }
      const evidenceUpdate = await db.query('SELECT id FROM astra.research_evidence WHERE tenant_id = $1::uuid AND id = $2::uuid', [tenantId, ownerEvidence.id]);
      assert.equal(evidenceUpdate.rows.length, 1);
      const { readAstraSourceRights } = await import('../pipeline/astra-source-rights.js');
      const unknownSourceId = randomUUID();
      const helper = await readAstraSourceRights(db, tenantId, [ownerEvidence.sourceId, foreignEvidence.sourceId, unknownSourceId]);
      assert.equal(helper.get(ownerEvidence.sourceId).status, 'revoked');
      assert.equal(helper.get(ownerEvidence.sourceId).usable, false);
      assert.equal(helper.get(foreignEvidence.sourceId).found, false, 'foreign IDs have no usable source metadata');
      assert.equal(helper.get(foreignEvidence.sourceId).usable, false);
      assert.equal(helper.get(unknownSourceId).status, 'unavailable');
      return errors;
    });
    assert.deepEqual(appMutation, ['42501', '42501'], 'application role has no mutation privileges for revocation events');

    workerStore = createAstraTenantStore({ connectionString: fixture.workerConnectionString, contextSecret: fixture.contextSecret });
    const workerCheck = await workerStore.withWorkerTenant({ tenantId, userId: String(ownerId) }, async db => {
      const visible = await db.query('SELECT id, reason FROM astra.research_source_rights_revocations WHERE tenant_id = $1::uuid AND source_id = $2::uuid', [tenantId, ownerEvidence.sourceId]);
      const privileges = await db.query(`SELECT has_table_privilege(current_user, 'astra.research_source_rights_revocations', 'SELECT') AS can_read,
        has_table_privilege(current_user, 'astra.research_source_rights_revocations', 'INSERT') AS can_insert,
        has_table_privilege(current_user, 'astra.research_source_rights_revocations', 'UPDATE') AS can_update,
        has_table_privilege(current_user, 'astra.research_source_rights_revocations', 'DELETE') AS can_delete,
        has_table_privilege(current_user, 'astra.research_source_rights_revocations', 'TRUNCATE') AS can_truncate`);
      let insertCode = null;
      await db.query('SAVEPOINT expected_worker_denial');
      try { await db.query('INSERT INTO astra.research_source_rights_revocations(tenant_id,source_id,idempotency_key,reason,created_by) VALUES($1::uuid,$2::uuid,$3,$4,$5)', [tenantId, ownerEvidence.sourceId, randomUUID(), 'Worker must not revoke.', String(ownerId)]); }
      catch (error) { insertCode = error.code; await db.query('ROLLBACK TO SAVEPOINT expected_worker_denial'); }
      await db.query('RELEASE SAVEPOINT expected_worker_denial');
      return { visible: visible.rows, privileges: privileges.rows[0], insertCode };
    });
    assert.equal(workerCheck.visible.length, 1, 'worker role can see the tenant revocation needed for safe read decisions');
    assert.deepEqual(workerCheck.privileges, { can_read: true, can_insert: false, can_update: false, can_delete: false, can_truncate: false });
    assert.equal(workerCheck.insertCode, '42501', 'worker cannot create revocations');

    const newCapture = await capture(tenantId, 'new-explicit-grant');
    assert.equal((await request(rightsRoute(ownerEvidence.sourceId), { cookie: owner.cookie })).body.data.effectiveRightsStatus, 'revoked');
    assert.equal((await request(rightsRoute(newCapture.sourceId), { cookie: owner.cookie })).body.data.effectiveRightsStatus, 'permitted', 'a new captured source has its own attestation and cannot restore the older source');
    assert.equal((await request(rightsRoute(randomUUID()), { cookie: owner.cookie })).status, 404);

    process.stdout.write(`${JSON.stringify({ fixtureMode: fixture.mode, label: fixture.label, migrations: fixture.migrations.length, realData: false,
      checks: ['owner and admin revocation', 'operator and reviewer denial', 'CSRF', 'tenant and foreign source isolation', 'idempotent concurrency and conflict',
        'append-only history bytes', 'worker read-only visibility', 'new capture does not restore revoked source'] }, null, 2)}\n`);
    t.diagnostic('Source rights revocations were verified through the authenticated API and both PostgreSQL roles on the explicit synthetic 33-migration fixture.');
  } finally {
    await new Promise(resolve => server?.close(resolve) || resolve());
    await setupStore?.close();
    await workerStore?.close();
    await closeDb?.();
    try { await import('node:fs/promises').then(fs => fs.rm(scratch, { recursive: true, force: true })); } catch { /* isolated auth scratch is test-only */ }
  }
});
