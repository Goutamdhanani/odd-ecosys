import dns from 'dns';
import { validateUrl } from './ssrf-guard.js';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

const dnsResolver = new dns.promises.Resolver();
try {
  dnsResolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch {
  // fallback to system resolver
}

import * as cheerio from 'cheerio';

export async function ensureCheerio() {
  return cheerio;
}
function parseHtml(html) {
  return cheerio.load(html);
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 3500; // 3.5 seconds max per page
const DELAY_BETWEEN_REQUESTS = 150; // fast 150ms delay

/**
 * Decode Cloudflare email protection encoded hex string.
 */
function decodeCloudflareEmail(encodedHex) {
  try {
    const k = parseInt(encodedHex.substr(0, 2), 16);
    let email = '';
    for (let i = 2; i < encodedHex.length; i += 2) {
      email += String.fromCharCode(parseInt(encodedHex.substr(i, 2), 16) ^ k);
    }
    return email;
  } catch {
    return null;
  }
}

/**
 * Enrich a single lead by crawling its website in prioritized parallel waves.
 * Wave 1: Homepage + /contact + /contact-us + /about
 * Wave 2 (if no emails): /team + /privacy-policy + /impressum
 * Fallback (if still no emails): DNS MX lookup + pattern role address generation
 * @param {object} lead - Lead object with website_url
 * @returns {Promise<object>} Enrichment data
 */
export async function enrichLead(lead) {
  await ensureCheerio();
  const result = {
    emails: [],
    facebook_url: cleanFacebookUrl(lead.facebook_url),
    instagram_url: null,
    linkedin_url: null,
    phones: [],
    has_contact_page: false,
    pages_crawled: 0,
    email_source: null,
    errors: [],
  };

  if (!lead.website_url) {
    return result;
  }

  // Normalize the base URL
  let baseUrl = lead.website_url.trim();
  if (!baseUrl.startsWith('http')) {
    baseUrl = `https://${baseUrl}`;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');

  // Validate URL with SSRF guard
  const urlCheck = await validateUrl(baseUrl);
  if (!urlCheck.safe) {
    result.errors.push({ url: baseUrl, error: `SSRF blocked: ${urlCheck.reason}` });
    return result;
  }

  // Wave 1: High-probability contact pages
  const wave1 = [
    baseUrl,
    `${baseUrl}/contact`,
    `${baseUrl}/contact-us`,
    `${baseUrl}/about`,
  ];

  const wave1Pages = await Promise.allSettled(wave1.map(url => crawlPage(url)));
  for (const item of wave1Pages) {
    if (item.status === 'fulfilled' && item.value) {
      const pageData = item.value;
      result.pages_crawled++;

      const emails = extractEmails(pageData.html, pageData.text);
      if (emails.length > 0) {
        result.emails.push(...emails);
        if (!result.email_source) result.email_source = 'website_crawl';
      }

      const fbUrl = extractFacebookUrl(pageData.html);
      if (fbUrl && !result.facebook_url) result.facebook_url = fbUrl;

      const socialUrls = extractSocialUrls(pageData.html);
      if (socialUrls.instagram && !result.instagram_url) result.instagram_url = socialUrls.instagram;
      if (socialUrls.linkedin && !result.linkedin_url) result.linkedin_url = socialUrls.linkedin;

      const phones = extractPhones(pageData.text);
      result.phones.push(...phones);

      if (pageData.url.includes('contact')) result.has_contact_page = true;
    }
  }

  // Wave 2: If no emails found on primary pages and host was responsive, check secondary pages
  if (result.emails.length === 0 && result.pages_crawled > 0) {
    const wave2 = [
      `${baseUrl}/team`,
      `${baseUrl}/staff`,
      `${baseUrl}/privacy-policy`,
      `${baseUrl}/privacy`,
      `${baseUrl}/impressum`,
    ];

    const wave2Pages = await Promise.allSettled(wave2.map(url => crawlPage(url)));
    for (const item of wave2Pages) {
      if (item.status === 'fulfilled' && item.value) {
        const pageData = item.value;
        result.pages_crawled++;

        const emails = extractEmails(pageData.html, pageData.text);
        if (emails.length > 0) {
          result.emails.push(...emails);
          if (!result.email_source) result.email_source = 'website_crawl_secondary';
        }

        const phones = extractPhones(pageData.text);
        result.phones.push(...phones);
      }
    }
  }

  // Deduplicate extracted data
  result.emails = [...new Set(result.emails)].filter(isValidEmail);
  result.phones = [...new Set(result.phones)];

  // Fallback: If no emails found from website, run DNS MX check & generate role candidates
  if (result.emails.length === 0) {
    try {
      const hostname = new URL(baseUrl).hostname.replace(/^www\./, '');
      let mxRecords = null;
      try {
        mxRecords = await dnsResolver.resolveMx(hostname);
      } catch {
        try {
          mxRecords = await dns.promises.resolveMx(hostname);
        } catch {}
      }
      if (mxRecords && mxRecords.length > 0) {
        result.emails.push(
          `info@${hostname}`,
          `contact@${hostname}`,
          `office@${hostname}`,
          `hello@${hostname}`
        );
        result.email_source = 'domain_mx_pattern';
      }
    } catch {
      // MX lookup not found or failed
    }
  }

  return result;
}

/**
 * Enrich a batch of leads concurrently (with concurrency limit).
 * @param {object[]} leads - Array of lead objects
 * @param {object} [options]
 * @param {number} [options.concurrency=3] - Max concurrent requests
 * @param {Function} [options.onProgress] - Progress callback
 * @returns {Promise<Map<number, object>>} Map of lead index → enrichment data
 */
export async function enrichLeadsBatch(leads, options = {}) {
  const { concurrency = 3, onProgress } = options;
  const results = new Map();
  const tasks = leads.map((lead, index) => ({ lead, index }));
  const leadsWithSites = tasks.filter(t => t.lead.website_url);

  console.log(`\n🌐 Enriching ${leadsWithSites.length} leads with websites (of ${leads.length} total)...`);

  // Process in chunks to limit concurrency
  for (let i = 0; i < leadsWithSites.length; i += concurrency) {
    const chunk = leadsWithSites.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(
      chunk.map(t => enrichLead(t.lead))
    );

    chunkResults.forEach((result, cIdx) => {
      const leadIdx = chunk[cIdx].index;
      if (result.status === 'fulfilled') {
        results.set(leadIdx, result.value);
      } else {
        results.set(leadIdx, {
          emails: [],
          facebook_url: null,
          instagram_url: null,
          linkedin_url: null,
          phones: [],
          has_contact_page: false,
          pages_crawled: 0,
          email_source: null,
          errors: [{ error: result.reason?.message || 'Unknown error' }],
        });
      }
    });

    const processed = Math.min(i + concurrency, leadsWithSites.length);
    if (onProgress) {
      onProgress(processed, leadsWithSites.length);
    }
    console.log(`   Enriched ${processed}/${leadsWithSites.length} leads...`);
  }

  return results;
}

/**
 * Crawl a single page and return its HTML + text content.
 */
async function crawlPage(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const html = await response.text();
    const $ = parseHtml(html);

    // Remove script and style tags for text extraction
    $('script, style, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();

    return { html, text, url };
  } catch {
    return null;
  }
}

/**
 * Extract email addresses from HTML and text content.
 * Checks: mailto links, Cloudflare encoded strings, JSON-LD schema, and text regex (including unmasking).
 */
function extractEmails(html, text) {
  const emails = new Set();
  const $ = parseHtml(html);

  // 1. From mailto: links
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const email = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
    if (email && isValidEmail(email)) emails.add(email);
  });

  // 2. From Cloudflare email protection
  $('[data-cfemail]').each((_, el) => {
    const hex = $(el).attr('data-cfemail');
    if (hex) {
      const decoded = decodeCloudflareEmail(hex);
      if (decoded && isValidEmail(decoded)) emails.add(decoded.toLowerCase());
    }
  });

  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const hex = href.split('#')[1];
    if (hex) {
      const decoded = decodeCloudflareEmail(hex);
      if (decoded && isValidEmail(decoded)) emails.add(decoded.toLowerCase());
    }
  });

  // 3. From schema.org JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const schemaText = $(el).text();
      const schema = JSON.parse(schemaText);
      const candidates = [];
      if (Array.isArray(schema)) {
        candidates.push(...schema);
      } else {
        candidates.push(schema);
      }
      for (const item of candidates) {
        if (!item) continue;
        if (typeof item.email === 'string') emails.add(item.email.trim().toLowerCase());
        if (typeof item.contactPoint?.email === 'string') emails.add(item.contactPoint.email.trim().toLowerCase());
      }
    } catch {}
  });

  // 4. From unmasked text & HTML regex
  const unmaskedText = (text || '')
    .replace(/\s*\[\s*at\s*\]\s*/gi, '@')
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/\s*\[\s*@\s*\]\s*/gi, '@')
    .replace(/\s+at\s+([a-zA-Z0-9-]+\.(?:com|org|net|co|io|edu|gov))\b/gi, '@$1');

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const textEmails = unmaskedText.match(emailRegex) || [];
  const htmlEmails = (html || '').match(emailRegex) || [];

  [...textEmails, ...htmlEmails].forEach(e => {
    const email = e.toLowerCase().trim();
    // Filter out common false positives and tracking pixels
    if (!email.endsWith('.png') && !email.endsWith('.jpg') &&
        !email.endsWith('.webp') && !email.endsWith('.svg') && !email.endsWith('.gif') &&
        !email.includes('example.com') && !email.includes('sentry.io') &&
        !email.includes('wixpress.com') && !email.includes('schema.org') &&
        !email.includes('googleapis.com') && !email.includes('cloudflare.com')) {
      if (isValidEmail(email)) {
        emails.add(email);
      }
    }
  });

  return [...emails];
}

