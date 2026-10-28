// Local orchestration only: disposable fixtures, real auth, no outbound network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const previewPort = Number(process.env.ODD_PREVIEW_PORT || 3210);
const requestedFixtureLabel = process.env.ODD_PREVIEW_FIXTURE_LABEL || '';
const requestedProspectingIntegration = process.env.ODD_PREVIEW_PROSPECTING_INTEGRATION === 'true';
const r18Preview = requestedFixtureLabel === 'r18-customer-preview';
if (requestedFixtureLabel && !r18Preview) throw new Error('Unrecognized local preview fixture selection.');
if (r18Preview && (previewPort !== 3212 || process.env.ODD_PREVIEW_TENANT !== '1')) {
  throw new Error('The R18 customer preview requires its dedicated tenant mode and port.');
}
const tenantPreview = r18Preview || process.env.ODD_PREVIEW_TENANT === '1';
const fixturePath = r18Preview
  ? path.join(repo, '.runner/astra-qa/r18-customer-preview/pg.json')
  : path.join(repo, '.runner/astra-preview/pg.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const PREVIEW_MIGRATIONS = Object.freeze([
  ['001-tenant-foundation.up.sql', '327e3c8e5e0dbaf083461985c44b233fc994db5c51731878f7fe8493cc82e38b'],
  ['002-ledger.up.sql', '6c2c20f167070bd819740a74eeb1f12d12594e1179a368e2a88f5e62f9ff3575'],
  ['003-workflow.up.sql', 'bc17f70789c297c20130de9f5c5558221ed13f962d58bf2838ae62a49f4680c3'],
  ['004-gateway.up.sql', '26003482360b07d3e568c3e89096cdf4e8e0f1591716953c6be3d587c7168c91'],
  ['005-research.up.sql', '37a3e778a201140719e54253a65af9321ff2199ef7802085d62f67d6f954bb24'],
  ['006-inbox-permissions.up.sql', '8992d70731aced726405af3bbf14e39b1fba7a604b70d285b3b0c82e36bd73d4'],
  ['007-campaigns.up.sql', '1fb9211bd8d5b81f4b20b4e2b09862fcc0c7b99164ab0ffedf3a87f84c1c59bf'],
  ['008-insights.up.sql', '689a812409610822331ea21721b12e735b2c5ae9e1016f3dc1bbb9691e062815'],
  ['009-runtime.up.sql', 'aff468c35dd05484ee849e8aa881084ddb175b20f45902d8a2bbcc948653a958'],
  ['010-connectors.up.sql', '2b218fcb2f834f7aa797b2a680268789412959dbf0cf274083543bc1e26e04c8'],
  ['011-generation.up.sql', '71bc191858ff99ef3a40d4c65fbc37239c6dfb54b2d0e70a088feb5346dfc53e'],
  ['012-autonomy.up.sql', 'f7cbe26de1e4811fb00ca19fd8bffe8f79edc19ffc224cb4c912355516d5503f'],
  ['013-evaluation.up.sql', 'c43b3a94188cbd39e972434454303796057a1e0f18417eeef8117657b0b3d1e5'],
  ['014-lifecycle.up.sql', '858ba8944ef6a64247858b33029c7f8ef9b11adbec82d26cd471ba1e5757b509'],
  ['015-operations.up.sql', '30dafb540b05ee76c1c48b967e67bfa6692b65ba7a66b04a232c1e9842fb268b'],
  ['016-radar.up.sql', '466b31b11c8b8e0eab3c30c43443a26489eae460dccd4be4e27db969e09438a1'],
  ['017-learning.up.sql', '4efb51a12b2a92cb375de90273f909f4a5e303e13a67806454056d5bbc297857'],
  ['018-economics-postsale.up.sql', '8f512e5b7820974fe183049b361bc594db01db96b17c6847a44e72d1a388f1b9'],
  ['019-launch-controls.up.sql', '7d8cfc7a6e3fc7999b7de4abedb40e4c80785797729e49869a0c9fabfe62738a'],
  ['020-conformance.up.sql', '0ac13d1977a943379969c1bc550526484593149e5439222dd4f8dc4430c5974f'],
  ['021-bandits.up.sql', 'a2992ff62387fce066c77b00e2f60c852271e72c71bb7fc853d18974698ee8b3'],
  ['022-memberships.up.sql', '8913c0c497e45ec75b8ab393e92947187308062bb52c436988d1235aa96e7faf'],
  ['023-customer-approvals.up.sql', 'bad23d26f2082b947ef285924caa97996b23fd3ea60754b840a30d2ce93b00bd'],
  ['024-domain-harness.up.sql', '2694bd7dd63667f3ca3d360c1fedd223562ba2d379c0a6292ab208acfdff18fd'],
  ['025-source-collection.up.sql', '1f9ea957db2faf1b65060b31b89af2aa49490aab8f9836b1c1c72c3ab838f076'],
  ['026-smtp-dispatch.up.sql', 'dc84e1a720e213f1e37367298f58ae04682fefb9470d2839debbc4b37a1a3383'],
  ['027-release-evidence.up.sql', '1ccd7dd355d86aa249182f01510eba07122f2838b05a5a273f4ec697e3a18ad1'],
  ['028-benchmark.up.sql', '7f7a383dac89e51eec75496107664eb49003e1f0089fca7377236f095539ec3a'],
  ['029-optimizer-execution.up.sql', 'ac9078cf8691c0812eec1e73bc2ab654cab1ae9304dfae4e46a4bc0c7f55cb29'],
  ['030-membership-hardening.up.sql', 'b6a5029c6c2cdd6c9b4c675553c6e8d8142d6d4ae3cac787db29c7b97eb43246'],
  ['031-research-idempotency.up.sql', 'd6601d42cd01f2c7e2d690bc03b660cfab2f828ad5f8516d0eb17d781263d76c'],
  ['032-workspace-discovery.up.sql', '547fec6287dc993097ff1e6faa999e925f1b1361b34d4c472f0624e0f0e6dd44'],
  ['033-source-rights-revocations.up.sql', '3f03c37ad0950260fa30f900de48061da45165a814e2ffce420ac13678850288'],
]);
function validateR18Fixture(file) {
  const repoCanonical = fs.realpathSync(repo);
  const qaRoot = fs.realpathSync(path.join(repoCanonical, '.runner/astra-qa'));
  const canonical = fs.realpathSync(file);
  const relative = path.relative(qaRoot, canonical);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
    || relative !== path.join('r18-customer-preview', 'pg.json')) {
    throw new Error('R18 preview fixture must be the named repository QA fixture.');
  }
  const fixture = JSON.parse(fs.readFileSync(canonical, 'utf8'));
  if (fixture.label !== 'r18-customer-preview' || fixture.mode !== 'disposable-synthetic-qa' || fixture.realData !== false
    || !Array.isArray(fixture.migrations) || ![32, 33].includes(fixture.migrations.length)
    || typeof fixture.clusterFixture !== 'string' || !fixture.clusterFixture
    || typeof fixture.parentPreviewFixture !== 'string' || !fixture.parentPreviewFixture
    || !Number.isInteger(fixture.port) || fixture.port < 1 || fixture.port > 65535
    || typeof fixture.contextSecret !== 'string' || fixture.contextSecret.length < 32) {
    throw new Error('R18 preview fixture identity or safety metadata is invalid.');
  }
  const migrationsDir = path.join(repoCanonical, 'migrations', 'astra');
  for (let index = 0; index < fixture.migrations.length; index += 1) {
    const entry = fixture.migrations[index];
    const [expectedFile, expectedHash] = PREVIEW_MIGRATIONS[index];
    if (entry?.file !== expectedFile || String(entry?.sha256 || '').toLowerCase() !== expectedHash) throw new Error('R18 preview migration manifest is invalid.');
    const migrationPath = path.join(migrationsDir, entry.file);
    if (path.dirname(migrationPath) !== migrationsDir || sha256(fs.readFileSync(migrationPath)) !== expectedHash) {
      throw new Error('R18 preview migration hash does not match this source checkout.');
    }
  }
  if (fixture.migrations[31].file !== '032-workspace-discovery.up.sql') throw new Error('R18 preview requires the pinned migration 032 UP file.');
  const identities = [];
  for (const [connectionString, expectedRole] of [
    [fixture.connectionString, 'app'], [fixture.workerConnectionString, 'worker'],
  ]) {
    const connection = new URL(connectionString);
    const role = decodeURIComponent(connection.username);
    if (!['postgres:', 'postgresql:'].includes(connection.protocol)
      || !['127.0.0.1', '::1', 'localhost'].includes(connection.hostname)
      || Number(connection.port) !== fixture.port
      || decodeURIComponent(connection.pathname.slice(1)) !== fixture.databaseName
      || !connection.password || !new RegExp(`^astra_qa_${expectedRole}_r18_customer_preview_[a-f0-9]{8}$`, 'i').test(role)) {
      throw new Error('R18 preview database endpoint or role identity is invalid.');
    }
    identities.push(role);
  }
  if (identities[0] === identities[1]) throw new Error('R18 preview application and worker roles must be distinct.');
  const suffix = fixture.databaseName.match(/^odd_astra_qa_r18_customer_preview_([a-f0-9]{8})$/)?.[1];
  if (!suffix || !identities.every(role => role.endsWith(suffix))) throw new Error('R18 preview database and role identities do not match.');
  return fixture;
}
const pgFixture = tenantPreview
  ? r18Preview ? validateR18Fixture(fixturePath) : JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  : null;
