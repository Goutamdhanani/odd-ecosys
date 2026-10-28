import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AstraResearchError, saveResearchSnapshot } from '../pipeline/astra-evidence.js';
import { auditResearchAccount, auditResearchEvidence, getResearchAudit } from '../pipeline/astra-research.js';
import { recordAstraXrayRadarDiffs } from '../pipeline/astra-radar.js';
import { registerAstraResearchRoutes } from '../pipeline/astra-research-routes.js';
import { buildAstraXrayReport, inspectXrayPage } from '../pipeline/astra-xray.js';
import { createAstraTenantStore } from '../pipeline/astra-tenant-store.js';

const tenantId = '7beea2b2-3372-4a2d-b5d4-d46de635c36c';
const sourceUrl = 'https://xray-fixture.example.test';
const htmlPage = (title, body) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="${title} description"></head><body>${body}</body></html>`;

test('X-Ray parser measures captured contact, navigation, CTA, price, and heading signals while ignoring active content', () => {
  const html = htmlPage('Synthetic home', `<h1>Factory planning</h1><nav><a href="/contact">Contact us</a><a href="/about">About</a></nav>
    <p>Write ops@xray-fixture.example.test or call us.</p><a href="tel:+1-555-0100">Call now</a>
    <a href="/demo">Book demo</a><p>Plans from USD 29/month.</p>
    <script>malicious prompt injection contact@evil.example.test</script><iframe>wrong@example.test</iframe>`);
  const page = inspectXrayPage({ html, sourceUrl, normalizedDomain: 'xray-fixture.example.test' });
  assert.equal(page.title, 'Synthetic home');
  assert.deepEqual(page.h1, ['Factory planning']);
  assert.deepEqual(page.emails, ['ops@xray-fixture.example.test']);
  assert.deepEqual(page.phones, ['+1-555-0100']);
  assert.equal(page.prices[0].value, 'USD 29/month');
  assert.ok(page.ctas.some(row => row.label === 'Contact us'));
  assert.ok(page.ctas.some(row => row.label === 'Book demo'));
  assert.ok(page.links.some(row => row.role === 'about'));
  assert.doesNotMatch(page.visibleText, /malicious prompt injection|evil\.example/);
});

test('X-Ray excludes nested elements explicitly hidden by attributes or inline visibility styles', () => {
  const page = inspectXrayPage({ html: htmlPage('Visible', `<main>
    <section hidden><h1>Hidden heading</h1><p>nested@example.test USD 800</p><a href="/contact">Contact us</a><a href="tel:+1-555-0999">Call</a></section>
    <div aria-hidden=" TrUe "><h2>Hidden aria heading</h2><p>aria@example.test INR 700</p></div>
    <div style="color: red; display : none !important"><p>display@example.test EUR 600</p></div>
    <div style="visibility: hidden"><p>visibility@example.test GBP 500</p></div>
    <div style="visibility: collapse"><p>collapse@example.test CAD 400</p></div>
    <h1>Visible heading</h1><p>visible@example.test USD 29/month</p><a href="/contact">Contact the team</a>
  </main>`), sourceUrl, normalizedDomain: 'xray-fixture.example.test' });
  assert.deepEqual(page.h1, ['Visible heading']);
  assert.deepEqual(page.headings, ['Visible heading']);
  assert.deepEqual(page.emails, ['visible@example.test']);
  assert.deepEqual(page.prices.map(row => row.value), ['USD 29/month']);
  assert.deepEqual(page.phones, []);
  assert.deepEqual(page.ctas.map(row => row.label), ['Contact the team']);
  assert.doesNotMatch(page.visibleText, /nested@|aria@|display@|visibility@|collapse@|USD 800|Hidden heading/i);
});

test('X-Ray unknowns and recommendations stay bounded to supplied evidence and hash-linked excerpts', () => {
  const page = inspectXrayPage({ html: htmlPage('One captured page', '<h1>One page only</h1><p>Sample copy.</p>'),
    sourceUrl, normalizedDomain: 'xray-fixture.example.test' });
  const report = buildAstraXrayReport({ account: { id: 'acct-1', normalizedDomain: 'xray-fixture.example.test' },
    pages: [{ ...page, evidenceId: 'evidence-1', sourceId: 'source-1', contentSha256: 'a'.repeat(64),
      capturedAt: '2026-10-26T00:00:00.000Z', status: 'usable' }],
    pageCoverage: [{ evidenceId: 'evidence-1', sourceId: 'source-1', sourceUrl,
      contentSha256: 'a'.repeat(64), capturedAt: '2026-10-26T00:00:00.000Z', status: 'usable' }],
    now: new Date('2026-10-26T00:00:01Z') });
  assert.equal(report.coverageStatus, 'partial');
  assert.equal(report.findings.find(row => row.signal === 'contact_page_coverage').outcome, 'unknown');
  assert.match(report.findings.find(row => row.signal === 'contact_page_coverage').detail, /supplied captures|captured/i);
  assert.equal(report.findings.find(row => row.signal === 'email_candidate_count').outcome, 'unknown');
  assert.ok(report.opportunities.every(row => row.evidence.every(ref => ref.contentSha256 === 'a'.repeat(64))));
  assert.equal(report.sourceCoverage.status, 'partial');
  assert.match(report.sourceCoverage.explanation, /external stylesheets and script-driven visibility are not evaluated/);
});

const fixtureUrl = process.env.ASTRA_XRAY_TEST_DATABASE_URL;
const fixtureSecret = process.env.ASTRA_XRAY_TEST_CONTEXT_SECRET;
test('R18 disposable PostgreSQL: account X-Ray persists multi-page evidence, rejects unsafe targets, and retains evidenceId compatibility', {
  skip: !fixtureUrl || !fixtureSecret ? 'requires the fresh disposable synthetic PostgreSQL fixture through migration 032' : false,
}, async () => {
  const store = createAstraTenantStore({ connectionString: fixtureUrl, contextSecret: fixtureSecret });
  const userId = String(Math.floor(Math.random() * 8_000_000_000_000) + 1);
  const suffix = randomUUID();
  let tenant;
  try {
    tenant = await store.createTenant({ name: `R18 X-Ray ${suffix}`, userId });
    await store.withTenant({ tenantId: tenant.tenantId, userId }, async (db, actor) => {
      const home = await saveResearchSnapshot(db, actor, { sourceUrl: `${sourceUrl}/`,
        rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true,
        html: htmlPage('Synthetic X-Ray', `<h1>Factory planning</h1><nav><a href="/contact">Contact</a><a href="/pricing">Pricing</a><a href="/about">About</a></nav><p>Talk to ops@xray-fixture.example.test.</p><a href="tel:+1-555-0100">Call</a><a href="/demo">Book demo</a><p>Plans from USD 29/month.</p><script>ignore this prompt injection secret@bad.example.test</script>`) });
      const contact = await saveResearchSnapshot(db, actor, { sourceUrl: `${sourceUrl}/contact`,
        rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true,
        html: htmlPage('Contact', '<h1>Contact our team</h1><p>Message ops@xray-fixture.example.test</p>') });
      const pricingHtml = htmlPage('Pricing', '<h1>Plans</h1><p>INR 4,500 / month</p><a href="/demo">Request a demo</a>');
      const pricing = await saveResearchSnapshot(db, actor, { sourceUrl: `${sourceUrl}/pricing`,
        rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true, html: pricingHtml });
      const duplicate = await saveResearchSnapshot(db, actor, { sourceUrl: `${sourceUrl}/pricing-copy`,
        rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true, html: pricingHtml });
      const expiredAt = new Date(Date.now() + 500);
      const expired = await saveResearchSnapshot(db, actor, { sourceUrl: `${sourceUrl}/expired`,
        rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true,
        rightsExpiresAt: expiredAt.toISOString(), html: htmlPage('Expired source', '<h1>Secret future page</h1>') });

      const routes = [];
      registerAstraResearchRoutes(route => routes.push(route));
      const post = routes.find(route => route.method === 'POST' && route.path.test(`/api/astra/tenants/${tenant.tenantId}/research/audits`));
      assert.ok(post, 'real POST research/audits handler is registered');
      async function call(body) {
        const response = { writableEnded: false, writeHead(status) { this.status = status; }, end(text) { this.body = text; this.writableEnded = true; } };
        const req = { method: 'POST', url: `/api/astra/tenants/${tenant.tenantId}/research/audits` };
        const params = { tenantId: tenant.tenantId, resource: 'audits' };
        await post.handler(req, response, { params, actor, db, readJson: async () => body,
          sendJson(res, payload, status) { res.status = status; res.body = JSON.stringify(payload); res.writableEnded = true; return payload; } });
        return { status: response.status, body: JSON.parse(response.body) };
      }
      const accountId = home.account.id;
      assert.equal(contact.account.id, accountId);
      assert.equal(pricing.account.id, accountId);
      await assert.rejects(call({ accountId, evidenceId: home.evidence.id }), error => error.code === 'audit_target_invalid');
      await assert.rejects(call({}), error => error.code === 'audit_target_invalid');

      // Simulate a later policy clock without sleeping or changing a fixture row.
      const expiredReport = await auditResearchAccount(db, actor, accountId, { now: new Date(Date.now() + 2 * 60_000) });
      assert.equal(expiredReport.sourceCoverage.pages.find(row => row.evidenceId === expired.evidence.id).status, 'rights_expired');
      assert.ok(!JSON.stringify(expiredReport).includes('Secret future page'));
      let databasePassedExpiry = false;
      const expiryDeadline = Date.now() + 10_000;
      while (!databasePassedExpiry && Date.now() < expiryDeadline) {
        const databaseClock = await db.query('SELECT statement_timestamp() >= $1::timestamptz AS passed', [expiredAt]);
        databasePassedExpiry = databaseClock.rows[0]?.passed === true;
        if (!databasePassedExpiry) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(databasePassedExpiry, true, 'the synthetic database clock passes the persisted source expiry');
      const backdatedReport = await auditResearchAccount(db, actor, accountId, { now: new Date(Date.now() - 2 * 60_000) });
      assert.equal(backdatedReport.sourceCoverage.pages.find(row => row.evidenceId === expired.evidence.id).status, 'rights_expired',
        'a backdated audit clock cannot revive rights already expired by database time');
      const staleReport = await auditResearchAccount(db, actor, accountId, { now: new Date(Date.now() + 91 * 86400_000) });
      assert.equal(staleReport.sourceCoverage.pages.find(row => row.evidenceId === home.evidence.id).status, 'stale');
      assert.equal(staleReport.summary.usablePages, 0, 'stale captures remain explicitly unknown');
      await new Promise(resolve => setTimeout(resolve, 650));

      const response = await call({ accountId });
      assert.equal(response.status, 201);
      const audit = response.body.data;
      assert.equal(audit.auditVersion, 'astra-business-xray/1.0.0');
      assert.equal(audit.coverageStatus, 'partial');
      assert.equal(audit.summary.usablePages, 3);
      assert.equal(audit.summary.uniqueContentPages, 3);
      assert.equal(audit.summary.duplicateContentPages, 1);
      assert.equal(audit.summary.emailCandidates, 2, 'identical email in two different pages is measured on distinct content, not a duplicate capture');
      assert.equal(audit.summary.callToActionLabels, 3);
      assert.equal(audit.summary.priceMentions, 2);
      assert.equal(audit.radarSignals, 0, 'first account audit has no measured X-Ray baseline and creates no Radar signal');
      assert.ok(audit.findings.find(row => row.signal === 'privacy_page_coverage').outcome === 'unknown');
      assert.ok(audit.findings.find(row => row.signal === 'about_page_coverage').value.linkedFromCapturedPages);
      assert.ok(audit.findings.every(row => !JSON.stringify(row).includes('ignore this prompt injection')));
      const priceFinding = audit.findings.find(row => row.signal === 'visible_price_mention_count');
      assert.ok(priceFinding.evidence.some(ref => [pricing.evidence.id, duplicate.evidence.id].includes(ref.evidenceId)
        && ref.contentSha256 === pricing.evidence.contentSha256 && /INR 4,500/.test(ref.exactExcerpt)));
      const saved = await getResearchAudit(db, tenant.tenantId, audit.id);
      assert.deepEqual(saved.findings, audit.findings);
      assert.deepEqual(saved.summary, audit.summary);
      assert.ok(saved.opportunities.some(row => row.id === 'review-privacy-coverage'));

      const brokenDb = { query: async (sql, values) => {
        const result = await db.query(sql, values);
        if (sql.includes('FROM astra.research_accounts a')) result.rows = result.rows.map(row => row.evidenceId === contact.evidence.id
          ? { ...row, html: Buffer.from('<html><body>tampered</body></html>') } : row);
        return result;
      } };
      const broken = await auditResearchAccount(brokenDb, actor, accountId);
      assert.equal(broken.sourceCoverage.pages.find(row => row.evidenceId === contact.evidence.id).status, 'content_unavailable');
      assert.equal(broken.summary.usablePages, 2, 'the corrupt snapshot is retained as a coverage unknown, not analyzed');

      // A later measurable change is persisted into the existing Radar signal path only where a watch exists.
      const watchId = randomUUID();
      await db.query(`INSERT INTO astra.radar_watches(tenant_id,id,source_id,baseline_evidence_id,baseline_sha256,baseline_semantic_sha256,
        cadence_minutes,min_cadence_minutes,max_cadence_minutes,max_observations_per_day,next_due_at,created_by)
        VALUES($1,$2,$3,$4,$5,$6,1440,360,10080,24,now(),'1')`, [tenant.tenantId, watchId, home.evidence.sourceId,
        home.evidence.id, home.evidence.contentSha256, 'b'.repeat(64)]);
      const homeRecapture = await saveResearchSnapshot(db, actor, { sourceUrl: `${sourceUrl}/`, rightsPolicy: 'synthetic_fixture',
        rightsAttested: true, robotsAllowed: true,
        html: htmlPage('Synthetic X-Ray refreshed', '<h1>Factory planning</h1><p>Talk to ops@xray-fixture.example.test and team@xray-fixture.example.test.</p><a href="tel:+1-555-0100">Call</a><a href="/demo">Book demo</a><p>Plans from USD 29/month.</p>') });
      assert.equal(homeRecapture.account.id, accountId);
      const changed = await auditResearchAccount(db, actor, accountId);
      assert.ok(changed.radarSignals >= 1, `measured count changes with an active source watch create existing Radar signals (${JSON.stringify(changed.radar)})`);
      const orderedAudits = await db.query(`SELECT created_at > (SELECT created_at FROM astra.research_audits WHERE tenant_id=$1 AND id=$2) AS "isNewer"
        FROM astra.research_audits WHERE tenant_id=$1 AND id=$3`, [tenant.tenantId, broken.id, changed.id]);
      assert.equal(orderedAudits.rows[0]?.isNewer, true, 'audit ordering uses actual insert time, not transaction-stable now() or random UUID order');
      const radar = await db.query(`SELECT signal_type,provenance,expires_at FROM astra.radar_signals WHERE tenant_id=$1 AND watch_id=$2`, [tenant.tenantId, watchId]);
      assert.ok(radar.rows.some(row => row.signal_type === 'semantic_change' && row.provenance.observationKind === 'account_xray_metric_delta'));
      assert.ok(radar.rows.every(row => new Date(row.expires_at).valueOf() > Date.now()));

      const backwards = await call({ evidenceId: home.evidence.id });
      assert.equal(backwards.status, 201);
      assert.equal(backwards.body.data.auditVersion, 'astra-site-audit/1.0.0');
      assert.ok(backwards.body.data.findings.some(row => row.signal === 'document_title'));
      assert.ok(backwards.body.data.findings.some(row => row.signal === 'privacy_page' && row.outcome === 'unknown'));

      const foreignAccount = await store.withTenant({ tenantId: tenant.tenantId, userId }, async () => randomUUID());
      await assert.rejects(auditResearchAccount(db, actor, foreignAccount), error => error instanceof AstraResearchError && error.code === 'account_not_found');
      await assert.rejects(auditResearchAccount(db, actor, '00000000-0000-4000-8000-000000000000'), error => error.code === 'account_not_found');
      await assert.rejects(auditResearchEvidence(db, actor, randomUUID()), error => error.code === 'evidence_not_found');
      await assert.rejects(auditResearchEvidence(db, actor, 'not-a-uuid'), error => error.code === 'evidence_id_invalid');
      const otherTenant = await store.createTenant({ name: `R18 foreign X-Ray ${suffix}`, userId: String(Number(userId) + 1) });
      const foreignAccountId = await store.withTenant({ tenantId: otherTenant.tenantId, userId: String(Number(userId) + 1) }, async (otherDb, otherActor) => {
        const foreign = await saveResearchSnapshot(otherDb, otherActor, { sourceUrl, rightsPolicy: 'synthetic_fixture',
          rightsAttested: true, robotsAllowed: true, html: htmlPage('Foreign', '<h1>Foreign account</h1>') });
        return foreign.account.id;
      });
      await assert.rejects(auditResearchAccount(db, actor, foreignAccountId), error => error instanceof AstraResearchError && error.code === 'account_not_found');
    });
  } finally {
    await store.close();
  }
});

test('R18 disposable PostgreSQL: watched recapture lineage is exact-URL, rights-current, and append-only', {
  skip: !fixtureUrl || !fixtureSecret ? 'requires the fresh disposable synthetic PostgreSQL fixture through migration 032' : false,
}, async () => {
  const store = createAstraTenantStore({ connectionString: fixtureUrl, contextSecret: fixtureSecret });
  const userId = String(Math.floor(Math.random() * 8_000_000_000_000) + 1);
  const suffix = randomUUID();
  let tenant;
  try {
    tenant = await store.createTenant({ name: `R18 X-Ray recapture ${suffix}`, userId });
    await store.withTenant({ tenantId: tenant.tenantId, userId }, async (db, actor) => {
      const page = (body) => htmlPage('Lineage fixture', body);
      async function capture(url, body, rightsExpiresAt) {
        return saveResearchSnapshot(db, actor, { sourceUrl: url, rightsPolicy: 'synthetic_fixture',
          rightsAttested: true, robotsAllowed: true, ...(rightsExpiresAt ? { rightsExpiresAt } : {}), html: page(body) });
      }
      async function watch(captureResult) {
        const watchId = randomUUID();
        await db.query(`INSERT INTO astra.radar_watches(tenant_id,id,source_id,baseline_evidence_id,baseline_sha256,baseline_semantic_sha256,
          cadence_minutes,min_cadence_minutes,max_cadence_minutes,max_observations_per_day,next_due_at,created_by)
          VALUES($1,$2,$3,$4,$5,$6,1440,360,10080,24,now(),'1')`, [tenant.tenantId, watchId,
          captureResult.evidence.sourceId, captureResult.evidence.id, captureResult.evidence.contentSha256, 'c'.repeat(64)]);
        return watchId;
      }

      const exactUrl = `https://recapture-${suffix}.example.test/`;
      const original = await capture(exactUrl, '<h1>Before</h1><p>one@example.test</p>');
      const baseline = await auditResearchAccount(db, actor, original.account.id);
      assert.equal(baseline.metrics.emailCandidates, 1);
      const watchId = await watch(original);
      const replacement = await capture(`${exactUrl}#same-document`, '<h1>After</h1><p>one@example.test two@example.test</p>');
      assert.notEqual(replacement.evidence.sourceId, original.evidence.sourceId, 'capture and source rows remain append-only');
      const current = await auditResearchAccount(db, actor, original.account.id);
      assert.equal(current.metrics.emailCandidates, 2);
      assert.equal(current.sourceCoverage.pages.find(row => row.evidenceId === original.evidence.id).status, 'superseded');
      assert.equal(current.sourceCoverage.pages.find(row => row.evidenceId === replacement.evidence.id).status, 'usable');
      const signals = await db.query(`SELECT source_id AS "sourceId",evidence_id AS "evidenceId",content_sha256 AS "contentSha256",provenance
        FROM astra.radar_signals WHERE tenant_id=$1 AND watch_id=$2`, [tenant.tenantId, watchId]);
      assert.ok(signals.rows.length >= 1, 'an exact canonical URL recapture signals its watched 1-to-2 email change');
      const signal = signals.rows.find(row => row.provenance.metric === 'emailCandidates');
      assert.ok(signal, 'email delta is linked to current evidence');
      assert.equal(signal.sourceId, original.evidence.sourceId, 'FK source_id remains the immutable watched source');
      assert.equal(signal.evidenceId, replacement.evidence.id);
      assert.equal(signal.contentSha256, replacement.evidence.contentSha256);
      assert.equal(signal.provenance.watchedSourceId, original.evidence.sourceId);
      assert.equal(signal.provenance.evidenceSourceId, replacement.evidence.sourceId);
      assert.equal(signal.provenance.sourceUrl, replacement.evidence.sourceUrl);
      const eventSource = await db.query(`SELECT source_id AS "sourceId",evidence_id AS "evidenceId" FROM astra.radar_event_sources
        WHERE tenant_id=$1 AND watch_id=$2 AND evidence_id=$3`, [tenant.tenantId, watchId, replacement.evidence.id]);
      assert.ok(eventSource.rows.some(row => row.sourceId === original.evidence.sourceId), 'event source FK preserves the watch source identity');

      // A page on another path, even on the same account domain, cannot borrow
      // the old homepage reference after the account-audit baseline.
      const otherPathUrl = `https://other-path-${suffix}.example.test/home`;
      const home = await capture(otherPathUrl, '<h1>Home</h1><p>stable home copy.</p>');
      const pathBaseline = await auditResearchAccount(db, actor, home.account.id);
      assert.equal(pathBaseline.metrics.emailCandidates, 0);
      const pathWatchId = await watch(home);
      const contact = await capture(`https://other-path-${suffix}.example.test/contact`, '<h1>Contact</h1><p>new@example.test</p>');
      const pathChanged = await auditResearchAccount(db, actor, home.account.id);
      assert.equal(pathChanged.metrics.emailCandidates, 1);
      assert.equal(contact.account.id, home.account.id);
      const pathSignals = await db.query('SELECT id FROM astra.radar_signals WHERE tenant_id=$1 AND watch_id=$2', [tenant.tenantId, pathWatchId]);
      assert.equal(pathSignals.rowCount, 0, 'an unrelated path does not match a watch for /home');

      // A same-URL recapture without a watch must remain silent.
      const unmonitoredUrl = `https://no-watch-${suffix}.example.test/`;
      const unmonitored = await capture(unmonitoredUrl, '<p>one@example.test</p>');
      await auditResearchAccount(db, actor, unmonitored.account.id);
      await capture(unmonitoredUrl, '<p>one@example.test two@example.test</p>');
      const unmonitoredChanged = await auditResearchAccount(db, actor, unmonitored.account.id);
      assert.equal(unmonitoredChanged.radarSignals, 0);

      // Matching URL is insufficient if the immutable watched-source rights
      // grant expired before the new, separately attested capture.
      const expiredWatchUrl = `https://expired-watch-${suffix}.example.test/`;
      const expiring = await capture(expiredWatchUrl, '<p>one@example.test</p>', new Date(Date.now() + 450).toISOString());
      await auditResearchAccount(db, actor, expiring.account.id);
      const expiredWatchId = await watch(expiring);
      await new Promise(resolve => setTimeout(resolve, 550));
      await capture(expiredWatchUrl, '<p>one@example.test two@example.test</p>');
      const afterWatchExpiry = await auditResearchAccount(db, actor, expiring.account.id);
      assert.equal(afterWatchExpiry.metrics.emailCandidates, 2);
      const expiredWatchSignals = await db.query('SELECT id FROM astra.radar_signals WHERE tenant_id=$1 AND watch_id=$2', [tenant.tenantId, expiredWatchId]);
      assert.equal(expiredWatchSignals.rowCount, 0, 'fresh evidence does not inherit expired watch rights');

      // Likewise, a fresh URL match cannot signal when the current evidence's
      // own rights have expired before the account audit.
      const expiredEvidenceUrl = `https://expired-evidence-${suffix}.example.test/`;
      const valid = await capture(expiredEvidenceUrl, '<p>one@example.test</p>');
      await auditResearchAccount(db, actor, valid.account.id);
      const validWatchId = await watch(valid);
      await capture(expiredEvidenceUrl, '<p>one@example.test two@example.test</p>', new Date(Date.now() + 450).toISOString());
      await new Promise(resolve => setTimeout(resolve, 550));
      const afterEvidenceExpiry = await auditResearchAccount(db, actor, valid.account.id);
      assert.ok(afterEvidenceExpiry.sourceCoverage.pages.some(row => row.status === 'rights_expired'));
      const expiredEvidenceSignals = await db.query('SELECT id FROM astra.radar_signals WHERE tenant_id=$1 AND watch_id=$2', [tenant.tenantId, validWatchId]);
      assert.equal(expiredEvidenceSignals.rowCount, 0, 'expired current evidence cannot produce a signal');
    });

    // A different tenant may have an active watch for the same URL; its row
    // is not visible to, or eligible for, this tenant's account audit.
    const foreignUserId = String(Number(userId) + 1);
    const foreign = await store.createTenant({ name: `R18 foreign watch ${suffix}`, userId: foreignUserId });
    const sharedUrl = `https://tenant-bound-${suffix}.example.test/`;
    await store.withTenant({ tenantId: foreign.tenantId, userId: foreignUserId }, async (foreignDb, foreignActor) => {
      const foreignCapture = await saveResearchSnapshot(foreignDb, foreignActor, { sourceUrl: sharedUrl,
        rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true, html: htmlPage('Foreign', '<p>foreign@example.test</p>') });
      const foreignWatchId = randomUUID();
      await foreignDb.query(`INSERT INTO astra.radar_watches(tenant_id,id,source_id,baseline_evidence_id,baseline_sha256,baseline_semantic_sha256,
        cadence_minutes,min_cadence_minutes,max_cadence_minutes,max_observations_per_day,next_due_at,created_by)
        VALUES($1,$2,$3,$4,$5,$6,1440,360,10080,24,now(),'1')`, [foreign.tenantId, foreignWatchId, foreignCapture.evidence.sourceId,
        foreignCapture.evidence.id, foreignCapture.evidence.contentSha256, 'd'.repeat(64)]);
    });
    await store.withTenant({ tenantId: tenant.tenantId, userId }, async (db, actor) => {
      const own = await saveResearchSnapshot(db, actor, { sourceUrl: sharedUrl, rightsPolicy: 'synthetic_fixture',
        rightsAttested: true, robotsAllowed: true, html: htmlPage('Own', '<p>one@example.test</p>') });
      await auditResearchAccount(db, actor, own.account.id);
      await saveResearchSnapshot(db, actor, { sourceUrl: sharedUrl, rightsPolicy: 'synthetic_fixture',
        rightsAttested: true, robotsAllowed: true, html: htmlPage('Own updated', '<p>one@example.test two@example.test</p>') });
      const after = await auditResearchAccount(db, actor, own.account.id);
      assert.equal(after.radarSignals, 0, 'same URL watched only by a different tenant creates no local signal');
    });
  } finally {
    await store.close();
  }
});

