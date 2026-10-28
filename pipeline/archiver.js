// ============================================================
//  ODD-ECOSYS Pipeline — Batch/Cohort Archival Engine (Section 14)
//  Terminal-only archival with a complete relational snapshot and restore path.
// ============================================================

import { getDb } from './database.js';

const TERMINAL_LEAD_STATES = new Set(['won', 'lost', 'disqualified', 'sent']);
const TERMINAL_SEND_STATES = new Set(['sent', 'failed', 'cancelled', 'bounced', 'replied']);
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_TABLE = 'batch_archive_snapshots';
const ARCHIVE_TABLES = new Set(['leads_archive', 'sends_archive', SNAPSHOT_TABLE]);

function archiveError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableNames(db) {
  return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().filter(row => !ARCHIVE_TABLES.has(row.name));
}

function tableInfo(db, name) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all();
}

function primaryKeyColumns(db, name) {
  return tableInfo(db, name).filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
}

function foreignKeyGroups(db, name) {
  const groups = new Map();
  for (const foreignKey of db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all()) {
    if (!groups.has(foreignKey.id)) groups.set(foreignKey.id, []);
    groups.get(foreignKey.id).push(foreignKey);
  }
  return [...groups.values()].map(group => group.sort((a, b) => a.seq - b.seq));
}

function rowIdentity(db, name, row) {
  const primaryKey = primaryKeyColumns(db, name);
  if (primaryKey.length) return JSON.stringify(primaryKey.map(column => row[column]));
  return JSON.stringify(['rowid', row.__archive_rowid]);
}