/**
 * Extract social media profile URLs from HTML content.
 */
function extractSocialUrls(html) {
  const $ = parseHtml(html);
  let instagram = null;
  let linkedin = null;

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('instagram.com/') && !href.includes('/p/') && !instagram) {
      instagram = href.split('?')[0].replace(/\/+$/, '');
    }
    if (href.includes('linkedin.com/company/') && !linkedin) {
      linkedin = href.split('?')[0].replace(/\/+$/, '');
    }
  });

  return { instagram, linkedin };
}

/**
 * Extract Facebook page URL from HTML content.
 * Checks: anchors, Schema.org sameAs JSON-LD, OpenGraph / meta tags, and iframe Page Plugins.
 */
export function extractFacebookUrl(html) {
  if (!html) return null;
  const $ = parseHtml(html);
  let fbUrl = null;

  // 1. Anchors: Check all facebook.com, fb.me, and fb.com links
  $('a[href*="facebook.com"], a[href*="fb.me"], a[href*="fb.com"]').each((_, el) => {
    if (fbUrl) return false;
    let href = $(el).attr('href') || '';
    // Unwrap redirects (e.g. l.facebook.com or tracking wrappers)
    if (href.includes('u=http')) {
      try {
        const u = new URL(href.startsWith('http') ? href : `https://${href}`);
        const dest = u.searchParams.get('u');
        if (dest) href = dest;
      } catch {}
    }
    const clean = cleanFacebookUrl(href);
    if (clean) fbUrl = clean;
  });

  // 2. Schema.org JSON-LD sameAs
  if (!fbUrl) {
    $('script[type="application/ld+json"]').each((_, el) => {
      if (fbUrl) return false;
      try {
        const schema = JSON.parse($(el).text());
        const candidates = Array.isArray(schema) ? schema : [schema];
        for (const item of candidates) {
          if (!item) continue;
          const sameAsList = Array.isArray(item.sameAs) ? item.sameAs : (item.sameAs ? [item.sameAs] : []);
          for (const s of sameAsList) {
            const clean = cleanFacebookUrl(s);
            if (clean) {
              fbUrl = clean;
              return false;
            }
          }
        }
      } catch {}
    });
  }

  // 3. OpenGraph and Meta tags
  if (!fbUrl) {
    const metaCandidates = [
      $('meta[property="article:publisher"]').attr('content'),
      $('meta[property="og:see_also"]').attr('content'),
      $('meta[name="facebook"]').attr('content'),
    ];
    for (const m of metaCandidates) {
      if (m) {
        const clean = cleanFacebookUrl(m);
        if (clean) {
          fbUrl = clean;
          break;
        }
      }
    }
  }

  // 4. Embedded Facebook Page Plugin iframes
  if (!fbUrl) {
    $('iframe[src*="facebook.com/plugins/page.php"], iframe[src*="facebook.com/plugins/likebox.php"]').each((_, el) => {
      if (fbUrl) return false;
      const src = $(el).attr('src') || '';
      try {
        const u = new URL(src.startsWith('http') ? src : `https://${src}`);
        const href = u.searchParams.get('href');
        if (href) {
          const clean = cleanFacebookUrl(href);
          if (clean) fbUrl = clean;
        }
      } catch {}
    });
  }

  return fbUrl;
}

