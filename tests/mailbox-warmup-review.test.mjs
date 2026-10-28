import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const directory = mkdtempSync(path.join(tmpdir(), 'odd-warmup-review-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const database = await import('../pipeline/database.js');
let db = database.initDb();
db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,warmup_started_at,daily_limit,health_score,active,
  smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
  VALUES(1,'sender@example.test','example.test','eligible',?,0,100,1,'smtp.example.test',587,'fixture','fixture-only',0)`)
  .run(new Date(Date.now() - 40 * 86400000).toISOString());
db.prepare("INSERT INTO campaigns(id,name,status) VALUES(1,'Warmup gate fixture','active')").run();
db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES(1,'Synthetic contact','recipient@example.test','sent')").run();
db.prepare("INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed) VALUES(1,1,'Hello','Fixture',1,1)").run();
db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,personalization_id,status,sent_at,scheduled_at)
  VALUES(1,1,1,1,1,'sent',datetime('now'),datetime('now'))`).run();
db.prepare(`INSERT INTO imap_sync_mailbox_state(mailbox_id,last_success_at,last_fetched,last_imported,last_duplicates,last_skipped)
  VALUES(1,datetime('now'),2,1,1,0)`).run();
db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,warmup_started_at,daily_limit,health_score,active)
  VALUES(2,'new@example.test','example.test','warming',datetime('now'),0,10,1)`).run();

db.prepare("INSERT INTO events(lead_id,send_id,event_type,meta_json) VALUES(1,1,'sent','{}')").run();
db.prepare("INSERT INTO events(lead_id,send_id,event_type,meta_json) VALUES(1,1,'replied',?)").run(JSON.stringify({to:'sender@example.test'}));

const { server } = await import('../server.js');
const engine = await import('../pipeline/sending-engine.js');
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

async function post(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('only a persisted owner review makes an eligible mailbox selectable; configuration edits revoke it', async () => {
  const tooEarly = await post('/api/sending/mailboxes/2/warmup-review', { decision: 'approve', acknowledgeEvidenceLimits: true });
  assert.equal(tooEarly.status, 409);
  assert.match(tooEarly.body.error, /health is below/i);
  db.prepare('UPDATE mailboxes SET warmup_started_at=?,health_score=100 WHERE id=2')
    .run(new Date(Date.now() - 40 * 86400000).toISOString());
  const calendarCheck = await post('/api/sending/warmup-check', {});
  assert.equal(calendarCheck.status, 200);
  assert.equal(calendarCheck.body.transitioned.length, 0, 'calendar age never automatically enables campaign sends');
  assert.ok(calendarCheck.body.awaitingReview.some(mailbox => mailbox.id === 2));
  assert.equal(db.prepare('SELECT warmup_status FROM mailboxes WHERE id=2').get().warmup_status, 'warming');
  const noActivity = await post('/api/sending/mailboxes/2/warmup-review', { decision: 'approve', acknowledgeEvidenceLimits: true });
  assert.equal(noActivity.status, 409);
  assert.match(noActivity.body.error, /SMTP|SMTP-accepted/i);

  assert.equal(engine.getCampaignSenderSelection(1).mailboxes.find(mailbox => mailbox.id === 1).readiness, 'warmup_review_required',
    'legacy eligible state without a review must not authorize campaign sending');
  assert.equal(engine.selectMailbox([1]), null);
  assert.throws(() => engine.updateMailbox(1, { warmup_status: 'eligible' }), error => error.statusCode === 400);
  assert.throws(() => engine.updateMailbox(1, { daily_limit: 500 }), /Daily|daily|limit/);

  const accepted = await post('/api/sending/mailboxes/1/warmup-review', { decision: 'approve', acknowledgeEvidenceLimits: true });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.decision, 'approved');
  assert.equal(accepted.body.evidence.outbound.count, 1);
  assert.equal(accepted.body.evidence.imap.fetched, 2);
  assert.equal(engine.getCampaignSenderSelection(1).mailboxes.find(mailbox => mailbox.id === 1).readiness, 'ready');
  assert.equal(engine.selectMailbox([1])?.id, 1);

  const fleet = engine.getMailboxFleet();
  assert.equal(fleet[0].warmup_review_approved, true);
  assert.equal(fleet[0].warmup_evidence.outbound.count, 1);
  assert.equal('smtp_pass' in fleet[0], false);

  database.closeDb();
  db = database.initDb();
  assert.equal(engine.getCampaignSenderSelection(1).mailboxes.find(mailbox => mailbox.id === 1).readiness, 'ready',
    'an evidence review survives reopening SQLite');

  engine.updateMailbox(1, { smtp_host: 'smtp.new.example.test' });
  assert.equal(engine.getCampaignSenderSelection(1).mailboxes.find(mailbox => mailbox.id === 1).readiness, 'warmup_review_required',
    'changing sending configuration revokes the prior review');
  assert.equal(engine.selectMailbox([1]), null);

  database.closeDb();
  db = database.initDb();
  assert.equal(engine.getCampaignSenderSelection(1).mailboxes.find(mailbox => mailbox.id === 1).readiness, 'warmup_review_required',
    'review invalidation survives reopening SQLite');
});

test('Mailbox UI shows the separate activity review and completes it through the API in Edge', async t => {
  const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || EDGE_PATH;
  if (!fs.existsSync(edgePath)) return t.skip('Microsoft Edge is unavailable on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const { renderMailboxes } = await import('/js/mailboxes.js');
      const root = document.createElement('main');
      root.id = 'warmup-review-fixture';
      document.body.append(root);
      await renderMailboxes(root);
    });
    const card = page.locator('#warmup-review-fixture .mailbox-card').first();
    await card.getByRole('button', { name: 'Allow campaign use' }).click();
    const confirmation = page.locator('dialog[open]');
    await confirmation.getByText(/do not prove inbox placement/i).waitFor({ state: 'visible' });
    await confirmation.getByRole('button', { name: 'Approve campaign use' }).click();
    await card.getByText('Owner/admin approved').waitFor({ state: 'visible' });
    await card.getByRole('button', { name: 'Keep blocked' }).click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Keep blocked' }).click();
    await card.getByText('Warming').waitFor({ state: 'visible' });
    await card.getByRole('button', { name: 'Allow campaign use' }).waitFor({ state: 'visible' });
    assert.match(await card.innerText(), /SMTP-accepted sends: 1/);
    assert.match(await card.innerText(), /2 messages fetched/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
