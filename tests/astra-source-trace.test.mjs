import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'astra-s00-trace-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.sqlite');
process.env.NODE_ENV = 'test';
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = 'c'.repeat(64);
delete process.env.TWENTY_API_URL;
delete process.env.TWENTY_API_TOKEN;

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const { createContact } = await import('../pipeline/contact-manager.js');
const { scoreQualificationSignals, createQualificationScoringManager } = await import('../pipeline/qualification-scoring.js');
const { createCampaign, updateCampaignDraft } = await import('../pipeline/sending-engine.js');
const { enrollContactsInCampaign } = await import('../pipeline/campaign-audience.js');
const { ingestInboundReply } = await import('../pipeline/reply-tracker.js');
const { syncLeadToCRM } = await import('../pipeline/crm-sync.js');
const { createOffer, approveOfferVersion, validateOfferVersionForUse } = await import('../pipeline/offer-contracts.js');
const { createWebsiteEmailDiscovery } = await import('../pipeline/website-email-discovery.js');
const { createWebsiteDiscoveryJobs } = await import('../pipeline/website-discovery-jobs.js');
const { createSearxngSearchManager } = await import('../pipeline/searxng-search.js');
const { createLeadDiscoveryJobs } = await import('../pipeline/lead-discovery-jobs.js');
const { registerOfferProof, linkOfferProof } = await import('../pipeline/offer-proof-store.js');

function json(data) { return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); }
const discovery = createWebsiteEmailDiscovery({
  db,
  fetchImpl: async input => {
    const url = new URL(input);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /');
    return new Response('<html><body>Contact <a href="mailto:contact@machine-shop.example.test">contact@machine-shop.example.test</a></body></html>', {
      headers: { 'content-type': 'text/html' },
    });
  },
  minimumRequestIntervalMs: 0,
  wait: async () => {},
});
const websiteJobs = createWebsiteDiscoveryJobs({
  db, discovery, createContact,
  schedule: callback => setImmediate(callback),
  verifyCandidate: async emailId => {
    db.prepare("UPDATE lead_emails SET verification_status='deliverable',verified_at=datetime('now') WHERE id=?").run(emailId);
    return { verification_status: 'deliverable' };
  },
});
const search = createSearxngSearchManager({
  db,
  websiteDiscoveryJobs: websiteJobs,
  fetcher: async input => {
    const url = new URL(input);
    if (url.searchParams.has('q')) return json({ results: [
      { title: 'Astra Synthetic Machine Shop', url: 'https://machine-shop.example.test/contact', content: 'Synthetic manufacturing account in Jaipur' },
    ] });
    return json({ results: [] });
  },
  now: () => Date.now(),
});
search.saveConfiguration({ endpoint_url: 'https://search.fixture.test' }, { id: 1, role: 'owner' });
const leadDiscovery = createLeadDiscoveryJobs({
  db, leadSearch: search, websiteDiscoveryJobs: websiteJobs,
  now: () => Date.now(), schedule: callback => setImmediate(callback),
});

