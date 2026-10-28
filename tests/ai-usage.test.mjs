import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-ai-usage-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const { personalizeBatch, getPersonalizationProviderStatus } = await import('../pipeline/personalizer.js');
const { getAiUsageAnalytics } = await import('../pipeline/ai-usage.js');
const { renderAICostHtml } = await import('../js/analytics.js');

const originalFetch = globalThis.fetch;
const providerFetchAttempts = [];
globalThis.fetch = (input) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  providerFetchAttempts.push(`${url.origin}${url.pathname}`);
  return Promise.reject(new Error('Provider egress is blocked in the legacy personalization fixture.'));
};

after(async () => {
  globalThis.fetch = originalFetch;
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

test('B08: legacy personalization is denied model use without the sole-GLM tenant request context', async () => {
  const batchId = db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Synthetic usage batch','P05','open')").run().lastInsertRowid;
  db.prepare(`INSERT INTO leads(id,batch_id,business_name,category,email,city,site_status,status)
    VALUES (1,?,'Synthetic contact','Fixture','contact@example.test','Test City','NO_SITE','verified')`).run(batchId);
  db.prepare(`INSERT INTO lead_emails(lead_id,email,verification_status,is_primary)
    VALUES (1,'contact@example.test','deliverable',1)`).run();

  const providerStatus = getPersonalizationProviderStatus();
  assert.deepEqual({ provider: providerStatus.provider, model: providerStatus.model, status: providerStatus.status,
    egressEnabled: providerStatus.egressEnabled }, {
    provider: 'glm-5.3-api', model: 'GLM-5.3', status: 'tenant_gateway_required', egressEnabled: false,
  });

  const result = await personalizeBatch(batchId, { limit: 1 });
  assert.equal(result.processed, 1);
  assert.equal(providerFetchAttempts.length, 0, 'legacy SQLite personalization has no authorized tenant request or provider transport');
  const rows = db.prepare(`SELECT approved,fact_check_passed,fact_check_status FROM personalizations
    WHERE lead_id=1 ORDER BY subject_variant`).all();
  assert.equal(rows.length, 2, 'template fallback rows remain available for human review');
  assert.ok(rows.every(row => row.approved === 0 && row.fact_check_passed === 0 && row.fact_check_status === 'unavailable'),
    'unavailable tenant GLM context cannot become a passed check or automatic approval');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=1').get().status, 'awaiting_approval');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=1').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_usage_events').get().count, 0,
    'no provider usage is claimed when the legacy path is blocked before inference');

  const report = getAiUsageAnalytics(db);
  assert.equal(report.request_count, 0);
  assert.equal(report.usage_status, 'unknown');
  assert.equal(report.cost_status, 'not_recorded', 'absence of model usage remains unknown, not a zero-cost assertion');
  assert.equal(report.total_tokens, null);
  assert.equal(report.cost_usd, null);

  const markup = renderAICostHtml(report);
  assert.match(markup, /No AI provider requests have been recorded yet/);
  assert.match(markup, /unknown/);
});