function readRows(db, name, where, values) {
  const primaryKey = primaryKeyColumns(db, name);
  const projection = primaryKey.length ? '*' : 'rowid AS __archive_rowid,*';
  return db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(name)} WHERE ${where}`).all(...values);
}

function addRows(db, rowsByTable, pendingByTable, table, rows) {
  if (!rows.length) return;
  if (!rowsByTable.has(table)) rowsByTable.set(table, new Map());
  if (!pendingByTable.has(table)) pendingByTable.set(table, new Map());
  const saved = rowsByTable.get(table);
  const pending = pendingByTable.get(table);
  for (const row of rows) {
    const key = rowIdentity(db, table, row);
    if (saved.has(key)) continue;
    saved.set(key, row);
    pending.set(key, row);
  }
}

function tuplesFromParent(parentRows, relation) {
  const parentColumns = relation.map(fk => fk.to || primaryKeyColumnsFromInfo(fk.parentInfo)[0]);
  return parentRows.map(row => parentColumns.map(column => row[column]))
    .filter(tuple => tuple.every(value => value !== null && value !== undefined));
}

function primaryKeyColumnsFromInfo(info) {
  return info.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
}

function rowsForTuples(db, childTable, childColumns, tuples) {
  const results = [];
  const uniqueTuples = new Map(tuples.map(tuple => [JSON.stringify(tuple), tuple]));
  const values = [...uniqueTuples.values()];
  const chunkSize = childColumns.length === 1 ? 400 : 100;
  for (let start = 0; start < values.length; start += chunkSize) {
    const chunk = values.slice(start, start + chunkSize);
    let where;
    let bindings;
    if (childColumns.length === 1) {
      where = `${quoteIdentifier(childColumns[0])} IN (${chunk.map(() => '?').join(',')})`;
      bindings = chunk.map(tuple => tuple[0]);
    } else {
      where = chunk.map(tuple => `(${childColumns.map(column => `${quoteIdentifier(column)} IS ?`).join(' AND ')})`).join(' OR ');
      bindings = chunk.flat();
    }
    results.push(...readRows(db, childTable, where, bindings));
  }
  return results;
}

function collectSnapshotRows(db, leadRows, sendRows) {
  const descriptors = tableNames(db).map(table => ({
    name: table.name,
    columns: tableInfo(db, table.name).map(column => column.name),
    foreignKeys: foreignKeyGroups(db, table.name),
  }));
  const parentInfo = new Map(descriptors.map(descriptor => [descriptor.name, tableInfo(db, descriptor.name)]));
  const rowsByTable = new Map();
  const pendingByTable = new Map();
  const queuedTables = new Set();
  const tableQueue = [];
  const enqueue = (table, rows) => {
    const before = pendingByTable.get(table)?.size || 0;
    addRows(db, rowsByTable, pendingByTable, table, rows);
    const after = pendingByTable.get(table)?.size || 0;
    if (after > before && !queuedTables.has(table)) {
      queuedTables.add(table);
      tableQueue.push(table);
    }
  };

  rowsByTable.set('leads', new Map());
  rowsByTable.set('sends', new Map());
  enqueue('leads', leadRows);
  enqueue('sends', sendRows);

  while (tableQueue.length) {
    const parentTable = tableQueue.shift();
    queuedTables.delete(parentTable);
    const parents = [...(pendingByTable.get(parentTable)?.values() || [])];
    pendingByTable.set(parentTable, new Map());
    const parentColumns = parentInfo.get(parentTable) || tableInfo(db, parentTable);
    const parentInfoValue = { table: parentTable, columns: parentColumns };

    for (const child of descriptors) {
      for (const relation of child.foreignKeys.filter(group => group[0].table === parentTable)) {
        const relationWithParent = relation.map(fk => ({ ...fk, parentInfo: parentColumns }));
        const tuples = tuplesFromParent(parents, relationWithParent);
        const matches = rowsForTuples(db, child.name, relation.map(fk => fk.from), tuples);
        enqueue(child.name, matches);
      }

      // Preserve legacy relations that predate declared SQLite foreign keys,
      // such as events.lead_id.
      for (const column of ['lead_id', 'send_id']) {
        const expectedParent = column === 'lead_id' ? 'leads' : 'sends';
        if (parentTable !== expectedParent || !child.columns.includes(column)) continue;
        if (child.foreignKeys.some(group => group[0].table === parentTable && group.some(fk => fk.from === column))) continue;
        const tuples = parents.map(row => [row.id]).filter(([id]) => id !== null && id !== undefined);
        enqueue(child.name, rowsForTuples(db, child.name, [column], tuples));
      }
    }
  }

  const leadIds = new Set(leadRows.map(row => Number(row.id)));
  const sendIds = new Set(sendRows.map(row => Number(row.id)));
  for (const [table, rows] of rowsByTable) {
    if (table === 'leads' || table === 'sends') continue;
    const columns = new Set(tableInfo(db, table).map(column => column.name));
    for (const row of rows.values()) {
      for (const column of columns) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        if (/(?:^|_)lead_id$/.test(column) && !leadIds.has(Number(value))) {
          throw archiveError(`Batch archival is blocked because ${table}.${column} links to a contact outside this batch.`, 409);
        }
        if (/(?:^|_)send_id$/.test(column) && !sendIds.has(Number(value))) {
          throw archiveError(`Batch archival is blocked because ${table}.${column} links to a send outside this batch.`, 409);
        }
      }
    }
  }
  return rowsByTable;
}

function assertNoUncapturedReferences(db, rowsByTable, leads, sends) {
  const ids = { lead: new Set(leads.map(row => Number(row.id))), send: new Set(sends.map(row => Number(row.id))) };
  for (const table of tableNames(db)) {
    const included = rowsByTable.get(table.name);
    for (const column of tableInfo(db, table.name)) {
      const scalar = column.name.match(/(?:^|_)(lead|send)_id$/);
      const array = column.name.match(/(?:^|_)(lead|send)_ids_json$/);
      const kind = scalar?.[1] || array?.[1];
      if (!kind || (!ids[kind].size && !included?.size)) continue;
      for (const row of readRows(db, table.name, `${quoteIdentifier(column.name)} IS NOT NULL`, [])) {
        const captured = included?.has(rowIdentity(db, table.name, row));
        let values = [row[column.name]];
        if (array) {
          try { values = JSON.parse(row[column.name]); }
          catch { throw archiveError(`Batch archival is blocked because ${table.name}.${column.name} contains malformed reference JSON.`, 409); }
          if (!Array.isArray(values)) throw archiveError(`Batch archival is blocked because ${table.name}.${column.name} is not a reference array.`, 409);
          // A row captured through one relation may still be shared with a
          // different batch through its JSON references. Validate the whole
          // captured array, even if no value matches (or the set is empty).
          if (captured) {
            if (values.some(value => !Number.isSafeInteger(value) || value < 1)) {
              throw archiveError(`Batch archival is blocked because ${table.name}.${column.name} contains an invalid reference ID.`, 409);
            }
            if (values.some(value => !ids[kind].has(value))) {
              throw archiveError(`Batch archival is blocked because ${table.name}.${column.name} links outside the restorable snapshot.`, 409);
            }
          }
        }
        if (!values.some(value => ids[kind].has(Number(value)))) continue;
        if (!captured) {
          throw archiveError(`Batch archival is blocked because ${table.name}.${column.name} has a live reference outside the restorable snapshot.`, 409);
        }
      }
    }
  }
}

function relatedTableOrder(db, rowsByTable, direction) {
  const included = new Set(rowsByTable.keys());
  const children = new Map([...included].map(table => [table, new Set()]));
  const parents = new Map([...included].map(table => [table, new Set()]));
  for (const childTable of included) {
    for (const relation of foreignKeyGroups(db, childTable)) {
      const parentTable = relation[0].table;
      if (included.has(parentTable)) {
        children.get(parentTable).add(childTable);
        parents.get(childTable).add(parentTable);
      }
    }
    if (tableInfo(db, childTable).some(column => column.name === 'lead_id') && included.has('leads')) {
      children.get('leads').add(childTable);
      parents.get(childTable).add('leads');
    }
    if (tableInfo(db, childTable).some(column => column.name === 'send_id') && included.has('sends')) {
      children.get('sends').add(childTable);
      parents.get(childTable).add('sends');
    }
  }

  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = table => {
    if (visited.has(table)) return;
    if (visiting.has(table)) throw archiveError(`Archive relationship cycle detected at ${table}; no rows were changed.`, 409);
    visiting.add(table);
    const dependencies = direction === 'delete' ? children.get(table) : parents.get(table);
    for (const related of dependencies) visit(related);
    visiting.delete(table);
    visited.add(table);
    ordered.push(table);
  };
  const roots = direction === 'delete' ? ['leads', 'sends'] : ['leads', 'sends'];
  for (const root of roots) if (included.has(root)) visit(root);
  for (const table of included) visit(table);
  return direction === 'delete' ? ordered : ordered;
}

function deleteSnapshotRows(db, rowsByTable) {
  const order = relatedTableOrder(db, rowsByTable, 'delete');
  for (const table of order) {
    const rows = [...rowsByTable.get(table).values()];
    const primaryKey = primaryKeyColumns(db, table);
    for (const row of rows) {
      const columns = primaryKey.length ? primaryKey : ['__archive_rowid'];
      const sqlColumns = primaryKey.length ? primaryKey : ['rowid'];
      db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE ${sqlColumns.map(column => `${quoteIdentifier(column)} IS ?`).join(' AND ')}`)
        .run(...columns.map(column => row[column]));
    }
  }
}

