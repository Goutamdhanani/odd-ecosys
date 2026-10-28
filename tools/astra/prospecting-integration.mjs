// Explicit isolated integration profile. Default local preview never loads it.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';

export function loadProspectingIntegration({ tenantId }) {
  const root = 'C:/Users/pooja/.codex/worktrees/astra-foundation/odd-ecosys';
  const profilePath = root + '/.superpowers/astra-discovery-runtime/authorization.json';
  const grant = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (grant.environment !== 'isolated-integration' || !grant.tenantIds.includes(tenantId)
    || Date.parse(grant.expiresAt) <= Date.now() || !Array.isArray(grant.sourceOrigins)
    || grant.maxRequests !== 3) throw new Error('The prospecting integration authorization is invalid or expired.');
  const protectedEnv = parseEnv(fs.readFileSync('C:/Users/pooja/.codex/secrets/astra-live-integration.env', 'utf8'));
  if (protectedEnv.MONGODB_DATABASE !== 'astra_test_validation_20261027'
    || protectedEnv.ASTRA_MONGODB_TEST_DATABASES !== protectedEnv.MONGODB_DATABASE) throw new Error('Dedicated Atlas test database is required.');
  const evidenceSha256 = createHash('sha256').update(fs.readFileSync(profilePath)).digest('hex');
  const approvals = [
    { decisionId: 'source.searxng-instance-and-engines', scope: 'http://127.0.0.1:8081' },
    { decisionId: 'glm.input-processing-and-data-protection' },
    ...grant.sourceOrigins.map(origin => ({ decisionId: 'source.public-websites', scope: new URL(origin).hostname.replace(/^www\./, '') })),
  ].map(value => ({ ...value, status: 'approved', reference: profilePath, evidenceSha256, expiresAt: grant.expiresAt }));
  const env = { MONGODB_URI: protectedEnv.MONGODB_URI, MONGODB_DATABASE: protectedEnv.MONGODB_DATABASE,
    ASTRA_MONGODB_TEST_DATABASES: protectedEnv.ASTRA_MONGODB_TEST_DATABASES,
    FREEINFERENCE_API_KEY: protectedEnv.FREEINFERENCE_API_KEY,
    ASTRA_PERSISTENCE_BACKEND: 'mongodb', ASTRA_INTEGRATION_MODE: 'prospecting-test', ASTRA_LIVE_PROSPECTING_GO: 'true',
    ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED: 'true', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: 'http://127.0.0.1:8081',
    ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED: 'true', ASTRA_SOURCE_COLLECTION_APPROVALS_JSON: JSON.stringify(approvals),
    ASTRA_PROSPECTING_RESEARCH_ENABLED: 'true', ASTRA_GLM_LOCAL_PREVIEW: 'false', ASTRA_GLM_EGRESS_ENABLED: 'true',
    ASTRA_PROSPECTING_USAGE_FILE: root + '/.superpowers/astra-discovery-runtime/request-usage.json',
    ASTRA_PROSPECTING_CATALOG_RECEIPT: 'C:/Users/pooja/.codex/secrets/astra-prospecting-catalog-receipt.json',
    ASTRA_PROSPECTING_RESEARCH_APPROVAL: JSON.stringify({ ...grant, referencePath: profilePath, referenceSha256: evidenceSha256 }),
  };
  const mongoHost = new URL(protectedEnv.MONGODB_URI).hostname;
  const mongoSuffix = mongoHost.split('.').slice(-3).join('.');
  const hosts = new Set(['127.0.0.1', 'localhost', '::1', 'freeinference.org', mongoHost,
    ...grant.sourceOrigins.map(value => new URL(value).hostname)]);
  const allowedHost = value => {
    const host = String(value || '').toLowerCase().replace(/^_mongodb\._tcp\./, '');
    return hosts.has(host) || host.endsWith('.' + mongoSuffix);
  };
  const usageFile = root + '/.superpowers/astra-discovery-runtime/request-usage.json';
  let counts = fs.existsSync(usageFile) ? JSON.parse(fs.readFileSync(usageFile, 'utf8')) : { catalog: 0, inference: 0, search: 0, websites: 0 };
  function reserve(kind, max) {
    if (counts[kind] >= max) throw Object.assign(new Error('The approved integration request budget is exhausted.'), { code: 'integration_budget_exhausted' });
    counts[kind] += 1;
    fs.writeFileSync(usageFile, JSON.stringify(counts, null, 2) + '\n');
  }
  return { env, allowedHost, sourceOrigins: grant.sourceOrigins, reserveSearch: () => reserve('search', 1),
    allowFetch(url, method) {
      if (url.origin === 'https://freeinference.org' && url.pathname === '/v1/models' && method === 'GET') return reserve('catalog', 1);
      if (url.origin === 'https://freeinference.org' && url.pathname === '/v1/chat/completions' && method === 'POST') return reserve('inference', 3);
      if (url.origin === 'http://127.0.0.1:8081' && url.pathname === '/search' && method === 'GET') return reserve('search', 1);
      if (grant.sourceOrigins.includes(url.origin) && method === 'GET') return reserve('websites', 6);
      throw Object.assign(new Error('This destination is outside the approved research integration.'), { code: 'integration_destination_denied' });
    } };
}
