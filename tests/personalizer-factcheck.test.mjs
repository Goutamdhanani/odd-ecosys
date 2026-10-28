import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-factcheck-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const { getPersonalizationProviderStatus, personalizeBatch } = await import('../pipeline/personalizer.js');
const { getCampaignRecipientPolicy, getQueueEligibleCampaignRecipients } = await import('../pipeline/campaign-audience.js');
const originalFetch = globalThis.fetch;
const fetchAttempts = [];
globalThis.fetch = (...args) => {
  fetchAttempts.push(args);
  return Promise.reject(new Error('Legacy personalization must not reach a provider transport'));
};

after(async () => {
  globalThis.fetch = originalFetch;
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('B07: unavailable tenant gateway yields unapproved drafts and blocks campaign eligibility without Ollama egress', async () => {
  assert.deepEqual(getPersonalizationProviderStatus(), {
    provider: 'glm-5.3-api', model: 'GLM-5.3', status: 'tenant_gateway_required',
    egressEnabled: false, credentials: 'not_checked',
  });

  const batchId = db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Synthetic fact check','P05','open')").run().lastInsertRowid;
  db.prepare("INSERT INTO leads(id,batch_id,business_name,category,email,status) VALUES (1,?,'Prior synthetic contact','Fixture','prior@example.test','queued')").run(batchId);
  for (let i = 0; i < 20; i++) {
    db.prepare(`INSERT INTO personalizations(lead_id,subject_line,body_text,approved,guardrail_passed,fact_check_passed,fact_check_status)
      VALUES (1,'Prior subject','Prior body',1,1,1,'passed')`).run();
  }
  db.prepare(`INSERT INTO leads(id,batch_id,business_name,category,email,city,site_status,status)
    VALUES (2,?,'Synthetic contact','Fixture','contact@example.test','Test City','NO_SITE','verified')`).run(batchId);
  db.prepare(`INSERT INTO lead_emails(lead_id,email,verification_status,is_primary)
    VALUES (2,'contact@example.test','deliverable',1)`).run();

  const result = await personalizeBatch(batchId, { limit: 1 });
  assert.equal(result.processed, 1);
  assert.equal(fetchAttempts.length, 0, 'draft, polish, and fact-check legacy paths make no provider/network call');

  const copies = db.prepare('SELECT guardrail_passed,fact_check_passed,fact_check_status,approved FROM personalizations WHERE lead_id=2 ORDER BY id').all();
  assert.equal(copies.length, 2);
  assert.ok(copies.every(copy => copy.guardrail_passed === 1), 'deterministic fallback drafts still pass rule guardrails');
  assert.ok(copies.every(copy => copy.fact_check_passed === 0 && copy.fact_check_status === 'unavailable' && copy.approved === 0));
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=2').get().status, 'awaiting_approval',
    'an unavailable check cannot leave the lead looking queued');

  const campaignId = db.prepare("INSERT INTO campaigns(name) VALUES ('Synthetic fact-check campaign')").run().lastInsertRowid;
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,2)').run(campaignId);
  const policy = getCampaignRecipientPolicy(campaignId, 2);
  assert.equal(policy.eligibility, 'approval_required');
  assert.deepEqual(getQueueEligibleCampaignRecipients(campaignId), [], 'campaign queue selection excludes every unchecked copy');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=? AND lead_id=2').get(campaignId).count, 0);
});
