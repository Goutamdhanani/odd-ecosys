import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadImportRejections, downloadRejectedContacts, rejectedContactsCsv } from '../js/contact-import.js';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-import-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Existing contacts','discovery','open')").run().lastInsertRowid);
const existingLeadId = Number(db.prepare(`
  INSERT INTO leads(batch_id,business_name,email,website_url,normalized_domain,status)
  VALUES (?,'Legacy Studio','legacy@example.test','https://legacy.example.test','legacy.example.test','discovered')
`).run(batchId).lastInsertRowid);
db.prepare("INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary) VALUES (?, 'legacy@example.test','csv_import','unknown',1)").run(existingLeadId);
db.prepare("INSERT INTO lead_emails(lead_id,email,source,verification_status) VALUES (?, 'alias@example.test','csv_import','unknown')").run(existingLeadId);
db.prepare('UPDATE batches SET lead_count=1 WHERE id=?').run(batchId);

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

async function request(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('bulk CSV import maps contacts, deduplicates real records, and leaves all email evidence unverified', async () => {
  const csv = [
    'business_name,email,category,city,website_url,phone',
    '"North Studio","north@example.test,team@north.example.test",Design,Pune,https://north.example.test,',
    'Duplicate Domain,other@example.test,Design,Mumbai,https://legacy.example.test,',
    'Duplicate Email,NORTH@example.test,Design,Delhi,https://other.example.test,',
    ',missing-name@example.test,Design,Surat,https://missing-name.example.test,',
    'Bad Email,invalid-email,Operations,Jaipur,https://bad-email.example.test,',
  ].join('\n');

  const imported = await request('/api/leads/import', { method: 'POST', body: { batch_id: batchId, csv } });
  assert.equal(imported.status, 200);
  assert.deepEqual(imported.body.counts, { parsed: 5, inserted: 1, duplicates: 2, invalid: 2 });
  assert.deepEqual(imported.body.duplicates.map(row => row.reason).sort(), ['duplicate_db_domain', 'duplicate_email']);
  assert.match(imported.body.errors.join('\n'), /Missing business name/);
  assert.match(imported.body.errors.join('\n'), /valid email/i);
  assert.equal(imported.body.rejections.length, 4);
  assert.equal(imported.body.rejections.find(row => row.row === 3).reason, 'duplicate_db_domain');
  assert.equal(imported.body.rejections.find(row => row.row === 3).fields.business_name, 'Duplicate Domain');
  assert.equal(imported.body.rejections.find(row => row.row === 4).fields.email, 'NORTH@example.test');
  assert.equal(imported.body.rejections.find(row => row.row === 5).reason, 'Missing business name');
  assert.equal(imported.body.rejections.find(row => row.row === 6).fields.email, 'invalid-email');

  const contact = db.prepare("SELECT * FROM leads WHERE business_name='North Studio'").get();
  assert.ok(contact);
  assert.equal(contact.batch_id, batchId);
  assert.equal(contact.source, 'csv_import');
  assert.equal(contact.status, 'discovered');
  assert.equal(contact.email, 'north@example.test');
  assert.equal(contact.normalized_domain, 'north.example.test');
  assert.deepEqual(db.prepare('SELECT email,source,verification_status,is_primary,verified_at FROM lead_emails WHERE lead_id=? ORDER BY is_primary DESC,email').all(contact.id), [
    { email: 'north@example.test', source: 'csv_import', verification_status: 'unknown', is_primary: 1, verified_at: null },
    { email: 'team@north.example.test', source: 'csv_import', verification_status: 'unknown', is_primary: 0, verified_at: null },
  ]);
  assert.equal(db.prepare('SELECT lead_count FROM batches WHERE id=?').get(batchId).lead_count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE lead_id=? AND event_type='contact_imported'").get(contact.id).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);

  const listed = await request(`/api/leads?batch_id=${batchId}&search=North%20Studio`);
  assert.equal(listed.body.pagination.total, 1);
  const detail = await request(`/api/leads/${contact.id}`);
  assert.deepEqual(detail.body.emails.map(email => email.verification_status), ['unknown', 'unknown']);
});

test('CSV preview is read-only, supports operator column mapping, and import saves the reviewed mapping', async () => {
  const csv = 'organization,primary address,office town\nMapped Studio,mapped@example.test,Chennai';
  const beforeLeads = db.prepare('SELECT COUNT(*) AS count FROM leads').get().count;
  const beforeEvents = db.prepare('SELECT COUNT(*) AS count FROM events').get().count;
  const mapping = { business_name: 'organization', email: 'primary address', city: 'office town' };
  const preview = await request('/api/leads/import/preview', {
    method: 'POST', body: { batch_id: batchId, csv, columnMap: mapping },
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.headers, ['organization', 'primary address', 'office town']);
  assert.equal(preview.body.totalRows, 1);
  assert.equal(preview.body.mapping.business_name, 'organization');
  assert.deepEqual(preview.body.sample[0], {
    business_name: 'Mapped Studio', category: '', address: '', city: 'Chennai', state: '', country: '', phone: '',
    website_url: '', facebook_url: '', email: 'mapped@example.test', source_details: '', source_url: '',
    consent_recorded_at: '', consent_method: '', consent_evidence_url: '', rating: '', reviews: '',
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, beforeLeads);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, beforeEvents);

  const missingRequiredMapping = await request('/api/leads/import', { method: 'POST', body: { batch_id: batchId, csv } });
  assert.equal(missingRequiredMapping.status, 400);
  assert.match(missingRequiredMapping.body.error, /business name/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, beforeLeads);

  const invalidMapping = await request('/api/leads/import/preview', {
    method: 'POST', body: { batch_id: batchId, csv, columnMap: { business_name: 'missing column' } },
  });
  assert.equal(invalidMapping.status, 400);

  const imported = await request('/api/leads/import', {
    method: 'POST', body: { batch_id: batchId, csv, columnMap: mapping },
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.counts.inserted, 1);
  const saved = db.prepare("SELECT id,email,city FROM leads WHERE business_name='Mapped Studio'").get();
  assert.deepEqual(saved, { id: saved.id, email: 'mapped@example.test', city: 'Chennai' });
  assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=?').get(saved.id).verification_status, 'unknown');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('large CSV preview samples bounded records without parsing a truncated file tail', async () => {
  const csv = [
    'organization,primary address,office town',
    ...Array.from({ length: 5 }, (_, index) => `Mapped Studio ${index},mapped${index}@example.test,Chennai`),
    'truncated tail,"not a complete quoted value',
  ].join('\n');
  const preview = await request('/api/leads/import/preview-sample', {
    method: 'POST', body: { batch_id: batchId, csv, columnMap: { business_name: 'organization', email: 'primary address' } },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.totalRows, null);
  assert.equal(preview.body.sample.length, 5);
  assert.equal(preview.body.mapping.business_name, 'organization');
  assert.equal(preview.body.sample[4].email, 'mapped4@example.test');
});

test('bulk import enforces batch, content, file-size and row limits before inserting contacts', async () => {
  const { importContactsToBatch } = await import('../pipeline/contact-manager.js');
  const { ContactManagerError } = await import('../pipeline/contact-manager.js');
  assert.throws(() => importContactsToBatch(99999, 'business_name,email\nA,a@example.test'), error => error.statusCode === 404);
  assert.throws(() => importContactsToBatch(batchId, ''), ContactManagerError);
  assert.throws(() => importContactsToBatch(batchId, 'x'.repeat(5 * 1024 * 1024 + 1)), error => error.statusCode === 413);

  const closedBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Closed contacts','discovery','closed')").run().lastInsertRowid);
  assert.throws(() => importContactsToBatch(closedBatchId, 'business_name,email\nA,a@example.test'), error => error.statusCode === 409);

  const manyRows = ['business_name,email', ...Array.from({ length: 5001 }, (_, index) => `Company ${index},contact${index}@example.test`)].join('\n');
  assert.throws(() => importContactsToBatch(batchId, manyRows), error => error.statusCode === 413);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(batchId).count, 3);
  assert.equal(db.prepare('SELECT lead_count FROM batches WHERE id=?').get(batchId).lead_count, 3);
});

test('rejected rows produce a safe CSV download with source values and reasons', async () => {
  const rows = [
    { row: 7, reason: 'Invalid name, review required', fields: { business_name: '=IMPORTXML("x")', email: 'bad@example.test' } },
    { row: 8, reason: 'Duplicate\nemail', fields: { business_name: 'Existing, contact', email: '@example.test' } },
  ];
  const csv = rejectedContactsCsv(rows);
  assert.match(csv, /^"row","reason","business_name","email"\r\n/);
  assert.match(csv, /"7","Invalid name, review required","'=IMPORTXML\(""x""\)","bad@example\.test"/);
  assert.match(csv, /"8","Duplicate\nemail","Existing, contact","'@example\.test"/);

  let anchor;
  let blob;
  let revoked = false;
  const documentRef = {
    body: { append(node) { assert.equal(node, anchor); } },
    createElement(tag) {
      assert.equal(tag, 'a');
      anchor = { click() { this.clicked = true; }, remove() { this.removed = true; } };
      return anchor;
    },
  };
  const urlApi = {
    createObjectURL(value) { blob = value; return 'blob:rejected-report'; },
    revokeObjectURL(value) { assert.equal(value, 'blob:rejected-report'); revoked = true; },
  };
  const download = downloadRejectedContacts(rows, 'contact import.csv', {
    documentRef,
    urlApi,
    BlobCtor: Blob,
    schedule(callback, delay) { assert.equal(delay, 1000); callback(); },
  });
  assert.deepEqual(download, { filename: 'contact_import-rejected.csv', rows: 2 });
  assert.equal(anchor.download, download.filename);
  assert.equal(anchor.href, 'blob:rejected-report');
  assert.equal(anchor.clicked, true);
  assert.equal(anchor.removed, true);
  assert.equal(blob.type, 'text/csv;charset=utf-8');
  assert.equal(await blob.text(), csv);
  assert.equal(revoked, true);
  assert.equal(downloadRejectedContacts([], 'empty.csv', { documentRef, urlApi, BlobCtor: Blob }), null);
});

test('large-import rejection download delegates to the authenticated streaming endpoint', () => {
  let anchor;
  const documentRef = {
    body: { append(node) { assert.equal(node, anchor); } },
    createElement(tag) { assert.equal(tag, 'a'); anchor = { click() { this.clicked = true; }, remove() { this.removed = true; } }; return anchor; },
  };
  const result = downloadImportRejections(12, { documentRef, apiBase: '/app' });
  assert.deepEqual(result, { filename: 'contact-import-12-rejections.csv' });
  assert.equal(anchor.href, '/app/api/leads/import-jobs/12/rejections.csv');
  assert.equal(anchor.download, result.filename);
  assert.equal(anchor.clicked, true);
  assert.equal(anchor.removed, true);
  assert.equal(downloadImportRejections('not-an-id', { documentRef }), null);
});
