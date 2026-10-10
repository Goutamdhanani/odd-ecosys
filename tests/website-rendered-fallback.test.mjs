import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createSafeFetcher, isPublicAddress } from '../pipeline/ssrf-guard.js';
import { makeTextPdf } from './support/minimal-pdf.mjs';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function browserExecutable() {
  const configured = process.env.ODD_CHROMIUM_EXECUTABLE_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  if (process.platform === 'win32' && fs.existsSync(EDGE_PATH)) return EDGE_PATH;
  try {
    const { chromium } = await import('playwright');
    const bundled = chromium.executablePath();
    if (fs.existsSync(bundled)) return bundled;
  } catch { /* This host may not have a Chromium runtime. */ }
  return null;
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-rendered-website-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES('Rendered website fixture','discovery','open')").run().lastInsertRowid);
const { renderLeadDetail } = await import('../js/leads.js');

const receivedPaths = [];
const catalogPdf = makeTextPdf([
  'Render Fixture Company sales@render.example.test',
  'Render Fixture Company hello@gmail.com',
  'Other Exporter other@outside.example',
]);
const site = http.createServer((req, res) => {
  receivedPaths.push(req.url);
  if (req.url === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('User-agent: *\nAllow: /\nDisallow: /private\nCrawl-delay: 0');
    return;
  }
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Render fixture</title></head><body><main id="app">Loading…</main><a href="/catalog.pdf" title="Company profile catalog">Download company profile</a><script src="/app.js"></script></body></html>');
    return;
  }
  if (req.url === '/catalog.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': catalogPdf.length });
    res.end(catalogPdf);
    return;
  }
  if (req.url === '/app.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(`const contactMeta = document.createElement('meta'); contactMeta.name = 'contact-email'; contactMeta.content = 'metadata@render.example.test'; document.head.appendChild(contactMeta); const contactButton = document.createElement('button'); contactButton.setAttribute('aria-label', 'Public support address support@render.example.test'); contactButton.setAttribute('data-contact-email', 'partners@render.example.test'); document.body.appendChild(contactButton); document.querySelector('#app').innerHTML = '<footer>Sales team <a href="mailto:dynamic@render.example.test">dynamic@render.example.test</a></footer>'; const contactForm = document.createElement('form'); contactForm.id = 'contact-form'; contactForm.action = '/submit'; contactForm.innerHTML = '<input type="email" name="email"><textarea name="message"></textarea><button type="submit">Send</button>'; document.body.appendChild(contactForm); fetch('/private/hidden.js').catch(() => {}); fetch('http://offsite.example.test/pixel').catch(() => {});`);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
site.listen(80, '127.0.0.1');
await once(site, 'listening');
const websiteUrl = 'http://render.example.test/';
const leadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES(?,?,?,'discovered')")
  .run(batchId, 'Render Fixture Company', websiteUrl).lastInsertRowid);

const resolver = async hostname => {
  if (hostname !== 'render.example.test') throw new Error(`Unexpected DNS lookup for ${hostname}`);
  return [{ address: '127.0.0.1', family: 4 }];
};
const guardedFetch = createSafeFetcher({
  resolver,
  addressPolicy: address => address === '127.0.0.1' || isPublicAddress(address),
});
const outboundTargets = [];
const fetchImpl = async (input, options) => {
  const target = new URL(input);
  outboundTargets.push({ href: target.href, options });
  return guardedFetch(input, options);
};

