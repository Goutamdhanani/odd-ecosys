import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateAstraPlatformFixture } from './support/astra-platform-fixture.mjs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = process.env.ASTRA_QA_FIXTURE_PATH ? path.resolve(process.env.ASTRA_QA_FIXTURE_PATH) : null;
const qaRoot = path.resolve(root, '.runner/astra-qa');

test('authenticated outcomes correction and reversal preserve tenant-scoped ledger behavior', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to a prepared synthetic QA fixture at .runner/astra-qa/<label>/pg.json.',
}, async () => {
  const { readFile, realpath } = await import('node:fs/promises');
  const [canonicalQaRoot, canonicalFixturePath] = await Promise.all([realpath(qaRoot), realpath(fixturePath)]);
  const relativeFixturePath = path.relative(canonicalQaRoot, canonicalFixturePath);
  const fixtureParts = relativeFixturePath.split(path.sep);
  assert.equal(path.isAbsolute(relativeFixturePath), false, 'fixture must be inside the repository QA fixture directory');
  assert.equal(fixtureParts.length, 2, 'fixture must be at .runner/astra-qa/<label>/pg.json');
  assert.equal(fixtureParts[1], 'pg.json', 'fixture filename must be pg.json');
  assert.ok(fixtureParts[0] && fixtureParts[0] !== '..', 'fixture label directory is required');
  const fixture = await validateAstraPlatformFixture({ root, fixturePath: canonicalFixturePath, allowR20: true });
  assert.equal(fixture.mode, 'disposable-synthetic-qa');
  assert.equal(fixture.label, fixtureParts[0], 'fixture label must match its directory name');
  assert.equal(fixture.realData, false);
  for (const connectionString of [fixture.connectionString, fixture.workerConnectionString]) {
    const connection = new URL(connectionString);
    assert.ok(['postgres:', 'postgresql:'].includes(connection.protocol), 'fixture must use PostgreSQL');
    assert.ok(['localhost', '127.0.0.1', '::1'].includes(connection.hostname), 'fixture database must be loopback-only');
  }

  // Retain only the local test runtime variables before importing the guard or application.
  const safeEnv = new Set(['PATH','SystemRoot','WINDIR','TEMP','TMP','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!safeEnv.has(key)) delete process.env[key];
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'astra-outcome-corrections-'));
  process.env.ODD_DB_PATH = path.join(scratch, 'auth.sqlite');
  process.env.NODE_ENV = 'test';
  process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
  process.env.ODD_AUTH_BOOTSTRAP_TOKEN = randomBytes(24).toString('hex');
  process.env.ODD_AUTH_COOKIE_SECURE = 'false';
  process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.ASTRA_DATABASE_URL = fixture.connectionString;
  process.env.ASTRA_WORKER_DATABASE_URL = fixture.workerConnectionString;
  process.env.ASTRA_CONTEXT_SECRET = fixture.contextSecret;
  process.env.ASTRA_TENANT_MODE = '1';
  process.env.ASTRA_LEGACY_OFFER_BRIDGE = '1';
  process.env.LOCAL_PREVIEW = '1';
  process.env.ASTRA_LIVE_ACTIONS = 'disabled';
  process.env.ASTRA_GLOBAL_PROVIDER_DECISION = 'unapproved';

  let server;
  let closeDb;
  const checks = [];
  try {
    await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
    ({ server } = await import('../server.js'));
    ({ closeDb } = await import('../pipeline/database.js'));
    const { registerAstraLedgerRoutes } = await import('../pipeline/astra-ledger-routes.js');
    if (!server.listening) await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      const response = await fetch(`${base}${route}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: await response.json() };
    }
    const authDb = (await import('../pipeline/database.js')).initDb();
    authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
    authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(1_000_000_000 + randomBytes(4).readUInt32BE(0));
    const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: {
      email: `outcome-${randomBytes(6).toString('hex')}@example.test`, password: 'Synthetic-outcome-pass-9!',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    } });
    assert.equal(bootstrap.status, 201);
    const sessionId = bootstrap.setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
    const csrfCookie = bootstrap.setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
    assert.ok(sessionId && csrfCookie, 'synthetic owner session cookies are set');
    const session = { cookie: `odd_session=${sessionId}; odd_csrf=${csrfCookie}`, csrf: decodeURIComponent(csrfCookie) };
    async function createTenant(name) {
      const result = await request('/api/astra/tenants', { method: 'POST', ...session, body: { name } });
      assert.equal(result.status, 201);
      return result.body.tenant.id;
    }
    const tenantId = await createTenant('Synthetic outcome correction tenant');
    const otherTenantId = await createTenant('Synthetic other outcome tenant');
    const entity = { type: 'account', id: `synthetic-account-${randomBytes(5).toString('hex')}` };
    const provenance = { source: 'synthetic_fixture', confidence: 'high', fieldAuthority: 'human' };
    const recordedAt = '2026-10-24T10:00:00.000Z';
    async function addOutcome(stage, idempotencyKey, details = {}, targetTenant = tenantId, targetEntity = entity) {
      return request(`/api/astra/tenants/${targetTenant}/outcomes`, { method: 'POST', ...session, body: {
        stage, entity: targetEntity, occurredAt: recordedAt, idempotencyKey, provenance, ...details,
      } });
    }
    const paid = await addOutcome('revenue_paid', 'outcome-paid-original', { amountMinor: 20_000, currency: 'USD' });
    const refund = await addOutcome('revenue_refunded', 'outcome-refund-original', { amountMinor: 5_000, currency: 'USD' });
    assert.equal(paid.status, 201);
    assert.equal(refund.status, 201);
    assert.equal(refund.body.data.projection.revenue[0].netMinor, 15_000);
    checks.push('paid and refund outcomes recorded');

    const correctionBody = {
      action: 'correct', correctsEventId: paid.body.data.id, occurredAt: '2026-10-24T11:00:00.000Z',
      idempotencyKey: 'outcome-paid-correction',
      replacement: { stage: 'revenue_paid', entity, occurredAt: '2026-10-24T10:00:00.000Z', amountMinor: 18_000, currency: 'USD' },
      provenance,
    };
    const corrected = await request(`/api/astra/tenants/${tenantId}/outcomes/corrections`, { method: 'POST', ...session, body: correctionBody });
    assert.equal(corrected.status, 201, corrected.body.error);
    assert.equal(corrected.body.data.projection.revenue[0].paidMinor, 18_000);
    assert.equal(corrected.body.data.projection.revenue[0].refundedMinor, 5_000);
    assert.equal(corrected.body.data.projection.revenue[0].netMinor, 13_000);
    checks.push('correction appends an immutable event and updates net revenue once');

    const replay = await request(`/api/astra/tenants/${tenantId}/outcomes/corrections`, { method: 'POST', ...session, body: correctionBody });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.id, corrected.body.data.id);
    assert.equal(replay.body.data.duplicate, true);
    assert.equal(replay.body.data.projection.revenue[0].netMinor, 13_000);
    const mismatch = await request(`/api/astra/tenants/${tenantId}/outcomes/corrections`, { method: 'POST', ...session,
      body: { ...correctionBody, replacement: { ...correctionBody.replacement, amountMinor: 19_000 } } });
    assert.equal(mismatch.status, 409);
    checks.push('exact replay is duplicate; explicit-key payload mismatch conflicts');

    const events = await request(`/api/astra/tenants/${tenantId}/events?entityType=account&entityId=${encodeURIComponent(entity.id)}`, { cookie: session.cookie });
    assert.equal(events.status, 200);
    const original = events.body.data.find(event => event.id === paid.body.data.id);
    assert.equal(original.eventType, 'revenue.paid');
    assert.equal(original.payload.amountMinor, 20_000);
    assert.equal(events.body.data.filter(event => event.eventType === 'outcome.corrected').length, 1);
    checks.push('original paid event remains unchanged in append-only event history');

    const analytics = await request(`/api/astra/tenants/${tenantId}/analytics/funnel?from=2020-01-01T00%3A00%3A00.000Z&to=2035-01-01T00%3A00%3A00.000Z`, { cookie: session.cookie });
    assert.equal(analytics.status, 200);
    assert.equal(analytics.body.data.revenue[0].netMinor, '13000');
    checks.push('funnel analytics reads correction-aware projection');

    const reversed = await request(`/api/astra/tenants/${tenantId}/outcomes/corrections`, { method: 'POST', ...session, body: {
      action: 'reverse', correctsEventId: refund.body.data.id, occurredAt: '2026-10-24T12:00:00.000Z',
      idempotencyKey: 'outcome-refund-reversal', provenance,
    } });
    assert.equal(reversed.status, 201, reversed.body.error);
    assert.equal(reversed.body.data.projection.revenue[0].paidMinor, 18_000);
    assert.equal(reversed.body.data.projection.revenue[0].refundedMinor, 0);
    assert.equal(reversed.body.data.projection.revenue[0].netMinor, 18_000);
    checks.push('reversal adjusts projection while retaining all ledger events');

    const missing = await request(`/api/astra/tenants/${otherTenantId}/outcomes/corrections`, { method: 'POST', ...session, body: {
      action: 'reverse', correctsEventId: paid.body.data.id, occurredAt: '2026-10-24T13:00:00.000Z',
      idempotencyKey: 'cross-tenant-target', provenance,
    } });
    assert.equal(missing.status, 404);
    const mismatchEntity = { ...correctionBody, idempotencyKey: 'wrong-entity-correction',
      replacement: { ...correctionBody.replacement, entity: { type: 'account', id: `${entity.id}-other` } } };
    const entityMismatch = await request(`/api/astra/tenants/${tenantId}/outcomes/corrections`, { method: 'POST', ...session, body: mismatchEntity });
    assert.equal(entityMismatch.status, 409);
    checks.push('cross-tenant target is hidden and replacement entity mismatch is rejected');

    const badCurrency = await addOutcome('revenue_paid', 'invalid-currency', { amountMinor: 1, currency: 'usd' });
    const badAmount = await addOutcome('revenue_paid', 'invalid-amount', { amountMinor: -1, currency: 'USD' });
    assert.equal(badCurrency.status, 400);
    assert.equal(badAmount.status, 400);
    checks.push('invalid currency and amount are rejected');

    let registered;
    registerAstraLedgerRoutes(definition => { registered = definition; });
    let roleResponse;
    await registered.handler({ method: 'POST', url: `/api/astra/tenants/${tenantId}/outcomes/corrections` }, {}, {
      params: { tenantId }, actor: { tenantId, userId: 'synthetic-viewer', tenantRole: 'viewer' }, db: {},
      pathname: `/api/astra/tenants/${tenantId}/outcomes/corrections`, readJson: async () => correctionBody,
      sendJson: (_res, body, status) => { roleResponse = { body, status }; },
    });
    assert.equal(roleResponse.status, 403);
    assert.equal(roleResponse.body.code, 'role_required');
    checks.push('wrong tenant role is denied before database access');

    process.stdout.write(`${JSON.stringify({ fixtureMode: fixture.mode, migrations: fixture.migrations.length, realData: false, checks }, null, 2)}\n`);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (closeDb) await closeDb();
    rmSync(scratch, { recursive: true, force: true });
  }
});
