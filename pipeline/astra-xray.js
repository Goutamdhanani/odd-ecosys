import { load } from 'cheerio';

export const ASTRA_XRAY_VERSION = 'astra-business-xray/1.0.0';
export const ASTRA_XRAY_MAX_EVIDENCE_AGE_DAYS = 90;
const MAX_EXCERPT = 320;
const WORD_SPACE = /[\t\f\v ]+/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PRICE = /(?:\b(?:INR|USD|EUR|GBP|CAD|AUD)\s*|[₹$€£]\s?)\d[\d,]*(?:\.\d{1,2})?(?:\s*(?:\/\s*(?:mo(?:nth)?|yr|year)|per\s+(?:month|year)))?/gi;
const CTA = /\b(contact|call|book|schedule|request|talk|demo|quote|get started|start now|sign up|subscribe|buy|purchase|shop|enquire|inquire)\b/i;
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'nav', 'ol', 'p', 'section', 'table', 'td', 'th', 'tr', 'ul']);
const ROLES = [
  ['contact', /(?:^|[\/_-])(?:contact|contact-us|contactus|reach-us)(?:[\/_-]|$)/i],
  ['pricing', /(?:^|[\/_-])(?:pricing|price|plans?)(?:[\/_-]|$)/i],
  ['privacy', /(?:^|[\/_-])(?:privacy|privacy-policy)(?:[\/_-]|$)/i],
  ['about', /(?:^|[\/_-])(?:about|company|who-we-are)(?:[\/_-]|$)/i],
  ['services', /(?:^|[\/_-])(?:services?|products?|solutions?)(?:[\/_-]|$)/i],
];

function cleanText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(WORD_SPACE, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function hasExplicitHiddenStyle(style) {
  return String(style || '').split(';').some(declaration => {
    const separator = declaration.indexOf(':');
    if (separator < 0) return false;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).replace(/\s*!important\s*$/i, '').trim().toLowerCase();
    return (property === 'display' && value === 'none')
      || (property === 'visibility' && ['hidden', 'collapse'].includes(value));
  });
}
function removeExplicitlyHidden($) {
  const elements = $('*').toArray();
  for (const element of elements) {
    const attributes = element.attribs || {};
    const ariaHidden = String(attributes['aria-hidden'] || '').trim().toLowerCase() === 'true';
    if (Object.hasOwn(attributes, 'hidden') || ariaHidden || hasExplicitHiddenStyle(attributes.style)) $(element).remove();
  }
}
function domText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.data || '';
  const value = (node.children || []).map(domText).join('');
  const name = String(node.name || '').toLowerCase();
  return BLOCK_TAGS.has(name) ? `\n${value}\n` : name === 'a' ? ` ${value} ` : value;
}
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}
function pageRole(sourceUrl, title, headings) {
  const url = safeUrl(sourceUrl);
  const path = url?.pathname || '';
  const byPath = ROLES.find(([, pattern]) => pattern.test(path))?.[0];
  if (byPath) return byPath;
  const copy = `${title || ''} ${(headings || []).join(' ')}`;
  return ROLES.find(([role]) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${role}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(copy))?.[0] || 'other';
}
function snippetAround(text, index, length) {
  const start = Math.max(0, index - 72);
  const end = Math.min(text.length, index + length + 90);
  return cleanText(text.slice(start, end)).slice(0, MAX_EXCERPT);
}
function matchEvidence(text, regex) {
  const rows = [];
  regex.lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    const value = match[0].trim();
    if (!value || rows.some(row => row.value.toLowerCase() === value.toLowerCase())) continue;
    rows.push({ value, exactExcerpt: snippetAround(text, match.index ?? 0, value.length) });
    if (rows.length >= 100) break;
  }
  return rows;
}
function canonicalPageKey(sourceUrl) {
  const url = safeUrl(sourceUrl);
  if (!url) return null;
  url.hash = '';
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  return `${url.origin.toLowerCase()}${url.pathname}${url.search}`;
}
function roleForLink(href, sourceUrl, domain) {
  const base = safeUrl(sourceUrl);
  if (!base) return null;
  let url;
  try { url = new URL(href, base); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.hostname.toLowerCase().replace(/^www\./, '') !== String(domain).toLowerCase().replace(/^www\./, '')) return null;
  return pageRole(url.toString(), '', []);
}