function insertArchiveCopy(db, archiveTable, row) {
  const archiveColumns = new Set(tableInfo(db, archiveTable).map(column => column.name));
  const columns = Object.keys(row).filter(column => column !== '__archive_rowid' && archiveColumns.has(column));
  if (!columns.length) return;
  db.prepare(`INSERT OR REPLACE INTO ${quoteIdentifier(archiveTable)} (${columns.map(quoteIdentifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map(column => row[column]));
}

function ensureArchiveTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads_archive AS SELECT * FROM leads WHERE 0;
    CREATE TABLE IF NOT EXISTS sends_archive AS SELECT * FROM sends WHERE 0;
    CREATE INDEX IF NOT EXISTS idx_leads_archive_batch ON leads_archive(batch_id);
    CREATE INDEX IF NOT EXISTS idx_sends_archive_batch ON sends_archive(lead_id);
  `);
}

function insertSnapshotRows(db, snapshot) {
  const rowsByTable = new Map(Object.entries(snapshot.rows).map(([table, rows]) => [table, rows]));
  const order = relatedTableOrder(db, rowsByTable, 'insert');
  for (const table of order) {
    const columns = tableInfo(db, table).map(column => column.name);
    const primaryKey = primaryKeyColumns(db, table);
    for (const row of rowsByTable.get(table)) {
      const insertColumns = columns.filter(column => row[column] !== undefined);
      const insertNames = insertColumns.map(quoteIdentifier);
      const values = insertColumns.map(column => row[column]);
      if (!primaryKey.length && row.__archive_rowid !== undefined) {
        insertNames.unshift('rowid');
        values.unshift(row.__archive_rowid);
      }
      db.prepare(`INSERT INTO ${quoteIdentifier(table)} (${insertNames.join(',')}) VALUES (${values.map(() => '?').join(',')})`)
        .run(...values);
    }
  }
}

