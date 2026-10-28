import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateAstraPlatformFixture } from './support/astra-platform-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qaRoot = path.resolve(root, '.runner/astra-qa');
const fixturePath = process.env.ASTRA_QA_FIXTURE_PATH ? path.resolve(process.env.ASTRA_QA_FIXTURE_PATH) : null;

test('customer inbox and CRM records persist, retry safely, and remain tenant and policy scoped', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to the named disposable synthetic R20 fixture or an approved historical fixture.',
}, async t => {
  const { realpath } = await import('node:fs/promises');
  const [canonicalQaRoot, canonicalFixture] = await Promise.all([realpath(qaRoot), realpath(fixturePath)]);
  const relative = path.relative(canonicalQaRoot, canonicalFixture);
  assert.equal(path.isAbsolute(relative), false, 'fixture must remain below the repository QA root');
  assert.ok(['r18-suite/pg.json', 'r20-source-rights/pg.json'].includes(relative.split(path.sep).join('/')),
    'only the approved R18 suite or canonical R20 source-rights fixture is accepted');
  const fixture = await validateAstraPlatformFixture({ root, fixturePath: canonicalFixture, allowR20: true, labels: 'r18-suite', migrations: 32 });

  const keep = new Set(['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'astra-customer-records-'));
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

  let server; let closeDb;
  try {
    // Install egress guards before importing server or any application module.
    await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
    ({ server } = await import('../server.js'));
    ({ closeDb } = await import('../pipeline/database.js'));
    const { initDb } = await import('../pipeline/database.js');
    const { createAuthManager } = await import('../pipeline/auth-manager.js');
    const authDb = initDb();
    createAuthManager(authDb);
    const isolatedAuthSequence = 1_000_000_000 + randomBytes(4).readUInt32BE(0);
    authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
    authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(isolatedAuthSequence);
    if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let json = {};
      try { json = await response.json(); } catch { /* the error assertion records the status below */ }
      return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: json };
    }
    const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: {
      email: `customer-records-${randomBytes(6).toString('hex')}@example.test`, password: 'Synthetic-customer-records-9!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    } });
    assert.equal(bootstrap.status, 201, bootstrap.body.error);
    const sid = bootstrap.setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
    const csrfCookie = bootstrap.setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
    assert.ok(sid && csrfCookie);
    const session = { cookie: `odd_session=${sid}; odd_csrf=${csrfCookie}`, csrf: decodeURIComponent(csrfCookie) };
    async function createTenant(name) {
      const result = await request('/api/astra/tenants', { method: 'POST', ...session, body: { name } });
      assert.equal(result.status, 201, result.body.error); return result.body.tenant.id;
    }
    const tenantId = await createTenant(`Records ${randomUUID().slice(0, 8)}`);
    const foreignTenantId = await createTenant(`Foreign ${randomUUID().slice(0, 8)}`);
    const source = domain => request(`/api/astra/tenants/${tenantId}/research/snapshots`, { method: 'POST', ...session, body: {
      sourceUrl: `https://${domain}/about`, rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true,
      html: `<html><title>${domain} profile</title><h1>Workspace supplied evidence</h1></html>`, mediaType: 'text/html; charset=utf-8',
    } });
    const accountSnapshot = await source(`north-${randomUUID().slice(0, 8)}.example`);
    const foreignSnapshot = await request(`/api/astra/tenants/${foreignTenantId}/research/snapshots`, { method: 'POST', ...session, body: {
      sourceUrl: `https://foreign-${randomUUID().slice(0, 8)}.example/about`, rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true,
      html: '<html><title>Foreign synthetic account</title></html>', mediaType: 'text/html; charset=utf-8',
    } });
    assert.equal(accountSnapshot.status, 201, accountSnapshot.body.error);
    assert.equal(foreignSnapshot.status, 201, foreignSnapshot.body.error);
    const accountId = accountSnapshot.body.data.account.id;
    const foreignAccountId = foreignSnapshot.body.data.account.id;

    const mailboxCreate = await request(`/api/astra/tenants/${tenantId}/mailboxes`, { method: 'POST', ...session, body: { displayName: 'Synthetic manual inbox', provider: 'manual' } });
    assert.equal(mailboxCreate.status, 201, mailboxCreate.body.error);
    const mailbox = mailboxCreate.body.mailbox;
    assert.equal(mailbox.provider, 'manual');
    assert.deepEqual(mailbox.capabilities, { receive: 'manual_ingest_only', send: 'disabled' });
    const mailboxes = await request(`/api/astra/tenants/${tenantId}/mailboxes`, { cookie: session.cookie });
    assert.equal(mailboxes.status, 200);
    assert.equal(mailboxes.body.outboundTransport, 'disabled');
    assert.equal(mailboxes.body.items.some(item => item.id === mailbox.id), true);

    const message = { mailboxId: mailbox.id, externalThreadId: `thread-${randomUUID()}`, externalMessageId: `message-${randomUUID()}`,
      sender: 'buyer@example.test', recipients: ['owner@example.test'], subject: 'A supplied message', bodyText: 'Synthetic body only.', receivedAt: '2026-10-20T12:00:00.000Z' };
    const imported = await request(`/api/astra/tenants/${tenantId}/inbox/messages`, { method: 'POST', ...session, body: message });
    assert.equal(imported.status, 201, imported.body.error);
    const retry = await request(`/api/astra/tenants/${tenantId}/inbox/messages`, { method: 'POST', ...session, body: message });
    assert.equal(retry.status, 200); assert.equal(retry.body.message.duplicate, true); assert.equal(retry.body.message.id, imported.body.message.id);
    const changed = await request(`/api/astra/tenants/${tenantId}/inbox/messages`, { method: 'POST', ...session, body: { ...message, bodyText: 'Changed body.' } });
    assert.equal(changed.status, 409); assert.match(changed.body.error || '', /different content/i);
    const inbox = await request(`/api/astra/tenants/${tenantId}/inbox/messages?limit=100`, { cookie: session.cookie });
    assert.equal(inbox.status, 200); assert.equal(inbox.body.items.filter(item => item.id === imported.body.message.id).length, 1);
    const foreignMailboxUse = await request(`/api/astra/tenants/${foreignTenantId}/inbox/messages`, { method: 'POST', ...session, body: message });
    assert.equal(foreignMailboxUse.status, 404);

    const mappingBody = { entityType: 'company', entityId: accountId, accountId, externalId: `twenty-${randomUUID()}`,
      fieldAuthority: { externalId: 'human' }, provenance: { source: 'customer_console_manual_assertion', confidence: 'low', fieldAuthority: 'human', verification: 'manual_unverified' } };
    const mapping = await request(`/api/astra/tenants/${tenantId}/crm/mappings`, { method: 'POST', ...session, body: mappingBody });
    assert.equal(mapping.status, 201, mapping.body.error); assert.equal(mapping.body.mapping.entityId, accountId);
    const mappingRetry = await request(`/api/astra/tenants/${tenantId}/crm/mappings`, { method: 'POST', ...session, body: mappingBody });
    assert.equal(mappingRetry.status, 200); assert.equal(mappingRetry.body.mapping.duplicate, true);
    const mappings = await request(`/api/astra/tenants/${tenantId}/crm/mappings`, { cookie: session.cookie });
    assert.equal(mappings.status, 200); assert.equal(mappings.body.items.some(item => item.externalId === mappingBody.externalId), true);
    const foreignMapping = await request(`/api/astra/tenants/${tenantId}/crm/mappings`, { method: 'POST', ...session, body: { ...mappingBody, accountId: foreignAccountId, entityId: foreignAccountId, externalId: `foreign-${randomUUID()}` } });
    assert.equal(foreignMapping.status, 404); assert.match(foreignMapping.body.error || '', /not found in this workspace/i);
    const missingMapping = await request(`/api/astra/tenants/${tenantId}/crm/mappings`, { method: 'POST', ...session, body: { ...mappingBody, accountId: randomUUID(), entityId: randomUUID(), externalId: `missing-${randomUUID()}` } });
    assert.equal(missingMapping.status, 404);
    const conflictingMapping = await request(`/api/astra/tenants/${tenantId}/crm/mappings`, { method: 'POST', ...session, body: { ...mappingBody, entityId: `different-${randomUUID()}`, externalId: `conflict-${randomUUID()}` } });
    assert.equal(conflictingMapping.status, 409); assert.match(conflictingMapping.body.error || '', /conflicts with the selected research account/i);
    const legacyMapping = await request(`/api/astra/tenants/${tenantId}/crm/mappings`, { method: 'POST', ...session, body: { ...mappingBody, accountId: undefined, entityId: `legacy-opaque-${randomUUID()}`, externalId: `legacy-${randomUUID()}` } });
    assert.equal(legacyMapping.status, 201, legacyMapping.body.error, 'legacy opaque company references still work when accountId is omitted');

    const proposalBody = { entityType: 'company', entityId: accountId, accountId, operation: 'create_company', idempotencyKey: `customer-proposal-${randomUUID()}`,
      payload: { name: 'North Studio Synthetic', domainName: 'north.example' }, fieldAuthority: { name: 'human', domainName: 'human' },
      provenance: { source: 'customer_console_manual_proposal', confidence: 'low', fieldAuthority: 'human', verification: 'manual_unverified' } };
    const proposal = await request(`/api/astra/tenants/${tenantId}/crm/outbox`, { method: 'POST', ...session, body: proposalBody });
    assert.equal(proposal.status, 201, proposal.body.error); assert.equal(proposal.body.proposal.state, 'held'); assert.equal(proposal.body.transportEnabled, false);
    const proposalRetry = await request(`/api/astra/tenants/${tenantId}/crm/outbox`, { method: 'POST', ...session, body: proposalBody });
    assert.equal(proposalRetry.status, 200); assert.equal(proposalRetry.body.proposal.duplicate, true); assert.equal(proposalRetry.body.proposal.id, proposal.body.proposal.id);
    const proposalConflict = await request(`/api/astra/tenants/${tenantId}/crm/outbox`, { method: 'POST', ...session, body: { ...proposalBody, payload: { name: 'Different company' } } });
    assert.equal(proposalConflict.status, 409); assert.match(proposalConflict.body.error || '', /idempotency key conflicts/i);
    const foreignProposal = await request(`/api/astra/tenants/${tenantId}/crm/outbox`, { method: 'POST', ...session, body: { ...proposalBody, accountId: foreignAccountId, entityId: foreignAccountId, idempotencyKey: `foreign-${randomUUID()}` } });
    assert.equal(foreignProposal.status, 404);
    const outbox = await request(`/api/astra/tenants/${tenantId}/crm/outbox?limit=100`, { cookie: session.cookie });
    assert.equal(outbox.status, 200); assert.equal(outbox.body.transportEnabled, false);
    assert.equal(outbox.body.items.filter(item => item.id === proposal.body.proposal.id).length, 1);
    assert.equal(outbox.body.items.find(item => item.id === proposal.body.proposal.id).state, 'held');
    const afterRejectedWrites = await request(`/api/astra/tenants/${tenantId}/crm/mappings`, { cookie: session.cookie });
    assert.equal(afterRejectedWrites.body.items.some(item => item.externalId.startsWith('foreign-') || item.externalId.startsWith('missing-') || item.externalId.startsWith('conflict-')), false);
    t.diagnostic(`Inbox and CRM writes persisted on the approved synthetic ${fixture.migrations.length}-migration PostgreSQL fixture; duplicate retries were idempotent, changed retries conflicted, foreign/missing associations were rejected, and policy-closed transport remained disabled.`);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (closeDb) await closeDb();
    rmSync(scratch, { recursive: true, force: true });
  }
});
