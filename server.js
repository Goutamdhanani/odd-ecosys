// ============================================================
//  ODD-ECOSYS — HTTP Server + REST API
//  Serves the CRM dashboard + pipeline API endpoints
// ============================================================
import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { URL, fileURLToPath } from 'url';
import { OSM_ATTRIBUTION, parseOsmExport } from './pipeline/osm-importer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js':   'text/javascript; charset=UTF-8',
  '.css':  'text/css; charset=UTF-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Lazy-load pipeline modules (ESM → dynamic import) ────────
let _pipeline = null;
let _authManager = null;
let _websiteEmailDiscoveryTestOverride = null;
let _websiteDiscoveryJobsTestOverride = null;
let _epchDirectoryJobsTestOverride = null;
let _searxngSearchFetchTestOverride = null;
let _metaLeadAdsFetchTestOverride = null;
let _metaLeadAdsNowTestOverride = null;
let _leadStrategyFetchTestOverride = null;
let _imapReceiverTestOverride = null;
let _metaWebhookRecoveryScheduled = false;
const AUTH_TEST_BYPASS = process.env.NODE_ENV === 'test' && process.env.ODD_AUTH_ENFORCE_TESTS !== 'true';

export function setWebsiteEmailDiscoveryTestManager(manager) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Website email discovery test injection is only available in test mode.');
  _websiteEmailDiscoveryTestOverride = manager;
  if (_pipeline) _pipeline.websiteEmailDiscovery = manager;
}

export function setWebsiteDiscoveryJobsTestManager(manager) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Website discovery job test injection is only available in test mode.');
  _websiteDiscoveryJobsTestOverride = manager;
  if (_pipeline) _pipeline.websiteDiscoveryJobs = manager;
}

export function setEpchDirectoryJobsTestManager(manager) {
  if (process.env.NODE_ENV !== 'test') throw new Error('EPCH directory job test injection is only available in test mode.');
  _epchDirectoryJobsTestOverride = manager;
  if (_pipeline) _pipeline.epchDirectoryJobs = manager;
}

export function setSearxngSearchFetchForTests(fetchImpl) {
  if (process.env.NODE_ENV !== 'test') throw new Error('SearXNG search test injection is only available in test mode.');
  if (fetchImpl !== null && typeof fetchImpl !== 'function') throw new TypeError('The test fetch must be a function or null.');
  _searxngSearchFetchTestOverride = fetchImpl;
}

export function setMetaLeadAdsFetchForTests(fetchImpl) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Meta Lead Ads test fetch injection is only available in test mode.');
  if (fetchImpl !== null && typeof fetchImpl !== 'function') throw new TypeError('The test fetch must be a function or null.');
  _metaLeadAdsFetchTestOverride = fetchImpl;
}

export function setMetaLeadAdsClockForTests(now) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Meta Lead Ads clock injection is only available in test mode.');
  if (now !== null && typeof now !== 'function') throw new TypeError('The test clock must be a function or null.');
  _metaLeadAdsNowTestOverride = now;
}

export async function setImapReceiverForTests(receiver) {
  if (process.env.NODE_ENV !== 'test') throw new Error('IMAP receiver test injection is only available in test mode.');
  if (!receiver || typeof receiver.syncMailbox !== 'function' || typeof receiver.testMailbox !== 'function') {
    throw new TypeError('The IMAP receiver test double must provide testMailbox and syncMailbox.');
  }
  _imapReceiverTestOverride = receiver;
  if (_pipeline) {
    _pipeline.imapSyncScheduler.stop();
    const { createImapSyncScheduler } = await import('./pipeline/imap-sync-scheduler.js');
    _pipeline.imapReceiver = receiver;
    _pipeline.imapSyncScheduler = createImapSyncScheduler({ db: _pipeline.database.getDb(), receiver });
  }
}

export function setLeadStrategyFetchForTests(fetchImpl) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Lead strategy test injection is only available in test mode.');
  if (fetchImpl !== null && typeof fetchImpl !== 'function') throw new TypeError('The test fetch must be a function or null.');
  _leadStrategyFetchTestOverride = fetchImpl;
}

async function getAuthManager() {
  if (!_authManager) {
    const [database, auth] = await Promise.all([
      import('./pipeline/database.js'),
      import('./pipeline/auth-manager.js'),
    ]);
    _authManager = auth.createAuthManager(database.initDb());
  }
  return _authManager;
}
async function getPipeline() {
  if (!_pipeline) {
    try {
      const [
        database, batchManager, dedup, csvImporter, leadDiscovery,
        qualifier, emailVerifier, sendingEngine, abTesting, personalizer, websiteEmailDiscoveryModule, websiteDiscoveryJobsModule, epchDirectoryJobsModule, epchMemberDirectoryModule, eepcCbamDirectoryModule, searxngSearchModule,
        compliance, replyTracker, crmSync, archiver, listManager, segmentManager, campaignAudience, contactManager, contactImportJobsModule, contactFieldsModule, campaignSequence, campaignTemplates, imapReceiverModule, imapSyncSchedulerModule
      ] = await Promise.all([
        import('./pipeline/database.js'),
        import('./pipeline/batch-manager.js'),
        import('./pipeline/dedup.js'),
        import('./pipeline/csv-importer.js'),
        import('./pipeline/lead-discovery.js'),
        import('./pipeline/qualifier.js'),
        import('./pipeline/email-verifier.js'),
        import('./pipeline/sending-engine.js'),
        import('./pipeline/ab-testing.js'),
        import('./pipeline/personalizer.js'),
        import('./pipeline/website-email-discovery.js'),
        import('./pipeline/website-discovery-jobs.js'),
        import('./pipeline/epch-directory-jobs.js'),
        import('./pipeline/epch-member-directory.js'),
        import('./pipeline/eepc-cbam-directory.js'),
        import('./pipeline/searxng-search.js'),
        import('./pipeline/compliance.js'),
        import('./pipeline/reply-tracker.js'),
        import('./pipeline/crm-sync.js'),
        import('./pipeline/archiver.js'),
        import('./pipeline/list-manager.js'),
        import('./pipeline/segment-manager.js'),
        import('./pipeline/campaign-audience.js'),
        import('./pipeline/contact-manager.js'),
        import('./pipeline/contact-import-jobs.js'),
        import('./pipeline/contact-fields.js'),
        import('./pipeline/campaign-sequence.js'),
        import('./pipeline/campaign-templates.js'),
        import('./pipeline/imap-receiver.js'),
        import('./pipeline/imap-sync-scheduler.js'),
      ]);

      database.initDb();
      const qualificationScoringModule = await import('./pipeline/qualification-scoring.js');
      const qualificationScoring = qualificationScoringModule.getQualificationScoringManager(database.getDb());
      const qualificationReviewModule = await import('./pipeline/qualification-review.js');
      const qualificationReviews = qualificationReviewModule.createQualificationReviewManager(database.getDb());
      const websiteEmailDiscovery = _websiteEmailDiscoveryTestOverride
        || websiteEmailDiscoveryModule.createWebsiteEmailDiscovery({ db: database.getDb() });
      websiteEmailDiscovery.recoverInterruptedScans();
      const websiteDiscoveryJobs = _websiteDiscoveryJobsTestOverride
        || websiteDiscoveryJobsModule.createWebsiteDiscoveryJobs({
          db: database.getDb(),
          discovery: websiteEmailDiscovery,
          createContact: contactManager.createContact,
        });
      websiteDiscoveryJobs.recover();
      const epchDirectoryJobs = _epchDirectoryJobsTestOverride
        || epchDirectoryJobsModule.createEpchDirectoryJobs({
          db: database.getDb(),
          adapter: epchMemberDirectoryModule.createEpchMemberDirectoryAdapter(),
          adapters: {
            eepc_cbam: {
              adapter: eepcCbamDirectoryModule.createEepcCbamDirectoryAdapter(),
              sourceUrl: eepcCbamDirectoryModule.EEPC_CBAM_SOURCE_URL,
              label: 'EEPC CBAM advisory directory',
              evidenceType: 'eepc_cbam_directory',
              extractorVersion: eepcCbamDirectoryModule.EEPC_CBAM_EXTRACTOR_VERSION,
            },
          },
          createContact: contactManager.createContact,
        });
      epchDirectoryJobs.recover();
      const leadSearch = searxngSearchModule.createSearxngSearchManager({
        db: database.getDb(),
        websiteDiscoveryJobs,
        ...( _searxngSearchFetchTestOverride ? { fetcher: _searxngSearchFetchTestOverride } : {}),
      });
      emailVerifier.recoverInterruptedVerificationJobs();
      qualifier.recoverInterruptedQualificationJobs();
      qualifier.recoverStuckLeads();
      sendingEngine.recoverInterruptedSends();
      const imapReceiver = _imapReceiverTestOverride
        || imapReceiverModule.createImapReceiver({ db: database.getDb(), ingestReply: replyTracker.ingestInboundReply });
      const contactImportJobs = contactImportJobsModule.createContactImportJobs({ db: database.getDb() });
      void contactImportJobs.recover().catch(error => console.error('Contact import recovery failed:', error.message));

      _pipeline = {
        database, batchManager, dedup, csvImporter, leadDiscovery,
        qualifier, emailVerifier, sendingEngine, abTesting, personalizer,
        compliance, replyTracker, crmSync, archiver, listManager, segmentManager, campaignAudience, contactManager, contactImportJobs, contactFields: contactFieldsModule, campaignSequence, campaignTemplates, qualificationScoring, qualificationReviews, websiteEmailDiscovery, websiteDiscoveryJobs, epchDirectoryJobs, leadSearch,
        imapReceiver,
        imapSyncScheduler: imapSyncSchedulerModule.createImapSyncScheduler({
          db: database.getDb(),
          receiver: imapReceiver,
        }),
      };
      void _pipeline.imapSyncScheduler.start();
      if (!_metaWebhookRecoveryScheduled) {
        _metaWebhookRecoveryScheduled = true;
        setImmediate(() => {
          void recoverMetaLeadWebhooksOnStartup({
            db: database.getDb(),
            fetchImpl: _metaLeadAdsFetchTestOverride || globalThis.fetch,
          now: _metaLeadAdsNowTestOverride || Date.now,
          }).then(result => {
            if (result.examined) console.info(`Meta webhook startup recovery examined ${result.examined} pending notification(s); ${result.imported} imported.`);
          }).catch(error => console.error('Meta webhook startup recovery failed:', error.message));
        });
      }
    } catch (error) {
      console.error('⚠️  Pipeline modules not loaded:', error.message);
      _pipeline = null;
    }
  }
  return _pipeline;
}

export async function recoverMetaLeadWebhooksOnStartup({ db, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!db) throw new TypeError('A database connection is required for Meta webhook recovery.');
  const { createMetaLeadAdsManager } = await import('./pipeline/meta-lead-ads.js');
  const manager = createMetaLeadAdsManager({ db, fetchImpl, now });
  const status = manager.publicStatus();
  if (status.connectionStatus !== 'provider_verified' || !status.webhookConfigured) {
    return { examined: 0, imported: 0, failed: 0, inserted: 0, duplicates: 0, sendingWorkCreated: false };
  }
  // Recover only durable pending/stale-processing events. Known provider failures
  // stay manual-only; this is one bounded pass, not another background scheduler.
  return manager.processWebhookEvents({ limit: 25 });
}

// ── Parse request body ───────────────────────────────────────
function parseBody(req, maxBytes = Infinity) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('Request body is too large.');
        error.statusCode = 413;
        reject(error);
        return;
      }
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('Request chunk exceeds the 256 KB limit.');
        error.statusCode = 413;
        reject(error);
      } else resolve(Buffer.concat(chunks, totalBytes));
    });
    req.on('error', reject);
  });
}

function parseUrlEncodedBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) { tooLarge = true; chunks.length = 0; return; }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('Form body is too large.');
        error.statusCode = 413;
        reject(error);
        return;
      }
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
  });
}

// ── JSON response helpers ────────────────────────────────────
function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function errorResponse(res, message, status = 400) {
  jsonResponse(res, { error: message }, status);
}

const LEAD_SORT_COLUMNS = Object.freeze({
  discovered_at: 'leads.discovered_at',
  business_name: 'leads.business_name',
  category: 'leads.category',
  city: 'leads.city',
  status: 'leads.status',
});

function decodeLeadPageCursor(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw Object.assign(new Error('Contact page cursor is invalid.'), { statusCode: 400 });
  }
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw Object.assign(new Error('Contact page cursor is invalid.'), { statusCode: 400 }); }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !Number.isSafeInteger(cursor.id) || cursor.id < 1) {
    throw Object.assign(new Error('Contact page cursor is invalid.'), { statusCode: 400 });
  }
  // Accept cursors issued by the earlier fixed discovered-at sort when the
  // caller still requests that default ordering.
  if (!Object.hasOwn(cursor, 'version') && Object.hasOwn(cursor, 'discoveredAt')) {
    if (!(cursor.discoveredAt === null || (typeof cursor.discoveredAt === 'string' && cursor.discoveredAt.length <= 100))) {
      throw Object.assign(new Error('Contact page cursor is invalid.'), { statusCode: 400 });
    }
    return {
      sortBy: 'discovered_at', sortOrder: 'desc',
      sortValue: cursor.discoveredAt === null ? '' : cursor.discoveredAt,
      nullRank: cursor.discoveredAt === null ? 1 : 0,
      id: cursor.id,
    };
  }
  if (cursor.version !== 2 || !Object.hasOwn(LEAD_SORT_COLUMNS, cursor.sortBy)
    || !['asc', 'desc'].includes(cursor.sortOrder)
    || typeof cursor.sortValue !== 'string' || cursor.sortValue.length > 2000
    || ![0, 1].includes(cursor.nullRank)) {
    throw Object.assign(new Error('Contact page cursor is invalid.'), { statusCode: 400 });
  }
  return cursor;
}

function encodeLeadPageCursor(lead, sortBy, sortOrder) {
  const rawValue = lead[sortBy];
  return Buffer.from(JSON.stringify({
    version: 2,
    sortBy,
    sortOrder,
    sortValue: rawValue === null || rawValue === undefined ? '' : String(rawValue),
    nullRank: rawValue === null || rawValue === undefined ? 1 : 0,
    id: lead.id,
  })).toString('base64url');
}

function requestCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    const key = part.slice(0, separator).trim();
    try { return [key, decodeURIComponent(part.slice(separator + 1).trim())]; }
    catch { return [key, '']; }
  }).filter(([key]) => key));
}

