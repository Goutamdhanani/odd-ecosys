import { safeFetch } from './ssrf-guard.js';
import { createHash } from 'node:crypto';
import { getRenderedPage } from './screenshot.js';
import { extractCompanyPdfEmails, extractPdfTextIsolated, MAX_PDF_BYTES } from './pdf-text.js';

export const WEBSITE_EMAIL_BOT_NAME = 'OddEcosysLeadResearch';
export const WEBSITE_EMAIL_USER_AGENT = `${WEBSITE_EMAIL_BOT_NAME}/1.0 (+https://oddwebs.shop)`;

const MAX_ROBOTS_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_SCAN_REQUESTS = 12;
const MAX_DISCOVERED_PATHS = 8;
const MAX_RENDERED_PAGES = 2;
const MAX_RENDERED_REQUESTS = 8;
const MAX_RENDERED_BYTES = 1024 * 1024;
const MAX_RENDERED_RESPONSE_BYTES = 256 * 1024;
const MAX_RENDERED_TIMEOUT_MS = 6000;
const MAX_RENDERED_SETTLE_MS = 250;
const MAX_JSON_LD_SCRIPTS = 12;
const MAX_JSON_LD_SCRIPT_CHARS = 64 * 1024;
const MAX_JSON_LD_NODES = 500;
const MAX_EMAIL_META_TAGS = 200;
const MAX_MAILTO_ENDPOINTS = 200;
const MAX_ACCESSIBLE_EMAIL_LABELS = 200;
const MAX_ACCESSIBLE_EMAIL_CANDIDATES = 100;
const MAX_CONTACT_EMAIL_ATTRIBUTES = 200;
const MAX_CONTACT_EMAIL_CANDIDATES = 100;
const EMAIL_META_NAMES = new Set([
  'email', 'contact-email', 'contact_email', 'business-email', 'business_email', 'company-email', 'company_email',
]);
const SITEMAP_PATH_PREFIX = '@sitemap:';
const RESUMABLE_SCAN_FAILURES = new Set(['website_request_failed', 'site_unavailable', 'scan_request_budget_reached']);
const MAX_CRAWL_DELAY_MS = 10_000;
const MAX_RATE_LIMIT_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;
const FALLBACK_PAGE_PATHS = ['/', '/contact', '/contact-us', '/about', '/about-us'];
export const WEBSITE_EMAIL_EXTRACTOR_VERSION = 'website-html-v18';
export const WEBSITE_RENDERED_EXTRACTOR_VERSION = 'website-rendered-v16';
const WEBSITE_CONTACT_FORM_EVIDENCE_VERSION = 'website-contact-form-v1';
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mail.com', 'protonmail.com', 'proton.me',
  'zoho.com', 'yandex.com', 'gmx.com', 'fastmail.com',
]);
const hostSchedules = new Map();

let cheerioModule = null;
async function loadCheerio() {
  if (!cheerioModule) cheerioModule = await import('cheerio');
  return cheerioModule;
}

export class WebsiteEmailDiscoveryError extends Error {
  constructor(message, statusCode, code, scan = null) {
    super(message);
    this.name = 'WebsiteEmailDiscoveryError';
    this.statusCode = statusCode;
    this.code = code;
    this.scan = scan;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function rateLimitDeadline(retryAfter, attemptCount = 1, nowMs = Date.now()) {
  const exponential = Math.min(MAX_RATE_LIMIT_BACKOFF_MS,
    60_000 * (2 ** Math.min(10, Math.max(0, Number(attemptCount || 1) - 1))));
  const value = String(retryAfter || '').trim();
  let hintedDelay = 0;
  if (/^\d{1,10}$/.test(value)) hintedDelay = Math.min(MAX_RATE_LIMIT_DELAY_MS, Number(value) * 1000);
  else if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) hintedDelay = Math.min(MAX_RATE_LIMIT_DELAY_MS, Math.max(0, parsed - nowMs));
  }
  return new Date(nowMs + Math.max(exponential, hintedDelay)).toISOString();
}

