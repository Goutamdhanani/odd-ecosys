import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { safeFetch } from './ssrf-guard.js';
import { EpchDirectoryError } from './epch-member-directory.js';
import { normalizeWebsiteUrl, parseRobotsPolicy, WEBSITE_EMAIL_USER_AGENT } from './website-email-discovery.js';

export const EEPC_CBAM_SOURCE_URL = 'https://cbam.eepcindia.org/';
export const EEPC_CBAM_EXTRACTOR_VERSION = 'eepc-cbam-advisory-v1';
const MAX_ROBOTS_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_CRAWL_DELAY_MS = 10_000;
const EMAIL_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi;
const hostSchedules = new Map();

let cheerioModule = null;
async function loadCheerio() {
  if (!cheerioModule) cheerioModule = await import('cheerio');
  return cheerioModule;
}

function normalizeText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function columnKey(value) {
  return normalizeText(value).toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function explicitlyHidden($, element) {
  const style = normalizeText($(element).attr('style')).toLocaleLowerCase('en');
  return $(element).is('[hidden],[aria-hidden="true"]')
    || /(?:^|;)\s*display\s*:\s*none\b/.test(style)
    || /(?:^|;)\s*visibility\s*:\s*hidden\b/.test(style);
}

function companyWebsite($, cell, sourceUrl) {
  const candidates = new Set();
  $(cell).find('a[href]').each((_, anchor) => {
    const text = normalizeText($(anchor).text()).toLocaleLowerCase('en');
    if (text && !/website|visit/i.test(text) && !/^https?:\/\//i.test(text)) return;
    const raw = normalizeText($(anchor).attr('href'));
    if (!raw || raw.startsWith('//')) return;
    let target;
    try { target = new URL(raw, sourceUrl); } catch { return; }
    const hostname = target.hostname.toLowerCase();
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password
      || target.origin === new URL(sourceUrl).origin || !hostname.includes('.') || isIP(hostname)
      || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || hostname.endsWith('.internal')) return;
    try { candidates.add(normalizeWebsiteUrl(target.href).href); } catch { /* Ignore a non-company link. */ }
  });
  return candidates.size === 1 ? [...candidates][0] : null;
}

function nextPages($, sourceUrl) {
  const current = new URL(sourceUrl);
  const links = $('a[rel~="next"],a[aria-label*="next" i],.pagination a,.pager a,[class*="pagination"] a');
  const candidates = links.length ? links : $('a[href]').filter((_, element) => /^(?:next|\d+)$/i.test(normalizeText($(element).text())));
  const output = [];
  candidates.each((_, element) => {
    const label = normalizeText($(element).attr('aria-label') || $(element).text());
    const href = $(element).attr('href');
    if (!href || !/^(?:next|\d+)$/i.test(label)) return;
    let target;
    try { target = new URL(href, sourceUrl); } catch { return; }
    if (target.protocol !== 'https:' || target.origin !== current.origin || target.pathname !== current.pathname
      || target.username || target.password) return;
    if (target.href !== current.href && !output.includes(target.href)) output.push(target.href);
  });
  return output;
}

export async function parseEepcCbamDirectoryPage(html, sourceUrl = EEPC_CBAM_SOURCE_URL) {
  const { load } = await loadCheerio();
  const $ = load(String(html || ''));
  let selectedTable = null;
  let columns = null;
  $('table').each((_, table) => {
    if (selectedTable) return;
    if (explicitlyHidden($, table)) return;
    const visibleTable = $(table).clone();
    visibleTable.find('script,style,template,noscript,iframe,object,embed').remove();
    visibleTable.find('tr').each((__, row) => { if (explicitlyHidden($, row)) $(row).remove(); });
    visibleTable.find('th,td').each((__, cell) => {
      if (explicitlyHidden($, cell)) $(cell).empty();
      else $(cell).find('*').each((___, child) => { if (explicitlyHidden($, child)) $(child).remove(); });
    });
    const header = visibleTable.find('thead tr').first().length
      ? visibleTable.find('thead tr').first() : visibleTable.find('tr').filter((__, row) => $(row).find('th').length).first();
    if (!header.length) return;
    const labels = header.find('th,td').map((__, cell) => columnKey($(cell).text())).get();
    const organization = labels.findIndex(label => /^(?:organization|organisation) name$/.test(label));
    const contact = labels.findIndex(label => /^contact person$/.test(label));
    const designation = labels.findIndex(label => /^designation$/.test(label));
    const email = labels.findIndex(label => /^(?:e mail|email)(?: address)?$/.test(label));
    const links = labels.findIndex(label => /^(?:quick links|links|website)$/.test(label));
    if ([organization, contact, designation, email].every(index => index >= 0)) {
      selectedTable = visibleTable;
      columns = { organization, contact, designation, email, links };
    }
  });
  if (!selectedTable || !columns) {
    return { records: [], pagination_urls: [], layout_detected: false, content_hash: hash(String(html || '')) };
  }

  const records = [];
  const tableRows = selectedTable.find('tr').toArray();
  const headerRow = selectedTable.find('thead tr').first().get(0)
    || selectedTable.find('tr').filter((__, row) => $(row).find('th').length).first().get(0);
  for (const row of tableRows) {
    if (row === headerRow || explicitlyHidden($, row) || !$(row).children('td').length) continue;
    const cells = $(row).children('td');
    const cellText = index => index >= 0 && cells.get(index) ? normalizeText($(cells.get(index)).text()) : '';
    const businessName = cellText(columns.organization).slice(0, 220);
    if (!businessName) continue;
    const contactName = cellText(columns.contact).slice(0, 160) || null;
    const contactTitle = cellText(columns.designation).slice(0, 160) || null;
    const emailText = cellText(columns.email);
    const emails = [...new Set((emailText.match(EMAIL_RE) || []).map(value => value.toLowerCase()))];
    const websiteUrl = columns.links >= 0 && cells.get(columns.links)
      ? companyWebsite($, cells.get(columns.links), sourceUrl) : null;
    const rowHtml = $(row).html() || '';
    const contentHash = hash(rowHtml);
    const businessKey = hash(`${businessName.toLocaleLowerCase('en')}\nindia`);
    const recordKey = hash(`${businessKey}\n${contactName || ''}\n${contactTitle || ''}\n${emails.join(',')}\n${websiteUrl || ''}`);
    const excerpt = [businessName, emails.length ? `Email: ${emails.join(', ')}` : null,
      contactName ? `Contact Person: ${contactName}` : null, contactTitle ? `Designation: ${contactTitle}` : null,
      websiteUrl ? `Website: ${websiteUrl}` : null].filter(Boolean).join(' · ').slice(0, 300);
    records.push({
      record_key: recordKey,
      business_key: businessKey,
      business_name: businessName,
      contact_person_name: contactName,
      contact_title: contactTitle,
      contact_type: contactTitle ? 'business_contact' : null,
      address: null,
      city: null,
      state: null,
      country: 'India',
      category: 'CBAM advisory service provider',
      products: null,
      website_url: websiteUrl,
      emails,
      source_url: `${sourceUrl}#record-${recordKey.slice(0, 16)}`,
      source_page_url: sourceUrl,
      raw_excerpt: excerpt,
      content_hash: contentHash,
    });
  }
  return {
    records,
    pagination_urls: nextPages($, sourceUrl),
    layout_detected: true,
    content_hash: hash(String(html || '')),
  };
}

async function reserveHostRequest(hostname, intervalMs, now, wait) {
  let state = hostSchedules.get(hostname);
  if (!state) {
    state = { nextAt: 0, tail: Promise.resolve(), queued: 0 };
    hostSchedules.set(hostname, state);
  }
  state.queued += 1;
  const previous = state.tail;
  let release;
  state.tail = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    const delay = Math.max(0, state.nextAt - now());
    if (delay) await wait(delay);
    state.nextAt = now() + intervalMs;
  } finally {
    state.queued = Math.max(0, state.queued - 1);
    release();
  }
}