test('R18 disposable PostgreSQL: X-Ray Radar uses only a unique strictly earlier same-tenant account baseline', {
  skip: !fixtureUrl || !fixtureSecret ? 'requires the fresh disposable synthetic PostgreSQL fixture through migration 032' : false,
}, async () => {
  const store = createAstraTenantStore({ connectionString: fixtureUrl, contextSecret: fixtureSecret });
  const userId = String(Math.floor(Math.random() * 8_000_000_000_000) + 1);
  const foreignUserId = String(Number(userId) + 1);
  let tenant;
  let foreignTenant;
  const suffix = randomUUID();
  const page = body => `<html><body>${body}</body></html>`;
  try {
    tenant = await store.createTenant({ name: `R18 Radar baseline ${suffix}`, userId });
    foreignTenant = await store.createTenant({ name: `R18 Radar foreign ${suffix}`, userId: foreignUserId });
    await store.withTenant({ tenantId: tenant.tenantId, userId }, async (db, actor) => {
      async function capture(dbForCapture, actorForCapture, url, body) {
        return saveResearchSnapshot(dbForCapture, actorForCapture, { sourceUrl: url, rightsPolicy: 'synthetic_fixture',
          rightsAttested: true, robotsAllowed: true, html: page(body) });
      }
      function metadata(accountId, captureResult, metric) {
        return [{ signal: '__account_report_metadata__', accountId, metrics: { uniqueContentPages: metric }, sourceCoverage: { pages: [{
          evidenceId: captureResult.evidence.id, sourceId: captureResult.evidence.sourceId, sourceUrl: captureResult.evidence.sourceUrl,
          contentSha256: captureResult.evidence.contentSha256, capturedAt: captureResult.evidence.captured_at, status: 'usable',
        }] } }];
      }
      async function insertAudit(dbForAudit, accountId, captureResult, createdAt, metric, id = randomUUID()) {
        await dbForAudit.query(`INSERT INTO astra.research_audits(tenant_id,id,evidence_id,audit_version,coverage_status,findings,created_at)
          VALUES($1,$2,$3,'astra-business-xray/1.0.0','partial',$4::jsonb,$5::timestamptz)`,
        [dbForAudit === db ? actor.tenantId : foreignTenant.tenantId, id, captureResult.evidence.id,
          JSON.stringify(metadata(accountId, captureResult, metric)), createdAt]);
        return id;
      }
      async function watch(captureResult) {
        const watchId = randomUUID();
        await db.query(`INSERT INTO astra.radar_watches(tenant_id,id,source_id,baseline_evidence_id,baseline_sha256,baseline_semantic_sha256,
          cadence_minutes,min_cadence_minutes,max_cadence_minutes,max_observations_per_day,next_due_at,created_by)
          VALUES($1,$2,$3,$4,$5,$6,1440,360,10080,24,now(),'1')`,
        [actor.tenantId, watchId, captureResult.evidence.sourceId, captureResult.evidence.id,
          captureResult.evidence.contentSha256, 'e'.repeat(64)]);
        return watchId;
      }
      function report(accountId, domain, auditId, currentCapture, metric) {
        return { auditId, summary: { accountId, normalizedDomain: domain }, metrics: { uniqueContentPages: metric }, findings: [{
          signal: 'captured_page_count', evidence: [{ evidenceId: currentCapture.evidence.id, sourceId: currentCapture.evidence.sourceId,
            contentSha256: currentCapture.evidence.contentSha256, exactExcerpt: 'Synthetic current capture',
            sourceUrl: currentCapture.evidence.sourceUrl, capturedAt: currentCapture.evidence.captured_at }],
        }] };
      }
      async function signalCount(watchId) {
        const result = await db.query('SELECT count(*)::int AS count FROM astra.radar_signals WHERE tenant_id=$1 AND watch_id=$2', [actor.tenantId, watchId]);
        return result.rows[0]?.count || 0;
      }

      // These adjacent PostgreSQL microsecond timestamps collapse to one JavaScript millisecond.
      // The later audit is inserted before Radar runs but must not hide the real prior 1 -> 2 delta.
      const futureUrl = `https://radar-future-${suffix}.example.test/`;
      const prior = await capture(db, actor, futureUrl, '<h1>Prior</h1><p>one@fixture.example.test</p>');
      const current = await capture(db, actor, futureUrl, '<h1>Current</h1><p>one@fixture.example.test two@fixture.example.test</p>');
      const later = await capture(db, actor, futureUrl, '<h1>Later</h1><p>three@fixture.example.test four@fixture.example.test</p>');
      const futureAccountId = current.account.id;
      const priorId = await insertAudit(db, futureAccountId, prior, '2098-05-01T00:00:00.123455Z', 1);
      const currentId = await insertAudit(db, futureAccountId, current, '2098-05-01T00:00:00.123456Z', 2);
      await insertAudit(db, futureAccountId, later, '2098-05-01T00:00:00.123457Z', 2);
      const futureWatchId = await watch(prior);
      const futureResult = await recordAstraXrayRadarDiffs(db, actor, report(futureAccountId, new URL(futureUrl).hostname, currentId, current, 2));
      assert.ok(futureResult.created >= 1, 'a future audit cannot mask a measurable change from the unique earlier baseline');
      const futureSignals = await db.query('SELECT provenance FROM astra.radar_signals WHERE tenant_id=$1 AND watch_id=$2', [actor.tenantId, futureWatchId]);
      assert.ok(futureSignals.rows.some(row => row.provenance.priorAuditId === priorId
        && row.provenance.priorValue === 1 && row.provenance.currentValue === 2));

      const tiedUrl = `https://radar-tied-${suffix}.example.test/`;
      const tiedPrior = await capture(db, actor, tiedUrl, '<h1>Tied prior</h1><p>one@fixture.example.test</p>');
      const tiedCurrent = await capture(db, actor, tiedUrl, '<h1>Tied current</h1><p>two@fixture.example.test</p>');
      const tiedAccountId = tiedCurrent.account.id;
      await insertAudit(db, tiedAccountId, tiedPrior, '2098-05-02T00:00:00.654321Z', 1);
      await insertAudit(db, tiedAccountId, tiedPrior, '2098-05-02T00:00:00.654321Z', 1);
      const tiedCurrentId = await insertAudit(db, tiedAccountId, tiedCurrent, '2098-05-02T00:00:00.654322Z', 2);
      const tiedWatchId = await watch(tiedPrior);
      const tiedResult = await recordAstraXrayRadarDiffs(db, actor, report(tiedAccountId, new URL(tiedUrl).hostname, tiedCurrentId, tiedCurrent, 2));
      assert.equal(tiedResult.created, 0);
      assert.equal(tiedResult.reason, 'baseline_ambiguous', 'tied latest prior audits fail closed instead of using UUID order');
      assert.equal(await signalCount(tiedWatchId), 0);

      const foreignAccountUrl = `https://radar-foreign-account-${suffix}.example.test/`;
      const foreignAccountPrior = await capture(db, actor, foreignAccountUrl, '<h1>Other account</h1><p>one@fixture.example.test</p>');
      const targetCurrent = await capture(db, actor, `https://radar-target-${suffix}.example.test/`, '<h1>Target</h1><p>two@fixture.example.test</p>');
      const targetAccountId = targetCurrent.account.id;
      await insertAudit(db, foreignAccountPrior.account.id, foreignAccountPrior, '2098-05-03T00:00:00.000001Z', 1);
      const targetCurrentId = await insertAudit(db, targetAccountId, targetCurrent, '2098-05-03T00:00:00.000002Z', 2);
      const targetWatchId = await watch(targetCurrent);
      const foreignAccountResult = await recordAstraXrayRadarDiffs(db, actor,
        report(targetAccountId, new URL(targetCurrent.evidence.sourceUrl).hostname, targetCurrentId, targetCurrent, 2));
      assert.equal(foreignAccountResult.created, 0);
      assert.equal(foreignAccountResult.reason, 'baseline_required', 'another same-tenant account cannot supply this account baseline');
      assert.equal(await signalCount(targetWatchId), 0);

      const foreignTenantUrl = `https://radar-foreign-tenant-${suffix}.example.test/`;
      const tenantCurrent = await capture(db, actor, foreignTenantUrl, '<h1>Tenant local</h1><p>two@fixture.example.test</p>');
      const tenantAccountId = tenantCurrent.account.id;
      const tenantCurrentId = await insertAudit(db, tenantAccountId, tenantCurrent, '2098-05-04T00:00:00.000002Z', 2);
      const foreignTenantCapture = await store.withTenant({ tenantId: foreignTenant.tenantId, userId: foreignUserId }, async (foreignDb, foreignActor) => {
        const captureResult = await capture(foreignDb, foreignActor, foreignTenantUrl, '<h1>Foreign tenant</h1><p>one@fixture.example.test</p>');
        await foreignDb.query(`INSERT INTO astra.research_audits(tenant_id,id,evidence_id,audit_version,coverage_status,findings,created_at)
          VALUES($1,$2,$3,'astra-business-xray/1.0.0','partial',$4::jsonb,'2098-05-04T00:00:00.000001Z'::timestamptz)`,
        [foreignActor.tenantId, randomUUID(), captureResult.evidence.id, JSON.stringify(metadata(tenantAccountId, captureResult, 1))]);
        return captureResult;
      });
      assert.ok(foreignTenantCapture.evidence.id);
      const tenantWatchId = await watch(tenantCurrent);
      const foreignTenantResult = await recordAstraXrayRadarDiffs(db, actor,
        report(tenantAccountId, new URL(foreignTenantUrl).hostname, tenantCurrentId, tenantCurrent, 2));
      assert.equal(foreignTenantResult.created, 0);
      assert.equal(foreignTenantResult.reason, 'baseline_required', 'another tenant cannot supply this account baseline');
      assert.equal(await signalCount(tenantWatchId), 0);
    });
  } finally {
    await store.close();
  }
});

