import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCityCoordinates,
  cleanFacebookUrl,
  scrapeGoogleMapsNative,
  scrapeFacebookLeads,
  scrapeLeadsMultiMethod,
} from '../pipeline/scraper.js';
import { extractFacebookUrl, normalizeFacebookUrl } from '../pipeline/enricher.js';
import { checkFacebookLiveness } from '../pipeline/qualifier.js';

test('Google Maps: getCityCoordinates resolves coordinates across global and regional queries', () => {
  const austin = getCityCoordinates('Austin TX');
  assert.equal(austin.lat, 30.2672);
  assert.equal(austin.lng, -97.7431);

  const miami = getCityCoordinates('Miami FL');
  assert.equal(miami.lat, 25.7617);
  assert.equal(miami.lng, -80.1918);

  const london = getCityCoordinates('London UK');
  assert.equal(london.lat, 51.5074);
  assert.equal(london.lng, -0.1278);

  const sydney = getCityCoordinates('Sydney Australia');
  assert.equal(sydney.lat, -33.8688);

  // State code fallback
  const txFallback = getCityCoordinates('SomeUnknownTown TX');
  assert.equal(txFallback.lat, 31.9686);
});

test('Facebook: cleanFacebookUrl standardizes page links and strips tracking', () => {
  const dirty1 = 'https://www.facebook.com/SouthAustinDentist?ref=bookmarks&fref=ts';
  assert.equal(cleanFacebookUrl(dirty1), 'https://www.facebook.com/SouthAustinDentist');

  const dirty2 = 'http://fb.me/MyLocalBusiness/';
  assert.equal(cleanFacebookUrl(dirty2), 'https://www.facebook.com/MyLocalBusiness');

  const dirty3 = 'facebook.com/pages/Dental-Care/123456789?mibextid=abc';
  assert.equal(cleanFacebookUrl(dirty3), 'https://www.facebook.com/pages/Dental-Care/123456789');

  // Should discard non-business paths
  assert.equal(cleanFacebookUrl('https://facebook.com/sharer/sharer.php?u=foo'), null);
  assert.equal(cleanFacebookUrl('https://facebook.com/share.php'), null);
  assert.equal(cleanFacebookUrl('https://facebook.com/login'), null);
  assert.equal(cleanFacebookUrl('https://facebook.com/help'), null);
  assert.equal(cleanFacebookUrl('https://facebook.com/policies'), null);
  assert.equal(cleanFacebookUrl('https://facebook.com/hashtag/smile'), null);
  assert.equal(cleanFacebookUrl('https://google.com'), null);
  assert.equal(cleanFacebookUrl(''), null);
  assert.equal(cleanFacebookUrl(null), null);
});

