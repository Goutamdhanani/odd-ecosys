import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const directory = mkdtempSync(path.join(tmpdir(), 'odd-delivery-history-ui-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const database = await import('../pipeline/database.js');
const db = database.initDb();
db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES(1,'Synthetic Contact','recipient@example.test','sent')").run();
db.prepare("INSERT INTO campaigns(id,name,status) VALUES(1,'Delivery history fixture','completed')").run();
db.prepare("INSERT INTO mailboxes(id,email,domain) VALUES(1,'sender@example.test','example.test')").run();
for (const [id, email, messageId] of [
  [1, 'recipient@example.test', '<history-report@example.test>'],
  [2, 'no-report@example.test', '<history-none@example.test>'],
]) {
  if (id === 2) db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES(2,'No Report Contact',?,'sent')").run(email);
  db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,status,sent_at)
    VALUES(?,?,1,1,'sent','2026-10-12 09:00:00')`).run(id, id);
  db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
    VALUES(?,?,'sent','2026-10-12 09:00:00',?)`).run(id, id, JSON.stringify({
    to: email, from: 'sender@example.test', messageId, delivery: 'unknown',
  }));
}
db.prepare(`INSERT INTO delivery_reports(send_id,mailbox_id,source_uid_validity,source_uid,
    smtp_message_id,report_message_id,report_sender,recipient,action,status_code,diagnostic,
    authentication_status,fingerprint)
  VALUES(1,1,'44',9,'<history-report@example.test>','<report@example.test>','mailer-daemon@mx.example.test',
    'recipient@example.test','delivered','2.0.0','<img src=x onerror=alert(1)>','unverified',?)`).run('a'.repeat(64));

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('campaign send-history action opens real, truthful delivery evidence in Edge', async t => {
  const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || EDGE_PATH;
  if (!fs.existsSync(edgePath)) return t.skip('Microsoft Edge is unavailable on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const { renderCampaigns } = await import('/js/campaigns.js');
      const root = document.createElement('main');
      root.id = 'delivery-history-fixture';
      document.body.append(root);
      await renderCampaigns(root);
    });
    const button = page.locator('#delivery-history-fixture [data-campaign-delivery-history="1"]');
    await button.waitFor({ state: 'visible' });
    await button.click();
    const dialog = page.locator('dialog.studio-dialog[open]');
    await dialog.getByText('Report says delivered').waitFor({ state: 'visible' });
    const content = await dialog.innerText();
    assert.match(content, /SMTP accepted/);
    assert.match(content, /Delivery\s+Unknown/);
    assert.match(content, /source is unverified/i);
    assert.match(content, /2\.0\.0 · unverified/);
    assert.equal(await dialog.locator('img').count(), 0, 'untrusted report diagnostics render as text, never markup');
    assert.match(content, /<img src=x onerror=alert\(1\)>/);
    assert.match(content, /No delivery report was recorded\. Delivery remains unknown\./);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