/** Parse only already-captured HTML. No source text is evaluated or treated as instructions. */
export function inspectXrayPage(input) {
  const { html, sourceUrl, normalizedDomain } = input;
  const $ = load(Buffer.isBuffer(html) ? html.toString('utf8') : String(html), { scriptingEnabled: false });
  $('script,style,template,noscript,svg,canvas,iframe,object,embed,form,input,button,select,textarea').remove();
  removeExplicitlyHidden($);
  const title = cleanText($('title').first().text()).slice(0, 500);
  const metaDescription = cleanText($('meta[name="description" i]').first().attr('content')).slice(0, 2000);
  const headings = $('h1,h2,h3').toArray().map(el => cleanText($(el).text())).filter(Boolean).slice(0, 60);
  const h1 = $('h1').toArray().map(el => cleanText($(el).text())).filter(Boolean).slice(0, 20);
  const visibleText = cleanText(domText($('body').get(0))).slice(0, 250000);
  const emails = [...new Set((visibleText.match(EMAIL) || []).map(value => value.toLowerCase()))].slice(0, 100);
  const phones = [...new Set($('a[href^="tel:"]').toArray().map(el => cleanText($(el).attr('href')?.replace(/^tel:/i, ''))).filter(Boolean))].slice(0, 50);
  const prices = matchEvidence(visibleText, PRICE);
  const emailEvidence = emails.map(value => ({ value, exactExcerpt: snippetAround(visibleText, visibleText.toLowerCase().indexOf(value), value.length) }));
  const links = $('a[href]').toArray().map(el => {
    const label = cleanText($(el).text()).slice(0, 160);
    const href = String($(el).attr('href') || '').trim();
    const role = roleForLink(href, sourceUrl, normalizedDomain);
    return { label, href, role };
  }).filter(link => link.href && link.role);
  const ctas = links.filter(link => CTA.test(link.label)).slice(0, 30);
  const url = safeUrl(sourceUrl);
  return {
    sourceUrl, normalizedDomain, title, metaDescription, headings, h1,
    visibleText, wordCount: visibleText ? visibleText.split(/\s+/).filter(Boolean).length : 0,
    role: pageRole(sourceUrl, title, headings), emails, emailEvidence, phones,
    prices, links: links.slice(0, 100), ctas, canonicalPageKey: canonicalPageKey(sourceUrl),
    path: url?.pathname || null,
    pageExcerpt: visibleText.slice(0, MAX_EXCERPT),
  };
}

function evidenceRef(page, excerpt = null) {
  return {
    evidenceId: page.evidenceId, sourceId: page.sourceId, sourceUrl: page.sourceUrl,
    contentSha256: page.contentSha256, capturedAt: page.capturedAt,
    exactExcerpt: cleanText(excerpt || page.pageExcerpt || page.title || page.sourceUrl).slice(0, MAX_EXCERPT),
  };
}
function finding(signal, title, outcome, value, detail, evidence = []) {
  return { signal, title, outcome, value, detail, evidence };
}
function uniqueEvidence(pages) {
  const found = new Map();
  for (const page of pages) if (page.contentSha256 && !found.has(page.contentSha256)) found.set(page.contentSha256, page);
  return [...found.values()];
}

/**
 * Summarize verified snapshots for one account. Input rows must already be
 * tenant-scoped and rights/source/hash checked by the research service.
 */
