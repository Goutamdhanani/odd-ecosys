import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { after, test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-meta-leads-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'synthetic-meta-bootstrap-key-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = '12'.repeat(32);
process.env.ODD_PUBLIC_BASE_URL = 'https://odd.example.test';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Meta synthetic cohort','discovery','open')").run().lastInsertRowid);
const closedBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Meta closed cohort','discovery','closed')").run().lastInsertRowid);

let graphMode = 'success';
let rateLimitRetryAfter = '120';
let rateLimitGraphCode = 4;
let rateLimitOnlyLeadPage = false;
let leadsForUi = false;
let largePaginationScenario = false;
let failLargeContinuationOnce = false;
let formPaginationScenario = false;
let failFormContinuationOnce = false;
let malformedFormCursor = false;
let webhookLeadFailureOnce = '';
const graphCalls = [];
const token = 'SYNTHETIC_META_PAGE_TOKEN_DO_NOT_EXPOSE';
const webhookAppSecret = 'SYNTHETIC_META_APP_SECRET_FOR_TEST_ONLY_0123456789';
const webhookVerifyToken = 'SYNTHETIC_META_WEBHOOK_VERIFY_TOKEN_0123456789';
const createHashForTest = value => createHash('sha256').update(value, 'utf8').digest('hex');
function graphResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

async function fakeGraphFetch(input, options = {}) {
  const url = new URL(input);
  assert.equal(url.origin, 'https://graph.facebook.com', 'all provider requests stay on the official Graph API host');
  assert.equal(url.searchParams.has('access_token'), false, 'access tokens never appear in request URLs');
  assert.equal(options.headers?.Authorization, `Bearer ${token}`, 'Page access token is sent in the authorization header');
  graphCalls.push({ method: options.method || 'GET', path: url.pathname, search: url.searchParams.toString(), auth: options.headers.Authorization });
  if (graphMode === 'reject') return graphResponse({ error: { message: 'synthetic' } }, 403);
  if (graphMode === 'rate-limit-http' && (!rateLimitOnlyLeadPage || url.pathname.endsWith('/leads'))) {
    return graphResponse({ error: { message: 'synthetic throttle' } }, 429, {
      'retry-after': rateLimitRetryAfter,
      'x-app-usage': JSON.stringify({ call_count: 87, total_time: 13, total_cputime: 9, unknown: 'discard-me' }),
      'x-business-use-case-usage': JSON.stringify({ 'private-business-id': [{ type: 'leadgen', call_count: 96,
        total_time: 34, total_cputime: 17, estimated_time_to_regain_access: 3, unrelated: 'discard-me' }] }),
    });
  }
  if (graphMode === 'rate-limit-http-no-usage') return graphResponse({ error: { message: 'synthetic throttle' } }, 429, {
    'retry-after': rateLimitRetryAfter,
  });
  if (graphMode === 'rate-limit-code') return graphResponse({ error: { message: 'synthetic throttled', code: rateLimitGraphCode } }, 400, {
    'x-app-usage': JSON.stringify({ call_count: 99 }),
  });
  if (url.pathname === '/v24.0/123456/subscribed_apps') {
    assert.equal(options.method, 'POST', 'Page subscriptions use Meta Graph POST');
    return graphResponse({ success: true });
  }
  if (url.pathname === '/v24.0/123456') {
    return graphResponse({ id: graphMode === 'mismatch' ? '999999' : '123456', name: 'Synthetic Page' });
  }
  if (url.pathname === '/v24.0/123456/leadgen_forms') {
    const includeQuestions = url.searchParams.get('fields')?.includes('questions');
    if (formPaginationScenario) {
      const after = url.searchParams.get('after') || '';
      if (after === 'forms-cursor-100' && failFormContinuationOnce) {
        failFormContinuationOnce = false;
        return graphResponse({ error: { message: 'synthetic transient form-list failure' } }, 503);
      }
      const start = after === 'forms-cursor-100' ? 100 : 0;
      const end = Math.min(107, start + 100);
      const data = [];
      for (let index = start; index < end; index++) {
        const id = index === 0 ? '654321' : String(900000 + index);
        data.push({
          id, name: `Synthetic lead form ${index + 1}`, status: 'ACTIVE', created_time: '2026-10-09T12:00:00+0000',
          ...(includeQuestions && index === 0 ? { questions: [
            { key: 'company_name', label: 'Company' }, { key: 'email', label: 'Work email' },
            { key: 'phone_number', label: 'Business phone' }, { key: 'street_address', label: 'Street address' },
            { key: 'city', label: 'City' }, { key: 'state', label: 'State/Province' },
          ] } : {}),
        });
      }
      const hasMore = end < 107;
      return graphResponse({ data, ...(hasMore ? { paging: {
        cursors: { after: malformedFormCursor ? '\u0001bad-cursor' : 'forms-cursor-100' },
        next: 'https://malicious.example.test/never-follow-this-form-page',
      } } : {}) });
    }
    return graphResponse({ data: [{
      id: '654321', name: 'Synthetic B2B enquiry', status: 'ACTIVE', created_time: '2026-10-09T12:00:00+0000',
      ...(includeQuestions ? { questions: [
        { key: 'company_name', label: 'Company' }, { key: 'email', label: 'Work email' },
        { key: 'phone_number', label: 'Business phone' }, { key: 'street_address', label: 'Street address' },
        { key: 'city', label: 'City' }, { key: 'state', label: 'State/Province' },
      ] } : {}),
    }] });
  }
  if (/^\/v24\.0\/93\d{4,5}$/.test(url.pathname)) {
    const leadId = url.pathname.split('/').at(-1);
    if (webhookLeadFailureOnce === leadId) {
      webhookLeadFailureOnce = '';
      return graphResponse({ error: { message: 'synthetic transient lead lookup failure' } }, 503);
    }
    return graphResponse({
      id: leadId, form_id: '654321', created_time: '2026-10-10T06:00:00+0000',
      field_data: [
        { name: 'company_name', values: [`Graph-authoritative webhook company ${leadId}`] },
        { name: 'email', values: [`webhook-${leadId}@example.test`] },
        { name: 'street_address', values: ['42 Synthetic Way'] },
        { name: 'city', values: ['Pune'] },
        { name: 'state', values: ['Maharashtra'] },
      ],
    });
  }
  if (url.pathname === '/v24.0/654321/leads') {
    if (leadsForUi || largePaginationScenario) {
      const mode = leadsForUi ? 'ui' : 'large';
      const after = url.searchParams.get('after') || '';
      if (mode === 'large' && failLargeContinuationOnce && after === 'large-cursor-250') {
        failLargeContinuationOnce = false;
        return graphResponse({ error: { message: 'synthetic transient provider failure' } }, 503);
      }
      const previous = after.match(new RegExp(`^${mode}-cursor-(\\d+)$`));
      const offset = previous ? Number(previous[1]) : 0;
      const limit = Number(url.searchParams.get('limit')) || 100;
      const total = 251;
      const end = Math.min(total, offset + limit);
      const data = [];
      for (let index = offset + 1; index <= end; index++) {
        const id = (mode === 'ui' ? 819000 : 720000) + index;
        data.push({
          id: String(id), form_id: '654321', created_time: '2026-10-10T05:00:00+0000',
          field_data: [
            { name: 'company_name', values: [mode === 'ui' && index === 250 ? 'Browser-imported synthetic supplier' : `Synthetic ${mode} supplier ${index}`] },
            { name: 'email', values: [`${mode}-${index}@example.test`] },
            { name: 'street_address', values: [`${index} Synthetic Way`] },
            { name: 'city', values: ['Pune'] },
            { name: 'state', values: ['Maharashtra'] },
          ],
        });
      }
      const paging = data.length ? { cursors: { after: `${mode}-cursor-${end}` } } : {};
      if (end < total) paging.next = `https://malicious.example.test/${mode}-page-${end}`;
      return graphResponse({ data, ...(Object.keys(paging).length ? { paging } : {}) });
    }
    const cursor = url.searchParams.get('after');
    if (!cursor) return graphResponse({
      data: [
        { id: '710001', form_id: '654321', created_time: '2026-10-08T09:00:00+0000', field_data: [
          { name: 'company_name', values: ['North Star Workshop'] }, { name: 'email', values: ['hello@northstar.example.test'] },
          { name: 'phone_number', values: ['+91 20 5555 0190'] }, { name: 'city', values: ['Pune'] },
        ] },
        { id: '710002', form_id: '654321', created_time: '2026-10-08T09:05:00+0000', field_data: [
          { name: 'company_name', values: ['Riverbend Fabrication'] }, { name: 'email', values: ['hello@northstar.example.test'] },
          { name: 'city', values: ['Pune'] },
        ] },
      ], paging: { next: 'https://malicious.example.test/should-never-follow', cursors: { after: 'synthetic-cursor-one' } },
    });
    return graphResponse({
      data: [
        { id: '710001', form_id: '654321', created_time: '2026-10-08T09:00:00+0000', field_data: [
          { name: 'company_name', values: ['Changed value from replay'] }, { name: 'email', values: ['different@northstar.example.test'] },
        ] },
        { id: '710003', form_id: '654321', created_time: '2026-10-08T09:10:00+0000', field_data: [
          { name: 'company_name', values: ['Harbor Tools Cooperative'] }, { name: 'city', values: ['Mumbai'] },
        ] },
      ], paging: { cursors: { after: 'synthetic-cursor-two' } },
    });
  }
  throw new Error(`Unexpected synthetic Graph API route: ${url.pathname}`);
}

const { server, setMetaLeadAdsFetchForTests, setMetaLeadAdsClockForTests, recoverMetaLeadWebhooksOnStartup } = await import('../server.js');
setMetaLeadAdsFetchForTests(fakeGraphFetch);
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

function sessionFrom(response) {
  const setCookie = response.headers.get('set-cookie') || '';
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session && csrf, 'authentication creates a disposable browser session');
  return { cookie: `odd_session=${session}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf), session };
}

const ownerBootstrap = await fetch(`${base}/api/auth/bootstrap`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'meta-owner@example.test', password: 'Synthetic-owner-password-9!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }),
});
assert.equal(ownerBootstrap.status, 201);
const owner = sessionFrom(ownerBootstrap);

async function request(route, { method = 'GET', body, actor = owner } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (actor) {
    headers.cookie = actor.cookie;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['x-csrf-token'] = actor.csrf;
  }
  const response = await fetch(`${base}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, headers: response.headers, body: parsed };
}