const privateDir = r18Preview ? path.join(repo, '.runner/astra-qa/r18-customer-preview') : path.join(repo, '.runner/astra-preview');
const privateStateFile = r18Preview
  ? path.join(privateDir, `preview-state-${previewPort}.json`)
  : path.join(privateDir, `session-${previewPort}.json`);
const previous = fs.existsSync(privateStateFile) ? JSON.parse(fs.readFileSync(privateStateFile, 'utf8')) : null;
if (previous && (previous.mode !== 'synthetic-local-preview' || !path.resolve(previous.directory).startsWith(path.join(os.tmpdir(), 'odd-astra-preview-'))
  || (r18Preview && previous.clusterFixture !== pgFixture.clusterFixture))) throw new Error('Unrecognized local preview state.');
if (!Number.isInteger(previewPort) || previewPort < 1024 || previewPort > 65535) throw new Error('Invalid preview port.');
// Start from a small OS runtime environment. No caller credentials, provider
// destinations, proxy settings or customer database paths reach server.js.
const safeRuntimeEnvironment = new Map(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
for (const key of Object.keys(process.env)) delete process.env[key];
for (const [key, value] of safeRuntimeEnvironment) process.env[key] = value;
const directory = previous?.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'odd-astra-preview-'));
// A dedicated persistent preview key lets synthetic connector settings use the
// real vault without inheriting any customer credential or production key.
fs.mkdirSync(path.dirname(privateStateFile), { recursive: true });
const previewKeyFile = path.join(path.dirname(privateStateFile), `credential-key-${previewPort}.txt`);
if (!fs.existsSync(previewKeyFile)) fs.writeFileSync(previewKeyFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
const previewCredentialKey = fs.readFileSync(previewKeyFile, 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(previewCredentialKey)) throw new Error('Unrecognized preview credential key; preserve it for recovery.');
Object.assign(process.env, {
  NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '0', LOCAL_PREVIEW: '1',
  ODD_DB_PATH: path.join(directory, 'preview.db'),
  ODD_AUTH_BOOTSTRAP_TOKEN: randomBytes(32).toString('hex'),
  ODD_AUTH_COOKIE_SECURE: 'false', ODD_GOOGLE_LOGIN_ENABLED: 'false',
  ASTRA_GLM_EGRESS_ENABLED: 'false',
  ODD_CREDENTIAL_ENCRYPTION_KEY: previewCredentialKey,
});
if (tenantPreview) Object.assign(process.env, {
  ASTRA_TENANT_MODE: '1', ASTRA_LEGACY_OFFER_BRIDGE: '1',
  ASTRA_DATABASE_URL: pgFixture.connectionString, ASTRA_CONTEXT_SECRET: pgFixture.contextSecret,
  ASTRA_WORKER_DATABASE_URL: pgFixture.workerConnectionString || '',
});
let integration = null;
if (requestedProspectingIntegration) {
  if (!r18Preview || !previous?.tenant?.tenantId) throw new Error('Integration requires the existing isolated preview tenant.');
  const { loadProspectingIntegration } = await import('./prospecting-integration.mjs');
  integration = loadProspectingIntegration({ tenantId: previous.tenant.tenantId });
  Object.assign(process.env, integration.env);
}

const allowedPorts = new Set();
if (pgFixture) allowedPorts.add(pgFixture.port);
const deny = () => Object.assign(new Error('External actions are disabled in the local preview.'), { code: 'LOCAL_PREVIEW_EGRESS_DISABLED' });
function assertDestination(host, port) {
  if (integration && [443, 27017].includes(Number(port)) && (integration.allowedHost(host) || net.isIP(String(host)))) return;
  if (integration && String(host) === '127.0.0.1' && Number(port) === 8081) { integration.reserveSearch(); return; }
  if (!['127.0.0.1', '::1', 'localhost'].includes(String(host || 'localhost')) || !allowedPorts.has(Number(port))) throw deny();
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  if (first && typeof first === 'object') {
    if (first.path) throw deny();
    assertDestination(first.host || first.hostname, first.port);
  } else if (typeof first === 'number' || /^\d+$/.test(String(first))) {
    assertDestination(typeof normalized[1] === 'string' ? normalized[1] : 'localhost', first);
  } else throw deny();
  return originalConnect.apply(this, args);
};
const originalTlsConnect = tls.connect;
tls.connect = (...args) => {
  if (!integration) throw deny();
  const options = typeof args[0] === 'object' ? args[0] : args.find(value => value && typeof value === 'object') || {};
  const port = options.port || (typeof args[0] === 'number' ? args[0] : 443);
  const host = options.servername || options.host;
  if (![443, 27017].includes(Number(port)) || !integration.allowedHost(host)) throw deny();
  return originalTlsConnect(...args);
};
const originalLookup = dns.lookup;
dns.lookup = (hostname, ...args) => {
  if (!['127.0.0.1', '::1', 'localhost'].includes(String(hostname)) && !integration?.allowedHost(hostname)) throw deny();
  return originalLookup(hostname, ...args);
};
for (const method of Object.keys(dns)) {
  if (method.startsWith('resolve') || method === 'reverse') {
    const original = dns[method];
    dns[method] = (host, ...args) => { if (!integration?.allowedHost(host)) throw deny(); return original(host, ...args); };
  }
}
for (const method of Object.keys(dns.promises)) {
  if (method.startsWith('resolve') || ['lookup', 'lookupService', 'reverse'].includes(method)) {
    const original = dns.promises[method];
    dns.promises[method] = async (host, ...args) => { if (!integration?.allowedHost(host)) throw deny(); return original(host, ...args); };
  }
}
for (const method of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  childProcess[method] = () => { throw deny(); };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (integration && !(url.protocol === 'http:' && allowedPorts.has(Number(url.port)))) {
    integration.allowFetch(url, String(options?.method || 'GET').toUpperCase());
    const response = originalFetch(input, options);
    if (url.origin === 'https://freeinference.org' && url.pathname.endsWith('/chat/completions')) {
      response.then(result => result.clone().json().then(body => {
        const safeCode = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : null;
        fs.writeFileSync(path.join(repo, '.superpowers/astra-discovery-runtime/latest-provider-response.json'), JSON.stringify({
          status: result.status, actualModel: safeCode(body.model), finishReason: safeCode(body.choices?.[0]?.finish_reason),
          errorCode: safeCode(body.error?.code), inputTokens: Number.isSafeInteger(body.usage?.prompt_tokens) ? body.usage.prompt_tokens : null,
          outputTokens: Number.isSafeInteger(body.usage?.completion_tokens) ? body.usage.completion_tokens : null,
          rawContentRetained: false, observedAt: new Date().toISOString(),
        }, null, 2));
      }).catch(() => {})).catch(() => {});
    }
    return response;
  }
  if (url.protocol !== 'http:') throw deny();
  assertDestination(url.hostname, url.port || 80);
  return originalFetch(input, options);
};
syncBuiltinESMExports();

const database = await import('../../pipeline/database.js');
const db = database.initDb();
const { createAuthManager } = await import('../../pipeline/auth-manager.js');
const auth = createAuthManager(db);
let session = previous?.session || await auth.bootstrap({
  email: 'preview@example.test', password: randomBytes(32).toString('base64url'),
  bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN, remoteAddress: '127.0.0.1',
});
let sessionRefresh = null;
async function renewSyntheticPreviewSession() {
  if (auth.currentSession(session.sessionToken)) return false;
  if (sessionRefresh) return sessionRefresh;
  sessionRefresh = (async () => {
    const account = db.prepare('SELECT id,email,role,is_active FROM auth_users WHERE id=?').get(session.user.id);
    if (!account || account.email !== 'preview@example.test' || account.role !== 'owner' || account.is_active !== 1) {
      throw new Error('Refusing to renew an unrecognized synthetic preview account.');
    }
    const recoveryToken = randomBytes(32).toString('hex');
    const password = randomBytes(32).toString('base64url');
    process.env.ODD_AUTH_RECOVERY_TOKEN = recoveryToken;
    try {
      await auth.recover({ email: account.email, password, recoveryToken, remoteAddress: '127.0.0.1' });
    } finally {
      delete process.env.ODD_AUTH_RECOVERY_TOKEN;
    }
    const renewed = await auth.login({ email: account.email, password, remoteAddress: '127.0.0.1' });
    if (!renewed.sessionToken || Number(renewed.user?.id) !== Number(account.id) || !auth.currentSession(renewed.sessionToken)) {
      throw new Error('Synthetic preview session could not be renewed without its normal authentication checks.');
    }
    session = renewed;
    return true;
  })();
  try { return await sessionRefresh; } finally { sessionRefresh = null; }
}
await renewSyntheticPreviewSession();
let tenant = null;
if (tenantPreview) {
  const { createAstraTenantStore } = await import('../../pipeline/astra-tenant-store.js');
  const tenantStore = createAstraTenantStore();
  const fixtureIdentity = r18Preview ? pgFixture.clusterFixture : pgFixture.fixture;
  tenant = previous?.[r18Preview ? 'clusterFixture' : 'fixture'] === fixtureIdentity && previous.tenant
    ? previous.tenant : await tenantStore.createTenant({ name: 'Local preview workspace', userId: session.user.id });
  await tenantStore.close();
}
if (!r18Preview && db.prepare('SELECT COUNT(*) AS count FROM batches').get().count === 0) db.transaction(() => {
  const batch = db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Local preview · synthetic contacts','discovery','open')").run().lastInsertRowid;
  const insert = db.prepare('INSERT INTO leads(batch_id,business_name,email,website_url,category,city,country,status,source) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const [name, slug, category, city] of [
    ['Example Design Studio', 'design', 'Design', 'Bengaluru'],
    ['Example Export Company', 'export', 'Manufacturing', 'Ahmedabad'],
    ['Example Service Group', 'service', 'Services', 'Mumbai'],
  ]) insert.run(batch, name, `contact@${slug}.example.test`, `https://${slug}.example.test`, category, city, 'IN', 'discovered', 'local_preview_synthetic');
  db.prepare('UPDATE batches SET lead_count=3 WHERE id=?').run(batch);
  db.prepare("INSERT INTO campaigns(name,status) VALUES ('Preview campaign · draft only','draft')").run();
})();
fs.mkdirSync(path.dirname(privateStateFile), { recursive: true });
function persistPreviewSession() {
  const state = { mode: 'synthetic-local-preview', directory, session, tenant };
  if (r18Preview) state.clusterFixture = pgFixture.clusterFixture;
  else state.pgFixture = pgFixture?.fixture || null;
  fs.writeFileSync(privateStateFile, JSON.stringify(state), { mode: 0o600 });
}
persistPreviewSession();