function cookieSecurityAttribute() {
  if (process.env.ODD_AUTH_COOKIE_SECURE === 'true') return '; Secure';
  if (process.env.ODD_AUTH_COOKIE_SECURE === 'false') return '';
  return process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

function setAuthCookies(res, session, additionalCookies = []) {
  const secure = cookieSecurityAttribute();
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  res.setHeader('Set-Cookie', [
    `odd_session=${encodeURIComponent(session.sessionToken)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`,
    `odd_csrf=${encodeURIComponent(session.csrfToken)}; Path=/; Max-Age=${maxAge}; SameSite=Strict${secure}`,
    ...additionalCookies,
  ]);
}

function googleNonceCookie(value, maxAge = 300) {
  return `odd_google_nonce=${encodeURIComponent(value)}; Path=/api/auth/google; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${cookieSecurityAttribute()}`;
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  const host = String(req.headers.host || '').toLowerCase();
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function clearAuthCookies(res) {
  const secure = cookieSecurityAttribute();
  res.setHeader('Set-Cookie', [
    `odd_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`,
    `odd_csrf=; Path=/; Max-Age=0; SameSite=Strict${secure}`,
    googleNonceCookie('', 0),
  ]);
}

function finishSignIn(res, result, status = 200, additionalCookies = []) {
  res.setHeader('Cache-Control', 'no-store, private');
  if (result?.mfaRequired) {
    clearAuthCookies(res);
    return jsonResponse(res, {
      ok: true,
      mfaRequired: true,
      challengeToken: result.challengeToken,
      expiresAt: result.expiresAt,
      user: result.user,
    }, status);
  }
  setAuthCookies(res, result, additionalCookies);
  return jsonResponse(res, { ok: true, user: result.user }, status);
}

async function handleAuthRoute(req, res, pathname) {
  const auth = await getAuthManager();
  const cookies = requestCookies(req);
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    return jsonResponse(res, auth.publicStatus(cookies.odd_session));
  }
  if (pathname === '/api/auth/google/nonce' && req.method === 'GET') {
    const { getGoogleClientId } = await import('./pipeline/google-oauth.js');
    const clientId = getGoogleClientId();
    if (!clientId) return errorResponse(res, 'Google sign-in is not configured.', 503);
    const nonce = randomBytes(32).toString('base64url');
    auth.issueGoogleNonce(nonce);
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Set-Cookie', googleNonceCookie(nonce));
    return jsonResponse(res, { clientId, nonce });
  }
  if (pathname === '/api/auth/google' && req.method === 'POST') {
    const remoteAddress = req.socket?.remoteAddress || 'unknown';
    const expiredNonceCookie = googleNonceCookie('', 0);
    res.setHeader('Set-Cookie', expiredNonceCookie);
    if (!isSameOriginRequest(req)) return errorResponse(res, 'Google sign-in request was not accepted.', 403);
    auth.checkGoogleTokenAttempt(remoteAddress);
    const body = await parseBody(req, 20 * 1024);
    const nonce = cookies.odd_google_nonce;
    if (!nonce || !body?.credential || typeof body.credential !== 'string') {
      auth.recordGoogleTokenFailure(remoteAddress);
      return errorResponse(res, 'Google sign-in could not be verified. Start again from this page.', 401);
    }
    if (!auth.consumeGoogleNonce(nonce)) {
      auth.recordGoogleTokenFailure(remoteAddress);
      return errorResponse(res, 'Google sign-in request expired or was already used. Start again from this page.', 401);
    }
    let identity;
    try {
      const { verifyGoogleIdToken } = await import('./pipeline/google-oauth.js');
      identity = await verifyGoogleIdToken(body.credential, nonce);
    } catch {
      auth.recordGoogleTokenFailure(remoteAddress);
      return errorResponse(res, 'Google sign-in could not be verified. Check the Google account and try again.', 401);
    }
    auth.clearGoogleTokenFailures(remoteAddress);
    const session = await auth.googleLogin({ ...identity, remoteAddress });
    return finishSignIn(res, session, 200, [expiredNonceCookie]);
  }
  if (pathname === '/api/auth/mfa/status' && req.method === 'GET') {
    const session = auth.currentSession(cookies.odd_session);
    if (!session) return errorResponse(res, 'Sign-in required.', 401);
    res.setHeader('Cache-Control', 'no-store, private');
    return jsonResponse(res, auth.mfaStatus(session));
  }
  if (pathname === '/api/auth/mfa/challenge' && req.method === 'POST') {
    if (!isSameOriginRequest(req)) return errorResponse(res, 'Authenticator challenge request was not accepted.', 403);
    const body = await parseBody(req, 16 * 1024);
    const result = auth.completeMfaChallenge({
      ...body,
      remoteAddress: req.socket?.remoteAddress || 'unknown',
    });
    return finishSignIn(res, result);
  }
  if (['/api/auth/mfa/enroll', '/api/auth/mfa/enroll/confirm', '/api/auth/mfa/recovery-codes', '/api/auth/mfa/disable'].includes(pathname)
    && req.method === 'POST') {
    const session = auth.currentSession(cookies.odd_session);
    if (!session) return errorResponse(res, 'Sign-in required.', 401);
    if (!isSameOriginRequest(req) || !auth.verifyCsrf(session, cookies.odd_csrf, req.headers['x-csrf-token'])) {
      return errorResponse(res, 'Security token was not accepted. Refresh the page and try again.', 403);
    }
    const remoteAddress = req.socket?.remoteAddress || 'unknown';
    res.setHeader('Cache-Control', 'no-store, private');
    if (pathname === '/api/auth/mfa/enroll') {
      return jsonResponse(res, auth.beginMfaEnrollment(session, remoteAddress), 201);
    }
    const body = await parseBody(req, 16 * 1024);
    if (pathname === '/api/auth/mfa/enroll/confirm') {
      return jsonResponse(res, auth.confirmMfaEnrollment(session, body.code, remoteAddress));
    }
    if (pathname === '/api/auth/mfa/recovery-codes') {
      return jsonResponse(res, await auth.regenerateMfaRecoveryCodes(session, { ...body, remoteAddress }));
    }
    return jsonResponse(res, await auth.disableMfa(session, { ...body, remoteAddress }));
  }
  if (pathname === '/api/auth/events' && req.method === 'GET') {
    if (!auth.currentSession(cookies.odd_session)) return errorResponse(res, 'Sign-in required.', 401);
    return jsonResponse(res, { events: auth.auditEvents(new URL(req.url, `http://localhost:${PORT}`).searchParams.get('limit')) });
  }
  if (pathname === '/api/auth/bootstrap' && req.method === 'POST') {
    const body = await parseBody(req, 16 * 1024);
    const session = await auth.bootstrap({ ...body, remoteAddress: req.socket?.remoteAddress || 'unknown' });
    setAuthCookies(res, session);
    return jsonResponse(res, { ok: true, user: session.user }, 201);
  }
  if (pathname === '/api/auth/invitations/accept' && req.method === 'POST') {
    const body = await parseBody(req, 16 * 1024);
    const session = await auth.acceptInvitation({ ...body, remoteAddress: req.socket?.remoteAddress || 'unknown' });
    return finishSignIn(res, session, 201);
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await parseBody(req, 16 * 1024);
    const session = await auth.login({
      ...body,
      remoteAddress: req.socket?.remoteAddress || 'unknown',
    });
    return finishSignIn(res, session);
  }
  if (pathname === '/api/auth/recover' && req.method === 'POST') {
    const body = await parseBody(req, 16 * 1024);
    return jsonResponse(res, await auth.recover({
      ...body,
      remoteAddress: req.socket?.remoteAddress || 'unknown',
    }));
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const session = auth.currentSession(cookies.odd_session);
    if (session && !auth.verifyCsrf(session, cookies.odd_csrf, req.headers['x-csrf-token'])) {
      return errorResponse(res, 'CSRF token was not accepted.', 403);
    }
    auth.logout(cookies.odd_session, req.socket?.remoteAddress || 'unknown');
    clearAuthCookies(res);
    return jsonResponse(res, { ok: true });
  }
  return errorResponse(res, 'Unknown authentication route.', 404);
}

async function handleWorkspaceRoute(req, res, parsedUrl, session) {
  const auth = await getAuthManager();
  const pathname = parsedUrl.pathname;
  const method = req.method;
  const remoteAddress = req.socket?.remoteAddress || 'unknown';
  if (pathname === '/api/workspace/members' && method === 'GET') {
    return jsonResponse(res, { members: auth.listMembers() });
  }
  if (pathname === '/api/workspace/invitations' && method === 'GET') {
    return jsonResponse(res, { invitations: auth.listInvitations() });
  }
  if (pathname === '/api/workspace/invitations' && method === 'POST') {
    const body = await parseBody(req, 16 * 1024);
    return jsonResponse(res, auth.createInvitation({ ...body, actor: session, remoteAddress }), 201);
  }
  const invitationMatch = pathname.match(/^\/api\/workspace\/invitations\/(\d+)$/);
  if (invitationMatch && method === 'DELETE') {
    return jsonResponse(res, auth.cancelInvitation({ actor: session, invitationId: invitationMatch[1], remoteAddress }));
  }
  const memberMatch = pathname.match(/^\/api\/workspace\/members\/(\d+)$/);
  if (memberMatch && method === 'PATCH') {
    const body = await parseBody(req, 16 * 1024);
    return jsonResponse(res, auth.updateMemberRole({ actor: session, memberId: memberMatch[1], ...body, remoteAddress }));
  }
  if (memberMatch && method === 'DELETE') {
    return jsonResponse(res, auth.deactivateMember({ actor: session, memberId: memberMatch[1], remoteAddress }));
  }
  return errorResponse(res, `Unknown workspace route: ${method} ${pathname}`, 404);
}

function isPublicApi(req, pathname) {
  if (pathname === '/api/unsubscribe') return true;
  if (pathname === '/api/replies/ingest' && (process.env.ODD_REPLY_INGEST_TOKEN || '').length >= 32) {
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const expectedDigest = Buffer.from(process.env.ODD_REPLY_INGEST_TOKEN);
    const suppliedDigest = Buffer.from(supplied);
    return suppliedDigest.length === expectedDigest.length && timingSafeEqual(suppliedDigest, expectedDigest);
  }
  return false;
}

function isSafeAssetPath(pathname) {
  return /^\/(?:css|js|assets)\/[A-Za-z0-9._/-]+$/.test(pathname) && !pathname.split('/').includes('..')
    || pathname === '/favicon.ico';
}

function serveStaticFile(req, res, reqPath) {
  const filePath = path.resolve(__dirname, `.${reqPath === '/' || reqPath === '/login' ? '/index.html' : reqPath}`);
  if (filePath !== __dirname && !filePath.startsWith(`${__dirname}${path.sep}`)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
    }
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Cache-Control': reqPath === '/login' ? 'no-store' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

// ── Rate limiting (per-IP, for qualify endpoints) ────────────
const _rateLimits = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60000;

function checkRateLimit(req) {
  const ip = req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = _rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    _rateLimits.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// ── API Routes ───────────────────────────────────────────────
async function handleApiRequest(req, res, parsedUrl, actor = null) {
  const pipeline = await getPipeline();
  if (!pipeline) {
    return errorResponse(res, 'Pipeline not initialized. Run "node pipeline/cli.js seed" first.', 503);
  }

  const { database, batchManager, dedup, listManager, segmentManager, contactManager, contactImportJobs, contactFields, compliance, websiteEmailDiscovery, websiteDiscoveryJobs, epchDirectoryJobs, leadSearch } = pipeline;
  const db = database.getDb();
  const pathname = parsedUrl.pathname;
  const method = req.method;
  const params = parsedUrl.searchParams;

  if (pathname === '/api/leads/sources/meta' || pathname.startsWith('/api/leads/sources/meta/')) {
    const { isMetaLeadAdsAdmin, createMetaLeadAdsManager } = await import('./pipeline/meta-lead-ads.js');
    if (!(AUTH_TEST_BYPASS && !actor) && !isMetaLeadAdsAdmin(actor)) {
      return errorResponse(res, 'Only workspace owners and admins can manage Meta Lead Ads connections.', 403);
    }
    const manager = createMetaLeadAdsManager({ db, fetchImpl: _metaLeadAdsFetchTestOverride || globalThis.fetch,
      now: _metaLeadAdsNowTestOverride || Date.now });
    res.setHeader('Cache-Control', 'no-store, private');
    if (pathname === '/api/leads/sources/meta' && method === 'GET') {
      return jsonResponse(res, manager.publicStatus());
    }
    if (pathname === '/api/leads/sources/meta' && method === 'PUT') {
      const body = await parseBody(req, 12 * 1024);
      return jsonResponse(res, manager.saveConfiguration(body));
    }
    if (pathname === '/api/leads/sources/meta/test' && method === 'POST') {
      const result = await manager.testConnection();
      return jsonResponse(res, result);
    }
    if (pathname === '/api/leads/sources/meta/forms' && method === 'GET') {
      const result = await manager.listForms();
      return jsonResponse(res, result);
    }
    if (pathname === '/api/leads/sources/meta/forms/next' && method === 'POST') {
      const result = await manager.listForms({ continuePage: true });
      return jsonResponse(res, result);
    }
    if (pathname === '/api/leads/sources/meta/import' && method === 'POST') {
      const body = await parseBody(req, 24 * 1024);
      const result = await manager.importForm(body);
      return jsonResponse(res, result);
    }
    if (pathname === '/api/leads/sources/meta/webhook-status' && method === 'GET') {
      return jsonResponse(res, manager.getWebhookStatus());
    }
    if (pathname === '/api/leads/sources/meta/webhook-config' && method === 'PUT') {
      const body = await parseBody(req, 12 * 1024);
      return jsonResponse(res, manager.saveWebhookConfiguration(body));
    }
    if (pathname === '/api/leads/sources/meta/webhook-subscribe' && method === 'POST') {
      return jsonResponse(res, await manager.subscribePageToLeadgen());
    }
    const formWebhookSettings = pathname.match(/^\/api\/leads\/sources\/meta\/webhook-forms\/(\d+)$/);
    if (formWebhookSettings && method === 'PUT') {
      const body = await parseBody(req, 12 * 1024);
      return jsonResponse(res, await manager.saveFormMapping({ ...body, form_id: formWebhookSettings[1] }));
    }
    if (pathname === '/api/leads/sources/meta/webhooks/process' && method === 'POST') {
      const body = await parseBody(req, 4 * 1024);
      return jsonResponse(res, await manager.processWebhookEvents({ includeFailed: body.retry_failed === true, operatorInitiated: true }));
    }
    return errorResponse(res, 'Unknown Meta Lead Ads route.', 404);
  }

  // OPTIONS (CORS preflight)
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ── GET /api/batches ─────────────────────────────────────
  if (pathname === '/api/batches' && method === 'GET') {
    const status = params.get('status');
    const limit = parseInt(params.get('limit')) || 50;
    const batches = batchManager.listBatches({ status, limit });
    return jsonResponse(res, batches);
  }

  // ── POST /api/batches ────────────────────────────────────
  if (pathname === '/api/batches' && method === 'POST') {
    const body = await parseBody(req);
    if (!body.name) return errorResponse(res, 'Missing required field: name');

    const batch = batchManager.createBatch(body.name, body.phase || 'discovery');
    return jsonResponse(res, batch, 201);
  }

  // ── GET /api/batches/:id ─────────────────────────────────
  const batchMatch = pathname.match(/^\/api\/batches\/(\d+)$/);
  if (batchMatch && method === 'GET') {
    const stats = batchManager.getBatchStats(parseInt(batchMatch[1]));
    if (!stats) return errorResponse(res, 'Batch not found', 404);
    return jsonResponse(res, stats);
  }

  // ── POST /api/batches/:id/close ──────────────────────────
  const batchCloseMatch = pathname.match(/^\/api\/batches\/(\d+)\/close$/);
  if (batchCloseMatch && method === 'POST') {
    const batchId = parseInt(batchCloseMatch[1]);
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
    if (!batch) return errorResponse(res, 'Batch not found', 404);
    if (batch.status === 'closed') {
      return errorResponse(res, 'Batch is already closed', 409);
    }
    const result = batchManager.closeBatch(batchId);
    return jsonResponse(res, result);
  }

  // ── Contact lists ────────────────────────────────────────
  if (pathname === '/api/lists' && method === 'GET') {
    const rawLimit = params.get('limit');
    const rawOffset = params.get('offset');
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return errorResponse(res, 'limit must be an integer from 1 to 200.');
    if (!Number.isSafeInteger(offset) || offset < 0) return errorResponse(res, 'offset must be a non-negative integer.');
    const result = listManager.listContactLists({
      includeArchived: params.get('include_archived') !== 'false',
      search: (params.get('search') || '').trim().slice(0, 120),
      limit,
      offset,
    });
    return jsonResponse(res, result);
  }

  if (pathname === '/api/lists' && method === 'POST') {
    const body = await parseBody(req);
    if (typeof body.name !== 'string' || !body.name.trim()) return errorResponse(res, 'List name is required.');
    const result = listManager.createContactList(body);
    return jsonResponse(res, result, 201);
  }

  const listExportMatch = pathname.match(/^\/api\/lists\/(\d+)\/export$/);
  if (listExportMatch && method === 'GET') {
    const exported = listManager.exportContactList(listExportMatch[1]);
    if (!exported) return errorResponse(res, 'List not found.', 404);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="contact-list-${exported.list.id}.csv"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    const headers = ['contact_id', 'business_name', 'email', 'verification_status', 'category', 'city', 'country', 'phone', 'website_url', 'status', 'added_at'];
    const write = async chunk => {
      if (res.write(chunk)) return;
      await new Promise((resolve, reject) => {
        res.once('drain', resolve);
        res.once('error', reject);
      });
    };
    await write(`\uFEFF${headers.map(listManager.csvCell).join(',')}\r\n`);
    for (const row of exported.rows) {
      await write(`${headers.map(header => listManager.csvCell(row[header])).join(',')}\r\n`);
    }
    res.end();
    return;
  }

  const listMembersMatch = pathname.match(/^\/api\/lists\/(\d+)\/members$/);
  if (listMembersMatch && method === 'GET') {
    const rawLimit = params.get('limit');
    const rawOffset = params.get('offset');
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return errorResponse(res, 'limit must be an integer from 1 to 200.');
    if (!Number.isSafeInteger(offset) || offset < 0) return errorResponse(res, 'offset must be a non-negative integer.');
    const result = listManager.listContactListMembers(listMembersMatch[1], {
      search: (params.get('search') || '').trim().slice(0, 120), limit, offset,
    });
    if (!result) return errorResponse(res, 'List not found.', 404);
    return jsonResponse(res, result);
  }

  if (listMembersMatch && method === 'POST') {
    const body = await parseBody(req);
    const result = listManager.addContactsToList(listMembersMatch[1], body.leadIds);
    return jsonResponse(res, result);
  }

  const listMemberMatch = pathname.match(/^\/api\/lists\/(\d+)\/members\/(\d+)$/);
  if (listMemberMatch && method === 'DELETE') {
    const result = listManager.removeContactFromList(listMemberMatch[1], listMemberMatch[2]);
    return jsonResponse(res, result);
  }

  if (pathname === '/api/contact-segments' && method === 'GET') {
    return jsonResponse(res, segmentManager.listContactSegments());
  }
  if (pathname === '/api/contact-segments' && method === 'POST') {
    const body = await parseBody(req);
    return jsonResponse(res, segmentManager.createContactSegment(body), 201);
  }
  const contactSegmentMatch = pathname.match(/^\/api\/contact-segments\/(\d+)$/);
  if (contactSegmentMatch && method === 'PATCH') {
    const body = await parseBody(req);
    const result = segmentManager.updateContactSegment(contactSegmentMatch[1], body);
    if (!result) return errorResponse(res, 'Segment not found.', 404);
    return jsonResponse(res, result);
  }
  if (contactSegmentMatch && method === 'DELETE') {
    const deleted = segmentManager.deleteContactSegment(contactSegmentMatch[1]);
    if (!deleted) return errorResponse(res, 'Segment not found.', 404);
    return jsonResponse(res, { ok: true, deleted: true });
  }

  const listMatch = pathname.match(/^\/api\/lists\/(\d+)$/);
  if (listMatch && method === 'GET') {
    const result = listManager.getContactList(listMatch[1]);
    if (!result) return errorResponse(res, 'List not found.', 404);
    return jsonResponse(res, result);
  }
  if (listMatch && method === 'PATCH') {
    const body = await parseBody(req);
    const result = listManager.updateContactList(listMatch[1], body);
    if (!result) return errorResponse(res, 'List not found.', 404);
    return jsonResponse(res, result);
  }

  // ── Persistent contact tags ──────────────────────────────
  if (pathname === '/api/contact-tags' && method === 'GET') {
    return jsonResponse(res, contactManager.listContactTags({ includeArchived: params.get('include_archived') === 'true' }));
  }
  if (pathname === '/api/contact-tags' && method === 'POST') {
    const body = await parseBody(req);
    return jsonResponse(res, contactManager.createContactTag(body.name), 201);
  }
  const contactTagMatch = pathname.match(/^\/api\/contact-tags\/(\d+)$/);
  if (contactTagMatch && method === 'PATCH') {
    const body = await parseBody(req);
    const tag = contactManager.renameContactTag(contactTagMatch[1], body.name);
    if (!tag) return errorResponse(res, 'Active tag not found.', 404);
    return jsonResponse(res, tag);
  }
  if (contactTagMatch && method === 'DELETE') {
    const result = contactManager.archiveContactTag(contactTagMatch[1]);
    if (!result) return errorResponse(res, 'Tag not found.', 404);
    return jsonResponse(res, result);
  }
  const contactTagRestoreMatch = pathname.match(/^\/api\/contact-tags\/(\d+)\/restore$/);
  if (contactTagRestoreMatch && method === 'POST') {
    const result = contactManager.archiveContactTag(contactTagRestoreMatch[1], false);
    if (!result) return errorResponse(res, 'Tag not found.', 404);
    return jsonResponse(res, result);
  }
  const leadTagsMatch = pathname.match(/^\/api\/leads\/(\d+)\/tags$/);
  if (leadTagsMatch && method === 'PUT') {
    const body = await parseBody(req);
    return jsonResponse(res, contactManager.assignContactTags(leadTagsMatch[1], body.tagIds, body.createTag));
  }
  if (pathname === '/api/leads/bulk/tags' && method === 'PUT') {
    const body = await parseBody(req, 64 * 1024);
    return jsonResponse(res, contactManager.assignContactTagsToMany(body.leadIds, body.tagIds));
  }

  // ── GET /api/leads ───────────────────────────────────────
  if (pathname === '/api/leads' && method === 'GET') {
    const batchId = params.get('batch_id');
    const status = params.get('status');
    const emailStatus = params.get('email_status');
    const suppressionStatus = params.get('suppression_status');
    const rawLimit = params.get('limit');
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    const rawOffset = params.get('offset');
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    const sortBy = params.get('sort_by') ?? 'discovered_at';
    const sortOrder = params.get('sort_order') ?? 'desc';
    if (!Object.hasOwn(LEAD_SORT_COLUMNS, sortBy)) return errorResponse(res, 'sort_by must be discovered_at, business_name, category, city, or status.');
    if (!['asc', 'desc'].includes(sortOrder)) return errorResponse(res, 'sort_order must be asc or desc.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return errorResponse(res, 'limit must be an integer from 1 to 500.');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000_000) return errorResponse(res, 'offset must be a non-negative integer no greater than 100000000.');
    let cursor;
    try { cursor = decodeLeadPageCursor(params.get('cursor')); }
    catch (error) { return errorResponse(res, error.message); }
    if (cursor && (cursor.sortBy !== sortBy || cursor.sortOrder !== sortOrder)) {
      return errorResponse(res, 'Contact page cursor does not match the selected sort.');
    }
    const useOffset = params.has('offset') && cursor === null;
    const search = (params.get('search') || '').replaceAll('\u0000', '').trim().slice(0, 120);
    const hasCustomFieldKey = params.has('custom_field_key');
    const hasCustomFieldValue = params.has('custom_field_value');
    if (hasCustomFieldKey !== hasCustomFieldValue) return errorResponse(res, 'Provide both custom_field_key and custom_field_value.');
    let customFieldFilter = null;
    if (hasCustomFieldKey) {
      try {
        customFieldFilter = contactFields.normalizeContactFieldFilter(db,
          params.get('custom_field_key'), params.get('custom_field_value'), { allowArchived: true });
      } catch (error) {
        return errorResponse(res, error.message, error.statusCode || 400);
      }
    }
    const rawTagId = params.get('tag_id');
    const tagId = rawTagId === null || rawTagId === '' ? null : Number(rawTagId);
    if (tagId !== null && (!Number.isSafeInteger(tagId) || tagId < 1)) return errorResponse(res, 'tag_id must be a positive integer.');
    const emailStatuses = new Set(['deliverable', 'risky', 'undeliverable', 'unknown', 'no_email']);
    if (emailStatus && !emailStatuses.has(emailStatus)) return errorResponse(res, 'email_status must be deliverable, risky, undeliverable, unknown, or no_email.');
    if (suppressionStatus && !['suppressed', 'not_suppressed'].includes(suppressionStatus)) {
      return errorResponse(res, 'suppression_status must be suppressed or not_suppressed.');
    }

    const hasSuppressedEmail = `(
      EXISTS (SELECT 1 FROM suppression_list sl WHERE leads.email IS NOT NULL AND lower(trim(sl.email))=lower(trim(leads.email)))
      OR EXISTS (SELECT 1 FROM lead_emails le JOIN suppression_list sl ON lower(trim(sl.email))=lower(trim(le.email)) WHERE le.lead_id=leads.id)
    )`;

    let query = 'SELECT * FROM leads WHERE 1=1';
    const queryParams = [];

    if (batchId) {
      query += ' AND batch_id = ?';
      queryParams.push(parseInt(batchId));
    }
    if (status) {
      query += ' AND status = ?';
      queryParams.push(status);
    }
    if (emailStatus === 'no_email') {
      query += " AND (leads.email IS NULL OR trim(leads.email) = '')";
    } else if (emailStatus) {
      query += ` AND NULLIF(trim(leads.email), '') IS NOT NULL
        AND COALESCE((SELECT CASE WHEN le.verification_status IN ('deliverable','risky','undeliverable')
          THEN le.verification_status ELSE 'unknown' END
          FROM lead_emails le
          WHERE le.lead_id=leads.id AND lower(trim(le.email))=lower(trim(leads.email))
          ORDER BY le.is_primary DESC,le.id DESC LIMIT 1),'unknown') = ?`;
      queryParams.push(emailStatus);
    }
    if (suppressionStatus === 'suppressed') query += ` AND ${hasSuppressedEmail}`;
    else if (suppressionStatus === 'not_suppressed') query += ` AND NOT ${hasSuppressedEmail}`;
    if (tagId !== null) {
      query += ` AND EXISTS (
        SELECT 1 FROM lead_contact_tags lct JOIN contact_tags ct ON ct.id=lct.tag_id
        WHERE lct.lead_id=leads.id AND ct.id=? AND ct.status='active'
      )`;
      queryParams.push(tagId);
    }
    if (customFieldFilter) {
      query += ` AND EXISTS (
        SELECT 1 FROM lead_custom_field_values lcfv
        WHERE lcfv.lead_id=leads.id AND lcfv.field_id=? AND lcfv.value_json=?
      )`;
      queryParams.push(customFieldFilter.fieldId, customFieldFilter.valueJson);
    }
    if (search) {
      const searchColumns = [
        'business_name', 'email', 'phone', 'address', 'city', 'state', 'country', 'category',
        'website_url', 'facebook_url', 'source', 'source_details', 'source_url',
      ];
      query += ` AND (${searchColumns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
      const searchTerm = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      queryParams.push(...searchColumns.map(() => searchTerm));
    }

    // Get total count
    const countQuery = query.replace(/^SELECT \* FROM leads/, 'SELECT COUNT(*) as count FROM leads');
    const total = db.prepare(countQuery).get(...queryParams).count;

    query = query.replace(/^SELECT \* FROM leads/, `SELECT leads.*,
      CASE WHEN NULLIF(trim(leads.email), '') IS NULL THEN 'no_email'
        ELSE COALESCE((SELECT CASE WHEN le.verification_status IN ('deliverable','risky','undeliverable')
          THEN le.verification_status ELSE 'unknown' END
          FROM lead_emails le
          WHERE le.lead_id=leads.id AND lower(trim(le.email))=lower(trim(leads.email))
          ORDER BY le.is_primary DESC,le.id DESC LIMIT 1),'unknown') END AS primary_email_status,
      CASE WHEN ${hasSuppressedEmail} THEN 1 ELSE 0 END AS has_suppressed_email
      FROM leads`);
    const sortColumn = LEAD_SORT_COLUMNS[sortBy];
    const sortExpression = `COALESCE(${sortColumn}, '')`;
    const nullRankExpression = `CASE WHEN ${sortColumn} IS NULL THEN 1 ELSE 0 END`;
    const direction = sortOrder.toUpperCase();
    if (cursor) {
      const comparator = sortOrder === 'asc' ? '>' : '<';
      query += ` AND (${nullRankExpression} > ? OR (${nullRankExpression} = ? AND
        (${sortExpression} ${comparator} ? OR (${sortExpression} = ? AND leads.id ${comparator} ?))))`;
      queryParams.push(cursor.nullRank, cursor.nullRank, cursor.sortValue, cursor.sortValue, cursor.id);
    }
    query += ` ORDER BY ${nullRankExpression} ASC, ${sortExpression} ${direction}, leads.id ${direction} LIMIT ?`;
    queryParams.push(limit + 1);
    if (useOffset) {
      query += ' OFFSET ?';
      queryParams.push(offset);
    }

    const resultPage = db.prepare(query).all(...queryParams);
    const hasMore = resultPage.length > limit;
    const leads = hasMore ? resultPage.slice(0, limit) : resultPage;
    const nextCursor = hasMore && leads.length ? encodeLeadPageCursor(leads.at(-1), sortBy, sortOrder) : null;

    return jsonResponse(res, {
      leads,
      pagination: { total, limit, offset: useOffset ? offset : null, pages: Math.ceil(total / limit), hasMore, nextCursor },
    });
  }

  if (pathname === '/api/leads' && method === 'POST') {
    const body = await parseBody(req);
    const result = contactManager.createContact(body);
    return jsonResponse(res, result, 201);
  }
  if (pathname === '/api/contact-fields' && method === 'GET') {
    return jsonResponse(res, { fields: contactFields.listContactFieldDefinitions(db, { includeArchived: params.get('include_archived') === 'true' }) });
  }
  if (pathname === '/api/contact-fields' && method === 'POST') {
    const body = await parseBody(req, 16 * 1024);
    return jsonResponse(res, contactFields.createContactField(db, body), 201);
  }
  const contactFieldMatch = pathname.match(/^\/api\/contact-fields\/(\d+)$/);
  if (contactFieldMatch && method === 'PATCH') {
    const body = await parseBody(req, 16 * 1024);
    const field = contactFields.updateContactField(db, contactFieldMatch[1], body);
    if (!field) return errorResponse(res, 'Custom field not found.', 404);
    return jsonResponse(res, field);
  }
  if (contactFieldMatch && method === 'DELETE') {
    const field = contactFields.archiveContactField(db, contactFieldMatch[1]);
    if (!field) return errorResponse(res, 'Custom field not found.', 404);
    return jsonResponse(res, field);
  }
  if (pathname === '/api/leads/import/preview' && method === 'POST') {
    const body = await parseBody(req, 5 * 1024 * 1024 + 64 * 1024);
    const result = contactManager.previewContactsImport(body.batch_id, body.csv, body.columnMap || {});
    return jsonResponse(res, result);
  }
  if (pathname === '/api/leads/import/preview-sample' && method === 'POST') {
    const body = await parseBody(req, 5 * 1024 * 1024 + 64 * 1024);
    const result = await contactManager.previewContactsImportSample(body.batch_id, body.csv, body.columnMap || {});
    return jsonResponse(res, result);
  }
  if (pathname === '/api/leads/import/openstreetmap/preview' && method === 'POST') {
    const body = await parseBody(req, 5 * 1024 * 1024 + 64 * 1024);
    if (body.attribution_acknowledged !== true) return errorResponse(res, 'Confirm your right to use the export and the OpenStreetMap ODbL attribution requirements.', 400);
    const batchId = Number(body.batch_id);
    if (!Number.isSafeInteger(batchId) || batchId < 1) return errorResponse(res, 'Choose an existing open batch.', 400);
    const batch = db.prepare('SELECT id,status FROM batches WHERE id=?').get(batchId);
    if (!batch) return errorResponse(res, 'Batch not found.', 404);
    if (batch.status !== 'open') return errorResponse(res, 'Contacts can only be imported into an open batch.', 409);
    const parsed = parseOsmExport(body.export);
    const existingSourceIds = parsed.records.filter(record => db.prepare('SELECT 1 FROM leads WHERE source_url=? LIMIT 1').get(record.source_url)).map(record => record.osm_id);
    return jsonResponse(res, {
      batchId,
      attribution: OSM_ATTRIBUTION,
      featureCount: parsed.featureCount,
      candidateCount: parsed.records.length,
      existingSourceDuplicates: existingSourceIds.length,
      rejections: parsed.rejections.slice(0, 100),
      sample: parsed.records.slice(0, 5),
    });
  }
  if (pathname === '/api/leads/import/openstreetmap' && method === 'POST') {
    const body = await parseBody(req, 5 * 1024 * 1024 + 64 * 1024);
    if (body.attribution_acknowledged !== true) return errorResponse(res, 'Confirm your right to use the export and the OpenStreetMap ODbL attribution requirements.', 400);
    const batchId = Number(body.batch_id);
    if (!Number.isSafeInteger(batchId) || batchId < 1) return errorResponse(res, 'Choose an existing open batch.', 400);
    const batch = db.prepare('SELECT id,status FROM batches WHERE id=?').get(batchId);
    if (!batch) return errorResponse(res, 'Batch not found.', 404);
    if (batch.status !== 'open') return errorResponse(res, 'Contacts can only be imported into an open batch.', 409);
    const parsed = parseOsmExport(body.export);
    const exportDuplicates = parsed.rejections.filter(row => row.reason === 'duplicate_osm_object_in_export');
    const sourceInvalids = parsed.rejections.filter(row => row.reason !== 'duplicate_osm_object_in_export');
    const imported = parsed.records.length
      ? contactManager.importContactsToBatch(batchId, parsed.csv, {}, 'openstreetmap')
      : { counts: { inserted: 0, duplicates: 0, invalid: 0 }, duplicates: [], errors: [], rejections: [] };
    const rowForCandidate = new Map(parsed.records.map((record, index) => [index + 2, record]));
    const remap = row => {
      const record = rowForCandidate.get(row.row);
      return { ...row, ...(record ? { row: record.row, osm_id: record.osm_id } : {}) };
    };
    const rejectedByImporter = imported.rejections.map(remap);
    return jsonResponse(res, {
      batchId,
      attribution: OSM_ATTRIBUTION,
      counts: {
        parsed: parsed.featureCount,
        inserted: imported.counts.inserted,
        duplicates: imported.counts.duplicates + exportDuplicates.length,
        invalid: imported.counts.invalid + sourceInvalids.length,
      },
      duplicates: [...imported.duplicates.map(remap), ...exportDuplicates].slice(0, 100),
      errors: [...imported.errors, ...sourceInvalids.map(row => `Feature ${row.row}: ${row.reason}`)].slice(0, 100),
      rejections: [...rejectedByImporter, ...parsed.rejections].slice(0, 5000),
    });
  }
  if (pathname === '/api/leads/import-jobs' && method === 'POST') {
    const body = await parseBody(req, 16 * 1024);
    return jsonResponse(res, contactImportJobs.createJob(body), 201);
  }
  if (pathname === '/api/leads/import-jobs' && method === 'GET') {
    return jsonResponse(res, { jobs: contactImportJobs.listJobs(params.get('batch_id'), params.get('limit')) });
  }
  const rejectionCsvMatch = pathname.match(/^\/api\/leads\/import-jobs\/(\d+)\/rejections\.csv$/);
  if (rejectionCsvMatch && method === 'GET') {
    const importJobId = rejectionCsvMatch[1];
    if (!contactImportJobs.getJob(importJobId)) return errorResponse(res, 'Import job not found.', 404);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="contact-import-${importJobId}-rejections.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    for (const chunk of contactImportJobs.rejectionCsv(importJobId)) {
      if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
    }
    return res.end();
  }
  const importJobMatch = pathname.match(/^\/api\/leads\/import-jobs\/(\d+)(?:\/(chunks|cancel|resume|rejections))?$/);
  if (importJobMatch) {
    const [, importJobId, importJobAction] = importJobMatch;
    if (!importJobAction && method === 'GET') {
      const job = contactImportJobs.getJob(importJobId);
      if (!job) return errorResponse(res, 'Import job not found.', 404);
      return jsonResponse(res, job);
    }
    if (importJobAction === 'chunks' && method === 'PUT') {
      const bytes = await readRawBody(req, 256 * 1024);
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] || ''));
      if (!range) return errorResponse(res, 'Content-Range must specify the exact chunk byte range.', 400);
      const result = await contactImportJobs.uploadChunk(importJobId, {
        start: Number(range[1]), end: Number(range[2]), total: Number(range[3]), bytes,
      });
      return jsonResponse(res, result);
    }
    if (importJobAction === 'cancel' && method === 'POST') {
      return jsonResponse(res, { job: contactImportJobs.cancel(importJobId) });
    }
    if (importJobAction === 'resume' && method === 'POST') {
      return jsonResponse(res, { job: await contactImportJobs.resume(importJobId) });
    }
    if (importJobAction === 'rejections' && method === 'GET') {
      return jsonResponse(res, contactImportJobs.rejections(importJobId, {
        limit: params.get('limit'), offset: params.get('offset'),
      }));
    }
  }
  if (pathname === '/api/leads/import' && method === 'POST') {
    const body = await parseBody(req, 5 * 1024 * 1024 + 64 * 1024);
    const result = contactManager.importContactsToBatch(body.batch_id, body.csv, body.columnMap || {});
    return jsonResponse(res, result);
  }

  if (pathname === '/api/leads/search-provider' || pathname === '/api/leads/search-provider/test') {
    const providerAdmin = AUTH_TEST_BYPASS && !actor ? true : ['owner', 'admin'].includes(actor?.role);
    if (method !== 'GET' && !providerAdmin) return errorResponse(res, 'Only workspace owners and admins can manage the search provider.', 403);
    res.setHeader('Cache-Control', 'no-store, private');
    if (pathname === '/api/leads/search-provider' && method === 'GET') return jsonResponse(res, leadSearch.publicStatus());
    if (pathname === '/api/leads/search-provider' && method === 'PUT') {
      const body = await parseBody(req, 8 * 1024);
      const settings = leadSearch.saveConfiguration(body, actor || { role: 'admin', id: null });
      if (actor) {
        try { (await getAuthManager()).recordAuditEvent('lead_search_provider_updated', actor.id, req.socket?.remoteAddress || 'unknown'); }
        catch (error) { console.error('Lead search provider audit event could not be recorded:', error.message); }
      }
      return jsonResponse(res, { settings });
    }
    if (pathname === '/api/leads/search-provider/test' && method === 'POST') {
      if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
      return jsonResponse(res, await leadSearch.testConnection());
    }
    return errorResponse(res, 'Unknown search provider route.', 404);
  }
  const leadSearchJobsPath = '/api/leads/search-jobs';
  if (pathname === leadSearchJobsPath && method === 'GET') {
    return jsonResponse(res, leadSearch.listJobs({ batch_id: params.get('batch_id'), limit: params.get('limit') }));
  }
  if (pathname === leadSearchJobsPath && method === 'POST') {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    try {
      const body = await parseBody(req, 8 * 1024);
      return jsonResponse(res, await leadSearch.search(body), 201);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return jsonResponse(res, { error: status >= 500 ? 'Business search could not be completed.' : error.message, code: error.code || 'lead_search_failed' }, status);
    }
  }
  const leadSearchJobMatch = pathname.match(/^\/api\/leads\/search-jobs\/(\d+)(?:\/(import|next-page))?$/);
  if (leadSearchJobMatch) {
    const [, jobId, action] = leadSearchJobMatch;
    try {
      if (!action && method === 'GET') {
        const job = leadSearch.getJob(jobId);
        return job ? jsonResponse(res, job) : errorResponse(res, 'Business search job not found.', 404);
      }
      if (action === 'next-page' && method === 'POST') {
        if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
        return jsonResponse(res, await leadSearch.loadNextPage(jobId), 201);
      }
      if (action === 'import' && method === 'POST') {
        const body = await parseBody(req, 8 * 1024);
        return jsonResponse(res, leadSearch.importResults(jobId, body));
      }
      return errorResponse(res, 'Unknown business search job route.', 404);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return jsonResponse(res, { error: status >= 500 ? 'Search results could not be imported.' : error.message, code: error.code || 'lead_search_failed' }, status);
    }
  }

  const websiteDiscoveryJobsPath = '/api/leads/website-discovery-jobs';
  if (pathname === websiteDiscoveryJobsPath && method === 'GET') {
    return jsonResponse(res, websiteDiscoveryJobs.listJobs({ batch_id: params.get('batch_id'), limit: params.get('limit') }));
  }

  const epchDirectoryJobsPath = '/api/leads/directory-jobs';
  if (pathname === epchDirectoryJobsPath && method === 'GET') {
    return jsonResponse(res, epchDirectoryJobs.listJobs({ batch_id: params.get('batch_id'), limit: params.get('limit') }));
  }
  if (pathname === epchDirectoryJobsPath && method === 'POST') {
    try {
      const body = await parseBody(req, 16 * 1024);
      return jsonResponse(res, epchDirectoryJobs.createJob(body), 201);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return jsonResponse(res, { error: status >= 500 ? 'Directory import could not be created.' : error.message, code: error.code || 'directory_job_failed' }, status);
    }
  }
  const epchDirectoryJobMatch = pathname.match(/^\/api\/leads\/directory-jobs\/(\d+)(?:\/(pause|resume|cancel|retry|export))?$/);
  if (epchDirectoryJobMatch) {
    const [, jobId, action] = epchDirectoryJobMatch;
    try {
      if (!action && method === 'GET') {
        const job = epchDirectoryJobs.getJob(jobId);
        return job ? jsonResponse(res, job) : errorResponse(res, 'Directory job not found.', 404);
      }
      if (action === 'pause' && method === 'POST') return jsonResponse(res, { job: epchDirectoryJobs.pause(jobId) });
      if (action === 'resume' && method === 'POST') return jsonResponse(res, { job: epchDirectoryJobs.resume(jobId, { extendPages: true }) });
      if (action === 'cancel' && method === 'POST') return jsonResponse(res, { job: epchDirectoryJobs.cancel(jobId) });
      if (action === 'retry' && method === 'POST') return jsonResponse(res, { job: epchDirectoryJobs.retry(jobId) });
      if (action === 'export' && method === 'GET') {
        const csv = epchDirectoryJobs.exportCsv(jobId);
        if (csv === null) return errorResponse(res, 'EPCH directory job not found.', 404);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="business-directory-${jobId}-evidence.csv"`,
          'Cache-Control': 'no-store, private',
        });
        return res.end(csv);
      }
      return errorResponse(res, 'Unknown EPCH directory job route.', 404);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return jsonResponse(res, { error: status >= 500 ? 'Directory import could not be completed.' : error.message, code: error.code || 'directory_job_failed' }, status);
    }
  }
  if (pathname === websiteDiscoveryJobsPath && method === 'POST') {
    try {
      const body = await parseBody(req, 5 * 1024 * 1024);
      return jsonResponse(res, websiteDiscoveryJobs.createJob({ ...body, source: 'website_seed' }), 201);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return jsonResponse(res, { error: status >= 500 ? 'Website discovery job could not be created.' : error.message, code: error.code || 'website_discovery_job_failed' }, status);
    }
  }
  const websiteDiscoveryJobMatch = pathname.match(/^\/api\/leads\/website-discovery-jobs\/(\d+)(?:\/(pause|resume|cancel|retry|export))?$/);
  if (websiteDiscoveryJobMatch) {
    const [, jobId, action] = websiteDiscoveryJobMatch;
    try {
      if (!action && method === 'GET') {
        const rawOffset = parsedUrl.searchParams.get('offset');
        const rawLimit = parsedUrl.searchParams.get('limit');
        if ((rawOffset !== null && !/^\d{1,10}$/.test(rawOffset))
          || (rawLimit !== null && !/^\d{1,4}$/.test(rawLimit))) {
          return errorResponse(res, 'Website discovery page offset and size must be whole numbers.', 400);
        }
        const job = websiteDiscoveryJobs.getJob(jobId, {
          offset: rawOffset === null ? 0 : Number(rawOffset),
          limit: rawLimit === null ? 100 : Number(rawLimit),
        });
        return job ? jsonResponse(res, job) : errorResponse(res, 'Website discovery job not found.', 404);
      }
      if (action === 'pause' && method === 'POST') return jsonResponse(res, { job: websiteDiscoveryJobs.pause(jobId) });
      if (action === 'resume' && method === 'POST') return jsonResponse(res, { job: websiteDiscoveryJobs.resume(jobId) });
      if (action === 'cancel' && method === 'POST') return jsonResponse(res, { job: websiteDiscoveryJobs.cancel(jobId) });
      if (action === 'retry' && method === 'POST') {
        const body = await parseBody(req, 4 * 1024);
        return jsonResponse(res, { job: websiteDiscoveryJobs.retryTask(jobId, body.task_id) });
      }
      if (action === 'export' && method === 'GET') {
        const csv = websiteDiscoveryJobs.exportCsv(jobId);
        if (csv === null) return errorResponse(res, 'Website discovery job not found.', 404);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="website-discovery-${jobId}-evidence.csv"`,
          'Cache-Control': 'no-store, private',
        });
        return res.end(csv);
      }
      return errorResponse(res, 'Unknown website discovery job route.', 404);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return jsonResponse(res, { error: status >= 500 ? 'Website discovery job could not be completed.' : error.message, code: error.code || 'website_discovery_job_failed' }, status);
    }
  }

  const websiteEmailScanMatch = pathname.match(/^\/api\/leads\/(\d+)\/website-email-scan$/);
  if (websiteEmailScanMatch && method === 'POST') {
    try {
      return jsonResponse(res, await websiteEmailDiscovery.scanLead(websiteEmailScanMatch[1]), 201);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return jsonResponse(res, {
        error: status >= 500 ? 'The website scan stopped safely.' : error.message,
        code: error.code || 'website_scan_failed',
        scan: error.scan || null,
      }, status);
    }
  }

  const websiteEmailRefreshMatch = pathname.match(/^\/api\/leads\/(\d+)\/website-email-scan\/refresh$/);
  if (websiteEmailRefreshMatch && method === 'POST') {
    try {
      return jsonResponse(res, await websiteEmailDiscovery.scanLead(websiteEmailRefreshMatch[1], { refresh: true }), 200);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return jsonResponse(res, {
        error: status >= 500 ? 'The website refresh stopped safely.' : error.message,
        code: error.code || 'website_refresh_failed',
        scan: error.scan || null,
      }, status);
    }
  }

  // ── GET /api/leads/:id ───────────────────────────────────
  const leadMatch = pathname.match(/^\/api\/leads\/(\d+)$/);
  if (leadMatch && method === 'DELETE') {
    const result = contactManager.deleteContact(leadMatch[1]);
    if (!result) return errorResponse(res, 'Lead not found', 404);
    return jsonResponse(res, result);
  }
  if (leadMatch && method === 'PATCH') {
    const body = await parseBody(req);
    const result = contactManager.updateContact(leadMatch[1], body);
    if (!result) return errorResponse(res, 'Lead not found', 404);
    return jsonResponse(res, result);
  }
  if (leadMatch && method === 'GET') {
    const leadId = parseInt(leadMatch[1]);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    if (!lead) return errorResponse(res, 'Lead not found', 404);

    // Include stored verification evidence and a read-only view of global
    // suppression. The lookup is case-insensitive to cover legacy addresses.
    const emails = db.prepare(`SELECT le.*,
        CASE WHEN EXISTS (SELECT 1 FROM suppression_list sl WHERE lower(trim(sl.email))=lower(trim(le.email))) THEN 1 ELSE 0 END AS is_suppressed,
        (SELECT COALESCE(NULLIF(trim(sl.reason),''),'Unspecified') FROM suppression_list sl
          WHERE lower(trim(sl.email))=lower(trim(le.email)) ORDER BY sl.added_at DESC,sl.email LIMIT 1) AS suppression_reason
      FROM lead_emails le WHERE le.lead_id=? ORDER BY le.is_primary DESC,le.id`).all(leadId);
    const profileEvidence = db.prepare(`SELECT source_url,evidence_type,raw_excerpt,content_hash,extractor_version,observed_at
      FROM lead_profile_source_evidence WHERE lead_id=? ORDER BY observed_at DESC,id DESC`).all(leadId);
    if (emails.length) {
      const ids = emails.map(email => email.id);
      const evidence = db.prepare(`SELECT id,lead_email_id,source_url,evidence_type,raw_excerpt,content_hash,extractor_version,observed_at
        FROM lead_email_source_evidence WHERE lead_email_id IN (${ids.map(() => '?').join(',')})
        ORDER BY observed_at DESC,id DESC`).all(...ids);
      const sourceRefreshHistory = db.prepare(`SELECT r.generation,r.status AS refresh_status,
          p.outcome,p.observed_at AS page_observed_at,p.content_hash AS page_content_hash,o.state,
          o.prior_content_hash,o.prior_raw_excerpt,o.prior_extractor_version,
          o.content_hash AS current_content_hash,o.raw_excerpt AS current_raw_excerpt,
          o.extractor_version AS current_extractor_version,o.observed_at AS email_observed_at
        FROM lead_website_email_refreshes r
        LEFT JOIN lead_website_email_refresh_pages p
          ON p.refresh_id=r.id AND p.source_url=? AND p.fetch_mode=?
        LEFT JOIN lead_website_email_refresh_observations o
          ON o.refresh_id=r.id AND o.lead_email_id=? AND o.source_url=? AND o.fetch_mode=?
        WHERE r.lead_id=? ORDER BY r.generation DESC LIMIT 20`);
      const evidenceByEmail = new Map();
      for (const item of evidence) {
        if (!evidenceByEmail.has(item.lead_email_id)) evidenceByEmail.set(item.lead_email_id, []);
        const fetchMode = String(item.evidence_type || '').startsWith('rendered_') ? 'rendered' : 'http';
        const refreshHistory = sourceRefreshHistory.all(item.source_url, fetchMode, item.lead_email_id,
          item.source_url, fetchMode, leadId).map(row => ({
          generation: row.generation,
          status: row.refresh_status,
          outcome: row.outcome || 'not_rechecked',
          state: row.outcome === 'fetched' ? row.state || 'not_rechecked' : row.outcome || 'not_rechecked',
          observed_at: row.email_observed_at || row.page_observed_at || null,
          page_content_hash: row.page_content_hash || null,
          prior_content_hash: row.prior_content_hash || null,
          prior_excerpt: row.prior_raw_excerpt || null,
          prior_extractor_version: row.prior_extractor_version || null,
          current_content_hash: row.current_content_hash || null,
          current_excerpt: row.current_raw_excerpt || null,
          current_extractor_version: row.current_extractor_version || null,
        }));
        const refresh = refreshHistory[0];
        evidenceByEmail.get(item.lead_email_id).push({ id: item.id, source_url: item.source_url, evidence_type: item.evidence_type,
          raw_excerpt: item.raw_excerpt, content_hash: item.content_hash, extractor_version: item.extractor_version, observed_at: item.observed_at,
          refresh_state: refresh?.state || null,
          refresh_observed_at: refresh?.observed_at || null, refresh_generation: refresh?.generation || null,
          refresh_history: refreshHistory,
          contact_points: [] });
      }
      const evidenceRows = [...evidenceByEmail.values()].flat();
      if (evidenceRows.length) {
        const evidenceIds = evidenceRows.map(item => item.id).filter(Number.isSafeInteger);
        const points = evidenceIds.length ? db.prepare(`SELECT evidence_id,contact_type,contact_name,contact_title
          FROM lead_email_contact_point_evidence WHERE evidence_id IN (${evidenceIds.map(() => '?').join(',')})
          ORDER BY id`).all(...evidenceIds) : [];
        const evidenceById = new Map(evidenceRows.map(item => [item.id, item]));
        for (const point of points) evidenceById.get(point.evidence_id)?.contact_points.push({
          contact_type: point.contact_type, contact_name: point.contact_name, contact_title: point.contact_title,
        });
      }
      const latestRefreshGeneration = websiteEmailDiscovery.getLeadScan(leadId)?.latest_refresh?.generation;
      for (const email of emails) {
        email.source_evidence = evidenceByEmail.get(email.id) || [];
        const currentStates = email.source_evidence
          .filter(source => source.refresh_generation === latestRefreshGeneration && ['present', 'not_present'].includes(source.refresh_state));
        const hasPresent = currentStates.some(source => source.refresh_state === 'present');
        const hasAbsent = currentStates.some(source => source.refresh_state === 'not_present');
        email.source_conflict = hasPresent && hasAbsent ? {
          generation: latestRefreshGeneration,
          present_sources: currentStates.filter(source => source.refresh_state === 'present').map(source => source.source_url),
          absent_sources: currentStates.filter(source => source.refresh_state === 'not_present').map(source => source.source_url),
        } : null;
      }
    }
    const tags = contactManager.getContactTags(leadId);
    if (!tags) return errorResponse(res, 'Lead not found', 404);
    // Include events
    const events = db.prepare(
      'SELECT * FROM events WHERE lead_id = ? ORDER BY event_at DESC LIMIT 20'
    ).all(leadId);

    return jsonResponse(res, {
      ...lead,
      emails,
      email_discovery: websiteEmailDiscovery.getLeadScan(leadId),
      profile_source_evidence: profileEvidence,
      tags,
      events,
      customFields: contactFields.listLeadCustomFields(db, leadId),
    });
  }

  // ── GET /api/stats/discovery ─────────────────────────────
  if (pathname === '/api/stats/discovery' && method === 'GET') {
    const stats = database.getDbStats();

    // Status distribution
    const statusDist = db.prepare(`
      SELECT status, COUNT(*) as count FROM leads GROUP BY status ORDER BY count DESC
    `).all();

    // Leads per batch
    const batchDist = db.prepare(`
      SELECT b.id, b.name, b.phase, b.status as batch_status, b.lead_count,
             COUNT(l.id) as actual_leads
      FROM batches b
      LEFT JOIN leads l ON l.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.opened_at DESC
    `).all();

    // Site status distribution
    const siteStatusDist = db.prepare(`
      SELECT site_status, COUNT(*) as count FROM leads
      WHERE site_status IS NOT NULL
      GROUP BY site_status
    `).all();

    // Recent activity
    const recentEvents = db.prepare(`
      SELECT e.*, l.business_name
      FROM events e
      LEFT JOIN leads l ON e.lead_id = l.id
      ORDER BY e.event_at DESC
      LIMIT 20
    `).all();

    return jsonResponse(res, {
      ...stats,
      status_distribution: statusDist,
      batch_distribution: batchDist,
      site_status_distribution: siteStatusDist,
      recent_events: recentEvents,
    });
  }

  // ── GET /api/stats/funnel ────────────────────────────────
  if (pathname === '/api/stats/funnel' && method === 'GET') {
    const stages = [
      'discovered', 'enriching', 'site_checked', 'verifying', 'verified',
      'personalizing', 'awaiting_approval', 'queued', 'sent',
      'replied', 'won', 'lost', 'disqualified',
    ];
    const statusCounts = db.prepare('SELECT status, COUNT(*) AS count FROM leads GROUP BY status').all();
    const counts = new Map(statusCounts.map(row => [row.status, row.count]));
    const total = statusCounts.reduce((sum, row) => sum + row.count, 0);
    const funnel = { total };
    for (const stage of stages) funnel[stage] = counts.get(stage) || 0;
    return jsonResponse(res, funnel);
  }

  // ── GET /api/stats/analytics ─────────────────────────────
  if (pathname === '/api/stats/analytics' && method === 'GET') {
    const { replyTracker } = pipeline;

    // 1. Daily timeline metrics for last 7 days
    const dailyRows = db.prepare(`
      SELECT
        date(event_at) as date,
        COUNT(CASE WHEN event_type = 'sent' THEN 1 END) as sent,
        COUNT(CASE WHEN event_type = 'opened' THEN 1 END) as opened,
        COUNT(CASE WHEN event_type = 'clicked' THEN 1 END) as clicked,
        COUNT(CASE WHEN event_type = 'replied' THEN 1 END) as replied
      FROM events
      WHERE event_at >= date('now', '-7 days')
      GROUP BY date(event_at)
      ORDER BY date ASC
    `).all();

    // Fill last 7 days even if no events
    const timeline = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      const found = dailyRows.find(r => r.date === ds);
      timeline.push(found || { date: ds, sent: 0, opened: 0, clicked: 0, replied: 0 });
    }

    // 2. Reply sentiment breakdown
    const sentiment = replyTracker ? replyTracker.getReplySentimentAnalytics() : {
      interested: 0, not_interested: 0, out_of_office: 0, wrong_person: 0, unsubscribe_request: 0, total: 0
    };

    // 3. Niche performance from leads
    const niches = db.prepare(`
      SELECT
        COALESCE(category, 'General') as niche,
        COALESCE(city, 'Nationwide') as geo,
        COUNT(id) as leads,
        COUNT(CASE WHEN status IN ('sent','replied','won','lost') THEN 1 END) as sent,
        COUNT(CASE WHEN status IN ('replied','won') THEN 1 END) as replies,
        COUNT(CASE WHEN status = 'won' THEN 1 END) as positive,
        ROUND(AVG(CASE WHEN site_score IS NOT NULL THEN site_score END), 1) as avg_site_score
      FROM leads
      GROUP BY category, city
      ORDER BY leads DESC
      LIMIT 15
    `    ).all().map(n => ({
      ...n,
      reply_rate: n.sent > 0 ? Math.round((n.replies / n.sent) * 100) : 0,
      positive_rate: n.sent > 0 ? Math.round((n.positive / n.sent) * 100) : 0,
      // Real spend accounting does not exist yet; reporting a fabricated
      // constant would pretend cost data is observed.
      cost_per_reply: null,
    }));

    // 4. AI usage comes from durable provider-request events. Copy rows are
    // outputs, not calls, and historical calls cannot be reconstructed.
    const { getAiUsageAnalytics } = await import('./pipeline/ai-usage.js');
    const aiCost = getAiUsageAnalytics(db);

    return jsonResponse(res, {
      timeline,
      sentiment,
      niches,
      aiCost,
    });
  }

  // ── GET /api/suppression ─────────────────────────────────
  if (pathname === '/api/suppression' && method === 'GET') {
    const limit = parseInt(params.get('limit')) || 100;
    const list = db.prepare('SELECT * FROM suppression_list ORDER BY added_at DESC LIMIT ?').all(limit);
    return jsonResponse(res, list);
  }

  // ── POST /api/suppression ────────────────────────────────
  if (pathname === '/api/suppression' && method === 'POST') {
    const body = await parseBody(req);
    if (!body.email) return errorResponse(res, 'Missing required field: email');

    db.prepare(`
      INSERT OR REPLACE INTO suppression_list (email, reason, added_at)
      VALUES (?, ?, datetime('now'))
    `).run(body.email, body.reason || 'manual');

    return jsonResponse(res, { success: true, email: body.email }, 201);
  }

  // ── GET /api/events ─────────────────────────────────────────
  if (pathname === '/api/events' && method === 'GET') {
    const limit = parseInt(params.get('limit')) || 20;
    const events = db.prepare(`
      SELECT e.*, l.business_name, l.category, l.city
      FROM events e
      LEFT JOIN leads l ON e.lead_id = l.id
      ORDER BY e.event_at DESC
      LIMIT ?
    `).all(limit);
    return jsonResponse(res, events);
  }

  // ── POST /api/batches/:id/archive (Section 14 Archival) ─────
  const batchArchiveMatch = pathname.match(/^\/api\/batches\/(\d+)\/archive$/);
  if (batchArchiveMatch && method === 'POST') {
    const { archiver } = pipeline;
    const batchId = parseInt(batchArchiveMatch[1]);
    const result = archiver.archiveBatch(batchId);
    return jsonResponse(res, result);
  }

  // ── GET /api/stats/archive ──────────────────────────────────
  if (pathname === '/api/stats/archive' && method === 'GET') {
    const { archiver } = pipeline;
    return jsonResponse(res, archiver.getArchiveStats());
  }

  // ── Compliance / One-Click Unsubscribe (Phase 0) ───────────
  if (pathname === '/api/unsubscribe') {
    const token = params.get('token');
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end('<h3>Missing unsubscribe token</h3>');
    }
    const verified = compliance.verifyUnsubscribeToken(token);
    if (!verified.valid) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end('<h3>Invalid or expired unsubscribe token</h3>');
    }
    if (method === 'POST') {
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
        return errorResponse(res, 'One-click unsubscribe requires an application/x-www-form-urlencoded body.', 415);
      }
      const form = await parseUrlEncodedBody(req);
      if (form.get('List-Unsubscribe') !== 'One-Click') return errorResponse(res, 'Invalid one-click unsubscribe request.', 400);
      return jsonResponse(res, compliance.unsubscribeFromToken(token));
    }
    if (method !== 'GET') {
      res.writeHead(405, { Allow: 'GET, POST', 'Content-Type': 'text/plain; charset=UTF-8' });
      return res.end('Method not allowed.');
    }
    const action = `/api/unsubscribe?token=${encodeURIComponent(token)}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    return res.end(`
      <!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Unsubscribe</title><body style="font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;padding:24px;background:#11151f;color:#fff;border-radius:18px;text-align:center">
        <h1 style="font-size:1.25rem">Stop future emails?</h1>
        <p style="color:#b5bcb5;line-height:1.5">Confirm once to permanently suppress this address from future outreach.</p>
        <form method="post" action="${action}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button style="padding:12px 20px;border:0;border-radius:10px;background:#e6eddf;color:#192119;font-weight:650;cursor:pointer">Unsubscribe</button></form>
      </body></html>
    `);
  }

  // ── Ingest Inbound Reply & AI Sentiment (Phase 8) ───────────
  if (pathname === '/api/inbox/replies' && method === 'GET') {
    const { replyTracker } = pipeline;
    const unreadValue = params.get('unread');
    if (unreadValue !== null && !['true', 'false'].includes(unreadValue)) return errorResponse(res, 'unread must be true or false.');
    return jsonResponse(res, replyTracker.listInboxReplies({
      search: params.get('search') || '', unreadOnly: unreadValue === 'true',
      limit: params.get('limit') ?? undefined, offset: params.get('offset') ?? undefined,
    }));
  }
  const inboxReplyMatch = pathname.match(/^\/api\/inbox\/replies\/(\d+)$/);
  if (method === 'GET' && inboxReplyMatch) {
    const { replyTracker } = pipeline;
    const thread = replyTracker.getInboxReplyThread(inboxReplyMatch[1]);
    if (!thread) return errorResponse(res, 'Reply not found.', 404);
    return jsonResponse(res, thread);
  }
  const inboxReadStateMatch = pathname.match(/^\/api\/inbox\/replies\/(\d+)\/(read|unread)$/);
  if (method === 'POST' && inboxReadStateMatch) {
    const { replyTracker } = pipeline;
    const state = replyTracker.setInboxReplyReadState(inboxReadStateMatch[1], inboxReadStateMatch[2] === 'read');
    if (!state) return errorResponse(res, 'Reply not found.', 404);
    return jsonResponse(res, { ok: true, ...state });
  }

  if (pathname === '/api/replies/ingest' && method === 'POST') {
    const { replyTracker } = pipeline;
    const body = await parseBody(req, 256 * 1024);
    if (!body.fromEmail) return errorResponse(res, 'fromEmail is required');
    const result = await replyTracker.ingestInboundReply(body);
    return jsonResponse(res, result);
  }

  // ── GET /api/replies/sentiment-breakdown ─────────────────────
  if (pathname === '/api/replies/sentiment-breakdown' && method === 'GET') {
    const { replyTracker } = pipeline;
    return jsonResponse(res, replyTracker.getReplySentimentAnalytics());
  }

  // ── Open Tracking Pixel (Phase 8) ───────────────────────────
  const openTrackMatch = pathname.match(/^\/api\/track\/open\/(\d+)$/);
  if (openTrackMatch && method === 'GET') {
    const { replyTracker } = pipeline;
    replyTracker.recordOpenEvent(parseInt(openTrackMatch[1]));
    // Return 1x1 transparent GIF
    const transparentGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': transparentGif.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    });
    return res.end(transparentGif);
  }

  // ── Click Tracking Redirect (Phase 8) ───────────────────────
  const clickTrackMatch = pathname.match(/^\/api\/track\/click\/(\d+)$/);
  if (clickTrackMatch && method === 'GET') {
    const { replyTracker } = pipeline;
    const targetUrl = params.get('url') || 'https://google.com';
    replyTracker.recordClickEvent(parseInt(clickTrackMatch[1]), targetUrl);
    res.writeHead(302, { 'Location': targetUrl });
    return res.end();
  }

  // ── CRM Control Plane (Phase 9) ─────────────────────────────
  const crmSyncMatch = pathname.match(/^\/api\/crm\/sync\/(\d+)$/);
  if (crmSyncMatch && method === 'POST') {
    const { crmSync } = pipeline;
    const result = await crmSync.syncLeadToCRM(parseInt(crmSyncMatch[1]));
    return jsonResponse(res, result);
  }

  if (pathname === '/api/crm/kill-switch' && method === 'POST') {
    const { crmSync } = pipeline;
    const body = await parseBody(req);
    const result = crmSync.emergencyKillSwitch(body.reason || 'dashboard_kill_switch');
    return jsonResponse(res, result);
  }

  if (pathname === '/api/crm/blacklist-domain' && method === 'POST') {
    const { crmSync } = pipeline;
    const body = await parseBody(req);
    if (!body.domain) return errorResponse(res, 'domain required');
    const result = crmSync.blacklistDomain(body.domain, body.reason);
    return jsonResponse(res, result);
  }

  if (pathname === '/api/crm/status' && method === 'GET') {
    const { crmSync } = pipeline;
    return jsonResponse(res, crmSync.getCRMControlPlaneStatus());
  }

  // ── 404 for unknown API routes ───────────────────────────
  return errorResponse(res, `Unknown API route: ${method} ${pathname}`, 404);
}

// ── Qualification API Routes ─────────────────────────────────
async function handleQualifyApi(req, res, parsedUrl, pipeline, actor) {
  const { qualifier, database, qualificationScoring, qualificationReviews } = pipeline;
  const db = database.getDb();
  const pathname = parsedUrl.pathname;
  const method = req.method;
  const params = parsedUrl.searchParams;

  // Rate limit POST requests
  if (method === 'POST' && !checkRateLimit(req)) {
    return errorResponse(res, 'Rate limit exceeded (30 req/min)', 429);
  }

  if (pathname === '/api/qualify/scoring' && method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, private');
    return jsonResponse(res, { active: qualificationScoring.getProfile(), history: qualificationScoring.listProfiles(10) });
  }
  if (pathname === '/api/qualify/scoring' && method === 'PUT') {
    const body = await parseBody(req, 32 * 1024);
    const active = qualificationScoring.createVersion({ ...body, actor, remoteAddress: req.socket?.remoteAddress || 'unknown' });
    const auth = await getAuthManager();
    auth.recordAuditEvent('qualification_scoring_profile_created', actor.id, req.socket?.remoteAddress || 'unknown');
    res.setHeader('Cache-Control', 'no-store, private');
    return jsonResponse(res, { active, history: qualificationScoring.listProfiles(10) }, 201);
  }
  const replayMatch = pathname.match(/^\/api\/qualify\/lead\/(\d+)\/scoring-replay$/);
  if (replayMatch && method === 'GET') {
    const requestedVersion = params.has('version') ? params.get('version') : undefined;
    res.setHeader('Cache-Control', 'no-store, private');
    return jsonResponse(res, qualificationScoring.replayLead(replayMatch[1], requestedVersion));
  }
  if (pathname === '/api/qualify/review-queue' && method === 'GET') {
    const rawBatchId = params.get('batch_id');
    const result = qualificationReviews.getReviewQueue({
      batchId: rawBatchId === null ? null : Number(rawBatchId),
      maxConfidence: params.has('max_confidence') ? Number(params.get('max_confidence')) : 70,
      limit: params.has('limit') ? Number(params.get('limit')) : 50,
      offset: params.has('offset') ? Number(params.get('offset')) : 0,
    });
    res.setHeader('Cache-Control', 'no-store, private');
    return jsonResponse(res, result);
  }
  const reviewHistoryMatch = pathname.match(/^\/api\/qualify\/lead\/(\d+)\/review-history$/);
  if (reviewHistoryMatch && method === 'GET') {
    const lead = database.getDb().prepare('SELECT id FROM leads WHERE id=?').get(Number(reviewHistoryMatch[1]));
    if (!lead) return errorResponse(res, 'Lead was not found.', 404);
    res.setHeader('Cache-Control', 'no-store, private');
    return jsonResponse(res, { reviews: qualificationReviews.getReviewHistory(reviewHistoryMatch[1]) });
  }
  const reviewMatch = pathname.match(/^\/api\/qualify\/review\/(\d+)$/);
  if (reviewMatch && method === 'POST') {
    const body = await parseBody(req, 16 * 1024);
    const review = qualificationReviews.recordReview({ ...body, leadId: reviewMatch[1], actor });
    const auth = await getAuthManager();
    auth.recordAuditEvent(`qualification_review_${review.decision}`, actor.id, req.socket?.remoteAddress || 'unknown');
    res.setHeader('Cache-Control', 'no-store, private');
    return jsonResponse(res, { review, sendingEligibilityChanged: false }, 201);
  }

  // POST /api/qualify/batch/:id — start batch qualification
  const batchStartMatch = pathname.match(/^\/api\/qualify\/batch\/(\d+)$/);
  if (batchStartMatch && method === 'POST') {
    const batchId = parseInt(batchStartMatch[1]);
    let started;
    try {
      started = qualifier.startQualificationBatch(batchId);
    } catch (error) {
      return errorResponse(res, error.message, error.statusCode || 500);
    }
    started.promise.catch(err => {
      console.error('Qualification error:', err);
    });
    return jsonResponse(res, { started: true, jobId: started.jobId, batchId: started.batchId }, 202);
  }

  // POST /api/qualify/cancel — global cancel (UI wrapper contract)
  if (method === 'POST' && pathname === '/api/qualify/cancel') {
    const cancelled = qualifier.cancelQualification();
    return jsonResponse(res, { ok: true, ...cancelled });
  }

  // POST /api/qualify/batch/:id/cancel — cancel running qualification
  const batchCancelMatch = pathname.match(/^\/api\/qualify\/batch\/(\d+)\/cancel$/);
  if (batchCancelMatch && method === 'POST') {
    const cancelled = qualifier.cancelQualification(batchCancelMatch[1]);
    return jsonResponse(res, { cancelled: cancelled.cancelling, ...cancelled });
  }

  // GET /api/qualify/status — current progress
  if (pathname === '/api/qualify/status' && method === 'GET') {
    const rawBatchId = params.get('batch_id');
    try { return jsonResponse(res, qualifier.getQualificationStatus(rawBatchId)); }
    catch (error) { return errorResponse(res, error.message, error.statusCode || 400); }
  }

  // GET /api/qualify/results/:batchId — results for a batch
  const resultsMatch = pathname.match(/^\/api\/qualify\/results\/(\d+)$/);
  if (resultsMatch && method === 'GET') {
    const batchId = parseInt(resultsMatch[1]);
    const siteStatus = params.get('site_status');
    const limit = parseInt(params.get('limit')) || 100;
    const offset = parseInt(params.get('offset')) || 0;
    const results = qualifier.getQualificationResults(batchId, { siteStatus, limit, offset });
    return jsonResponse(res, {
      ...results,
      results: results.results.map(lead => ({ ...lead, human_review: qualificationReviews.getCurrentReview(lead.id) })),
    });
  }

  // POST /api/qualify/lead/:id — re-qualify single lead
  const leadMatch = pathname.match(/^\/api\/qualify\/lead\/(\d+)$/);
  if (leadMatch && method === 'POST') {
    const leadId = parseInt(leadMatch[1]);
    try {
      const result = await qualifier.requalifyLead(leadId);
      return jsonResponse(res, result);
    } catch (err) {
      return errorResponse(res, err.message, err.statusCode || 404);
    }
  }

  // POST /api/qualify/recheck-stale — requeue stale leads
  if (pathname === '/api/qualify/recheck-stale' && method === 'POST') {
    const body = await parseBody(req);
    const days = body.days || 60;
    try {
      const result = qualifier.requeueStaleLeads(days);
      return jsonResponse(res, result);
    } catch (error) {
      return errorResponse(res, error.message, error.statusCode || 400);
    }
  }

  // GET /api/qualify/stale-count — count of stale leads
  if (pathname === '/api/qualify/stale-count' && method === 'GET') {
    const days = parseInt(params.get('days')) || 60;
    try {
      return jsonResponse(res, { count: qualifier.getStaleLeadCount(days), days });
    } catch (error) {
      return errorResponse(res, error.message, error.statusCode || 400);
    }
  }

  // GET /api/qualify/spot-check/:batchId — lowest confidence leads
  const spotCheckMatch = pathname.match(/^\/api\/qualify\/spot-check\/(\d+)$/);
  if (spotCheckMatch && method === 'GET') {
    const batchId = parseInt(spotCheckMatch[1]);
    const limit = parseInt(params.get('limit')) || 20;
    const leads = qualifier.getSpotCheckLeads(batchId, limit);
    return jsonResponse(res, leads);
  }

  // GET /api/leads/site-status-distribution — aggregated counts
  if (pathname === '/api/leads/site-status-distribution' && method === 'GET') {
    const batchId = params.get('batch_id') ? parseInt(params.get('batch_id')) : null;
    const dist = qualifier.getSiteStatusDistribution(batchId);
    return jsonResponse(res, dist);
  }

  return errorResponse(res, `Unknown qualify route: ${method} ${pathname}`, 404);
}

async function writeResponseChunk(res, chunk) {
  if (res.destroyed) return false;
  if (res.write(chunk)) return true;
  return new Promise(resolve => {
    const cleanup = () => { res.removeListener('drain', onDrain); res.removeListener('close', onClose); res.removeListener('error', onError); };
    const finish = value => { cleanup(); resolve(value); };
    const onDrain = () => finish(!res.destroyed);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    res.once('drain', onDrain); res.once('close', onClose); res.once('error', onError);
  });
}
// ── Verify API routes ────────────────────────────────────────
async function handleVerifyApi(req, res, parsedUrl, pipeline) {
  const { emailVerifier, database } = pipeline;
  const method = req.method;
  const pathname = parsedUrl.pathname;

  // POST /api/verify/batch/:id — start batch verification
  const batchMatch = pathname.match(/^\/api\/verify\/batch\/(\d+)$/);
  if (method === 'POST' && batchMatch) {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const batchId = parseInt(batchMatch[1]);
    if (!database.getDb().prepare('SELECT id FROM batches WHERE id=?').get(batchId)) return errorResponse(res, 'Batch not found.', 404);
    const currentJob = emailVerifier.getVerificationStatus();
    if (currentJob.active) return errorResponse(res, `Verification job #${currentJob.jobId} is already active for batch #${currentJob.batchId}.`, 409);
    const run = emailVerifier.verifyBatch(batchId);
    run.catch(e => console.error('Verify error:', e.message));
    return jsonResponse(res, { ok: true, message: 'Verification job accepted.', ...emailVerifier.getVerificationStatus(batchId) }, 202);
  }

  // POST /api/verify/cancel — global cancel (UI wrapper contract)
  if (method === 'POST' && pathname === '/api/verify/cancel') {
    const cancelled = emailVerifier.cancelVerification();
    return jsonResponse(res, { ok: true, cancelled });
  }

  // POST /api/verify/batch/:id/cancel — cancel running verification
  const cancelMatch = pathname.match(/^\/api\/verify\/batch\/(\d+)\/cancel$/);
  if (method === 'POST' && cancelMatch) {
    const cancelled = emailVerifier.cancelVerification(Number(cancelMatch[1]));
    return jsonResponse(res, { ok: true, ...cancelled });
  }

  // GET /api/verify/status — current verification progress
  if (method === 'GET' && pathname === '/api/verify/status') {
    const rawBatchId = parsedUrl.searchParams.get('batch_id');
    return jsonResponse(res, emailVerifier.getVerificationStatus(rawBatchId));
  }

  // GET /api/verify/results/:batchId/export — stream all stored evidence as CSV
  const exportMatch = pathname.match(/^\/api\/verify\/results\/(\d+)\/export$/);
  if (method === 'GET' && exportMatch) {
    const status = parsedUrl.searchParams.get('status') || undefined;
    const batchId = Number(exportMatch[1]);
    const exported = emailVerifier.getVerificationExport(batchId, { status });
    if (!exported) return errorResponse(res, 'Batch not found.', 404);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="verification-batch-${batchId}.csv"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    });
    try {
      if (!await writeResponseChunk(res, '\uFEFFcontact_id,email_id,business_name,email,status,verified_at,mx_host,engine,checks_json,reasons\r\n')) return;
      for (const row of exported.rows) {
        if (!await writeResponseChunk(res, emailVerifier.formatVerificationCsvRow(row))) return;
      }
      res.end();
    } catch (error) {
      console.error('Verification CSV stream failed:', error.message);
      if (res.headersSent) res.destroy(error); else throw error;
    }
    return;
  }
  // GET /api/verify/results/:batchId — paginated results
  const resultsMatch = pathname.match(/^\/api\/verify\/results\/(\d+)$/);
  if (method === 'GET' && resultsMatch) {
    const batchId = parseInt(resultsMatch[1]);
    const status = parsedUrl.searchParams.get('status') || undefined;
    const limit = parseInt(parsedUrl.searchParams.get('limit')) || 100;
    const offset = parseInt(parsedUrl.searchParams.get('offset')) || 0;
    return jsonResponse(res, emailVerifier.getVerificationResults(batchId, { status, limit, offset }));
  }

  // POST /api/verify/email/:id — re-verify single email
  const emailMatch = pathname.match(/^\/api\/verify\/email\/(\d+)$/);
  if (method === 'POST' && emailMatch) {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const id = parseInt(emailMatch[1]);
    try {
      const result = await emailVerifier.reverifyEmailById(id);
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return errorResponse(res, e.message, 404);
    }
  }

  // POST /api/verify/single — verify arbitrary email
  if (method === 'POST' && pathname === '/api/verify/single') {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const body = await parseBody(req);
    if (!body.email) return errorResponse(res, 'email required');
    const result = await emailVerifier.verifyEmail(body.email);
    return jsonResponse(res, { ok: true, result });
  }

  // GET /api/verify/distribution — status counts
  if (method === 'GET' && pathname === '/api/verify/distribution') {
    const batchId = parsedUrl.searchParams.get('batch_id');
    return jsonResponse(res, emailVerifier.getVerificationDistribution(batchId ? parseInt(batchId) : null));
  }

  // GET /api/verify/reacher-status — check if Reacher Docker backend is running
  if (method === 'GET' && pathname === '/api/verify/reacher-status') {
    const status = await emailVerifier.getReacherStatus();
    return jsonResponse(res, status);
  }

  return errorResponse(res, `Unknown verify route: ${method} ${pathname}`, 404);
}

// ── Sending & Campaign API routes ───────────────────────────
async function handleSendingApi(req, res, parsedUrl, pipeline, actor = null) {
  const { sendingEngine, abTesting, campaignAudience, campaignSequence, campaignTemplates, imapReceiver, imapSyncScheduler } = pipeline;
  const method = req.method;
  const pathname = parsedUrl.pathname;

  if (method === 'GET' && pathname === '/api/sending/control') {
    return jsonResponse(res, sendingEngine.getSendControlState());
  }
  if (method === 'PUT' && pathname === '/api/sending/control') {
    const body = await parseBody(req, 16 * 1024);
    return jsonResponse(res, sendingEngine.setSendControlState({ ...body, actor }));
  }
  if (method === 'GET' && pathname === '/api/sending/schedule') {
    return jsonResponse(res, sendingEngine.getSendingScheduleSettings());
  }
  if (method === 'GET' && pathname === '/api/sending/credential-storage') {
    return jsonResponse(res, sendingEngine.getMailboxCredentialStorageStatus());
  }
  if (method === 'GET' && pathname === '/api/sending/imap-sync') {
    return jsonResponse(res, imapSyncScheduler.status());
  }
  if (method === 'PUT' && pathname === '/api/sending/imap-sync') {
    if (!['owner', 'admin'].includes(actor?.role)) return errorResponse(res, 'Only workspace owners and admins can change automatic Inbox sync.', 403);
    const body = await parseBody(req, 8 * 1024);
    return jsonResponse(res, imapSyncScheduler.setSettings(body, actor));
  }
  if (method === 'PUT' && pathname === '/api/sending/schedule') {
    const body = await parseBody(req, 16 * 1024);
    return jsonResponse(res, sendingEngine.setSendingScheduleSettings(body, actor));
  }

  // --- Mailbox Fleet ---

  // GET /api/sending/mailboxes — full fleet
  if (method === 'GET' && pathname === '/api/sending/mailboxes') {
    return jsonResponse(res, sendingEngine.getMailboxFleet());
  }

  // POST /api/sending/mailboxes — add mailbox
  if (method === 'POST' && pathname === '/api/sending/mailboxes') {
    const body = await parseBody(req);
    if (!body.email) return errorResponse(res, 'email required');
    const result = await sendingEngine.addMailbox(body);
    return jsonResponse(res, { ok: true, ...result });
  }

  // PATCH /api/sending/mailboxes/:id — update mailbox
  const updateMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)$/);
  if (method === 'PATCH' && updateMatch) {
    const body = await parseBody(req);
    const result = sendingEngine.updateMailbox(parseInt(updateMatch[1]), body);
    return jsonResponse(res, { ok: true, ...result });
  }

  const testImapMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/test-imap$/);
  if (method === 'POST' && testImapMatch) {
    const result = await imapReceiver.testMailbox(testImapMatch[1]);
    return jsonResponse(res, result);
  }

  const syncImapMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/sync-imap$/);
  if (method === 'POST' && syncImapMatch) {
    const body = await parseBody(req, 8 * 1024);
    try {
      const result = await imapReceiver.syncMailbox(syncImapMatch[1], { limit: body.limit, backfill: body.backfill === true });
      imapSyncScheduler.recordManualSuccess(syncImapMatch[1], result);
      return jsonResponse(res, result);
    } catch (error) {
      imapSyncScheduler.recordManualFailure(syncImapMatch[1], error);
      throw error;
    }
  }

  // DELETE /api/sending/mailboxes/:id — delete mailbox
  if (method === 'DELETE' && updateMatch) {
    const result = sendingEngine.deleteMailbox(parseInt(updateMatch[1]));
    return jsonResponse(res, { ok: true, ...result });
  }

  // POST /api/sending/mailboxes/:id/verify-dns — perform live DNS lookups (SPF, DMARC, MX, DNSBL)
  const verifyDnsMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/verify-dns$/);
  if (method === 'POST' && verifyDnsMatch) {
    const result = await sendingEngine.verifyMailboxDns(parseInt(verifyDnsMatch[1]));
    return jsonResponse(res, { ok: true, ...result });
  }

  // POST /api/sending/mailboxes/:id/test-smtp — verify live SMTP handshake
  const testSmtpMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/test-smtp$/);
  if (method === 'POST' && testSmtpMatch) {
    const result = await sendingEngine.testMailboxSmtp(parseInt(testSmtpMatch[1]));
    return jsonResponse(res, result);
  }

  // POST /api/sending/mailboxes/:id/send-test — transmit real test email
  const sendTestMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/send-test$/);
  if (method === 'POST' && sendTestMatch) {
    const body = await parseBody(req);
    if (!body.toEmail) return errorResponse(res, 'toEmail is required');
    const result = await sendingEngine.sendTestEmail(
      parseInt(sendTestMatch[1]),
      body.toEmail,
      body.subject,
      body.body
    );
    return jsonResponse(res, result);
  }

  // POST /api/sending/mailboxes/:id/pause
  const pauseMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/pause$/);
  if (method === 'POST' && pauseMatch) {
    return jsonResponse(res, sendingEngine.pauseMailbox(parseInt(pauseMatch[1])));
  }

  // POST /api/sending/mailboxes/:id/activate
  const activateMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/activate$/);
  if (method === 'POST' && activateMatch) {
    return jsonResponse(res, sendingEngine.activateMailbox(parseInt(activateMatch[1])));
  }

  // POST /api/sending/mailboxes/:id/retire
  const retireMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/retire$/);
  if (method === 'POST' && retireMatch) {
    return jsonResponse(res, sendingEngine.retireMailbox(parseInt(retireMatch[1])));
  }

  // POST /api/sending/health-recompute — recompute all health scores
  if (method === 'POST' && pathname === '/api/sending/health-recompute') {
    const results = sendingEngine.recomputeHealthScores();
    return jsonResponse(res, { ok: true, results });
  }

  // POST /api/sending/warmup-check — process warmup transitions
  if (method === 'POST' && pathname === '/api/sending/warmup-check') {
    const transitioned = sendingEngine.processWarmupTransitions();
    return jsonResponse(res, { ok: true, transitioned });
  }

  // --- Campaigns ---

  if (method === 'GET' && pathname === '/api/sending/templates') {
    const includeArchived = parsedUrl.searchParams.get('include_archived') === 'true';
    return jsonResponse(res, campaignTemplates.listCampaignTemplates({ includeArchived }));
  }
  if (method === 'POST' && pathname === '/api/sending/templates') {
    const body = await parseBody(req);
    return jsonResponse(res, { ok: true, ...campaignTemplates.createCampaignTemplate(body) }, 201);
  }
  const campaignTemplateMatch = pathname.match(/^\/api\/sending\/templates\/(\d+)$/);
  if (method === 'PATCH' && campaignTemplateMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, { ok: true, ...campaignTemplates.updateCampaignTemplate(campaignTemplateMatch[1], body) });
  }
  const campaignTemplateStateMatch = pathname.match(/^\/api\/sending\/templates\/(\d+)\/(archive|restore)$/);
  if (method === 'POST' && campaignTemplateStateMatch) {
    return jsonResponse(res, { ok: true, ...campaignTemplates.setCampaignTemplateArchived(campaignTemplateStateMatch[1], campaignTemplateStateMatch[2] === 'archive') });
  }

  // GET /api/sending/campaigns — list all campaigns with stats
  if (method === 'GET' && pathname === '/api/sending/campaigns') {
    const result = abTesting.getAllCampaignStats().map(campaign => {
      const audience = campaignAudience.getCampaignAudience(campaign.id, { limit: 1 });
      const senderSelection = sendingEngine.getCampaignSenderSelection(campaign.id);
      return {
        ...campaign,
        status: audience?.campaign.status || campaign.status,
        audience_total: audience?.counts.total || 0,
        audience_eligible: audience?.counts.eligible || 0,
        sender_count: senderSelection?.senderIds.length || 0,
        sender_ready_count: senderSelection?.readyCount || 0,
        sender_locked: senderSelection?.locked || false,
        sequence_step_count: campaignSequence.getCampaignSequence(campaign.id)?.steps.length || 0,
        launch_snapshot: sendingEngine.getCampaignLaunchSummary(campaign.id),
      };
    });
    const view = parsedUrl.searchParams.get('status');
    if (view !== null && view !== 'archived') return errorResponse(res, 'status filter must be archived when provided.');
    return jsonResponse(res, view === 'archived' ? result.filter(campaign => campaign.status === 'archived') : result.filter(campaign => campaign.status !== 'archived'));
  }

  // POST /api/sending/campaigns — create campaign
  if (method === 'POST' && pathname === '/api/sending/campaigns') {
    const body = await parseBody(req);
    if (!body.name) return errorResponse(res, 'name required');
    const result = sendingEngine.createCampaign(body);
    return jsonResponse(res, { ok: true, ...result });
  }

  const campaignCloneMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/clone$/);
  if (method === 'POST' && campaignCloneMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, { ok: true, ...campaignSequence.cloneCampaignAsDraft(campaignCloneMatch[1], body) }, 201);
  }

  const campaignDraftMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)$/);
  if (method === 'PATCH' && campaignDraftMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, { ok: true, ...sendingEngine.updateCampaignDraft(campaignDraftMatch[1], body.name) });
  }
  const campaignArchiveMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/(archive|restore)$/);
  if (method === 'POST' && campaignArchiveMatch) {
    const result = sendingEngine.archiveCampaignDraft(campaignArchiveMatch[1], campaignArchiveMatch[2] === 'archive');
    return jsonResponse(res, { ok: true, ...result });
  }

  const campaignSendersMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/senders$/);
  if (method === 'GET' && campaignSendersMatch) {
    const result = sendingEngine.getCampaignSenderSelection(campaignSendersMatch[1]);
    if (!result) return errorResponse(res, 'Campaign not found.', 404);
    return jsonResponse(res, result);
  }
  if (method === 'PUT' && campaignSendersMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, { ok: true, ...sendingEngine.updateCampaignSenderSelection(campaignSendersMatch[1], body.mailboxIds) });
  }

  const campaignSequenceMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/sequence$/);
  if (method === 'GET' && campaignSequenceMatch) {
    const result = campaignSequence.getCampaignSequence(campaignSequenceMatch[1]);
    if (!result) return errorResponse(res, 'Campaign not found.', 404);
    return jsonResponse(res, result);
  }
  const campaignSequenceStepsMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/sequence\/steps$/);
  if (method === 'POST' && campaignSequenceStepsMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, { ok: true, ...campaignSequence.createCampaignStep(campaignSequenceStepsMatch[1], body) }, 201);
  }
  const campaignSequenceOrderMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/sequence\/order$/);
  if (method === 'PUT' && campaignSequenceOrderMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, { ok: true, ...campaignSequence.reorderCampaignSteps(campaignSequenceOrderMatch[1], body.stepIds) });
  }
  const campaignSequencePreviewMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/sequence\/steps\/(\d+)\/preview$/);
  if (method === 'POST' && campaignSequencePreviewMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, campaignSequence.previewCampaignStep(campaignSequencePreviewMatch[1], campaignSequencePreviewMatch[2], body.leadId, body.variantKey));
  }
  const campaignSequenceStepMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/sequence\/steps\/(\d+)$/);
  if (method === 'PUT' && campaignSequenceStepMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, { ok: true, ...campaignSequence.updateCampaignStep(campaignSequenceStepMatch[1], campaignSequenceStepMatch[2], body) });
  }
  if (method === 'DELETE' && campaignSequenceStepMatch) {
    return jsonResponse(res, { ok: true, ...campaignSequence.deleteCampaignStep(campaignSequenceStepMatch[1], campaignSequenceStepMatch[2]) });
  }

  const campaignLifecycleMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/(pause|resume|stop)$/);
  if (method === 'POST' && campaignLifecycleMatch) {
    const [, campaignId, action] = campaignLifecycleMatch;
    const result = action === 'pause'
      ? sendingEngine.pauseCampaign(campaignId)
      : action === 'resume'
        ? sendingEngine.resumeCampaign(campaignId)
        : sendingEngine.stopCampaign(campaignId);
    return jsonResponse(res, { ok: true, ...result });
  }

  // GET /api/sending/campaigns/:id/preflight — recipient, sender and launch readiness review
  const campaignPreflightMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/preflight$/);
  if (method === 'GET' && campaignPreflightMatch) {
    return jsonResponse(res, sendingEngine.getCampaignPreflight(campaignPreflightMatch[1]));
  }

  // GET/POST /api/sending/campaigns/:id/audience — snapshot and inspect recipients
  const audienceMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/audience$/);
  if (method === 'GET' && audienceMatch) {
    const rawLimit = parsedUrl.searchParams.get('limit');
    const rawOffset = parsedUrl.searchParams.get('offset');
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    const result = campaignAudience.getCampaignAudience(audienceMatch[1], {
      search: (parsedUrl.searchParams.get('search') || '').trim().slice(0, 120), limit, offset,
    });
    if (!result) return errorResponse(res, 'Campaign not found.', 404);
    return jsonResponse(res, result);
  }
  if (method === 'POST' && audienceMatch) {
    const body = await parseBody(req);
    if (body.listId !== undefined && body.leadIds !== undefined) return errorResponse(res, 'Choose either one saved list or an explicit contact selection.');
    const result = Array.isArray(body.leadIds)
      ? campaignAudience.enrollContactsInCampaign(audienceMatch[1], body.leadIds)
      : campaignAudience.enrollListInCampaign(audienceMatch[1], body.listId);
    return jsonResponse(res, { ok: true, ...result });
  }

  const campaignRecipientMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/audience\/(\d+)$/);
  if (method === 'DELETE' && campaignRecipientMatch) {
    return jsonResponse(res, { ok: true, ...campaignAudience.removeCampaignRecipient(campaignRecipientMatch[1], campaignRecipientMatch[2]) });
  }

  const oooReactivateMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/audience\/(\d+)\/reactivate$/);
  if (method === 'POST' && oooReactivateMatch) {
    const result = campaignAudience.reactivateSequenceAfterOutOfOffice(oooReactivateMatch[1], oooReactivateMatch[2]);
    return jsonResponse(res, { ok: true, ...result });
  }

  // GET /api/sending/campaigns/:id/variants — variant stats
  const variantsMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/variants$/);
  if (method === 'GET' && variantsMatch) {
    const rawStepId = parsedUrl.searchParams.get('stepId');
    return jsonResponse(res, abTesting.getVariantStats(parseInt(variantsMatch[1]), rawStepId === null ? null : Number(rawStepId)));
  }

  // GET /api/sending/campaigns/:id/timeline — 14-day timeline
  const timelineMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/timeline$/);
  if (method === 'GET' && timelineMatch) {
    const days = parseInt(parsedUrl.searchParams.get('days')) || 14;
    return jsonResponse(res, abTesting.getCampaignTimeline(parseInt(timelineMatch[1]), days));
  }

  // --- Send Queue ---

  // POST /api/sending/queue/:campaignId — queue sends
  const queueMatch = pathname.match(/^\/api\/sending\/queue\/(\d+)$/);
  if (method === 'POST' && queueMatch) {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const body = await parseBody(req);
    const result = await sendingEngine.queueSends(parseInt(queueMatch[1]), body);
    return jsonResponse(res, { ok: true, ...result });
  }

  // POST /api/sending/process — process the send queue
  if (method === 'POST' && pathname === '/api/sending/process') {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const body = await parseBody(req);
    sendingEngine.processSendQueue(body).catch(e => console.error('Send error:', e.message));
    return jsonResponse(res, { ok: true, message: 'Send queue processing started' });
  }

  // POST /api/sending/cancel — cancel processing
  if (method === 'POST' && pathname === '/api/sending/cancel') {
    return jsonResponse(res, { ok: true, cancelled: sendingEngine.cancelSending() });
  }

  // GET /api/sending/status — sending progress
  if (method === 'GET' && pathname === '/api/sending/status') {
    return jsonResponse(res, sendingEngine.getSendingStatus());
  }

  // GET /api/sending/queue/:campaignId — view send queue
  const viewQueueMatch = pathname.match(/^\/api\/sending\/queue\/(\d+)$/);
  if (method === 'GET' && viewQueueMatch) {
    return jsonResponse(res, sendingEngine.getSendQueue(parseInt(viewQueueMatch[1])));
  }

  // GET /api/sending/stats — overall send stats
  if (method === 'GET' && pathname === '/api/sending/stats') {
    return jsonResponse(res, sendingEngine.getSendStats());
  }

  // --- A/B Testing ---

  // POST /api/sending/ab/auto-promote — report eligible recommendations; never rewrite a launched experiment
  if (method === 'POST' && pathname === '/api/sending/ab/auto-promote') {
    const recommendations = abTesting.autoPromoteWinners();
    return jsonResponse(res, { ok: true, applied: false, recommendations });
  }

  // GET /api/sending/ab/assign/:campaignId — get next variant assignment
  const assignMatch = pathname.match(/^\/api\/sending\/ab\/assign\/(\d+)$/);
  if (method === 'GET' && assignMatch) {
    const leadId = parsedUrl.searchParams.get('leadId');
    const stepId = parsedUrl.searchParams.get('stepId');
    return jsonResponse(res, { variant: abTesting.assignVariant(assignMatch[1], leadId, stepId) });
  }

  // POST /api/sending/threshold-check — auto-pause breaching mailboxes
  if (method === 'POST' && pathname === '/api/sending/threshold-check') {
    const paused = sendingEngine.checkAutoThresholds();
    return jsonResponse(res, { ok: true, paused });
  }

  return errorResponse(res, `Unknown sending route: ${method} ${pathname}`, 404);
}