export function buildAstraXrayReport({ account, pages, pageCoverage, now = new Date() }) {
  const usablePages = pages.filter(page => page.status === 'usable');
  const distinctPages = uniqueEvidence(usablePages);
  const refs = distinctPages.map(page => evidenceRef(page));
  const emailCount = distinctPages.reduce((sum, page) => sum + page.emails.length, 0);
  const phoneCount = distinctPages.reduce((sum, page) => sum + page.phones.length, 0);
  const ctaCount = distinctPages.reduce((sum, page) => sum + page.ctas.length, 0);
  const priceCount = distinctPages.reduce((sum, page) => sum + page.prices.length, 0);
  const roleCounts = Object.fromEntries(ROLES.map(([role]) => [role, distinctPages.filter(page => page.role === role).length]));
  const linkedRoles = new Set(distinctPages.flatMap(page => page.links.map(link => link.role)));
  const findings = [];
  findings.push(finding('captured_page_count', 'Captured page coverage', usablePages.length ? 'observed' : 'unknown', {
    suppliedPages: pageCoverage.length, usablePages: usablePages.length, uniqueContentPages: distinctPages.length,
  }, 'Counts describe only permitted snapshots supplied to this audit; no site-wide crawl was performed.', refs));

  for (const role of ['contact', 'pricing', 'privacy', 'about', 'services']) {
    const count = roleCounts[role];
    const evidence = distinctPages.filter(page => page.role === role).map(page => evidenceRef(page));
    const linked = distinctPages.filter(page => page.links.some(link => link.role === role))
      .flatMap(page => page.links.filter(link => link.role === role).map(link => evidenceRef(page, `${link.label || link.href} — ${link.href}`)));
    const detail = count
      ? `${count} distinct captured page(s) were identified as ${role} pages; this says nothing about uncaptured routes.`
      : linkedRoles.has(role)
        ? `A ${role} link appears in captured navigation, but its destination page was not captured and remains unknown.`
        : `No ${role} page was identified among the supplied captures. This is unknown beyond those captures.`;
    findings.push(finding(`${role}_page_coverage`, `${role[0].toUpperCase()}${role.slice(1)} page coverage`, count ? 'observed' : 'unknown',
      { capturedPages: count, linkedFromCapturedPages: linkedRoles.has(role) }, detail, evidence.length ? evidence : linked.length ? linked : refs));
  }

  const emailEvidence = distinctPages.flatMap(page => page.emailEvidence.map(item => evidenceRef(page, item.exactExcerpt)));
  findings.push(finding('email_candidate_count', 'Email candidates in captured pages', emailCount ? 'observed' : 'unknown', { count: emailCount },
    emailCount ? `${emailCount} distinct email candidate(s) were visible in unique captured content; they remain unverified.`
      : 'No email candidate was visible in unique captured content. This does not establish site-wide absence.', emailEvidence.length ? emailEvidence : refs));
  findings.push(finding('telephone_link_count', 'Telephone links in captured pages', phoneCount ? 'observed' : 'unknown', { count: phoneCount },
    phoneCount ? `${phoneCount} telephone link(s) were present in unique captured content.`
      : 'No tel: link was visible in unique captured content; other contact methods may exist.',
    distinctPages.filter(page => page.phones.length).flatMap(page => page.phones.map(number => evidenceRef(page, `tel:${number}`))).length
      ? distinctPages.filter(page => page.phones.length).flatMap(page => page.phones.map(number => evidenceRef(page, `tel:${number}`))) : refs));
  findings.push(finding('call_to_action_count', 'Call-to-action labels', ctaCount ? 'observed' : 'unknown', { count: ctaCount },
    ctaCount ? `${ctaCount} link label(s) matched the local action vocabulary in unique captured content.`
      : 'No label matched the local action vocabulary in unique captured content; this is not a conversion assessment.',
    distinctPages.filter(page => page.ctas.length).flatMap(page => page.ctas.map(link => evidenceRef(page, `${link.label || '(unlabeled link)'} — ${link.href}`))).length
      ? distinctPages.filter(page => page.ctas.length).flatMap(page => page.ctas.map(link => evidenceRef(page, `${link.label || '(unlabeled link)'} — ${link.href}`))) : refs));
  const priceEvidence = distinctPages.flatMap(page => page.prices.map(item => evidenceRef(page, item.exactExcerpt)));
  findings.push(finding('visible_price_mention_count', 'Visible price mentions', priceCount ? 'observed' : 'unknown', { count: priceCount },
    priceCount ? `${priceCount} currency-formatted price mention(s) were detected in unique captured text; amounts are not normalized or treated as current offers.`
      : 'No supported currency-formatted price mention was detected in unique captured text. Pricing elsewhere remains unknown.', priceEvidence.length ? priceEvidence : refs));

  const opportunities = [];
  if (refs.length) for (const role of ['contact', 'pricing', 'privacy', 'about', 'services']) {
    if (roleCounts[role] || linkedRoles.has(role)) continue;
    opportunities.push({ id: `review-${role}-coverage`, title: `Review ${role} page coverage`, priority: 'review',
      recommendation: `If a ${role} page is relevant, capture it before drawing conclusions about its content.`,
      reason: `No supplied capture was identified as a ${role} page and no matching internal link was seen in the unique captured pages. This is a coverage gap, not a site-wide absence.`, evidence: refs });
  }
  if (!emailCount && refs.length) opportunities.push({ id: 'review-contact-channel', title: 'Review contact-channel visibility', priority: 'review',
    recommendation: 'Consider whether a contact route or contact method should be visible on the pages customers are expected to use.',
    reason: 'No email candidate was found in unique captured content; telephone links and uninspected pages may still provide contact routes.', evidence: refs });
  for (const page of distinctPages) {
    if (!page.h1.length) opportunities.push({ id: `review-h1-${page.evidenceId}`, title: 'Review page heading', priority: 'review',
      recommendation: 'Review whether this captured page should have a descriptive primary heading.',
      reason: 'The parsed snapshot contains no H1 element. This recommendation applies to this captured page only.', evidence: [evidenceRef(page)] });
    if (!page.metaDescription) opportunities.push({ id: `review-description-${page.evidenceId}`, title: 'Review search-result description', priority: 'review',
      recommendation: 'Review whether this captured page needs a concise meta description.',
      reason: 'The parsed snapshot contains no non-empty meta description. This recommendation applies to this captured page only.', evidence: [evidenceRef(page)] });
  }

  const summary = {
    accountId: account.id, normalizedDomain: account.normalizedDomain,
    suppliedPages: pageCoverage.length, usablePages: usablePages.length,
    uniqueContentPages: distinctPages.length,
    duplicateContentPages: pageCoverage.filter(page => page.status === 'duplicate_content').length,
    supersededPages: pageCoverage.filter(page => page.status === 'superseded').length,
    stalePages: pageCoverage.filter(page => page.status === 'stale').length,
    rightsBlockedPages: pageCoverage.filter(page => ['rights_expired', 'rights_unverified', 'rights_revoked', 'rights_unavailable'].includes(page.status)).length,
    revokedPages: pageCoverage.filter(page => page.status === 'rights_revoked').length,
    ambiguousPages: pageCoverage.filter(page => page.status === 'ambiguous').length,
    emailCandidates: emailCount, telephoneLinks: phoneCount, callToActionLabels: ctaCount, priceMentions: priceCount,
    pageRoles: roleCounts, freshnessWindowDays: ASTRA_XRAY_MAX_EVIDENCE_AGE_DAYS,
    generatedAt: now.toISOString(),
  };
  const sourceCoverage = {
    status: usablePages.length ? 'partial' : 'insufficient',
    explanation: 'Only captured, permitted HTML snapshots were analyzed. No network fetch, JavaScript execution, or site-wide crawl occurred. Explicit hidden attributes, aria-hidden=true, and inline display/visibility suppression are excluded; external stylesheets and script-driven visibility are not evaluated.',
    freshnessWindowDays: ASTRA_XRAY_MAX_EVIDENCE_AGE_DAYS,
    pages: pageCoverage.map(({ html, ...page }) => page),
  };
  return { auditVersion: ASTRA_XRAY_VERSION, coverageStatus: 'partial', findings, summary, opportunities, sourceCoverage,
    metrics: { usablePages: usablePages.length, uniqueContentPages: distinctPages.length, emailCandidates: emailCount,
      telephoneLinks: phoneCount, callToActionLabels: ctaCount, priceMentions: priceCount,
      contactPageCaptures: roleCounts.contact, pricingPageCaptures: roleCounts.pricing },
    pageCoverage };
}

