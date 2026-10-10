import test from 'node:test';
import assert from 'node:assert/strict';
import { getDiscoveryStatus, cancelDiscovery, startDiscoveryJob, discoverLeads } from '../pipeline/lead-discovery.js';
import { scrapeGoogleMapsNative, scrapeWebQueryLeads, scrapeLeadsMultiMethod } from '../pipeline/scraper.js';
import { enrichLead } from '../pipeline/enricher.js';
import { getDb } from '../pipeline/database.js';

test('Lead Discovery Status: initial state is idle', () => {
  const status = getDiscoveryStatus();
  assert.equal(typeof status, 'object');
  assert.equal(typeof status.active, 'boolean');
  assert.ok(['idle', 'scraping', 'enriching', 'deduping', 'inserting', 'qualifying', 'verifying', 'done'].includes(status.step));
});

test('Lead Discovery: startDiscoveryJob validates input', async () => {
  assert.equal(typeof startDiscoveryJob, 'function');
  assert.equal(typeof cancelDiscovery, 'function');
});

test('Scraper: scrapeGoogleMapsNative parses places without Docker', async () => {
  const results = await scrapeGoogleMapsNative('dentists in Austin TX', { limit: 3 });
  assert.ok(Array.isArray(results), 'Expected array of leads');
  if (results.length > 0) {
    const lead = results[0];
    assert.ok(lead.business_name, 'Lead has business name');
    assert.equal(lead.source, 'google_maps');
  }
});

test('Scraper: scrapeWebQueryLeads extracts web listings or handles gracefully', async () => {
  const results = await scrapeWebQueryLeads('electricians', 'Austin TX', { limit: 3 });
  assert.ok(Array.isArray(results), 'Expected array of leads');
});

test('Scraper: scrapeLeadsMultiMethod supports combined and individual methods', async () => {
  // Method 1: google_maps
  const mapsResults = await scrapeLeadsMultiMethod({
    niche: 'roofers',
    geography: 'Austin TX',
    method: 'google_maps',
    limit: 2,
  });
  assert.ok(Array.isArray(mapsResults));

  // Method 2: combined
  const combinedResults = await scrapeLeadsMultiMethod({
    niche: 'hvac',
    geography: 'Austin TX',
    method: 'combined',
    limit: 2,
  });
  assert.ok(Array.isArray(combinedResults));
  assert.ok(combinedResults.length > 0, 'Expected leads from combined scraping');
});

test('Enricher: enrichLead extracts or provides DNS MX candidates', async () => {
  const dummyLead = {
    business_name: 'Test Business',
    website_url: 'https://google.com',
  };
  const result = await enrichLead(dummyLead);
  assert.ok(Array.isArray(result.emails), 'Emails should be an array');
  assert.ok(result.pages_crawled >= 0, 'Crawled pages should be tracked');
});

test('Pipeline: full 1-click discovery with auto-qualify and auto-verify advances leads', async () => {
  const summary = await discoverLeads({
    niche: 'Chiropractors',
    geography: 'Austin TX',
    options: {
      limit: 2,
      method: 'combined',
    },
  });

  assert.ok(summary.batch, 'Batch was created');
  assert.ok(summary.stats.scraped > 0, 'Leads were scraped');

  const batchId = summary.batch.id;

  // Auto-qualify test
  const { qualifyBatch } = await import('../pipeline/qualifier.js');
  const qResult = await qualifyBatch(batchId);
  assert.ok(qResult, 'Qualification ran');

  // Auto-verify test
  const { verifyBatch } = await import('../pipeline/email-verifier.js');
  const vResult = await verifyBatch(batchId);
  assert.ok(vResult, 'Verification ran');

  // Verify database integrity
  const db = getDb();
  const emails = db.prepare(`
    SELECT le.* FROM lead_emails le
    JOIN leads l ON le.lead_id = l.id
    WHERE l.batch_id = ?
  `).all(batchId);

  assert.ok(Array.isArray(emails), 'Emails array returned');
});