// ── Personalization API routes ───────────────────────────
async function handlePersonalizeApi(req, res, parsedUrl, pipeline) {
  const { personalizer } = pipeline;
  const method = req.method;
  const pathname = parsedUrl.pathname;

  // POST /api/personalize/batch/:id — start personalization for a batch
  const batchMatch = pathname.match(/^\/api\/personalize\/batch\/(\d+)$/);
  if (method === 'POST' && batchMatch) {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const body = await parseBody(req);
    const batchId = parseInt(batchMatch[1]);
    personalizer.personalizeBatch(batchId, body).catch(e => console.error('Personalize error:', e.message));
    return jsonResponse(res, { ok: true, batchId, message: 'Personalization started' });
  }

  // POST /api/personalize/cancel — cancel running personalization
  if (method === 'POST' && pathname === '/api/personalize/cancel') {
    return jsonResponse(res, { ok: true, cancelled: personalizer.cancelPersonalization() });
  }

  // GET /api/personalize/status — current progress
  if (method === 'GET' && pathname === '/api/personalize/status') {
    return jsonResponse(res, personalizer.getPersonalizationStatus());
  }

  // GET /api/personalize/list — list personalizations (filter: batch_id, status)
  if (method === 'GET' && pathname === '/api/personalize/list') {
    const batchId = parsedUrl.searchParams.get('batch_id');
    const status = parsedUrl.searchParams.get('status') || undefined;
    const limit = parseInt(parsedUrl.searchParams.get('limit')) || 100;
    const offset = parseInt(parsedUrl.searchParams.get('offset')) || 0;
    return jsonResponse(res, personalizer.getPersonalizationList(
      batchId ? parseInt(batchId) : null, { status, limit, offset }
    ));
  }

  // GET /api/personalize/awaiting — leads awaiting human approval
  if (method === 'GET' && pathname === '/api/personalize/awaiting') {
    const batchId = parsedUrl.searchParams.get('batch_id');
    return jsonResponse(res, personalizer.getAwaitingApproval(batchId ? parseInt(batchId) : null));
  }

  // GET /api/personalize/stats — personalization statistics
  if (method === 'GET' && pathname === '/api/personalize/stats') {
    const batchId = parsedUrl.searchParams.get('batch_id');
    return jsonResponse(res, personalizer.getPersonalizationStats(batchId ? parseInt(batchId) : null));
  }

  // POST /api/personalize/approve/:id — approve a personalization
  const approveMatch = pathname.match(/^\/api\/personalize\/approve\/(\d+)$/);
  if (method === 'POST' && approveMatch) {
    return jsonResponse(res, personalizer.approvePersonalization(parseInt(approveMatch[1])));
  }

  // POST /api/personalize/reject/:id — reject a personalization
  const rejectMatch = pathname.match(/^\/api\/personalize\/reject\/(\d+)$/);
  if (method === 'POST' && rejectMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, personalizer.rejectPersonalization(parseInt(rejectMatch[1]), body.reason));
  }

  // PATCH /api/personalize/:id — edit a personalization (human edits copy)
  const editMatch = pathname.match(/^\/api\/personalize\/(\d+)$/);
  if (method === 'PATCH' && editMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, personalizer.editPersonalization(parseInt(editMatch[1]), body));
  }

  // GET /api/personalize/ollama-test — check Ollama connection
  if (method === 'GET' && pathname === '/api/personalize/ollama-test') {
    const result = await personalizer.testOllamaConnection();
    return jsonResponse(res, result);
  }

  return errorResponse(res, `Unknown personalize route: ${method} ${pathname}`, 404);
}

