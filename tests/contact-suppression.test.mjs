import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-suppression-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Suppression fixture','discovery','open')").run().lastInsertRowid);
db.exec(`
  INSERT INTO leads(id,batch_id,business_name,email,status) VALUES
    (41,${batchId},'Previously opted out','deleted@example.test','disqualified'),
    (42,${batchId},'Editable contact','editable@example.test','discovered');
  INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary) VALUES
    (41,'deleted@example.test','fixture','unknown',1),
    (42,'editable@example.test','fixture','unknown',1);
  INSERT INTO suppression_list(email,reason) VALUES
    ('deleted@example.test','one_click_unsubscribe'),
    ('alias-blocked@example.test','operator_suppression'),
    ('chunk-blocked@example.test','complaint'),
    ('edit-blocked@example.test','one_click_unsubscribe');
  UPDATE batches SET lead_count=2 WHERE id=${batchId};
`);
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

async function request(route, { method = 'GET', body, headers } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json', ...headers }, body }),
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = text; }
  return { status: response.status, body: result };
}

async function waitForTerminal(id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const current = await request(`/api/leads/import-jobs/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(current.body.status)) return current.body;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Suppression import did not reach a terminal state.');
}

test('globally suppressed addresses cannot re-enter through create, edit, or either CSV import path', async () => {
  const suppressionBefore = db.prepare('SELECT email,reason,added_at FROM suppression_list ORDER BY email').all();
  const deleted = await request('/api/leads/41', { method: 'DELETE' });
  assert.equal(deleted.status, 200, deleted.body.error);
  assert.equal(db.prepare('SELECT 1 FROM suppression_list WHERE email=?').get('deleted@example.test') !== undefined, true,
    'contact deletion leaves the global opt-out record intact');

  const createBlocked = await request('/api/leads', { method: 'POST', body: JSON.stringify({
    batch_id: batchId, business_name: 'Attempted re-add', email: 'DELETED@example.test',
  }) });
  assert.equal(createBlocked.status, 409);
  assert.match(createBlocked.body.error, /globally suppressed/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE lower(email)='deleted@example.test'").get().count, 0);

  const editBlocked = await request('/api/leads/42', { method: 'PATCH', body: JSON.stringify({ email: 'edit-blocked@example.test' }) });
  assert.equal(editBlocked.status, 409);
  assert.match(editBlocked.body.error, /globally suppressed/i);
  assert.equal(db.prepare('SELECT email FROM leads WHERE id=42').get().email, 'editable@example.test');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=42 AND email='edit-blocked@example.test'").get().count, 0);

  const csv = [
    'business_name,email',
    'Deleted address,deleted@example.test',
    'Suppressed alias,"allowed@example.test,alias-blocked@example.test"',
  ].join('\n');
  const synchronous = await request('/api/leads/import', { method: 'POST', body: JSON.stringify({ batch_id: batchId, csv }) });
  assert.equal(synchronous.status, 200, synchronous.body.error);
  assert.deepEqual(synchronous.body.counts, { parsed: 2, inserted: 0, duplicates: 0, invalid: 2 });
  assert.deepEqual(synchronous.body.rejections.map(row => row.reason), ['suppressed_email', 'suppressed_email']);
  assert.equal(synchronous.body.rejections[1].fields.email, 'allowed@example.test,alias-blocked@example.test');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE business_name IN ('Deleted address','Suppressed alias')").get().count, 0);

  const chunkCsv = Buffer.from('business_name,email\nChunked suppressed,chunk-blocked@example.test', 'utf8');
  const created = await request('/api/leads/import-jobs', { method: 'POST', body: JSON.stringify({
    batch_id: batchId,
    file_name: 'suppressed.csv',
    file_bytes: chunkCsv.length,
    columnMap: { business_name: 'business_name', email: 'email' },
    request_key: 'suppression-import-0001',
  }) });
  assert.equal(created.status, 201, created.body.error);
  const uploaded = await request(`/api/leads/import-jobs/${created.body.id}/chunks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes 0-${chunkCsv.length - 1}/${chunkCsv.length}` },
    body: chunkCsv,
  });
  assert.equal(uploaded.status, 200, uploaded.body.error);
  const completed = await waitForTerminal(created.body.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.deepEqual(completed.counts, { inserted: 0, duplicates: 0, invalid: 1 });
  const rejections = await request(`/api/leads/import-jobs/${created.body.id}/rejections`);
  assert.equal(rejections.status, 200);
  assert.equal(rejections.body.rows[0].reason, 'suppressed_email');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE business_name='Chunked suppressed'").get().count, 0);

  closeDb();
  db = initDb();
  assert.deepEqual(db.prepare('SELECT email,reason,added_at FROM suppression_list ORDER BY email').all(), suppressionBefore,
    'all suppression provenance stays unchanged across rejection and database reopen');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