/** Close and archive a batch only after all contact and sequence work is terminal. */
export function archiveBatch(batchId) {
  const cleanBatchId = Number(batchId);
  if (!Number.isSafeInteger(cleanBatchId) || cleanBatchId < 1) throw archiveError('Batch ID must be a positive integer.', 400);
  const db = getDb();

  const archiveTransaction = db.transaction(() => {
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(cleanBatchId);
    if (!batch) throw archiveError(`Batch #${cleanBatchId} not found`, 404);
    if (db.prepare(`SELECT 1 FROM ${quoteIdentifier(SNAPSHOT_TABLE)} WHERE batch_id=? AND restored_at IS NULL LIMIT 1`).get(cleanBatchId)) {
      throw archiveError(`Batch #${cleanBatchId} already has an active archive snapshot.`, 409);
    }

    const leads = db.prepare('SELECT * FROM leads WHERE batch_id = ?').all(cleanBatchId);
    const unfinished = leads.filter(lead => !TERMINAL_LEAD_STATES.has(lead.status));
    if (unfinished.length) {
      const states = [...new Set(unfinished.map(lead => lead.status || 'unknown'))].join(', ');
      throw archiveError(`Batch #${cleanBatchId} cannot be archived: ${unfinished.length} contact(s) are not in terminal states (${states}).`, 409);
    }
    const activeEnrollment = db.prepare("SELECT campaign_id FROM campaign_enrollments WHERE lead_id=? AND status='active' LIMIT 1");
    const unfinishedSend = db.prepare(`SELECT id,status FROM sends WHERE lead_id=?
      AND (status IS NULL OR status NOT IN (${[...TERMINAL_SEND_STATES].map(() => '?').join(',')})) LIMIT 1`);
    for (const lead of leads) {
      const enrollment = activeEnrollment.get(lead.id);
      if (enrollment) throw archiveError(`Batch #${cleanBatchId} cannot be archived: contact #${lead.id} is still active in campaign #${enrollment.campaign_id}.`, 409);
      const send = unfinishedSend.get(lead.id, ...TERMINAL_SEND_STATES);
      if (send) {
        throw archiveError(`Batch #${cleanBatchId} cannot be archived: send #${send.id} is ${send.status}; resolve it before archiving.`, 409);
      }
    }

    const sends = leads.flatMap(lead => db.prepare('SELECT * FROM sends WHERE lead_id=?').all(lead.id));
    for (const send of sends) {
      for (const table of ['delivery_reports', 'campaign_click_links']) {
        if (db.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE send_id=? LIMIT 1`).get(send.id)) {
          throw archiveError(`Batch #${cleanBatchId} cannot be archived: send #${send.id} has live ${table} references needed for delayed evidence.`, 409);
        }
      }
    }
    const rowsByTable = collectSnapshotRows(db, leads, sends);
    assertNoUncapturedReferences(db, rowsByTable, leads, sends);
    ensureArchiveTables(db);
    for (const lead of leads) insertArchiveCopy(db, 'leads_archive', lead);
    for (const send of sends) insertArchiveCopy(db, 'sends_archive', send);

    const payload = JSON.stringify({
      format: 'odd-ecosys-batch-archive',
      version: SNAPSHOT_VERSION,
      batch,
      rows: Object.fromEntries([...rowsByTable].map(([table, rows]) => [table, [...rows.values()]])),
    });
    db.prepare(`INSERT INTO ${quoteIdentifier(SNAPSHOT_TABLE)}(batch_id,snapshot_version,payload_json)
      VALUES(?,?,?)`).run(cleanBatchId, SNAPSHOT_VERSION, payload);

    deleteSnapshotRows(db, rowsByTable);
    db.prepare("UPDATE batches SET status='closed',closed_at=datetime('now') WHERE id=?").run(cleanBatchId);
    return { batchName: batch.name, archivedLeads: leads.length, archivedSends: sends.length };
  });

  const archived = archiveTransaction.immediate();
  try { db.exec('VACUUM'); } catch { /* SQLite may defer compaction while readers or WAL activity are present. */ }
  return { ok: true, batchId: cleanBatchId, ...archived, closedAt: new Date().toISOString() };
}