after(() => {
  leadDiscovery.close();
  websiteJobs.close();
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

test('S00-03 / S00-B01: synthetic account reaches real qualification, campaign intent, reply handling, then stops at unknown CRM outcome', async () => {
  const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('S00 synthetic trace','discovery','open')").run().lastInsertRowid);
  const job = leadDiscovery.createJob({ batch_id: batchId, country: 'India', state: 'Rajasthan', cities: ['Jaipur'],
    niches: ['machine shop'], target_email_count: 1, max_businesses: 1, max_pages_per_query: 1 }, { id: 1, role: 'operator' });
  const deadline = Date.now() + 8000;
  let completed;
  while (Date.now() < deadline) {
    completed = leadDiscovery.getJob(job.id);
    if (['completed', 'partial', 'blocked', 'failed', 'cancelled'].includes(completed.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(completed.status, 'completed', JSON.stringify({ status: completed.status, error: completed.error_code }));
  const discovered = db.prepare('SELECT * FROM leads WHERE batch_id=? ORDER BY id LIMIT 1').get(batchId);
  assert.ok(discovered, 'actual discovery coordinator persisted a synthetic account/contact');
  const leadId = discovered.id;
  const storedEvidence = db.prepare('SELECT source_url,raw_excerpt,content_hash FROM lead_profile_source_evidence WHERE lead_id=?').get(leadId);
  assert.ok(storedEvidence?.source_url?.startsWith('https://machine-shop.example.test/'));
  assert.ok(storedEvidence?.content_hash, 'website evidence is persisted by the real discovery modules');

  const scoring = createQualificationScoringManager(db);
  const profile = scoring.getProfile();
  const qualification = scoreQualificationSignals({ ssl_valid: true, viewport_meta: true, mobile_responsive: true }, profile);
  assert.ok(['MODERN', 'OUTDATED'].includes(qualification.site_status));
  assert.ok(Number.isInteger(qualification.site_score));
  assert.notEqual(qualification.scoring.providerEvidence, 'real_provider');

  const owner = { id: 1, role: 'owner', tenantId: '98387fbb-0e5a-4657-a435-61b32989291a' };
  const proofBytes = Buffer.from('Synthetic source trace proof bytes only.');
  const proofHash = createHash('sha256').update(proofBytes).digest('hex');
  const approvedOffer = createOffer(db, { name: 'Synthetic site audit', content: {
    service: 'Synthetic site audit', scope: 'One synthetic diagnostic review.',
    price: { minMinor: 10000, maxMinor: 50000, currency: 'INR' },
    proofAssets: [{ proofId: 'synthetic-proof', reference: 'fixture://synthetic/proof', contentHash: proofHash,
      observedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2035-01-01T00:00:00.000Z', rightsBasis: 'Synthetic fixture grant' }],
    audienceExclusions: [], geography: { includedCountries: ['IN'], excludedCountries: [] }, capacity: 1,
    egress: { mode: 'NO_MODEL_EGRESS', allowedDestinations: [] },
  } }, owner);
  const storedProof = registerOfferProof(db, owner, { bytes: proofBytes, mimeType: 'text/plain',
    expiresAt: '2035-01-01T00:00:00.000Z', contentHash: proofHash });
  linkOfferProof(db, owner, { offerVersionId: approvedOffer.version.id, proofId: 'synthetic-proof', objectId: storedProof.id });
  approveOfferVersion(db, approvedOffer.id, approvedOffer.version.id, owner);
  assert.equal(validateOfferVersionForUse(db, approvedOffer.version.id).ok, true);
  const campaign = createCampaign({ name: 'S00 synthetic campaign intent' });
  updateCampaignDraft(campaign.id, { name: campaign.name, offerVersionId: approvedOffer.version.id });
  const enrollment = enrollContactsInCampaign(campaign.id, [leadId]);
  assert.equal(enrollment.added, 1);
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id=?').get(campaign.id).status, 'draft');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends WHERE campaign_id=?').get(campaign.id).n, 0,
    'campaign intent is recorded without dispatching any message');

  // Synthetic transport evidence is seeded explicitly; this does not assert an SMTP call or delivery.
  const sendId = Number(db.prepare(`INSERT INTO sends(lead_id,campaign_id,status,sent_at)
    VALUES(?,?,'sent',datetime('now'))`).run(leadId, campaign.id).lastInsertRowid);
  db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
    VALUES(?,?,'sent',datetime('now'),?)`).run(sendId, leadId, JSON.stringify({
    messageId: '<synthetic-outbound@fixture.test>', to: 'contact@machine-shop.example.test',
    evidenceCategory: 'synthetic_fixture_only', delivery: 'unknown',
  }));
  const reply = await ingestInboundReply({
    fromEmail: 'contact@machine-shop.example.test', toMailboxEmail: 'sender@fixture.test',
    subject: 'Re: synthetic campaign', body: 'Please unsubscribe me.',
    messageId: '<synthetic-reply@fixture.test>', inReplyTo: '<synthetic-outbound@fixture.test>',
  });
  assert.equal(reply.sentiment, 'unsubscribe_request');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(leadId).status, 'disqualified');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM suppression_list WHERE email=?').get('contact@machine-shop.example.test').n, 1);

  const crm = await syncLeadToCRM(leadId);
  assert.equal(crm.status, 'not_configured');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads WHERE id=? AND crm_remote_id IS NOT NULL').get(leadId).n, 0);
  const outcomes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%outcome%'").all();
  assert.deepEqual(outcomes, [], 'no canonical booked/held/won/paid/refunded outcome ledger is present');
});
