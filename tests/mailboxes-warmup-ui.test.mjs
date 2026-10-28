import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let postedReview = null;
let mailbox = {
  id: 7, email: 'sender@example.test', domain: 'example.test', provider: 'smtp', from_name: null,
  warmup_status: 'warming', warmup_started_at: '2026-09-01T00:00:00.000Z', daily_limit: 0,
  health_score: 95, today_sent: 0, today_reserved: 0, spf_ok: 1, dmarc_ok: 1,
  dkim_status: 'unknown', imap_configured: true, smtp_configured: true,
  imap_last_sync_attempt_at: '2026-10-12T10:00:00.000Z', imap_last_sync_success_at: '2026-10-12T10:00:00.000Z',
  imap_last_sync_error: null, imap_last_sync_fetched: 1, imap_last_sync_imported: 1,
  imap_last_sync_duplicates: 0, imap_last_sync_skipped: 0,
  warmup_schedule: { day: 42, totalDays: 35, rampComplete: true, scheduleOnly: true },
  warmup_evidence: {
    outbound: { source: 'SMTP-accepted send records', count: 1, latest: { sendId: 11, eventId: 12, at: '2026-10-12T10:00:00.000Z' } },
    inbound: { source: 'saved inbound mailbox events', count: 1, latest: { eventId: 13, sendId: null, at: '2026-10-12T10:01:00.000Z' } },
    imap: { source: 'IMAP sync state', lastSuccessAt: '2026-10-12T10:00:00.000Z', fetched: 1, imported: 1, alreadyRecorded: 0, skipped: 0 },
  },
  warmup_approval: { allowed: true, blockers: [] },
  warmup_review: { decision: 'review_required', reviewedAt: null, historyCount: 0, policyCurrent: false },
  can_review_warmup: true,
};

const appSource = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/main.css"></head><body><main id="main-content"></main><script type="module">import {renderMailboxes} from '/js/mailboxes.js'; await renderMailboxes(document.querySelector('#main-content'));</script></body></html>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(appSource); return;
  }
  if (url.pathname === '/api/sending/mailboxes' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify([mailbox])); return;
  }
  if (url.pathname === '/api/sending/mailboxes/7/warmup-review' && req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    postedReview = JSON.parse(Buffer.concat(chunks).toString());
    const approved = postedReview.decision === 'approve';
    mailbox = {
      ...mailbox,
      warmup_status: approved ? 'eligible' : 'warming',
      daily_limit: approved ? 25 : 0,
      warmup_review: { decision: approved ? 'approved' : 'held', reviewedAt: '2026-10-14T10:00:00.000Z', historyCount: (mailbox.warmup_review.historyCount || 0) + 1, policyCurrent: true },
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, decision: approved ? 'approved' : 'held' })); return;
  }
  const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(file));
});

let browser;
let page;
let alerts = [];
after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});

test('mailbox review shows separate evidence and asks an explicit owner before allow or hold', async () => {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ executablePath: edgePath, headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', dialog => { alerts.push(dialog.type()); void dialog.dismiss(); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  const review = page.locator('.mailbox-warmup-review');
  await review.getByText('Campaign sending access').waitFor();
  const copy = await review.innerText();
  assert.match(copy, /day 42 of 35.*schedule complete/i);
  assert.match(copy, /SMTP-accepted sends: 1/);
  assert.match(copy, /Saved inbound mailbox records: 1/);
  assert.match(copy, /not proof of inbox placement/i);
  assert.match(copy, /sending blocked/i);

  await review.getByRole('button', { name: 'Allow campaign use' }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByText(/do not prove inbox placement/).waitFor();
  await dialog.getByRole('button', { name: 'Approve campaign use' }).click();
  await review.getByText('Owner/admin approved').waitFor();
  assert.deepEqual(postedReview, { decision: 'approve', acknowledgeEvidenceLimits: true });

  await review.getByRole('button', { name: 'Keep blocked' }).click();
  const holdDialog = page.locator('dialog[open]');
  await holdDialog.getByRole('button', { name: 'Keep blocked' }).click();
  await review.getByText('Held · sending blocked').waitFor();
  assert.deepEqual(postedReview, { decision: 'hold', acknowledgeEvidenceLimits: false });
  assert.deepEqual(alerts, [], 'the workflow uses inline/dialog UI, never a JavaScript alert');
});
