// ============================================================
//  ODD-ECOSYS Pipeline — Lead Discovery Orchestrator
//  Ties together: scraper → enrichment → dedup → DB insert
//  This is the main entry point for the discovery pipeline
// ============================================================

import { getDb, initDb } from './database.js';
import { createBatch, updateBatchLeadCount, startProcessingBatch, getBatchStats } from './batch-manager.js';
import { deduplicateLeads, normalizeDomain, normalizePhone } from './dedup.js';
import { generateQueryFile, runScraper, isDockerAvailable, ensureDockerImage, scrapeLeadsMultiMethod } from './scraper.js';
import { enrichLeadsBatch } from './enricher.js';
import { importFromCsv } from './csv-importer.js';

// ── Discovery run state ───────────────────────────────────────
let _discoveryState = {
  active: false,
  jobId: null,
  batchId: null,
  batchName: null,
  method: 'combined', // 'combined' | 'google_maps' | 'web_search'
  step: 'idle', // 'idle' | 'scraping' | 'enriching' | 'deduping' | 'inserting' | 'qualifying' | 'verifying' | 'done' | 'error' | 'cancelled'
  progress: 0,
  scrapedCount: 0,
  emailsFoundCount: 0,
  insertedCount: 0,
  duplicatesCount: 0,
  qualifiedCount: 0,
  verifiedCount: 0,
  deliverableCount: 0,
  currentQuery: null,
  error: null,
  cancelling: false,
  startedAt: null,
  completedAt: null,
  duration: 0,
  autoQualify: false,
  autoVerify: false,
};

export function getDiscoveryStatus() {
  return { ..._discoveryState };
}

export function cancelDiscovery() {
  if (_discoveryState.active) {
    _discoveryState.cancelling = true;
    return true;
  }
  return false;
}

/**
 * Start a 1-click discovery job in the background.
 */
