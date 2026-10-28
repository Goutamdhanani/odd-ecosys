import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-sorting-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Contact sorting','discovery','open')").run().lastInsertRowid);
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

function insert(name, { category = null, city = null, status = 'discovered', discoveredAt = '2026-10-09 10:00:00' } = {}) {
  return Number(db.prepare(`INSERT INTO leads(batch_id,business_name,category,city,status,discovered_at)
    VALUES(?,?,?,?,?,?)`).run(batchId, name, category, city, status, discoveredAt).lastInsertRowid);
}

test('Contacts sorting is deterministic, keyset pages survive inserts and cursors bind to a sort', async () => {
  const alphaFirstId = insert('Alpha', { category: 'C', city: 'Delhi' });
  const alphaSecondId = insert('Alpha', { category: 'A', city: 'Pune' });
  const betaId = insert('Beta', { category: 'B', city: 'Mumbai' });
  const nullCityId = insert('Gamma', { category: 'D', city: null });

  const first = await request(`/api/leads?limit=2&sort_by=business_name&sort_order=asc`);
  assert.equal(first.status, 200, first.body.error);
  assert.deepEqual(first.body.leads.map(lead => lead.id), [alphaFirstId, alphaSecondId], 'sort ties use ascending contact id');
  assert.equal(first.body.pagination.total, 4);
  assert.ok(first.body.pagination.nextCursor);

  const insertedBeforeCursor = insert('Aardvark', { category: 'Z', city: 'London' });
  const next = await request(`/api/leads?limit=2&sort_by=business_name&sort_order=asc&cursor=${encodeURIComponent(first.body.pagination.nextCursor)}`);
  assert.equal(next.status, 200, next.body.error);
  assert.deepEqual(next.body.leads.map(lead => lead.id), [betaId, nullCityId], 'insert before the cursor cannot duplicate or shift older rows');
  assert.equal(next.body.pagination.hasMore, false);
  assert.equal([...first.body.leads, ...next.body.leads].some(lead => lead.id === insertedBeforeCursor), false);
  assert.equal(new Set([...first.body.leads, ...next.body.leads].map(lead => lead.id)).size, 4);

  const tiedCategory = await request('/api/leads?sort_by=category&sort_order=asc');
  assert.equal(tiedCategory.status, 200);
  assert.deepEqual(tiedCategory.body.leads.slice(0, 2).map(lead => lead.id), [alphaSecondId, betaId]);
  assert.equal(tiedCategory.body.leads.at(-2).id, nullCityId, 'null category follows all non-null categories');
  assert.equal(tiedCategory.body.leads.at(-1).id, insertedBeforeCursor);
  const descCity = await request('/api/leads?sort_by=city&sort_order=desc');
  assert.equal(descCity.status, 200);
  assert.equal(descCity.body.leads.at(-1).id, nullCityId, 'null values stay last when descending');

  const mismatched = await request(`/api/leads?limit=2&sort_by=city&sort_order=asc&cursor=${encodeURIComponent(first.body.pagination.nextCursor)}`);
  assert.equal(mismatched.status, 400);
  assert.match(mismatched.body.error, /does not match the selected sort/i);
  assert.equal((await request('/api/leads?sort_by=raw_sql')).status, 400);
  assert.equal((await request('/api/leads?sort_order=sideways')).status, 400);
  assert.equal((await request('/api/leads?limit=2&sort_by=business_name&sort_order=asc&cursor=not-a-cursor')).status, 400);
});

test('saved segments normalize and persist non-default contact sort after database reopen', async () => {
  const created = await request('/api/contact-segments', { method: 'POST', body: {
    name: 'City order', filters: { sort_by: 'city', sort_order: 'asc', status: 'discovered' },
  } });
  assert.equal(created.status, 201, created.body.error);
  assert.deepEqual(created.body.filters, { status: 'discovered', sort_by: 'city', sort_order: 'asc' });
  const invalidField = await request('/api/contact-segments', { method: 'POST', body: {
    name: 'Unsafe sort', filters: { sort_by: 'business_name; DROP TABLE leads' },
  } });
  assert.equal(invalidField.status, 400);
  const invalidOrder = await request('/api/contact-segments', { method: 'POST', body: {
    name: 'Invalid order', filters: { sort_order: 'sideways' },
  } });
  assert.equal(invalidOrder.status, 400);
  const defaultSort = await request('/api/contact-segments', { method: 'POST', body: {
    name: 'Default order', filters: { sort_by: 'discovered_at', sort_order: 'desc' },
  } });
  assert.equal(defaultSort.status, 201);
  assert.deepEqual(defaultSort.body.filters, {}, 'default sort stays implicit for existing segment callers');

  closeDb();
  db = initDb();
  const listed = await request('/api/contact-segments');
  assert.deepEqual(listed.body.find(segment => segment.id === created.body.id).filters, {
    status: 'discovered', sort_by: 'city', sort_order: 'asc',
  });
  const serialized = new URLSearchParams(listed.body.find(segment => segment.id === created.body.id).filters).toString();
  const applied = await request(`/api/leads?${serialized}`);
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.body.leads.map(lead => lead.city), ['Delhi', 'London', 'Mumbai', 'Pune', null]);
});