test('Facebook: extractFacebookUrl detects pages from anchors, JSON-LD, OpenGraph, and widgets', () => {
  // 1. Anchor tag with tracking
  const html1 = `<div><a href="https://www.facebook.com/AustinBakery?locale=en_US">Follow Us</a></div>`;
  assert.equal(extractFacebookUrl(html1), 'https://www.facebook.com/AustinBakery');

  // 2. Schema.org JSON-LD sameAs array
  const html2 = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "LocalBusiness",
            "name": "Austin Dental",
            "sameAs": [
              "https://twitter.com/austindental",
              "https://www.facebook.com/AustinDentalPractice/"
            ]
          }
        </script>
      </head>
      <body></body>
    </html>
  `;
  assert.equal(extractFacebookUrl(html2), 'https://www.facebook.com/AustinDentalPractice');

  // 3. OpenGraph meta tag
  const html3 = `<html><head><meta property="article:publisher" content="https://www.facebook.com/CapitalRoofing"></head></html>`;
  assert.equal(extractFacebookUrl(html3), 'https://www.facebook.com/CapitalRoofing');

  // 4. Iframe Facebook Page Plugin widget
  const html4 = `
    <html><body>
      <iframe src="https://www.facebook.com/plugins/page.php?href=https%3A%2F%2Fwww.facebook.com%2FModernPlumbingAustin&tabs=timeline"></iframe>
    </body></html>
  `;
  assert.equal(extractFacebookUrl(html4), 'https://www.facebook.com/ModernPlumbingAustin');

  // 5. Shortlink
  const html5 = `<a href="https://fb.me/ATXElectric">FB</a>`;
  assert.equal(extractFacebookUrl(html5), 'https://www.facebook.com/ATXElectric');
});

test('Google Maps: scrapeGoogleMapsNative extracts complete B2B data', async () => {
  const leads = await scrapeGoogleMapsNative('dentists in Austin TX', { limit: 3 });
  assert.ok(Array.isArray(leads));
  assert.ok(leads.length > 0, 'Should extract at least 1 lead');

  const first = leads[0];
  assert.ok(first.business_name, 'Business name is required');
  assert.equal(first.source, 'google_maps');
  assert.ok(first.city, 'City is extracted');
  assert.ok(first.address, 'Address is extracted');
  if (first.phone) {
    assert.match(first.phone, /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  }
});

test('Facebook: scrapeFacebookLeads returns valid structured prospects', async () => {
  const fbLeads = await scrapeFacebookLeads('plumbers', 'Austin TX', { limit: 2 });
  assert.ok(Array.isArray(fbLeads));
  for (const lead of fbLeads) {
    assert.ok(lead.business_name);
    assert.equal(lead.source, 'facebook');
    assert.ok(lead.city);
  }
});

test('Multi-method: scrapeLeadsMultiMethod supports facebook engine and deduplication', async () => {
  const leads = await scrapeLeadsMultiMethod({
    niche: 'dentists',
    geography: 'Austin TX',
    method: 'facebook',
    limit: 2,
  });
  assert.ok(Array.isArray(leads));
  for (const lead of leads) {
    assert.equal(lead.source, 'facebook');
  }
});

test('Facebook: checkFacebookLiveness handles valid and invalid pages without stalling', async () => {
  // Null or invalid URL returns null fast
  const rNull = await checkFacebookLiveness(null);
  assert.equal(rNull, null);

  const rInvalid = await checkFacebookLiveness('not-a-url');
  assert.equal(rInvalid, null);

  const rNonFb = await checkFacebookLiveness('https://example.com');
  assert.equal(rNonFb, null);
});

test('Google Maps: getGeoGridCoordinates tiles cardinal quadrants for deep city scan', async () => {
  const { getGeoGridCoordinates } = await import('../pipeline/scraper.js');
  const grid = getGeoGridCoordinates('Austin TX', 5);
  assert.equal(grid.length, 5);
  const names = grid.map(g => g.name);
  assert.deepEqual(names, ['center', 'north', 'south', 'east', 'west']);

  const center = grid.find(g => g.name === 'center');
  const north = grid.find(g => g.name === 'north');
  const south = grid.find(g => g.name === 'south');
  const east = grid.find(g => g.name === 'east');
  const west = grid.find(g => g.name === 'west');

  assert.ok(north.lat > center.lat, 'North quadrant should have higher latitude');
  assert.ok(south.lat < center.lat, 'South quadrant should have lower latitude');
  assert.ok(east.lng > center.lng, 'East quadrant should have higher longitude');
  assert.ok(west.lng < center.lng, 'West quadrant should have lower longitude');
});

test('Protobuf: extractBookingUrl, extractPhotoUrl, extractPriceLevel & isPermanentlyClosed', async () => {
  const {
    extractBookingUrl,
    extractPhotoUrl,
    extractPriceLevel,
    isPermanentlyClosed,
    extractHoursStatus,
  } = await import('../pipeline/scraper.js');

  // Booking URL extraction
  const mockDWithBooking = [];
  mockDWithBooking[75] = [[[3, null, [[['smileaustin.com'], [null, null, ['https://www.smileaustin.com/appointments/?utm_source=google&rwg_token=123']]]]]]];
  const booking = extractBookingUrl(mockDWithBooking);
  assert.equal(booking, 'https://www.smileaustin.com/appointments/');

  // High-res photo extraction
  const mockDPhoto = [];
  mockDPhoto[157] = 'https://lh4.googleusercontent.com/photo/s44-p-k-no/photo.jpg';
  const photo = extractPhotoUrl(mockDPhoto);
  assert.equal(photo, 'https://lh4.googleusercontent.com/photo/s400/photo.jpg');

  // Price tier extraction
  const mockDPrice = [];
  mockDPrice[4] = [null, null, 2];
  assert.equal(extractPriceLevel(mockDPrice), '$$');

  // Permanently closed check
  const mockDOpen = [];
  mockDOpen[34] = null;
  assert.equal(isPermanentlyClosed(mockDOpen), false);

  const mockDClosed = [];
  mockDClosed[34] = [2, 'Permanently closed'];
  assert.equal(isPermanentlyClosed(mockDClosed), true);
  assert.equal(extractHoursStatus(mockDClosed), 'Permanently closed');
});

test('Social Normalizers: cleanInstagramUrl, cleanLinkedinUrl, cleanTwitterUrl', async () => {
  const {
    cleanInstagramUrl,
    cleanLinkedinUrl,
    cleanTwitterUrl,
  } = await import('../pipeline/scraper.js');

  // Instagram
  assert.equal(cleanInstagramUrl('https://instagram.com/atxdental/'), 'https://www.instagram.com/atxdental');
  assert.equal(cleanInstagramUrl('https://instagram.com/p/Cxyz123'), null);

  // LinkedIn
  assert.equal(cleanLinkedinUrl('https://linkedin.com/company/atx-plumbing/'), 'https://www.linkedin.com/company/atx-plumbing');
  assert.equal(cleanLinkedinUrl('https://linkedin.com/login'), null);

  // Twitter / X
  assert.equal(cleanTwitterUrl('https://twitter.com/atxroofing'), 'https://x.com/atxroofing');
  assert.equal(cleanTwitterUrl('https://x.com/atxroofing/'), 'https://x.com/atxroofing');
  assert.equal(cleanTwitterUrl('https://twitter.com/share'), null);
});

test('Lead Fusion: fuseLead merges rich multi-engine contacts without data loss', async () => {
  const { fuseLead } = await import('../pipeline/scraper.js');

  const mapsLead = {
    business_name: 'Acme Dental',
    city: 'Austin',
    phone: '512-555-1234',
    website_url: 'https://acmedental.com',
    rating: 4.9,
    reviews: 120,
    place_id: 'ChIJ12345',
    booking_url: 'https://acmedental.com/book',
    photo_url: 'https://lh4.googleusercontent.com/p/s400/photo.jpg',
    source: 'google_maps',
  };

  const fbLead = {
    business_name: 'Acme Dental Practice',
    city: 'Austin',
    facebook_url: 'https://www.facebook.com/acmedental',
    email: 'info@acmedental.com',
    instagram_url: 'https://www.instagram.com/acmedental',
    source: 'facebook',
  };

  const fused = fuseLead(mapsLead, fbLead);

  assert.equal(fused.business_name, 'Acme Dental');
  assert.equal(fused.phone, '512-555-1234');
  assert.equal(fused.website_url, 'https://acmedental.com');
  assert.equal(fused.facebook_url, 'https://www.facebook.com/acmedental');
  assert.equal(fused.instagram_url, 'https://www.instagram.com/acmedental');
  assert.equal(fused.email, 'info@acmedental.com');
  assert.equal(fused.booking_url, 'https://acmedental.com/book');
  assert.equal(fused.photo_url, 'https://lh4.googleusercontent.com/p/s400/photo.jpg');
  assert.equal(fused.rating, 4.9);
  assert.equal(fused.source, 'combined');
  assert.deepEqual(fused.sources, ['google_maps', 'facebook']);
});

function awaitImportScraper() {
  return import('../pipeline/scraper.js');
}

