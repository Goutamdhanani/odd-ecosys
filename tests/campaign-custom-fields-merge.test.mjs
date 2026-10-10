import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-custom-merge-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Custom merge fixture','test','open')").run().lastInsertRowid);
const acceptedMessages = [];
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  logger: false,
  onAuth(auth, _session, callback) {
    if (auth.username !== 'fixture' || auth.password !== 'fixture-only') return callback(new Error('Fixture credentials rejected.'));
    callback(null, { user: 'fixture' });
  },
  onData(stream, session, callback) {
    let raw = '';
    stream.on('data', chunk => { raw += chunk; });
    stream.on('end', () => {
      acceptedMessages.push({ raw, recipients: session.envelope.rcptTo.map(item => item.address) });
      callback(null, 'Custom merge fixture accepted.');
    });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });
db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
  smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
  VALUES (880,'merge-sender@example.test','example.test','eligible',20,100,1,'127.0.0.1',?,?, 'fixture-only',0)`)
  .run(smtp.server.address().port, 'fixture');

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
const worker = await import('../pipeline/sending-engine.js');

after(async () => {
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => smtp.close(resolve)),
  ]);
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* Preserve status for an empty response. */ }
  return { status: response.status, body: payload };
}

async function makeStep(campaignId, position, variants) {
  const created = await request(`/api/sending/campaigns/${campaignId}/sequence/steps`, {
    method: 'POST', body: position > 1 ? { delayDays: 1 } : {},
  });
  assert.equal(created.status, 201, created.body.error);
  const step = created.body.steps.at(-1);
  const updated = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${step.id}`, {
    method: 'PUT', body: { variants },
  });
  assert.equal(updated.status, 200, updated.body.error);
  return step.id;
}

