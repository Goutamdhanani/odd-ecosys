import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const project = path.resolve(import.meta.dirname, '../..');
const source = path.join(project, 'data', 'pipeline.db');
const directory = path.join(os.homedir(), '.codex', 'odd-ecosys-backups', new Date().toISOString().replaceAll(':', '-'));
fs.mkdirSync(directory, { recursive: true });
const backupPath = path.join(directory, 'pipeline.db');
const restorePath = path.join(directory, 'restore-check.db');
const original = new Database(source, { readonly: true, fileMustExist: true });
try { await original.backup(backupPath); } finally { original.close(); }
fs.copyFileSync(backupPath, restorePath);
const restored = new Database(restorePath, { readonly: true, fileMustExist: true });
let integrity, foreignKeyViolations, syntheticEvents;
try {
  integrity = restored.pragma('integrity_check', { simple: true });
  foreignKeyViolations = restored.pragma('foreign_key_check').length;
  syntheticEvents = restored.prepare("SELECT COUNT(*) AS n FROM events WHERE json_valid(meta_json) AND json_extract(meta_json, '$.simulated') = 1").get().n;
} finally { restored.close(); }
if (integrity !== 'ok') throw new Error('Backup restore integrity failed');
const evidence = { createdAt: new Date().toISOString(), backupPath, restorePath, sha256: crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex'), integrity, foreignKeyViolations, explicitlySimulatedEventCount: syntheticEvents, note: 'Read-only consistent SQLite backup and restored-copy check. No private row bodies exported. Zero marked synthetic events does not prove historical provenance.' };
fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
const evidenceDirectory = path.join(project, 'orchestration', 'evidence');
fs.mkdirSync(evidenceDirectory, { recursive: true });
fs.writeFileSync(path.join(evidenceDirectory, 'backup.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