export async function startDiscoveryJob(config) {
  if (_discoveryState.active) {
    throw new Error('A scraping and lead discovery job is already currently running.');
  }

  const {
    niche,
    geography,
    limit = 25,
    method = 'combined',
    autoQualify = false,
    autoVerify = false,
    deepScan = true,
    filterClosed = true,
    gridSize = 5,
  } = config;
  const batchName = `${capitalize(niche)} — ${geography}`;

  _discoveryState = {
    active: true,
    jobId: Date.now().toString(),
    batchId: null,
    batchName,
    method,
    step: 'scraping',
    progress: 15,
    scrapedCount: 0,
    emailsFoundCount: 0,
    insertedCount: 0,
    duplicatesCount: 0,
    qualifiedCount: 0,
    verifiedCount: 0,
    deliverableCount: 0,
    currentQuery: `${niche} in ${geography}`,
    error: null,
    cancelling: false,
    startedAt: Date.now(),
    completedAt: null,
    duration: 0,
    autoQualify: !!autoQualify,
    autoVerify: !!autoVerify,
  };

  // Launch async pipeline in background
  (async () => {
    try {
      const summary = await discoverLeads({
        niche,
        geography,
        options: { limit, method, deepScan, filterClosed, gridSize },
      });

      if (_discoveryState.cancelling) {
        _discoveryState.active = false;
        _discoveryState.step = 'cancelled';
        return;
      }

      const batchId = summary?.batch?.id;
      if (batchId && (autoQualify || autoVerify)) {
        if (autoQualify && !_discoveryState.cancelling) {
          _discoveryState.step = 'qualifying';
          _discoveryState.progress = 85;
          console.log(`🚀 Step 4/5: Auto-qualifying Batch #${batchId} directly...`);
          const { qualifyBatch } = await import('./qualifier.js');
          await qualifyBatch(batchId);
          try {
            const db = getDb();
            const qualifiedRow = db.prepare("SELECT COUNT(*) as count FROM leads WHERE batch_id = ? AND status = 'qualified'").get(batchId);
            _discoveryState.qualifiedCount = qualifiedRow ? qualifiedRow.count : 0;
          } catch {}
        }

        if (autoVerify && !_discoveryState.cancelling) {
          _discoveryState.step = 'verifying';
          _discoveryState.progress = 92;
          console.log(`🚀 Step 5/5: Auto-verifying emails for Batch #${batchId}...`);
          const { verifyBatch } = await import('./email-verifier.js');
          await verifyBatch(batchId, {
            onProgress: (p) => {
              _discoveryState.verifiedCount = p.processed;
              _discoveryState.deliverableCount = p.deliverable;
            }
          });
          try {
            const db = getDb();
            const verifiedRow = db.prepare("SELECT COUNT(*) as count FROM lead_emails le JOIN leads l ON le.lead_id = l.id WHERE l.batch_id = ?").get(batchId);
            const deliverableRow = db.prepare("SELECT COUNT(*) as count FROM lead_emails le JOIN leads l ON le.lead_id = l.id WHERE l.batch_id = ? AND le.verification_status = 'deliverable'").get(batchId);
            _discoveryState.verifiedCount = verifiedRow ? verifiedRow.count : 0;
            _discoveryState.deliverableCount = deliverableRow ? deliverableRow.count : 0;
          } catch {}
        }
      }

      _discoveryState.active = false;
      _discoveryState.step = 'done';
      _discoveryState.progress = 100;
      _discoveryState.completedAt = Date.now();
      _discoveryState.duration = _discoveryState.completedAt - _discoveryState.startedAt;
    } catch (err) {
      console.error('❌ Lead Discovery job error:', err);
      _discoveryState.active = false;
      _discoveryState.step = 'error';
      _discoveryState.error = err.message;
    }
  })();

  return { started: true, jobId: _discoveryState.jobId, batchName };
}

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
    _discoveryState.batchId = batch.id;
    console.log(`   Created batch #${batch.id}: "${batchName}"\n`);
  } else {
    batch = { id: 0, name: batchName };
    console.log(`   [DRY RUN] Would create batch: "${batchName}"\n`);
  }

  // Step 2: Scrape leads via multi-method scraper
  console.log(`🔍 Step 2/5: Discovering leads via multi-method (${options.method || 'combined'})...`);
  _discoveryState.step = 'scraping';
  _discoveryState.progress = 25;
  let rawLeads = await scrapeLeadsMultiMethod({
    niche,
    geography,
    method: options.method || 'combined',
    limit,
    options: { depth: scraperDepth, ...options },
  });

  if (!rawLeads || rawLeads.length === 0) {
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
  }
  _discoveryState.scrapedCount = rawLeads.length;
  console.log(`   Found ${rawLeads.length} raw leads\n`);

  // Step 3: Enrich leads (website crawling, Cloudflare decode, schema, and DNS MX checks)
  let enrichmentResults = new Map();
  if (!skipEnrichment) {
    console.log('🌐 Step 3/5: Enriching leads (crawling websites & finding emails)...');
    _discoveryState.step = 'enriching';
    _discoveryState.progress = 50;

    enrichmentResults = await enrichLeadsBatch(rawLeads, {
      concurrency: 3,
      onProgress: (current, total) => {
        _discoveryState.progress = 50 + Math.floor((current / total) * 20);
      },
    });

    // Merge enrichment data back into leads
    let totalEmailsFound = 0;
    for (const [idx, enrichment] of enrichmentResults) {
      const lead = rawLeads[idx];
      if (enrichment.emails && enrichment.emails.length > 0) {
        if (!lead.email) lead.email = enrichment.emails[0];
        lead._extra_emails = [...(lead._extra_emails || []), ...enrichment.emails.slice(1)];
        totalEmailsFound += enrichment.emails.length;
      }
      if (enrichment.facebook_url && !lead.facebook_url) {
        lead.facebook_url = enrichment.facebook_url;
      }
    }
    _discoveryState.emailsFoundCount = totalEmailsFound;

    const enrichedCount = [...enrichmentResults.values()].filter(r => r.emails.length > 0 || r.facebook_url).length;
    console.log(`   Enriched: ${enrichedCount} leads got email / social data\n`);
  } else {
    console.log('⏭️  Step 3/5: Skipping enrichment (--skip-enrichment flag)\n');
  }

  // Step 4: Deduplicate
  console.log('🔄 Step 4/5: Deduplicating leads...');
  _discoveryState.step = 'deduping';
  _discoveryState.progress = 75;
  const { unique, duplicates, stats: dedupStats } = deduplicateLeads(rawLeads);
  _discoveryState.duplicatesCount = dedupStats.duplicates;
  console.log(`   Total: ${dedupStats.total}, Unique: ${dedupStats.unique}, Duplicates: ${dedupStats.duplicates}`);
  if (dedupStats.within_batch > 0) console.log(`   Within-batch dups: ${dedupStats.within_batch}`);
  if (dedupStats.existing_db > 0) console.log(`   Already in DB: ${dedupStats.existing_db}`);
  console.log('');

  // Step 5: Insert into database
  console.log('💾 Step 5/5: Inserting leads into database...');
  _discoveryState.step = 'inserting';
  _discoveryState.progress = 85;
  let insertedCount = 0;

  if (!dryRun) {
    insertedCount = insertLeads(unique, batch.id);
    updateBatchLeadCount(batch.id);
    _discoveryState.insertedCount = insertedCount;
    console.log(`   Inserted ${insertedCount} leads into batch #${batch.id}\n`);
  } else {
    console.log(`   [DRY RUN] Would insert ${unique.length} leads\n`);
    insertedCount = unique.length;
    _discoveryState.insertedCount = insertedCount;
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
      booking_url, photo_url, price_level, hours_status, instagram_url, linkedin_url, twitter_url,
      status, discovered_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
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
        lead.booking_url || null,
        lead.photo_url || null,
        lead.price_level || null,
        lead.hours_status || null,
        lead.instagram_url || null,
        lead.linkedin_url || null,
        lead.twitter_url || null,
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
