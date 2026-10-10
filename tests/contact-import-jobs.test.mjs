import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-import-jobs-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb, getDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Streaming contacts','discovery','open')").run().lastInsertRowid);
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

async function jsonRequest(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function uploadChunk(id, bytes, start, total) {
  const response = await fetch(`${base}/api/leads/import-jobs/${id}/chunks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${start + bytes.length - 1}/${total}` },
    body: bytes,
  });
  return { status: response.status, body: await response.json() };
}

function makeCsv(prefix, count = 900) {
  const rows = ['business_name,email,address,website_url'];
  const address = 'A'.repeat(370);
  for (let index = 0; index < count; index++) {
    rows.push(`${prefix} Studio ${index},${prefix}${index}@example.test,${address},https://${prefix}${index}.example.test`);
  }
  return Buffer.from(rows.join('\n'), 'utf8');
}

async function waitForTerminal(id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const current = await jsonRequest(`/api/leads/import-jobs/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(current.body.status)) return current.body;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Contact import job did not reach a terminal state.');
}

test('streamed CSV import resumes verified chunks, persists progress, and is idempotent', async () => {
  const csv = makeCsv('stream', 900);
  const mapping = { business_name: 'business_name', email: 'email', address: 'address', website_url: 'website_url' };
  const created = await jsonRequest('/api/leads/import-jobs', {
    method: 'POST',
    body: { batch_id: batchId, file_name: 'large-contacts.csv', file_bytes: csv.length, columnMap: mapping, request_key: 'import-key-00000001' },
  });
  assert.equal(created.status, 201);
  const jobId = created.body.id;
  const firstLength = 256 * 1024;
  const first = csv.subarray(0, firstLength);
  const initial = await uploadChunk(jobId, first, 0, csv.length);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.job.status, 'uploading');
  assert.equal(initial.body.job.uploadedBytes, firstLength);

  // A user can reselect the original file after a browser interruption. The
  // already-persisted prefix is rechecked instead of appended twice.
  const replay = await uploadChunk(jobId, first, 0, csv.length);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.job.uploadedBytes, firstLength);
  const mismatchedReplay = Buffer.from(first);
  mismatchedReplay[0] ^= 1;
  assert.equal((await uploadChunk(jobId, mismatchedReplay, 0, csv.length)).status, 409);

  for (let start = firstLength; start < csv.length; start += 256 * 1024) {
    const chunk = csv.subarray(start, Math.min(csv.length, start + 256 * 1024));
    const result = await uploadChunk(jobId, chunk, start, csv.length);
    assert.equal(result.status, 200);
  }
  const completed = await waitForTerminal(jobId);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.totalRows, 900);
  assert.deepEqual(completed.counts, { inserted: 900, duplicates: 0, invalid: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(batchId).count, 900);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_emails WHERE source='csv_import' AND verification_status='unknown'").get().count, 900);
  assert.equal(db.prepare('SELECT lead_count FROM batches WHERE id=?').get(batchId).lead_count, 900);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  const idempotent = await jsonRequest('/api/leads/import-jobs', {
    method: 'POST',
    body: { batch_id: batchId, file_name: 'large-contacts.csv', file_bytes: csv.length, columnMap: mapping, request_key: 'import-key-00000001' },
  });
  assert.equal(idempotent.body.id, jobId);
  assert.equal(idempotent.body.counts.inserted, 900);
});

test('import cancellation leaves no partial rows for an incomplete upload', async () => {
  const csv = makeCsv('cancel', 900);
  const mapping = { business_name: 'business_name', email: 'email', address: 'address', website_url: 'website_url' };
  const created = await jsonRequest('/api/leads/import-jobs', {
    method: 'POST',
    body: { batch_id: batchId, file_name: 'cancel.csv', file_bytes: csv.length, columnMap: mapping, request_key: 'import-key-00000002' },
  });
  const first = csv.subarray(0, 256 * 1024);
  assert.equal((await uploadChunk(created.body.id, first, 0, csv.length)).status, 200);
  const cancelled = await jsonRequest(`/api/leads/import-jobs/${created.body.id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.job.status, 'cancelled');
  const rest = csv.subarray(256 * 1024);
  assert.equal((await uploadChunk(created.body.id, rest, 256 * 1024, csv.length)).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE business_name LIKE \'cancel Studio %\'').get().count, 0);
});

