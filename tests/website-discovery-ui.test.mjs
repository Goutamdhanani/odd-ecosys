import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const appSource = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/observatory.css"><link rel="stylesheet" href="/css/contact-edit.css"></head><body><main id="main-content"></main><script type="module">import {renderLeads} from '/js/leads.js'; window.__workspaceRole='operator'; await renderLeads(document.querySelector('#main-content'));</script></body></html>`;
let bodyReceived;
let getCount = 0;
let websiteJobCreateCount = 0;
let websiteJobBodyReceived = null;
const pagedWebsiteJobOffsets = [];
let budgetRetryCount = 0;
let budgetJobState = {
  id: 18, batch_id: 3, status: 'partial', task_count: 1,
  progress: { total: 1, completed: 0, blocked: 0, failed: 1, skipped: 0, queued: 0, running: 0, found_emails: 1 },
  tasks: [{ id: 30, lead_id: 82, business_name: 'Budget Fixture', website_url: 'https://budget.example.test/', status: 'failed',
    scan_status: 'failed', scan_error_code: 'scan_request_budget_reached', error_code: 'scan_request_budget_reached', retryable: true,
    page_count: 12, emails: [{ email: 'hello@budget.example.test', verification_status: 'unknown', source_url: 'https://budget.example.test/contact', raw_excerpt: 'Contact: hello@budget.example.test' }] }],
};
let epchBodyReceived;
let directoryBodyReceived;
let cbamCooldownMode = false;
let cbamCooldownState;
let directoryRetryCount = 0;
let epchGetCount = 0;
let epchResumeCount = 0;
let pageCappedEpchJob;
const completeJob = {
  id: 17, batch_id: 3, status: 'completed', task_count: 1,
  progress: { total: 1, completed: 1, blocked: 0, failed: 0, skipped: 0, queued: 0, running: 0, found_emails: 1 },
  tasks: [{ id: 29, lead_id: 81, business_name: 'North Star Workshop', website_url: 'https://northstar.example.test/', status: 'completed', category: 'Precision manufacturing', address: '10 Workshop Lane, Jaipur, Rajasthan, India', city: 'Jaipur', state: 'Rajasthan', country: 'India', phone: '+1-212-555-0132', facebook_url: 'https://www.facebook.com/north-star',
    latest_refresh: { status: 'completed', generation: 2 }, page_count: 3, emails: [{ email: 'sales@northstar.example.test', verification_status: 'unknown', source_url: 'https://northstar.example.test/contact', refresh_state: 'not_present', refresh_generation: 2,
      source_conflict: { generation: 2, present_sources: ['https://northstar.example.test/team'], absent_sources: ['https://northstar.example.test/contact'] },
      refresh_history: [{ generation: 2, status: 'completed', outcome: 'fetched', state: 'not_present', prior_content_hash: 'c'.repeat(64), prior_excerpt: 'Business enquiries: sales@northstar.example.test', current_content_hash: 'd'.repeat(64), current_extractor_version: 'website-html-v20' }],
      raw_excerpt: 'Business enquiries: sales@northstar.example.test', evidence_type: 'website_json_ld', contact_points: [
        { contact_type: 'sales', contact_name: 'Maya Singh', contact_title: 'Regional Sales Manager' },
      ] }] }],
};
const cooldownWebsiteJob = {
  id: 22, batch_id: 3, status: 'partial', task_count: 1,
  progress: { total: 1, completed: 0, blocked: 1, failed: 0, skipped: 0, queued: 0, running: 0, found_emails: 0 },
  tasks: [{ id: 203, lead_id: 305, business_name: 'Cooldown Fixture', website_url: 'https://cooldown-ui.example.test/',
    status: 'blocked', scan_status: 'blocked', scan_error_code: 'site_rate_limited', error_code: 'site_rate_limited',
    retry_after_at: new Date(Date.now() + 120_000).toISOString(), retryable: false, page_count: 2, emails: [] }],
};
const pagedWebsiteTasks = Array.from({ length: 105 }, (_, index) => ({
  id: 1000 + index, lead_id: 2000 + index, business_name: `Page Fixture ${index + 1}`,
  website_url: `https://page-${index + 1}.example.test/`, status: 'completed', emails: [],
}));
function pagedWebsiteJob(offset = 0, limit = 100) {
  return {
    id: 20, batch_id: 3, status: 'completed', task_count: 105,
    progress: { total: 105, completed: 105, blocked: 0, failed: 0, skipped: 0, queued: 0, running: 0, found_emails: 0 },
    task_pagination: { offset, limit, total: 105, hasMore: offset + limit < 105 },
    tasks: pagedWebsiteTasks.slice(offset, offset + limit),
  };
}
const epchWebsiteJob = {
  ...completeJob, id: 19, status: 'completed',
  tasks: [{ id: 91, lead_id: 81, business_name: 'Jaipur Craft Works', website_url: 'https://jaipurcrafts.example.test/',
    status: 'completed', page_count: 2, emails: [{ email: 'contact@jaipurcrafts.example.test', verification_status: 'unknown',
      source_url: 'https://jaipurcrafts.example.test/contact', evidence_type: 'website_html',
      raw_excerpt: 'Business enquiries: contact@jaipurcrafts.example.test', content_hash: 'a'.repeat(64), extractor_version: 'website-html-v18' }],
    contact_forms: [{ source_url: 'https://jaipurcrafts.example.test/contact', evidence_type: 'website_contact_form',
      raw_excerpt: 'Public contact/enquiry form observed. No fields were submitted or values collected.',
      content_hash: 'b'.repeat(64), extractor_version: 'website-contact-form-v1' }] }],
};
const completeEpchJob = {
  id: 44, batch_id: 3, status: 'completed', page_limit: 50, pages_completed: 2,
  businesses_created: 12, emails_created: 9, duplicates: 1, suppressed_emails_skipped: 0, records_seen: 12, error_code: null,
  progress: { pages_completed: 2, businesses_created: 12, emails_created: 9, duplicates: 1, suppressed_emails_skipped: 0 },
  records: [{ lead_id: 81, business_name: 'Jaipur Craft Works', contact_person_name: 'Asha Mehta', category: 'Handicraft exporter',
    city: 'Jaipur', state: 'Rajasthan', country: 'India', emails: ['hello@gmail.com'], website_url: 'https://jaipurcrafts.example.test/',
    source_url: 'https://epch.in/member#record-1', raw_excerpt: 'Jaipur Craft Works · Email: hello@gmail.com · Website: https://jaipurcrafts.example.test/', status: 'imported' }],
};
const completeCbamJob = {
  ...completeEpchJob, id: 47, source_id: 'eepc_cbam', source_name: 'EEPC CBAM advisory directory',
  records: [{ lead_id: 91, business_name: 'CBAM Advisory Co', contact_person_name: 'Priya Nair', contact_title: 'Managing Director',
    category: 'CBAM advisory service provider', country: 'India', emails: ['priya@cbam-advisory.example'],
    website_url: 'https://cbam-advisory.example.test/', source_url: 'https://cbam.eepcindia.org/#record-test',
    raw_excerpt: 'CBAM Advisory Co · Email: priya@cbam-advisory.example · Contact Person: Priya Nair · Designation: Managing Director',
    status: 'imported' }],
};
const bulkEpchJob = {
  ...completeEpchJob, id: 46, status: 'running',
  records: [
    ...completeEpchJob.records,
    { lead_id: 82, business_name: 'Bulk Scan Two', contact_person_name: null, category: 'Industrial tools',
      city: 'Pune', state: 'Maharashtra', country: 'India', emails: [], website_url: 'https://bulk-two.example.test/',
      source_url: 'https://epch.in/member#record-2', raw_excerpt: 'Bulk Scan Two · Website: https://bulk-two.example.test/', status: 'imported' },
  ],
};
const bulkWebsiteDiscoveryJob = {
  id: 21, batch_id: 3, status: 'completed', task_count: 2,
  progress: { total: 2, completed: 2, blocked: 0, failed: 0, skipped: 0, queued: 0, running: 0, found_emails: 2 },
  tasks: [
    { id: 101, lead_id: 81, business_name: 'Jaipur Craft Works', website_url: 'https://jaipurcrafts.example.test/', status: 'completed',
      emails: [{ email: 'contact@jaipurcrafts.example.test', verification_status: 'unknown', source_url: 'https://jaipurcrafts.example.test/contact', raw_excerpt: 'Contact: contact@jaipurcrafts.example.test' }] },
    { id: 102, lead_id: 82, business_name: 'Bulk Scan Two', website_url: 'https://bulk-two.example.test/', status: 'completed',
      emails: [{ email: 'sales@bulk-two.example.test', verification_status: 'unknown', source_url: 'https://bulk-two.example.test/contact', raw_excerpt: 'Sales: sales@bulk-two.example.test' }] },
  ],
};
pageCappedEpchJob = {
  ...completeEpchJob, id: 45, status: 'partial', page_limit: 1, pages_completed: 1,
  error_code: 'page_limit_reached', can_extend_pages: true,
  progress: { ...completeEpchJob.progress, pages_completed: 1 },
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(appSource); return; }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/batches') return res.end(JSON.stringify([{ id: 3, name: 'Current collection', status: 'open' }]));
    if (req.method === 'GET' && url.pathname === '/api/contact-tags') return res.end('[]');
    if (req.method === 'GET' && url.pathname === '/api/contact-segments') return res.end('[]');
    if (req.method === 'GET' && url.pathname === '/api/contact-fields') return res.end(JSON.stringify({ fields: [] }));
    if (req.method === 'GET' && url.pathname === '/api/leads') return res.end(JSON.stringify({ leads: [], pagination: { total: 0, hasMore: false, nextCursor: null } }));
    if (url.pathname === '/api/leads/website-discovery-jobs' && req.method === 'GET') return res.end('[]');
    if (url.pathname === '/api/leads/directory-jobs' && req.method === 'GET') return res.end('[]');
    if (url.pathname === '/api/leads/website-discovery-jobs' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      bodyReceived = JSON.parse(Buffer.concat(chunks).toString());
      websiteJobCreateCount += 1;
      websiteJobBodyReceived = bodyReceived;
      res.statusCode = 201;
      if (bodyReceived.businesses?.length > 1 && bodyReceived.businesses[0]?.business_name === 'Jaipur Craft Works') {
        return res.end(JSON.stringify({ ...bulkWebsiteDiscoveryJob, status: 'queued' }));
      }
      if (bodyReceived.businesses?.[0]?.business_name === 'Budget Fixture') {
        budgetJobState = { ...budgetJobState, status: 'partial' };
        return res.end(JSON.stringify({ id: 18, batch_id: 3, status: 'queued' }));
      }
      if (bodyReceived.businesses?.[0]?.business_name === 'Cooldown Fixture') {
        return res.end(JSON.stringify({ id: 22, batch_id: 3, status: 'queued' }));
      }
      if (bodyReceived.businesses?.[0]?.business_name?.startsWith('Page Fixture ')) {
        return res.end(JSON.stringify({ ...pagedWebsiteJob(), status: 'queued' }));
      }
      if (bodyReceived.businesses?.[0]?.business_name === 'Bulk Scan One') {
        return res.end(JSON.stringify({ ...bulkWebsiteDiscoveryJob, status: 'queued' }));
      }
      if (bodyReceived.businesses?.[0]?.business_name === 'Jaipur Craft Works') {
        return res.end(JSON.stringify({ ...epchWebsiteJob, status: 'queued' }));
      }
      return res.end(JSON.stringify({ ...completeJob, status: 'queued' }));
    }
    if (url.pathname === '/api/leads/website-discovery-jobs/17' && req.method === 'GET') {
      getCount += 1;
      return res.end(JSON.stringify(completeJob));
    }
    if (url.pathname === '/api/leads/website-discovery-jobs/20' && req.method === 'GET') {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 100);
      pagedWebsiteJobOffsets.push(offset);
      return res.end(JSON.stringify(pagedWebsiteJob(offset, limit)));
    }
    if (url.pathname === '/api/leads/website-discovery-jobs/21' && req.method === 'GET') return res.end(JSON.stringify(bulkWebsiteDiscoveryJob));
    if (url.pathname === '/api/leads/website-discovery-jobs/22' && req.method === 'GET') return res.end(JSON.stringify(cooldownWebsiteJob));
    if (url.pathname === '/api/leads/website-discovery-jobs/19' && req.method === 'GET') return res.end(JSON.stringify(epchWebsiteJob));
    if (url.pathname === '/api/leads/website-discovery-jobs/18' && req.method === 'GET') return res.end(JSON.stringify(budgetJobState));
    if (url.pathname === '/api/leads/website-discovery-jobs/18/retry' && req.method === 'POST') {
      budgetRetryCount += 1;
      budgetJobState = {
        ...budgetJobState, status: 'completed',
        progress: { ...budgetJobState.progress, completed: 1, failed: 0 },
        tasks: budgetJobState.tasks.map(task => ({ ...task, status: 'completed', scan_status: 'completed', retryable: false,
          scan_error_code: null, error_code: null, page_count: 13 })),
      };
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ job: budgetJobState }));
    }
    if (url.pathname === '/api/leads/directory-jobs' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      directoryBodyReceived = JSON.parse(Buffer.concat(chunks).toString());
      epchBodyReceived = directoryBodyReceived;
      res.statusCode = 201;
      if (directoryBodyReceived.source_id === 'eepc_cbam') return res.end(JSON.stringify(cbamCooldownMode
        ? cbamCooldownState : { ...completeCbamJob, status: 'queued' }));
      if (epchBodyReceived.page_limit === 1) {
        pageCappedEpchJob = { ...pageCappedEpchJob, status: 'partial', page_limit: 1, can_extend_pages: true };
        return res.end(JSON.stringify({ ...pageCappedEpchJob }));
      }
      if (epchBodyReceived.page_limit === 4) return res.end(JSON.stringify({ ...bulkEpchJob, status: 'queued' }));
      return res.end(JSON.stringify({ ...completeEpchJob, status: 'queued' }));
    }
    if (url.pathname === '/api/leads/directory-jobs/44' && req.method === 'GET') {
      epchGetCount += 1;
      return res.end(JSON.stringify(completeEpchJob));
    }
    if (url.pathname === '/api/leads/directory-jobs/45' && req.method === 'GET') {
      epchGetCount += 1;
      return res.end(JSON.stringify(pageCappedEpchJob));
    }
    if (url.pathname === '/api/leads/directory-jobs/46' && req.method === 'GET') {
      epchGetCount += 1;
      return res.end(JSON.stringify(bulkEpchJob));
    }
    if (url.pathname === '/api/leads/directory-jobs/47' && req.method === 'GET') {
      epchGetCount += 1;
      return res.end(JSON.stringify(completeCbamJob));
    }
    if (url.pathname === '/api/leads/directory-jobs/48' && req.method === 'GET') return res.end(JSON.stringify(cbamCooldownState));
    if (url.pathname === '/api/leads/directory-jobs/48/retry' && req.method === 'POST') {
      directoryRetryCount += 1;
      cbamCooldownState = { ...cbamCooldownState, status: 'queued', error_code: null, retry_after_at: null };
      return res.end(JSON.stringify({ job: cbamCooldownState }));
    }
    if (url.pathname === '/api/leads/directory-jobs/45/resume' && req.method === 'POST') {
      epchResumeCount += 1;
      pageCappedEpchJob = {
        ...pageCappedEpchJob, status: 'running', page_limit: 6, error_code: null, can_extend_pages: false,
        progress: { ...pageCappedEpchJob.progress, pages_total_limit: 6 },
      };
      return res.end(JSON.stringify({ job: pageCappedEpchJob }));
    }
    res.statusCode = 404; return res.end(JSON.stringify({ error: 'Not found' }));
  }
  const assetPath = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!assetPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  const type = assetPath.endsWith('.js') ? 'text/javascript; charset=utf-8' : assetPath.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type }); fs.createReadStream(assetPath).pipe(res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

test('Contacts can start a website collection and inspect source evidence in job progress', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  bodyReceived = null;
  getCount = 0;
  budgetRetryCount = 0;
  epchBodyReceived = null;
  epchGetCount = 0;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const find = page.getByRole('button', { name: 'Find businesses' });
    await find.waitFor();
    await find.click();
    const dialog = page.getByRole('dialog', { name: 'Find businesses' });
    await dialog.waitFor();
    await dialog.locator('[name="businesses"]').fill('North Star Workshop | https://northstar.example.test | Manufacturing | Jaipur | Rajasthan | India');
    await dialog.getByRole('button', { name: 'Start discovery' }).click();
    const progress = page.getByRole('dialog', { name: 'Discovery job #17' });
    await progress.waitFor();
    await progress.getByText('sales@northstar.example.test', { exact: true }).waitFor();
    assert.deepEqual(bodyReceived, {
      batch_id: 3,
      businesses: [{ business_name: 'North Star Workshop', website_url: 'https://northstar.example.test', category: 'Manufacturing', city: 'Jaipur', state: 'Rajasthan', country: 'India' }],
    });
    assert.match(await progress.innerText(), /not verified/);
    assert.match(await progress.innerText(), /Business enquiries: sales@northstar\.example\.test/);
    assert.match(await progress.innerText(), /Contact type: sales · Contact: Maya Singh · Role: Regional Sales Manager/);
    assert.match(await progress.innerText(), /Public phone: \+1-212-555-0132/);
    assert.match(await progress.innerText(), /Precision manufacturing · 10 Workshop Lane, Jaipur, Rajasthan, India · Jaipur, Rajasthan, India/);
    assert.match(await progress.innerText(), /Latest source refresh: completed · generation 2/);
    assert.match(await progress.innerText(), /Not seen on last successful refresh · generation 2/);
    assert.match(await progress.innerText(), /Source disagreement · refresh 2/);
    await progress.locator('.contact-source-history summary').click();
    assert.match(await progress.innerText(), /Prior content c{16}/);
    assert.equal(await progress.getByRole('link', { name: 'Facebook page ↗' }).getAttribute('href'), 'https://www.facebook.com/north-star');
    assert.equal(await progress.getByRole('button', { name: 'Export evidence CSV' }).count(), 1);
    assert.ok(getCount >= 1);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('website discovery progress lets the operator continue a budget-limited site', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Find businesses' }).click();
    const dialog = page.getByRole('dialog', { name: 'Find businesses' });
    await dialog.locator('[name="businesses"]').fill('Budget Fixture | https://budget.example.test');
    await dialog.getByRole('button', { name: 'Start discovery' }).click();
    const progress = page.getByRole('dialog', { name: 'Discovery job #18' });
    await progress.getByRole('button', { name: 'Continue scan' }).waitFor();
    assert.match(await progress.innerText(), /pending links/);
    await progress.getByRole('button', { name: 'Continue scan' }).click();
    await progress.getByText('hello@budget.example.test', { exact: true }).waitFor();
    await progress.locator('.website-discovery-progress-top strong').filter({ hasText: 'completed' }).waitFor();
    assert.equal(budgetRetryCount, 1);
    assert.match(await progress.innerText(), /Completed/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('website discovery progress paginates all results beyond the first 100 sites', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  pagedWebsiteJobOffsets.length = 0;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Find businesses' }).click();
    const dialog = page.getByRole('dialog', { name: 'Find businesses' });
    const seeds = Array.from({ length: 105 }, (_, index) =>
      `Page Fixture ${index + 1} | https://page-${index + 1}.example.test`).join('\n');
    await dialog.locator('[name="businesses"]').fill(seeds);
    await dialog.getByRole('button', { name: 'Start discovery' }).click();
    const progress = page.getByRole('dialog', { name: 'Discovery job #20' });
    await progress.getByText('Sites 1–100 of 105').waitFor();
    await progress.getByText('Page Fixture 1', { exact: true }).waitFor();
    assert.equal(await progress.getByText('Page Fixture 101', { exact: true }).count(), 0);
    await progress.getByRole('button', { name: 'Next' }).click();
    await progress.getByText('Sites 101–105 of 105').waitFor();
    await progress.getByText('Page Fixture 101', { exact: true }).waitFor();
    await progress.getByText('Page Fixture 105', { exact: true }).waitFor();
    await progress.getByRole('button', { name: 'Previous' }).click();
    await progress.getByText('Sites 1–100 of 105').waitFor();
    await progress.getByText('Page Fixture 1', { exact: true }).waitFor();
    assert.deepEqual(pagedWebsiteJobOffsets.slice(0, 3), [0, 100, 0]);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('page-capped EPCH imports wait for an explicit bounded continuation action', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  epchBodyReceived = null;
  epchGetCount = 0;
  epchResumeCount = 0;
  pageCappedEpchJob = {
    ...completeEpchJob, id: 45, batch_id: 3, status: 'partial', page_limit: 1, pages_completed: 1,
    error_code: 'page_limit_reached', can_extend_pages: true,
    progress: { ...completeEpchJob.progress, pages_completed: 1 },
  };
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Find businesses' }).click();
    const dialog = page.getByRole('dialog', { name: 'Find businesses' });
    await dialog.getByLabel('Maximum EPCH pages').fill('1');
    await dialog.getByRole('button', { name: 'Import EPCH member directory' }).click();
    const progress = page.getByRole('dialog', { name: 'EPCH directory job #45' });
    await progress.getByRole('button', { name: 'Continue next 5 pages' }).waitFor();
    assert.deepEqual(epchBodyReceived, { batch_id: 3, page_limit: 1, source_id: 'epch' });
    assert.equal(epchResumeCount, 0, 'a capped job never continues on its own');
    await progress.getByRole('button', { name: 'Continue next 5 pages' }).click();
    await progress.locator('progress[value="17"]').waitFor();
    assert.equal(epchResumeCount, 1);
    assert.match(await progress.innerText(), /running/i);
    assert.equal(await progress.getByRole('button', { name: 'Continue next 5 pages' }).count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('Contacts can import EPCH records into the selected batch and inspect source-backed email evidence', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  epchBodyReceived = null;
  epchGetCount = 0;
  websiteJobCreateCount = 0;
  websiteJobBodyReceived = null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Find businesses' }).click();
    const dialog = page.getByRole('dialog', { name: 'Find businesses' });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('Maximum EPCH pages').inputValue(), '5');
    await dialog.getByLabel('Maximum EPCH pages').fill('3');
    await dialog.getByRole('button', { name: 'Import EPCH member directory' }).click();
    const progress = page.getByRole('dialog', { name: 'EPCH directory job #44' });
    await progress.waitFor();
    await progress.getByText('hello@gmail.com', { exact: true }).waitFor();
    const companyWebsite = progress.getByRole('link', { name: 'Company website ↗' });
    await companyWebsite.waitFor();
    assert.equal(await companyWebsite.getAttribute('href'), 'https://jaipurcrafts.example.test/');
    assert.equal(await companyWebsite.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await progress.getByRole('button', { name: 'Find emails from website' }).count(), 1);
    assert.deepEqual(epchBodyReceived, { batch_id: 3, page_limit: 3, source_id: 'epch' });
    assert.match(await progress.innerText(), /not verified/);
    assert.match(await progress.innerText(), /Jaipur Craft Works/);
    assert.equal(await progress.getByRole('button', { name: 'Export evidence CSV' }).count(), 1);
    assert.ok(epchGetCount >= 1);
    assert.equal(websiteJobCreateCount, 0, 'import and review do not start a company-site scan');
    await progress.getByRole('button', { name: 'Find emails from website' }).click();
    await page.waitForTimeout(500);
    const openDialogText = await page.locator('dialog[open]').allInnerTexts();
    assert.equal(websiteJobCreateCount, 1, `scan action did not reach the website queue; dialogs: ${JSON.stringify(openDialogText)}`);
    assert.deepEqual(websiteJobBodyReceived, {
      batch_id: 3,
      businesses: [{ lead_id: 81, business_name: 'Jaipur Craft Works', website_url: 'https://jaipurcrafts.example.test/',
        category: 'Handicraft exporter', city: 'Jaipur', state: 'Rajasthan', country: 'India' }],
    });
    const websiteProgress = page.getByRole('dialog', { name: 'Discovery job #19' });
    await websiteProgress.waitFor();
    const websiteProgressText = await websiteProgress.innerText();
    assert.match(websiteProgressText, /contact@jaipurcrafts\.example\.test/, websiteProgressText);
    assert.match(websiteProgressText, /not verified/);
    assert.match(websiteProgressText, /A public contact form was observed\. No fields were submitted or values collected\./);
    const formSource = websiteProgress.locator('.website-discovery-contact-form a');
    assert.equal(await formSource.getAttribute('href'), 'https://jaipurcrafts.example.test/contact');
    assert.equal(await formSource.getAttribute('rel'), 'noopener noreferrer');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('Contacts can import EEPC CBAM evidence and review the named source without auto-scanning company sites', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  directoryBodyReceived = null;
  epchGetCount = 0;
  websiteJobCreateCount = 0;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Find businesses' }).click();
    const setup = page.getByRole('dialog', { name: 'Find businesses' });
    await setup.getByRole('button', { name: 'Import EEPC CBAM advisory directory' }).click();
    assert.deepEqual(directoryBodyReceived, { batch_id: 3, source_id: 'eepc_cbam' });
    const progress = page.getByRole('dialog', { name: 'EEPC CBAM directory job #47' });
    await progress.getByText('CBAM Advisory Co', { exact: true }).waitFor();
    await progress.getByText('Priya Nair · Managing Director', { exact: true }).waitFor();
    await progress.getByText('priya@cbam-advisory.example', { exact: true }).waitFor();
    assert.match(await progress.innerText(), /unknown · not verified/);
    const sourceLink = progress.getByRole('link', { name: 'View source record' });
    assert.equal(await sourceLink.getAttribute('href'), 'https://cbam.eepcindia.org/#record-test');
    assert.equal(websiteJobCreateCount, 0, 'directory import and review do not automatically scan the listed company website');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('directory cooldown is visible, waits without retrying, and retries only after the operator clicks', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  cbamCooldownMode = true;
  directoryRetryCount = 0;
  cbamCooldownState = { ...completeCbamJob, id: 48, source_id: 'eepc_cbam', status: 'failed',
    error_code: 'source_rate_limited', retry_after_at: new Date(Date.now() + 5000).toISOString() };
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Find businesses' }).click();
    const setup = page.getByRole('dialog', { name: 'Find businesses' });
    await setup.getByRole('button', { name: 'Import EEPC CBAM advisory directory' }).click();
    const progress = page.getByRole('dialog', { name: 'EEPC CBAM directory job #48' });
    const retry = progress.locator('[data-epch-retry]');
    await retry.waitFor();
    assert.equal(await retry.innerText(), 'Retry after cooldown');
    assert.equal(await retry.isDisabled(), true);
    assert.match(await progress.innerText(), /No requests will be made before then/);
    await page.waitForTimeout(5200);
    assert.equal(directoryRetryCount, 0, 'deadline expiry updates the UI but does not automatically retry');
    assert.equal(await retry.isEnabled(), true);
    assert.equal(await retry.innerText(), 'Retry network failure');
    await retry.click();
    assert.equal(directoryRetryCount, 1, 'only the explicit operator click reaches the retry API');
    assert.deepEqual(pageErrors, []);
  } finally {
    cbamCooldownMode = false;
    await browser.close();
  }
});

test('EPCH review queues selected company websites together and preserves selection across refresh', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  epchBodyReceived = null;
  epchGetCount = 0;
  websiteJobCreateCount = 0;
  websiteJobBodyReceived = null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Find businesses' }).click();
    const setup = page.getByRole('dialog', { name: 'Find businesses' });
    await setup.getByLabel('Maximum EPCH pages').fill('4');
    await setup.getByRole('button', { name: 'Import EPCH member directory' }).click();
    const directory = page.getByRole('dialog', { name: 'EPCH directory job #46' });
    await directory.waitFor();
    const first = directory.locator('[data-epch-select-website="81"]');
    const second = directory.locator('[data-epch-select-website="82"]');
    await first.check();
    assert.equal(await directory.getByRole('button', { name: 'Find emails from 1 selected sites' }).isDisabled(), false);
    await page.waitForTimeout(1700);
    assert.equal(await first.isChecked(), true, 'the selected lead remains selected after the durable job refresh');
    assert.ok(epchGetCount >= 2, 'the browser exercised an actual progress refresh');
    await second.check();
    assert.equal(await directory.getByRole('button', { name: 'Find emails from 2 selected sites' }).isDisabled(), false);
    assert.equal(websiteJobCreateCount, 0, 'directory import and selection do not start website scans');

    await directory.getByRole('button', { name: 'Find emails from 2 selected sites' }).click();
    assert.deepEqual(websiteJobBodyReceived, {
      batch_id: 3,
      businesses: [
        { lead_id: 81, business_name: 'Jaipur Craft Works', website_url: 'https://jaipurcrafts.example.test/',
          category: 'Handicraft exporter', city: 'Jaipur', state: 'Rajasthan', country: 'India' },
        { lead_id: 82, business_name: 'Bulk Scan Two', website_url: 'https://bulk-two.example.test/',
          category: 'Industrial tools', city: 'Pune', state: 'Maharashtra', country: 'India' },
      ],
    });
    assert.equal(websiteJobCreateCount, 1);
    const progress = page.getByRole('dialog', { name: 'Discovery job #21' });
    await progress.getByText('contact@jaipurcrafts.example.test', { exact: true }).waitFor();
    await progress.getByText('sales@bulk-two.example.test', { exact: true }).waitFor();
    assert.match(await progress.innerText(), /not verified/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('rate-limited website review shows the saved cooldown and hides retry until it expires', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  websiteJobBodyReceived = null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Find businesses' }).click();
    const setup = page.getByRole('dialog', { name: 'Find businesses' });
    await setup.locator('[name="businesses"]').fill('Cooldown Fixture | https://cooldown-ui.example.test');
    await setup.getByRole('button', { name: 'Start discovery' }).click();
    const progress = page.getByRole('dialog', { name: 'Discovery job #22' });
    await progress.waitFor();
    await progress.getByText('Cooldown Fixture', { exact: true }).waitFor();
    assert.match(await progress.innerText(), /Retry is available after/);
    assert.equal(await progress.getByRole('button', { name: 'Retry rate-limited site' }).count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