// ── Main request handler ─────────────────────────────────────
export const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const reqPath = parsedUrl.pathname;

  if (reqPath === '/api/webhooks/meta/leadgen') {
    try {
      if (!['GET', 'POST'].includes(req.method)) {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, POST', 'Cache-Control': 'no-store' });
        return res.end('Method not allowed');
      }
      const pipeline = await getPipeline();
      if (!pipeline) return errorResponse(res, 'Pipeline is not available.', 503);
      const { createMetaLeadAdsManager } = await import('./pipeline/meta-lead-ads.js');
      const manager = createMetaLeadAdsManager({ db: pipeline.database.getDb(), fetchImpl: _metaLeadAdsFetchTestOverride || globalThis.fetch,
        now: _metaLeadAdsNowTestOverride || Date.now });
      if (req.method === 'GET') {
        const challenge = manager.verifyWebhookChallenge({
          mode: parsedUrl.searchParams.get('hub.mode'),
          verifyToken: parsedUrl.searchParams.get('hub.verify_token'),
          challenge: parsedUrl.searchParams.get('hub.challenge'),
        });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(challenge);
      }
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
        return errorResponse(res, 'Meta webhook requests must use application/json.', 415);
      }
      const rawBody = await readRawBody(req, 256 * 1024);
      const receipt = manager.receiveWebhook({ rawBody, signature: req.headers['x-hub-signature-256'] });
      jsonResponse(res, { received: true, ...receipt });
      if (receipt.accepted > 0) {
        setImmediate(() => { void manager.processWebhookEvents({ limit: 25 }).catch(() => {}); });
      }
      return;
    } catch (error) {
      const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
      if (status === 500) console.error('Meta lead webhook error:', error);
      return errorResponse(res, status === 500 ? 'Meta webhook could not be processed.' : error.message, status);
    }
  }

  if (reqPath.startsWith('/api/auth/')) {
    try {
      await handleAuthRoute(req, res, reqPath);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
      if (status === 500) console.error('Authentication API Error:', error);
      errorResponse(res, status === 500 ? 'Authentication service unavailable.' : error.message, status);
    }
    return;
  }

  let authenticatedSession = null;
  if (reqPath.startsWith('/api/') && !AUTH_TEST_BYPASS && !isPublicApi(req, reqPath)) {
    try {
      const auth = await getAuthManager();
      const cookies = requestCookies(req);
      const session = auth.currentSession(cookies.odd_session);
      if (!session) return errorResponse(res, 'Sign-in required.', 401);
      authenticatedSession = session;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
        && !auth.verifyCsrf(session, cookies.odd_csrf, req.headers['x-csrf-token'])) {
        return errorResponse(res, 'CSRF token was not accepted.', 403);
      }
      if (!auth.authorize(session, req.method, reqPath)) {
        return errorResponse(res, 'Your workspace role does not allow this action.', 403);
      }
    } catch (error) {
      console.error('Authentication boundary error:', error);
      return errorResponse(res, 'Authentication service unavailable.', 503);
    }
  }

  if (reqPath.startsWith('/api/workspace/')) {
    try {
      await handleWorkspaceRoute(req, res, parsedUrl, authenticatedSession);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      if (status === 500) console.error('Workspace API Error:', error);
      errorResponse(res, status === 500 ? 'Workspace request could not be completed.' : error.message, status);
    }
    return;
  }

  // API routes
  if (reqPath.startsWith('/api/qualify/') || reqPath === '/api/leads/site-status-distribution') {
    try {
      const pipeline = await getPipeline();
      if (!pipeline) return errorResponse(res, 'Pipeline not initialized', 503);
      await handleQualifyApi(req, res, parsedUrl, pipeline, authenticatedSession);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
      if (status === 500) console.error('Qualify API Error:', error);
      errorResponse(res, status === 500 ? 'Internal server error' : error.message, status);
    }
    return;
  }

  if (reqPath.startsWith('/api/verify/')) {
    try {
      const pipeline = await getPipeline();
      if (!pipeline) return errorResponse(res, 'Pipeline not initialized', 503);
      await handleVerifyApi(req, res, parsedUrl, pipeline);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      if (status === 500) console.error('Verify API Error:', error);
      errorResponse(res, status === 500 ? 'Internal server error' : error.message, status);
    }
    return;
  }

  if (reqPath.startsWith('/api/sending/')) {
    try {
      const pipeline = await getPipeline();
      if (!pipeline) return errorResponse(res, 'Pipeline not initialized', 503);
      await handleSendingApi(req, res, parsedUrl, pipeline, authenticatedSession);
    } catch (error) {
      const status = Number.isInteger(error.statusCode)
        && ((error.statusCode >= 400 && error.statusCode < 500) || error.statusCode === 503) ? error.statusCode : 500;
      if (status === 500) console.error('Sending API Error:', error);
      errorResponse(res, status === 500 ? 'Internal server error' : error.message, status);
    }
    return;
  }

  if (reqPath.startsWith('/api/personalize/')) {
    try {
      const pipeline = await getPipeline();
      if (!pipeline) return errorResponse(res, 'Pipeline not initialized', 503);
      await handlePersonalizeApi(req, res, parsedUrl, pipeline);
    } catch (error) {
      console.error('Personalize API Error:', error);
      errorResponse(res, 'Internal server error', 500);
    }
    return;
  }

  if (reqPath === '/api/lead-strategies' || reqPath.startsWith('/api/lead-strategies/')) {
    try {
      const pipeline = await getPipeline();
      if (!pipeline) return errorResponse(res, 'Pipeline not initialized', 503);
      const { createLeadStrategyManager } = await import('./pipeline/lead-strategy.js');
      const manager = createLeadStrategyManager({
        db: pipeline.database.getDb(),
        fetchImpl: _leadStrategyFetchTestOverride || globalThis.fetch,
      });
      if (req.method === 'GET' && reqPath === '/api/lead-strategies') {
        const limit = Number.parseInt(parsedUrl.searchParams.get('limit'), 10) || 25;
        return jsonResponse(res, { provider: manager.getStatus(authenticatedSession), settings: manager.getSettings(authenticatedSession), strategies: manager.list(limit) });
      }
      const strategyMatch = reqPath.match(/^\/api\/lead-strategies\/(\d+)$/);
      if (req.method === 'GET' && strategyMatch) {
        const strategy = manager.get(strategyMatch[1]);
        return strategy ? jsonResponse(res, strategy) : errorResponse(res, 'Targeting strategy was not found.', 404);
      }
      if (req.method === 'POST' && reqPath === '/api/lead-strategies/provider-check') {
        if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
        const body = await parseBody(req, 8 * 1024);
        return jsonResponse(res, await manager.checkProvider(authenticatedSession, body.scope || 'effective'));
      }
      if (req.method === 'PUT' && reqPath === '/api/lead-strategies/provider-settings') {
        if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
        const body = await parseBody(req, 8 * 1024);
        const bypass = AUTH_TEST_BYPASS && !authenticatedSession;
        const scope = body.scope || (Number.isSafeInteger(authenticatedSession?.id) ? 'personal' : 'workspace');
        if (!bypass && scope === 'workspace' && !['owner', 'admin'].includes(authenticatedSession?.role)) {
          return errorResponse(res, 'Only workspace owners and admins can change the shared AI provider.', 403);
        }
        if (!bypass && scope === 'personal' && (!Number.isSafeInteger(authenticatedSession?.id)
          || !['owner', 'admin', 'operator'].includes(authenticatedSession?.role))) {
          return errorResponse(res, 'Sign in as an owner, admin, or operator to save personal AI provider settings.', 403);
        }
        const actor = authenticatedSession || (bypass ? { id: null, role: 'admin' } : null);
        const settings = manager.saveSettings({ ...body, scope }, actor);
        if (authenticatedSession) {
          try {
            const auth = await getAuthManager();
            auth.recordAuditEvent(scope === 'personal' ? 'ai_personal_provider_settings_updated' : 'ai_workspace_provider_settings_updated', authenticatedSession.id, req.socket?.remoteAddress || 'unknown');
          } catch (error) { console.error('AI provider settings audit event could not be recorded:', error.message); }
        }
        return jsonResponse(res, { settings, provider: manager.getStatus(authenticatedSession, scope) });
      }
      if (req.method === 'DELETE' && reqPath === '/api/lead-strategies/provider-settings') {
        if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
        if (!authenticatedSession) return errorResponse(res, 'Sign in before clearing personal AI provider settings.', 401);
        const settings = manager.clearPersonalSettings(authenticatedSession);
        try {
          const auth = await getAuthManager();
          auth.recordAuditEvent('ai_personal_provider_settings_cleared', authenticatedSession.id, req.socket?.remoteAddress || 'unknown');
        } catch (error) { console.error('AI provider settings audit event could not be recorded:', error.message); }
        return jsonResponse(res, { settings, provider: manager.getStatus(authenticatedSession) });
      }
      if (req.method === 'POST' && reqPath === '/api/lead-strategies') {
        if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
        const body = await parseBody(req, 12 * 1024);
        const strategy = await manager.generate(body, authenticatedSession);
        return jsonResponse(res, strategy, 201);
      }
      return errorResponse(res, 'Unknown lead strategy route.', 404);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
      if (status === 500) console.error('Lead strategy API Error:', error);
      return errorResponse(res, status === 500 ? 'Lead targeting strategy could not be completed.' : error.message, status);
    }
  }

  if (reqPath.startsWith('/api/')) {
    try {
      await handleApiRequest(req, res, parsedUrl, authenticatedSession);
    } catch (error) {
      const status = Number.isInteger(error.statusCode)
        && ((error.statusCode >= 400 && error.statusCode < 500) || [502, 503, 504].includes(error.statusCode))
        ? error.statusCode : 500;
      if (status === 500) console.error('API Error:', error);
      errorResponse(res, status === 500 ? 'Internal server error' : error.message, status);
    }
    return;
  }

  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    return res.end('Method not allowed');
  }
  if (!AUTH_TEST_BYPASS && reqPath !== '/login' && !isSafeAssetPath(reqPath)) {
    try {
      const auth = await getAuthManager();
      if (!auth.currentSession(requestCookies(req).odd_session)) {
        res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
        return res.end();
      }
    } catch (error) {
      console.error('Static authentication boundary error:', error);
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('Authentication service unavailable.');
    }
  }
  serveStaticFile(req, res, reqPath);
});

