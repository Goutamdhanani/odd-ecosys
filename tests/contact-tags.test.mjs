import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-tags-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
db.prepare('INSERT INTO leads(id,business_name,email,status) VALUES (501,?,?,?)').run('Tag Contact One', 'one@example.test', 'discovered');
db.prepare('INSERT INTO leads(id,business_name,email,status) VALUES (502,?,?,?)').run('Tag Contact Two', 'two@example.test', 'discovered');
db.prepare('INSERT INTO leads(id,business_name,email,status) VALUES (503,?,?,?)').run('Untagged Contact', 'three@example.test', 'discovered');

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

test('contact tags persist, filter contacts, and archive without deleting assignments', async () => {
  const created = await request('/api/contact-tags', { method: 'POST', body: { name: 'Priority' } });
  assert.equal(created.status, 201);
  const priorityId = created.body.id;
  assert.equal(created.body.name, 'Priority');
  assert.equal((await request('/api/contact-tags', { method: 'POST', body: { name: 'priority' } })).status, 409);

  const assigned = await request('/api/leads/501/tags', {
    method: 'PUT', body: { tagIds: [priorityId, priorityId], createTag: 'Warm lead' },
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.createdTagId, 2);
  assert.deepEqual(assigned.body.tags.map(tag => tag.name), ['Priority', 'Warm lead']);
  assert.deepEqual(assigned.body.added, 2);
  assert.deepEqual((await request('/api/leads/501/tags', {
    method: 'PUT', body: { tagIds: [priorityId, 2, priorityId] },
  })).body.added, 0, 'repeat assignment is idempotent');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE lead_id=501 AND event_type='contact_tags_updated'").get().count, 1);

  const renamed = await request(`/api/contact-tags/${priorityId}`, { method: 'PATCH', body: { name: 'High intent' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'High intent');
  const detail = await request('/api/leads/501');
  assert.deepEqual(detail.body.tags.map(tag => tag.name), ['High intent', 'Warm lead']);

  const byTag = await request(`/api/leads?tag_id=${priorityId}&limit=20`);
  assert.equal(byTag.body.pagination.total, 1);
  assert.equal(byTag.body.leads[0].id, 501);
  assert.equal((await request('/api/leads?tag_id=99999')).body.pagination.total, 0);
  assert.equal((await request('/api/leads?tag_id=bad')).status, 400);

  const rejectedAssignment = await request('/api/leads/502/tags', {
    method: 'PUT', body: { tagIds: [99999], createTag: 'Must roll back' },
  });
  assert.equal(rejectedAssignment.status, 409);
  assert.equal((await request('/api/contact-tags')).body.some(tag => tag.name === 'Must roll back'), false, 'failed assignment rolls back tag creation');

  const archived = await request(`/api/contact-tags/${priorityId}`, { method: 'DELETE' });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.tag.status, 'archived');
  assert.equal((await request('/api/contact-tags')).body.some(tag => tag.id === priorityId), false);
  assert.equal((await request('/api/contact-tags?include_archived=true')).body.find(tag => tag.id === priorityId).contact_count, 1);
  assert.equal((await request(`/api/leads?tag_id=${priorityId}`)).body.pagination.total, 0, 'archived tags are not active filters');

  assert.equal((await request(`/api/contact-tags/${priorityId}/restore`, { method: 'POST' })).body.tag.status, 'active');
  assert.equal((await request(`/api/leads?tag_id=${priorityId}`)).body.leads[0].id, 501, 'restore preserves the original contact assignment');
  // Reopen in a separate process; closing the running server's injected DB
  // connection is not an application restart and invalidates its services.
  const reopened = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {initDb,closeDb} from './pipeline/database.js';
    const db=initDb();
    if(db.prepare('PRAGMA foreign_key_check').all().length) process.exitCode=1;
    if(!db.prepare('SELECT id FROM leads WHERE id=501').get()) process.exitCode=1;
    closeDb();
  `], { cwd: process.cwd(), env: { ...process.env }, encoding: 'utf8', timeout: 10000 });
  assert.equal(reopened.status, 0, reopened.stderr || reopened.stdout);
  const afterReopen = await request('/api/leads/501');
  assert.deepEqual(afterReopen.body.tags.map(tag => tag.name), ['High intent', 'Warm lead']);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