/**
 * Validate and clean a Facebook URL to canonical format.
 */
export function cleanFacebookUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    let clean = url.trim();
    if (clean.startsWith('//')) clean = `https:${clean}`;
    if (!clean.startsWith('http')) clean = `https://${clean}`;
    const u = new URL(clean);
    if (!u.hostname.includes('facebook.com') && !u.hostname.includes('fb.me') && !u.hostname.includes('fb.com')) {
      return null;
    }
    const path = u.pathname.replace(/\/+$/, '');
    const forbidden = [
      '/sharer', '/share.php', '/login', '/help', '/terms',
      '/policies', '/privacy', '/dialog', '/tr', '/v2.0',
      '/directory', '/search', '/hashtag', '/events'
    ];
    if (forbidden.some(f => path.toLowerCase().startsWith(f))) return null;
    if (path.length <= 1) return null;
    return `https://www.facebook.com${path}`;
  } catch {
    return null;
  }
}

export const normalizeFacebookUrl = cleanFacebookUrl;

/**
 * Extract phone numbers from text content.
 */
function extractPhones(text) {
  const phoneRegex = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  const ukPhoneRegex = /(?:\+44|0)\s?\d{2,5}\s?\d{3,4}\s?\d{3,4}/g;

  const matches = [
    ...(text.match(phoneRegex) || []),
    ...(text.match(ukPhoneRegex) || []),
  ];

  return [...new Set(matches.map(p => p.trim()))];
}

/**
 * Basic email validation.
 */
function isValidEmail(email) {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