server.on('close', () => _pipeline?.imapSyncScheduler?.stop());

server.listen(PORT, HOST, () => {
  console.log(`\n🚀 oddecosys CRM Control Plane running at: http://localhost:${server.address().port}`);
  console.log(`📡 API endpoints available at: http://localhost:${PORT}/api/`);
  console.log(`\nAPI Routes:`);
  console.log(`  GET  /api/batches                     - List all batches`);
  console.log(`  POST /api/batches                     - Create new batch`);
  console.log(`  GET  /api/batches/:id                 - Batch details`);
  console.log(`  GET  /api/leads                       - List leads (filter: batch_id, status, search)`);
  console.log(`  GET  /api/leads/:id                   - Lead details with emails & events`);
  console.log(`  GET  /api/stats/discovery             - Discovery pipeline stats`);
  console.log(`  GET  /api/stats/funnel                - Pipeline funnel stats`);
  console.log(`  POST /api/qualify/batch/:id            - Start batch qualification`);
  console.log(`  POST /api/qualify/batch/:id/cancel     - Cancel running qualification`);
  console.log(`  GET  /api/qualify/status               - Qualification progress`);
  console.log(`  GET  /api/qualify/results/:batchId     - Qualification results`);
  console.log(`  POST /api/qualify/lead/:id             - Re-qualify single lead`);
  console.log(`  POST /api/qualify/recheck-stale        - Requeue stale leads`);
  console.log(`  GET  /api/qualify/stale-count          - Count stale leads`);
  console.log(`  GET  /api/qualify/spot-check/:batchId  - Lowest confidence leads`);
  console.log(`  GET  /api/leads/site-status-distribution - Site status counts`);
  console.log(`  POST /api/verify/batch/:id              - Start batch verification`);
  console.log(`  POST /api/verify/batch/:id/cancel       - Cancel running verification`);
  console.log(`  GET  /api/verify/status                 - Verification progress`);
  console.log(`  GET  /api/verify/results/:batchId       - Verification results`);
  console.log(`  POST /api/verify/email/:id              - Re-verify single email`);
  console.log(`  POST /api/verify/single                 - Verify arbitrary email`);
  console.log(`  GET  /api/verify/distribution           - Verification status counts`);
  console.log(`  --- Sending Engine (Phase 6) ---`);
  console.log(`  GET  /api/sending/mailboxes              - Mailbox fleet`);
  console.log(`  POST /api/sending/mailboxes              - Add mailbox`);
  console.log(`  POST /api/sending/mailboxes/:id/pause    - Pause mailbox`);
  console.log(`  POST /api/sending/mailboxes/:id/activate - Re-activate mailbox`);
  console.log(`  POST /api/sending/mailboxes/:id/retire   - Retire mailbox`);
  console.log(`  POST /api/sending/health-recompute       - Recompute health scores`);
  console.log(`  POST /api/sending/warmup-check           - Process warmup transitions`);
  console.log(`  GET  /api/sending/campaigns              - List campaigns + stats`);
  console.log(`  POST /api/sending/campaigns              - Create campaign`);
  console.log(`  GET  /api/sending/campaigns/:id/variants - A/B variant stats`);
  console.log(`  GET  /api/sending/campaigns/:id/timeline - Campaign timeline`);
  console.log(`  POST /api/sending/queue/:campaignId      - Queue sends`);
  console.log(`  POST /api/sending/process                - Process send queue`);
  console.log(`  POST /api/sending/cancel                 - Cancel processing`);
  console.log(`  GET  /api/sending/status                 - Sending progress`);
  console.log(`  GET  /api/sending/stats                  - Overall send stats`);
  console.log(`  --- A/B Testing (Phase 7) ---`);
  console.log(`  POST /api/sending/ab/auto-promote        - Auto-promote winners`);
  console.log(`  GET  /api/sending/ab/assign/:campaignId  - Get variant assignment`);
  console.log(`  POST /api/sending/threshold-check        - Auto-pause check`);
  console.log(`  --- AI Personalization (Phase 5) ---`);
  console.log(`  POST /api/personalize/batch/:id          - Start personalization`);
  console.log(`  POST /api/personalize/cancel             - Cancel personalization`);
  console.log(`  GET  /api/personalize/status             - Personalization progress`);
  console.log(`  GET  /api/personalize/list               - List personalizations`);
  console.log(`  GET  /api/personalize/awaiting           - Leads awaiting approval`);
  console.log(`  GET  /api/personalize/stats              - Personalization stats`);
  console.log(`  POST /api/personalize/approve/:id        - Approve personalization`);
  console.log(`  POST /api/personalize/reject/:id         - Reject personalization`);
  console.log(`  PATCH /api/personalize/:id               - Edit personalization`);
  console.log(`  GET  /api/personalize/ollama-test        - Check Ollama connection`);
  console.log(`\nPress Ctrl+C to stop.\n`);
});