test('import manager recovers an interrupted upload from durable SQLite cursor state', async () => {
  const csv = makeCsv('recover', 900);
  const mapping = { business_name: 'business_name', email: 'email', address: 'address', website_url: 'website_url' };
  const { createContactImportJobs } = await import('../pipeline/contact-import-jobs.js');
  const firstManager = createContactImportJobs({ db: getDb() });
  const job = firstManager.createJob({
    batch_id: batchId, file_name: 'recover.csv', file_bytes: csv.length,
    columnMap: mapping, request_key: 'import-key-00000003',
  });
  const first = csv.subarray(0, 256 * 1024);
  await firstManager.uploadChunk(job.id, { start: 0, end: first.length - 1, total: csv.length, bytes: first });

  // A fresh manager models process restart; job offsets live in SQLite and the
  // raw file is resumed from the verified database boundary.
  const restartedManager = createContactImportJobs({ db: getDb() });
  await restartedManager.recover();
  assert.equal(restartedManager.getJob(job.id).uploadedBytes, first.length);
  for (let start = 0; start < csv.length; start += 256 * 1024) {
    const chunk = csv.subarray(start, Math.min(csv.length, start + 256 * 1024));
    await restartedManager.uploadChunk(job.id, { start, end: start + chunk.length - 1, total: csv.length, bytes: chunk });
  }
  let current;
  for (let attempt = 0; attempt < 300; attempt++) {
    current = restartedManager.getJob(job.id);
    if (['completed', 'failed', 'cancelled'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(current.status, 'completed', current.error);
  assert.equal(current.counts.inserted, 900);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE business_name LIKE 'recover Studio %'").get().count, 900);
});

test('failed row transactions resume from their committed cursor without duplicate inserts', async () => {
  const csv = makeCsv('retry', 300);
  const mapping = { business_name: 'business_name', email: 'email', address: 'address', website_url: 'website_url' };
  const { createContactImportJobs } = await import('../pipeline/contact-import-jobs.js');
  const manager = createContactImportJobs({ db: getDb() });
  const job = manager.createJob({
    batch_id: batchId, file_name: 'retry.csv', file_bytes: csv.length,
    columnMap: mapping, request_key: 'import-key-00000004',
  });
  db.exec(`CREATE TRIGGER fail_retry_rows BEFORE INSERT ON leads
    WHEN NEW.business_name LIKE 'retry Studio %'
    BEGIN SELECT RAISE(ABORT, 'temporary insert failure'); END;`);
  for (let start = 0; start < csv.length; start += 256 * 1024) {
    const chunk = csv.subarray(start, Math.min(csv.length, start + 256 * 1024));
    await manager.uploadChunk(job.id, { start, end: start + chunk.length - 1, total: csv.length, bytes: chunk });
  }
  let current;
  for (let attempt = 0; attempt < 300; attempt++) {
    current = manager.getJob(job.id);
    if (current.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(current.status, 'failed');
  assert.equal(current.processedRows, 0);
  db.exec('DROP TRIGGER fail_retry_rows');
  await manager.resume(job.id);
  for (let attempt = 0; attempt < 300; attempt++) {
    current = manager.getJob(job.id);
    if (['completed', 'failed', 'cancelled'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(current.status, 'completed', current.error);
  assert.equal(current.counts.inserted, 300);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE business_name LIKE 'retry Studio %'").get().count, 300);
});

test('streamed rejection export includes every rejected row and neutralizes spreadsheet formulas', async () => {
  const csv = Buffer.from('business_name,email\n"=HYPERLINK(""https://evil.example"")",broken-address', 'utf8');
  const created = await jsonRequest('/api/leads/import-jobs', {
    method: 'POST',
    body: {
      batch_id: batchId, file_name: 'rejections.csv', file_bytes: csv.length,
      columnMap: { business_name: 'business_name', email: 'email' }, request_key: 'import-key-00000005',
    },
  });
  const uploaded = await uploadChunk(created.body.id, csv, 0, csv.length);
  assert.equal(uploaded.status, 200);
  const completed = await waitForTerminal(created.body.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.rejectionCount, 1);
  const report = await fetch(`${base}/api/leads/import-jobs/${created.body.id}/rejections.csv`);
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-disposition'), new RegExp(`contact-import-${created.body.id}-rejections\\.csv`));
  const csvReport = await report.text();
  assert.match(csvReport, /"'=HYPERLINK\(""https:\/\/evil\.example""\)"/);
});
