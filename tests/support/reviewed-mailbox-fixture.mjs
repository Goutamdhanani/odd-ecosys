// Explicit disposable-fixture prerequisite for tests of downstream SMTP policy.
// This helper installs no hooks and grants no product-wide test bypass.
export function seedSyntheticCampaignSendReview(db, mailboxIds, evidence = {}) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Synthetic mailbox reviews require NODE_ENV=test.');
  for (const mailboxId of [].concat(mailboxIds)) {
    const mailbox = db.prepare('SELECT id,email FROM mailboxes WHERE id=?').get(mailboxId);
    if (!mailbox || !/@[^@]+\.(?:test|invalid)$/i.test(mailbox.email)) {
      throw new Error('Synthetic reviews require an explicitly saved .test or .invalid mailbox.');
    }
    db.prepare(`INSERT INTO mailbox_warmup_reviews(mailbox_id,decision,policy_version,evidence_json,reviewed_at)
      VALUES(?,'approved','smtp-imap-source-evidence-v2',?,datetime('now'))
      ON CONFLICT(mailbox_id) DO UPDATE SET decision=excluded.decision,policy_version=excluded.policy_version,
        evidence_json=excluded.evidence_json,reviewed_at=excluded.reviewed_at`)
      .run(mailboxId, JSON.stringify({ fixture: 'synthetic pre-reviewed sender; no real warmup or inbox-placement proof', ...evidence }));
  }
}