test('custom field merge previews bind review/launch copy and render actual sequence sends through SMTP', async () => {
  const [segmentResponse, priceResponse, trialResponse, noteResponse] = await Promise.all([
    request('/api/contact-fields', { method: 'POST', body: { name: 'Market segment', type: 'text', required: true } }),
    request('/api/contact-fields', { method: 'POST', body: { name: 'Contract value', type: 'number' } }),
    request('/api/contact-fields', { method: 'POST', body: { name: 'Trial enabled', type: 'boolean' } }),
    request('/api/contact-fields', { method: 'POST', body: { name: 'Contact note', type: 'text' } }),
  ]);
  assert.deepEqual([segmentResponse.status, priceResponse.status, trialResponse.status, noteResponse.status], [201, 201, 201, 201]);
  const fields = [segmentResponse.body, priceResponse.body, trialResponse.body, noteResponse.body];
  const contact = await request('/api/leads', { method: 'POST', body: {
    batch_id: batchId,
    business_name: 'Custom Merge Studio',
    email: 'merge-contact@example.test',
    custom_fields: {
      market_segment: 'SaaS',
      contract_value: 42.5,
      trial_enabled: false,
      contact_note: '',
    },
  } });
  assert.equal(contact.status, 201, contact.body.error);
  const leadId = contact.body.contact.id;
  db.prepare("UPDATE lead_emails SET verification_status='deliverable',verified_at=datetime('now') WHERE lead_id=?").run(leadId);
  db.prepare("UPDATE leads SET status='queued' WHERE id=?").run(leadId);
  db.prepare(`INSERT INTO personalizations(lead_id,subject_line,body_text,approved,guardrail_passed,fact_check_passed)
    VALUES(?,'Approved system copy','Approved system personalization',1,1,1)`).run(leadId);

  const secondContact = await request('/api/leads', { method: 'POST', body: {
    batch_id: batchId,
    business_name: 'Second Merge Studio',
    email: 'second-merge-contact@example.test',
    custom_fields: {
      market_segment: 'Services',
      contract_value: 21,
      trial_enabled: true,
      contact_note: 'second contact',
    },
  } });
  assert.equal(secondContact.status, 201, secondContact.body.error);
  const secondLeadId = secondContact.body.contact.id;
  db.prepare("UPDATE lead_emails SET verification_status='deliverable',verified_at=datetime('now') WHERE lead_id=?").run(secondLeadId);
  db.prepare("UPDATE leads SET status='queued' WHERE id=?").run(secondLeadId);
  db.prepare(`INSERT INTO personalizations(lead_id,subject_line,body_text,approved,guardrail_passed,fact_check_passed)
    VALUES(?,'Approved system copy','Approved system personalization',1,1,1)`).run(secondLeadId);

  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Custom merge sequence' } });
  assert.equal(campaign.status, 200, campaign.body.error);
  const campaignId = campaign.body.id;
  const enrolled = await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { leadIds: [leadId] } });
  assert.equal(enrolled.status, 200, enrolled.body.error);
  const selectedSender = await request(`/api/sending/campaigns/${campaignId}/senders`, { method: 'PUT', body: { mailboxIds: [880] } });
  assert.equal(selectedSender.status, 200, selectedSender.body.error);

  const firstStep = await makeStep(campaignId, 1, [
    { variantKey: 'A', allocationPct: 100, subjectLine: 'A plan for {{custom.market_segment}}',
      bodyText: 'Value {{custom.contract_value}}; trial {{custom.trial_enabled}}; note {{custom.contact_note|no note}}.' },
    { variantKey: 'B', allocationPct: 0, subjectLine: '', bodyText: '' },
  ]);
  const secondStep = await makeStep(campaignId, 2, [
    { variantKey: 'A', allocationPct: 100, subjectLine: 'Following up with {{custom.market_segment}}',
      bodyText: 'The saved value is {{custom.contract_value}}.' },
    { variantKey: 'B', allocationPct: 0, subjectLine: '', bodyText: '' },
  ]);
  const thirdStep = await makeStep(campaignId, 3, [
    { variantKey: 'A', allocationPct: 100, subjectLine: 'One final note',
      bodyText: 'This missing field must stop safely: {{custom.not_a_real_field}}.' },
    { variantKey: 'B', allocationPct: 0, subjectLine: '', bodyText: '' },
  ]);

  const preview = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${firstStep}/preview`, {
    method: 'POST', body: { leadId, variantKey: 'A' },
  });
  assert.equal(preview.status, 200, preview.body.error);
  assert.equal(preview.body.ready, true);
  assert.equal(preview.body.subject, 'A plan for SaaS');
  assert.equal(preview.body.body, 'Value 42.5; trial false; note no note.');
  assert.deepEqual(preview.body.unresolvedTokens, []);
  const unresolved = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${thirdStep}/preview`, {
    method: 'POST', body: { leadId, variantKey: 'A' },
  });
  assert.equal(unresolved.body.ready, false);
  assert.deepEqual(unresolved.body.unresolvedTokens, ['custom.not_a_real_field']);

  const beforeEditReview = await request(`/api/sending/campaigns/${campaignId}/preflight`);
  assert.match(beforeEditReview.body.recipients.find(item => item.contactId === leadId).sequenceCopyHash, /^[a-f0-9]{64}$/);
  const edit = await request(`/api/leads/${leadId}`, { method: 'PATCH', body: {
    custom_fields: { contract_value: 45 },
  } });
  assert.equal(edit.status, 200, edit.body.error);
  assert.equal(edit.body.reviewRequired, true);
  db.prepare('UPDATE personalizations SET approved=1,guardrail_passed=1,fact_check_passed=1 WHERE lead_id=?').run(leadId);
  const staleQueue = await request(`/api/sending/queue/${campaignId}`, {
    method: 'POST', body: { limit: 5, reviewHash: beforeEditReview.body.reviewHash },
  });
  assert.equal(staleQueue.status, 409, 'a custom-value change invalidates the previous launch review');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 0);

  const currentReview = await request(`/api/sending/campaigns/${campaignId}/preflight`);
  assert.equal(currentReview.body.ready, true, JSON.stringify(currentReview.body.blockers));
  const queued = await request(`/api/sending/queue/${campaignId}`, {
    method: 'POST', body: { limit: 5, reviewHash: currentReview.body.reviewHash },
  });
  assert.equal(queued.status, 200, queued.body.error);
  assert.equal(queued.body.queued, 1);
  const launch = db.prepare('SELECT snapshot_json,snapshot_hash FROM campaign_launches WHERE campaign_id=?').get(campaignId);
  assert.ok(launch);
  assert.doesNotMatch(launch.snapshot_json, /SaaS|45\.0|merge-contact@example\.test/, 'launch evidence stores a contact-field digest rather than copying raw custom values');
  const firstSend = db.prepare('SELECT * FROM sends WHERE campaign_id=? AND campaign_step_id=?').get(campaignId, firstStep);
  assert.equal(firstSend.subject_snapshot, 'A plan for SaaS');
  assert.equal(firstSend.body_snapshot, 'Value 45; trial false; note no note.');
  assert.equal(firstSend.campaign_launch_id, db.prepare('SELECT id FROM campaign_launches WHERE campaign_id=?').get(campaignId).id);

  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(firstSend.id);
  const firstOutcome = await worker.processSendQueue({ limit: 10 });
  assert.equal(firstOutcome.sent, 1, JSON.stringify(firstOutcome));
  assert.equal(acceptedMessages.length, 1, 'loopback SMTP observed the first step submission');
  assert.deepEqual(acceptedMessages[0].recipients, ['merge-contact@example.test']);
  assert.match(acceptedMessages[0].raw, /Subject: A plan for SaaS/i);
  assert.match(acceptedMessages[0].raw, /Value 45; trial false; note no note\./);
  const firstSentEvent = db.prepare("SELECT meta_json FROM events WHERE event_type='sent' AND send_id=?").get(firstSend.id);
  assert.equal(JSON.parse(firstSentEvent.meta_json).delivery, 'unknown');

  const followup = db.prepare('SELECT * FROM sends WHERE campaign_id=? AND campaign_step_id=?').get(campaignId, secondStep);
  assert.ok(followup, 'the accepted first step scheduled its durable next step');
  assert.equal(followup.subject_snapshot, 'Following up with SaaS');
  assert.equal(followup.body_snapshot, 'The saved value is 45.');
  assert.equal(followup.campaign_launch_id, firstSend.campaign_launch_id);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(followup.id);
  const followupOutcome = await worker.processSendQueue({ limit: 10 });
  assert.equal(followupOutcome.sent, 1, JSON.stringify(followupOutcome));
  assert.equal(acceptedMessages.length, 2, 'loopback SMTP observed the rendered follow-up');
  assert.match(acceptedMessages[1].raw, /Subject: Following up with SaaS/i);
  assert.match(acceptedMessages[1].raw, /The saved value is 45\./);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=? AND campaign_step_id=?').get(campaignId, thirdStep).count, 0,
    'an unresolved custom merge field blocks a later follow-up instead of sending a literal token');
  assert.equal(db.prepare('SELECT status FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(campaignId, leadId).status, 'stopped');
  const stopped = db.prepare("SELECT meta_json FROM events WHERE event_type='campaign_sequence_stopped' AND lead_id=? ORDER BY id DESC LIMIT 1").get(leadId);
  assert.equal(JSON.parse(stopped.meta_json).reason, 'step_3_merge_fields_unresolved');

  const driftCampaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Custom merge drift guard' } });
  assert.equal(driftCampaign.status, 200, driftCampaign.body.error);
  const driftCampaignId = driftCampaign.body.id;
  const driftEnrollment = await request(`/api/sending/campaigns/${driftCampaignId}/audience`, { method: 'POST', body: { leadIds: [secondLeadId] } });
  assert.equal(driftEnrollment.status, 200, driftEnrollment.body.error);
  const driftSender = await request(`/api/sending/campaigns/${driftCampaignId}/senders`, { method: 'PUT', body: { mailboxIds: [880] } });
  assert.equal(driftSender.status, 200, driftSender.body.error);
  const driftStep = await makeStep(driftCampaignId, 1, [
    { variantKey: 'A', allocationPct: 100, subjectLine: 'Launch value {{custom.contract_value}}', bodyText: 'Approved after review.' },
    { variantKey: 'B', allocationPct: 0, subjectLine: '', bodyText: '' },
  ]);
  const driftReview = await request(`/api/sending/campaigns/${driftCampaignId}/preflight`);
  assert.equal(driftReview.body.ready, true, JSON.stringify(driftReview.body.blockers));
  const driftQueue = await request(`/api/sending/queue/${driftCampaignId}`, {
    method: 'POST', body: { limit: 5, reviewHash: driftReview.body.reviewHash },
  });
  assert.equal(driftQueue.status, 200, driftQueue.body.error);
  const driftSend = db.prepare('SELECT * FROM sends WHERE campaign_id=? AND lead_id=? AND campaign_step_id=?').get(driftCampaignId, secondLeadId, driftStep);
  assert.ok(driftSend);
  const contractFieldId = db.prepare("SELECT id FROM contact_field_definitions WHERE field_key='contract_value'").get().id;
  // Simulate a custom-data write racing the worker after queueing. The API normally cancels
  // these rows as soon as profile data changes, but the launch snapshot must independently
  // fail closed if a write bypasses that invalidation path.
  db.prepare(`UPDATE lead_custom_field_values SET value_json='99',updated_at=datetime('now')
    WHERE lead_id=? AND field_id=?`).run(secondLeadId, contractFieldId);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(driftSend.id);
  const driftOutcome = await worker.processSendQueue({ limit: 10 });
  assert.equal(driftOutcome.sent, 0, JSON.stringify(driftOutcome));
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(driftSend.id).status, 'cancelled', 'custom-value drift after queueing is rejected by the worker');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE send_id=? AND event_type='campaign_launch_configuration_mismatch'").get(driftSend.id).count, 1);
  assert.equal(acceptedMessages.length, 2, 'custom-data drift is blocked before a third loopback SMTP submission');
});
