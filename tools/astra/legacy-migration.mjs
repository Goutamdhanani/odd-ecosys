#!/usr/bin/env node
/**
 * Prepare a reversible Astra S03 migration plan from an explicit JSON source
 * snapshot and explicit owner-to-tenant mapping. This tool has no database
 * driver, accepts no connection strings, and never applies data changes.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_ID = /^[1-9][0-9]{0,39}$/;
const hash = data => createHash('sha256').update(data).digest('hex');
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
};
const canonical = value => JSON.stringify(stable(value));
function parseArgs(argv) {
  const result = { mode: 'dry-run' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--prepare') result.mode = 'prepare';
    else if (arg === '--resume') { result.mode = 'prepare'; result.resume = true; }
    else if (['--source','--mapping','--out'].includes(arg)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path.`);
      result[arg.slice(2)] = value;
    } else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`Unsupported option: ${arg}. Database apply and credential flags are not supported.`);
  }
  if (!result.help && (!result.source || !result.mapping)) throw new Error('--source and --mapping are required.');
  if (result.mode === 'prepare' && !result.out) throw new Error('--out is required with --prepare or --resume.');
  return result;
}
function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !snapshot.tables || typeof snapshot.tables !== 'object' || Array.isArray(snapshot.tables)) {
    throw new Error('Source snapshot must be an object with a tables object.');
  }
  for (const [table, rows] of Object.entries(snapshot.tables)) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(table) || !Array.isArray(rows)) throw new Error('Snapshot tables must be named arrays of rows.');
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error(`Table ${table} contains a non-object row.`);
  }
}
function mappedOwner(mapping, table, row) {
  const rule = mapping.tables?.[table];
  if (!rule || typeof rule.ownerColumn !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(rule.ownerColumn)) return null;
  const value = row[rule.ownerColumn];
  if (value === null || value === undefined) return null;
  const entry = mapping.owners?.[String(value)];
  if (!entry || !UUID.test(String(entry.tenantId || '')) || !OWNER_ID.test(String(entry.userId || ''))) return null;
  return { tenantId: String(entry.tenantId).toLowerCase(), userId: String(entry.userId) };
}
function preparePlan(snapshot, mapping, sourceBytes) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || !mapping.owners || typeof mapping.owners !== 'object' || !mapping.tables || typeof mapping.tables !== 'object') {
    throw new Error('Mapping must explicitly define owners and per-table ownership columns.');
  }
  const records = [];
  const recordsByTable = new Map();
  for (const [table, rows] of Object.entries(snapshot.tables)) {
    const rule = mapping.tables?.[table] || {};
    const idKey = rule.idColumn || 'id';
    if (typeof idKey !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(idKey)) throw new Error(`Invalid idColumn mapping for ${table}.`);
    const seenIds = new Set(); const tableRecords = [];
    for (const row of rows) {
      const sourceId = row[idKey]; const checksum = hash(canonical(row)); const ownership = mappedOwner(mapping, table, row);
      const validId = sourceId !== undefined && sourceId !== null && String(sourceId).length > 0;
      const record = { sourceTable: table, sourcePk: validId ? String(sourceId) : `missing:${checksum.slice(0,16)}`, rowChecksum: checksum,
        relationshipRefs: [], decision: 'quarantined', targetTenantId: null, targetTable: null, targetId: null, ownerUserId: null,
        reasonCode: !ownership ? 'owner_unknown' : !validId ? 'other' : 'owner_unknown', sourceRow: row };
      if (ownership && validId) Object.assign(record, { decision: 'mapped', targetTenantId: ownership.tenantId, targetTable: table,
        targetId: String(sourceId), ownerUserId: ownership.userId, reasonCode: null });
      const id = validId ? String(sourceId) : null;
      if (id && seenIds.has(id)) {
        record.decision = 'quarantined'; record.targetTenantId = null; record.targetTable = null; record.targetId = null;
        record.ownerUserId = null; record.reasonCode = 'other';
        for (const previous of tableRecords) if (previous.sourcePk === id) {
          previous.decision = 'quarantined'; previous.targetTenantId = null; previous.targetTable = null; previous.targetId = null;
          previous.ownerUserId = null; previous.reasonCode = 'other';
        }
      }
      if (id) seenIds.add(id);
      tableRecords.push(record); records.push(record);
    }
    const byId = new Map(); for (const record of tableRecords) if (!byId.has(record.sourcePk)) byId.set(record.sourcePk, record);
    recordsByTable.set(table, { rows, rule, idKey, tableRecords, byId });
  }
  // Validate declared foreign-key relationships against the explicit target
  // row mapping. A child cannot inherit a tenant or escape an unmapped parent.
  for (const [table, source] of recordsByTable) {
    const links = source.rule.references || [];
    if (!Array.isArray(links)) throw new Error(`references for ${table} must be an array.`);
    source.tableRecords.forEach((record, index) => {
      const row = source.rows[index];
      for (const link of links) {
        if (!link || typeof link.column !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(link.column)
          || typeof link.targetTable !== 'string' || !recordsByTable.has(link.targetTable)) throw new Error(`Invalid reference mapping for ${table}.`);
        const rawRef = row[link.column]; if (rawRef === null || rawRef === undefined) continue;
        const target = recordsByTable.get(link.targetTable);
        const targetIdKey = link.targetIdColumn || target.idKey;
        if (targetIdKey !== target.idKey) throw new Error(`Reference target ID column for ${table} must match the explicit ${link.targetTable} idColumn.`);
        record.relationshipRefs.push({ table: link.targetTable, id: String(rawRef) });
        const parent = target.byId.get(String(rawRef));
        if (!parent) record.reasonCode = 'orphan_reference';
        else if (parent.decision !== 'mapped') record.reasonCode = 'parent_unmapped';
        else if (record.decision === 'mapped' && parent.targetTenantId !== record.targetTenantId) record.reasonCode = 'conflicting_parent';
        if (record.reasonCode) { record.decision = 'quarantined'; record.targetTenantId = null; record.targetTable = null;
          record.targetId = null; record.ownerUserId = null; break; }
      }
    });
  }
  const checkpoints = [...recordsByTable.entries()].map(([table, source]) => {
    const rows = source.tableRecords;
    return { table, rowCount: rows.length, mappedCount: rows.filter(r => r.decision === 'mapped').length,
      quarantinedCount: rows.filter(r => r.decision === 'quarantined').length, rowsSha256: hash(rows.map(canonical).join('\n')) };
  });
  const fingerprint = hash(sourceBytes);
  const mapped = records.filter(row => row.decision === 'mapped');
  const quarantined = records.filter(row => row.decision === 'quarantined');
  const plan = {
    schemaVersion: 'astra-s03-prepared-migration/1', mode: 'prepared_plan_only',
    source: { fingerprint, schemaVersion: String(snapshot.schemaVersion || 'unknown'), filename: null, bytes: sourceBytes.length },
    mappingSha256: hash(canonical(mapping)), reversible: true,
    preservation: { sourceSnapshotCopiedByteForByte: true, stableSourceIdsRetained: true, rowPayloadsUnmodified: true,
      suppressionAndHistoryPolicy: 'Preserve source references and immutable history; no event time/outcome inference or mutation.' },
    counts: { sourceRows: records.length, mapped: mapped.length, quarantined: quarantined.length },
    mapped: mapped.map(({ sourceTable, sourcePk, rowChecksum, targetTenantId, targetTable, targetId, ownerUserId, relationshipRefs }) =>
      ({ sourceTable, sourcePk, rowChecksum, targetTenantId, targetTable, targetId, ownerUserId, relationshipRefs })),
    quarantine: quarantined.map(({ sourceTable, sourcePk, rowChecksum, reasonCode, relationshipRefs }) => ({ sourceTable, sourcePk, rowChecksum, reasonCode, relationshipRefs })),
    checkpoints,
    execution: { databaseWrites: false, realDataMigration: false, requiresIndependentReview: true },
  };
  plan.planSha256 = hash(canonical(plan));
  return plan;
}
export async function prepareLegacyMigration({ source, mapping, out = null, resume = false }) {
  const sourcePath = path.resolve(source); const mappingPath = path.resolve(mapping);
  const sourceBytes = await readFile(sourcePath); const mappingBytes = await readFile(mappingPath);
  const snapshot = JSON.parse(sourceBytes.toString('utf8')); const ownerMap = JSON.parse(mappingBytes.toString('utf8'));
  validateSnapshot(snapshot);
  const plan = preparePlan(snapshot, ownerMap, sourceBytes);
  const sourceStat = await stat(sourcePath); plan.source.filename = path.basename(sourcePath); plan.source.modifiedAt = sourceStat.mtime.toISOString();
  // Filename/stat metadata is part of the plan digest too.
  delete plan.planSha256; plan.planSha256 = hash(canonical(plan));
  if (out) {
    const destination = path.resolve(out);
    if (destination === sourcePath || destination === mappingPath || destination.startsWith(`${sourcePath}${path.sep}`) || destination.startsWith(`${mappingPath}${path.sep}`)) {
      throw new Error('Output directory cannot replace or contain the source snapshot or mapping.');
    }
    await mkdir(destination, { recursive: true });
    const sourceCopy = path.join(destination, 'source.snapshot.json');
    const planPath = path.join(destination, 'migration-plan.json');
    const checkpointsPath = path.join(destination, 'checkpoints.json');
    if (resume) {
      try {
        const previous = JSON.parse(await readFile(planPath, 'utf8'));
        if (previous.source?.fingerprint !== plan.source.fingerprint || previous.mappingSha256 !== plan.mappingSha256) throw new Error('Resume inputs do not match the prepared checkpoint.');
      } catch (error) { if (error.code === 'ENOENT') throw new Error('No prepared plan exists to resume.'); throw error; }
      const saved = await readFile(sourceCopy); if (hash(saved) !== plan.source.fingerprint) throw new Error('Preserved source snapshot checkpoint checksum does not match.');
    } else {
      try { await stat(planPath); throw new Error('Output already contains a migration plan; use --resume with identical inputs.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await copyFile(sourcePath, sourceCopy);
    }
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'w' });
    await writeFile(checkpointsPath, `${JSON.stringify({ sourceFingerprint: plan.source.fingerprint, mappingSha256: plan.mappingSha256, tables: plan.checkpoints }, null, 2)}\n`, { flag: 'w' });
  }
  return { plan, preparedDirectory: out ? path.resolve(out) : null };
}
function help() {
  return 'Usage: node tools/astra/legacy-migration.mjs --source <explicit-snapshot.json> --mapping <explicit-owner-map.json> [--prepare --out <new-directory> | --resume --out <prepared-directory>]\nDefault mode prints a dry-run plan. This command never connects to a database and has no apply mode.\n';
}
async function main() {
  try {
    const args = parseArgs(process.argv.slice(2)); if (args.help) { process.stdout.write(help()); return; }
    const result = await prepareLegacyMigration({ source: args.source, mapping: args.mapping, out: args.mode === 'prepare' ? args.out : null, resume: args.resume });
    process.stdout.write(`${JSON.stringify({ mode: args.mode === 'prepare' ? 'prepared_plan_only' : 'dry_run', plan: result.plan, preparedDirectory: result.preparedDirectory }, null, 2)}\n`);
  } catch (error) { process.stderr.write(`Legacy migration plan failed: ${error.message}\n`); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
