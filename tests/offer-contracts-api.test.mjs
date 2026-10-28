import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateAstraR20Fixture } from './support/astra-r20-fixture.mjs';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-offer-api-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'fixture-offer-bootstrap-token-123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.ASTRA_TENANT_MODE = '1';
process.env.ASTRA_LEGACY_OFFER_BRIDGE = '1';
process.env.LOCAL_PREVIEW = '1';
process.env.ASTRA_LIVE_ACTIONS = 'disabled';
process.env.ASTRA_GLOBAL_PROVIDER_DECISION = 'unapproved';
process.env.PORT = '0';
delete process.env.HOST;

// Tenant creation uses the actual PostgreSQL store; never fall back to a
// process-global or production connection for this disposable API contract.
const fixture = await validateAstraR20Fixture({ root: path.resolve(import.meta.dirname, '..'),
  fixturePath: path.resolve(process.env.ASTRA_QA_FIXTURE_PATH || '.runner/astra-qa/r20-source-rights/pg.json') });
Object.assign(process.env, { ASTRA_DATABASE_URL: fixture.connectionString,
  ASTRA_WORKER_DATABASE_URL: fixture.workerConnectionString, ASTRA_CONTEXT_SECRET: fixture.contextSecret });

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, session } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session?.cookie) headers.cookie = session.cookie;
  if (session?.csrf) headers['x-csrf-token'] = session.csrf;
  const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: type.includes('json') ? await response.json() : await response.text() };
}

function sessionFrom(setCookie) {
  const cookie = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(cookie && csrf, 'authenticated session cookies are set');
  return { cookie: `odd_session=${cookie}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

test('tenant-scoped offer API requires trusted UUID ownership and uploaded immutable proof bytes', async () => {
  const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: {
    email: 'offer-owner@example.test', password: 'Fixture-offer-password-9!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
  } });
  assert.equal(bootstrap.status, 201, JSON.stringify(bootstrap.body));
  const owner = sessionFrom(bootstrap.setCookie);
  const tenant = await request('/api/astra/tenants', { method: 'POST', session: owner, body: { name: 'Synthetic offer fixture tenant' } });
  assert.equal(tenant.status, 201, JSON.stringify(tenant.body));
  const tenantId = tenant.body.tenant.id;
  assert.match(tenantId, /^[0-9a-f-]{36}$/i);
  const context = await request(`/api/astra/tenants/${tenantId}/context`, { session: owner });
  assert.equal(context.status, 200, JSON.stringify(context.body));
  assert.equal(context.body.tenant.role, 'owner');

  const bytes = Buffer.from('Synthetic offer proof bytes for tenant API contract only.');
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const offerContent = {
    service: 'SEO audit', scope: 'One technical audit with a written findings report.',
    price: { minMinor: 10000, maxMinor: 90000, currency: 'USD' },
    proofAssets: [{ proofId: 'proof-1', reference: 'fixture://uploaded-proof-1', contentHash,
      observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: '2035-01-01T00:00:00.000Z', rightsBasis: 'Synthetic fixture grant only' }],
    audienceExclusions: ['Existing customer'], geography: { includedCountries: ['US'] }, capacity: 5,
    egress: { mode: 'NO_MODEL_EGRESS', allowedDestinations: [] },
  };
  const offer = await request(`/api/astra/tenants/${tenantId}/offers`, { method: 'POST', session: owner, body: { name: 'Scoped audit', content: offerContent } });
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  const { id, version } = offer.body.offer;
  assert.equal(version.status, 'draft');

  const upload = await request(`/api/astra/tenants/${tenantId}/offers/${id}/versions/${version.id}/proofs`, {
    method: 'POST', session: owner,
    body: { proofId: 'proof-1', bytesBase64: bytes.toString('base64'), mimeType: 'text/plain', expiresAt: '2035-01-01T00:00:00.000Z', contentHash },
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  assert.equal(upload.body.proof.contentHash, contentHash);
  assert.equal(upload.body.proof.byteLength, bytes.length);

  const mailbox = await request(`/api/astra/tenants/${tenantId}/mailboxes`, { method: 'POST', session: owner, body: {
    displayName: 'Synthetic manual mailbox', providerMailboxId: 'offer-fixture@example.test', provider: 'manual',
  } });
  assert.equal(mailbox.status, 201, JSON.stringify(mailbox.body));
  const unapprovedCampaign = await request(`/api/astra/tenants/${tenantId}/campaigns`, { method: 'POST', session: owner, body: {
    name: 'Unapproved offer campaign', offerVersionId: version.id, mailboxId: mailbox.body.mailbox.id,
    purpose: 'synthetic_fixture', geography: ['US'], spendLimitMinor: 0, currency: 'USD',
  } });
  assert.equal(unapprovedCampaign.status, 409, JSON.stringify(unapprovedCampaign.body));
  assert.match(unapprovedCampaign.body.error, /offer_unapproved/);

  const approved = await request(`/api/astra/tenants/${tenantId}/offers/${id}/versions/${version.id}/approve`, { method: 'POST', session: owner, body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.version.status, 'approved');
  assert.equal(String(approved.body.version.approvedBy), '1', 'approval actor is the authenticated bootstrap owner');
  const readBack = await request(`/api/astra/tenants/${tenantId}/offers/${id}`, { session: owner });
  assert.equal(readBack.status, 200, JSON.stringify(readBack.body));
  assert.equal(readBack.body.offer.versions[0].status, 'approved');
  const crossTenant = await request(`/api/astra/tenants/00000000-0000-4000-8000-000000000001/offers/${id}`, { session: owner });
  assert.equal(crossTenant.status, 404, 'offers cannot be read under another tenant UUID');

  const campaign = await request(`/api/astra/tenants/${tenantId}/campaigns`, { method: 'POST', session: owner, body: {
    name: 'Approved offer campaign', offerVersionId: version.id, mailboxId: mailbox.body.mailbox.id,
    purpose: 'synthetic_fixture', geography: ['US'], spendLimitMinor: 0, currency: 'USD',
  } });
  assert.equal(campaign.status, 201, JSON.stringify(campaign.body));
  assert.equal(String(campaign.body.campaign.offerVersionId), String(version.id));

  const revoke = await request(`/api/astra/tenants/${tenantId}/offers/${id}/versions/${version.id}/proofs/${upload.body.proof.id}/revoke`, {
    method: 'POST', session: owner, body: { reason: 'Synthetic fixture rights withdrawn' },
  });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
});
