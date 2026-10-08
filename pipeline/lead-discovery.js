// ============================================================
//  ODD-ECOSYS Pipeline — Lead Discovery Orchestrator
//  Ties together: scraper → enrichment → dedup → DB insert
//  This is the main entry point for the discovery pipeline
// ============================================================

import { getDb, initDb } from './database.js';
import { createBatch, updateBatchLeadCount, startProcessingBatch, getBatchStats } from './batch-manager.js';
import { deduplicateLeads, normalizeDomain, normalizePhone } from './dedup.js';
import { generateQueryFile, runScraper, isDockerAvailable, ensureDockerImage } from './scraper.js';
import { enrichLeadsBatch } from './enricher.js';
import { importFromCsv } from './csv-importer.js';

/**
 * Run the full lead discovery pipeline.
 * @param {object} config
 * @param {string} config.niche - Business category (e.g. "dentists")
 * @param {string} config.geography - Location (e.g. "Austin TX")
 * @param {object} [config.options]
 * @param {number} [config.options.limit] - Max leads to process
 * @param {boolean} [config.options.skipEnrichment=false] - Skip website crawling
 * @param {boolean} [config.options.dryRun=false] - Don't write to DB
 * @param {number} [config.options.scraperDepth=1] - Scraper depth
 * @returns {Promise<object>} Pipeline run summary
 */