/** Restore the latest un-restored archive snapshot without replacing current rows. */
export function restoreBatch(batchId) {
  const cleanBatchId = Number(batchId);
  if (!Number.isSafeInteger(cleanBatchId) || cleanBatchId < 1) throw archiveError('Batch ID must be a positive integer.', 400);
  const db = getDb();
  return db.transaction(() => {
    const snapshotRow = db.prepare(`SELECT * FROM ${quoteIdentifier(SNAPSHOT_TABLE)}
      WHERE batch_id=? AND restored_at IS NULL ORDER BY id DESC LIMIT 1`).get(cleanBatchId);
    if (!snapshotRow) throw archiveError(`No restorable archive snapshot exists for batch #${cleanBatchId}.`, 404);
    const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(cleanBatchId);
    if (!batch || batch.status !== 'closed') throw archiveError(`Batch #${cleanBatchId} must remain closed until its archive snapshot is restored.`, 409);
    const snapshot = JSON.parse(snapshotRow.payload_json);
    if (snapshot.format !== 'odd-ecosys-batch-archive' || snapshot.version !== SNAPSHOT_VERSION
      || snapshotRow.snapshot_version !== SNAPSHOT_VERSION || !snapshot.rows?.leads) {
      throw archiveError(`Archive snapshot for batch #${cleanBatchId} has an unsupported format.`, 409);
    }

    insertSnapshotRows(db, snapshot);
    for (const lead of snapshot.rows.leads) db.prepare('DELETE FROM leads_archive WHERE id=?').run(lead.id);
    for (const send of snapshot.rows.sends || []) db.prepare('DELETE FROM sends_archive WHERE id=?').run(send.id);
    db.prepare('UPDATE batches SET status=?,closed_at=? WHERE id=?')
      .run(snapshot.batch.status || 'open', snapshot.batch.closed_at || null, cleanBatchId);
    db.prepare(`UPDATE ${quoteIdentifier(SNAPSHOT_TABLE)} SET restored_at=datetime('now') WHERE id=? AND restored_at IS NULL`)
      .run(snapshotRow.id);
    return { ok: true, batchId: cleanBatchId, restoredLeads: snapshot.rows.leads.length, restoredSends: (snapshot.rows.sends || []).length };
  }).immediate();
}

/** Get archive statistics. */
export function getArchiveStats() {
  const db = getDb();
  try {
    const leadsArchived = db.prepare('SELECT COUNT(*) as count FROM leads_archive').get()?.count || 0;
    const sendsArchived = db.prepare('SELECT COUNT(*) as count FROM sends_archive').get()?.count || 0;
    const closedBatches = db.prepare("SELECT COUNT(*) as count FROM batches WHERE status = 'closed'").get()?.count || 0;
    const restorableBatches = db.prepare(`SELECT COUNT(DISTINCT batch_id) AS count FROM ${quoteIdentifier(SNAPSHOT_TABLE)} WHERE restored_at IS NULL`).get()?.count || 0;
    const restorableBatchIds = db.prepare(`SELECT DISTINCT batch_id FROM ${quoteIdentifier(SNAPSHOT_TABLE)}
      WHERE restored_at IS NULL ORDER BY batch_id`).all().map(row => row.batch_id);
    return { leadsArchived, sendsArchived, closedBatches, restorableBatches, restorableBatchIds };
  } catch {
    return { leadsArchived: 0, sendsArchived: 0, closedBatches: 0, restorableBatches: 0 };
  }
}
