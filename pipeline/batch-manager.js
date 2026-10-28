// ============================================================
//  ODD-ECOSYS Pipeline — Batch Manager
//  Creates, tracks, and closes lead batches (cohort engine)
// ============================================================

import { getDb } from './database.js';

/**
 * Create a new batch.
 * @param {string} name - Descriptive name (e.g. "Dentists — Austin TX")
 * @param {string} phase - Pipeline phase: 'discovery' | 'qualification' | 'sending'
 * @returns {{ id: number, name: string, phase: string, status: string }}
 */
export function createBatch(name, phase = 'discovery') {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO batches (name, phase, status, lead_count, opened_at)
    VALUES (?, ?, 'open', 0, datetime('now'))
  `).run(name, phase);

  return {
    id: result.lastInsertRowid,
    name,
    phase,
    status: 'open',
  };
}

/**
 * Update batch status to 'processing'.
 * @param {number} batchId
 */
export function startProcessingBatch(batchId) {
  const db = getDb();
  db.prepare(`
    UPDATE batches SET status = 'processing' WHERE id = ?
  `).run(batchId);
}

/**
 * Close a batch: mark as closed, set closed_at, update lead_count.
 * @param {number} batchId
 */
export function closeBatch(batchId) {
  const db = getDb();

  // Count actual leads in this batch
  const { count } = db.prepare(
    'SELECT COUNT(*) as count FROM leads WHERE batch_id = ?'
  ).get(batchId);

  db.prepare(`
    UPDATE batches
    SET status = 'closed',
        closed_at = datetime('now'),
        lead_count = ?
    WHERE id = ?
  `).run(count, batchId);
}

/**
 * Update the lead_count on a batch (call after inserting leads).
 * @param {number} batchId
 */
export function updateBatchLeadCount(batchId) {
  const db = getDb();
  const { count } = db.prepare(
    'SELECT COUNT(*) as count FROM leads WHERE batch_id = ?'
  ).get(batchId);

  db.prepare('UPDATE batches SET lead_count = ? WHERE id = ?').run(count, batchId);
}

/**
 * Get batch details with status breakdown.
 * @param {number} batchId
 * @returns {object}
 */
export function getBatchStats(batchId) {
  const db = getDb();

  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  if (!batch) return null;

  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM leads
    WHERE batch_id = ?
    GROUP BY status
  `).all(batchId);

  const emailCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM lead_emails le
    JOIN leads l ON le.lead_id = l.id
    WHERE l.batch_id = ?
  `).all(batchId);

  return {
    ...batch,
    lead_count: statusBreakdown.reduce((sum, row) => sum + row.count, 0),
    status_breakdown: statusBreakdown.reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {}),
    email_count: emailCount[0]?.count || 0,
  };
}

/**
 * List all batches with optional status filter.
 * @param {object} [options]
 * @param {string} [options.status] - Filter by status
 * @param {number} [options.limit] - Limit results
 * @returns {object[]}
 */
export function listBatches(options = {}) {
  const db = getDb();
  let query = 'SELECT b.*, (SELECT COUNT(*) FROM leads l WHERE l.batch_id=b.id) AS lead_count FROM batches b';
  const params = [];

  if (options.status) {
    query += ' WHERE status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY opened_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }

  return db.prepare(query).all(...params);
}

/**
 * Get the next available batch (open, with room for more leads).
 * @param {number} [maxLeads=2000] - Max leads per batch
 * @returns {object|null}
 */
export function getOpenBatch(maxLeads = 2000) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM batches
    WHERE status = 'open' AND lead_count < ?
    ORDER BY opened_at DESC
    LIMIT 1
  `).get(maxLeads) || null;
}
