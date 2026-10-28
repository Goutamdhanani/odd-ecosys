import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-email-filter-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
db.exec(`
  INSERT INTO batches(id,name,phase,status) VALUES (1,'Email filter fixture','test','open');
  INSERT INTO leads(id,batch_id,business_name,email,status) VALUES
    (101,1,'Deliverable Contact','deliverable@example.test','discovered'),
    (102,1,'Risky Contact','risky@example.test','discovered'),
    (103,1,'Undeliverable Contact','undeliverable@example.test','discovered'),
    (104,1,'Unverified Contact','unverified@example.test','discovered'),
    (105,1,'No Email Contact',NULL,'discovered'),
    (106,1,'No Evidence Contact','no-evidence@example.test','discovered'),
    (107,1,'Discovered Address Contact',NULL,'discovered');
  INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary) VALUES
    (101,'deliverable@example.test','fixture','deliverable',1),
    (101,'old-alias@example.test','fixture','risky',0),
    (102,'risky@example.test','fixture','risky',1),
    (103,'undeliverable@example.test','fixture','undeliverable',1),
    (104,'unverified@example.test','fixture','unknown',1),
    (107,'saved-discovery@example.test','fixture','risky',0);
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

async function list(query) {
  const response = await fetch(`${base}/api/leads?${query}`);
  return { status: response.status, body: await response.json() };
}

test('contact list shows saved addresses and filters by any saved address outcome without changing evidence', async () => {
  const before = db.prepare('SELECT COUNT(*) AS count FROM lead_emails').get().count;
  const cases = [
    ['deliverable', [101]],
    ['risky', [101, 102, 107]],
    ['undeliverable', [103]],
    ['unknown', [104, 106]],
    ['no_email', [105]],
  ];
  for (const [status, expectedIds] of cases) {
    const result = await list(`email_status=${status}&limit=50`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.leads.map(row => row.id).sort((a, b) => a - b), expectedIds);
  }
  const deliverable = await list('email_status=deliverable');
  assert.equal(deliverable.body.leads.find(row => row.id === 101).primary_email_status, 'deliverable');
  const riskyAlias = await list('email_status=risky');
  assert.equal(riskyAlias.body.leads.find(row => row.id === 101).primary_email_status, 'deliverable', 'primary state remains distinct from a matching risky alias');
  assert.deepEqual(riskyAlias.body.leads.find(row => row.id === 101).emails.map(email => email.verification_status), ['deliverable', 'risky']);
  assert.equal((await list('email_status=unsafe')).status, 400);
  const combined = await list('email_status=risky&search=Risky%20Contact');
  assert.deepEqual(combined.body.leads.map(row => row.id), [102]);
  const discoveredAddress = await list('email_status=risky&search=saved-discovery%40example.test');
  assert.equal(discoveredAddress.status, 200);
  assert.equal(discoveredAddress.body.leads[0].primary_email, 'saved-discovery@example.test');
  assert.equal(discoveredAddress.body.leads[0].primary_email_status, 'risky');
  assert.equal(discoveredAddress.body.leads[0].emails[0].email, 'saved-discovery@example.test');
  const withoutAnySavedAddress = await list('email_status=no_email');
  assert.deepEqual(withoutAnySavedAddress.body.leads.map(row => row.id), [105]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails').get().count, before, 'read filters do not perform verification or mutate evidence');
});