after(async () => {
  setMetaLeadAdsFetchForTests(null);
  setMetaLeadAdsClockForTests(null);
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

test('Meta connection routes require an authenticated owner/admin and redact secrets', async () => {
  const unauthenticated = await request('/api/leads/sources/meta', { actor: null });
  assert.equal(unauthenticated.status, 401);

  const invitation = await request('/api/workspace/invitations', {
    method: 'POST', body: { email: 'meta-operator@example.test', role: 'operator' },
  });
  assert.equal(invitation.status, 201);
  const accepted = await fetch(`${base}/api/auth/invitations/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'meta-operator@example.test', password: 'Synthetic-operator-password-9!', invitationToken: invitation.body.invitation.token }),
  });
  assert.equal(accepted.status, 201);
  const operator = sessionFrom(accepted);
  assert.equal((await request('/api/leads/sources/meta', { actor: operator })).status, 403);
  assert.equal((await request('/api/leads/sources/meta/webhook-status', { actor: operator })).status, 403);
  assert.equal((await request('/api/leads/sources/meta/webhook-subscribe', { method: 'POST', actor: operator, body: {} })).status, 403);
  assert.equal((await request('/api/leads/sources/meta', { method: 'PUT', actor: operator, body: {
    page_id: '123456', graph_version: 'v24.0', access_token: token,
  } })).status, 403);
  assert.equal((await request('/api/leads/sources/meta/webhook-config', { method: 'PUT', actor: operator, body: {
    app_secret: webhookAppSecret, verify_token: webhookVerifyToken,
  } })).status, 403);

  const status = await request('/api/leads/sources/meta');
  assert.equal(status.status, 200);
  assert.equal(status.body.connectionStatus, 'not_configured');
  assert.equal(status.body.webhookConfigured, false);
  assert.match(status.headers.get('cache-control') || '', /no-store/);
  assert.equal(JSON.stringify(status.body).includes(token), false);
});

test('official Meta Page setup is encrypted and cannot list forms until provider access is tested', async () => {
  assert.equal((await request('/api/leads/sources/meta/forms')).status, 409);
  assert.equal(graphCalls.length, 0);
  assert.equal((await request('/api/leads/sources/meta', { method: 'PUT', body: { page_id: '123/../../evil', graph_version: 'v24.0', access_token: token } })).status, 400);
  assert.equal((await request('/api/leads/sources/meta', { method: 'PUT', body: { page_id: '123456', graph_version: 'latest', access_token: token } })).status, 400);

  const encryptionKey = process.env.ODD_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.ODD_CREDENTIAL_ENCRYPTION_KEY;
  const missingKey = await request('/api/leads/sources/meta', { method: 'PUT', body: {
    page_id: '123456', graph_version: 'v24.0', access_token: token,
  } });
  assert.equal(missingKey.status, 503);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_source_connections').get().count, 0, 'a token is never saved without encryption');
  process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = encryptionKey;

  const saved = await request('/api/leads/sources/meta', { method: 'PUT', body: {
    page_id: '123456', graph_version: 'v24.0', access_token: token,
  } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.connectionStatus, 'provider_unverified');
  assert.equal(saved.body.tokenPresent, true);
  assert.equal(JSON.stringify(saved.body).includes(token), false);
  const stored = db.prepare("SELECT * FROM lead_source_connections WHERE provider='meta_lead_ads'").get();
  assert.ok(stored.access_token_enc.startsWith('oddc1:'));
  assert.equal(stored.access_token_enc.includes(token), false);
  assert.equal(stored.access_token_enc.includes('SYNTHETIC'), false);

  const tested = await request('/api/leads/sources/meta/test', { method: 'POST', body: {} });
  assert.equal(tested.status, 200);
  assert.equal(tested.body.connectionStatus, 'provider_verified');
  assert.equal(tested.body.pageName, 'Synthetic Page');
  const firstRequest = graphCalls[0];
  assert.equal(firstRequest.path, '/v24.0/123456');
  assert.match(firstRequest.search, /fields=id%2Cname/);

  const forms = await request('/api/leads/sources/meta/forms');
  assert.equal(forms.status, 200);
  assert.deepEqual(forms.body.forms[0], {
    id: '654321', name: 'Synthetic B2B enquiry', status: 'ACTIVE', createdAt: '2026-10-09T12:00:00.000Z',
    continuationAvailable: false, moreResultsLastSeen: false,
    savedBatchId: null, savedFieldMap: {},
    fields: [
      { key: 'company_name', label: 'Company' }, { key: 'email', label: 'Work email' },
      { key: 'phone_number', label: 'Business phone' }, { key: 'street_address', label: 'Street address' },
      { key: 'city', label: 'City' }, { key: 'state', label: 'State/Province' },
    ],
  });
  assert.equal(forms.body.forms[0].fields.some(field => field.label.includes('SYNTHETIC')), false);
});

test('signed Meta leadgen notifications deduplicate, fetch trusted fields, and retry after provider failure', async () => {
  const settings = await request('/api/leads/sources/meta/webhook-status');
  assert.equal(settings.status, 200);
  assert.equal(settings.body.configured, false);
  const noWebhookConfig = await request('/api/leads/sources/meta/webhook-subscribe', { method: 'POST', body: {} });
  assert.equal(noWebhookConfig.status, 409);
  assert.match(noWebhookConfig.body.error, /Save the webhook App Secret and verify token/);
  assert.equal(graphCalls.some(call => call.path.endsWith('/subscribed_apps')), false, 'no Page subscription is attempted before webhook secrets are saved');
  assert.equal((await fetch(`${base}/api/webhooks/meta/leadgen?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(webhookVerifyToken)}&hub.challenge=12345`)).status, 503);

  const configured = await request('/api/leads/sources/meta/webhook-config', { method: 'PUT', body: {
    app_secret: webhookAppSecret, verify_token: webhookVerifyToken,
  } });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.configured, true);
  assert.equal(JSON.stringify(configured.body).includes(webhookAppSecret), false);
  assert.equal(JSON.stringify(configured.body).includes(webhookVerifyToken), false);
  const storedConnection = db.prepare("SELECT webhook_app_secret_enc,webhook_verify_token_hash FROM lead_source_connections WHERE provider='meta_lead_ads'").get();
  assert.ok(storedConnection.webhook_app_secret_enc.startsWith('oddc1:'));
  assert.equal(storedConnection.webhook_app_secret_enc.includes(webhookAppSecret), false);
  assert.equal(storedConnection.webhook_verify_token_hash, createHashForTest(webhookVerifyToken));

  const subscribed = await request('/api/leads/sources/meta/webhook-subscribe', { method: 'POST', body: {} });
  assert.equal(subscribed.status, 200);
  assert.equal(subscribed.body.pageId, '123456');
  assert.ok(subscribed.body.lastPageSubscriptionAt);
  const pageSubscribeCall = graphCalls.find(call => call.path === '/v24.0/123456/subscribed_apps');
  assert.equal(pageSubscribeCall.method, 'POST');
  assert.equal(new URLSearchParams(pageSubscribeCall.search).get('subscribed_fields'), 'leadgen');
  assert.equal(pageSubscribeCall.auth, `Bearer ${token}`);
  assert.equal(db.prepare("SELECT webhook_page_subscribed_at FROM lead_source_connections WHERE provider='meta_lead_ads'").get().webhook_page_subscribed_at, subscribed.body.lastPageSubscriptionAt);
  graphMode = 'reject';
  const subscriptionRejected = await request('/api/leads/sources/meta/webhook-subscribe', { method: 'POST', body: {} });
  assert.equal(subscriptionRejected.status, 502);
  assert.equal(db.prepare("SELECT webhook_page_subscribed_at FROM lead_source_connections WHERE provider='meta_lead_ads'").get().webhook_page_subscribed_at, subscribed.body.lastPageSubscriptionAt, 'a rejected Graph request does not replace the prior successful confirmation');
  graphMode = 'success';

  const callback = new URL(`${base}/api/webhooks/meta/leadgen`);
  callback.searchParams.set('hub.mode', 'subscribe');
  callback.searchParams.set('hub.verify_token', webhookVerifyToken);
  callback.searchParams.set('hub.challenge', 'synthetic-challenge-123');
  const verified = await fetch(callback);
  assert.equal(verified.status, 200);
  assert.equal(await verified.text(), 'synthetic-challenge-123');
  callback.searchParams.set('hub.verify_token', 'wrong'.padEnd(32, 'x'));
  assert.equal((await fetch(callback)).status, 403);

  const mapping = { business_name: 'company_name', email: 'email', address: 'street_address', city: 'city', state: 'state' };
  assert.equal((await request('/api/leads/sources/meta/webhook-forms/654321', { method: 'PUT', body: {
    batch_id: batchId, field_map: mapping,
  } })).status, 200);
  assert.equal((await request('/api/leads/sources/meta/webhook-forms/654321', { method: 'PUT', body: {
    batch_id: closedBatchId, field_map: mapping,
  } })).status, 409);
  const savedForms = await request('/api/leads/sources/meta/forms');
  assert.deepEqual(savedForms.body.forms[0].savedFieldMap, mapping);
  assert.equal(savedForms.body.forms[0].savedBatchId, batchId);

  const deliver = async (leadId, { forgeSignature = false } = {}) => {
    const raw = JSON.stringify({ object: 'page', entry: [{ id: '123456', changes: [{
      field: 'leadgen', value: {
        page_id: '123456', form_id: '654321', leadgen_id: String(leadId), created_time: 1791612000,
        field_data: [{ name: 'company_name', values: [`FORGED NOT AUTHORITATIVE ${leadId}`] }],
      },
    }] }] });
    const signature = createHmac('sha256', webhookAppSecret).update(raw).digest('hex');
    return fetch(`${base}/api/webhooks/meta/leadgen`, {
      method: 'POST', headers: {
        'content-type': 'application/json', 'x-hub-signature-256': `sha256=${forgeSignature ? '0'.repeat(64) : signature}`,
      }, body: raw,
    });
  };
  const countBefore = db.prepare("SELECT COUNT(*) AS count FROM leads WHERE source='meta_lead_ads'").get().count;
  assert.equal((await deliver(930001, { forgeSignature: true })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM meta_lead_webhook_events').get().count, 0, 'forged notifications are rejected before persistence');

  const accepted = await deliver(930001);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { received: true, accepted: 1, duplicates: 0, ignored: 0 });
  const replay = await deliver(930001);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { received: true, accepted: 0, duplicates: 1, ignored: 0 });
  const waitForEvent = async (leadId, expectedStatus) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const event = db.prepare('SELECT * FROM meta_lead_webhook_events WHERE lead_id=?').get(String(leadId));
      if (event?.status === expectedStatus) return event;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`Meta lead webhook event ${leadId} did not reach ${expectedStatus}`);
  };
  const importedEvent = await waitForEvent(930001, 'imported');
  assert.equal(importedEvent.attempts, 1, 'duplicate delivery does not claim a second processing attempt');
  const trustedLead = db.prepare('SELECT id,business_name,address,state,consent_recorded_at,consent_method FROM leads WHERE business_name=?').get('Graph-authoritative webhook company 930001');
  assert.ok(trustedLead);
  assert.equal(db.prepare('SELECT business_name FROM leads WHERE business_name LIKE ?').get('%FORGED NOT AUTHORITATIVE%'), undefined);
  assert.equal(trustedLead.consent_recorded_at, null);
  assert.equal(trustedLead.consent_method, null);
  assert.equal(trustedLead.address, '42 Synthetic Way');
  assert.equal(trustedLead.state, 'Maharashtra');
  assert.deepEqual(db.prepare('SELECT email,verification_status FROM lead_emails WHERE lead_id=?').get(trustedLead.id), {
    email: 'webhook-930001@example.test', verification_status: 'unknown',
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(trustedLead.id).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('meta_lead_webhook_events') WHERE name LIKE '%payload%' OR name LIKE '%body%'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE source='meta_lead_ads'").get().count, countBefore + 1);

  webhookLeadFailureOnce = '930002';
  assert.equal((await deliver(930002)).status, 200);
  const failedEvent = await waitForEvent(930002, 'failed');
  assert.equal(failedEvent.last_error_code, 'meta_graph_rejected');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_source_records WHERE provider=? AND external_id='930002'").get('meta_lead_ads').count, 0);
  const retry = await request('/api/leads/sources/meta/webhooks/process', { method: 'POST', body: { retry_failed: true } });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, { examined: 1, imported: 1, failed: 0, inserted: 1, duplicates: 0, sendingWorkCreated: false });
  assert.equal(db.prepare('SELECT status,attempts FROM meta_lead_webhook_events WHERE lead_id=?').get('930002').status, 'imported');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_source_records WHERE provider=? AND external_id='930002'").get('meta_lead_ads').count, 1);
  const rowsBeforeRecovery = db.prepare("SELECT COUNT(*) AS count FROM leads WHERE source='meta_lead_ads'").get().count;
  db.prepare("UPDATE meta_lead_webhook_events SET status='pending',updated_at=datetime('now') WHERE lead_id='930002'").run();
  const recovered = await recoverMetaLeadWebhooksOnStartup({ db, fetchImpl: fakeGraphFetch });
  assert.deepEqual(recovered, { examined: 1, imported: 1, failed: 0, inserted: 0, duplicates: 1, sendingWorkCreated: false });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE source='meta_lead_ads'").get().count, rowsBeforeRecovery, 'recovery after contact persistence is idempotent');
  assert.equal(db.prepare('SELECT status,attempts FROM meta_lead_webhook_events WHERE lead_id=?').get('930002').status, 'imported');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  db.prepare("INSERT INTO meta_lead_webhook_events(page_id,form_id,lead_id,status) VALUES('123456','654321','930004','failed')").run();
  const failedBeforeRecovery = db.prepare("SELECT attempts FROM meta_lead_webhook_events WHERE lead_id='930004'").get().attempts;
  const failedEventRecovery = await recoverMetaLeadWebhooksOnStartup({ db, fetchImpl: fakeGraphFetch });
  assert.equal(failedEventRecovery.examined, 0, 'startup recovery never retries an event already marked failed');
  assert.equal(db.prepare("SELECT status,attempts FROM meta_lead_webhook_events WHERE lead_id='930004'").get().attempts, failedBeforeRecovery);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('Meta throttling persists sanitized usage and blocks automatic or repeated Graph requests until explicit recovery', async () => {
  let clockMs = Date.now();
  setMetaLeadAdsClockForTests(() => clockMs);
  const savedCursor = db.prepare('SELECT after_cursor,has_more FROM meta_lead_form_cursors WHERE page_id=? AND form_id=?').get('123456', '654321');
  const sendsBefore = db.prepare('SELECT COUNT(*) AS count FROM sends').get().count;
  const leadsBefore = db.prepare("SELECT COUNT(*) AS count FROM leads WHERE source='meta_lead_ads'").get().count;
  const callsBefore = graphCalls.length;
  db.prepare(`INSERT INTO meta_lead_form_cursors(page_id,form_id,after_cursor,has_more)
    VALUES('123456','654321','saved-before-throttle',1)
    ON CONFLICT(page_id,form_id) DO UPDATE SET after_cursor=excluded.after_cursor,has_more=excluded.has_more`).run();
  db.prepare(`INSERT INTO meta_lead_webhook_events(page_id,form_id,lead_id,status)
    VALUES('123456','654321','930099','pending')`).run();
  try {
    graphMode = 'rate-limit-http';
    rateLimitOnlyLeadPage = true;
    rateLimitRetryAfter = '120';
    const throttledImport = await request('/api/leads/sources/meta/import', { method: 'POST', body: {
      form_id: '654321', batch_id: batchId, field_map: { business_name: 'company_name', email: 'email' },
    } });
    assert.equal(throttledImport.status, 429);
    assert.match(throttledImport.body.error, /retry manually/i);
    assert.equal(graphCalls.length, callsBefore + 2, 'import makes one forms request and one rate-limited page request, with no retry');
    const checkpoint = db.prepare('SELECT after_cursor,has_more FROM meta_lead_form_cursors WHERE page_id=? AND form_id=?').get('123456', '654321');
    assert.deepEqual(checkpoint, { after_cursor: 'saved-before-throttle', has_more: 1 }, 'a throttled page does not advance the saved form cursor');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE source='meta_lead_ads'").get().count, leadsBefore, 'throttled page data is not partially imported');
    const status = await request('/api/leads/sources/meta');
    assert.equal(status.status, 200);
    const rate = status.body.rateLimitUntil;
    assert.equal(Date.parse(rate), clockMs + 120_000);
    assert.equal(status.body.rateLimitActive, true);
    assert.equal(status.body.rateLimitRecoveryRequired, true);
    assert.deepEqual(status.body.rateUsage, {
      app: { callCount: 87, totalTime: 13, totalCpuTime: 9 },
      businessUseCase: [{ type: 'leadgen', callCount: 96, totalTime: 34, totalCpuTime: 17, estimatedTimeToRegainAccessMinutes: 3 }],
    });
    assert.equal(JSON.stringify(status.body.rateUsage).includes('private-business-id'), false, 'Meta business IDs and unknown header fields are not exposed');

    const blockedForms = await request('/api/leads/sources/meta/forms');
    const blockedTest = await request('/api/leads/sources/meta/test', { method: 'POST', body: {} });
    const blockedImport = await request('/api/leads/sources/meta/import', { method: 'POST', body: {
      form_id: '654321', batch_id: batchId, field_map: { business_name: 'company_name' },
    } });
    const blockedSubscribe = await request('/api/leads/sources/meta/webhook-subscribe', { method: 'POST', body: {} });
    const blockedMapping = await request('/api/leads/sources/meta/webhook-forms/654321', { method: 'PUT', body: {
      batch_id: batchId, field_map: { business_name: 'company_name' },
    } });
    const blockedWebhookRetry = await request('/api/leads/sources/meta/webhooks/process', { method: 'POST', body: { retry_failed: true } });
    assert.deepEqual([blockedForms.status, blockedTest.status, blockedImport.status, blockedSubscribe.status, blockedMapping.status, blockedWebhookRetry.status],
      [429, 429, 429, 429, 429, 429]);
    assert.equal(graphCalls.length, callsBefore + 2, 'cooldown rejects all explicit Graph actions before fetch');
    assert.equal(db.prepare("SELECT status,attempts FROM meta_lead_webhook_events WHERE lead_id='930099'").get().status, 'pending', 'pending signed webhook work remains intact');
    const startupCalls = graphCalls.length;
    const startup = await recoverMetaLeadWebhooksOnStartup({ db, fetchImpl: fakeGraphFetch, now: () => clockMs });
    assert.equal(startup.examined, 0);
    assert.equal(graphCalls.length, startupCalls, 'startup recovery does not retry after a rate limit');
    assert.equal(db.prepare("SELECT status,attempts FROM meta_lead_webhook_events WHERE lead_id='930099'").get().attempts, 0);

    clockMs = Date.parse(rate) + 1;
    graphMode = 'success';
    rateLimitOnlyLeadPage = false;
    const expiredStartupCalls = graphCalls.length;
    const expiredStartup = await recoverMetaLeadWebhooksOnStartup({ db, fetchImpl: fakeGraphFetch, now: () => clockMs });
    assert.equal(expiredStartup.examined, 0, 'startup does not resume provider work after cooldown expiry without an operator action');
    assert.equal(graphCalls.length, expiredStartupCalls);
    const incomingRaw = JSON.stringify({ object: 'page', entry: [{ id: '123456', changes: [{
      field: 'leadgen', value: { page_id: '123456', form_id: '654321', leadgen_id: '930098', created_time: 1791612000 },
    }] }] });
    const incomingSignature = createHmac('sha256', webhookAppSecret).update(incomingRaw).digest('hex');
    const incomingResponse = await fetch(`${base}/api/webhooks/meta/leadgen`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${incomingSignature}` }, body: incomingRaw,
    });
    assert.equal(incomingResponse.status, 200, 'signed notifications are still accepted and saved during manual recovery pause');
    assert.equal((await incomingResponse.json()).accepted, 1);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(db.prepare("SELECT status,attempts FROM meta_lead_webhook_events WHERE lead_id='930098'").get(), { status: 'pending', attempts: 0 });
    assert.equal(graphCalls.length, expiredStartupCalls, 'a webhook callback does not trigger provider fetch after cooldown expiry');
    const explicitRecovery = await request('/api/leads/sources/meta/test', { method: 'POST', body: {} });
    assert.equal(explicitRecovery.status, 200, 'an explicit post-expiry operator request can recover');
    assert.equal(explicitRecovery.body.rateLimitUntil, null);
    assert.equal(explicitRecovery.body.rateLimitRecoveryRequired, false);
    assert.deepEqual(db.prepare('SELECT after_cursor,has_more FROM meta_lead_form_cursors WHERE page_id=? AND form_id=?').get('123456', '654321'),
      { after_cursor: 'saved-before-throttle', has_more: 1 }, 'successful connection recovery leaves the form cursor untouched');
    assert.equal(db.prepare("SELECT status,attempts FROM meta_lead_webhook_events WHERE lead_id='930099'").get().status, 'pending', 'pending webhook work requires a separate explicit operator action');

    const recoverAfterHeader = async (header, expectedDeadline) => {
      rateLimitRetryAfter = header;
      graphMode = 'rate-limit-http-no-usage';
      const response = await request('/api/leads/sources/meta/forms');
      assert.equal(response.status, 429);
      const next = (await request('/api/leads/sources/meta')).body;
      assert.equal(Date.parse(next.rateLimitUntil), expectedDeadline);
      clockMs = expectedDeadline + 1;
      graphMode = 'success';
      const recovered = await request('/api/leads/sources/meta/forms');
      assert.equal(recovered.status, 200, 'cooldown expiry only makes a later explicit request eligible');
    };
    await recoverAfterHeader('30', clockMs + 30_000);
    const dateHeader = new Date(clockMs + 300_000).toUTCString();
    await recoverAfterHeader(dateHeader, Date.parse(dateHeader));
    await recoverAfterHeader('invalid-retry-value', clockMs + 60_000);
    await recoverAfterHeader('9999999999', clockMs + 7 * 24 * 60 * 60 * 1000);

    for (const code of [4, 17, 32, 613]) {
      graphMode = 'rate-limit-code';
      rateLimitGraphCode = code;
      const response = await request('/api/leads/sources/meta/forms');
      assert.equal(response.status, 429, `Graph throttling code ${code} becomes an explicit cooldown`);
      const limited = (await request('/api/leads/sources/meta')).body;
      assert.equal(limited.rateLimitRecoveryRequired, true);
      clockMs = Date.parse(limited.rateLimitUntil) + 1;
      graphMode = 'success';
      assert.equal((await request('/api/leads/sources/meta/forms')).status, 200);
    }
    const lastRateUsage = (await request('/api/leads/sources/meta')).body.rateUsage;
    assert.equal(lastRateUsage.app.callCount, 99, 'successful responses without usage headers do not erase the last observed usage');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, sendsBefore, 'Meta lead intake creates no send rows');
  } finally {
    if (savedCursor) {
      db.prepare(`UPDATE meta_lead_form_cursors SET after_cursor=?,has_more=? WHERE page_id='123456' AND form_id='654321'`)
        .run(savedCursor.after_cursor, savedCursor.has_more);
    } else db.prepare("DELETE FROM meta_lead_form_cursors WHERE page_id='123456' AND form_id='654321'").run();
    db.prepare("DELETE FROM meta_lead_webhook_events WHERE lead_id='930099'").run();
    db.prepare("DELETE FROM meta_lead_webhook_events WHERE lead_id='930098'").run();
    graphMode = 'success';
    rateLimitOnlyLeadPage = false;
    rateLimitRetryAfter = '120';
    setMetaLeadAdsClockForTests(null);
  }
});

