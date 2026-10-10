// Legacy compatibility surface. Automatic website crawling was removed so
// CSV imports and bulk discovery cannot silently fetch every contact site.
// Use website-email-discovery.js through the authenticated one-time API action.

const DISABLED_MESSAGE = 'Automatic website crawling is disabled. Use the one-time public website scan on an individual contact.';

function emptyResult(lead) {
  return {
    emails: [],
    facebook_url: null,
    phones: [],
    has_contact_page: false,
    pages_crawled: 0,
    errors: lead?.website_url ? [{ url: lead.website_url, error: DISABLED_MESSAGE }] : [],
  };
}

export async function enrichLead(lead) {
  return emptyResult(lead);
}

export async function enrichLeadsBatch(leads, { onProgress } = {}) {
  const results = new Map();
  const candidates = Array.isArray(leads) ? leads : [];
  const withSites = candidates.map((lead, index) => ({ lead, index })).filter(item => item.lead?.website_url);
  for (const { lead, index } of withSites) results.set(index, emptyResult(lead));
  onProgress?.(withSites.length, withSites.length);
  return results;
}
