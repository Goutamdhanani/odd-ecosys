import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-fields-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Custom fields fixture','discovery','open')").run().lastInsertRowid);
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

async function createField(input) {
  const result = await jsonRequest('/api/contact-fields', { method: 'POST', body: input });
  assert.equal(result.status, 201, result.body.error);
  return result.body;
}

async function waitForImport(id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await jsonRequest(`/api/leads/import-jobs/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(result.body.status)) return result.body;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Custom-field import did not reach a terminal state.');
}

test('typed custom contact fields validate, persist on create/edit, appear in detail, and invalidate stale copy', async () => {
  const segment = await createField({ name: 'Market segment', type: 'text', required: true });
  const seats = await createField({ name: 'Seat count', type: 'number' });
  const renewal = await createField({ name: 'Renewal date', type: 'date' });
  const optedIn = await createField({ name: 'Opted in', type: 'boolean' });
  const plan = await createField({ name: 'Plan', type: 'select', options: ['Starter', 'Growth'] });
  assert.equal(segment.fieldKey, 'market_segment');
  assert.deepEqual((await jsonRequest('/api/contact-fields')).body.fields.map(field => field.name), [
    'Market segment', 'Seat count', 'Renewal date', 'Opted in', 'Plan',
  ]);

  const incomplete = await jsonRequest('/api/leads', { method: 'POST', body: {
    batch_id: batchId, business_name: 'Missing required custom field', custom_fields: {},
  } });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.body.error, /market segment is required/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, 0, 'failed validation must roll back the contact');

  const created = await jsonRequest('/api/leads', { method: 'POST', body: {
    batch_id: batchId,
    business_name: 'Typed Field Studio',
    email: 'typed@example.test',
    custom_fields: {
      [segment.fieldKey]: '  SaaS  ',
      [seats.fieldKey]: '12.5',
      [renewal.fieldKey]: '2026-12-31',
      [optedIn.fieldKey]: false,
      [plan.fieldKey]: 'Growth',
    },
  } });
  assert.equal(created.status, 201, created.body.error);
  assert.deepEqual(created.body.customFields.map(field => field.value), ['SaaS', 12.5, '2026-12-31', false, 'Growth']);

  const invalidValues = await jsonRequest(`/api/leads/${created.body.contact.id}`, { method: 'PATCH', body: {
    custom_fields: { [seats.fieldKey]: 'NaN', [renewal.fieldKey]: '2026-02-30' },
  } });
  assert.equal(invalidValues.status, 400);
  assert.equal(db.prepare('SELECT value_json FROM lead_custom_field_values WHERE lead_id=? AND field_id=?')
    .get(created.body.contact.id, seats.id).value_json, '12.5', 'invalid multi-field updates must not partially persist');

  db.prepare(`INSERT INTO campaigns(id,name) VALUES(901,'Custom field invalidation')`).run();
  db.prepare('INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed,fact_check_passed) VALUES(901,?,?,?,1,1,1)')
    .run(created.body.contact.id, 'Old custom copy', 'Old details');
  db.prepare("INSERT INTO sends(id,lead_id,campaign_id,personalization_id,scheduled_at,status) VALUES(901,?,901,901,datetime('now','+1 day'),'scheduled')")
    .run(created.body.contact.id);
  const updated = await jsonRequest(`/api/leads/${created.body.contact.id}`, { method: 'PATCH', body: {
    custom_fields: { [segment.fieldKey]: 'Fintech' },
  } });
  assert.equal(updated.status, 200, updated.body.error);
  assert.deepEqual(updated.body.changedCustomFields, [segment.fieldKey]);
  assert.equal(updated.body.reviewRequired, true);
  assert.equal(updated.body.cancelledSends, 1);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=901').get().status, 'cancelled');
  assert.deepEqual(db.prepare('SELECT approved,guardrail_passed,fact_check_passed FROM personalizations WHERE id=901').get(), {
    approved: 0, guardrail_passed: 0, fact_check_passed: 0,
  });

  const detail = await jsonRequest(`/api/leads/${created.body.contact.id}`);
  assert.equal(detail.body.customFields.find(field => field.fieldKey === segment.fieldKey).value, 'Fintech');
  assert.equal(detail.body.customFields.find(field => field.fieldKey === optedIn.fieldKey).value, false);
});

test('custom field definitions reject option loss and protected system-field keys', async () => {
  const plan = db.prepare("SELECT id FROM contact_field_definitions WHERE field_key='plan'").get();
  const contactId = db.prepare("INSERT INTO leads(batch_id,business_name,status) VALUES (?,'Existing custom record','discovered')").run(batchId).lastInsertRowid;

  const removeUsedOption = await jsonRequest(`/api/contact-fields/${plan.id}`, { method: 'PATCH', body: { options: ['Starter', 'Pro'] } });
  assert.equal(removeUsedOption.status, 409);
  assert.match(removeUsedOption.body.error, /existing values use an option/i);

  const protectedKey = await jsonRequest(`/api/leads/${contactId}`, { method: 'PATCH', body: {
    custom_fields: { status: 'sent' },
  } });
  assert.equal(protectedKey.status, 400);
  assert.match(protectedKey.body.error, /unknown or archived/i);

  assert.equal((await jsonRequest('/api/contact-fields')).body.fields.some(field => field.fieldKey === 'market_segment'), true);
});

test('chunked CSV import maps typed custom values and rejects invalid custom data per row', async () => {
  const csv = Buffer.from([
    'business_name,email,segment,seats,plan',
    'Imported Good,good@example.test,SaaS,18,Growth',
    'Imported Bad,bad@example.test,Agency,not-a-number,Starter',
  ].join('\n'));
  const mapping = {
    business_name: 'business_name', email: 'email',
    custom__market_segment: 'segment', custom__seat_count: 'seats', custom__plan: 'plan',
  };
  const missingRequiredMapping = await jsonRequest('/api/leads/import-jobs', { method: 'POST', body: {
    batch_id: batchId, file_name: 'missing-required.csv', file_bytes: csv.length,
    columnMap: { business_name: 'business_name' }, request_key: 'custom-fields-import-missing',
  } });
  assert.equal(missingRequiredMapping.status, 400);
  assert.match(missingRequiredMapping.body.error, /required custom field/i);
  const preview = await jsonRequest('/api/leads/import/preview', { method: 'POST', body: {
    batch_id: batchId, csv: csv.toString(), columnMap: mapping,
  } });
  assert.equal(preview.status, 200, preview.body.error);
  assert.equal(preview.body.sample[0].custom__plan, 'Growth');

  const created = await jsonRequest('/api/leads/import-jobs', { method: 'POST', body: {
    batch_id: batchId, file_name: 'typed-fields.csv', file_bytes: csv.length,
    columnMap: mapping, request_key: 'custom-fields-import-0001',
  } });
  assert.equal(created.status, 201, created.body.error);
  const upload = await fetch(`${base}/api/leads/import-jobs/${created.body.id}/chunks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes 0-${csv.length - 1}/${csv.length}` },
    body: csv,
  });
  assert.equal(upload.status, 200, await upload.text());
  const completed = await waitForImport(created.body.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.deepEqual(completed.counts, { inserted: 1, duplicates: 0, invalid: 1 });
  const imported = db.prepare("SELECT id FROM leads WHERE business_name='Imported Good'").get();
  assert.ok(imported);
  assert.equal(db.prepare('SELECT value_json FROM lead_custom_field_values WHERE lead_id=? AND field_id=(SELECT id FROM contact_field_definitions WHERE field_key=\'seat_count\')')
    .get(imported.id).value_json, '18');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE business_name='Imported Bad'").get().count, 0);
  const rejects = await jsonRequest(`/api/leads/import-jobs/${created.body.id}/rejections`);
  assert.equal(rejects.body.rows[0].row, 3);
  assert.match(rejects.body.rows[0].reason, /seat count must be a finite number/i);
});

test('archiving a custom field preserves values in existing contact detail and prevents future writes', async () => {
  const field = db.prepare("SELECT id FROM contact_field_definitions WHERE field_key='market_segment'").get();
  const contactId = db.prepare("INSERT INTO leads(batch_id,business_name,status) VALUES (?,'Archived field record','discovered')").run(batchId).lastInsertRowid;
  db.prepare(`INSERT INTO lead_custom_field_values(lead_id,field_id,value_json) VALUES(?,?,?)`).run(contactId, field.id, JSON.stringify('SaaS'));

  const archived = await jsonRequest(`/api/contact-fields/${field.id}`, { method: 'DELETE' });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.status, 'archived');
  const allFields = await jsonRequest('/api/contact-fields?include_archived=true');
  assert.equal(allFields.body.fields.find(item => item.id === field.id).status, 'archived');
  const detail = await jsonRequest(`/api/leads/${contactId}`);
  assert.equal(detail.body.customFields.find(item => item.fieldKey === 'market_segment').status, 'archived');
  assert.equal(detail.body.customFields.find(item => item.fieldKey === 'market_segment').value, 'SaaS');
  const cannotWriteArchived = await jsonRequest(`/api/leads/${contactId}`, { method: 'PATCH', body: {
    custom_fields: { market_segment: 'Fintech' },
  } });
  assert.equal(cannotWriteArchived.status, 400);
});
