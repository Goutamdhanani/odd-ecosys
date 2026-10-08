// ============================================================
//  ODD-ECOSYS Pipeline — Website Enrichment Crawler
//  Extracts emails + Facebook URLs from business websites
//  Uses native fetch + cheerio (HTML parser)
// ============================================================

let cheerioModule = null;
async function ensureCheerio() {
  if (!cheerioModule) cheerioModule = await import('cheerio');
  return cheerioModule;
}
function parseHtml(html) {
  if (!cheerioModule) throw new Error('cheerio not loaded; await ensureCheerio() before parsing HTML');
  return cheerioModule.load(html);
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 10000; // 10 seconds
const DELAY_BETWEEN_REQUESTS = 500; // 500ms between requests

/**
 * Enrich a single lead by crawling its website.
 * Visits homepage + /contact + /about to extract emails and Facebook URL.
 * @param {object} lead - Lead object with website_url
 * @returns {Promise<object>} Enrichment data
 */
export async function enrichLead(lead) {
  await ensureCheerio();
  const result = {
    emails: [],
    facebook_url: null,
    phones: [],
    has_contact_page: false,
    pages_crawled: 0,
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
  // Remove trailing slash
  baseUrl = baseUrl.replace(/\/+$/, '');

  // Pages to crawl in order of priority
  const pagesToCrawl = [
    baseUrl,
    `${baseUrl}/contact`,
    `${baseUrl}/contact-us`,
    `${baseUrl}/about`,
    `${baseUrl}/about-us`,
  ];

  for (const url of pagesToCrawl) {
    try {
      const pageData = await crawlPage(url);
      if (!pageData) continue;

      result.pages_crawled++;

      // Extract emails
      const emails = extractEmails(pageData.html, pageData.text);
      result.emails.push(...emails);

      // Extract Facebook URLs
      const fbUrl = extractFacebookUrl(pageData.html);
      if (fbUrl && !result.facebook_url) {
        result.facebook_url = fbUrl;
      }

      // Extract phone numbers
      const phones = extractPhones(pageData.text);
      result.phones.push(...phones);

      // Check if this was a contact page
      if (url.includes('contact')) {
        result.has_contact_page = true;
      }

      // Small delay between requests to be respectful
      await sleep(DELAY_BETWEEN_REQUESTS);

    } catch (error) {
      result.errors.push({ url, error: error.message });
    }
  }

  // Deduplicate extracted data
  result.emails = [...new Set(result.emails)].filter(isValidEmail);
  result.phones = [...new Set(result.phones)];

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
  const leadsWithSites = leads.filter(l => l.website_url);

  console.log(`\n🌐 Enriching ${leadsWithSites.length} leads with websites (of ${leads.length} total)...`);

  // Process in chunks to limit concurrency
  for (let i = 0; i < leadsWithSites.length; i += concurrency) {
    const chunk = leadsWithSites.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(
      chunk.map(lead => enrichLead(lead))
    );

    chunkResults.forEach((result, idx) => {
      const leadIdx = leads.indexOf(chunk[idx]);
      if (result.status === 'fulfilled') {
        results.set(leadIdx, result.value);
      } else {
        results.set(leadIdx, {
          emails: [],
          facebook_url: null,
          phones: [],
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
 */
function extractEmails(html, text) {
  const emails = new Set();

  // From mailto: links
  const $ = parseHtml(html);
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const email = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
    if (email) emails.add(email);
  });

  // From text content using regex
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const textEmails = text.match(emailRegex) || [];
  const htmlEmails = html.match(emailRegex) || [];

  [...textEmails, ...htmlEmails].forEach(e => {
    const email = e.toLowerCase().trim();
    // Filter out common false positives
    if (!email.endsWith('.png') && !email.endsWith('.jpg') &&
        !email.endsWith('.svg') && !email.endsWith('.gif') &&
        !email.includes('example.com') && !email.includes('sentry.io') &&
        !email.includes('wixpress.com') && !email.includes('schema.org')) {
      emails.add(email);
    }
  });

  return [...emails];
}

/**
 * Extract Facebook page URL from HTML content.
 */
function extractFacebookUrl(html) {
  const $ = parseHtml(html);
  let fbUrl = null;

  // Look for Facebook links in anchors
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('facebook.com') && !href.includes('sharer') && !href.includes('share.php')) {
      fbUrl = normalizeFacebookUrl(href);
      return false; // break
    }
  });

  // Also check Open Graph tags
  if (!fbUrl) {
    const ogFb = $('meta[property="og:see_also"]').attr('content') ||
                  $('meta[property="article:publisher"]').attr('content') || '';
    if (ogFb.includes('facebook.com')) {
      fbUrl = normalizeFacebookUrl(ogFb);
    }
  }

  return fbUrl;
}

/**
 * Normalize a Facebook URL to a consistent format.
 */
function normalizeFacebookUrl(url) {
  if (!url) return null;
  try {
    let clean = url.trim();
    // Remove tracking parameters
    clean = clean.split('?')[0];
    // Remove trailing slash
    clean = clean.replace(/\/+$/, '');
    // Ensure https
    if (clean.startsWith('//')) clean = `https:${clean}`;
    if (!clean.startsWith('http')) clean = `https://${clean}`;
    return clean;
  } catch {
    return url;
  }
}

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
