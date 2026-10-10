import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { safeFetch } from './ssrf-guard.js';
import { normalizeWebsiteUrl, parseRobotsPolicy, WEBSITE_EMAIL_USER_AGENT } from './website-email-discovery.js';

export const EPCH_DIRECTORY_SOURCE_URL = 'https://epch.in/member';
export const EPCH_DIRECTORY_EXTRACTOR_VERSION = 'epch-member-v2';
const MAX_ROBOTS_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_CRAWL_DELAY_MS = 10_000;
const EMAIL_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi;
const WEBSITE_TOKEN_RE = /https?:\/\/[^\s,;<>]+|(?<![@\w])(?:www\.)?(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?(?::\d{1,5})?(?:\/[^\s,;<>]*)?/gi;
const hostSchedules = new Map();

let cheerioModule = null;
async function loadCheerio() {
  if (!cheerioModule) cheerioModule = await import('cheerio');
  return cheerioModule;
}

export class EpchDirectoryError extends Error {
  constructor(message, code, statusCode = 502, details = {}) {
    super(message);
    this.name = 'EpchDirectoryError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfter = typeof details.retryAfter === 'string' ? details.retryAfter : null;
    this.retryAfterAt = typeof details.retryAfterAt === 'string' ? details.retryAfterAt : null;
  }
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function normalizeText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function textLines($, element) {
  const html = $(element).html() || '';
  const separated = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:h[1-6]|p|div|li|tr|td|th|section|article|address|footer)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
  return separated.split(/\r?\n/).map(normalizeText).filter(Boolean);
}

function fieldValue(text, label) {
  const labels = '(?:Contact\\s+Person|Address|Email|Products|Website|Phone)';
  const expression = new RegExp(`(?:^|\\n|\\s)${label}\\s*:\\s*([\\s\\S]*?)(?=\\s*(?:${labels})\\s*:|$)`, 'i');
  return normalizeText(expression.exec(text)?.[1] || '');
}

export function normalizeEpchCompanyWebsiteUrl(value, sourceUrl) {
  const raw = normalizeText(value).replace(/^[<([{\"'`]+|[>\])},.;!?\"'`]+$/g, '');
  if (!raw || raw.length > 2048 || /[\\\s]/.test(raw) || raw.startsWith('//')) return null;
  if (!/^https?:\/\//i.test(raw)
      && !/^(?:www\.)?(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?(?::\d{1,5})?(?:\/[^\s]*)?$/i.test(raw)) return null;
  let website;
  let source;
  try {
    website = normalizeWebsiteUrl(raw);
    source = new URL(sourceUrl);
  } catch { return null; }
  const hostname = website.hostname.toLowerCase();
  if (isIP(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.endsWith('.local') || hostname.endsWith('.internal') || website.origin === source.origin) return null;
  return website.href;
}

function websiteCandidatesFromText(value, sourceUrl) {
  const matches = [...String(value || '').matchAll(WEBSITE_TOKEN_RE)]
    .map(match => match[0].replace(/[)\]}.,;!?]+$/g, ''))
    .filter(Boolean);
  return matches.map(candidate => normalizeEpchCompanyWebsiteUrl(candidate, sourceUrl));
}

function explicitWebsiteUrl($, card, text, sourceUrl) {
  if (!/\bWebsite\s*:/i.test(text)) return null;
  const field = fieldValue(text, 'Website');
  const candidates = websiteCandidatesFromText(field, sourceUrl);
  let labeledAnchorCount = 0;
  const anchorCandidates = [];
  card.find('p,li,td,th,dd,div,span,label,a').each((_, element) => {
    const lines = textLines($, element);
    if (!/^Website\s*:/i.test(lines[0] || '')) return;
    const node = $(element);
    const anchors = node.is('a[href]') ? node : node.find('a[href]');
    anchors.each((__, anchor) => {
      labeledAnchorCount += 1;
      anchorCandidates.push(normalizeEpchCompanyWebsiteUrl($(anchor).attr('href'), sourceUrl));
    });
  });
  if (anchorCandidates.some(value => !value)) return null;
  if (!labeledAnchorCount && candidates.some(value => !value)) return null;
  const allCandidates = [...new Set([...candidates.filter(Boolean), ...anchorCandidates])];
  return allCandidates.length === 1 ? allCandidates[0] : null;
}

function parseAddress(address) {
  const parts = address.split(',').map(value => value.trim()).filter(Boolean);
  return {
    city: parts.length > 1 ? parts.at(-2).slice(0, 120) : null,
    state: parts.length > 1 ? parts.at(-1).slice(0, 120) : null,
  };
}

export async function parseEpchDirectoryPage(html, sourceUrl) {
  const { load } = await loadCheerio();
  const $ = load(String(html || ''));
  const headings = $('h3,h4,h5,h6,.company-name,[data-company-name]');
  const seenCards = new Set();
  const records = [];
  const headingSelector = 'h3,h4,h5,h6,.company-name,[data-company-name]';

  headings.each((_, heading) => {
    const name = normalizeText($(heading).attr('data-company-name') || $(heading).text());
    if (!name || name.length > 220) return;
    let card = null;
    let parent = $(heading).parent();
    for (let depth = 0; parent.length && depth < 8; depth += 1, parent = parent.parent()) {
      const titles = parent.find(headingSelector).length + (parent.is(headingSelector) ? 1 : 0);
      const text = textLines($, parent).join('\n');
      if (titles === 1 && (/\bAddress\s*:/i.test(text) || /\bContact\s+Person\s*:/i.test(text) || /\bProducts\s*:/i.test(text))) {
        card = parent;
        break;
      }
    }
    if (!card) return;
    const node = card.get(0);
    if (seenCards.has(node)) return;
    seenCards.add(node);
    const text = textLines($, card).join('\n');
    const emailField = fieldValue(text, 'Email');
    const emails = [...new Set((emailField.match(EMAIL_RE) || []).map(value => value.toLowerCase()))];
    const address = fieldValue(text, 'Address').slice(0, 500) || null;
    const contactPerson = fieldValue(text, 'Contact\\s+Person').slice(0, 160) || null;
    const products = fieldValue(text, 'Products').slice(0, 2000) || null;
    const websiteUrl = explicitWebsiteUrl($, card, text, sourceUrl);
    if (!emails.length && !address && !products && !contactPerson && !websiteUrl) return;
    const cityState = parseAddress(address || '');
    // Put the email ahead of long directory addresses/products so the saved
    // bounded evidence excerpt always contains the value it is proving.
    const excerpt = [name, emails.length && `Email: ${emails.join(', ')}`, websiteUrl && `Website: ${websiteUrl}`,
      contactPerson && `Contact Person: ${contactPerson}`, address && `Address: ${address}`,
      products && `Products: ${products}`].filter(Boolean).join(' · ').slice(0, 300);
    const recordKey = hash([name.toLocaleLowerCase('en'), (address || '').toLocaleLowerCase('en'), (contactPerson || '').toLocaleLowerCase('en'), websiteUrl || '', emails.join(',')].join('\n'));
    records.push({
      record_key: recordKey,
      business_key: hash([name.toLocaleLowerCase('en'), (address || '').toLocaleLowerCase('en'), 'India'].join('\n')),
      business_name: name,
      contact_person_name: contactPerson,
      address,
      city: cityState.city,
      state: cityState.state,
      country: 'India',
      category: 'Handicraft exporter',
      products,
      website_url: websiteUrl,
      emails,
      source_url: `${sourceUrl}#record-${recordKey.slice(0, 16)}`,
      source_page_url: sourceUrl,
      raw_excerpt: excerpt,
      content_hash: hash(text),
    });
  });

  const pager = $('a[rel~="next"],a[aria-label*="next" i],.pagination a,.pager a,[class*="pagination"] a');
  const candidateLinks = pager.length ? pager : $('a[href]').filter((_, element) => /^(?:next|\d+)$/i.test(normalizeText($(element).text())));
  const current = new URL(sourceUrl);
  const currentPage = Number(current.searchParams.get('page')) || 1;
  const paginationUrls = [];
  candidateLinks.each((_, element) => {
    const label = normalizeText($(element).attr('aria-label') || $(element).text());
    const href = $(element).attr('href');
    if (!href || !/^(?:next|\d+)$/i.test(label)) return;
    let target;
    try { target = new URL(href, sourceUrl); } catch { return; }
    if (target.protocol !== 'https:' || target.origin !== current.origin || target.pathname !== current.pathname) return;
    const candidatePage = Number(target.searchParams.get('page')) || null;
    if (/^\d+$/.test(label) && candidatePage !== null && candidatePage <= currentPage) return;
    if (target.href !== current.href && !paginationUrls.includes(target.href)) paginationUrls.push(target.href);
  });
  const pageText = normalizeText($('body').text());
  return {
    records,
    pagination_urls: paginationUrls,
    layout_detected: records.length > 0 || /member directory|no (?:member|record)s? found/i.test(pageText),
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

export function createEpchMemberDirectoryAdapter({
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
    const robotsUrl = new URL('/robots.txt', EPCH_DIRECTORY_SOURCE_URL).href;
    let robots;
    try { robots = await request(robotsUrl, MAX_ROBOTS_BYTES, minimumRequestIntervalMs); }
    catch { throw new EpchDirectoryError('EPCH robots.txt could not be checked; no directory data was fetched.', 'robots_unavailable', 503); }
    const robotsStatus = Number(robots.status) || 0;
    let policy;
    if (robotsStatus === 404 || robotsStatus === 410) policy = parseRobotsPolicy('');
    else if (robotsStatus >= 200 && robotsStatus < 300) {
      const type = robots.headers?.get?.('content-type') || '';
      if (type && !/text\/plain|application\/octet-stream/i.test(type)) {
        throw new EpchDirectoryError('EPCH robots response has an unsupported content type.', 'robots_content_type_unsupported', 403);
      }
      policy = parseRobotsPolicy(await robots.text());
    } else if (robotsStatus === 429) {
      throw new EpchDirectoryError('EPCH robots requested a cooldown; directory data was not fetched.', 'source_rate_limited', 429,
        { retryAfter: robots.headers?.get?.('retry-after') || '' });
    } else if ([401, 403].includes(robotsStatus)) {
      throw new EpchDirectoryError('EPCH robots rules deny access.', 'robots_access_denied', 403);
    } else {
      throw new EpchDirectoryError(`EPCH robots rules returned HTTP ${robotsStatus || 'error'}.`, 'robots_unavailable', 503);
    }
    if (policy.crawlDelayMs > MAX_CRAWL_DELAY_MS) {
      throw new EpchDirectoryError('EPCH robots crawl delay exceeds this worker’s safe limit.', 'robots_crawl_delay_exceeds_limit', 403);
    }
    const memberUrl = new URL(EPCH_DIRECTORY_SOURCE_URL);
    if (!policy.canFetch(memberUrl.pathname + memberUrl.search)) {
      throw new EpchDirectoryError('EPCH robots rules disallow the public member directory page.', 'robots_disallowed', 403);
    }
    const memberPage = await request(memberUrl.href, MAX_PAGE_BYTES, Math.max(minimumRequestIntervalMs, policy.crawlDelayMs));
    const memberStatus = Number(memberPage.status) || 0;
    if (memberStatus === 429) {
      throw new EpchDirectoryError('EPCH throttled access to its member directory page.', 'source_rate_limited', 429,
        { retryAfter: memberPage.headers?.get?.('retry-after') || '' });
    }
    if (memberStatus === 401 || memberStatus === 403) {
      throw new EpchDirectoryError(`EPCH denied access to its member directory page (HTTP ${memberStatus}).`, 'source_access_denied', 403);
    }
    if (memberStatus < 200 || memberStatus >= 300) {
      throw new EpchDirectoryError(`EPCH member page returned HTTP ${memberStatus || 'error'}.`, 'member_page_unavailable');
    }
    const memberType = memberPage.headers?.get?.('content-type') || '';
    if (memberType && !/text\/html|application\/xhtml\+xml/i.test(memberType)) {
      throw new EpchDirectoryError('EPCH member page is not HTML.', 'member_page_content_type_unsupported');
    }
    const memberHtml = await memberPage.text();
    const { load } = await loadCheerio();
    const $ = load(memberHtml);
    const iframeSource = $('iframe[src]').map((_, element) => $(element).attr('src')).get().find(Boolean);
    if (!iframeSource) throw new EpchDirectoryError('EPCH no longer exposes a member-directory frame; the source adapter needs review.', 'directory_frame_missing');
    let directoryUrl;
    try { directoryUrl = new URL(iframeSource, memberUrl); }
    catch { throw new EpchDirectoryError('EPCH directory frame URL is invalid.', 'directory_frame_invalid'); }
    if (directoryUrl.protocol !== 'https:' || directoryUrl.hostname.toLowerCase() !== memberUrl.hostname.toLowerCase()
      || directoryUrl.username || directoryUrl.password) {
      throw new EpchDirectoryError('EPCH directory frame left the approved source origin.', 'directory_frame_origin_changed', 403);
    }
    if (!policy.canFetch(directoryUrl.pathname + directoryUrl.search)) {
      throw new EpchDirectoryError('EPCH robots rules disallow the member-directory data path.', 'robots_disallowed', 403);
    }
    return { policy, directory_url: directoryUrl.href, crawl_delay_ms: policy.crawlDelayMs };
  }

  async function fetchDirectoryPage(session, pageUrl) {
    const url = new URL(pageUrl);
    const source = new URL(session.directory_url);
    if (url.protocol !== 'https:' || url.origin !== source.origin || url.pathname !== source.pathname) {
      throw new EpchDirectoryError('EPCH pagination left the approved directory path.', 'pagination_origin_changed', 403);
    }
    if (!session.policy.canFetch(url.pathname + url.search)) {
      throw new EpchDirectoryError('EPCH robots rules disallow this directory page.', 'robots_disallowed', 403);
    }
    const response = await request(url.href, MAX_PAGE_BYTES, Math.max(minimumRequestIntervalMs, session.crawl_delay_ms));
    const status = Number(response.status) || 0;
    if (status === 429) throw new EpchDirectoryError('EPCH throttled the directory request.', 'source_rate_limited', 429,
      { retryAfter: response.headers?.get?.('retry-after') || '' });
    if ([401, 403].includes(status)) throw new EpchDirectoryError(`EPCH denied the directory request (HTTP ${status}).`, 'source_access_denied', 403);
    if (status < 200 || status >= 300) throw new EpchDirectoryError(`EPCH directory page returned HTTP ${status || 'error'}.`, 'directory_page_unavailable');
    const type = response.headers?.get?.('content-type') || '';
    if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) throw new EpchDirectoryError('EPCH directory page is not HTML.', 'directory_page_content_type_unsupported');
    const html = await response.text();
    const parsed = await parseEpchDirectoryPage(html, url.href);
    if (!parsed.layout_detected) throw new EpchDirectoryError('EPCH page layout changed; extraction stopped instead of reporting zero results.', 'directory_layout_changed');
    return parsed;
  }

  return { createSession, fetchDirectoryPage };
}