const { server } = await import('../../server.js');
if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const backendPort = server.address().port;
allowedPorts.add(backendPort);
// Distinct loopback hostnames keep the two disposable auth cookies separate.
const origin = `http://${tenantPreview && !r18Preview ? 'localhost' : '127.0.0.1'}:${previewPort}`;
const entryToken = randomBytes(24).toString('base64url');
const cookies = () => [
  `odd_session=${session.sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
  `odd_csrf=${session.csrfToken}; Path=/; SameSite=Strict`,
];
const preview = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${previewPort}` && req.headers.host !== `localhost:${previewPort}`) {
      res.writeHead(403); return res.end('Local preview only.');
    }
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && ['/', '/growth.html', '/astra.html', '/__preview/open'].includes(url.pathname)) {
      if (await renewSyntheticPreviewSession()) persistPreviewSession();
    }
    if (req.headers.origin && ![origin, `http://127.0.0.1:${previewPort}`, `http://localhost:${previewPort}`].includes(req.headers.origin)) {
      res.writeHead(403); return res.end('Cross-origin preview requests are disabled.');
    }
    if (req.method === 'GET' && ['/', '/growth.html', '/astra.html'].includes(url.pathname)
      && !String(req.headers.cookie || '').split(';').some(item => item.trim() === `odd_session=${session.sessionToken}`)) {
      res.writeHead(302, { Location: `/__preview/open?token=${entryToken}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (url.pathname === '/__preview/open' && url.searchParams.get('token') === entryToken) {
      if (tenant) {
        const nonce = randomBytes(18).toString('base64url');
        res.writeHead(200, {
          'Set-Cookie': cookies(), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'self' data: blob:; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; img-src 'self' data: blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`,
        });
        return res.end(`<!doctype html><title>Opening Astra</title><script nonce="${nonce}">localStorage.setItem('odd-astra-tenant-id',${JSON.stringify(tenant.tenantId)});location.replace('/growth.html');</script><p>Opening the local Astra workspace…</p>`);
      }
      res.writeHead(302, { 'Set-Cookie': cookies(), Location: '/growth.html', 'Cache-Control': 'no-store' }); return res.end();
    }
    if (url.pathname === '/__preview/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ mode: integration ? 'isolated-prospecting-integration' : 'synthetic-local-preview', externalActions: integration ? 'scoped_research_only' : 'disabled', outreach: 'disabled', tenantDatabase: tenant ? 'disposable_fixture' : 'not_configured', realData: Boolean(integration) }));
    }
    const asset = /^\/(?:css|js|assets)\/[a-z0-9._/-]+$/i.test(url.pathname) && !url.pathname.split('/').includes('..');
    if (!(asset || ['/', '/login', '/index.html', '/growth.html', '/astra.html', '/favicon.ico', '/shared/verification-classification.js'].includes(url.pathname) || url.pathname.startsWith('/api/'))) {
      res.writeHead(404); return res.end('Not found.');
    }
    const headers = { ...req.headers, host: `127.0.0.1:${backendPort}` };
    delete headers.connection;
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : req;
    const response = await originalFetch(`http://127.0.0.1:${backendPort}${url.pathname}${url.search}`, {
      method: req.method, headers, body, ...(body ? { duplex: 'half' } : {}), redirect: 'manual',
    });
    const responseHeaders = Object.fromEntries(response.headers);
    delete responseHeaders['set-cookie'];
    delete responseHeaders['content-encoding'];
    delete responseHeaders['content-length'];
    responseHeaders['cache-control'] = 'no-store';
    responseHeaders['content-security-policy'] = "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; img-src 'self' data: blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
    const changedCookies = response.headers.getSetCookie();
    if (changedCookies.length) responseHeaders['set-cookie'] = changedCookies;
    res.writeHead(response.status, responseHeaders);
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: error.code === 'LOCAL_PREVIEW_EGRESS_DISABLED' ? error.message : 'Local preview request could not be completed.' }));
  }
});
await new Promise((resolve, reject) => { preview.once('error', reject); preview.listen(previewPort, '127.0.0.1', resolve); });
const state = { url: `${origin}/__preview/open?token=${entryToken}`, console: `${origin}/growth.html`, workbench: `${origin}/astra.html`, tenantId: tenant?.tenantId || null, pid: process.pid, directory, backendPort, externalActions: integration ? 'scoped_research_only' : 'disabled', outreach: 'disabled', createdAt: new Date().toISOString() };
fs.mkdirSync(path.join(repo, '.superpowers'), { recursive: true });
const publicStatePath = r18Preview
  ? path.join(repo, '.superpowers/r18/preview/local-preview-r18.json')
  : path.join(repo, '.superpowers', tenantPreview ? 'local-preview-astra.json' : 'local-preview.json');
fs.writeFileSync(publicStatePath, JSON.stringify({ ...state, url: `${origin}/growth.html` }, null, 2));
console.log(`LOCAL_PREVIEW_READY ${origin} (${integration ? 'isolated public research; outreach disabled' : 'synthetic data; external actions disabled'})`);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await Promise.all([new Promise(resolve => preview.close(resolve)), new Promise(resolve => server.close(resolve))]);
  database.closeDb();
  process.exit(0);
}
process.on('SIGINT', close); process.on('SIGTERM', close);