after(async () => {
  site.closeAllConnections?.();
  await new Promise(resolve => site.close(resolve));
  closeDb();
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

test('renders a sparse JavaScript contact page through same-origin robots and SSRF guards', async t => {
  const executablePath = await browserExecutable();
  if (!executablePath) return t.skip('No Playwright-compatible Chromium executable is installed on this host.');
  const { createWebsiteEmailDiscovery } = await import('../pipeline/website-email-discovery.js');
  const discovery = createWebsiteEmailDiscovery({
    db,
    fetchImpl,
    minimumRequestIntervalMs: 0,
    wait: async () => {},
    renderOptions: { executablePath },
  });

  const result = await discovery.scanLead(leadId);
  assert.equal(result.scan.status, 'completed');
  assert.equal(result.scan.found_count, 6, JSON.stringify(result.emails.map(item => item.email)));
  assert.deepEqual(JSON.parse(result.scan.rendered_paths_json), ['/']);
  assert.ok(JSON.parse(result.scan.visited_paths_json).includes('@rendered:/'));
  const renderedForm = db.prepare(`SELECT source_url,evidence_type,raw_excerpt,content_hash,extractor_version
    FROM lead_profile_source_evidence WHERE lead_id=? AND evidence_type='website_contact_form'`).get(leadId);
  assert.equal(renderedForm.source_url, websiteUrl);
  assert.equal(renderedForm.evidence_type, 'website_contact_form');
  assert.equal(renderedForm.raw_excerpt, 'Public contact/enquiry form observed. No fields were submitted or values collected.');
  assert.match(renderedForm.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(renderedForm.extractor_version, 'website-contact-form-v1');
  assert.equal(receivedPaths.includes('/submit'), false, 'rendered contact forms are never submitted');
  assert.deepEqual(result.emails.map(item => item.email).sort(), [
    'dynamic@render.example.test', 'hello@gmail.com', 'metadata@render.example.test', 'partners@render.example.test',
    'sales@render.example.test', 'support@render.example.test',
  ]);
  assert.ok(result.emails.every(item => item.verification_status === 'unknown'));
  const renderedEmail = result.emails.find(item => item.email === 'dynamic@render.example.test');
  assert.ok(renderedEmail.source_evidence.some(evidence => {
    return evidence.evidence_type === 'rendered_mailto'
      && evidence.extractor_version === 'website-rendered-v16'
      && evidence.source_url === websiteUrl;
  }));
  const renderedMetadata = result.emails.find(item => item.email === 'metadata@render.example.test');
  assert.ok(renderedMetadata.source_evidence.some(evidence => evidence.evidence_type === 'rendered_website_meta_email'
    && evidence.extractor_version === 'website-rendered-v16'
    && /name="contact-email"/i.test(evidence.raw_excerpt)));
  const renderedAccessible = result.emails.find(item => item.email === 'support@render.example.test');
  assert.ok(renderedAccessible.source_evidence.some(evidence => evidence.evidence_type === 'rendered_website_accessible_text'
    && evidence.extractor_version === 'website-rendered-v16'
    && /aria-label: Public support address/i.test(evidence.raw_excerpt)));
  const renderedDataEmail = result.emails.find(item => item.email === 'partners@render.example.test');
  assert.ok(renderedDataEmail.source_evidence.some(evidence => evidence.evidence_type === 'rendered_website_contact_attribute'
    && evidence.extractor_version === 'website-rendered-v16'
    && /data-contact-email: partners@render.example.test/i.test(evidence.raw_excerpt)));
  const pdfEmail = result.emails.find(item => item.email === 'hello@gmail.com');
  assert.ok(pdfEmail.source_evidence.some(evidence => evidence.evidence_type === 'website_pdf_text'
    && evidence.extractor_version === 'website-pdf-v1'
    && evidence.source_url === `${websiteUrl}catalog.pdf`
    && evidence.raw_excerpt.startsWith('PDF page 1:')));
  assert.equal(result.emails.some(item => item.email === 'other@outside.example'), false,
    'an unrelated exporter in the same catalog is not attached to this business');
  const detail = renderLeadDetail({
    id: leadId,
    business_name: 'Render Fixture Company',
    website_url: websiteUrl,
    email_discovery: result.scan,
    emails: result.emails,
    tags: [],
    events: [],
    customFields: [],
  });
  assert.match(detail, /rendered mailto/);
  assert.match(detail, /website pdf text/);
  assert.match(detail, /unknown/);
  assert.match(detail, /This result is not email verification or permission to send/);
  assert.equal(receivedPaths.includes('/private/hidden.js'), false, 'robots-disallowed browser requests never reach the site');
  assert.ok(receivedPaths.includes('/catalog.pdf'), 'the public company-linked PDF is fetched and parsed');
  assert.equal(outboundTargets.some(({ href }) => new URL(href).hostname !== 'render.example.test'), false,
    'off-site scripts and analytics never reach the guarded transport');
  assert.ok(outboundTargets.every(({ options }) => options.redirect === 'manual' && options.maxBytes <= 2 * 1024 * 1024));
  assert.ok(outboundTargets.find(({ href }) => new URL(href).pathname === '/catalog.pdf').options.maxBytes <= 2 * 1024 * 1024,
    'PDF downloads keep the dedicated two-megabyte limit');
  assert.ok(outboundTargets.find(({ href }) => new URL(href).pathname === '/app.js').options.maxBytes <= 256 * 1024,
    'rendered assets keep the tighter per-response budget');

  const callsBeforeRepeat = outboundTargets.length;
  await assert.rejects(discovery.scanLead(leadId), error => error.code === 'already_scanned');
  assert.equal(outboundTargets.length, callsBeforeRepeat, 'one-time scan semantics still prevent a second browser crawl');
});