export async function discoverLeads(config) {
  const { niche, geography, options = {} } = config;
  const { limit, skipEnrichment = false, dryRun = false, scraperDepth = 1 } = options;

  const startTime = Date.now();
  console.log('\n' + '═'.repeat(60));
  console.log('  🚀 ODD-ECOSYS Lead Discovery Pipeline');
  console.log('═'.repeat(60));
  console.log(`  Niche:     ${niche}`);
  console.log(`  Geography: ${geography}`);
  console.log(`  Limit:     ${limit || 'none'}`);
  console.log(`  Dry run:   ${dryRun}`);
  console.log('═'.repeat(60) + '\n');

  // Initialize database
  initDb();

  // Step 1: Create batch
  console.log('📦 Step 1/5: Creating batch...');
  const batchName = `${capitalize(niche)} — ${geography}`;
  let batch;
  if (!dryRun) {
    batch = createBatch(batchName, 'discovery');
    startProcessingBatch(batch.id);
    console.log(`   Created batch #${batch.id}: "${batchName}"\n`);
  } else {
    batch = { id: 0, name: batchName };
    console.log(`   [DRY RUN] Would create batch: "${batchName}"\n`);
  }

  // Step 2: Scrape leads from Google Maps
  console.log('🔍 Step 2/5: Discovering leads...');
  let rawLeads = [];

  const dockerAvailable = await isDockerAvailable();
  if (dockerAvailable) {
    await ensureDockerImage();
    const queryFile = generateQueryFile(niche, geography);
    rawLeads = await runScraper(queryFile, { depth: scraperDepth });
  } else {
    console.log('   ⚠️  Docker not available. Skipping Google Maps scraper.');
    console.log('   💡 Use CSV import instead: node pipeline/cli.js import --csv <file>\n');
  }

  if (rawLeads.length === 0) {
    console.log('   No leads found from scraper. Pipeline complete (empty batch).\n');
    return {
      batch,
      stats: { scraped: 0, enriched: 0, unique: 0, inserted: 0, duplicates: 0 },
      duration: Date.now() - startTime,
    };
  }

  // Apply limit
  if (limit && rawLeads.length > limit) {
    rawLeads = rawLeads.slice(0, limit);
    console.log(`   Applied limit: ${limit} leads\n`);
  }

  console.log(`   Found ${rawLeads.length} raw leads\n`);

  // Step 3: Enrich leads (website crawling)
  let enrichmentResults = new Map();
  if (!skipEnrichment) {
    console.log('🌐 Step 3/5: Enriching leads (crawling websites)...');
    enrichmentResults = await enrichLeadsBatch(rawLeads, {
      concurrency: 3,
      onProgress: (current, total) => {
        // Progress is logged inside enrichLeadsBatch
      },
    });

    // Merge enrichment data back into leads
    for (const [idx, enrichment] of enrichmentResults) {
      const lead = rawLeads[idx];
      if (enrichment.emails.length > 0 && !lead.email) {
        lead.email = enrichment.emails[0];
        lead._extra_emails = [...(lead._extra_emails || []), ...enrichment.emails.slice(1)];
      }
      if (enrichment.facebook_url && !lead.facebook_url) {
        lead.facebook_url = enrichment.facebook_url;
      }
    }

    const enrichedCount = [...enrichmentResults.values()].filter(r => r.emails.length > 0 || r.facebook_url).length;
    console.log(`   Enriched: ${enrichedCount} leads got new data\n`);
  } else {
    console.log('⏭️  Step 3/5: Skipping enrichment (--skip-enrichment flag)\n');
  }

  // Step 4: Deduplicate
  console.log('🔄 Step 4/5: Deduplicating leads...');
  const { unique, duplicates, stats: dedupStats } = deduplicateLeads(rawLeads);
  console.log(`   Total: ${dedupStats.total}, Unique: ${dedupStats.unique}, Duplicates: ${dedupStats.duplicates}`);
  if (dedupStats.within_batch > 0) console.log(`   Within-batch dups: ${dedupStats.within_batch}`);
  if (dedupStats.existing_db > 0) console.log(`   Already in DB: ${dedupStats.existing_db}`);
  console.log('');

  // Step 5: Insert into database
  console.log('💾 Step 5/5: Inserting leads into database...');
  let insertedCount = 0;

  if (!dryRun) {
    insertedCount = insertLeads(unique, batch.id);
    updateBatchLeadCount(batch.id);
    console.log(`   Inserted ${insertedCount} leads into batch #${batch.id}\n`);
  } else {
    console.log(`   [DRY RUN] Would insert ${unique.length} leads\n`);
    insertedCount = unique.length;
  }

  // Summary
  const duration = Date.now() - startTime;
  const summary = {
    batch: dryRun ? null : getBatchStats(batch.id),
    stats: {
      scraped: rawLeads.length,
      enriched: enrichmentResults.size,
      unique: unique.length,
      inserted: insertedCount,
      duplicates: dedupStats.duplicates,
    },
    duration,
  };

  console.log('═'.repeat(60));
  console.log('  ✅ Discovery Pipeline Complete');
  console.log('═'.repeat(60));
  console.log(`  Scraped:    ${summary.stats.scraped} leads`);
  console.log(`  Enriched:   ${summary.stats.enriched} leads`);
  console.log(`  Unique:     ${summary.stats.unique} leads`);
  console.log(`  Inserted:   ${summary.stats.inserted} leads`);
  console.log(`  Duplicates: ${summary.stats.duplicates} skipped`);
  console.log(`  Duration:   ${(duration / 1000).toFixed(1)}s`);
  if (summary.batch) {
    console.log(`  Batch:      #${summary.batch.id} (${summary.batch.lead_count} leads)`);
  }
  console.log('═'.repeat(60) + '\n');

  return summary;
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

  // Enrich
  if (!skipEnrichment) {
    console.log('🌐 Step 3/4: Enriching leads...');
    const enrichmentResults = await enrichLeadsBatch(csvLeads, { concurrency: 3 });

    for (const [idx, enrichment] of enrichmentResults) {
      const lead = csvLeads[idx];
      if (enrichment.emails.length > 0 && !lead.email) {
        lead.email = enrichment.emails[0];
      }
      if (enrichment.facebook_url && !lead.facebook_url) {
        lead.facebook_url = enrichment.facebook_url;
      }
    }
    console.log('');
  }

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