export function createEepcCbamDirectoryAdapter({
  fetchImpl = safeFetch,
  now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  minimumRequestIntervalMs = 1000,
} = {}) {
  async function request(url, maxBytes, intervalMs) {
    await reserveHostRequest(new URL(url).hostname.toLowerCase(), intervalMs, now, wait);
    return fetchImpl(url, {
      method: 'GET', redirect: 'manual', timeoutMs: 12_000, maxBytes,
      headers: { 'User-Agent': WEBSITE_EMAIL_USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' },
    });
  }

  async function createSession() {
    const root = new URL(EEPC_CBAM_SOURCE_URL);
    let robots;
    try { robots = await request(new URL('/robots.txt', root).href, MAX_ROBOTS_BYTES, minimumRequestIntervalMs); }
    catch { throw new EpchDirectoryError('EEPC CBAM robots.txt could not be checked; no directory data was fetched.', 'robots_unavailable', 503); }
    const robotsStatus = Number(robots.status) || 0;
    let policy;
    if (robotsStatus === 404 || robotsStatus === 410) policy = parseRobotsPolicy('');
    else if (robotsStatus >= 200 && robotsStatus < 300) {
      const type = robots.headers?.get?.('content-type') || '';
      if (type && !/text\/plain|application\/octet-stream/i.test(type)) {
        throw new EpchDirectoryError('EEPC CBAM robots response has an unsupported content type.', 'robots_content_type_unsupported', 403);
      }
      policy = parseRobotsPolicy(await robots.text());
    } else if (robotsStatus === 429) {
      throw new EpchDirectoryError('EEPC CBAM robots requested a cooldown; directory data was not fetched.', 'source_rate_limited', 429,
        { retryAfter: robots.headers?.get?.('retry-after') || '' });
    } else if (robotsStatus === 401 || robotsStatus === 403) {
      throw new EpchDirectoryError('EEPC CBAM robots rules deny access.', 'robots_access_denied', 403);
    } else {
      throw new EpchDirectoryError(`EEPC CBAM robots rules returned HTTP ${robotsStatus || 'error'}.`, 'robots_unavailable', 503);
    }
    if (policy.crawlDelayMs > MAX_CRAWL_DELAY_MS) {
      throw new EpchDirectoryError('EEPC CBAM robots crawl delay exceeds this worker’s safe limit.', 'robots_crawl_delay_exceeds_limit', 403);
    }
    if (!policy.canFetch(root.pathname + root.search)) {
      throw new EpchDirectoryError('EEPC CBAM robots rules disallow the advisory directory page.', 'robots_disallowed', 403);
    }
    return { policy, directory_url: root.href, crawl_delay_ms: policy.crawlDelayMs };
  }

  async function fetchDirectoryPage(session, pageUrl) {
    let target;
    try { target = new URL(pageUrl); } catch { throw new EpchDirectoryError('EEPC CBAM page URL is invalid.', 'directory_page_invalid', 400); }
    const source = new URL(session.directory_url);
    if (target.protocol !== 'https:' || target.origin !== source.origin || target.pathname !== source.pathname
      || target.username || target.password) {
      throw new EpchDirectoryError('EEPC CBAM pagination left the approved source page.', 'pagination_origin_changed', 403);
    }
    if (!session.policy.canFetch(target.pathname + target.search)) {
      throw new EpchDirectoryError('EEPC CBAM robots rules disallow this directory page.', 'robots_disallowed', 403);
    }
    const response = await request(target.href, MAX_PAGE_BYTES, Math.max(minimumRequestIntervalMs, session.crawl_delay_ms));
    const status = Number(response.status) || 0;
    if (status === 401 || status === 403) throw new EpchDirectoryError(`EEPC CBAM denied the directory request (HTTP ${status}).`, 'source_access_denied', 403);
    if (status === 429) throw new EpchDirectoryError('EEPC CBAM throttled the directory request.', 'source_rate_limited', 429,
      { retryAfter: response.headers?.get?.('retry-after') || '' });
    if (status < 200 || status >= 300) throw new EpchDirectoryError(`EEPC CBAM page returned HTTP ${status || 'error'}.`, 'directory_page_unavailable');
    const type = response.headers?.get?.('content-type') || '';
    if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) {
      throw new EpchDirectoryError('EEPC CBAM page is not HTML.', 'directory_page_content_type_unsupported');
    }
    const parsed = await parseEepcCbamDirectoryPage(await response.text(), target.href);
    if (!parsed.layout_detected) {
      throw new EpchDirectoryError('EEPC CBAM advisory table changed or was not present; extraction stopped instead of reporting zero results.', 'directory_layout_changed');
    }
    return parsed;
  }

  return { createSession, fetchDirectoryPage };
}
