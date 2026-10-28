import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderLeadDetail } from '../js/leads.js';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-suppression-view-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Suppression display','discovery','open')").run().lastInsertRowid);
db.exec(`
  INSERT INTO leads(id,batch_id,business_name,email,status) VALUES (51,${batchId},'Suppression display','Primary@Example.Test','disqualified');
  INSERT INTO lead_emails(lead_id,email,source,verification_status,verified_at,is_primary) VALUES
    (51,'Primary@Example.Test','fixture','deliverable','2026-10-01 12:00:00',1),
    (51,'Alias@Example.Test','fixture','risky','2026-10-02 12:00:00',0),
    (51,'safe@example.test','fixture','unknown',NULL,0);
  INSERT INTO suppression_list(email,reason) VALUES
    ('primary@example.test','one_click_unsubscribe'),
    ('alias@example.test','<script>alert(1)</script>');
`);
const suppressionBefore = db.prepare('SELECT email,reason,added_at FROM suppression_list ORDER BY email').all();
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

test('contact details identify case-insensitive suppression for primary and aliases without changing evidence', async () => {
  const response = await fetch(`${base}/api/leads/51`);
  assert.equal(response.status, 200);
  const lead = await response.json();
  const primary = lead.emails.find(email => email.email === 'Primary@Example.Test');
  const alias = lead.emails.find(email => email.email === 'Alias@Example.Test');
  const safe = lead.emails.find(email => email.email === 'safe@example.test');
  assert.equal(primary.is_suppressed, 1);
  assert.equal(primary.suppression_reason, 'one_click_unsubscribe');
  assert.equal(alias.is_suppressed, 1);
  assert.equal(alias.suppression_reason, '<script>alert(1)</script>');
  assert.equal(safe.is_suppressed, 0);
  assert.equal(safe.suppression_reason, null);
  assert.equal(primary.verification_status, 'deliverable');
  assert.equal(primary.verified_at, '2026-10-01 12:00:00');
  assert.equal(alias.verification_status, 'risky');
  assert.equal(alias.verified_at, '2026-10-02 12:00:00');

  const html = renderLeadDetail({ ...lead, tags: [], events: [], customFields: [] });
  assert.equal((html.match(/contact-suppression-badge/g) || []).length, 2);
  assert.match(html, /Suppressed · one_click_unsubscribe/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'operator-provided reason is escaped before rendering');
  assert.match(html, /safe@example\.test/);
  assert.equal(db.prepare('SELECT email,reason,added_at FROM suppression_list ORDER BY email').all().length, suppressionBefore.length);
  assert.deepEqual(db.prepare('SELECT email,reason,added_at FROM suppression_list ORDER BY email').all(), suppressionBefore,
    'reading contact details does not mutate global suppression');
});
