import './support/all-hours-send-window.js';
import { seedSyntheticCampaignSendReview } from './support/reviewed-mailbox-fixture.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-sender-rotation-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
const database = await import('../pipeline/database.js');
let db = database.initDb();
const engine = await import('../pipeline/sending-engine.js');

after(() => {
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('campaign sender rotation is weighted, deterministic, capacity-aware, and resumes from persisted state', () => {
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES(1,'healthy@rotation.test','rotation.test','eligible',100,80,1,'smtp.rotation.test',587,'fixture','fixture-only',0),
          (2,'steady@rotation.test','rotation.test','eligible',100,40,1,'smtp.rotation.test',587,'fixture','fixture-only',0),
          (3,'paused@rotation.test','rotation.test','paused',100,100,1,'smtp.rotation.test',587,'fixture','fixture-only',0)`).run();
  const reviewEvidence = JSON.stringify({
    outbound: { source: 'accepted_sends', count: 1, latestAt: '2026-10-24T10:00:00.000Z' },
    replies: { source: 'attributed_inbound_reply_events', count: 0, latestAt: null },
    inbox: { source: 'imap_sync_mailbox_state', lastCheckedAt: '2026-10-24T10:05:00.000Z', fetched: 1, imported: 1, alreadyRecorded: 0, skipped: 0 },
  });
  seedSyntheticCampaignSendReview(db, [1, 2], JSON.parse(reviewEvidence));

  const firstFive = Array.from({ length: 5 }, () => engine.selectMailbox([1, 2, 3]).id);
  assert.deepEqual(firstFive, [1, 2, 1, 1, 2], 'smooth weighted round-robin gives the higher-health sender two shares for each one');
  const nextExpected = 1;
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mailbox_rotation_state WHERE pool_key='senders:1,2,3'").get().count, 2);

  database.closeDb();
  db = database.initDb();
  assert.equal(engine.selectMailbox([3, 2, 1]).id, nextExpected,
    'sender order is canonicalized and persisted rotation continues after the database reopens');
  db.prepare("UPDATE mailboxes SET daily_limit=2 WHERE id=1").run();
  db.prepare("INSERT INTO sends(lead_id,mailbox_id,campaign_id,scheduled_at,sent_at,status) VALUES(NULL,1,NULL,datetime('now'),datetime('now'),'sent'),(NULL,1,NULL,datetime('now'),datetime('now'),'sent')").run();
  assert.equal(engine.selectMailbox([1, 2, 3]).id, 2, 'the exhausted mailbox is skipped while a capacity-eligible sender remains');
});
