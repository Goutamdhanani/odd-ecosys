import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-legacy-tracking-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.sqlite');
process.env.NODE_ENV = 'production';
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

const database = await import('../pipeline/database.js');
const db = database.initDb();
db.prepare("INSERT INTO batches(id,name,phase,status) VALUES (1,'Tracking fixture','test','open')").run();
db.prepare("INSERT INTO leads(id,batch_id,business_name,status) VALUES (1,1,'Tracking fixture','sent')").run();
db.prepare("INSERT INTO campaigns(id,name,status) VALUES (1,'Tracking fixture','completed')").run();
db.prepare("INSERT INTO sends(id,lead_id,campaign_id,status) VALUES (1,1,1,'sent')").run();

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('legacy sequential open/click URLs cannot forge events or redirect visitors', async () => {
  const paths = [
    '/api/track/open/1',
    '/api/track/open/999999',
    '/api/track/click/1?url=https%3A%2F%2Fevil.example%2Flanding',
    '/api/track/click/1?url=javascript%3Aalert(1)',
    '/api/track/click/999999?url=https%3A%2F%2Fevil.example%2F',
  ];

  for (const pathname of paths) {
    const response = await fetch(`${base}${pathname}`, { redirect: 'manual' });
    assert.equal(response.status, 410, pathname);
    assert.equal(response.headers.get('location'), null, pathname);
    const body = await response.json();
    assert.match(body.error, /no analytics event was recorded/i);
  }

  const head = await fetch(`${base}/api/track/open/1`, { method: 'HEAD', redirect: 'manual' });
  assert.equal(head.status, 410);
  assert.equal(head.headers.get('location'), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type IN ('opened','clicked')").get().count, 0);
  assert.equal(db.prepare("SELECT status FROM sends WHERE id=1").get().status, 'sent');
});