test('manual form import persists Meta provenance and idempotent IDs without inferring consent or sending', async () => {
  graphCalls.length = 0;
  const imported = await request('/api/leads/sources/meta/import', { method: 'POST', body: {
    form_id: '654321', batch_id: batchId,
    field_map: { business_name: 'company_name', email: 'email', phone: 'phone_number', city: 'city' },
  } });
  assert.equal(imported.status, 200);
  assert.deepEqual(imported.body, {
    batchId, formId: '654321', fetched: 4, mapped: 4, inserted: 2, duplicates: 2, rejected: 0,
    rejectedRows: 2, truncated: false, emailEvidence: 'unknown', consentRecorded: false, sendingWorkCreated: false,
    hasMore: false, cursorAdvanced: true,
  });
  assert.equal(graphCalls.length, 3, 'the form was checked, then both cursor pages were retrieved');
  assert.equal(graphCalls[2].search.includes('after=synthetic-cursor-one'), true);
  assert.equal(graphCalls.some(call => call.path.includes('malicious')), false, 'the provider paging.next URL is never followed');
  assert.equal(graphCalls.every(call => !call.search.includes(token)), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_source_records').get().count, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);

  const lead = db.prepare("SELECT * FROM leads WHERE business_name='North Star Workshop'").get();
  assert.ok(lead);
  assert.equal(lead.source, 'meta_lead_ads');
  assert.equal(lead.source_details, 'Meta Lead Ads · form 654321 · submitted 2026-10-08T09:00:00.000Z');
  assert.equal(lead.consent_recorded_at, null);
  assert.equal(lead.consent_method, null);
  assert.equal(lead.consent_evidence_url, null);
  assert.deepEqual(db.prepare('SELECT email,source,verification_status,is_primary FROM lead_emails WHERE lead_id=?').get(lead.id), {
    email: 'hello@northstar.example.test', source: 'meta_lead_ads', verification_status: 'unknown', is_primary: 1,
  });
  assert.deepEqual(db.prepare('SELECT provider,external_id,page_id,form_id,source_created_at FROM lead_source_records WHERE lead_id=?').get(lead.id), {
    provider: 'meta_lead_ads', external_id: '710001', page_id: '123456', form_id: '654321', source_created_at: '2026-10-08T09:00:00.000Z',
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE lead_id=? AND event_type='contact_imported'").get(lead.id).count, 1);

  const replay = await request('/api/leads/sources/meta/import', { method: 'POST', body: {
    form_id: '654321', batch_id: batchId, field_map: { business_name: 'company_name', email: 'email' },
  } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.inserted, 0);
  assert.equal(replay.body.duplicates, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  assert.equal((await request(`/api/leads?batch_id=${batchId}&search=North%20Star%20Workshop`)).body.pagination.total, 1);
});

test('Meta form catalog continuation is durable, Page-scoped, replayable after failure, and ignores paging URLs', async () => {
  db.prepare('DELETE FROM meta_lead_form_list_cursors WHERE page_id=?').run('123456');
  const otherPageCursor = { after_cursor: 'other-page-opaque', has_more: 1 };
  db.prepare(`INSERT INTO meta_lead_form_list_cursors(page_id,after_cursor,has_more)
    VALUES('999999',?,?) ON CONFLICT(page_id) DO UPDATE SET after_cursor=excluded.after_cursor,has_more=excluded.has_more`)
    .run(otherPageCursor.after_cursor, otherPageCursor.has_more);
  formPaginationScenario = true;
  failFormContinuationOnce = true;
  try {
    graphCalls.length = 0;
    malformedFormCursor = true;
    const malformed = await request('/api/leads/sources/meta/forms');
    assert.equal(malformed.status, 502, 'a response with an invalid opaque cursor is rejected');
    assert.equal(db.prepare('SELECT after_cursor FROM meta_lead_form_list_cursors WHERE page_id=?').get('123456'), undefined,
      'invalid form-list data does not create or advance a checkpoint');
    malformedFormCursor = false;
    const first = await request('/api/leads/sources/meta/forms');
    assert.equal(first.status, 200);
    assert.equal(first.body.forms.length, 100);
    assert.equal(first.body.hasMore, true);
    assert.equal(new Set(first.body.forms.map(form => form.id)).size, 100);
    assert.deepEqual(db.prepare('SELECT after_cursor,has_more FROM meta_lead_form_list_cursors WHERE page_id=?').get('123456'), {
      after_cursor: 'forms-cursor-100', has_more: 1,
    });
    assert.deepEqual(db.prepare('SELECT after_cursor,has_more FROM meta_lead_form_list_cursors WHERE page_id=?').get('999999'), otherPageCursor,
      'loading the configured Page does not replace another Page checkpoint');

    const failed = await request('/api/leads/sources/meta/forms/next', { method: 'POST', body: {} });
    assert.equal(failed.status, 502);
    assert.deepEqual(db.prepare('SELECT after_cursor,has_more FROM meta_lead_form_list_cursors WHERE page_id=?').get('123456'), {
      after_cursor: 'forms-cursor-100', has_more: 1,
    }, 'a transient next-page failure preserves its durable cursor');

    // The route creates a fresh manager for every request; continuation state
    // is read from SQLite rather than held in manager memory.
    const continued = await request('/api/leads/sources/meta/forms/next', { method: 'POST', body: {} });
    assert.equal(continued.status, 200);
    assert.equal(continued.body.forms.length, 7);
    assert.equal(continued.body.hasMore, false);
    const allForms = [...first.body.forms, ...continued.body.forms];
    assert.equal(allForms.length, 107);
    assert.equal(new Set(allForms.map(form => form.id)).size, 107, 'the two pages have no gaps or repeated IDs');
    assert.deepEqual(db.prepare('SELECT after_cursor,has_more FROM meta_lead_form_list_cursors WHERE page_id=?').get('123456'), {
      after_cursor: null, has_more: 0,
    });
    const nextCalls = graphCalls.filter(call => call.path === '/v24.0/123456/leadgen_forms' && call.search.includes('after='));
    assert.equal(nextCalls.length, 2, 'the failed request and explicit replay use the same saved cursor');
    assert.ok(nextCalls.every(call => new URLSearchParams(call.search).get('after') === 'forms-cursor-100'));
    assert.equal(graphCalls.some(call => call.path.includes('malicious.example.test') || call.search.includes('malicious.example.test')), false,
      'the provider paging.next URL is never stored or followed');
    const beforeNoMore = graphCalls.length;
    assert.equal((await request('/api/leads/sources/meta/forms/next', { method: 'POST', body: {} })).status, 409);
    assert.equal(graphCalls.length, beforeNoMore, 'a completed Page list is rejected locally');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  } finally {
    formPaginationScenario = false;
    failFormContinuationOnce = false;
    malformedFormCursor = false;
    db.prepare('DELETE FROM meta_lead_form_list_cursors WHERE page_id IN (?,?)').run('123456', '999999');
  }
});

test('large Meta form imports resume from durable cursors after a request failure without skips or duplicate rows', async () => {
  db.prepare('DELETE FROM meta_lead_form_cursors WHERE page_id=? AND form_id=?').run('123456', '654321');
  largePaginationScenario = true;
  const body = {
    form_id: '654321', batch_id: batchId,
    field_map: { business_name: 'company_name', email: 'email' },
  };
  try {
    const first = await request('/api/leads/sources/meta/import', { method: 'POST', body });
    assert.equal(first.status, 200);
    assert.equal(first.body.fetched, 250);
    assert.equal(first.body.inserted, 250);
    assert.equal(first.body.hasMore, true);
    assert.equal(first.body.cursorAdvanced, true);
    assert.equal(db.prepare('SELECT after_cursor,has_more FROM meta_lead_form_cursors WHERE page_id=? AND form_id=?').get('123456', '654321').after_cursor, 'large-cursor-250');
    assert.equal(db.prepare('SELECT has_more FROM meta_lead_form_cursors WHERE page_id=? AND form_id=?').get('123456', '654321').has_more, 1);

    const forms = await request('/api/leads/sources/meta/forms');
    assert.equal(forms.status, 200);
    assert.equal(forms.body.forms[0].continuationAvailable, true, 'the Forms API reflects the resumable saved cursor');
    assert.equal(forms.body.forms[0].moreResultsLastSeen, true);

    failLargeContinuationOnce = true;
    const failed = await request('/api/leads/sources/meta/import', { method: 'POST', body });
    assert.equal(failed.status, 502);
    assert.equal(db.prepare('SELECT after_cursor FROM meta_lead_form_cursors WHERE page_id=? AND form_id=?').get('123456', '654321').after_cursor, 'large-cursor-250', 'a failed provider request leaves the checkpoint unchanged');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_source_records WHERE provider=? AND form_id=?').get('meta_lead_ads', '654321').count, 254, 'the two earlier imports and 250 new rows are persisted');

    // Each HTTP request creates a fresh manager instance; its only resume state is the durable SQLite cursor.
    const resumed = await request('/api/leads/sources/meta/import', { method: 'POST', body });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.fetched, 1);
    assert.equal(resumed.body.inserted, 1);
    assert.equal(resumed.body.duplicates, 0);
    assert.equal(resumed.body.hasMore, false);
    assert.equal(resumed.body.cursorAdvanced, true);
    assert.deepEqual(db.prepare('SELECT after_cursor,has_more FROM meta_lead_form_cursors WHERE page_id=? AND form_id=?').get('123456', '654321'), {
      after_cursor: 'large-cursor-251', has_more: 0,
    });

    const importedIds = db.prepare('SELECT external_id FROM lead_source_records WHERE provider=? AND form_id=? ORDER BY CAST(external_id AS INTEGER)').all('meta_lead_ads', '654321').map(record => Number(record.external_id));
    assert.equal(importedIds.length, 255);
    assert.deepEqual(importedIds.filter(id => id >= 720001 && id <= 720251), Array.from({ length: 251 }, (_, index) => 720001 + index), 'all provider IDs in the large fixture exist exactly once');
    const noMore = await request('/api/leads/sources/meta/import', { method: 'POST', body });
    assert.equal(noMore.status, 200);
    assert.equal(noMore.body.fetched, 0);
    assert.equal(noMore.body.inserted, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_source_records WHERE provider=? AND form_id=?').get('meta_lead_ads', '654321').count, 255);
    assert.equal(graphCalls.some(call => call.path.includes('malicious.example.test')), false, 'no Graph paging.next URL is followed');
    assert.equal(graphCalls.every(call => !call.search.includes(token)), true);
  } finally {
    largePaginationScenario = false;
    failLargeContinuationOnce = false;
  }
});

test('Meta page/form mismatch, closed batch, and provider rejection fail without partial contacts', async () => {
  const before = db.prepare('SELECT COUNT(*) AS count FROM leads').get().count;
  assert.equal((await request('/api/leads/sources/meta/import', { method: 'POST', body: {
    form_id: '654321', batch_id: closedBatchId, field_map: { business_name: 'company_name' },
  } })).status, 409);
  assert.equal((await request('/api/leads/sources/meta/import', { method: 'POST', body: {
    form_id: 'not-an-id', batch_id: batchId, field_map: { business_name: 'company_name' },
  } })).status, 400);
  const mismatchedForm = await request('/api/leads/sources/meta/import', { method: 'POST', body: {
    form_id: '111111', batch_id: batchId, field_map: { business_name: 'company_name' },
  } });
  assert.equal(mismatchedForm.status, 400);
  assert.match(mismatchedForm.body.error, /listed under the configured Page/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, before);

  graphMode = 'mismatch';
  const pageMismatch = await request('/api/leads/sources/meta/test', { method: 'POST', body: {} });
  assert.equal(pageMismatch.status, 502);
  assert.equal((await request('/api/leads/sources/meta/forms')).status, 409, 'failed Page check clears verified state');
  graphMode = 'success';
  assert.equal((await request('/api/leads/sources/meta/test', { method: 'POST', body: {} })).status, 200);

  graphMode = 'reject';
  const rejected = await request('/api/leads/sources/meta/test', { method: 'POST', body: {} });
  assert.equal(rejected.status, 502);
  assert.equal(JSON.stringify(rejected.body).includes(token), false);
  assert.equal(JSON.stringify(rejected.body).includes('synthetic'), false, 'provider error bodies are not reflected to the user');
  graphMode = 'success';
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, before);
});

test('Meta Lead Ads import can be operated through Contacts in a real browser', async t => {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!process.env.ODD_CHROMIUM_EXECUTABLE_PATH && !existsSync(edgePath)) return t.skip('No local Edge runtime is installed on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: process.env.ODD_CHROMIUM_EXECUTABLE_PATH || edgePath });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block' });
  await context.addCookies([
    { name: 'odd_session', value: owner.session, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' },
    { name: 'odd_csrf', value: owner.csrf, domain: '127.0.0.1', path: '/', sameSite: 'Strict' },
  ]);
  const page = await context.newPage();
  const errors = [];
  const externalOrigins = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    if (['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(url.origin)) return route.abort();
    externalOrigins.push(url.origin);
    return route.abort();
  });
  await context.route('**/api/personalize/ollama-test*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ connected: false, available: false, status: 'not-tested-in-meta-ui-test' }),
  }));
  try {
    db.prepare('DELETE FROM meta_lead_form_cursors WHERE page_id=? AND form_id=?').run('123456', '654321');
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#workspace-navigation').waitFor();
    await page.locator('#workspace-navigation [data-view="leads"]').click();
    await page.locator('#lead-import-meta').waitFor();
    leadsForUi = true;
    await page.locator('#lead-import-meta').click();
    const dialog = page.getByRole('dialog', { name: 'Import Meta Lead Ads' });
    await dialog.locator('[name="page_id"]').fill('123456');
    await dialog.locator('[name="graph_version"]').fill('v24.0');
    await dialog.locator('[name="access_token"]').fill(token);
    await dialog.getByRole('button', { name: 'Save connection' }).click();
    await dialog.getByText(/Connection saved/).waitFor();
    await dialog.getByRole('button', { name: 'Test Page access' }).click();
    await dialog.getByText('Connected to Synthetic Page.').waitFor();
    await dialog.locator('[data-meta-app-secret]').fill(webhookAppSecret);
    await dialog.locator('[data-meta-verify-token]').fill(webhookVerifyToken);
    await dialog.getByRole('button', { name: 'Save webhook settings' }).click();
    await dialog.getByText(/Webhook verification settings saved/).waitFor();
    await dialog.getByText('Webhook callback URL: https://odd.example.test/api/webhooks/meta/leadgen').waitFor();
    await dialog.getByRole('button', { name: 'Subscribe Page to leadgen' }).click();
    await dialog.getByText('Meta confirmed the leadgen subscription for Page 123456. You can refresh later to see new notifications.').waitFor();
    formPaginationScenario = true;
    await dialog.getByRole('button', { name: 'Load forms' }).click();
    await dialog.locator('[name="form_id"] option[value="654321"]').waitFor({ state: 'attached' });
    const loadMoreFormsButton = dialog.getByRole('button', { name: 'Load more forms' });
    await loadMoreFormsButton.waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('[name="form_id"] option').count(), 101, 'first page contains 100 forms plus the placeholder');
    await dialog.locator('[name="form_id"]').selectOption('654321');
    await loadMoreFormsButton.click();
    await dialog.locator('[name="form_id"] option[value="900106"]').waitFor({ state: 'attached' });
    assert.equal(await dialog.locator('[name="form_id"] option').count(), 108, 'continuation appends all later forms while keeping the first page');
    assert.equal(await dialog.locator('[name="form_id"]').inputValue(), '654321', 'continuing the list preserves the selected form');
    await loadMoreFormsButton.waitFor({ state: 'hidden' });
    assert.equal(await dialog.locator('[data-meta-map="address"]').inputValue(), 'street_address', 'saved address mapping is restored when the form is selected');
    assert.equal(await dialog.locator('[data-meta-map="state"]').inputValue(), 'state', 'saved state mapping is restored when the form is selected');
    await dialog.getByLabel('Business or respondent name *').selectOption('company_name');
    await dialog.getByLabel('Email address').selectOption('email');
    await dialog.locator('[data-meta-map="address"]').selectOption('street_address');
    await dialog.locator('[data-meta-map="state"]').selectOption('state');
    await dialog.getByRole('button', { name: 'Save mapping for live leads' }).click();
    await dialog.getByText('Mapping saved. Signed notifications for this form can now be retrieved and imported.').waitFor();
    const importButton = dialog.getByRole('button', { name: /Import next 250 submissions/ });
    await importButton.click();
    await dialog.locator('[data-meta-message]').getByText(/250 added, 0 duplicates, 0 rejected/).waitFor();
    await dialog.getByText(/More submissions remain/).waitFor();
    assert.equal(await dialog.isVisible(), true, 'the operator can continue large imports without reopening the dialog');
    await importButton.click();
    await dialog.locator('[data-meta-message]').getByText(/1 added, 0 duplicates, 0 rejected/).waitFor();
    await dialog.getByText(/no further submissions at the saved checkpoint/i).waitFor();
    await page.locator('.lead-biz-name').getByText('Browser-imported synthetic supplier', { exact: true }).waitFor();
    const browserLead = db.prepare("SELECT id,address,state FROM leads WHERE business_name='Browser-imported synthetic supplier'").get();
    assert.ok(browserLead?.id, 'real Contacts UI import persists through API and database');
    assert.equal(browserLead.address, '250 Synthetic Way');
    assert.equal(browserLead.state, 'Maharashtra');
    assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=?').get(browserLead.id).verification_status, 'unknown');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(browserLead.id).count, 0);

    const webhookRaw = JSON.stringify({ object: 'page', entry: [{ id: '123456', changes: [{
      field: 'leadgen', value: { page_id: '123456', form_id: '654321', leadgen_id: '930003', created_time: 1791612000 },
    }] }] });
    const webhookSignature = createHmac('sha256', webhookAppSecret).update(webhookRaw).digest('hex');
    const webhookReceipt = await page.evaluate(async ({ raw, signature }) => {
      const response = await fetch('/api/webhooks/meta/leadgen', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` }, body: raw,
      });
      return { status: response.status, body: await response.json() };
    }, { raw: webhookRaw, signature: webhookSignature });
    assert.equal(webhookReceipt.status, 200);
    assert.equal(webhookReceipt.body.accepted, 1);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (db.prepare('SELECT status FROM meta_lead_webhook_events WHERE lead_id=?').get('930003')?.status === 'imported') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(db.prepare('SELECT status FROM meta_lead_webhook_events WHERE lead_id=?').get('930003').status, 'imported');
    await dialog.getByRole('button', { name: 'Refresh notifications' }).click();
    await dialog.locator('[data-meta-webhook-events]').getByText(/lead 930003 · imported/).waitFor();
    const webhookLead = db.prepare("SELECT id FROM leads WHERE business_name='Graph-authoritative webhook company 930003'").get();
    assert.ok(webhookLead?.id, 'webhook receipt retrieves and persists authoritative contact fields');
    assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=?').get(webhookLead.id).verification_status, 'unknown');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(webhookLead.id).count, 0);
    const callsBeforeCooldown = graphCalls.length;
    graphMode = 'rate-limit-http';
    rateLimitOnlyLeadPage = false;
    rateLimitRetryAfter = '120';
    await dialog.getByRole('button', { name: 'Load forms' }).click();
    const cooldownNotice = dialog.locator('[data-meta-rate-status][data-state="cooldown"]');
    await cooldownNotice.waitFor();
    assert.match(await cooldownNotice.textContent(), /Meta rate limit active/i);
    assert.match(await cooldownNotice.textContent(), /app calls 87%/i, 'the UI shows only normalized usage percentages');
    assert.equal(await dialog.getByRole('button', { name: 'Load forms' }).isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: 'Test Page access' }).isDisabled(), true);
    assert.equal(graphCalls.length, callsBeforeCooldown + 1, 'the throttled UI action made one request and did not retry');
    await page.waitForTimeout(300);
    assert.equal(graphCalls.length, callsBeforeCooldown + 1, 'cooldown expiry is not polled into an automatic Graph retry');
    graphMode = 'success';
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('#workspace-navigation [data-view="dashboard"]').click();
    await page.locator('#workspace-navigation [data-view="leads"]').click();
    await page.locator('.lead-biz-name').getByText('Graph-authoritative webhook company 930003', { exact: true }).waitFor();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_source_records WHERE provider=? AND form_id=?').get('meta_lead_ads', '654321').count, 507, 'the real Contacts UI imports both form pages and the signed notification lead');
    assert.deepEqual(errors, []);
    assert.deepEqual(externalOrigins, []);
  } finally {
    formPaginationScenario = false;
    await browser.close();
  }
});