async function reserveHostRequest(hostname, intervalMs, now, wait) {
  let state = hostSchedules.get(hostname);
  if (!state) {
    if (hostSchedules.size >= 2048) {
      for (const [key, value] of hostSchedules) {
        if (value.nextAt < now() - 60_000 && !value.queued) hostSchedules.delete(key);
        if (hostSchedules.size < 2048) break;
      }
    }
    if (hostSchedules.size >= 2048) throw new Error('Website scan host capacity exceeded');
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

function splitRobotsGroups(robotsText) {
  const groups = [];
  let current = null;
  let hasRules = false;
  for (const rawLine of String(robotsText || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!current || hasRules) {
        current = { agents: [], rules: [], crawlDelays: [] };
        groups.push(current);
        hasRules = false;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      if (value) current.rules.push({ type: field, path: value });
      hasRules = true;
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        current.crawlDelays.push(Math.min(seconds * 1000, MAX_CRAWL_DELAY_MS + 1));
      }
      hasRules = true;
    }
  }
  return groups;
}

function robotsGroupsForAgent(groups, botName = WEBSITE_EMAIL_BOT_NAME) {
  const token = botName.toLowerCase();
  const matches = [];
  for (const group of groups) {
    const specificity = Math.max(0, ...group.agents
      .filter(agent => agent !== '*' && token.includes(agent))
      .map(agent => agent.length));
    if (specificity) matches.push({ group, specificity });
  }
  if (matches.length) {
    const strongest = Math.max(...matches.map(match => match.specificity));
    return matches.filter(match => match.specificity === strongest).map(match => match.group);
  }
  return groups.filter(group => group.agents.includes('*'));
}

function pathRuleMatches(rulePath, requestPath) {
  const endAnchored = rulePath.endsWith('$');
  const source = endAnchored ? rulePath.slice(0, -1) : rulePath;
  const escaped = source.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${endAnchored ? '$' : ''}`).test(requestPath);
}

export function parseRobotsPolicy(robotsText, botName = WEBSITE_EMAIL_BOT_NAME) {
  const groups = robotsGroupsForAgent(splitRobotsGroups(robotsText), botName);
  const rules = groups.flatMap(group => group.rules);
  const crawlDelayMs = Math.max(0, ...groups.flatMap(group => group.crawlDelays));
  return {
    crawlDelayMs,
    canFetch(pathname) {
      const matches = rules
        .filter(rule => pathRuleMatches(rule.path, pathname))
        .map(rule => ({ ...rule, specificity: rule.path.replace(/\*|\$/g, '').length }))
        .sort((a, b) => b.specificity - a.specificity || Number(b.type === 'allow') - Number(a.type === 'allow'));
      return !matches.length || matches[0].type === 'allow';
    },
  };
}

const USEFUL_PATH_TERMS = [
  'contact', 'get-in-touch', 'team', 'about', 'location', 'branch', 'office', 'sales', 'distributor',
  'dealer', 'partner', 'enquir', 'inquir', 'request-quote', 'catalog', 'catalogue', 'brochure',
  'company-profile', 'corporate-profile', 'imprint', 'email', 'contacto', 'kontakt',
];
const EXCLUDED_PATH_TERMS = ['privacy', 'security', 'abuse', 'terms', 'legal', 'careers', 'jobs', 'press', 'reporter'];

function normalizeCrawlPath(value, baseUrl, siteOrigin) {
  let target;
  try { target = new URL(value, baseUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== siteOrigin || target.username || target.password) return null;
  if (target.pathname.length > 300 || /\.(?:jpe?g|png|gif|svg|webp|css|js|zip|mp[34]|woff2?|ttf)$/i.test(target.pathname)) return null;
  for (const key of target.searchParams.keys()) {
    if (!/^(?:utm_[a-z0-9_]+|gclid|fbclid|mc_cid|mc_eid)$/i.test(key)) return null;
  }
  target.search = '';
  target.hash = '';
  if (target.pathname.length > 1) target.pathname = target.pathname.replace(/\/+$/, '');
  return target.pathname || '/';
}

function usefulPathScore(pathname, label = '') {
  const text = `${pathname} ${label}`.toLowerCase().replace(/[_\s]+/g, '-');
  if (EXCLUDED_PATH_TERMS.some(term => text.includes(term))) return 0;
  const pageScore = USEFUL_PATH_TERMS.reduce((score, term) => score + (text.includes(term) ? (term === 'contact' ? 6 : term === 'sales' || term === 'email' ? 4 : 2) : 0), 0);
  return pageScore || (/\.vcf$/i.test(pathname) ? 1 : 0);
}

function sitemapEntry(pathname) {
  return `${SITEMAP_PATH_PREFIX}${pathname}`;
}

function parseRobotsSitemaps(robotsText, site) {
  const found = [];
  for (const rawLine of String(robotsText || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const match = /^sitemap\s*:\s*(\S+)/i.exec(line);
    if (!match) continue;
    let sitemapUrl;
    try { sitemapUrl = new URL(match[1]); } catch { continue; }
    if (!['http:', 'https:'].includes(sitemapUrl.protocol) || sitemapUrl.origin !== site.origin
      || sitemapUrl.username || sitemapUrl.password || sitemapUrl.search || sitemapUrl.hash) continue;
    if (sitemapUrl.pathname.length <= 300) found.push(sitemapEntry(sitemapUrl.pathname));
  }
  return [...new Set(found)].slice(0, 4);
}

async function extractUsefulLinks(html, pageUrl, siteOrigin) {
  const { load } = await loadCheerio();
  const $ = load(String(html || ''));
  const candidates = new Map();
  const sitemaps = [];
  $('a[href],area[href],link[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const rel = String($(element).attr('rel') || '').toLowerCase().split(/\s+/);
    if (rel.includes('sitemap')) {
      const sitemapPath = normalizeCrawlPath(href, pageUrl, siteOrigin);
      if (sitemapPath) sitemaps.push(sitemapEntry(sitemapPath));
      return;
    }
    const pathname = normalizeCrawlPath(href, pageUrl, siteOrigin);
    if (!pathname || pathname === '/') return;
    const label = `${$(element).text()} ${$(element).attr('alt') || ''} ${$(element).attr('title') || ''} ${$(element).attr('aria-label') || ''}`
      .replace(/\s+/g, ' ').trim();
    const score = usefulPathScore(pathname, label);
    if (score && (!candidates.has(pathname) || candidates.get(pathname) < score)) candidates.set(pathname, score);
  });
  const internalPaths = [...candidates.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_DISCOVERED_PATHS).map(([pathname]) => pathname);
  return { internal_paths: internalPaths, sitemap_paths: [...new Set(sitemaps)].slice(0, 4) };
}

async function extractUsefulSitemapPaths(xml, sitemapUrl, siteOrigin) {
  const { load } = await loadCheerio();
  const $ = load(String(xml || ''), { xmlMode: true });
  const pages = new Map();
  const sitemaps = [];
  $('loc').slice(0, 200).each((_, element) => {
    const raw = $(element).text().trim();
    let url;
    try { url = new URL(raw, sitemapUrl); } catch { return; }
    if (url.origin !== siteOrigin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    if (/\.xml$/i.test(url.pathname) && /sitemap/i.test(url.pathname)) {
      if (url.pathname.length <= 300) sitemaps.push(sitemapEntry(url.pathname));
      return;
    }
    const pathname = normalizeCrawlPath(raw, sitemapUrl, siteOrigin);
    if (!pathname || pathname === '/') return;
    const score = usefulPathScore(pathname);
    if (score) pages.set(pathname, Math.max(score, pages.get(pathname) || 0));
  });
  return {
    internal_paths: [...pages.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_DISCOVERED_PATHS).map(([pathname]) => pathname),
    sitemap_paths: [...new Set(sitemaps)].slice(0, 4),
  };
}

export function normalizeWebsiteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new WebsiteEmailDiscoveryError('Add a website to this contact first.', 422, 'website_missing');
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(candidate); }
  catch { throw new WebsiteEmailDiscoveryError('The contact website URL is invalid.', 422, 'website_invalid'); }
  const expectedDefaultPort = url.protocol === 'https:' ? '443' : '80';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !url.hostname.includes('.') || (url.port && url.port !== expectedDefaultPort)) {
    throw new WebsiteEmailDiscoveryError('Only public HTTP or HTTPS business websites can be scanned.', 422, 'website_invalid');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function responseStatus(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) ? status : 0;
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function boundedText(value, limit = 500) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text && text.length <= limit ? text : null;
}

function normalizePublicTelephone(value) {
  let number = String(value || '').trim().replace(/^tel:/i, '').split(/[?;]/, 1)[0].trim();
  try { number = decodeURIComponent(number); } catch { /* Use the link value exactly as observed. */ }
  if (!number || number.length > 40 || !/^\+?[\d().\s-]+$/.test(number)) return null;
  const digitCount = number.replace(/\D/g, '').length;
  return digitCount >= 7 && digitCount <= 18 ? number.replace(/\s+/g, ' ') : null;
}

function unescapeVcardText(value) {
  return String(value || '').replace(/\\[nN]/g, ' ')
    .replace(/\\([\\,;:])/g, '$1').replace(/\s+/g, ' ').trim();
}

function normalizedBusinessText(value) {
  return unescapeVcardText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function comparableHost(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch { return null; }
}

function extractVcardEmails(vcardText, { sourceUrl, contentHash, businessName, websiteHost }) {
  const source = String(vcardText || '').replace(/^\uFEFF/, '');
  if (!/^\s*BEGIN:VCARD\s*(?:\r?\n)/i.test(source)) return [];
  const unfolded = [];
  for (const line of source.split(/\r?\n/).slice(0, 30_000)) {
    if (/^[ \t]/.test(line) && unfolded.length) unfolded[unfolded.length - 1] += line.slice(1);
    else unfolded.push(line);
  }
  const expectedName = normalizedBusinessText(businessName);
  const expectedHost = String(websiteHost || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const output = new Map();
  let card = null;
  let processedCards = 0;
  for (const line of unfolded) {
    if (/^BEGIN:VCARD\s*$/i.test(line.trim())) {
      if (processedCards >= 40) break;
      processedCards += 1;
      card = [];
      continue;
    }
    if (!card) continue;
    if (/^END:VCARD\s*$/i.test(line.trim())) {
      const fields = new Map();
      for (const fieldLine of card) {
        const colon = fieldLine.indexOf(':');
        if (colon < 1) continue;
        const header = fieldLine.slice(0, colon).trim();
        const property = header.split(';', 1)[0].split('.').at(-1).toUpperCase();
        if (!fields.has(property)) fields.set(property, []);
        fields.get(property).push({ header, rawValue: fieldLine.slice(colon + 1) });
      }
      const getValue = key => fields.get(key)?.[0]?.rawValue || '';
      const rawOrg = unescapeVcardText(getValue('ORG'));
      const organizationMatches = Boolean(expectedName) && rawOrg.split(';').some(part => normalizedBusinessText(part) === expectedName);
      const cardHost = comparableHost(unescapeVcardText(getValue('URL')));
      const urlMatches = Boolean(expectedHost && cardHost === expectedHost);
      const privacy = [...(fields.get('CLASS') || []), ...(fields.get('X-PRIVACY') || [])]
        .some(item => /(?:private|confidential|personal)/i.test(unescapeVcardText(item.rawValue)));
      const contactName = boundedText(unescapeVcardText(getValue('FN')), 160);
      const contactTitle = boundedText(unescapeVcardText(getValue('TITLE') || getValue('ROLE')), 160);
      const emailRows = fields.get('EMAIL') || [];
      for (const emailRow of emailRows) {
        const colon = emailRow.header.indexOf(';');
        const parameters = (colon < 0 ? [] : emailRow.header.slice(colon + 1).split(';'))
          .flatMap(item => item.replace(/^TYPE=/i, '').split(',')).map(item => item.trim().toLowerCase());
        if (privacy || parameters.some(item => ['home', 'private', 'personal'].includes(item))) continue;
        const email = unescapeVcardText(emailRow.rawValue).replace(/^mailto:/i, '').toLowerCase();
        const domain = email.slice(email.lastIndexOf('@') + 1).replace(/^www\./, '').replace(/\.$/, '');
        const emailMatchesHost = Boolean(expectedHost && domain === expectedHost);
        if (!organizationMatches && !urlMatches && !emailMatchesHost) continue;
        if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) continue;
        const relevantLines = card.filter(item => /^(?:FN|ORG|TITLE|ROLE|EMAIL)(?:[;.]|:)/i.test(item));
        const rawExcerpt = relevantLines.join(' | ').replace(/\s+/g, ' ').trim().slice(0, 300);
        const existing = output.get(email) || {
          email,
          source_url: sourceUrl,
          evidence_type: 'website_vcard',
          extractor_version: 'website-vcard-v1',
          raw_excerpt: rawExcerpt,
          content_hash: contentHash,
          contact_points: [],
        };
        const point = { contact_type: null, contact_name: contactName, contact_title: contactTitle };
        if ((point.contact_name || point.contact_title) && !existing.contact_points.some(item =>
          item.contact_name === point.contact_name && item.contact_title === point.contact_title)) {
          existing.contact_points.push(point);
        }
        output.set(email, existing);
      }
      card = null;
      continue;
    }
    if (card.length < 200) card.push(line);
  }
  return [...output.values()];
}

function structuredAddress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const country = typeof value.addressCountry === 'string' ? value.addressCountry
    : value.addressCountry?.name || value.addressCountry?.identifier || null;
  const street = boundedText(value.streetAddress, 400);
  const city = boundedText(value.addressLocality, 120);
  const state = boundedText(value.addressRegion, 120);
  const postal = boundedText(value.postalCode, 32);
  const address = [street, city, state, postal, boundedText(country, 120)].filter(Boolean).join(', ');
  return { address: address || null, city, state, country: boundedText(country, 120) };
}

function directMicrodataProperties($, scope, property) {
  return $(scope).find(`[itemprop~="${property}"]`).toArray()
    .filter(element => $(element).parents('[itemscope]').first()[0] === scope).slice(0, 20);
}

function rdfaPropertyMatches(value, property) {
  return String(value || '').split(/\s+/).some(token => token.split(/[\/#:]/).at(-1).toLowerCase() === property.toLowerCase());
}

function directRdfaProperties($, scope, property) {
  return $(scope).find('[property]').toArray()
    .filter(element => rdfaPropertyMatches($(element).attr('property'), property)
      && $(element).parents('[typeof]').first()[0] === scope).slice(0, 20);
}

function rdfaValue($, element, property = '') {
  const $element = $(element);
  const content = String($element.attr('content') || '').trim();
  if (content) return content;
  const href = String($element.attr('href') || $element.attr('resource') || '').trim();
  if ((property === 'email' && /^mailto:/i.test(href)) || (property === 'telephone' && /^tel:/i.test(href))
      || property === 'url' || property === 'sameAs') return href;
  return String($element.attr('datetime') || $element.text()).replace(/\s+/g, ' ').trim();
}

function rdfaPropertyValues($, scope, property) {
  return directRdfaProperties($, scope, property).map(element => rdfaValue($, element, property)).filter(Boolean);
}

function microdataValue($, element, property = '') {
  const $element = $(element);
  const content = String($element.attr('content') || '').trim();
  if (content) return content;
  const href = String($element.attr('href') || '').trim();
  if (property === 'email' && /^mailto:/i.test(href)) return href;
  if (property === 'telephone' && /^tel:/i.test(href)) return href;
  if (property === 'url' || property === 'sameAs') return href || String($element.attr('value') || '').trim() || $element.text().trim();
  const value = String($element.attr('value') || $element.attr('datetime') || '').trim();
  return value || $element.text().replace(/\s+/g, ' ').trim();
}

function microdataPropertyValues($, scope, property) {
  return directMicrodataProperties($, scope, property).map(element => microdataValue($, element, property)).filter(Boolean);
}

function directHCardProperties($, scope, property) {
  return $(scope).find(`[class~="${property}"]`).toArray()
    .filter(element => $(element).parents('[class~="h-card"]').first()[0] === scope).slice(0, 20);
}

function hCardValue($, element, property) {
  const $element = $(element);
  const content = String($element.attr('content') || $element.attr('title') || $element.attr('value') || '').trim();
  if (content) return content;
  const href = String($element.attr('href') || '').trim();
  if ((property === 'u-email' && /^mailto:/i.test(href)) || (property === 'p-tel' && /^tel:/i.test(href))
      || property === 'u-url') return href;
  const src = String($element.attr('src') || '').trim();
  if (src && (property === 'u-photo' || property === 'u-logo')) return src;
  const datetime = String($element.attr('datetime') || '').trim();
  return datetime || $element.text().replace(/\s+/g, ' ').trim();
}

function hCardEmailIsPrivate($, emailElement, scope) {
  let current = emailElement;
  while (current) {
    const $current = $(current);
    const classes = String($current.attr('class') || '').split(/\s+/);
    if (classes.some(name => ['private', 'confidential'].includes(name.toLowerCase()))
        || String($current.attr('data-private') || '').toLowerCase() === 'true') return true;
    if (current === scope) break;
    current = $current.parent()[0];
  }
  return false;
}

function organizationType(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some(type => {
    const name = String(type || '').split(/[\/#]/).at(-1).toLowerCase();
    return name === 'organization' || name === 'corporation' || name === 'store' || name === 'localbusiness'
      || name.endsWith('business') || name.endsWith('organization');
  });
}

function personType(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some(type => String(type || '').split(/[\/#:]/).at(-1).toLowerCase() === 'person');
}

function contactPointType(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some(type => String(type || '').split(/[\/#:]/).at(-1).toLowerCase() === 'contactpoint');
}

function indexLocalJsonLdIds(root) {
  const pending = [root];
  const visited = new Set();
  const indexed = new Map();
  const ambiguous = new Set();
  while (pending.length && visited.size < MAX_JSON_LD_NODES) {
    const node = pending.shift();
    if (Array.isArray(node)) {
      const room = Math.max(0, MAX_JSON_LD_NODES - visited.size - pending.length);
      pending.push(...node.slice(0, room));
      continue;
    }
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    visited.add(node);
    const id = typeof node['@id'] === 'string' ? node['@id'].trim() : '';
    const isDefinition = Object.keys(node).some(key => !['@id', '@context', '@type'].includes(key));
    if (id && id.length <= 2048 && isDefinition && !ambiguous.has(id)) {
      if (indexed.has(id)) {
        indexed.delete(id);
        ambiguous.add(id);
      } else indexed.set(id, node);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '@context' || key === '@id' || key === '@type') continue;
      const children = Array.isArray(value) ? value : [value];
      const room = Math.max(0, MAX_JSON_LD_NODES - visited.size - pending.length);
      pending.push(...children.slice(0, room).filter(child => child && typeof child === 'object'));
      if (pending.length + visited.size >= MAX_JSON_LD_NODES) break;
    }
  }
  return indexed;
}

function safeFacebookProfile(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password
      || !['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname.toLowerCase())
      || url.pathname === '/' || /^\/(?:login|groups|profile\.php|watch|events|share|marketplace|help|privacy)(?:\/|$)/i.test(url.pathname)) return null;
  url.hostname = 'www.facebook.com';
  url.search = '';
  url.hash = '';
  return url.href.length <= 2000 ? url.href : null;
}

function sourceExcerpt(source, values = []) {
  const positions = values.map(value => typeof value === 'string' ? source.indexOf(value) : -1).filter(index => index >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 100) : 0;
  return source.slice(start, start + 300).replace(/\s+/g, ' ').trim();
}

function sourceEvidenceExcerpt(source, values = []) {
  const snippets = [];
  for (const rawValue of values) {
    const value = String(rawValue || '').trim();
    if (!value || snippets.length >= 8) continue;
    const position = source.indexOf(value);
    if (position < 0) continue;
    const snippet = source.slice(Math.max(0, position - 28), Math.min(source.length, position + value.length + 28))
      .replace(/\s+/g, ' ').trim();
    if (snippet && !snippets.includes(snippet)) snippets.push(snippet);
    if (snippets.join(' | ').length >= 300) break;
  }
  return (snippets.join(' | ') || sourceExcerpt(source, values)).slice(0, 300);
}

async function extractPageData(html, sourceUrl, contentHash, { rendered = false, businessName = '', websiteHost = '' } = {}) {
  const { load } = await loadCheerio();
  const $ = load(html);
  const emails = new Map();
  const add = (value, rawExcerpt, evidenceType, contactPoints = []) => {
    let candidate = String(value || '').trim().replace(/^mailto:/i, '');
    try { candidate = decodeURIComponent(candidate); } catch { /* Keep the public source text as observed. */ }
    const addresses = candidate.split(/[?;]/, 1)[0].split(',');
    for (const value of addresses) {
      const email = value.trim().toLowerCase();
      if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) continue;
      if (/\.(?:png|jpe?g|gif|svg|webp|css|js)$/i.test(email)) continue;
      const previous = emails.get(email);
      if (!previous || evidenceType === 'mailto') {
        emails.set(email, {
          email,
          source_url: sourceUrl,
          evidence_type: rendered ? `rendered_${evidenceType}` : evidenceType,
          extractor_version: rendered ? WEBSITE_RENDERED_EXTRACTOR_VERSION : WEBSITE_EMAIL_EXTRACTOR_VERSION,
          raw_excerpt: String(rawExcerpt || email).replace(/\s+/g, ' ').trim().slice(0, 300),
          content_hash: contentHash,
          contact_points: previous?.contact_points || [],
        });
      }
      const item = emails.get(email);
      for (const point of contactPoints) {
        const normalized = {
          contact_type: boundedText(point?.contact_type, 120),
          contact_name: boundedText(point?.contact_name, 160),
          contact_title: boundedText(point?.contact_title, 160),
        };
        if (!Object.values(normalized).some(Boolean)) continue;
        if (!item.contact_points.some(existing => existing.contact_type === normalized.contact_type
          && existing.contact_name === normalized.contact_name && existing.contact_title === normalized.contact_title)) {
          item.contact_points.push(normalized);
        }
      }
    }
  };
  const mailtoEndpoints = [];
  for (const [selector, attribute] of [
    ['a[href]', 'href'], ['area[href]', 'href'], ['link[href]', 'href'], ['form[action]', 'action'], ['[formaction]', 'formaction'],
  ]) {
    for (const element of $(selector).toArray()) {
      const value = String($(element).attr(attribute) || '').trim();
      if (!/^mailto:/i.test(value)) continue;
      mailtoEndpoints.push({ element, value, attribute });
      if (mailtoEndpoints.length >= MAX_MAILTO_ENDPOINTS) break;
    }
    if (mailtoEndpoints.length >= MAX_MAILTO_ENDPOINTS) break;
  }
  for (const { element, value, attribute } of mailtoEndpoints) {
    const $element = $(element);
    if (hCardEmailIsPrivate($, element, $element.closest('[class~="h-card"]')[0] || null)) continue;
    const label = $element.text().replace(/\s+/g, ' ').trim() || String($element.attr('alt') || $element.attr('title') || '').trim();
    const blockContext = ['a', 'area'].includes(String(element.tagName || '').toLowerCase())
      ? $element.closest('footer,section,address,div,p,li').first().text().replace(/\s+/g, ' ').trim()
      : sourceExcerpt(html, [value]);
    const context = blockContext || label || `${String(element.tagName || 'element').toLowerCase()} ${attribute}=${value}`;
    add(value, context, 'mailto');
  }

  let accessibleLabelsExamined = 0;
  let accessibleEmailCandidates = 0;
  const accessibleEmailAttributes = [
    ['a[aria-label],area[aria-label],button[aria-label],input[aria-label]', 'aria-label'],
    ['a[title],area[title],button[title],input[title]', 'title'],
    ['img[alt]', 'alt'], ['img[title]', 'title'],
  ];
  for (const [selector, attribute] of accessibleEmailAttributes) {
    for (const element of $(selector).toArray()) {
      if (accessibleLabelsExamined >= MAX_ACCESSIBLE_EMAIL_LABELS
          || accessibleEmailCandidates >= MAX_ACCESSIBLE_EMAIL_CANDIDATES) break;
      accessibleLabelsExamined += 1;
      if (String(element.tagName || '').toLowerCase() === 'input'
          && String($(element).attr('type') || '').toLowerCase() === 'hidden') continue;
      if (String(element.tagName || '').toLowerCase() === 'img') {
        const src = String($(element).attr('src') || '').trim();
        if (src) {
          try { if (new URL(src, sourceUrl).origin !== new URL(sourceUrl).origin) continue; }
          catch { continue; }
        }
      }
      if (hCardEmailIsPrivate($, element, null)) continue;
      const rawLabel = String($(element).attr(attribute) || '').trim();
      if (!rawLabel || rawLabel.length > 500) continue;
      for (const match of rawLabel.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi)) {
        const email = match[0];
        const start = Math.max(0, match.index - 80);
        const end = Math.min(rawLabel.length, match.index + email.length + 80);
        const excerpt = `${attribute}: ${rawLabel.slice(start, end)}`.replace(/\s+/g, ' ').trim();
        add(email, excerpt, 'website_accessible_text');
        accessibleEmailCandidates += 1;
        if (accessibleEmailCandidates >= MAX_ACCESSIBLE_EMAIL_CANDIDATES) break;
      }
    }
    if (accessibleLabelsExamined >= MAX_ACCESSIBLE_EMAIL_LABELS
        || accessibleEmailCandidates >= MAX_ACCESSIBLE_EMAIL_CANDIDATES) break;
  }

  let contactEmailAttributesExamined = 0;
  let contactEmailAttributeCandidates = 0;
  for (const [selector, attribute] of [
    ['[data-contact-email]', 'data-contact-email'],
    ['[data-business-email]', 'data-business-email'],
  ]) {
    for (const element of $(selector).toArray()) {
      if (contactEmailAttributesExamined >= MAX_CONTACT_EMAIL_ATTRIBUTES
          || contactEmailAttributeCandidates >= MAX_CONTACT_EMAIL_CANDIDATES) break;
      contactEmailAttributesExamined += 1;
      if (hCardEmailIsPrivate($, element, null)) continue;
      const $element = $(element);
      const hidden = [element, ...$element.parents().toArray()].some(node => {
        const $node = $(node);
        return $node.attr('hidden') !== undefined
          || String($node.attr('aria-hidden') || '').toLowerCase() === 'true'
          || (String(node.tagName || '').toLowerCase() === 'input'
            && String($node.attr('type') || '').toLowerCase() === 'hidden');
      });
      if (hidden) continue;
      const rawValue = String($element.attr(attribute) || '').trim();
      if (!rawValue || rawValue.length > 500) continue;
      for (const match of rawValue.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi)) {
        const email = match[0];
        const start = Math.max(0, match.index - 60);
        const end = Math.min(rawValue.length, match.index + email.length + 60);
        const excerpt = `${attribute}: ${rawValue.slice(start, end)}`.replace(/\s+/g, ' ').trim();
        add(email, excerpt, 'website_contact_attribute');
        contactEmailAttributeCandidates += 1;
        if (contactEmailAttributeCandidates >= MAX_CONTACT_EMAIL_CANDIDATES) break;
      }
    }
    if (contactEmailAttributesExamined >= MAX_CONTACT_EMAIL_ATTRIBUTES
        || contactEmailAttributeCandidates >= MAX_CONTACT_EMAIL_CANDIDATES) break;
  }

  const profile = { business_name: null, category: null, address: null, city: null, state: null, country: null, phone: null, facebook_url: null };
  let profileExcerpt = null;
  let profileEvidenceType = null;
  let facebookProfileExcerpt = null;
  let parsedNodes = 0;
  const jsonLdScripts = $('script[type="application/ld+json"]').slice(0, MAX_JSON_LD_SCRIPTS).toArray()
    .map(script => {
      const source = String($(script).text() || '').trim();
      if (!source || source.length > MAX_JSON_LD_SCRIPT_CHARS) return null;
      try { return { source, root: JSON.parse(source) }; } catch { return null; }
    }).filter(Boolean);
  const localJsonLdIds = indexLocalJsonLdIds(jsonLdScripts.map(item => item.root));
  for (const { source, root } of jsonLdScripts) {
    const pending = [root];
    while (pending.length && parsedNodes < MAX_JSON_LD_NODES) {
      const node = pending.shift();
      if (Array.isArray(node)) {
        pending.push(...node.slice(0, MAX_JSON_LD_NODES - parsedNodes));
        continue;
      }
      if (!node || typeof node !== 'object') continue;
      parsedNodes += 1;
      for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(value)) pending.push(...value.slice(0, 40));
        else if (value && typeof value === 'object') pending.push(value);
        if (pending.length + parsedNodes >= MAX_JSON_LD_NODES) break;
      }
      if (!organizationType(node['@type'])) continue;

      const expectedOrganizationName = normalizedBusinessText(businessName || '');
      const scannedOrganizationHost = String(websiteHost || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
      const organizationName = normalizedBusinessText(node.name || '');
      const organizationUrl = typeof node.url === 'string' ? node.url
        : node.url && typeof node.url === 'object' ? (node.url.url || node.url['@id'] || node.url.value || '') : '';
      const organizationUrlHost = comparableHost(organizationUrl);
      const organizationUrlConflicts = Boolean(scannedOrganizationHost && organizationUrlHost
        && scannedOrganizationHost !== organizationUrlHost);
      const linkedPeopleBelongToLead = Boolean(expectedOrganizationName && !organizationUrlConflicts
        && (organizationName === expectedOrganizationName
          || Boolean(scannedOrganizationHost && organizationUrlHost === scannedOrganizationHost)));
      const contactPoints = (Array.isArray(node.contactPoint) ? node.contactPoint : [node.contactPoint])
        .filter(item => item && typeof item === 'object' && !Array.isArray(item)).slice(0, 20)
        .map(item => {
          const hasInlineProperties = Object.keys(item).some(key => !['@id', '@context', '@type'].includes(key));
          if (hasInlineProperties) return item;
          const id = typeof item['@id'] === 'string' ? item['@id'].trim() : '';
          const resolved = id && linkedPeopleBelongToLead ? localJsonLdIds.get(id) || null : null;
          return resolved && contactPointType(resolved['@type']) ? resolved : null;
        }).filter(Boolean);
      const structuredEmails = [node.email, ...contactPoints.map(item => item?.email)].flat(2).filter(Boolean).slice(0, 20);
      const structuredPhones = [node.telephone, ...contactPoints.map(item => item?.telephone)].filter(Boolean);
      const context = `${boundedText(node.name, 200) || ''} ${structuredPhones.map(item => boundedText(item, 80) || '').join(' ')} ${sourceExcerpt(source, structuredEmails.map(item => String(item)))}`.trim();
      for (const email of [node.email].flat(2).filter(Boolean).slice(0, 20)) add(email, context || sourceExcerpt(source), 'website_json_ld');
      for (const point of contactPoints) {
        const pointEmails = [point.email].flat(2).filter(Boolean).slice(0, 20);
        const pointEvidence = [{
          contact_type: point.contactType,
          contact_name: point.name,
          contact_title: point.jobTitle,
        }];
        for (const email of pointEmails) add(email, context || sourceExcerpt(source), 'website_json_ld', pointEvidence);
      }
      if (linkedPeopleBelongToLead) {
        for (const relationship of ['employee', 'founder', 'member']) {
          const people = (Array.isArray(node[relationship]) ? node[relationship] : [node[relationship]])
            .filter(person => person && typeof person === 'object' && !Array.isArray(person))
            .map(person => personType(person['@type']) ? person
              : (typeof person['@id'] === 'string' ? localJsonLdIds.get(person['@id'].trim()) || null : null))
            .filter(person => person && personType(person['@type']))
            .slice(0, 20);
          for (const person of people) {
            const point = [{
              contact_type: relationship,
              contact_name: person.name,
              contact_title: person.jobTitle || person.title,
            }];
            const personEmails = [person.email].flat(2).filter(email => typeof email === 'string' && email.trim()).slice(0, 20);
            const personContext = `${boundedText(node.name, 200) || ''} ${boundedText(person.name, 160) || ''} ${boundedText(person.jobTitle || person.title, 160) || ''} ${sourceExcerpt(source, personEmails.map(String))}`.trim();
            for (const email of personEmails) add(email, personContext || sourceExcerpt(source), 'website_json_ld_person', point);
          }
        }
      }
      const addressNode = Array.isArray(node.address) ? node.address[0] : node.address;
      const address = structuredAddress(addressNode);
      const sameAs = Array.isArray(node.sameAs) ? node.sameAs : [node.sameAs];
      const facebook = sameAs.map(safeFacebookProfile).find(Boolean) || null;
      profile.business_name ||= boundedText(node.name, 200);
      profile.category ||= boundedText(node.industry, 120);
      profile.address ||= address.address;
      profile.city ||= address.city;
      profile.state ||= address.state;
      profile.country ||= address.country;
      profile.phone ||= boundedText(structuredPhones[0], 80);
      profile.facebook_url ||= facebook;
      if (facebook) facebookProfileExcerpt ||= `Facebook business page: ${facebook}`;
      if (!profileExcerpt && Object.values(profile).some(Boolean)) {
        profileExcerpt = sourceExcerpt(source, [node.name, node.industry, structuredPhones[0], address.city, address.state, structuredEmails[0]].filter(Boolean).map(String));
        profileEvidenceType = rendered ? 'website_rendered_json_ld_profile' : 'website_json_ld_profile';
      }
    }
  }

  const microdataScopes = $('[itemscope][itemtype]').toArray().slice(0, MAX_JSON_LD_NODES);
  for (const scope of microdataScopes) {
    const itemTypes = String($(scope).attr('itemtype') || '').split(/\s+/).filter(Boolean);
    if (!organizationType(itemTypes)) continue;
    const scopeBusinessName = microdataPropertyValues($, scope, 'name')[0] || null;
    const expectedBusinessName = normalizedBusinessText(businessName || '');
    const scopedBusinessName = normalizedBusinessText(scopeBusinessName || '');
    const scopedHost = String(websiteHost || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    const microdataWebsite = microdataPropertyValues($, scope, 'url').map(comparableHost).find(Boolean) || null;
    const directEmails = microdataPropertyValues($, scope, 'email');
    const emailDomainMatches = directEmails.some(email => String(email).trim().toLowerCase().split('@').at(-1)
      ?.replace(/^www\./, '').replace(/\.$/, '') === scopedHost);
    const explicitIdentityMatches = Boolean(expectedBusinessName && scopedBusinessName === expectedBusinessName);
    const unnamedScopeMatches = !scopedBusinessName && Boolean(scopedHost)
      && (microdataWebsite === scopedHost || emailDomainMatches);
    if (!explicitIdentityMatches && !unnamedScopeMatches) continue;
    const industry = microdataPropertyValues($, scope, 'industry')[0] || null;
    const businessEmails = directEmails.slice(0, 20);
    const businessPhones = microdataPropertyValues($, scope, 'telephone').slice(0, 10);
    const sameAsValues = microdataPropertyValues($, scope, 'sameAs');
    const addressScope = directMicrodataProperties($, scope, 'address')
      .find(element => $(element).attr('itemscope') !== undefined);
    const address = addressScope ? structuredAddress({
      streetAddress: microdataPropertyValues($, addressScope, 'streetAddress')[0],
      addressLocality: microdataPropertyValues($, addressScope, 'addressLocality')[0],
      addressRegion: microdataPropertyValues($, addressScope, 'addressRegion')[0],
      postalCode: microdataPropertyValues($, addressScope, 'postalCode')[0],
      addressCountry: microdataPropertyValues($, addressScope, 'addressCountry')[0],
    }) : {};
    profile.business_name ||= boundedText(scopeBusinessName, 200);
    profile.category ||= boundedText(industry, 120);
    profile.address ||= address.address;
    profile.city ||= address.city;
    profile.state ||= address.state;
    profile.country ||= address.country;
    profile.phone ||= normalizePublicTelephone(businessPhones[0]) || boundedText(businessPhones[0], 80);
    profile.facebook_url ||= sameAsValues.map(safeFacebookProfile).find(Boolean) || null;

    const contactScopes = $(scope).find('[itemscope][itemprop~="contactPoint"]').toArray()
      .filter(element => $(element).parents('[itemscope]').first()[0] === scope).slice(0, 20);
    for (const contactScope of contactScopes) {
      const personScopes = $(contactScope).find('[itemscope][itemtype]').toArray()
        .filter(element => $(element).parents('[itemscope]').first()[0] === contactScope
          && String($(element).attr('itemtype') || '').split(/[\s/]/).at(-1).toLowerCase() === 'person').slice(0, 5);
      const personNames = personScopes.flatMap(person => microdataPropertyValues($, person, 'name'));
      const personTitles = personScopes.flatMap(person => [
        ...microdataPropertyValues($, person, 'jobTitle'), ...microdataPropertyValues($, person, 'title'),
      ]);
      const point = {
        contact_type: microdataPropertyValues($, contactScope, 'contactType')[0] || null,
        contact_name: microdataPropertyValues($, contactScope, 'name')[0] || personNames[0] || null,
        contact_title: microdataPropertyValues($, contactScope, 'jobTitle')[0]
          || microdataPropertyValues($, contactScope, 'title')[0] || personTitles[0] || null,
      };
      const pointEmails = microdataPropertyValues($, contactScope, 'email').slice(0, 20);
      const context = sourceExcerpt(html, [scopeBusinessName, point.contact_type, point.contact_name, point.contact_title, ...pointEmails]
        .filter(Boolean).map(String));
      for (const email of pointEmails) add(email, context || sourceExcerpt(html), 'website_microdata', [point]);
    }
    const businessContext = sourceExcerpt(html, [scopeBusinessName, industry, ...businessPhones, ...businessEmails]
      .filter(Boolean).map(String));
    for (const email of businessEmails) add(email, businessContext || sourceExcerpt(html), 'website_microdata');
    if (Object.values(profile).some(Boolean)) {
      const profileContext = sourceExcerpt(html, [scopeBusinessName, industry, businessPhones[0], address.city, address.state, ...sameAsValues]
        .filter(Boolean).map(String));
      if (profileContext) {
        profileExcerpt = `${profileExcerpt ? `${profileExcerpt} | ` : ''}Microdata: ${profileContext}`.slice(0, 300);
        profileEvidenceType ||= rendered ? 'website_rendered_microdata_profile' : 'website_microdata_profile';
      }
    }
  }

  const rdfaScopes = $('[typeof]').toArray().slice(0, MAX_JSON_LD_NODES);
  const expectedRdfaBusiness = normalizedBusinessText(businessName || '');
  const scannedRdfaHost = String(websiteHost || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  for (const scope of rdfaScopes) {
    const itemTypes = String($(scope).attr('typeof') || '').split(/\s+/).filter(Boolean);
    if (!organizationType(itemTypes)) continue;
    const scopeName = rdfaPropertyValues($, scope, 'name')[0] || null;
    const normalizedScopeName = normalizedBusinessText(scopeName || '');
    const rdfaWebsite = rdfaPropertyValues($, scope, 'url').map(comparableHost).find(Boolean) || null;
    const hostMatches = Boolean(scannedRdfaHost && rdfaWebsite === scannedRdfaHost);
    const urlConflicts = Boolean(scannedRdfaHost && rdfaWebsite && rdfaWebsite !== scannedRdfaHost);
    const businessMatches = Boolean(expectedRdfaBusiness && !urlConflicts
      && (normalizedScopeName === expectedRdfaBusiness || (!scopeName && hostMatches)));
    if (!businessMatches) continue;

    const businessCategory = rdfaPropertyValues($, scope, 'industry')[0] || null;
    const postalAddressScope = $(scope).find('[typeof]').toArray()
      .find(element => rdfaPropertyMatches($(element).attr('property'), 'address')
        && $(element).parents('[typeof]').first()[0] === scope
        && String($(element).attr('typeof') || '').split(/\s+/).some(type => type.split(/[\/#:]/).at(-1).toLowerCase() === 'postaladdress'));
    const rdfaAddressParts = postalAddressScope ? {
      streetAddress: rdfaPropertyValues($, postalAddressScope, 'streetAddress')[0],
      addressLocality: rdfaPropertyValues($, postalAddressScope, 'addressLocality')[0],
      addressRegion: rdfaPropertyValues($, postalAddressScope, 'addressRegion')[0],
      postalCode: rdfaPropertyValues($, postalAddressScope, 'postalCode')[0],
      addressCountry: rdfaPropertyValues($, postalAddressScope, 'addressCountry')[0],
    } : {};
    const rdfaAddress = structuredAddress(rdfaAddressParts);
    profile.category ||= boundedText(businessCategory, 120);
    profile.address ||= rdfaAddress.address;
    profile.city ||= rdfaAddress.city;
    profile.state ||= rdfaAddress.state;
    profile.country ||= rdfaAddress.country;
    if (businessCategory || rdfaAddress.address) {
      const profileDetails = [scopeName, businessCategory, rdfaAddress.address, rdfaAddress.city, rdfaAddress.state]
        .filter(Boolean).map(String);
      const evidenceExcerpt = `RDFa business profile: ${sourceEvidenceExcerpt(html, [
        ...profileDetails, ...Object.values(rdfaAddressParts),
      ])}`;
      profileExcerpt = `${profileExcerpt ? `${profileExcerpt} | ` : ''}${evidenceExcerpt}`.slice(0, 300);
      profileEvidenceType ||= rendered ? 'website_rendered_rdfa_profile' : 'website_rdfa_profile';
    }

    const businessEmails = rdfaPropertyValues($, scope, 'email').slice(0, 20);
    const businessContext = sourceExcerpt(html, [scopeName, ...businessEmails].filter(Boolean).map(String));
    for (const email of businessEmails) add(email, businessContext || sourceExcerpt(html), 'website_rdfa');
    const businessPhone = rdfaPropertyValues($, scope, 'telephone').map(normalizePublicTelephone).find(Boolean) || null;
    if (businessPhone) {
      profile.phone ||= businessPhone;
      profileExcerpt = `RDFa business telephone: ${businessPhone} | RDFa business profile: ${sourceEvidenceExcerpt(html, [businessPhone, scopeName, businessCategory,
        ...Object.values(rdfaAddressParts)])}`;
      profileEvidenceType ||= rendered ? 'website_rendered_rdfa_profile' : 'website_rdfa_profile';
    }

    const contactScopes = $(scope).find('[typeof]').toArray()
      .filter(element => rdfaPropertyMatches($(element).attr('property'), 'contactPoint')
        && $(element).parents('[typeof]').first()[0] === scope
        && String($(element).attr('typeof') || '').split(/\s+/).some(type => type.split(/[\/#:]/).at(-1).toLowerCase() === 'contactpoint'))
      .slice(0, 20);
    for (const contactScope of contactScopes) {
      const personScopes = $(contactScope).find('[typeof]').toArray()
        .filter(element => $(element).parents('[typeof]').first()[0] === contactScope
          && String($(element).attr('typeof') || '').split(/\s+/).some(type => type.split(/[\/#:]/).at(-1).toLowerCase() === 'person'))
        .slice(0, 5);
      const point = {
        contact_type: rdfaPropertyValues($, contactScope, 'contactType')[0] || null,
        contact_name: rdfaPropertyValues($, contactScope, 'name')[0] || null,
        contact_title: rdfaPropertyValues($, contactScope, 'jobTitle')[0]
          || rdfaPropertyValues($, contactScope, 'title')[0] || null,
      };
      const pointEmails = rdfaPropertyValues($, contactScope, 'email').slice(0, 20);
      const context = sourceExcerpt(html, [scopeName, point.contact_type, point.contact_name, point.contact_title, ...pointEmails]
        .filter(Boolean).map(String));
      for (const email of pointEmails) add(email, context || sourceExcerpt(html), 'website_rdfa', [point]);
      for (const person of personScopes) {
        const personPoint = {
          contact_type: point.contact_type,
          contact_name: rdfaPropertyValues($, person, 'name')[0] || null,
          contact_title: rdfaPropertyValues($, person, 'jobTitle')[0] || rdfaPropertyValues($, person, 'title')[0] || null,
        };
        const personEmails = rdfaPropertyValues($, person, 'email').slice(0, 20);
        const personContext = sourceExcerpt(html, [scopeName, ...Object.values(personPoint), ...personEmails]
          .filter(Boolean).map(String));
        for (const email of personEmails) add(email, personContext || sourceExcerpt(html), 'website_rdfa', [personPoint]);
      }
    }
  }

  const hCardScopes = $('[class~="h-card"]').toArray().slice(0, MAX_JSON_LD_NODES);
  const expectedHCardBusiness = normalizedBusinessText(businessName || '');
  const scannedHCardHost = String(websiteHost || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  for (const scope of hCardScopes) {
    const cardName = directHCardProperties($, scope, 'p-name').map(element => hCardValue($, element, 'p-name')).find(Boolean) || null;
    const organizations = directHCardProperties($, scope, 'p-org').map(element => hCardValue($, element, 'p-org')).filter(Boolean);
    const urls = directHCardProperties($, scope, 'u-url').map(element => comparableHost(hCardValue($, element, 'u-url'))).filter(Boolean);
    const normalizedCardName = normalizedBusinessText(cardName || '');
    const businessCardMatch = Boolean(expectedHCardBusiness && normalizedCardName === expectedHCardBusiness
      && (!urls.length || urls.includes(scannedHCardHost)));
    const personCardMatch = Boolean(expectedHCardBusiness && organizations.some(value =>
      normalizedBusinessText(value) === expectedHCardBusiness));
    if (!businessCardMatch && !personCardMatch) continue;

    const personName = businessCardMatch ? null : boundedText(cardName, 160);
    if (businessCardMatch) {
      const businessCategory = directHCardProperties($, scope, 'p-category')
        .map(element => hCardValue($, element, 'p-category')).find(Boolean) || null;
      const hCardAddressParts = {
        streetAddress: directHCardProperties($, scope, 'p-street-address').map(element => hCardValue($, element, 'p-street-address')).find(Boolean),
        addressLocality: directHCardProperties($, scope, 'p-locality').map(element => hCardValue($, element, 'p-locality')).find(Boolean),
        addressRegion: directHCardProperties($, scope, 'p-region').map(element => hCardValue($, element, 'p-region')).find(Boolean),
        postalCode: directHCardProperties($, scope, 'p-postal-code').map(element => hCardValue($, element, 'p-postal-code')).find(Boolean),
        addressCountry: directHCardProperties($, scope, 'p-country-name').map(element => hCardValue($, element, 'p-country-name')).find(Boolean),
      };
      const hCardAddress = structuredAddress(hCardAddressParts);
      profile.category ||= boundedText(businessCategory, 120);
      profile.address ||= hCardAddress.address;
      profile.city ||= hCardAddress.city;
      profile.state ||= hCardAddress.state;
      profile.country ||= hCardAddress.country;
      if (businessCategory || hCardAddress.address) {
        const profileDetails = [cardName, businessCategory, hCardAddress.address, hCardAddress.city, hCardAddress.state]
          .filter(Boolean).map(String);
        const evidenceExcerpt = `h-card business profile: ${sourceEvidenceExcerpt(html, [
          ...profileDetails, ...Object.values(hCardAddressParts),
        ])}`;
        profileExcerpt = `${profileExcerpt ? `${profileExcerpt} | ` : ''}${evidenceExcerpt}`.slice(0, 300);
        profileEvidenceType ||= rendered ? 'website_rendered_hcard_profile' : 'website_hcard_profile';
      }
      const businessPhone = directHCardProperties($, scope, 'p-tel')
        .map(element => normalizePublicTelephone(hCardValue($, element, 'p-tel'))).find(Boolean) || null;
      if (businessPhone) {
        profile.phone ||= businessPhone;
        profileExcerpt = `h-card business telephone: ${businessPhone} | h-card business profile: ${sourceEvidenceExcerpt(html, [businessPhone, cardName, businessCategory,
          ...Object.values(hCardAddressParts)])}`;
        profileEvidenceType ||= rendered ? 'website_rendered_hcard_profile' : 'website_hcard_profile';
      }
    }
    const jobTitle = directHCardProperties($, scope, 'p-job-title')
      .map(element => hCardValue($, element, 'p-job-title')).find(Boolean) || null;
    const point = { contact_type: null, contact_name: personName, contact_title: jobTitle };
    const emailElements = directHCardProperties($, scope, 'u-email').filter(element => !hCardEmailIsPrivate($, element, scope));
    for (const emailElement of emailElements) {
      const email = hCardValue($, emailElement, 'u-email');
      const context = sourceExcerpt(html, [cardName, ...organizations, jobTitle, email].filter(Boolean).map(String));
      add(email, context || sourceExcerpt(html), 'website_hcard', [point]);
    }
  }

  $('a[href]').each((_, element) => {
    const href = String($(element).attr('href') || '').trim();
    const facebook = safeFacebookProfile(href);
    if (!facebook) return;
    profile.facebook_url ||= facebook;
    const label = $(element).text().replace(/\s+/g, ' ').trim().slice(0, 120);
    facebookProfileExcerpt ||= `Facebook page link: ${facebook}${label ? ` (${label})` : ''}`;
  });
  if (facebookProfileExcerpt) {
    profileExcerpt = `${facebookProfileExcerpt}${profileExcerpt ? ` | ${profileExcerpt}` : ''}`.slice(0, 300);
    profileEvidenceType ||= rendered ? 'website_rendered_facebook_profile' : 'website_facebook_profile';
  }

  // Email-bearing meta names are explicit contact data. Generic metadata and
  // property attributes are intentionally excluded to avoid harvesting prose,
  // analytics payloads, or unrelated social profile values.
  $('head meta[name]').toArray().slice(0, MAX_EMAIL_META_TAGS).forEach(element => {
    const $meta = $(element);
    const name = String($meta.attr('name') || '').trim().toLowerCase();
    const content = String($meta.attr('content') || '').trim();
    if (!EMAIL_META_NAMES.has(name) || !content || content.length > 1000) return;
    const context = sourceExcerpt(html, [content]);
    add(content, context || `meta name="${name}" content="${content}"`, 'website_meta_email');
  });

  $('a[href^="tel:"]').each((_, element) => {
    const href = String($(element).attr('href') || '').trim();
    const phone = normalizePublicTelephone(href);
    if (!phone) return;
    profile.phone ||= phone;
    const label = $(element).text().replace(/\s+/g, ' ').trim().slice(0, 120);
    const telephoneExcerpt = `Telephone link: ${href}${label ? ` (${label})` : ''}`;
    profileExcerpt = `${telephoneExcerpt}${profileExcerpt ? ` | ${profileExcerpt}` : ''}`.slice(0, 300);
    profileEvidenceType ||= rendered ? 'website_rendered_tel_profile' : 'website_tel_profile';
  });

  $('.private,.confidential,[data-private="true"]').remove();
  $('script,style,noscript,template,svg').remove();
  $('body').find('a,article,blockquote,br,div,footer,h1,h2,h3,h4,h5,h6,header,li,main,p,section,td,th,tr,[property],[itemprop],.p-name,.p-org,.p-job-title,.u-email')
    .each((_, element) => { $(element).prepend(' ').append(' '); });
  const text = $('body').text().replace(/\s+/g, ' ');
  const pattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi;
  for (const match of text.matchAll(pattern)) {
    const start = Math.max(0, match.index - 90);
    const end = Math.min(text.length, match.index + match[0].length + 90);
    add(match[0], text.slice(start, end), 'visible_text');
  }
  const obfuscatedPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+\s*(?:\[at\]|\(at\)|\{at\})\s*[a-z0-9-]+(?:\s*(?:\[dot\]|\(dot\)|\{dot\})\s*[a-z0-9-]+)+/gi;
  for (const match of text.matchAll(obfuscatedPattern)) {
    const normalized = match[0]
      .replace(/\s*(?:\[at\]|\(at\)|\{at\})\s*/i, '@')
      .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\})\s*/gi, '.')
      .replace(/\s+/g, '');
    add(normalized, match[0], 'obfuscated_text');
  }
  const hasHiddenAncestor = element => {
    for (let node = element; node && node.name !== 'body'; node = node.parent) {
      const $node = $(node);
      const className = String($node.attr('class') || '');
      const style = String($node.attr('style') || '');
      if ($node.attr('hidden') !== undefined || String($node.attr('aria-hidden') || '').toLowerCase() === 'true'
        || String($node.attr('data-private') || '').toLowerCase() === 'true'
        || /\b(?:private|confidential|hidden|d-none|is-hidden)\b/i.test(className)
        || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\s*;|\s*$))/i.test(style)) return true;
    }
    return false;
  };
  const contactFormDetected = $('form').toArray().some(form => {
    if (hasHiddenAncestor(form)) return false;
    const $form = $(form);
    const attributes = ['action', 'id', 'class', 'name', 'aria-label']
      .map(name => String($form.attr(name) || '')).join(' ').toLowerCase();
    const visibleFields = $form.find('input,textarea,select').toArray().filter(field => {
      const $field = $(field);
      return String($field.attr('type') || '').toLowerCase() !== 'hidden'
        && $field.attr('disabled') === undefined && !hasHiddenAncestor(field);
    });
    const fieldDetails = visibleFields.map(field => [
      'type', 'name', 'id', 'placeholder', 'aria-label', 'autocomplete',
    ].map(name => String($(field).attr(name) || '')).join(' ').toLowerCase());
    const contactContext = /contact|enquir|inquir|message/.test(`${attributes} ${fieldDetails.join(' ')}`);
    const emailField = fieldDetails.some(value => /email/.test(value));
    const messageField = visibleFields.some(field => field.name === 'textarea')
      || fieldDetails.some(value => /message|enquir|inquir/.test(value));
    return visibleFields.length > 0 && contactContext && (emailField || messageField);
  });
  return {
    emails: [...emails.values()],
    profile: profileExcerpt ? {
      values: profile, source_url: sourceUrl, raw_excerpt: profileExcerpt, content_hash: contentHash,
      extractor_version: rendered ? WEBSITE_RENDERED_EXTRACTOR_VERSION : WEBSITE_EMAIL_EXTRACTOR_VERSION,
      evidence_type: profileEvidenceType || (rendered ? 'website_rendered_json_ld_profile' : 'website_json_ld_profile'),
    } : null,
    contact_form_detected: contactFormDetected,
    contact_form_evidence: contactFormDetected ? {
      source_url: sourceUrl,
      content_hash: contentHash,
      extractor_version: WEBSITE_CONTACT_FORM_EVIDENCE_VERSION,
      rendered,
    } : null,
  };
}

export function createWebsiteEmailDiscovery({
  db,
  fetchImpl = safeFetch,
  now = Date.now,
  wait = sleep,
  minimumRequestIntervalMs = 1000,
  renderPage = getRenderedPage,
  renderOptions = {},
} = {}) {
  if (!db) throw new TypeError('A database connection is required.');

  const getScan = db.prepare(`SELECT id,lead_id,status,started_at,completed_at,page_count,found_count,error_code,website_url,retry_after_at,
      attempt_count,visited_paths_json,pending_paths_json,rendered_paths_json
    FROM lead_website_email_scans WHERE lead_id=?`);
  const findEmail = db.prepare(`SELECT id FROM lead_emails
    WHERE lead_id=? AND lower(trim(email))=? ORDER BY is_primary DESC,id LIMIT 1`);
  const insertEmail = db.prepare(`INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary,is_free_provider)
    VALUES(?,?,'website_scan','unknown',0,?)`);
  const insertEvidence = db.prepare(`INSERT INTO lead_email_source_evidence
      (lead_email_id,source_url,evidence_type,raw_excerpt,content_hash,extractor_version)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(lead_email_id,source_url) DO UPDATE SET evidence_type=excluded.evidence_type,
      raw_excerpt=excluded.raw_excerpt,content_hash=excluded.content_hash,
      extractor_version=excluded.extractor_version,observed_at=datetime('now')`);
  const findEvidenceId = db.prepare('SELECT id FROM lead_email_source_evidence WHERE lead_email_id=? AND source_url=?');
  const insertContactPointEvidence = db.prepare(`INSERT INTO lead_email_contact_point_evidence
      (evidence_id,contact_type,contact_name,contact_title)
    SELECT ?,?,?,? WHERE NOT EXISTS (
      SELECT 1 FROM lead_email_contact_point_evidence WHERE evidence_id=?
        AND COALESCE(contact_type,'')=COALESCE(?,'')
        AND COALESCE(contact_name,'')=COALESCE(?,'')
        AND COALESCE(contact_title,'')=COALESCE(?,'')
    )`);
  const updateStructuredProfile = db.prepare(`UPDATE leads SET
      business_name=COALESCE(NULLIF(trim(business_name),''),?),
      category=COALESCE(NULLIF(trim(category),''),?),address=COALESCE(NULLIF(trim(address),''),?),
      city=COALESCE(NULLIF(trim(city),''),?),state=COALESCE(NULLIF(trim(state),''),?),
      country=COALESCE(NULLIF(trim(country),''),?),phone=COALESCE(NULLIF(trim(phone),''),?),
      facebook_url=COALESCE(NULLIF(trim(facebook_url),''),?)
    WHERE id=?`);
  const insertProfileEvidence = db.prepare(`INSERT INTO lead_profile_source_evidence
      (lead_id,source_url,source_key,evidence_type,raw_excerpt,content_hash,extractor_version)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(lead_id,source_key) DO UPDATE SET source_url=excluded.source_url,evidence_type=excluded.evidence_type,
      raw_excerpt=excluded.raw_excerpt,content_hash=excluded.content_hash,extractor_version=excluded.extractor_version,
      observed_at=datetime('now')`);
  const updateScan = db.prepare(`UPDATE lead_website_email_scans SET status=?,completed_at=datetime('now'),
    found_count=?,error_code=?,retry_after_at=? WHERE lead_id=?`);
  const readHostCooldown = db.prepare('SELECT hostname,not_before,reason FROM website_host_cooldowns WHERE hostname=?');
  const writeHostCooldown = db.prepare(`INSERT INTO website_host_cooldowns(hostname,not_before,reason,updated_at)
    VALUES(?,?,?,datetime('now')) ON CONFLICT(hostname) DO UPDATE SET not_before=excluded.not_before,
      reason=excluded.reason,updated_at=datetime('now')`);
  const deleteHostCooldown = db.prepare('DELETE FROM website_host_cooldowns WHERE hostname=?');

  function activeHostCooldown(hostname) {
    const key = String(hostname || '').toLowerCase();
    const row = readHostCooldown.get(key);
    if (!row) return null;
    if (!Number.isFinite(Date.parse(row.not_before)) || Date.parse(row.not_before) <= Number(now())) {
      deleteHostCooldown.run(key);
      return null;
    }
    return row;
  }

  function recordHostCooldown(hostname, retryAfter, leadId, reason) {
    const key = String(hostname || '').toLowerCase();
    const attemptCount = getScan.get(Number(leadId))?.attempt_count || 1;
    const proposed = rateLimitDeadline(retryAfter, attemptCount, Number(now()));
    const prior = activeHostCooldown(key);
    const notBefore = prior && Date.parse(prior.not_before) > Date.parse(proposed) ? prior.not_before : proposed;
    writeHostCooldown.run(key, notBefore, reason);
    return { hostname: key, not_before: notBefore, reason };
  }

  function assertHostAvailable(hostname, leadId) {
    const cooldown = activeHostCooldown(hostname);
    if (!cooldown) return;
    const error = new WebsiteEmailDiscoveryError(
      `This host requested a pause until ${cooldown.not_before}. No request was made.`, 429, 'website_host_cooldown',
      getScan.get(Number(leadId)) || null);
    error.retryAfterAt = cooldown.not_before;
    error.rateLimitCode = cooldown.reason;
    throw error;
  }
  const insertRefresh = db.prepare(`INSERT INTO lead_website_email_refreshes(lead_id,generation,website_url,status)
    VALUES(?,?,?,'running')`);
  const updateRefresh = db.prepare(`UPDATE lead_website_email_refreshes SET status=?,completed_at=datetime('now'),
    page_count=?,error_code=? WHERE id=?`);
  const latestRefreshForLead = db.prepare(`SELECT r.id,r.generation,r.website_url,r.status,r.started_at,r.completed_at,
      r.page_count,r.error_code,(SELECT COUNT(DISTINCT o.lead_email_id) FROM lead_website_email_refresh_observations o
        WHERE o.refresh_id=r.id AND o.state='present') AS found_count
    FROM lead_website_email_refreshes r WHERE r.lead_id=? ORDER BY r.generation DESC LIMIT 1`);
  const insertRefreshPage = db.prepare(`INSERT INTO lead_website_email_refresh_pages
      (refresh_id,source_url,fetch_mode,outcome,content_hash)
    VALUES(?,?,?,?,?) ON CONFLICT(refresh_id,source_url,fetch_mode) DO UPDATE SET outcome=excluded.outcome,
      content_hash=excluded.content_hash,observed_at=datetime('now')`);
  const recordRefreshPage = (refreshId, sourceUrl, fetchMode, outcome, contentHash = null) => {
    if (refreshId && sourceUrl) insertRefreshPage.run(refreshId, sourceUrl, fetchMode, outcome, contentHash);
  };
  const priorRefreshEvidence = db.prepare(`SELECT le.id AS lead_email_id,le.email,ev.content_hash,ev.raw_excerpt,ev.extractor_version,ev.evidence_type
    FROM lead_emails le JOIN lead_email_source_evidence ev ON ev.lead_email_id=le.id
    WHERE le.lead_id=? AND ev.source_url=? ORDER BY le.id`);
  const insertRefreshObservation = db.prepare(`INSERT INTO lead_website_email_refresh_observations
      (refresh_id,lead_email_id,source_url,fetch_mode,state,prior_content_hash,prior_raw_excerpt,prior_extractor_version,
        content_hash,raw_excerpt,extractor_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(refresh_id,lead_email_id,source_url,fetch_mode) DO UPDATE SET state=excluded.state,
      content_hash=excluded.content_hash,raw_excerpt=excluded.raw_excerpt,extractor_version=excluded.extractor_version,
      observed_at=datetime('now')`);

  const markVisited = db.transaction((leadId, pathname, pageItems = null, discoveredPaths = [], profileData = null,
    contactFormData = null, observationContext = null) => {
    let addedCount = 0;
    const sourceHistory = observationContext?.refresh_id && observationContext.source_url
      ? priorRefreshEvidence.all(leadId, observationContext.source_url).filter(row => observationContext.fetch_mode === 'rendered'
        ? String(row.evidence_type || '').startsWith('rendered_')
        : !String(row.evidence_type || '').startsWith('rendered_')) : [];
    for (const item of pageItems || []) {
      let row = findEmail.get(leadId, item.email);
      const domain = item.email.slice(item.email.lastIndexOf('@') + 1).toLowerCase();
      const freeProvider = FREE_EMAIL_DOMAINS.has(domain) ? 1 : 0;
      if (!row) {
        const result = insertEmail.run(leadId, item.email, freeProvider);
        row = { id: Number(result.lastInsertRowid) };
        addedCount += 1;
      } else {
        db.prepare(`UPDATE lead_emails SET is_free_provider=? WHERE id=? AND COALESCE(is_free_provider,0)<>?`)
          .run(freeProvider, row.id, freeProvider);
      }
      insertEvidence.run(row.id, item.source_url, item.evidence_type, item.raw_excerpt, item.content_hash,
        item.extractor_version || WEBSITE_EMAIL_EXTRACTOR_VERSION);
      const evidenceId = findEvidenceId.get(row.id, item.source_url)?.id;
      for (const point of item.contact_points || []) {
        insertContactPointEvidence.run(evidenceId, point.contact_type, point.contact_name, point.contact_title,
          evidenceId, point.contact_type, point.contact_name, point.contact_title);
      }
    }
    if (observationContext?.refresh_id && observationContext.source_url && observationContext.content_hash) {
      insertRefreshPage.run(observationContext.refresh_id, observationContext.source_url,
        observationContext.fetch_mode, 'fetched', observationContext.content_hash);
      const visibleItems = (pageItems || []).filter(item => observationContext.fetch_mode === 'rendered'
        ? String(item.evidence_type || '').startsWith('rendered_')
        : !String(item.evidence_type || '').startsWith('rendered_'));
      const byEmail = new Map(visibleItems.map(item => [String(item.email || '').toLowerCase(), item]));
      const observedIds = new Set();
      for (const prior of sourceHistory) {
        const item = byEmail.get(String(prior.email || '').toLowerCase());
        insertRefreshObservation.run(observationContext.refresh_id, prior.lead_email_id, observationContext.source_url,
          observationContext.fetch_mode, item ? 'present' : 'not_present', prior.content_hash, prior.raw_excerpt,
          prior.extractor_version, item?.content_hash || observationContext.content_hash, item?.raw_excerpt || null,
          item?.extractor_version || observationContext.extractor_version || WEBSITE_EMAIL_EXTRACTOR_VERSION);
        observedIds.add(prior.lead_email_id);
      }
      for (const item of visibleItems) {
        const row = findEmail.get(leadId, item.email);
        if (!row || observedIds.has(row.id)) continue;
        insertRefreshObservation.run(observationContext.refresh_id, row.id, observationContext.source_url,
          observationContext.fetch_mode, 'present', null, null, null, item.content_hash || observationContext.content_hash,
          item.raw_excerpt || null, item.extractor_version || observationContext.extractor_version || WEBSITE_EMAIL_EXTRACTOR_VERSION);
      }
    }
    if (contactFormData?.source_url && contactFormData.content_hash) {
      const sourcePath = new URL(contactFormData.source_url).pathname;
      const sourceKeyPrefix = contactFormData.rendered ? 'website-rendered-contact-form' : 'website-contact-form';
      insertProfileEvidence.run(leadId, contactFormData.source_url, `${sourceKeyPrefix}:${sourcePath}`,
        'website_contact_form', 'Public contact/enquiry form observed. No fields were submitted or values collected.',
        contactFormData.content_hash, WEBSITE_CONTACT_FORM_EVIDENCE_VERSION);
    }
    if (profileData?.values && profileData.source_url && profileData.content_hash) {
      const values = profileData.values;
      updateStructuredProfile.run(values.business_name, values.category, values.address, values.city, values.state,
        values.country, values.phone, values.facebook_url, leadId);
      const sourcePath = new URL(profileData.source_url).pathname;
      const renderedProfile = profileData.extractor_version === WEBSITE_RENDERED_EXTRACTOR_VERSION;
      const telephoneOnlyProfile = profileData.evidence_type === 'website_tel_profile' || profileData.evidence_type === 'website_rendered_tel_profile';
      const facebookOnlyProfile = profileData.evidence_type === 'website_facebook_profile' || profileData.evidence_type === 'website_rendered_facebook_profile';
      const microdataProfile = profileData.evidence_type === 'website_microdata_profile' || profileData.evidence_type === 'website_rendered_microdata_profile';
      const sourceKeyPrefix = telephoneOnlyProfile ? (renderedProfile ? 'website-rendered-tel' : 'website-tel')
        : facebookOnlyProfile ? (renderedProfile ? 'website-rendered-facebook' : 'website-facebook')
          : microdataProfile ? (renderedProfile ? 'website-rendered-microdata' : 'website-microdata')
            : renderedProfile ? 'website-rendered-jsonld' : 'website-jsonld';
      insertProfileEvidence.run(leadId, profileData.source_url, `${sourceKeyPrefix}:${sourcePath}`,
        profileData.evidence_type || 'website_json_ld_profile', profileData.raw_excerpt, profileData.content_hash,
        profileData.extractor_version || WEBSITE_EMAIL_EXTRACTOR_VERSION);
    }
    const current = getScan.get(leadId);
    const visited = new Set(JSON.parse(current?.visited_paths_json || '[]'));
    if (pathname !== null) visited.add(pathname);
    const pending = JSON.parse(current?.pending_paths_json || '[]').filter(value => value !== pathname && !visited.has(value));
    const additions = observationContext?.refresh_id ? []
      : [...new Set(discoveredPaths)].filter(value => !visited.has(value) && !pending.includes(value));
    const nextPending = [...additions, ...pending].slice(0, MAX_SCAN_REQUESTS * 2);
    const pageDelta = pathname?.startsWith('@rendered:') || pageItems === null ? 0 : 1;
    const count = db.prepare(`SELECT COUNT(DISTINCT le.id) AS count FROM lead_emails le
      JOIN lead_email_source_evidence ev ON ev.lead_email_id=le.id
      WHERE le.lead_id=? AND le.source='website_scan'`).get(leadId).count;
    db.prepare(`UPDATE lead_website_email_scans SET page_count=page_count+?,found_count=?,visited_paths_json=?,pending_paths_json=?,rendered_paths_json=? WHERE lead_id=?`)
      .run(pageDelta, count, JSON.stringify([...visited]), JSON.stringify(nextPending),
        pathname?.startsWith('@rendered:') ? JSON.stringify([...new Set([...jsonPathList(getScan.get(leadId)?.rendered_paths_json), pathname.slice('@rendered:'.length)])]) : getScan.get(leadId)?.rendered_paths_json || '[]', leadId);
    return addedCount;
  });

  const savePendingPaths = db.prepare('UPDATE lead_website_email_scans SET pending_paths_json=? WHERE lead_id=?');

  function jsonPathList(value) {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string' && item.length <= 320) : [];
    } catch { return []; }
  }

  function looksLikeJavaScriptShell(html) {
    if (!/<script\b/i.test(html)) return false;
    const source = String(html || '').slice(0, MAX_PAGE_BYTES);
    const visible = source.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|#160);/gi, ' ').replace(/\s+/g, ' ').trim();
    const mountPoint = /\bid\s*=\s*["'](?:app|root|__next|__nuxt|svelte|outlet)["']/i.test(source);
    const moduleBootstrap = /<script\b[^>]*\btype\s*=\s*["']module["']/i.test(source);
    return (mountPoint && visible.length < 1400) || (moduleBootstrap && visible.length < 500) || visible.length < 180;
  }

  function jsonRenderedPaths(leadId) {
    return jsonPathList(getScan.get(leadId)?.rendered_paths_json);
  }

  async function renderSameOriginPage(pageUrl, leadId, site, policy, interval) {
    if (typeof renderPage !== 'function') return null;
    const guardedRenderFetch = async (input, options = {}) => {
      const target = new URL(input);
      const method = String(options.method || 'GET').toUpperCase();
      if (target.origin !== site.origin || !['GET', 'HEAD'].includes(method) || !policy.canFetch(target.pathname)) {
        throw new Error('Rendered website request was blocked by same-origin or robots policy.');
      }
      assertHostAvailable(target.hostname, leadId);
      await reserveHostRequest(target.hostname.toLowerCase(), interval, now, wait);
      assertHostAvailable(target.hostname, leadId);
      const response = await fetchImpl(target.href, {
        ...options,
        method,
        redirect: 'manual',
        maxRedirects: 0,
        maxBytes: Math.min(MAX_RENDERED_RESPONSE_BYTES, Number(options.maxBytes) || MAX_RENDERED_RESPONSE_BYTES),
        timeoutMs: Math.min(MAX_RENDERED_TIMEOUT_MS, Number(options.timeoutMs) || MAX_RENDERED_TIMEOUT_MS),
        headers: {
          ...(options.headers || {}),
          'User-Agent': WEBSITE_EMAIL_USER_AGENT,
        },
      });
      if (responseStatus(response) === 429) {
        recordHostCooldown(target.hostname, response.headers?.get?.('retry-after'), leadId,
          target.pathname === '/robots.txt' ? 'robots_rate_limited' : 'site_rate_limited');
      }
      return response;
    };
    const rendered = await renderPage(pageUrl, {
      ...renderOptions,
      timeoutMs: MAX_RENDERED_TIMEOUT_MS,
      maxRequests: MAX_RENDERED_REQUESTS,
      maxBytes: MAX_RENDERED_BYTES,
      settleMs: MAX_RENDERED_SETTLE_MS,
      safeFetch: guardedRenderFetch,
    });
    if (!rendered?.html || !rendered?.url) return null;
    const finalUrl = new URL(rendered.url);
    if (finalUrl.origin !== site.origin || !policy.canFetch(finalUrl.pathname)) return null;
    return { html: rendered.html, url: finalUrl.href };
  }

  const recoverInterruptedScans = () => db.transaction(() => {
    const leads = db.prepare(`SELECT lead_id FROM lead_website_email_scans WHERE status='running'`).all();
    const changed = db.prepare(`UPDATE lead_website_email_scans
      SET status='interrupted',completed_at=datetime('now'),error_code='worker_interrupted' WHERE status='running'`).run().changes;
    for (const row of leads) db.prepare(`UPDATE lead_website_email_refreshes
      SET status='interrupted',completed_at=datetime('now'),error_code='worker_interrupted'
      WHERE lead_id=? AND status='running'`).run(row.lead_id);
    return changed;
  })();

  function reserveScan(leadId, previous, { resumeInterrupted = false, retryFailed = false, refresh = false } = {}, websiteUrl) {
    if (refresh) {
      const latestRefresh = previous ? latestRefreshForLead.get(leadId) : null;
      const refreshStateCanContinue = previous && latestRefresh
        && ['completed', 'blocked', 'failed', 'interrupted'].includes(previous.status);
      if (!previous || (previous.status !== 'completed' && !refreshStateCanContinue)) {
        throw new WebsiteEmailDiscoveryError('Only a completed website scan can be refreshed.', 409, 'refresh_not_available', previous);
      }
      if (previous.website_url) {
        let savedUrl = null;
        try { savedUrl = normalizeWebsiteUrl(previous.website_url).href; } catch { /* A malformed saved target cannot be refreshed. */ }
        if (savedUrl !== websiteUrl) {
          throw new WebsiteEmailDiscoveryError('This contact’s website changed since its last scan. Run a new scan only after reviewing the saved website.', 409, 'refresh_website_changed', previous);
        }
      }
      const paths = [...new Set([...jsonPathList(previous.visited_paths_json), ...jsonPathList(previous.pending_paths_json)])]
        .filter(value => !value.startsWith('@rendered:') && !value.startsWith(SITEMAP_PATH_PREFIX))
        .slice(0, MAX_SCAN_REQUESTS);
      if (!paths.length) throw new WebsiteEmailDiscoveryError('This scan has no saved public page paths to refresh.', 409, 'refresh_paths_missing', previous);
      return db.transaction(() => {
        const current = getScan.get(leadId);
        const currentRefresh = latestRefreshForLead.get(leadId);
        const canRefreshCurrent = current?.status === 'completed'
          || (currentRefresh && ['completed', 'blocked', 'failed', 'interrupted'].includes(current?.status));
        if (!canRefreshCurrent) {
          throw new WebsiteEmailDiscoveryError('This website scan is no longer available to refresh.', 409, 'refresh_not_available', current || null);
        }
        const latest = db.prepare('SELECT MAX(generation) AS generation FROM lead_website_email_refreshes WHERE lead_id=?').get(leadId);
        const generation = Number(latest?.generation || 0) + 1;
        const created = insertRefresh.run(leadId, generation, websiteUrl);
        const refreshId = Number(created.lastInsertRowid);
        const changed = db.prepare(`UPDATE lead_website_email_scans SET status='running',started_at=datetime('now'),
          completed_at=NULL,page_count=0,found_count=0,error_code=NULL,website_url=?,attempt_count=attempt_count+1,
          visited_paths_json='[]',pending_paths_json=?,rendered_paths_json='[]'
          WHERE lead_id=? AND status=?`).run(websiteUrl, JSON.stringify(paths), leadId, current.status).changes;
        if (!changed) throw new WebsiteEmailDiscoveryError('This website scan is no longer available to refresh.', 409, 'refresh_not_available', getScan.get(leadId));
        return { refreshId, paths, generation };
      })();
    }
    if (!previous) {
      try {
        db.prepare(`INSERT INTO lead_website_email_scans(lead_id,status,attempt_count,website_url) VALUES(?,'running',1,?)`).run(leadId, websiteUrl);
        return null;
      } catch (error) {
        if (!String(error.message || '').includes('UNIQUE')) throw error;
        throw new WebsiteEmailDiscoveryError('This contact already has its one-time website scan recorded.', 409, 'already_scanned', getScan.get(leadId));
      }
    }
    const canResume = previous.status === 'interrupted' && resumeInterrupted;
    const pendingPaths = jsonPathList(previous.pending_paths_json);
    const canRetry = previous.status === 'failed' && retryFailed
      && RESUMABLE_SCAN_FAILURES.has(previous.error_code)
      && (previous.page_count === 0 || pendingPaths.length > 0)
      && (previous.error_code !== 'scan_request_budget_reached' || pendingPaths.length > 0);
    const hostCooldown = activeHostCooldown(new URL(websiteUrl).hostname);
    const canRetryRateLimited = previous.status === 'blocked' && retryFailed
      && ['site_rate_limited', 'robots_rate_limited'].includes(previous.error_code)
      && previous.retry_after_at && Date.parse(previous.retry_after_at) <= Number(now()) && !hostCooldown;
    if (!canResume && !canRetry && !canRetryRateLimited) {
      throw new WebsiteEmailDiscoveryError('This contact already has its one-time website scan recorded.', 409, 'already_scanned', previous);
    }
    const expected = canResume ? 'interrupted' : canRetryRateLimited ? 'blocked' : 'failed';
    const changed = db.prepare(`UPDATE lead_website_email_scans SET status='running',started_at=datetime('now'),
      completed_at=NULL,error_code=NULL,retry_after_at=NULL,attempt_count=attempt_count+1,website_url=COALESCE(website_url,?)
      WHERE lead_id=? AND status=?`).run(websiteUrl, leadId, expected).changes;
    if (!changed) throw new WebsiteEmailDiscoveryError('This contact already has its one-time website scan recorded.', 409, 'already_scanned', getScan.get(leadId));
    return null;
  }

  async function request(url, maxBytes, intervalMs, leadId) {
    const target = new URL(url);
    assertHostAvailable(target.hostname, leadId);
    await reserveHostRequest(target.hostname.toLowerCase(), intervalMs, now, wait);
    assertHostAvailable(target.hostname, leadId);
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      timeoutMs: 8000,
      maxBytes,
      headers: {
        'User-Agent': WEBSITE_EMAIL_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/pdf,text/vcard;q=0.8,text/plain;q=0.8',
      },
    });
    if (responseStatus(response) === 429) {
      recordHostCooldown(target.hostname, response.headers?.get?.('retry-after'), leadId,
        target.pathname === '/robots.txt' ? 'robots_rate_limited' : 'site_rate_limited');
    }
    return response;
  }

  async function scanLead(leadIdInput, options = {}) {
    const leadId = Number(leadIdInput);
    if (!Number.isSafeInteger(leadId) || leadId < 1) throw new WebsiteEmailDiscoveryError('Contact not found.', 404, 'contact_missing');
    const lead = db.prepare('SELECT id,website_url FROM leads WHERE id=?').get(leadId);
    if (!lead) throw new WebsiteEmailDiscoveryError('Contact not found.', 404, 'contact_missing');

    const site = normalizeWebsiteUrl(lead.website_url);
    const businessName = db.prepare('SELECT business_name FROM leads WHERE id=?').get(leadId)?.business_name || '';
    const previous = getScan.get(leadId);
    const reservation = reserveScan(leadId, previous, options, site.href);
    const refreshRunId = reservation?.refreshId || null;
    const refreshPaths = reservation?.paths || [];
    let addedCount = 0;
    let status = 'completed';
    let errorCode = null;
    let retryAfterAt = null;
    let contactFormObserved = false;
    let renderedFallbackUnavailable = false;
    let renderedPageCount = 0;
    let pdfOutcomeCode = null;
    let pdfLimitReached = false;
    let visited = new Set(jsonPathList(getScan.get(leadId)?.visited_paths_json));
    let policy;
    let robotsText = '';
    try {
      const robotsUrl = new URL('/robots.txt', site).href;
      const robotsResponse = await request(robotsUrl, MAX_ROBOTS_BYTES, minimumRequestIntervalMs, leadId);
      const robotsStatus = responseStatus(robotsResponse);
      if (robotsStatus === 404 || robotsStatus === 410) {
        policy = parseRobotsPolicy('');
      } else if (robotsStatus >= 200 && robotsStatus < 300) {
        const type = robotsResponse.headers?.get?.('content-type') || '';
        if (type && !/text\/plain|application\/octet-stream/i.test(type)) {
          status = 'blocked';
          errorCode = 'robots_content_type_unsupported';
        } else {
          robotsText = await robotsResponse.text();
          policy = parseRobotsPolicy(robotsText);
        }
      } else {
        status = robotsStatus === 403 || robotsStatus === 401 || robotsStatus === 429 ? 'blocked' : 'failed';
        errorCode = robotsStatus === 403 || robotsStatus === 401 ? 'robots_access_denied'
          : robotsStatus === 429 ? 'robots_rate_limited'
          : `robots_http_${robotsStatus || 'error'}`;
        if (robotsStatus === 429) retryAfterAt = activeHostCooldown(site.hostname)?.not_before || null;
      }

      if (policy && policy.crawlDelayMs > MAX_CRAWL_DELAY_MS) {
        status = 'blocked';
        errorCode = 'robots_crawl_delay_exceeds_limit';
      }

      if (refreshRunId && status !== 'completed' && refreshPaths.length) {
        const outcome = status === 'blocked' ? 'blocked' : 'unavailable';
        for (const pathKey of refreshPaths) {
          const pathname = pathKey.startsWith(SITEMAP_PATH_PREFIX) ? pathKey.slice(SITEMAP_PATH_PREFIX.length) : pathKey;
          recordRefreshPage(refreshRunId, new URL(pathname, site).href, 'http', outcome);
          markVisited(leadId, pathKey);
        }
      }

      if (policy && status === 'completed') {
        const interval = Math.max(minimumRequestIntervalMs, policy.crawlDelayMs);
        // The robots request predates knowledge of the site's crawl-delay, so
        // explicitly wait before the first HTML request as well.
        if (interval > 0) await wait(interval);
        let pendingPaths = jsonPathList(getScan.get(leadId)?.pending_paths_json);
        if (!pendingPaths.length && visited.size === 0) {
          pendingPaths = ['/', ...parseRobotsSitemaps(robotsText, site), ...FALLBACK_PAGE_PATHS.slice(1)];
        } else if (!pendingPaths.length) {
          // Older interrupted rows did not persist a queue. Resume their
          // already-observed paths without fetching those pages again.
          pendingPaths = FALLBACK_PAGE_PATHS;
        }
        const rejectedByRobots = pendingPaths.filter(pathKey => {
          const pathname = pathKey.startsWith(SITEMAP_PATH_PREFIX) ? pathKey.slice(SITEMAP_PATH_PREFIX.length) : pathKey;
          return !visited.has(pathKey) && !policy.canFetch(pathname);
        });
        for (const pathKey of rejectedByRobots) {
          const pathname = pathKey.startsWith(SITEMAP_PATH_PREFIX) ? pathKey.slice(SITEMAP_PATH_PREFIX.length) : pathKey;
          const pageUrl = new URL(pathname, site).href;
          if (refreshRunId) recordRefreshPage(refreshRunId, pageUrl, 'http', 'blocked');
          // Keep the known path for a later operator-triggered refresh, while
          // recording that this generation could not recheck it under robots.txt.
          markVisited(leadId, pathKey);
        }
        pendingPaths = pendingPaths.filter(pathKey => {
          const pathname = pathKey.startsWith(SITEMAP_PATH_PREFIX) ? pathKey.slice(SITEMAP_PATH_PREFIX.length) : pathKey;
          return !visited.has(pathKey) && policy.canFetch(pathname);
        }).slice(0, MAX_SCAN_REQUESTS * 2);
        savePendingPaths.run(JSON.stringify(pendingPaths), leadId);
        if (!pendingPaths.length) {
          status = 'blocked';
          errorCode = 'robots_disallowed';
        }
        let requestCount = 0;
        for (; status === 'completed' && requestCount < MAX_SCAN_REQUESTS; requestCount += 1) {
          const current = getScan.get(leadId);
          visited = new Set(jsonPathList(current?.visited_paths_json));
          pendingPaths = jsonPathList(current?.pending_paths_json).filter(pathKey => !visited.has(pathKey));
          if (!pendingPaths.length) break;
          const pathKey = pendingPaths[0];
          const isSitemap = pathKey.startsWith(SITEMAP_PATH_PREFIX);
          const pathname = isSitemap ? pathKey.slice(SITEMAP_PATH_PREFIX.length) : pathKey;
          if (!policy.canFetch(pathname)) {
            errorCode ||= 'robots_disallowed_discovered_path';
            markVisited(leadId, pathKey);
            continue;
          }
          const pageUrl = new URL(pathname, site).href;
          const pdfPath = /\.pdf$/i.test(pathname);
          let response;
          try {
            response = await request(pageUrl, isSitemap ? MAX_ROBOTS_BYTES * 16 : pdfPath ? MAX_PDF_BYTES : MAX_PAGE_BYTES, interval, leadId);
          } catch (error) {
            if (pdfPath && /exceeds byte limit/i.test(String(error.message || ''))) {
              pdfOutcomeCode ||= 'pdf_size_limit';
              if (refreshRunId) recordRefreshPage(refreshRunId, pageUrl, 'http', 'unsupported');
              markVisited(leadId, pathKey);
              continue;
            }
            if (error.code === 'website_host_cooldown') {
              status = 'blocked';
              errorCode = error.rateLimitCode || 'site_rate_limited';
              retryAfterAt = error.retryAfterAt || null;
              if (refreshRunId) recordRefreshPage(refreshRunId, pageUrl, 'http', 'blocked');
              break;
            }
            if (refreshRunId) recordRefreshPage(refreshRunId, pageUrl, 'http', 'unavailable');
            throw error;
          }
          const pageStatus = responseStatus(response);
          if (isRedirect(pageStatus)) {
            errorCode ||= 'redirect_not_followed';
            if (refreshRunId) recordRefreshPage(refreshRunId, pageUrl, 'http', 'blocked');
            markVisited(leadId, pathKey);
            continue;
          }
          if (pageStatus === 403 || pageStatus === 429) {
            status = 'blocked';
            errorCode = pageStatus === 403 ? 'site_access_denied' : 'site_rate_limited';
            if (pageStatus === 429) retryAfterAt = activeHostCooldown(site.hostname)?.not_before || null;
            if (refreshRunId) recordRefreshPage(refreshRunId, pageUrl, 'http', 'blocked');
            break;
          }
          if (pageStatus >= 500 || pageStatus === 0) {
            status = 'failed';
            errorCode = 'site_unavailable';
            if (refreshRunId) recordRefreshPage(refreshRunId, pageUrl, 'http', 'unavailable');
            break;
          }
          if (pageStatus < 200 || pageStatus >= 300) {
            if (refreshRunId) recordRefreshPage(refreshRunId, pageUrl, 'http', 'missing');
            markVisited(leadId, pathKey);
            continue;
          }
          const type = response.headers?.get?.('content-type') || '';
          if (isSitemap) {
            if (!/xml|text\/plain/i.test(type)) {
              errorCode ||= 'sitemap_content_type_unsupported';
              markVisited(leadId, pathKey);
              continue;
            }
            const sitemap = await extractUsefulSitemapPaths(await response.text(), pageUrl, site.origin);
            const discovered = [
              ...sitemap.sitemap_paths.filter(item => policy.canFetch(item.slice(SITEMAP_PATH_PREFIX.length))),
              ...sitemap.internal_paths.filter(item => policy.canFetch(item)),
            ];
            markVisited(leadId, pathKey, null, discovered);
            continue;
          }
          const pdfBytes = pdfPath || /application\/pdf/i.test(type)
            ? Buffer.from(await response.arrayBuffer())
            : null;
          if (pdfBytes && pdfBytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
            try {
              const document = await extractPdfTextIsolated(pdfBytes);
              const pdfEmails = extractCompanyPdfEmails(document.pages, {
                websiteHost: site.hostname,
                businessName,
              }).map(item => ({ ...item, source_url: pageUrl }));
              const pdfHash = createHash('sha256').update(pdfBytes).digest('hex');
              addedCount += markVisited(leadId, pathKey, pdfEmails, [], null, null,
                refreshRunId ? { refresh_id: refreshRunId, source_url: pageUrl, fetch_mode: 'http', content_hash: pdfHash, extractor_version: 'website-pdf-v1' } : null);
              if (!document.pages.some(page => page.text.trim())) pdfOutcomeCode ||= 'pdf_no_text_layer';
              else if (!pdfEmails.length) pdfOutcomeCode ||= 'pdf_no_company_match';
              if (document.truncated_pages || document.truncated_text) pdfLimitReached = true;
            } catch (error) {
              pdfOutcomeCode ||= ['pdf_size_limit', 'pdf_parse_timeout', 'pdf_parser_busy', 'pdf_input_too_large'].includes(error.message)
                ? error.message
                : 'pdf_text_extraction_failed';
              markVisited(leadId, pathKey);
            }
            continue;
          }
          if (pdfBytes) {
            pdfOutcomeCode ||= 'pdf_signature_invalid';
            markVisited(leadId, pathKey);
            continue;
          }
          const vcardMime = /^(?:text\/vcard|text\/x-vcard|application\/vcard)(?:\s*;|$)/i.test(type);
          if (/\.vcf$/i.test(pathname) || vcardMime) {
            const vcardText = await response.text();
            if (!/^\s*BEGIN:VCARD\s*(?:\r?\n)/i.test(vcardText.replace(/^\uFEFF/, ''))) {
              errorCode ||= 'vcard_signature_invalid';
              markVisited(leadId, pathKey);
              continue;
            }
            const vcardHash = createHash('sha256').update(vcardText).digest('hex');
            const vcardEmails = extractVcardEmails(vcardText, {
              sourceUrl: pageUrl,
              contentHash: vcardHash,
              businessName,
              websiteHost: site.hostname,
            });
            addedCount += markVisited(leadId, pathKey, vcardEmails, [], null, null,
              refreshRunId ? { refresh_id: refreshRunId, source_url: pageUrl, fetch_mode: 'http', content_hash: vcardHash, extractor_version: 'website-vcard-v1' } : null);
            continue;
          }
          if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
            if (refreshRunId) recordRefreshPage(refreshRunId, pageUrl, 'http', 'unsupported');
            markVisited(leadId, pathKey);
            continue;
          }
          const html = await response.text();
          const hash = createHash('sha256').update(html).digest('hex');
            const pageData = await extractPageData(html, pageUrl, hash, { businessName, websiteHost: site.hostname });
          contactFormObserved ||= pageData.contact_form_detected;
          const links = await extractUsefulLinks(html, pageUrl, site.origin);
          const discovered = [
            ...links.internal_paths.filter(item => policy.canFetch(item)),
            ...links.sitemap_paths.filter(item => policy.canFetch(item.slice(SITEMAP_PATH_PREFIX.length))),
          ];
          addedCount += markVisited(leadId, pathKey, pageData.emails, discovered, pageData.profile, pageData.contact_form_evidence,
            refreshRunId ? { refresh_id: refreshRunId, source_url: pageUrl, fetch_mode: 'http', content_hash: hash,
              extractor_version: WEBSITE_EMAIL_EXTRACTOR_VERSION } : null);
          if (!pageData.emails.length && renderedPageCount < MAX_RENDERED_PAGES
            && !jsonRenderedPaths(leadId).includes(pathKey) && looksLikeJavaScriptShell(html)) {
            renderedPageCount += 1;
            let rendered = null;
            try { rendered = await renderSameOriginPage(pageUrl, leadId, site, policy, interval); }
            catch { /* Rendering is optional; failure is surfaced without retrying or widening access. */ }
            const renderedMarker = `@rendered:${pathKey}`;
            if (!rendered) {
              renderedFallbackUnavailable = true;
              if (refreshRunId) recordRefreshPage(refreshRunId, pageUrl, 'rendered', 'unavailable');
              markVisited(leadId, renderedMarker, [], []);
            } else {
              const renderedHash = createHash('sha256').update(rendered.html).digest('hex');
              const renderedData = await extractPageData(rendered.html, rendered.url, renderedHash,
                { rendered: true, businessName, websiteHost: site.hostname });
              contactFormObserved ||= renderedData.contact_form_detected;
              const renderedLinks = await extractUsefulLinks(rendered.html, rendered.url, site.origin);
              const renderedDiscovered = [
                ...renderedLinks.internal_paths.filter(item => policy.canFetch(item)),
                ...renderedLinks.sitemap_paths.filter(item => policy.canFetch(item.slice(SITEMAP_PATH_PREFIX.length))),
              ];
              addedCount += markVisited(leadId, renderedMarker, renderedData.emails, renderedDiscovered, renderedData.profile,
                renderedData.contact_form_evidence ? { ...renderedData.contact_form_evidence, rendered: true } : null,
                refreshRunId ? { refresh_id: refreshRunId, source_url: rendered.url, fetch_mode: 'rendered', content_hash: renderedHash,
                  extractor_version: WEBSITE_RENDERED_EXTRACTOR_VERSION } : null);
            }
          }
        }
        const afterCrawl = getScan.get(leadId);
        const unfinished = jsonPathList(afterCrawl?.pending_paths_json).some(pathKey => !new Set(jsonPathList(afterCrawl.visited_paths_json)).has(pathKey));
        if (status === 'completed' && unfinished && requestCount >= MAX_SCAN_REQUESTS) {
          status = 'failed';
          errorCode = 'scan_request_budget_reached';
        }
        if (status === 'completed' && pdfLimitReached) errorCode ||= 'pdf_extraction_limit_reached';
        if (status === 'completed' && !Number(getScan.get(leadId)?.found_count)) {
          if (renderedFallbackUnavailable) errorCode ||= 'rendered_fallback_unavailable';
          else if (pdfOutcomeCode) errorCode ||= pdfOutcomeCode;
          else if (contactFormObserved) errorCode ||= 'contact_form_only';
          else if (!getScan.get(leadId).page_count) errorCode ||= 'no_public_html_pages';
          else errorCode ||= 'email_not_found';
        }
      }
    } catch (error) {
      if (error.code === 'website_host_cooldown') {
        status = 'blocked';
        errorCode = error.rateLimitCode || 'site_rate_limited';
        retryAfterAt = error.retryAfterAt || null;
      } else {
        status = 'failed';
        errorCode = /SSRF blocked/i.test(error.message) ? 'unsafe_website_url' : 'website_request_failed';
      }
    }

    const count = db.prepare(`SELECT COUNT(DISTINCT le.id) AS count FROM lead_emails le
      JOIN lead_email_source_evidence ev ON ev.lead_email_id=le.id
      WHERE le.lead_id=? AND le.source='website_scan'`).get(leadId).count;
    const finalize = db.transaction(() => {
      updateScan.run(status, count, errorCode, retryAfterAt, leadId);
      if (refreshRunId) {
        const pageCount = db.prepare(`SELECT COUNT(*) AS count FROM lead_website_email_refresh_pages
          WHERE refresh_id=? AND outcome='fetched'`).get(refreshRunId).count;
        updateRefresh.run(status, pageCount, errorCode, refreshRunId);
      }
      if (refreshRunId) {
        const refresh = latestRefreshForLead.get(leadId);
        db.prepare(`INSERT INTO events(lead_id,event_type,event_at,meta_json)
          VALUES(?,'website_email_scan_refreshed',datetime('now'),?)`)
          .run(leadId, JSON.stringify({ generation: refresh?.generation, status, page_count: getScan.get(leadId).page_count,
            refreshed_pages: db.prepare(`SELECT COUNT(*) AS count FROM lead_website_email_refresh_pages
              WHERE refresh_id=? AND outcome='fetched'`).get(refreshRunId).count }));
      } else if (status === 'completed') {
        db.prepare(`INSERT INTO events(lead_id,event_type,event_at,meta_json)
          VALUES(?,'website_email_scan_completed',datetime('now'),?)`)
          .run(leadId, JSON.stringify({ page_count: getScan.get(leadId).page_count, found_count: count }));
      }
    });
    finalize();
    const savedEmailRows = db.prepare(`SELECT le.id,le.email,le.verification_status,ev.id AS evidence_id,ev.source_url,ev.evidence_type,
        ev.raw_excerpt,ev.content_hash,ev.extractor_version,ev.observed_at
      FROM lead_emails le JOIN lead_email_source_evidence ev ON ev.lead_email_id=le.id
      WHERE le.lead_id=? AND le.source='website_scan' ORDER BY le.id,ev.id`).all(leadId);
    const evidenceIds = [...new Set(savedEmailRows.map(row => row.evidence_id).filter(Number.isSafeInteger))];
    const contactPointRows = evidenceIds.length ? db.prepare(`SELECT evidence_id,contact_type,contact_name,contact_title
      FROM lead_email_contact_point_evidence WHERE evidence_id IN (${evidenceIds.map(() => '?').join(',')}) ORDER BY id`)
      .all(...evidenceIds) : [];
    const contactPointsByEvidence = new Map();
    for (const row of contactPointRows) {
      if (!contactPointsByEvidence.has(row.evidence_id)) contactPointsByEvidence.set(row.evidence_id, []);
      contactPointsByEvidence.get(row.evidence_id).push({ contact_type: row.contact_type,
        contact_name: row.contact_name, contact_title: row.contact_title });
    }
    const emailMap = new Map();
    for (const row of savedEmailRows) {
      let item = emailMap.get(row.id);
      if (!item) {
        item = { email: row.email, verification_status: row.verification_status, source_url: row.source_url, source_evidence: [] };
        emailMap.set(row.id, item);
      }
      item.source_evidence.push({ source_url: row.source_url, evidence_type: row.evidence_type, raw_excerpt: row.raw_excerpt,
        content_hash: row.content_hash, extractor_version: row.extractor_version, observed_at: row.observed_at,
        contact_points: contactPointsByEvidence.get(row.evidence_id) || [] });
    }
    const savedEmails = [...emailMap.values()];
    const finalScan = getLeadScan(leadId);
    const refreshFoundCount = finalScan?.latest_refresh?.found_count || 0;
    const saved = { scan: finalScan, emails: savedEmails, addedCount,
      ...(refreshRunId ? { currentRefreshFoundCount: refreshFoundCount } : {}) };
    return {
      ...saved,
      foundCount: count,
      message: status === 'completed' && refreshRunId
        ? `Refresh complete · ${refreshFoundCount} address(es) seen on successfully fetched pages. Historical email records remain saved and unverified.`
        : status === 'completed'
        ? errorCode === 'rendered_fallback_unavailable'
          ? 'The bounded JavaScript page fallback could not load; no address was confirmed from the rendered view.'
          : `${count} address${count === 1 ? '' : 'es'} found; each remains unverified.`
        : 'The website scan stopped safely. This one-time attempt has been recorded.',
    };
  }

  function getLeadScan(leadId) {
    const id = Number(leadId);
    const scan = getScan.get(id);
    if (!scan) return null;
    const latestRefresh = latestRefreshForLead.get(id) || null;
    const refreshPaths = [...new Set([...jsonPathList(scan.visited_paths_json), ...jsonPathList(scan.pending_paths_json)])]
      .filter(value => !value.startsWith('@rendered:') && !value.startsWith(SITEMAP_PATH_PREFIX));
    return { ...scan, latest_refresh: latestRefresh,
      refreshable: scan.status !== 'running' && (scan.status === 'completed' || Boolean(latestRefresh)),
      refresh_page_count: refreshPaths.length };
  }

  return { scanLead, getLeadScan, recoverInterruptedScans };
}
