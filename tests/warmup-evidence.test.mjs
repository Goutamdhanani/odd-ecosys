import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-warmup-evidence-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const database = await import('../pipeline/database.js');
let db = database.initDb();
const engine = await import('../pipeline/sending-engine.js');

after(() => {
  database.closeDb();
  delete process.env.ODD_DB_PATH;
  delete process.env.ODD_CREDENTIAL_ENCRYPTION_KEY;
  rmSync(directory, { recursive: true, force: true });
});

function insertMailbox(id, email, { status = 'warming', startedAt = '2000-01-01T00:00:00.000Z' } = {}) {
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,warmup_started_at,daily_limit,health_score,active)
    VALUES(?,?,?,?,?,40,95,1)`).run(id, email, email.split('@')[1], status, startedAt);
}

test('calendar time and generic mailbox edits never grant campaign eligibility', () => {
  insertMailbox(1, 'old-sender@example.test');
  engine.updateMailbox(1, { smtp_host: 'smtp.example.test', smtp_port: 587, smtp_user: 'old-sender@example.test', smtp_pass: 'fixture-password', smtp_secure: false });
  const ramp = engine.processWarmupTransitions();
  assert.equal(ramp.checked, 1);
  assert.deepEqual(ramp.transitioned, []);
  assert.equal(ramp.awaitingReview[0].schedule.rampComplete, true);
  assert.equal(ramp.awaitingReview[0].schedule.scheduleOnly, true);
  assert.equal(db.prepare('SELECT warmup_status FROM mailboxes WHERE id=1').get().warmup_status, 'warming');
  assert.throws(() => engine.updateMailbox(1, { warmup_status: 'eligible' }), /explicit pause, activate, retire, or sending-review/);
  assert.throws(() => engine.reviewMailboxForCampaignSending(1, { decision: 'approve', acknowledgeEvidenceLimits: true, actor: { id: 2, role: 'operator' } }), /owner or admin/);
  assert.throws(() => engine.reviewMailboxForCampaignSending(1, { decision: 'approve', acknowledgeEvidenceLimits: true, actor: { id: 1, role: 'owner' } }), /SMTP-accepted send record/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mailbox_warmup_reviews').get().n, 0);
});

test('approval requires source-backed send and inbound evidence, explicit owner review, and persists review history', () => {
  insertMailbox(2, 'sender@example.test');
  engine.updateMailbox(2, {
    smtp_host: 'smtp.example.test', smtp_port: 587, smtp_user: 'sender@example.test', smtp_pass: 'fixture-password', smtp_secure: false,
    imap_host: 'imap.example.test', imap_port: 993, imap_user: 'sender@example.test', imap_pass: 'fixture-imap-password', imap_secure: true,
  });
  const send = db.prepare("INSERT INTO sends(id,mailbox_id,status,sent_at) VALUES(20,2,'sent',datetime('now'))").run();
  db.prepare("INSERT INTO events(send_id,event_type,event_at,meta_json) VALUES(20,'sent',datetime('now'),?)")
    .run(JSON.stringify({ messageId: '<fixture@example.test>', response: '250 accepted' }));
  db.prepare(`INSERT INTO imap_sync_mailbox_state(mailbox_id,last_success_at,last_fetched,last_imported,last_duplicates,last_skipped,last_cursor_uid)
    VALUES(2,datetime('now'),1,1,0,0,77)`).run();
  db.prepare("INSERT INTO events(event_type,event_at,meta_json) VALUES('replied',datetime('now'),?)")
    .run(JSON.stringify({ from: 'person@example.test', to: 'sender@example.test', receivedTo: 'sender@example.test', receivedAt: new Date().toISOString() }));

  const fleet = engine.getMailboxFleet({ canReviewSendAccess: true });
  const card = fleet.find(mailbox => mailbox.id === 2);
  assert.equal(card.warmup_evidence.outbound.source, 'SMTP-accepted send records');
  assert.equal(card.warmup_evidence.outbound.count, 1);
  assert.ok(card.warmup_evidence.outbound.latest.eventId > 0);
  assert.equal(card.warmup_evidence.inbound.source, 'saved inbound mailbox events');
  assert.equal(card.warmup_evidence.inbound.count, 1);
  assert.ok(card.warmup_evidence.inbound.latest.eventId > 0);
  assert.equal(card.warmup_evidence.imap.fetched, 1);
  assert.equal(card.warmup_approval.allowed, true);
  assert.equal(card.can_review_warmup, true);
  assert.equal(Object.hasOwn(card, 'smtp_pass'), false);
  assert.equal(Object.hasOwn(card, 'imap_pass'), false);

  assert.throws(() => engine.reviewMailboxForCampaignSending(2, { decision: 'approve', actor: { id: 1, role: 'owner' } }), /Confirm that these records show email activity/);
  const approval = engine.reviewMailboxForCampaignSending(2, {
    decision: 'approve', acknowledgeEvidenceLimits: true, actor: { id: 1, role: 'owner' },
  });
  assert.equal(approval.decision, 'approved');
  assert.match(approval.policyVersion, /v2/);
  assert.equal(db.prepare('SELECT warmup_status FROM mailboxes WHERE id=2').get().warmup_status, 'eligible');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mailbox_warmup_review_history WHERE mailbox_id=2').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends WHERE mailbox_id=2').get().n, 1, 'review creates no sends');

  engine.reviewMailboxForCampaignSending(2, { decision: 'hold', actor: { id: 1, role: 'owner' } });
  assert.equal(db.prepare('SELECT warmup_status FROM mailboxes WHERE id=2').get().warmup_status, 'warming');
  assert.equal(db.prepare("SELECT decision FROM mailbox_warmup_reviews WHERE mailbox_id=2").get().decision, 'held');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mailbox_warmup_review_history WHERE mailbox_id=2').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 1, 'hold creates no sends');
});

test('startup retains old review evidence and demotes legacy age-based eligibility without deleting activity', () => {
  insertMailbox(9, 'legacy@example.test', { status: 'eligible', startedAt: '2000-01-01T00:00:00.000Z' });
  db.prepare(`INSERT INTO mailbox_warmup_reviews(mailbox_id,decision,policy_version,evidence_json,reviewed_by,reviewed_at)
    VALUES(9,'approved','smtp-and-inbox-activity-v1','{"legacyEvidence":true}',4,'2026-10-01T10:00:00.000Z')`).run();
  db.prepare("INSERT INTO sends(id,mailbox_id,status,sent_at) VALUES(90,9,'sent',datetime('now'))").run();
  db.prepare('DELETE FROM schema_migrations').run();

  database.closeDb();
  db = database.initDb();

  assert.equal(db.prepare('SELECT warmup_status FROM mailboxes WHERE id=9').get().warmup_status, 'warming');
  assert.equal(db.prepare('SELECT daily_limit FROM mailboxes WHERE id=9').get().daily_limit, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sends WHERE mailbox_id=9 AND status='sent'").get().n, 1);
  const old = db.prepare("SELECT evidence_json FROM mailbox_warmup_review_history WHERE mailbox_id=9 AND policy_version='smtp-and-inbox-activity-v1'").get();
  assert.equal(JSON.parse(old.evidence_json).legacyEvidence, true);
  assert.equal(db.prepare("SELECT decision FROM mailbox_warmup_reviews WHERE mailbox_id=9").get().decision, 'held');
  assert.ok(db.prepare("SELECT 1 FROM mailbox_warmup_review_history WHERE mailbox_id=9 AND policy_version='smtp-imap-source-evidence-v2' AND decision='held'").get());
});
