// ============================================================
//  ODD-ECOSYS Pipeline — Test Data Seeder
//  Seeds the SQLite database with realistic test data
//  Matches the CRM dashboard mock data format
// ============================================================

import { getDb, initDb } from './database.js';
import { createBatch, updateBatchLeadCount } from './batch-manager.js';
import { normalizeDomain, normalizePhone } from './dedup.js';

/**
 * Seed the database with realistic test data.
 * Safe to run multiple times — checks for existing data.
 */
export function seedDatabase() {
  const db = initDb();

  // Check if already seeded
  const existing = db.prepare('SELECT COUNT(*) as count FROM leads').get();
  if (existing.count > 0) {
    console.log(`⚠️  Database already has ${existing.count} leads. Skipping seed.`);
    console.log('   Delete data/pipeline.db to re-seed from scratch.\n');
    return;
  }

  console.log('🌱 Seeding database...\n');

  // ── Create batches ──────────────────────────────────────────
  const batches = [
    { name: 'Dentists — Austin TX', phase: 'sending', status: 'closed', lead_count: 0 },
    { name: 'Plumbers — Leeds UK', phase: 'sending', status: 'closed', lead_count: 0 },
    { name: 'Roofers — Dallas TX', phase: 'qualification', status: 'processing', lead_count: 0 },
    { name: 'Salons — Chicago IL', phase: 'discovery', status: 'open', lead_count: 0 },
    { name: 'HVAC — Phoenix AZ', phase: 'sending', status: 'processing', lead_count: 0 },
  ];

  const insertBatch = db.prepare(`
    INSERT INTO batches (name, phase, status, lead_count, opened_at, closed_at)
    VALUES (?, ?, ?, 0, datetime('now', ?), ?)
  `);

  const batchIds = [];
  const batchOffsets = ['-21 days', '-14 days', '-5 days', '-1 days', '-8 days'];
  const batchClosed = [
    "datetime('now', '-7 days')", null, null, null, null,
  ];

  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    const result = insertBatch.run(b.name, b.phase, b.status, batchOffsets[i], i === 0 ? new Date(Date.now() - 7 * 86400000).toISOString() : null);
    batchIds.push(result.lastInsertRowid);
    console.log(`   📦 Batch #${result.lastInsertRowid}: ${b.name}`);
  }

  // ── Create leads ────────────────────────────────────────────
  const leads = [
    // Batch 4: Salons — Chicago IL (discovered)
    { batch_idx: 3, business_name: 'Glamour Touch Salon', category: 'Hair Salon', city: 'Chicago', country: 'US', website_url: null, facebook_url: 'https://facebook.com/glamourtouchsalon', site_status: 'NO_SITE', fb_active: 1, status: 'discovered', email: null, rating: 4.2, reviews: 78 },
    { batch_idx: 3, business_name: 'Bella Hair Studio', category: 'Hair Salon', city: 'Chicago', country: 'US', website_url: 'bellahairstudio.com', facebook_url: null, site_status: null, fb_active: null, status: 'discovered', email: null, rating: 3.9, reviews: 42 },
    { batch_idx: 3, business_name: 'Style & Grace', category: 'Beauty Salon', city: 'Chicago', country: 'US', website_url: 'styleandgrace.net', facebook_url: null, site_status: null, fb_active: null, status: 'discovered', email: null, rating: 4.7, reviews: 203 },
    { batch_idx: 3, business_name: 'Urban Cuts Chicago', category: 'Barber Shop', city: 'Chicago', country: 'US', website_url: 'urbancutschicago.com', facebook_url: 'https://facebook.com/urbancuts', site_status: null, fb_active: null, status: 'discovered', email: null, rating: 4.5, reviews: 156 },
    { batch_idx: 3, business_name: 'Lux Beauty Lounge', category: 'Beauty Salon', city: 'Chicago', country: 'US', website_url: null, facebook_url: 'https://facebook.com/luxbeautychi', site_status: 'NO_SITE', fb_active: 1, status: 'discovered', email: null, rating: 4.3, reviews: 91 },

    // Batch 3: Roofers — Dallas TX (qualification phase)
    { batch_idx: 2, business_name: 'Peak Roofing Co', category: 'Roofing', city: 'Dallas', country: 'US', website_url: 'peakroofingco.com', facebook_url: 'https://facebook.com/peakroofingco', site_status: 'OUTDATED', site_score: 3, fb_active: 0, status: 'site_checked', email: null, rating: 4.5, reviews: 134 },
    { batch_idx: 2, business_name: 'Skyline Roofing & Repair', category: 'Roofing', city: 'Dallas', country: 'US', website_url: null, facebook_url: 'https://facebook.com/skylineroofingdtx', site_status: 'NO_SITE', fb_active: 1, status: 'site_checked', email: null, rating: 4.1, reviews: 56 },
    { batch_idx: 2, business_name: 'DFW Pro Roofing', category: 'Roofing', city: 'Irving', country: 'US', website_url: 'dfwproroofing.com', facebook_url: null, site_status: 'MODERN', site_score: 8, fb_active: null, status: 'disqualified', email: null, rating: 4.8, reviews: 310, disqualification_reason: 'modern_site' },
    { batch_idx: 2, business_name: 'Texas Top Roofing', category: 'Roofing', city: 'Dallas', country: 'US', website_url: 'texastoproofing.net', facebook_url: null, site_status: 'DEAD_SITE', fb_active: null, status: 'verifying', email: 'info@texastoproofing.net', rating: 3.8, reviews: 29 },
    { batch_idx: 2, business_name: 'Lone Star Roof Repair', category: 'Roofing', city: 'Plano', country: 'US', website_url: 'lonestarroof.com', facebook_url: null, site_status: 'OUTDATED', site_score: 4, fb_active: null, status: 'site_checked', email: 'info@lonestarroof.com', rating: 4.0, reviews: 67 },

    // Batch 5: HVAC — Phoenix AZ (sending phase)
    { batch_idx: 4, business_name: 'Cool Air HVAC Services', category: 'HVAC', city: 'Phoenix', country: 'US', website_url: 'coolair-hvac.com', facebook_url: 'https://facebook.com/coolair', site_status: 'OUTDATED', site_score: 2, fb_active: 1, status: 'awaiting_approval', email: 'mike@coolair-hvac.com', rating: 4.6, reviews: 187 },
    { batch_idx: 4, business_name: 'Desert Breeze HVAC', category: 'HVAC', city: 'Scottsdale', country: 'US', website_url: null, facebook_url: 'https://facebook.com/desertbreezehvac', site_status: 'NO_SITE', fb_active: 1, status: 'awaiting_approval', email: 'info@desertbreezehvac.com', rating: 4.3, reviews: 97 },
    { batch_idx: 4, business_name: 'Sun Valley Air', category: 'HVAC', city: 'Mesa', country: 'US', website_url: 'sunvalleyair.net', facebook_url: null, site_status: 'OUTDATED', site_score: 3, fb_active: null, status: 'queued', email: 'contact@sunvalleyair.net', rating: 4.0, reviews: 63 },
    { batch_idx: 4, business_name: 'Arctic Comfort Solutions', category: 'HVAC', city: 'Tempe', country: 'US', website_url: 'arcticcomfort.co', facebook_url: 'https://facebook.com/arcticcomforttx', site_status: 'OUTDATED', site_score: 4, fb_active: 0, status: 'queued', email: 'hello@arcticcomfort.co', rating: 4.4, reviews: 142 },
    { batch_idx: 4, business_name: 'Oasis Cooling & Heating', category: 'HVAC', city: 'Chandler', country: 'US', website_url: 'oasiscooling.com', facebook_url: 'https://facebook.com/oasiscooling', site_status: 'OUTDATED', site_score: 2, fb_active: 1, status: 'sent', email: 'dave@oasiscooling.com', rating: 4.8, reviews: 412 },
    { batch_idx: 4, business_name: 'Phoenix Air Masters', category: 'HVAC', city: 'Phoenix', country: 'US', website_url: 'phoenixairmasters.biz', facebook_url: null, site_status: 'DEAD_SITE', fb_active: null, status: 'sent', email: 'office@phoenixairmasters.biz', rating: 3.9, reviews: 44 },
    { batch_idx: 4, business_name: 'Reliable HVAC Phoenix', category: 'HVAC', city: 'Phoenix', country: 'US', website_url: null, facebook_url: 'https://facebook.com/reliablehvacaz', site_status: 'NO_SITE', fb_active: 1, status: 'replied', email: 'bob@reliablehvac.net', rating: 4.5, reviews: 217 },

    // Batch 1: Dentists — Austin TX (completed)
    { batch_idx: 0, business_name: 'Austin Dental Group', category: 'Dentist', city: 'Austin', country: 'US', website_url: 'austindentalgroup.net', facebook_url: 'https://facebook.com/austindentalgroup', site_status: 'OUTDATED', site_score: 2, fb_active: 1, status: 'won', email: 'admin@austindentalgroup.net', rating: 4.9, reviews: 511 },
    { batch_idx: 0, business_name: 'Smile Bright Dentistry', category: 'Dentist', city: 'Austin', country: 'US', website_url: null, facebook_url: 'https://facebook.com/smilebrightaustin', site_status: 'NO_SITE', fb_active: 1, status: 'won', email: 'dr.chen@smilebrightaustin.com', rating: 4.7, reviews: 430 },

    // Batch 2: Plumbers — Leeds UK
    { batch_idx: 1, business_name: 'Yorkshire Plumbing', category: 'Plumbing', city: 'Leeds', country: 'UK', website_url: 'yorkshireplumbing.co.uk', facebook_url: null, site_status: 'OUTDATED', site_score: 2, fb_active: null, status: 'replied', email: 'info@yorkshireplumbing.co.uk', rating: 4.2, reviews: 89 },
    { batch_idx: 1, business_name: 'Leeds Pro Plumbers Ltd', category: 'Plumbing', city: 'Leeds', country: 'UK', website_url: 'leedsproplumbers.co.uk', facebook_url: null, site_status: 'MODERN', site_score: 9, fb_active: null, status: 'disqualified', email: null, rating: 4.6, reviews: 178, disqualification_reason: 'modern_site' },
  ];

  const insertLead = db.prepare(`
    INSERT INTO leads (
      batch_id, business_name, category, city, country,
      website_url, facebook_url, email, source, site_status,
      site_score, fb_active, status, disqualification_reason,
      rating, reviews, normalized_domain, normalized_phone,
      discovered_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, 'google_maps', ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      datetime('now'), datetime('now')
    )
  `);

  const insertEmail = db.prepare(`
    INSERT INTO lead_emails (lead_id, email, source, verification_status)
    VALUES (?, ?, 'scraper', ?)
  `);

  const insertAll = db.transaction(() => {
    for (const lead of leads) {
      const batchId = batchIds[lead.batch_idx];
      const result = insertLead.run(
        batchId,
        lead.business_name,
        lead.category,
        lead.city,
        lead.country,
        lead.website_url,
        lead.facebook_url,
        lead.email,
        lead.site_status,
        lead.site_score || null,
        lead.fb_active,
        lead.status,
        lead.disqualification_reason || null,
        lead.rating,
        lead.reviews,
        normalizeDomain(lead.website_url),
        normalizePhone(null),
      );

      if (lead.email) {
        const verStatus = ['won', 'sent', 'replied', 'queued', 'awaiting_approval'].includes(lead.status)
          ? 'deliverable'
          : null;
        insertEmail.run(result.lastInsertRowid, lead.email, verStatus);
      }
    }
  });

  insertAll();

  // Update batch lead counts
  for (const batchId of batchIds) {
    updateBatchLeadCount(batchId);
  }

  // ── Seed suppression list ──────────────────────────────────
  const insertSuppression = db.prepare(`
    INSERT OR IGNORE INTO suppression_list (email, reason, added_at)
    VALUES (?, ?, datetime('now', ?))
  `);

  insertSuppression.run('unsubscribe@example.com', 'unsubscribed', '-2 days');
  insertSuppression.run('bounce@oldsite.net', 'hard_bounce', '-4 days');
  insertSuppression.run('complaint@mail.co.uk', 'complaint', '-6 days');

  // ── Summary ─────────────────────────────────────────────────
  const totalLeads = db.prepare('SELECT COUNT(*) as count FROM leads').get().count;
  const totalBatches = db.prepare('SELECT COUNT(*) as count FROM batches').get().count;
  const totalEmails = db.prepare('SELECT COUNT(*) as count FROM lead_emails').get().count;
  const totalSuppressed = db.prepare('SELECT COUNT(*) as count FROM suppression_list').get().count;

  console.log(`\n   ✅ Seeded:`);
  console.log(`      ${totalBatches} batches`);
  console.log(`      ${totalLeads} leads`);
  console.log(`      ${totalEmails} lead emails`);
  console.log(`      ${totalSuppressed} suppressed emails`);
}
