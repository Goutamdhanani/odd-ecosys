import { seedSyntheticCampaignSendReview } from './support/reviewed-mailbox-fixture.mjs';
import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-click-tracking-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.sqlite');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.ODD_PUBLIC_BASE_URL = 'https://mail.test.invalid';
delete process.env.HOST;

const database = await import('../pipeline/database.js');
let db = database.initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
const sending = await import('../pipeline/sending-engine.js');
const clickTracking = await import('../pipeline/click-tracking.js');

const acceptedMessages = [];
let dropNextSmtpReply = false;
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false,
  onAuth(auth, _session, callback) {
    if (auth.username !== 'fixture' || auth.password !== 'fixture-only') return callback(new Error('Fixture auth rejected'));
    callback(null, { user: 'fixture' });
  },
  onData(stream, session, callback) {
    let raw = '';
    stream.on('data', chunk => { raw += chunk; });
    stream.on('end', () => {
      acceptedMessages.push(raw);
      if (dropNextSmtpReply) {
        dropNextSmtpReply = false;
        for (const connection of smtp.connections) connection._socket.destroy();
        return;
      }
      callback(null, 'Fixture accepted');
    });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });

after(async () => {
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => smtp.close(resolve))]);
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, body: payload };
}

test('campaign opt-in rewrites only plain-text HTTP links and stored opaque links redirect with truthful request evidence', async t => {
  const created = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Optional tracking' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const campaignId = Number(created.body.id);
  assert.equal(created.body.trackClicks, false, 'campaign click tracking defaults off');
  assert.equal(db.prepare('SELECT track_clicks FROM campaigns WHERE id=?').get(campaignId).track_clicks, 0);

  const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (fs.existsSync(edgePath)) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
      await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(async () => {
        const { renderCampaigns } = await import('/js/campaigns.js');
        const root = document.createElement('main');
        root.id = 'main-content';
        document.body.append(root);
        await renderCampaigns(root);
      });
      const card = page.locator('.campaign-card').first();
      await card.getByRole('button', { name: 'Edit draft' }).click();
      const dialog = page.getByRole('dialog').last();
      await dialog.getByRole('checkbox', { name: /Track link requests/ }).check();
      await dialog.getByRole('button', { name: 'Save draft' }).click();
      await card.getByText(/link tracking on/).waitFor({ state: 'visible' });
      assert.match(await card.innerText(), /Link requests\s+—/);
      assert.doesNotMatch(await card.innerText(), /Open %|Open signals/);
      assert.deepEqual(pageErrors, []);
    } finally { await browser.close(); }
  } else {
    t.diagnostic('Edge is unavailable; campaign tracking setting was exercised through its authenticated API contract instead of the browser.');
    const enabled = await request(`/api/sending/campaigns/${campaignId}`, {
      method: 'PATCH', body: { name: 'Optional tracking', trackClicks: true },
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  }

  assert.equal(db.prepare('SELECT track_clicks FROM campaigns WHERE id=?').get(campaignId).track_clicks, 1);
  const invalid = await request(`/api/sending/campaigns/${campaignId}`, {
    method: 'PATCH', body: { name: 'Optional tracking', trackClicks: 'yes' },
  });
  assert.equal(invalid.status, 400);

  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (771,'Synthetic recipient','person@example.test','queued')").run();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status) VALUES (771,'person@example.test','deliverable')").run();
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES(771,'sender@example.test','example.test','eligible',100,100,1,'127.0.0.1',?,?, 'fixture-only',0)`)
    .run(smtp.server.address().port, 'fixture');
  seedSyntheticCampaignSendReview(db, 771);
  const body = 'Read the details at https://destination.example.test/guide?q=one. Do not track javascript:alert(1) or http://[bad.';
  db.prepare(`INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed,fact_check_passed)
    VALUES(771,771,'A useful note',?,1,1,1)`).run(body);
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES(?,771)').run(campaignId);
  db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,personalization_id,scheduled_at,status)
    VALUES(771,771,771,?,?,?,'scheduled')`)
    .run(campaignId, 771, new Date(Date.now() - 60_000).toISOString());

  db.prepare("UPDATE sends SET status='processing' WHERE id=771").run();
  const html = clickTracking.rewriteTrackedMessageBody(771, '<p>See <a href="https://html.example.test/">the page</a></p>');
  assert.deepEqual(html, { text: '<p>See <a href="https://html.example.test/">the page</a></p>', trackedLinkCount: 0 },
    'HTML-looking messages remain unchanged');
  db.prepare("UPDATE sends SET status='scheduled' WHERE id=771").run();

  db.prepare("INSERT INTO campaigns(name,track_clicks) VALUES('Tracking off',0)").run();
  const offCampaignId = Number(db.prepare("SELECT id FROM campaigns WHERE name='Tracking off'").get().id);
  db.prepare("INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,personalization_id,scheduled_at,status) VALUES(772,771,771,?,771,datetime('now'),'processing')").run(offCampaignId);
  assert.deepEqual(clickTracking.rewriteTrackedMessageBody(772, body), { text: body, trackedLinkCount: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_click_links WHERE send_id=772').get().count, 0);
  db.prepare("UPDATE sends SET status='cancelled' WHERE id=772").run();
  assert.ok(offCampaignId > 0);

  const processed = await sending.processSendQueue({ limit: 1 });
  assert.equal(processed.sent, 1, JSON.stringify({ processed, events: db.prepare('SELECT event_type,meta_json FROM events ORDER BY id').all(), send: db.prepare('SELECT status,error_message FROM sends WHERE id=771').get() }));
  assert.equal(acceptedMessages.length, 1, 'loopback SMTP received one actual accepted DATA message');
  const decodedMessage = acceptedMessages[0].replace(/=\r?\n/g, '').replace(/=([a-f0-9]{2})/gi, (_match, byte) => String.fromCharCode(parseInt(byte, 16)));
  const tokenMatch = decodedMessage.match(/https:\/\/mail\.test\.invalid\/t\/([A-Za-z0-9_-]{43})/);
  assert.ok(tokenMatch, decodedMessage);
  const token = tokenMatch[1];
  assert.match(decodedMessage, /Do not track javascript:alert\(1\) or http:\/\/\[bad\./);
  assert.doesNotMatch(decodedMessage, /\/api\/track\/(?:open|click)\//);
  const link = db.prepare('SELECT * FROM campaign_click_links WHERE send_id=771').get();
  assert.ok(link);
  assert.equal(link.target_url, 'https://destination.example.test/guide?q=one');
  assert.equal(link.token_hash.length, 64);
  assert.doesNotMatch(JSON.stringify(link), new RegExp(token));

  const first = await fetch(`${base}/t/${token}?url=https%3A%2F%2Fattacker.example.test`, { redirect: 'manual' });
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('location'), link.target_url, 'caller query cannot choose the redirect destination');
  assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE send_id=771 AND event_type='tracked_link_requested'").get().count, 1);

  database.closeDb();
  db = database.initDb();
  const replay = await fetch(`${base}/t/${token}`, { redirect: 'manual' });
  assert.equal(replay.status, 302, 'the opaque link survives database reopen');
  assert.equal(replay.headers.get('location'), link.target_url);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE send_id=771 AND event_type='tracked_link_requested'").get().count, 1,
    'repeat requests do not multiply click-event analytics');
  assert.equal(db.prepare('SELECT request_count FROM campaign_click_links WHERE send_id=771').get().request_count, 2);

  const unknown = await fetch(`${base}/t/${'A'.repeat(43)}`, { redirect: 'manual' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('location'), null);
  const legacy = await fetch(`${base}/api/track/click/771?url=https%3A%2F%2Fattacker.example.test`, { redirect: 'manual' });
  assert.equal(legacy.status, 410);
  assert.equal(legacy.headers.get('location'), null);

  const history = await request(`/api/sending/campaigns/${campaignId}/delivery-history`);
  assert.equal(history.status, 200);
  assert.equal(history.body.items.find(item => item.sendId === 771).clickTrackingEnabled, true);
  assert.equal(history.body.items.find(item => item.sendId === 771).trackedLinkRequests, 2);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=771').get().status, 'sent');

  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (772,'Ambiguous tracking recipient','uncertain@example.test','queued')").run();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status) VALUES (772,'uncertain@example.test','deliverable')").run();
  db.prepare("INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed,fact_check_passed) VALUES (772,772,'Ambiguous tracking','Please review https://uncertain.example.test/notice',1,1,1)").run();
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES(?,772)').run(campaignId);
  db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,personalization_id,scheduled_at,status)
    VALUES(773,772,771,?,?,?,'scheduled')`)
    .run(campaignId, 772, new Date(Date.now() - 60_000).toISOString());

  dropNextSmtpReply = true;
  const ambiguous = await sending.processSendQueue({ limit: 1 });
  assert.equal(ambiguous.uncertain, 1, JSON.stringify(ambiguous));
  assert.equal(acceptedMessages.length, 2, 'the SMTP sink captured DATA before withholding its final response');
  const uncertainMessage = acceptedMessages[1].replace(/=\r?\n/g, '').replace(/=([a-f0-9]{2})/gi, (_match, byte) => String.fromCharCode(parseInt(byte, 16)));
  const uncertainToken = uncertainMessage.match(/https:\/\/mail\.test\.invalid\/t\/([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(uncertainToken, uncertainMessage);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=773').get().status, 'uncertain');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_click_links WHERE send_id=773').get().count, 1,
    'an ambiguous submission retains links in case the recipient received it');
  assert.equal((await sending.processSendQueue({ limit: 1 })).processed, 0);
  assert.equal(acceptedMessages.length, 2, 'uncertain sends never trigger an automatic SMTP retry');
  const uncertainRedirect = await fetch(`${base}/t/${uncertainToken}`, { redirect: 'manual' });
  assert.equal(uncertainRedirect.status, 302, 'the original message links remain usable for an uncertain submission');
  assert.equal(uncertainRedirect.headers.get('location'), 'https://uncertain.example.test/notice');
  const campaignList = await request('/api/sending/campaigns');
  assert.equal(campaignList.status, 200);
  const campaignStats = campaignList.body.find(item => item.id === campaignId);
  assert.equal(campaignStats.tracked_link_requests, 3, 'campaign totals use actual stored requests across accepted and uncertain sends');
  assert.equal(campaignStats.opened, undefined, 'retired open metrics are not returned by the campaign API');
});
