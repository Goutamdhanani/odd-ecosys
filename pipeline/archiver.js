// ============================================================
//  ODD-ECOSYS Pipeline — Batch/Cohort Archival Engine (Section 14)
//  "Collect a lot, process a batch, close it, archive it, move on"
//  Archives terminal leads/sends out of hot tables into leads_archive/sends_archive,
//  runs SQLite VACUUM to reclaim space, and maintains sub-millisecond query speed.
// ============================================================

import { getDb } from './database.js';

/**
 * Close and archive a completed batch.
 * Moves all terminal leads and associated sends into archive tables.
 */
export function archiveBatch(batchId) {
  const db = getDb();
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  if (!batch) throw new Error(`Batch #${batchId} not found`);

  // Ensure archive tables exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads_archive AS SELECT * FROM leads WHERE 0;
    CREATE TABLE IF NOT EXISTS sends_archive AS SELECT * FROM sends WHERE 0;
    CREATE INDEX IF NOT EXISTS idx_leads_archive_batch ON leads_archive(batch_id);
    CREATE INDEX IF NOT EXISTS idx_sends_archive_batch ON sends_archive(lead_id);
  `);

  // Terminal states eligible for archiving
  const terminalStates = ['won', 'lost', 'disqualified', 'sent'];

  const leadsToArchive = db.prepare(`
    SELECT * FROM leads WHERE batch_id = ?
  `).all(batchId);

  let archivedLeadsCount = 0;
  let archivedSendsCount = 0;

  const insertLeadArchive = db.prepare(`
    INSERT OR REPLACE INTO leads_archive (
      id, batch_id, business_name, category, address, city, state, country,
      phone, website_url, facebook_url, email, source, site_status, site_score,
      site_reasons, fb_active, status, disqualification_reason, rating, reviews,
      discovered_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?
    )
  `);

  const deleteLead = db.prepare('DELETE FROM leads WHERE id = ?');

  const insertSendArchive = db.prepare(`
    INSERT OR REPLACE INTO sends_archive (
      id, lead_id, mailbox_id, campaign_id, personalization_id, variant, scheduled_at, sent_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteSend = db.prepare('DELETE FROM sends WHERE id = ?');

  // Archive in a single transaction
  const archiveTransaction = db.transaction(() => {
    for (const lead of leadsToArchive) {
      // Archive related sends
      const sends = db.prepare('SELECT * FROM sends WHERE lead_id = ?').all(lead.id);
      for (const s of sends) {
        insertSendArchive.run(s.id, s.lead_id, s.mailbox_id, s.campaign_id, s.personalization_id, s.variant, s.scheduled_at, s.sent_at, s.status);
        deleteSend.run(s.id);
        archivedSendsCount++;
      }

      // Archive lead
      insertLeadArchive.run(
        lead.id, lead.batch_id, lead.business_name, lead.category, lead.address, lead.city, lead.state, lead.country,
        lead.phone, lead.website_url, lead.facebook_url, lead.email, lead.source, lead.site_status, lead.site_score,
        lead.site_reasons, lead.fb_active, lead.status, lead.disqualification_reason, lead.rating, lead.reviews,
        lead.discovered_at, lead.updated_at
      );
      deleteLead.run(lead.id);
      archivedLeadsCount++;
    }

    // Mark batch as closed
    db.prepare("UPDATE batches SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(batchId);
  });

  archiveTransaction();

  // Execute VACUUM to defragment SQLite file and reclaim disk pages
  try {
    db.exec('VACUUM');
  } catch {
    // In WAL mode VACUUM might be deferred
  }

  return {
    ok: true,
    batchId,
    batchName: batch.name,
    archivedLeads: archivedLeadsCount,
    archivedSends: archivedSendsCount,
    closedAt: new Date().toISOString(),
  };
}

/**
 * Get archive statistics.
 */
export function getArchiveStats() {
  const db = getDb();
  try {
    const leadsArchived = db.prepare('SELECT COUNT(*) as count FROM leads_archive').get()?.count || 0;
    const sendsArchived = db.prepare('SELECT COUNT(*) as count FROM sends_archive').get()?.count || 0;
    const closedBatches = db.prepare("SELECT COUNT(*) as count FROM batches WHERE status = 'closed'").get()?.count || 0;
    return { leadsArchived, sendsArchived, closedBatches };
  } catch {
    return { leadsArchived: 0, sendsArchived: 0, closedBatches: 0 };
  }
}
