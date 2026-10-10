import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-lists-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
db.exec(`
  INSERT INTO leads (id,business_name,email,city,status) VALUES
    (11,'North Star Bakery','hello@northstar.example','Pune','discovered'),
    (12,'Paper Kite Studio','team@paperkite.example','Mumbai','verified'),
    (13,'Orbit Books','contact@orbitbooks.example','Delhi','queued');
`);
db.prepare("INSERT INTO suppression_list (email,reason) VALUES ('hello@northstar.example','unsubscribe_request')").run();

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
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

test('contact lists persist, search, and report real member counts through the API', async () => {
  const empty = await request('/api/lists');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.items, []);
  assert.equal(empty.body.pagination.total, 0);

  assert.equal((await request('/api/lists', { method: 'POST', body: { name: '   ' } })).status, 400);
  const created = await request('/api/lists', { method: 'POST', body: { name: '  Local Partners  ', description: '  Pune introductions  ' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'Local Partners');
  assert.equal(created.body.description, 'Pune introductions');
  assert.equal(created.body.status, 'active');
  assert.equal(created.body.contact_count, 0);

  const listId = created.body.id;
  const added = await request(`/api/lists/${listId}/members`, { method: 'POST', body: { leadIds: [11, 12, 12] } });
  assert.equal(added.status, 200);
  assert.equal(added.body.added, 2);
  assert.equal(added.body.alreadyMember, 0);
  assert.equal(added.body.contactCount, 2);

  const repeated = await request(`/api/lists/${listId}/members`, { method: 'POST', body: { leadIds: [11, 12] } });
  assert.equal(repeated.body.added, 0);
  assert.equal(repeated.body.alreadyMember, 2);
  const searched = await request(`/api/lists/${listId}/members?search=paper&limit=1`);
  assert.equal(searched.body.pagination.total, 1);
  assert.equal(searched.body.items[0].business_name, 'Paper Kite Studio');
  assert.equal((await request(`/api/lists?search=partners`)).body.items[0].id, listId);

  const summary = await request(`/api/lists/${listId}`);
  assert.equal(summary.body.contact_count, 2);
  assert.equal((await request(`/api/lists/999/members`)).status, 404);
  assert.equal((await request('/api/lists?limit=999')).status, 400);
});

test('invalid member batches roll back, archiving retains membership, and removing a member preserves contact/suppression data', async () => {
  const created = await request('/api/lists', { method: 'POST', body: { name: 'Safe audience' } });
  const listId = created.body.id;
  const missing = await request(`/api/lists/${listId}/members`, { method: 'POST', body: { leadIds: [13, 9999] } });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /No contacts were added/);
  assert.equal((await request(`/api/lists/${listId}`)).body.contact_count, 0);

  const added = await request(`/api/lists/${listId}/members`, { method: 'POST', body: { leadIds: [11, 13] } });
  assert.equal(added.body.added, 2);
  const archived = await request(`/api/lists/${listId}`, { method: 'PATCH', body: { status: 'archived' } });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.contact_count, 2);
  assert.equal((await request(`/api/lists/${listId}/members`, { method: 'POST', body: { leadIds: [12] } })).status, 409);

  const restored = await request(`/api/lists/${listId}`, { method: 'PATCH', body: { status: 'active', name: 'Restored audience' } });
  assert.equal(restored.body.status, 'active');
  assert.equal(restored.body.name, 'Restored audience');
  const removed = await request(`/api/lists/${listId}/members/11`, { method: 'DELETE' });
  assert.equal(removed.body.removed, true);
  assert.equal(removed.body.contactCount, 1);
  assert.equal(db.prepare('SELECT business_name FROM leads WHERE id=11').get().business_name, 'North Star Bakery');
  assert.equal(db.prepare('SELECT reason FROM suppression_list WHERE email=?').get('hello@northstar.example').reason, 'unsubscribe_request');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('list CSV export contains full membership and verification evidence while neutralizing spreadsheet formulas', async () => {
  db.prepare("UPDATE leads SET business_name='=HYPERLINK(\"https://evil.test\",\"open\"), Inc.' WHERE id=13").run();
  const created = await request('/api/lists', { method: 'POST', body: { name: 'Export fixture' } });
  const listId = created.body.id;
  assert.equal((await request(`/api/lists/${listId}/members`, { method: 'POST', body: { leadIds: [13] } })).body.added, 1);

  const response = await fetch(`${base}/api/lists/${listId}/export`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="contact-list-${listId}.csv"`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const csv = Buffer.from(await response.arrayBuffer()).toString('utf8');
  assert.ok(csv.startsWith('\uFEFF"contact_id","business_name","email","verification_status"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""https://evil.test"",""open""), Inc."'));
  assert.ok(csv.includes('"contact@orbitbooks.example","unknown"'));
  assert.ok(csv.endsWith('\r\n'));

  assert.equal((await request(`/api/lists/${listId}`, { method: 'PATCH', body: { status: 'archived' } })).body.status, 'archived');
  assert.equal((await fetch(`${base}/api/lists/${listId}/export`)).status, 200, 'archived lists remain exportable');
  assert.equal((await request('/api/lists/999999/export')).status, 404);
});

test('list membership survives a database close and reopen without modifying contact records', () => {
  closeDb();
  const reopened = initDb();
  const list = reopened.prepare("SELECT id, name, contact_count FROM (SELECT l.id,l.name,(SELECT COUNT(*) FROM contact_list_members m WHERE m.list_id=l.id) contact_count FROM contact_lists l) WHERE name='Restored audience'").get();
  assert.ok(list);
  assert.equal(list.contact_count, 1);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 3);
});
