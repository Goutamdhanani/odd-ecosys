// ============================================================
//  ODD-ECOSYS Pipeline — Lead Discovery Orchestrator
//  Authorized-source discovery and CSV import orchestration
// ============================================================

import { getDb, initDb } from './database.js';
import { createBatch, updateBatchLeadCount, startProcessingBatch, getBatchStats } from './batch-manager.js';
import { deduplicateLeads, normalizeDomain, normalizePhone } from './dedup.js';
import { importFromCsv } from './csv-importer.js';

/**
 * The previous default source copied Google Maps listings using an unofficial
 * scraper. Keep discovery fail-closed until an authorized source provider is
 * configured. Use importLeads for operator-supplied data they are allowed to use.
 * @param {object} _config
 * @returns {Promise<never>}
 */
export async function discoverLeads(_config) {
  throw new Error(
    'Automated Google Maps scraping is disabled. Import a contact CSV from a source you are authorized to use; approved source connectors can be configured separately.'
  );
}

/**
 * Import leads from a CSV file through the full pipeline.
 * @param {object} config
 * @param {string} config.csvPath - Path to CSV file
 * @param {string} config.batchName - Name for the batch
 * @param {object} [config.options]
 * @param {boolean} [config.options.skipEnrichment=false]
 * @param {boolean} [config.options.dryRun=false]
 * @returns {Promise<object>}
 */
export async function importLeads(config) {
  const { csvPath, batchName, options = {} } = config;
  const { skipEnrichment = false, dryRun = false } = options;

  const startTime = Date.now();
  console.log('\n' + '═'.repeat(60));
  console.log('  📄 ODD-ECOSYS CSV Lead Import');
  console.log('═'.repeat(60));
  console.log(`  File:  ${csvPath}`);
  console.log(`  Batch: ${batchName}`);
  console.log('═'.repeat(60) + '\n');

  initDb();

  // Parse CSV
  console.log('📄 Step 1/4: Parsing CSV...');
  const { leads: csvLeads, errors, stats: csvStats } = importFromCsv(csvPath);
  console.log(`   Parsed: ${csvStats.valid} valid, ${csvStats.invalid} invalid`);
  if (errors.length > 0) {
    console.log(`   Errors: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ''}`);
  }
  console.log('');

  if (csvLeads.length === 0) {
    console.log('   No valid leads to import.\n');
    return { stats: { parsed: 0, inserted: 0 }, duration: Date.now() - startTime };
  }

  // Create batch
  console.log('📦 Step 2/4: Creating batch...');
  let batch;
  if (!dryRun) {
    batch = createBatch(batchName, 'discovery');
    startProcessingBatch(batch.id);
    console.log(`   Created batch #${batch.id}\n`);
  } else {
    batch = { id: 0 };
    console.log(`   [DRY RUN] Would create batch\n`);
  }

  console.log(skipEnrichment
    ? '⏭️  Step 3/4: Website scans skipped by request.\n'
    : '⏭️  Step 3/4: No automatic website scans during CSV import.\n');

  // Dedup + insert
  console.log('🔄 Step 3.5/4: Deduplicating...');
  const { unique, stats: dedupStats } = deduplicateLeads(csvLeads);
  console.log(`   Unique: ${dedupStats.unique}, Duplicates: ${dedupStats.duplicates}\n`);

  console.log('💾 Step 4/4: Inserting into database...');
  let insertedCount = 0;
  if (!dryRun) {
    insertedCount = insertLeads(unique, batch.id);
    updateBatchLeadCount(batch.id);
    console.log(`   Inserted ${insertedCount} leads\n`);
  } else {
    console.log(`   [DRY RUN] Would insert ${unique.length} leads\n`);
    insertedCount = unique.length;
  }

  const duration = Date.now() - startTime;
  console.log(`✅ Import complete: ${insertedCount} leads in ${(duration / 1000).toFixed(1)}s\n`);

  return {
    batch: dryRun ? null : getBatchStats(batch.id),
    stats: {
      parsed: csvStats.valid,
      unique: dedupStats.unique,
      duplicates: dedupStats.duplicates,
      inserted: insertedCount,
    },
    duration,
  };
}

/**
 * Insert leads into the database, including extra emails in lead_emails.
 * Uses a transaction for atomicity.
 * @param {object[]} leads
 * @param {number} batchId
 * @returns {number} Number of leads inserted
 */
function insertLeads(leads, batchId) {
  const db = getDb();

  const insertLead = db.prepare(`
    INSERT INTO leads (
      batch_id, business_name, category, address, city, state, country,
      phone, website_url, facebook_url, email, source, rating, reviews,
      latitude, longitude, place_id, normalized_domain, normalized_phone,
      status, discovered_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      'discovered', datetime('now'), datetime('now')
    )
  `);

  const insertEmail = db.prepare(`
    INSERT INTO lead_emails (lead_id, email, source)
    VALUES (?, ?, ?)
  `);

  const insertEvent = db.prepare(`
    INSERT INTO events (lead_id, event_type, event_at, meta_json)
    VALUES (?, 'discovered', datetime('now'), ?)
  `);

  let count = 0;

  const insertAll = db.transaction((leadsToInsert) => {
    for (const lead of leadsToInsert) {
      const result = insertLead.run(
        batchId,
        lead.business_name,
        lead.category || null,
        lead.address || null,
        lead.city || null,
        lead.state || null,
        lead.country || null,
        lead.phone || null,
        lead.website_url || null,
        lead.facebook_url || null,
        lead.email || null,
        lead.source || 'google_maps',
        lead.rating || null,
        lead.reviews || null,
        lead.latitude || null,
        lead.longitude || null,
        lead.place_id || null,
        lead.normalized_domain || normalizeDomain(lead.website_url),
        lead.normalized_phone || normalizePhone(lead.phone),
      );

      const leadId = result.lastInsertRowid;

      // Insert primary email into lead_emails too
      if (lead.email) {
        insertEmail.run(leadId, lead.email, lead.source || 'scraper');
      }

      // Insert extra emails
      if (lead._extra_emails) {
        for (const email of lead._extra_emails) {
          insertEmail.run(leadId, email, 'website_enrichment');
        }
      }

      // Log discovery event
      insertEvent.run(leadId, JSON.stringify({ batch_id: batchId }));

      count++;
    }
  });

  insertAll(leads);
  return count;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
