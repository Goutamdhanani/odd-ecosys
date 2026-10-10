import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-verifier-smooth-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');

const { getDb, initDb, closeDb } = await import('../pipeline/database.js');
const { createBatch } = await import('../pipeline/batch-manager.js');
const { verifyBatch, reverifyEmailById, getVerificationStatus, getVerificationResults, getVerificationDistribution } = await import('../pipeline/email-verifier.js');

after(() => {
  closeDb();
  delete process.env.ODD_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

test('Email Verifier: verifyBatch runs smoothly with prepared statements and sets verified status', async () => {
  initDb();
  const db = getDb();

  // Create a clean test batch
  const batch = createBatch('Smooth Verifier Test Batch', 'test');
  const batchId = batch.id;

  // Insert lead 1: Deliverable / good email
  const lead1Res = db.prepare(`
    INSERT INTO leads (batch_id, business_name, email, status, website_url)
    VALUES (?, ?, ?, 'site_checked', ?)
  `).run(batchId, 'Acme Roofing', 'info@google.com', 'https://google.com');
  const lead1Id = lead1Res.lastInsertRowid;

  // Insert lead 2: Lead with bad primary email but good secondary email
  const lead2Res = db.prepare(`
    INSERT INTO leads (batch_id, business_name, email, status, website_url)
    VALUES (?, ?, ?, 'site_checked', ?)
  `).run(batchId, 'Beta Solar', 'invalid-bad-format', 'https://betasolar.com');
  const lead2Id = lead2Res.lastInsertRowid;

  // Add good secondary email for lead 2 in lead_emails
  db.prepare(`
    INSERT INTO lead_emails (lead_id, email, source, is_primary)
    VALUES (?, ?, 'website_crawl', 0)
  `).run(lead2Id, 'contact@github.com');

  // Insert lead 3: Completely invalid / undeliverable lead
  const lead3Res = db.prepare(`
    INSERT INTO leads (batch_id, business_name, email, status, website_url)
    VALUES (?, ?, ?, 'site_checked', ?)
  `).run(batchId, 'Gamma HVAC', 'fake@mailinator.com', 'https://gamma.com');
  const lead3Id = lead3Res.lastInsertRowid;

  // Track onProgress callbacks
  const progressEvents = [];
  const result = await verifyBatch(batchId, {
    delayMs: 0,
    onProgress: (state) => {
      progressEvents.push({ ...state });
    }
  });

  assert.equal(result.batchId, batchId);
  assert.equal(result.total, 3);
  assert.equal(result.processed, 3);
  assert.ok(progressEvents.length > 0, 'onProgress should be called');

  // Check Lead 1: Should be marked 'verified'
  const lead1 = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead1Id);
  assert.equal(lead1.status, 'verified', 'Lead 1 status should be verified');

  // Check Lead 1 Email in lead_emails
  const lead1Emails = db.prepare('SELECT * FROM lead_emails WHERE lead_id = ?').all(lead1Id);
  assert.ok(lead1Emails.length >= 1, 'Lead 1 should have record in lead_emails');
  assert.equal(lead1Emails[0].is_primary, 1);
  assert.ok(lead1Emails[0].confidence_score > 0, 'Confidence score should be populated');

  // Check Lead 2: Secondary email should have been promoted to primary, status verified!
  const lead2 = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead2Id);
  assert.equal(lead2.status, 'verified', 'Lead 2 should be verified via promoted secondary email');
  assert.equal(lead2.email, 'contact@github.com', 'Secondary email should be promoted to primary');

  // Check Lead 3: Mailinator (disposable) should be disqualified
  const lead3 = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead3Id);
  assert.equal(lead3.status, 'disqualified', 'Lead 3 with disposable email should be disqualified');

  // Check reverifyEmailById
  const lead1EmailId = lead1Emails[0].id;
  const reverifyRes = await reverifyEmailById(lead1EmailId);
  assert.ok(reverifyRes, 'reverifyEmailById should return result');
  assert.ok(['deliverable', 'risky', 'undeliverable'].includes(reverifyRes.verification_status));

  // Check getVerificationResults
  const vr = getVerificationResults(batchId);
  assert.ok(vr.total >= 3, 'Should have verification results for batch');
  assert.ok(Array.isArray(vr.results));

  // Check getVerificationDistribution
  const dist = getVerificationDistribution(batchId);
  assert.ok(Array.isArray(dist), 'Distribution should be an array');
  assert.ok(dist.length > 0, 'Distribution should have counts');
});
