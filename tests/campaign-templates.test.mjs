import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-templates-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
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
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, body: payload };
}

test('reusable campaign copy templates support validated create/edit/archive/restore and persist across database reopen', async () => {
  const created = await request('/api/sending/templates', {
    method: 'POST', body: { name: 'First touch', subjectLine: 'Hello {{business_name}}', bodyText: 'A reusable note for {{company}}.' },
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.status, 'active');
  assert.equal(created.body.subjectLine, 'Hello {{business_name}}');

  const duplicate = await request('/api/sending/templates', {
    method: 'POST', body: { name: 'first TOUCH', subjectLine: 'Another subject', bodyText: 'Another body.' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await request('/api/sending/templates', { method: 'POST', body: { name: 'Empty copy', subjectLine: '', bodyText: 'Body' } })).status, 400);

  const updated = await request(`/api/sending/templates/${id}`, {
    method: 'PATCH', body: { name: 'First touch v2', subjectLine: 'A note for {{city}}', bodyText: 'Hi {{business_name}}.' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.subjectLine, 'A note for {{city}}');
  assert.equal((await request('/api/sending/templates')).body.length, 1);

  const archived = await request(`/api/sending/templates/${id}/archive`, { method: 'POST' });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.status, 'archived');
  assert.deepEqual((await request('/api/sending/templates')).body, []);
  const archivedList = await request('/api/sending/templates?include_archived=true');
  assert.equal(archivedList.body.length, 1);
  assert.equal(archivedList.body[0].bodyText, 'Hi {{business_name}}.');
  assert.equal((await request(`/api/sending/templates/${id}`, { method: 'PATCH', body: { name: 'Blocked', subjectLine: 'x', bodyText: 'y' } })).status, 409);

  closeDb();
  db = initDb();
  const restored = await request(`/api/sending/templates/${id}/restore`, { method: 'POST' });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.status, 'active');
  assert.equal((await request('/api/sending/templates')).body[0].name, 'First touch v2');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
