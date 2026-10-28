import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverLeads } from '../pipeline/lead-discovery.js';
import {
  GOOGLE_MAPS_SCRAPER_DISABLED,
  isDockerAvailable,
  runScraper,
  scrapeFacebookLeads,
  scrapeGoogleMapsNative,
  scrapeLeadsMultiMethod,
  scrapeWebQueryLeads,
  ensureDockerImage,
} from '../pipeline/scraper.js';

test('discovery orchestration fails closed before creating a batch', async () => {
  await assert.rejects(
    discoverLeads({ niche: 'roofers', geography: 'Ontario', options: { limit: 10 } }),
    /Automated Google Maps scraping is disabled/,
  );
});

test('legacy scraping and Docker entry points fail before fetching or writing', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('unexpected outbound request'); };
  try {
    await assert.rejects(scrapeGoogleMapsNative('dentists in Ontario'), new RegExp(GOOGLE_MAPS_SCRAPER_DISABLED));
    await assert.rejects(runScraper('unused-query-file.txt'), new RegExp(GOOGLE_MAPS_SCRAPER_DISABLED));
    await assert.rejects(ensureDockerImage(), new RegExp(GOOGLE_MAPS_SCRAPER_DISABLED));
    await assert.rejects(scrapeWebQueryLeads('dentists', 'Ontario'), /Search-engine result scraping is disabled/);
    await assert.rejects(scrapeFacebookLeads('dentists', 'Ontario'), /Facebook scraping is disabled/);
    await assert.rejects(scrapeLeadsMultiMethod({ niche: 'dentists', geography: 'Ontario', method: 'combined' }), new RegExp(GOOGLE_MAPS_SCRAPER_DISABLED));
    await assert.rejects(scrapeLeadsMultiMethod({ niche: 'dentists', geography: 'Ontario', method: 'web_search' }), /Search-engine result scraping is disabled/);
    assert.equal(await isDockerAvailable(), false);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authorized-source imports remain separate from the legacy scraper surface', async () => {
  await assert.rejects(
    discoverLeads({ niche: 'plumbers', geography: 'Ontario' }),
    /Import a contact CSV from a source you are authorized to use/,
  );
});
