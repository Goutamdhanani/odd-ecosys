import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-custom-field-filter-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Typed filter fixture','discovery','open')").run().lastInsertRowid);
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
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = text; }
  return { status: response.status, body: result };
}

async function createField(name, type, options) {
  const result = await request('/api/contact-fields', {
    method: 'POST', body: { name, type, ...(options ? { options } : {}) },
  });
  assert.equal(result.status, 201, result.body.error);
  return result.body;
}

async function createContact(businessName, fields) {
  const result = await request('/api/leads', { method: 'POST', body: {
    batch_id: batchId, business_name: businessName, custom_fields: fields,
  } });
  assert.equal(result.status, 201, result.body.error);
  return result.body.contact.id;
}

async function matches(key, value, extra = '') {
  const query = new URLSearchParams({ custom_field_key: key, custom_field_value: String(value), ...Object.fromEntries(new URLSearchParams(extra)) });
  const result = await request(`/api/leads?${query}`);
  assert.equal(result.status, 200, result.body.error);
  return result.body;
}

test('Contacts API filters exact typed values and combines them with existing filters', async () => {
  const segmentField = await createField('Market Segment', 'text');
  const seatField = await createField('Seat Count', 'number');
  const optedField = await createField('Opted In', 'boolean');
  const renewalField = await createField('Renewal Date', 'date');
  const planField = await createField('Plan', 'select', ['Starter', 'Growth']);
  const firstId = await createContact('Zero-seat SaaS', {
    [segmentField.fieldKey]: 'SaaS', [seatField.fieldKey]: 0, [optedField.fieldKey]: false,
    [renewalField.fieldKey]: '2026-12-31', [planField.fieldKey]: 'Starter',
  });
  const secondId = await createContact('Growth SaaS', {
    [segmentField.fieldKey]: 'SaaS', [seatField.fieldKey]: 12.5, [optedField.fieldKey]: true,
    [renewalField.fieldKey]: '2027-01-31', [planField.fieldKey]: 'Growth',
  });
  const thirdId = await createContact('Agency', {
    [segmentField.fieldKey]: 'Agency', [seatField.fieldKey]: 12.5, [optedField.fieldKey]: false,
    [renewalField.fieldKey]: '2026-12-31', [planField.fieldKey]: 'Growth',
  });

  assert.deepEqual((await matches(segmentField.fieldKey, 'SaaS')).leads.map(row => row.id).sort(), [firstId, secondId].sort());
  assert.deepEqual((await matches(segmentField.fieldKey, 'Saa')).leads, [], 'text comparisons are exact, not substring searches');
  assert.deepEqual((await matches(seatField.fieldKey, '0')).leads.map(row => row.id), [firstId], 'zero is a valid numeric filter');
  assert.deepEqual((await matches(optedField.fieldKey, false)).leads.map(row => row.id).sort(), [firstId, thirdId].sort(), 'false is a valid boolean filter');
  assert.deepEqual((await matches(renewalField.fieldKey, '2026-12-31')).leads.map(row => row.id).sort(), [firstId, thirdId].sort());
  assert.deepEqual((await matches(planField.fieldKey, 'Growth')).leads.map(row => row.id).sort(), [secondId, thirdId].sort());
  assert.deepEqual((await matches(segmentField.fieldKey, 'SaaS', 'status=discovered')).leads.map(row => row.id).sort(), [firstId, secondId].sort());
  assert.equal((await matches(segmentField.fieldKey, 'SaaS')).pagination.total, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, 3, 'filtering does not change contacts');

  for (const [query, expected] of [
    ['custom_field_key=market_segment', /both custom_field_key and custom_field_value/],
    ['custom_field_value=SaaS', /both custom_field_key and custom_field_value/],
    ['custom_field_key=missing&custom_field_value=x', /existing active custom field/],
    ['custom_field_key=seat_count&custom_field_value=NaN', /finite number/],
    ['custom_field_key=renewal_date&custom_field_value=2026-02-30', /valid YYYY-MM-DD date/],
    ['custom_field_key=opted_in&custom_field_value=yes', /true or false/],
    ['custom_field_key=plan&custom_field_value=Enterprise', /configured options/],
    ['custom_field_key=market_segment&custom_field_value=%20%20', /enter a value/i],
  ]) {
    const rejected = await request(`/api/leads?${query}`);
    assert.equal(rejected.status, 400, query);
    assert.match(rejected.body.error, expected, query);
  }
});

test('saved typed-field segments survive database reopen and continue working when their field is archived', async () => {
  const contactCountBefore = db.prepare('SELECT COUNT(*) AS count FROM leads').get().count;
  const field = await createField('Lifecycle Group', 'select', ['Customer', 'Prospect']);
  const customerId = await createContact('Existing customer', { [field.fieldKey]: 'Customer' });
  await createContact('Prospect', { [field.fieldKey]: 'Prospect' });
  const filters = { custom_field_key: field.fieldKey, custom_field_value: 'Customer' };
  const created = await request('/api/contact-segments', { method: 'POST', body: { name: 'Customer contacts', filters } });
  assert.equal(created.status, 201, created.body.error);
  assert.deepEqual(created.body.filters, filters);

  const invalidPair = await request('/api/contact-segments', { method: 'POST', body: {
    name: 'Incomplete custom filter', filters: { custom_field_key: field.fieldKey },
  } });
  assert.equal(invalidPair.status, 400);

  const archived = await request(`/api/contact-fields/${field.id}`, { method: 'DELETE' });
  assert.equal(archived.status, 200);
  const newArchivedSegment = await request('/api/contact-segments', { method: 'POST', body: { name: 'New archived filter', filters } });
  assert.equal(newArchivedSegment.status, 400, 'new segments cannot start using an archived field');

  closeDb();
  db = initDb();
  const listed = await request('/api/contact-segments');
  assert.deepEqual(listed.body[0].filters, filters, 'saved typed filter is durable across SQLite reopen');
  const query = new URLSearchParams(listed.body[0].filters).toString();
  const applied = await request(`/api/leads?${query}`);
  assert.equal(applied.status, 200, applied.body.error);
  assert.deepEqual(applied.body.leads.map(row => row.id), [customerId], 'archiving does not break an existing saved filter');

  const renamed = await request(`/api/contact-segments/${created.body.id}`, { method: 'PATCH', body: {
    name: 'Archived customer filter', filters: { ...filters, search: 'Existing' },
  } });
  assert.equal(renamed.status, 200, renamed.body.error);
  assert.equal(renamed.body.filters.custom_field_value, 'Customer');
  assert.equal(renamed.body.filters.search, 'Existing');
  const archivedFilterChoice = await request('/api/contact-segments', { method: 'POST', body: {
    name: 'Different archived field', filters: { custom_field_key: field.fieldKey, custom_field_value: 'Prospect' },
  } });
  assert.equal(archivedFilterChoice.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, contactCountBefore + 2);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
