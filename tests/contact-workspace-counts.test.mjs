import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dashboardLeadTotal } from '../js/dashboard-metrics.js';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-workspace-counts-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const insert = db.prepare('INSERT INTO leads(id,business_name,status) VALUES (?,?,?)');
insert.run(701, 'Discovered one', 'discovered');
insert.run(702, 'Discovered two', 'discovered');
insert.run(703, 'Won contact', 'won');
insert.run(704, 'Manual review hold', 'manual_review_hold');
insert.run(705, 'Verified contact', 'verified');

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

async function get(route) {
  const response = await fetch(`${base}${route}`);
  return { status: response.status, body: await response.json() };
}

test('Contacts, discovery and dashboard totals use the same durable contact count', async () => {
  const [contacts, funnel, discovery, filtered] = await Promise.all([
    get('/api/leads?limit=2'),
    get('/api/stats/funnel'),
    get('/api/stats/discovery'),
    get('/api/leads?status=manual_review_hold&limit=10'),
  ]);
  assert.equal(contacts.status, 200);
  assert.equal(funnel.status, 200);
  assert.equal(discovery.status, 200);
  assert.equal(contacts.body.pagination.total, 5);
  assert.equal(funnel.body.total, 5);
  assert.equal(discovery.body.leads_total, 5);
  assert.equal(dashboardLeadTotal(funnel.body), 5);
  assert.equal(funnel.body.discovered, 2);
  assert.equal(funnel.body.verified, 1);
  assert.equal(funnel.body.won, 1);
  assert.equal(Object.entries(funnel.body).filter(([key]) => key !== 'total').reduce((sum, [, count]) => sum + count, 0), 4,
    'the chart remains stage-scoped while the dashboard total includes valid statuses outside its fixed stages');
  assert.equal(filtered.body.pagination.total, 1, 'Contacts pagination reports only matching rows under a status filter');
});

test('dashboard metric ignores a total field when keeping compatibility with older stage-only responses', () => {
  assert.equal(dashboardLeadTotal({ total: 8, discovered: 4, replied: 2 }), 8);
  assert.equal(dashboardLeadTotal({ discovered: 4, replied: 2 }), 6);
  assert.equal(dashboardLeadTotal({ total: 'invalid', discovered: 4, replied: 2 }), 6);
});
