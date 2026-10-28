import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEvent } from '../pipeline/astra-ledger.js';
import { createAstraTenantStore } from '../pipeline/astra-tenant-store.js';
import { rebuildOutcomeProjection } from '../pipeline/astra-outcomes.js';
import { validateAstraPlatformFixture } from './support/astra-platform-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = process.env.ASTRA_QA_FIXTURE_PATH ? path.resolve(process.env.ASTRA_QA_FIXTURE_PATH) : null;

test('outcome account UUID references are tenant-owned before writes', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to the canonical strict33 synthetic fixture.',
}, async () => {
  const fixture = await validateAstraPlatformFixture({ root, fixturePath, allowR20: true });
  assert.equal(fixture.mode, 'disposable-synthetic-qa');
  assert.equal(fixture.realData, false);
  for (const connectionString of [fixture.connectionString, fixture.workerConnectionString]) {
    const connection = new URL(connectionString);
    assert.ok(['postgres:', 'postgresql:'].includes(connection.protocol));
    assert.ok(['localhost', '127.0.0.1', '::1'].includes(connection.hostname));
  }

  const safeEnv = new Set(['PATH','SystemRoot','WINDIR','TEMP','TMP','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!safeEnv.has(key)) delete process.env[key];
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'astra-outcome-ownership-'));
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

  let server; let closeDb; let historicalStore;
  try {
    await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
    ({ server } = await import('../server.js'));
    ({ closeDb } = await import('../pipeline/database.js'));
    if (!server.listening) await new Promise((resolve, reject) => {
      server.once('error', reject); server.once('listening', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: await response.json() };
    }
    const authDb = (await import('../pipeline/database.js')).initDb();
    authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
    authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(1_000_000_000 + randomBytes(4).readUInt32BE(0));
    const ownerEmail = `outcome-owner-${randomBytes(6).toString('hex')}@example.test`;
    const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: {
      email: ownerEmail, password: 'Synthetic-outcome-pass-9!',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    } });
    assert.equal(bootstrap.status, 201);
    const sessionId = bootstrap.setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
    const csrfCookie = bootstrap.setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
    assert.ok(sessionId && csrfCookie);
    const session = { cookie: `odd_session=${sessionId}; odd_csrf=${csrfCookie}`, csrf: decodeURIComponent(csrfCookie) };
    async function createTenant(name) {
      const result = await request('/api/astra/tenants', { method: 'POST', ...session, body: { name } });
      assert.equal(result.status, 201, result.body.error); return result.body.tenant.id;
    }
    const ownTenant = await createTenant('Synthetic outcome owner tenant');
    const otherTenant = await createTenant('Synthetic outcome second tenant');
    async function createAccount(tenantId, suffix) {
      const response = await request(`/api/astra/tenants/${tenantId}/research/snapshots`, { method: 'POST', ...session, body: {
        sourceUrl: `https://${suffix}-${randomUUID().slice(0, 8)}.example.test/about`, rightsPolicy: 'synthetic_fixture',
        rightsAttested: true, robotsAllowed: true, mediaType: 'text/html; charset=utf-8',
        html: `<html><title>${suffix} synthetic account</title><h1>Tenant ownership proof</h1></html>`,
      } });
      assert.equal(response.status, 201, response.body.error);
      return response.body.data.account.id;
    }
    const ownAccount = await createAccount(ownTenant, 'own-account');
    const foreignAccount = await createAccount(otherTenant, 'foreign-account');
    const missingUuid = randomUUID();
    const opaque = `synthetic-account-${randomBytes(5).toString('hex')}`;
    const provenance = { source: 'synthetic_fixture', confidence: 'high', fieldAuthority: 'human' };
    const occurredAt = '2026-10-24T10:00:00.000Z';
    historicalStore = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
    const ownerUserId = String(authDb.prepare('SELECT id FROM auth_users WHERE email = ?').get(ownerEmail).id);
    const historical = await historicalStore.withTenant({ tenantId: ownTenant, userId: ownerUserId }, async (db, membership) => {
      const actor = { tenantId: ownTenant, userId: ownerUserId, tenantRole: membership.tenantRole, role: membership.tenantRole };
      async function seedLegacyEvent(id, idempotencyKey) {
        const event = await appendEvent(db, actor, {
          eventType: 'meeting.held', schemaVersion: 1, entity: { type: 'account', id }, occurredAt,
          idempotencyKey, payload: { stage: 'meeting_held' }, provenance,
        });
        await rebuildOutcomeProjection(db, ownTenant, 'account', id);
        return event;
      }
      return {
        foreignAccountEvent: await seedLegacyEvent(foreignAccount, 'historical-malformed-foreign-account'),
        missingAccountEvent: await seedLegacyEvent(missingUuid, 'historical-malformed-missing-account'),
        uppercaseOwnedEvent: await seedLegacyEvent(ownAccount.toUpperCase(), 'historical-uppercase-owned-account'),
      };
    });
    const outcomeRoute = tenant => `/api/astra/tenants/${tenant}/outcomes`;
    const eventsRoute = (tenant, id) => `/api/astra/tenants/${tenant}/events?entityType=account&entityId=${encodeURIComponent(id)}`;
    const allEventsRoute = tenant => `/api/astra/tenants/${tenant}/events?limit=500`;
    const projectionRoute = tenant => `/api/astra/tenants/${tenant}/outcomes?entityType=account`;
    const analyticsRoute = tenant => `/api/astra/tenants/${tenant}/analytics/funnel?from=2020-01-01T00%3A00%3A00.000Z&to=2035-01-01T00%3A00%3A00.000Z`;
    async function add(tenant, entityId, idempotencyKey, details = {}) {
      return request(outcomeRoute(tenant), { method: 'POST', ...session, body: {
        stage: 'meeting_held', entity: { type: 'account', id: entityId }, occurredAt, idempotencyKey, provenance, ...details,
      } });
    }

    const own = await add(ownTenant, ownAccount, 'owned-account-outcome');
    assert.equal(own.status, 201, own.body.error);
    const ownReplay = await add(ownTenant, ownAccount, 'owned-account-outcome');
    assert.equal(ownReplay.status, 200); assert.equal(ownReplay.body.data.id, own.body.data.id);
    assert.equal(ownReplay.body.data.duplicate, true);
    const ownVariantReplay = await add(ownTenant, ownAccount.toUpperCase(), 'owned-account-outcome');
    assert.equal(ownVariantReplay.status, 200, 'uppercase UUID spelling canonicalizes to the same idempotent event');
    assert.equal(ownVariantReplay.body.data.id, own.body.data.id);
    const ownCanonicalHistory = await request(eventsRoute(ownTenant, ownAccount.toLowerCase()), { cookie: session.cookie });
    assert.equal(ownCanonicalHistory.body.data.length, 1, 'recognized UUID is stored in canonical form');
    const conflict = await add(ownTenant, ownAccount, 'owned-account-outcome', { stage: 'meeting_cancelled' });
    assert.equal(conflict.status, 409, 'changed idempotency payload remains a conflict');

    const ownedPaid = await add(ownTenant, ownAccount, 'owned-account-paid', {
      stage: 'revenue_paid', amountMinor: 20_000, currency: 'USD',
    });
    const ownedRefund = await add(ownTenant, ownAccount, 'owned-account-refund', {
      stage: 'revenue_refunded', amountMinor: 5_000, currency: 'USD',
    });
    assert.equal(ownedPaid.status, 201, ownedPaid.body.error);
    assert.equal(ownedRefund.status, 201, ownedRefund.body.error);
    assert.equal(ownedRefund.body.data.projection.revenue[0].netMinor, 15_000);
    const ownedCorrection = await request(`/api/astra/tenants/${ownTenant}/outcomes/corrections`, {
      method: 'POST', ...session, body: {
        action: 'correct', correctsEventId: ownedPaid.body.data.id,
        occurredAt: '2026-10-24T10:30:00.000Z', idempotencyKey: 'owned-account-paid-correction', provenance,
        replacement: { stage: 'revenue_paid', entity: { type: 'account', id: `{${ownAccount}}` }, occurredAt,
          amountMinor: 18_000, currency: 'USD' },
      },
    });
    assert.equal(ownedCorrection.status, 201, ownedCorrection.body.error);
    assert.equal(ownedCorrection.body.data.projection.revenue[0].netMinor, 13_000,
      'owned UUID alternate spelling corrects the revenue event without changing refund history');

    const foreignVariants = [foreignAccount, foreignAccount.toUpperCase(), foreignAccount.replaceAll('-', ''), `{${foreignAccount}}`];
    const deniedIds = [...foreignVariants, missingUuid];
    const before = await Promise.all([
      request(allEventsRoute(ownTenant), { cookie: session.cookie }),
      request(projectionRoute(ownTenant), { cookie: session.cookie }),
      request(analyticsRoute(ownTenant), { cookie: session.cookie }),
    ]);
    const denied = [];
    for (const [index, id] of deniedIds.entries()) {
      const result = await add(ownTenant, id, `cross-tenant-denied-${index}`);
      denied.push(result);
    }
    assert.deepEqual(denied.map(result => result.status), [404, 404, 404, 404, 404]);
    assert.equal(new Set(denied.map(result => result.body.code)).size, 1, 'foreign and missing UUIDs share one non-disclosing rejection');
    assert.equal(new Set(denied.map(result => result.body.error)).size, 1);
    const after = await Promise.all([
      request(allEventsRoute(ownTenant), { cookie: session.cookie }),
      request(projectionRoute(ownTenant), { cookie: session.cookie }),
      request(analyticsRoute(ownTenant), { cookie: session.cookie }),
    ]);
    assert.deepEqual(after[0].body.data.map(event => event.id), before[0].body.data.map(event => event.id), 'denied requests leave the event ledger unchanged');
    assert.deepEqual(after[1].body.data, before[1].body.data, 'denied events leave outcome projections unchanged');
    assert.deepEqual(after[2].body.data, before[2].body.data, 'denied events leave analytics unchanged');

    const generic = (id, key) => ({ eventType: 'meeting.held', schemaVersion: 1,
      entity: { type: 'account', id }, occurredAt, idempotencyKey: key,
      payload: { stage: 'meeting_held' }, provenance });
    const genericOwn = await request(`/api/astra/tenants/${ownTenant}/events`, {
      method: 'POST', ...session, body: generic(ownAccount.toUpperCase(), 'owned-generic-event'),
    });
    assert.equal(genericOwn.status, 201, genericOwn.body.error);
    const genericOwnHistory = await request(eventsRoute(ownTenant, ownAccount), { cookie: session.cookie });
    assert.ok(genericOwnHistory.body.data.some(event => event.id === genericOwn.body.data.id),
      'generic events accept owned UUID references and store them canonically');
    const genericBefore = await Promise.all([
      request(allEventsRoute(ownTenant), { cookie: session.cookie }),
      request(projectionRoute(ownTenant), { cookie: session.cookie }),
      request(analyticsRoute(ownTenant), { cookie: session.cookie }),
    ]);
    const genericDenied = [];
    for (const [index, id] of [...foreignVariants, missingUuid].entries()) {
      genericDenied.push(await request(`/api/astra/tenants/${ownTenant}/events`, {
        method: 'POST', ...session, body: generic(id, `generic-cross-tenant-denied-${index}`),
      }));
    }
    assert.deepEqual(genericDenied.map(result => result.status), [404, 404, 404, 404, 404]);
    assert.equal(new Set(genericDenied.map(result => result.body.code)).size, 1,
      'generic event foreign and missing UUIDs share one safe rejection');
    const genericAfter = await Promise.all([
      request(allEventsRoute(ownTenant), { cookie: session.cookie }),
      request(projectionRoute(ownTenant), { cookie: session.cookie }),
      request(analyticsRoute(ownTenant), { cookie: session.cookie }),
    ]);
    assert.deepEqual(genericAfter[0].body.data.map(event => event.id), genericBefore[0].body.data.map(event => event.id),
      'denied generic events do not append ledger rows');
    assert.deepEqual(genericAfter[1].body.data, genericBefore[1].body.data, 'denied generic events do not change projections');
    assert.deepEqual(genericAfter[2].body.data, genericBefore[2].body.data, 'denied generic events do not change analytics');

    const legacy = await add(ownTenant, opaque, 'legacy-opaque-outcome');
    assert.equal(legacy.status, 201, 'legacy opaque account references remain supported');
    const legacyRead = await request(eventsRoute(ownTenant, opaque), { cookie: session.cookie });
    assert.equal(legacyRead.status, 200); assert.equal(legacyRead.body.data[0].entityId, opaque);
    const legacyCorrection = await request(`/api/astra/tenants/${ownTenant}/outcomes/corrections`, { method: 'POST', ...session, body: {
      action: 'correct', correctsEventId: legacy.body.data.id, occurredAt: '2026-10-24T11:00:00.000Z',
      idempotencyKey: 'legacy-opaque-correction', replacement: { stage: 'meeting_booked', entity: { type: 'account', id: opaque }, occurredAt, }, provenance,
    } });
    assert.equal(legacyCorrection.status, 201, legacyCorrection.body.error);
    const opaqueHistory = await request(eventsRoute(ownTenant, opaque), { cookie: session.cookie });
    assert.deepEqual(opaqueHistory.body.data.map(event => event.eventType), ['meeting.held', 'outcome.corrected']);

    // Reversal depends on an exact tenant-scoped target event and deliberately
    // does not resolve the target entity through another tenant's account row.
    const safeReverse = await request(`/api/astra/tenants/${ownTenant}/outcomes/corrections`, { method: 'POST', ...session, body: {
      action: 'reverse', correctsEventId: own.body.data.id, occurredAt: '2026-10-24T12:00:00.000Z',
      idempotencyKey: 'historical-malformed-link-reversal', provenance,
    } });
    assert.equal(safeReverse.status, 201, safeReverse.body.error);
    const correctedForeign = await request(`/api/astra/tenants/${ownTenant}/outcomes/corrections`, { method: 'POST', ...session, body: {
      action: 'correct', correctsEventId: own.body.data.id, occurredAt: '2026-10-24T13:00:00.000Z',
      idempotencyKey: 'historical-malformed-link-correction',
      replacement: { stage: 'meeting_booked', entity: { type: 'account', id: foreignAccount }, occurredAt }, provenance,
    } });
    assert.equal(correctedForeign.status, 404, 'correction replacement cannot create another UUID account link without local ownership');

    const uppercaseHistoricalCorrection = await request(`/api/astra/tenants/${ownTenant}/outcomes/corrections`, {
      method: 'POST', ...session, body: {
        action: 'correct', correctsEventId: historical.uppercaseOwnedEvent.id,
        occurredAt: '2026-10-24T13:30:00.000Z', idempotencyKey: 'historical-uppercase-owned-correction', provenance,
        replacement: { stage: 'meeting_booked', entity: { type: 'account', id: ownAccount }, occurredAt },
      },
    });
    assert.equal(uppercaseHistoricalCorrection.status, 201, uppercaseHistoricalCorrection.body.error,
      'canonical replacement remains compatible with a historical uppercase owned UUID identity');

    const foreignTenantReverse = await request(`/api/astra/tenants/${otherTenant}/outcomes/corrections`, {
      method: 'POST', ...session, body: {
        action: 'reverse', correctsEventId: historical.foreignAccountEvent.id,
        occurredAt: '2026-10-24T13:45:00.000Z', idempotencyKey: 'foreign-tenant-historical-reversal', provenance,
      },
    });
    assert.equal(foreignTenantReverse.status, 404, 'a foreign tenant cannot reverse a historical event by ID');

    const historicalAnalyticsBeforeReversals = await request(analyticsRoute(ownTenant), { cookie: session.cookie });
    const historicalReversals = [];
    for (const [index, event] of [historical.foreignAccountEvent, historical.missingAccountEvent].entries()) {
      const reversal = await request(`/api/astra/tenants/${ownTenant}/outcomes/corrections`, {
        method: 'POST', ...session, body: {
          action: 'reverse', correctsEventId: event.id, occurredAt: `2026-10-24T14:0${index}:00.000Z`,
          idempotencyKey: `historical-malformed-link-reversal-${index}`, provenance,
        },
      });
      assert.equal(reversal.status, 201, reversal.body.error);
      historicalReversals.push(reversal);
    }
    for (const [index, id] of [foreignAccount, missingUuid].entries()) {
      const history = await request(eventsRoute(ownTenant, id), { cookie: session.cookie });
      assert.deepEqual(history.body.data.map(event => event.id), [
        index === 0 ? historical.foreignAccountEvent.id : historical.missingAccountEvent.id,
        historicalReversals[index].body.data.id,
      ], 'tenant-owned remediation appends a reversal and preserves historical event identity');
      const projection = (await request(projectionRoute(ownTenant), { cookie: session.cookie })).body.data
        .find(row => row.entityId === id);
      assert.equal(projection.state.latestStage, null, 'reversed malformed historical account outcome leaves no active milestone');
      assert.deepEqual(projection.state.milestones, []);
    }
    const historicalAnalyticsAfter = await request(analyticsRoute(ownTenant), { cookie: session.cookie });
    assert.equal(historicalAnalyticsAfter.body.data.funnel['meeting.held'],
      historicalAnalyticsBeforeReversals.body.data.funnel['meeting.held'] - 2,
      'reversing historical foreign and missing account links removes only their two active funnel milestones');
    const reverseHistory = await request(eventsRoute(ownTenant, ownAccount), { cookie: session.cookie });
    assert.deepEqual(reverseHistory.body.data.map(event => event.id), [
      own.body.data.id, ownedPaid.body.data.id, ownedRefund.body.data.id, ownedCorrection.body.data.id,
      genericOwn.body.data.id, safeReverse.body.data.id,
    ], 'safe reversal retains exactly the expected immutable event identities');
    const uppercaseHistory = await request(eventsRoute(ownTenant, ownAccount.toUpperCase()), { cookie: session.cookie });
    assert.deepEqual(uppercaseHistory.body.data.map(event => event.id), [
      historical.uppercaseOwnedEvent.id, uppercaseHistoricalCorrection.body.data.id,
    ], 'correction preserves the historical uppercase UUID entity identity');
    const finalProjections = await request(projectionRoute(ownTenant), { cookie: session.cookie });
    const finalAccountProjection = finalProjections.body.data.find(row => row.entityId === ownAccount);
    assert.equal(finalAccountProjection.state.revenue[0].netMinor, 13_000,
      'safe reversal keeps the corrected owned-account revenue projection intact');

    process.stdout.write(`${JSON.stringify({ fixtureMode: fixture.mode, migrations: fixture.migrations.length, realData: false,
      checks: ['owned account accepted; UUID spelling replay idempotent and payload conflict preserved', 'foreign and missing UUID forms return identical 404',
        'denied outcomes preserve events, projections, and analytics', 'opaque legacy account refs remain readable and correctable',
        'tenant-scoped reversal remains available; new correction link is rejected'] }, null, 2)}\n`);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (historicalStore) await historicalStore.close();
    if (closeDb) await closeDb();
    rmSync(scratch, { recursive: true, force: true });
  }
});
