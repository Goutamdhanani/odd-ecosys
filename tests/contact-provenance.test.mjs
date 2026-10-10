import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-provenance-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Provenance fixture','discovery','open')").run().lastInsertRowid);
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* Preserve status if a response has no JSON body. */ }
  return { status: response.status, body: payload };
}

async function waitForJob(id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const current = await request(`/api/leads/import-jobs/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(current.body.status)) return current.body;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Contact provenance import did not reach a terminal state.');
}

async function importCsv(csv, requestKey) {
  const bytes = Buffer.from(csv, 'utf8');
  const preview = await request('/api/leads/import/preview', {
    method: 'POST', body: { batch_id: batchId, csv },
  });
  assert.equal(preview.status, 200, preview.body.error);
  const created = await request('/api/leads/import-jobs', {
    method: 'POST', body: {
      batch_id: batchId, file_name: `${requestKey}.csv`, file_bytes: bytes.length,
      columnMap: preview.body.mapping, request_key: requestKey.padEnd(16, 'x'),
    },
  });
  assert.equal(created.status, 201, created.body.error);
  const uploaded = await fetch(`${base}/api/leads/import-jobs/${created.body.id}/chunks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` },
    body: bytes,
  });
  assert.equal(uploaded.status, 200, await uploaded.text());
  return { preview: preview.body, job: await waitForJob(created.body.id) };
}

test('source and consent evidence persist through contacts, CSV imports, and archive without inference', async () => {
  const ordinary = await request('/api/leads', { method: 'POST', body: {
    batch_id: batchId, business_name: 'Unrecorded Contact', email: 'unrecorded@example.test',
  } });
  assert.equal(ordinary.status, 201, ordinary.body.error);
  assert.equal(ordinary.body.contact.source, 'manual');
  assert.equal(ordinary.body.contact.source_details, null);
  assert.equal(ordinary.body.contact.consent_recorded_at, null);
  assert.equal(ordinary.body.contact.consent_method, null);

  const created = await request('/api/leads', { method: 'POST', body: {
    batch_id: batchId,
    business_name: 'Evidence Contact',
    email: 'evidence@example.test',
    source_details: 'Requested a product guide at the trade event',
    source_url: 'https://events.example.test/attendees/42',
    consent_recorded_at: '2026-08-19',
    consent_method: 'Website signup form',
    consent_evidence_url: 'https://evidence.example.test/records/42',
  } });
  assert.equal(created.status, 201, created.body.error);
  const contactId = created.body.contact.id;
  assert.equal(created.body.contact.source, 'manual', 'operator provenance does not rewrite the system acquisition channel');
  assert.equal(created.body.contact.source_details, 'Requested a product guide at the trade event');
  assert.equal(created.body.contact.consent_recorded_at, '2026-08-19');
  assert.equal(created.body.contact.consent_method, 'Website signup form');
  assert.equal(created.body.contact.consent_evidence_url, 'https://evidence.example.test/records/42');
  assert.equal(created.body.emailEvidence.verification_status, 'unknown');

  const detail = await request(`/api/leads/${contactId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.consent_method, 'Website signup form');

  const partialConsent = await request('/api/leads', { method: 'POST', body: {
    batch_id: batchId, business_name: 'Incomplete Evidence', consent_method: 'Signup form',
  } });
  assert.equal(partialConsent.status, 400);
  assert.match(partialConsent.body.error, /date and method/i);
  const impossibleDate = await request('/api/leads', { method: 'POST', body: {
    batch_id: batchId, business_name: 'Invalid Date', consent_recorded_at: '2026-02-30', consent_method: 'Signup form',
  } });
  assert.equal(impossibleDate.status, 400);
  const unsafeUrl = await request('/api/leads', { method: 'POST', body: {
    batch_id: batchId, business_name: 'Invalid Source URL', source_url: 'javascript:alert(1)',
  } });
  assert.equal(unsafeUrl.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE business_name IN ('Incomplete Evidence','Invalid Date','Invalid Source URL')").get().count, 0,
    'invalid provenance rolls the contact creation back');

  const queuedSendId = Number(db.prepare(`INSERT INTO sends(lead_id,status,scheduled_at)
    VALUES(?,'scheduled',datetime('now','+1 day'))`).run(contactId).lastInsertRowid);
  const edited = await request(`/api/leads/${contactId}`, { method: 'PATCH', body: {
    source_details: 'Updated acquisition note',
  } });
  assert.equal(edited.status, 200, edited.body.error);
  assert.equal(edited.body.reviewRequired, false, 'provenance-only edits do not invalidate reviewed message copy');
  assert.equal(edited.body.cancelledSends, 0);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(queuedSendId).status, 'scheduled');
  assert.equal(edited.body.contact.consent_recorded_at, '2026-08-19', 'partial edits preserve existing consent evidence');
  const invalidClear = await request(`/api/leads/${contactId}`, { method: 'PATCH', body: { consent_recorded_at: '' } });
  assert.equal(invalidClear.status, 400, 'consent evidence must be cleared as a complete record');
  assert.equal(db.prepare('SELECT consent_recorded_at FROM leads WHERE id=?').get(contactId).consent_recorded_at, '2026-08-19');
  const cleared = await request(`/api/leads/${contactId}`, { method: 'PATCH', body: {
    consent_recorded_at: '', consent_method: '', consent_evidence_url: '',
  } });
  assert.equal(cleared.status, 200, cleared.body.error);
  assert.equal(cleared.body.contact.consent_recorded_at, null);
  assert.equal(cleared.body.contact.consent_method, null);
  assert.equal(cleared.body.contact.consent_evidence_url, null);

  const imported = await importCsv([
    'business_name,email,source_details,source_url,consent_recorded_at,consent_method,consent_evidence_url',
    'Imported Evidence,imported-evidence@example.test,Partner webinar,https://partners.example.test/webinar,2026-09-02,Verified registration,https://evidence.example.test/registration/9',
  ].join('\n'), 'provenance-import-01');
  assert.equal(imported.job.status, 'completed', imported.job.error);
  assert.equal(imported.job.counts.inserted, 1);
  assert.equal(imported.preview.sample[0].consent_method, 'Verified registration');
  const importedLead = db.prepare("SELECT * FROM leads WHERE email='imported-evidence@example.test'").get();
  assert.equal(importedLead.source, 'csv_import');
  assert.equal(importedLead.source_details, 'Partner webinar');
  assert.equal(importedLead.consent_recorded_at, '2026-09-02');
  assert.equal(importedLead.consent_method, 'Verified registration');
  assert.equal(importedLead.consent_evidence_url, 'https://evidence.example.test/registration/9');

  const syncCsv = [
    'business_name,email,source_details,consent_recorded_at,consent_method',
    'Synchronous Import,sync-evidence@example.test,Manual partner referral,2026-09-07,Partner signup',
  ].join('\n');
  const syncPreview = await request('/api/leads/import/preview', { method: 'POST', body: { batch_id: batchId, csv: syncCsv } });
  assert.equal(syncPreview.status, 200, syncPreview.body.error);
  const syncImport = await request('/api/leads/import', { method: 'POST', body: {
    batch_id: batchId, csv: syncCsv, columnMap: syncPreview.body.mapping,
  } });
  assert.equal(syncImport.status, 200, syncImport.body.error);
  assert.equal(syncImport.body.counts.inserted, 1);
  const syncLead = db.prepare("SELECT source_details,consent_recorded_at,consent_method FROM leads WHERE email='sync-evidence@example.test'").get();
  assert.equal(syncLead.source_details, 'Manual partner referral');
  assert.equal(syncLead.consent_recorded_at, '2026-09-07');
  assert.equal(syncLead.consent_method, 'Partner signup');

  const rejected = await importCsv([
    'business_name,email,consent_method',
    'Missing Consent Date,missing-date@example.test,Unspecified spreadsheet value',
  ].join('\n'), 'provenance-import-02');
  assert.equal(rejected.job.status, 'completed', rejected.job.error);
  assert.equal(rejected.job.counts.inserted, 0);
  assert.equal(rejected.job.counts.invalid, 1, 'invalid evidence is rejected per row without inferred dates');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE email='missing-date@example.test'").get().count, 0);

  const { archiveBatch } = await import('../pipeline/archiver.js');
  const archiveBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Archive metadata fixture','discovery','open')").run().lastInsertRowid);
  const archiveContact = db.prepare(`INSERT INTO leads(
    batch_id,business_name,source,source_details,source_url,consent_recorded_at,consent_method,consent_evidence_url
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    archiveBatchId, 'Archive Evidence Contact', 'csv_import', 'Archive fixture source', 'https://source.example.test/archive',
    '2026-05-22', 'Archive test evidence', 'https://evidence.example.test/archive');
  const archiveContactId = Number(archiveContact.lastInsertRowid);
  const archived = archiveBatch(archiveBatchId);
  assert.equal(archived.archivedLeads, 1);
  const savedArchive = db.prepare('SELECT source_details,source_url,consent_recorded_at,consent_method,consent_evidence_url FROM leads_archive WHERE id=?').get(archiveContactId);
  assert.equal(savedArchive.source_details, 'Archive fixture source');
  assert.equal(savedArchive.consent_recorded_at, '2026-05-22');
  assert.equal(savedArchive.consent_method, 'Archive test evidence');
  assert.equal(savedArchive.consent_evidence_url, 'https://evidence.example.test/archive');

  const legacyPath = path.join(directory, 'legacy-copy.db');
  await db.backup(legacyPath);
  const legacy = new Database(legacyPath);
  for (const table of ['leads', 'leads_archive']) {
    for (const column of ['source_details', 'source_url', 'consent_recorded_at', 'consent_method', 'consent_evidence_url']) {
      legacy.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
  legacy.close();
  const databaseModule = pathToFileURL(path.resolve('pipeline/database.js')).href;
  const migrationScript = `import { initDb, getDb, closeDb } from ${JSON.stringify(databaseModule)};
    const db = initDb();
    const lead = db.prepare("SELECT business_name,source_details,consent_recorded_at FROM leads WHERE email='unrecorded@example.test'").get();
    console.log(JSON.stringify(lead));
    closeDb();`;
  const migration = spawnSync(process.execPath, ['--input-type=module', '-e', migrationScript], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ODD_DB_PATH: legacyPath },
  });
  assert.equal(migration.status, 0, migration.stderr);
  const migratedLead = JSON.parse(migration.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(migratedLead.business_name, 'Unrecorded Contact', 'migration preserves existing contact rows');
  assert.equal(migratedLead.source_details, null);
  assert.equal(migratedLead.consent_recorded_at, null, 'older rows remain unrecorded after migration');
});
