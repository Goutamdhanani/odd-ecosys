// ============================================================
//  ODD-ECOSYS Pipeline — Google Maps Scraper (Docker wrapper)
//  Wraps gosom/google-maps-scraper Docker image
// ============================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import dns from 'dns';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUERIES_DIR = path.join(__dirname, 'queries');
const DATA_DIR = path.join(__dirname, '..', 'data');

export const GOOGLE_MAPS_SCRAPER_DISABLED =
  'Automated Google Maps scraping is disabled. Configure an authorized source connector instead.';
const SEARCH_SCRAPING_DISABLED =
  'Search-engine result scraping is disabled. Configure an authorized source connector instead.';
const FACEBOOK_SCRAPING_DISABLED =
  'Automated Facebook scraping is disabled. Use an authorized Meta integration instead.';

/**
 * Generate search queries from niche + geography.
 * @param {string} niche - Business category (e.g. "dentists")
 * @param {string} geography - Location (e.g. "Austin TX")
 * @param {object} [options]
 * @param {string[]} [options.additionalQueries] - Extra search queries
 * @returns {string} Path to the query file
 */
export function generateQueryFile(niche, geography, options = {}) {
  const queries = [
    `${niche} in ${geography}`,
  ];

  // Add common variations
  const nicheVariations = {
    'dentists': ['dental clinic', 'dental office', 'dental practice', 'cosmetic dentist', 'family dentistry'],
    'plumbers': ['plumbing services', 'plumbing company', 'plumber', 'emergency plumber', 'commercial plumbing'],
    'roofers': ['roofing company', 'roofing contractor', 'roof repair', 'commercial roofing', 'roof replacement'],
    'hvac': ['hvac company', 'air conditioning repair', 'heating and cooling', 'ac service', 'hvac contractor'],
    'salons': ['hair salon', 'beauty salon', 'barber shop', 'hair styling', 'nail salon'],
    'electricians': ['electrical contractor', 'electrical services', 'licensed electrician', 'commercial electrician', 'emergency electrician'],
    'landscapers': ['landscaping company', 'lawn care service', 'landscape contractor', 'commercial landscaping'],
    'auto repair': ['auto mechanic', 'car repair shop', 'auto body shop', 'brake repair', 'transmission repair'],
    'lawyers': ['law firm', 'attorney', 'legal services', 'personal injury attorney', 'corporate lawyer'],
    'accountants': ['accounting firm', 'cpa firm', 'certified public accountant', 'bookkeeping service', 'tax accountant'],
    'chiropractors': ['chiropractic clinic', 'chiropractic center', 'family chiropractor'],
    'real estate': ['real estate agency', 'realtor', 'property management', 'commercial real estate'],
    'solar': ['solar company', 'solar panel installation', 'solar contractors'],
  };

  const variations = nicheVariations[niche.toLowerCase()] || [];
  for (const variant of variations) {
    queries.push(`${variant} in ${geography}`);
  }

  // Universal B2B prefixes for maximum coverage across all industries
  const prefixes = ['best', 'commercial', 'top rated', 'emergency'];
  for (const p of prefixes) {
    queries.push(`${p} ${niche} ${geography}`);
  }
  queries.push(`${niche} company ${geography}`);
  queries.push(`${niche} contractors ${geography}`);

  if (options.additionalQueries) {
    queries.push(...options.additionalQueries);
  }

  const filename = `${niche.toLowerCase().replace(/\s+/g, '-')}_${geography.toLowerCase().replace(/\s+/g, '-')}_${Date.now()}.txt`;
  const filepath = path.join(QUERIES_DIR, filename);
  fs.mkdirSync(QUERIES_DIR, { recursive: true });
  fs.writeFileSync(filepath, queries.join('\n'), 'utf-8');

  return filepath;
}

// ══════════════════════════════════════════════════════════════
//  GEOGRAPHIC COORDINATES LOOKUP
// ══════════════════════════════════════════════════════════════

export function getCityCoordinates(geography = '') {
  const geoLower = geography.toLowerCase();
  const CITIES = {
    'austin': { lat: 30.2672, lng: -97.7431 },
    'houston': { lat: 29.7604, lng: -95.3698 },
    'dallas': { lat: 32.7767, lng: -96.7970 },
    'san antonio': { lat: 29.4241, lng: -98.4936 },
    'fort worth': { lat: 32.7555, lng: -97.3308 },
    'el paso': { lat: 31.7619, lng: -106.4850 },
    'arlington': { lat: 32.7357, lng: -97.1081 },
    'plano': { lat: 33.0198, lng: -96.6989 },
    'new york': { lat: 40.7128, lng: -74.0060 },
    'nyc': { lat: 40.7128, lng: -74.0060 },
    'los angeles': { lat: 34.0522, lng: -118.2437 },
    'la': { lat: 34.0522, lng: -118.2437 },
    'san diego': { lat: 32.7157, lng: -117.1611 },
    'san jose': { lat: 37.3382, lng: -121.8863 },
    'san francisco': { lat: 37.7749, lng: -122.4194 },
    'fresno': { lat: 36.7468, lng: -119.7726 },
    'sacramento': { lat: 38.5816, lng: -121.4944 },
    'long beach': { lat: 33.7701, lng: -118.1937 },
    'oakland': { lat: 37.8044, lng: -122.2712 },
    'bakersfield': { lat: 35.3733, lng: -119.0187 },
    'anaheim': { lat: 33.8366, lng: -117.9143 },
    'chicago': { lat: 41.8781, lng: -87.6298 },
    'phoenix': { lat: 33.4484, lng: -112.0740 },
    'tucson': { lat: 32.2226, lng: -110.9747 },
    'mesa': { lat: 33.4152, lng: -111.8315 },
    'chandler': { lat: 33.3062, lng: -111.8413 },
    'scottsdale': { lat: 33.4942, lng: -111.9261 },
    'philadelphia': { lat: 39.9526, lng: -75.1652 },
    'pittsburgh': { lat: 40.4406, lng: -79.9959 },
    'miami': { lat: 25.7617, lng: -80.1918 },
    'orlando': { lat: 28.5383, lng: -81.3792 },
    'tampa': { lat: 27.9506, lng: -82.4572 },
    'jacksonville': { lat: 30.3322, lng: -81.6557 },
    'st. petersburg': { lat: 27.7676, lng: -82.6403 },
    'fort lauderdale': { lat: 26.1224, lng: -80.1373 },
    'atlanta': { lat: 33.7490, lng: -84.3880 },
    'seattle': { lat: 47.6062, lng: -122.3321 },
    'spokane': { lat: 47.6588, lng: -117.4260 },
    'tacoma': { lat: 47.2529, lng: -122.4443 },
    'denver': { lat: 39.7392, lng: -104.9903 },
    'colorado springs': { lat: 38.8339, lng: -104.8214 },
    'aurora': { lat: 39.7294, lng: -104.8319 },
    'boston': { lat: 42.3601, lng: -71.0589 },
    'las vegas': { lat: 36.1699, lng: -115.1398 },
    'henderson': { lat: 36.0395, lng: -114.9817 },
    'reno': { lat: 39.5296, lng: -119.8138 },
    'portland': { lat: 45.5152, lng: -122.6784 },
    'charlotte': { lat: 35.2271, lng: -80.8431 },
    'raleigh': { lat: 35.7796, lng: -78.6382 },
    'greensboro': { lat: 36.0726, lng: -79.7920 },
    'durham': { lat: 35.9940, lng: -78.8986 },
    'nashville': { lat: 36.1627, lng: -86.7816 },
    'memphis': { lat: 35.1495, lng: -90.0490 },
    'knoxville': { lat: 35.9606, lng: -83.9207 },
    'indianapolis': { lat: 39.7684, lng: -86.1581 },
    'detroit': { lat: 42.3314, lng: -83.0458 },
    'columbus': { lat: 39.9612, lng: -82.9988 },
    'cleveland': { lat: 41.4993, lng: -81.6944 },
    'cincinnati': { lat: 39.1031, lng: -84.5120 },
    'kansas city': { lat: 39.0997, lng: -94.5786 },
    'st. louis': { lat: 38.6270, lng: -90.1994 },
    'minneapolis': { lat: 44.9778, lng: -93.2650 },
    'saint paul': { lat: 44.9537, lng: -93.0900 },
    'milwaukee': { lat: 43.0389, lng: -87.9065 },
    'baltimore': { lat: 39.2904, lng: -76.6122 },
    'washington': { lat: 38.9072, lng: -77.0369 },
    'dc': { lat: 38.9072, lng: -77.0369 },
    'virginia beach': { lat: 36.8529, lng: -75.9780 },
    'louisville': { lat: 38.2527, lng: -85.7585 },
    'new orleans': { lat: 29.9511, lng: -90.0715 },
    'oklahoma city': { lat: 35.4676, lng: -97.5164 },
    'tulsa': { lat: 36.1540, lng: -95.9928 },
    'albuquerque': { lat: 35.0844, lng: -106.6504 },
    'omaha': { lat: 41.2565, lng: -95.9345 },
    'salt lake city': { lat: 40.7608, lng: -111.8910 },
    'boise': { lat: 43.6150, lng: -116.2023 },
    'honolulu': { lat: 21.3069, lng: -157.8583 },
    'london': { lat: 51.5074, lng: -0.1278 },
    'manchester': { lat: 53.4808, lng: -2.2426 },
    'birmingham': { lat: 52.4862, lng: -1.8904 },
    'leeds': { lat: 53.8008, lng: -1.5491 },
    'glasgow': { lat: 55.8642, lng: -4.2518 },
    'toronto': { lat: 43.6532, lng: -79.3832 },
    'vancouver': { lat: 49.2827, lng: -123.1207 },
    'montreal': { lat: 45.5017, lng: -73.5673 },
    'calgary': { lat: 51.0447, lng: -114.0719 },
    'sydney': { lat: -33.8688, lng: 151.2093 },
    'melbourne': { lat: -37.8136, lng: 144.9631 },
    'brisbane': { lat: -27.4698, lng: 153.0251 },
  };

  for (const [city, coords] of Object.entries(CITIES)) {
    if (geoLower.includes(city)) return coords;
  }

  // State code fallbacks (US)
  const STATES = {
    'tx': { lat: 31.9686, lng: -99.9018 },
    'ca': { lat: 36.7783, lng: -119.4179 },
    'fl': { lat: 27.6648, lng: -81.5158 },
    'ny': { lat: 40.7128, lng: -74.0060 },
    'il': { lat: 40.6331, lng: -89.3985 },
    'pa': { lat: 41.2033, lng: -77.1945 },
    'oh': { lat: 40.4173, lng: -82.9071 },
    'ga': { lat: 32.1656, lng: -82.9001 },
    'nc': { lat: 35.7596, lng: -79.0193 },
    'mi': { lat: 44.3148, lng: -85.6024 },
    'wa': { lat: 47.7511, lng: -120.7401 },
    'co': { lat: 39.5501, lng: -105.7821 },
    'az': { lat: 34.0489, lng: -111.0937 },
    'ma': { lat: 42.4072, lng: -71.3824 },
    'tn': { lat: 35.5175, lng: -86.5804 },
  };
  for (const [st, coords] of Object.entries(STATES)) {
    if (new RegExp(`\\b${st}\\b`, 'i').test(geoLower)) return coords;
  }

  return { lat: 39.8283, lng: -98.5795 }; // US geographical center
}

// ══════════════════════════════════════════════════════════════
//  GEOGRAPHIC GRID TILING (DEEP CITY SCAN)
// ══════════════════════════════════════════════════════════════

/**
 * Generate multi-quadrant geographic coordinates for deep city-wide scanning.
 * Tiles across downtown and cardinal suburban quadrants (Center, North, South, East, West).
 * @param {string} geography - Target location
 * @param {number} [gridSize=5] - 1 for center only, 5 for cardinal grid, 9 for 3x3 matrix
 * @returns {{ name: string, lat: number, lng: number }[]}
 */
export function getGeoGridCoordinates(geography = '', gridSize = 5) {
  const center = getCityCoordinates(geography);
  if (gridSize <= 1) return [{ name: 'center', lat: center.lat, lng: center.lng }];

  // Metropolitan delta offset (~8-10 km radius)
  const deltaLat = 0.075;
  const deltaLng = 0.095;

  const grid = [
    { name: 'center', lat: center.lat, lng: center.lng },
    { name: 'north', lat: +(center.lat + deltaLat).toFixed(4), lng: center.lng },
    { name: 'south', lat: +(center.lat - deltaLat).toFixed(4), lng: center.lng },
    { name: 'east', lat: center.lat, lng: +(center.lng + deltaLng).toFixed(4) },
    { name: 'west', lat: center.lat, lng: +(center.lng - deltaLng).toFixed(4) },
  ];

  if (gridSize >= 9) {
    grid.push(
      { name: 'northeast', lat: +(center.lat + deltaLat * 0.7).toFixed(4), lng: +(center.lng + deltaLng * 0.7).toFixed(4) },
      { name: 'northwest', lat: +(center.lat + deltaLat * 0.7).toFixed(4), lng: +(center.lng - deltaLng * 0.7).toFixed(4) },
      { name: 'southeast', lat: +(center.lat - deltaLat * 0.7).toFixed(4), lng: +(center.lng + deltaLng * 0.7).toFixed(4) },
      { name: 'southwest', lat: +(center.lat - deltaLat * 0.7).toFixed(4), lng: +(center.lng - deltaLng * 0.7).toFixed(4) },
    );
  }

  return grid.slice(0, gridSize);
}

// ══════════════════════════════════════════════════════════════
//  BROWSER EMULATION & ANTI-THROTTLING HEADERS
// ══════════════════════════════════════════════════════════════

export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
];

export function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export function getEmulatedHeaders() {
  const ua = getRandomUserAgent();
  const headers = {
    'User-Agent': ua,
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': '*/*',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };
  if (ua.includes('Chrome')) {
    headers['sec-ch-ua'] = '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    headers['sec-fetch-dest'] = 'empty';
    headers['sec-fetch-mode'] = 'cors';
    headers['sec-fetch-site'] = 'same-origin';
  }
  return headers;
}

export const delayJitter = (min = 250, max = 450) =>
  new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));

// ══════════════════════════════════════════════════════════════
//  CANONICAL SOCIAL & BUSINESS URL NORMALIZERS
// ══════════════════════════════════════════════════════════════

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

export function cleanInstagramUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    let clean = url.trim();
    if (clean.startsWith('//')) clean = `https:${clean}`;
    if (!clean.startsWith('http')) clean = `https://${clean}`;
    const u = new URL(clean);
    if (!u.hostname.includes('instagram.com')) return null;
    const path = u.pathname.replace(/\/+$/, '');
    const forbidden = ['/p', '/reel', '/reels', '/stories', '/explore', '/accounts', '/direct', '/about'];
    if (forbidden.some(f => path.toLowerCase().startsWith(f))) return null;
    if (path.length <= 1) return null;
    return `https://www.instagram.com${path}`;
  } catch {
    return null;
  }
}

export function cleanLinkedinUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    let clean = url.trim();
    if (clean.startsWith('//')) clean = `https:${clean}`;
    if (!clean.startsWith('http')) clean = `https://${clean}`;
    const u = new URL(clean);
    if (!u.hostname.includes('linkedin.com')) return null;
    const path = u.pathname.replace(/\/+$/, '');
    if (['/share', '/sharing', '/login', '/signup', '/feed'].some(f => path.toLowerCase().startsWith(f))) return null;
    if (path.length <= 1) return null;
    return `https://www.linkedin.com${path}`;
  } catch {
    return null;
  }
}

export function cleanTwitterUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    let clean = url.trim();
    if (clean.startsWith('//')) clean = `https:${clean}`;
    if (!clean.startsWith('http')) clean = `https://${clean}`;
    const u = new URL(clean);
    if (!u.hostname.includes('twitter.com') && !u.hostname.includes('x.com')) return null;
    const path = u.pathname.replace(/\/+$/, '');
    if (['/intent', '/share', '/home', '/login', '/search'].some(f => path.toLowerCase().startsWith(f))) return null;
    if (path.length <= 1) return null;
    return `https://x.com${path}`;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//  PROTOBUF RICH METADATA MINING HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Extracts direct appointment or booking links from protobuf field d[75].
 * Strips tracking parameters (UTM, rwg_token, opi).
 * @param {Array} d - Business protobuf node
 * @returns {string|null}
 */
export function extractBookingUrl(d) {
  if (!d || !d[75]) return null;
  let bookingUrl = null;
  function findUrl(obj) {
    if (bookingUrl) return;
    if (typeof obj === 'string') {
      if ((obj.startsWith('http://') || obj.startsWith('https://')) &&
          !obj.includes('google.com') &&
          !obj.includes('googleusercontent.com') &&
          !obj.includes('/url?') &&
          !/\.(png|jpg|jpeg|gif|webp|svg)($|\?)/i.test(obj)) {
        bookingUrl = obj;
        return;
      }
    } else if (Array.isArray(obj)) {
      obj.forEach(findUrl);
    }
  }
  findUrl(d[75]);
  if (bookingUrl) {
    try {
      const u = new URL(bookingUrl);
      u.searchParams.delete('utm_source');
      u.searchParams.delete('utm_medium');
      u.searchParams.delete('utm_campaign');
      u.searchParams.delete('utm_content');
      u.searchParams.delete('opi');
      u.searchParams.delete('rwg_token');
      return u.toString();
    } catch {
      return bookingUrl;
    }
  }
  return null;
}

/**
 * Extracts high-res cover thumbnail from d[157] or d[72].
 * @param {Array} d - Business protobuf node
 * @returns {string|null}
 */
export function extractPhotoUrl(d) {
  if (!d) return null;
  const raw = d[157] || d[72]?.[0]?.[1]?.[6]?.[0] || null;
  if (!raw || typeof raw !== 'string' || !raw.startsWith('http')) return null;
  // Upgrade thumbnail size from low-res (e.g. s44) to high-res (s400)
  return raw.replace(/\/s\d+[^/]*\//, '/s400/');
}

/**
 * Extracts price level tier ($, $$, $$$, $$$$) from d[4][2].
 * @param {Array} d
 * @returns {string|null}
 */
export function extractPriceLevel(d) {
  if (!d || !d[4]) return null;
  const raw = d[4][2];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') {
    if (raw === 1) return '$';
    if (raw === 2) return '$$';
    if (raw === 3) return '$$$';
    if (raw === 4) return '$$$$';
  }
  return null;
}

/**
 * Checks if a business is permanently closed via d[34] or recursive scan.
 * @param {Array} d
 * @returns {boolean}
 */
export function isPermanentlyClosed(d) {
  if (!d) return false;
  if (d[34]?.[0] === 2 || (typeof d[34]?.[1] === 'string' && /permanently closed/i.test(d[34][1]))) {
    return true;
  }
  let closed = false;
  function checkClosed(obj) {
    if (closed) return;
    if (typeof obj === 'string' && /permanently closed|permanently_closed/i.test(obj)) {
      closed = true;
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) checkClosed(item);
    }
  }
  checkClosed(d);
  return closed;
}

/**
 * Extracts operating hours or status text from d[203] or d[34].
 * @param {Array} d
 * @returns {string|null}
 */
export function extractHoursStatus(d) {
  if (!d) return null;
  if (isPermanentlyClosed(d)) return 'Permanently closed';
  if (d[203]) {
    const candidate = d[203]?.[1]?.[4]?.[0] || d[203]?.[1]?.[5]?.[0] || d[203]?.[1]?.[8]?.[0] || null;
    if (typeof candidate === 'string') return candidate;
  }
  if (d[34]?.[1] && typeof d[34][1] === 'string') return d[34][1];
  return null;
}

/**
 * Native Node.js Google Maps scraper with multi-quadrant Geographic Grid Tiling,
 * high-precision Protobuf parsing, rich business mining (booking, photos, price, hours),
 * anti-throttling emulation, and closed-business filtering.
 * @param {string} query - Search query (e.g. "dentists in Austin TX")
 * @param {object} [options]
 * @param {number} [options.limit=25] - Maximum leads to return
 * @param {boolean} [options.deepScan] - Multi-quadrant deep city grid scan (auto-enabled for limit > 20)
 * @param {boolean} [options.filterClosed=true] - Filter out permanently closed businesses
 * @param {number} [options.gridSize=5] - Number of geographic grid quadrants (1, 5, or 9)
 * @returns {Promise<object[]>} Array of raw lead objects
 */
export async function scrapeGoogleMapsNative(query, options = {}) {
  throw new Error(GOOGLE_MAPS_SCRAPER_DISABLED);

  // Retained below as historical parsing/reference code; network collection is disabled.
  const limit = options.limit || 25;
  const filterClosed = options.filterClosed !== false;
  const isDeep = options.deepScan === true || limit > 20;
  const gridSize = options.gridSize || (isDeep ? 5 : 1);

  console.log(`\n🔍 Running Enterprise Google Maps scraper for: "${query}" (Limit: ${limit}, DeepScan: ${isDeep ? `${gridSize}-Quadrant Grid` : 'Center'})...`);

  const gridCoords = getGeoGridCoordinates(query, gridSize);
  const leads = [];
  const seenPlaceIds = new Set();
  const seenPhones = new Set();
  const seenDomains = new Set();

  for (let gIdx = 0; gIdx < gridCoords.length; gIdx++) {
    if (leads.length >= limit) break;
    const currentCoords = gridCoords[gIdx];
    const quadrantName = currentCoords.name || `Q${gIdx + 1}`;

    const maxPagesForQuad = Math.min(Math.ceil((limit - leads.length) / 20), 3);

    for (let page = 0; page < maxPagesForQuad; page++) {
      if (leads.length >= limit) break;
      const startIndex = page * 20;

      // Anti-throttling human jitter delay
      if (page > 0 || gIdx > 0) {
        await delayJitter(250, 400);
      }

      const url = `https://www.google.com/search?tbm=map&authuser=0&hl=en&gl=us&pb=!4m12!1m3!1d50000!2d${currentCoords.lng}!3d${currentCoords.lat}!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!7i20!10b1!12m6!2m3!5m1!6e2!20e3!10b1!16b1!19m3!2m2!1i392!2i106!26m4!2m3!1i80!2i92!4o2!1i${startIndex}!&q=${encodeURIComponent(query)}`;

      let responseText = null;
      let attempt = 0;
      const maxAttempts = 3;

      while (attempt < maxAttempts) {
        attempt++;
        try {
          const res = await fetch(url, {
            headers: getEmulatedHeaders(),
            signal: AbortSignal.timeout(18000),
          });

          if (!res.ok) {
            console.warn(`⚠️ Google Maps responded with HTTP ${res.status} on quadrant ${quadrantName}`);
            break;
          }

          responseText = await res.text();
          break;
        } catch (fetchErr) {
          if (attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, 600 * attempt));
          } else {
            console.warn(`⚠️ Google Maps network notice on ${quadrantName} page ${page}: ${fetchErr.message}`);
          }
        }
      }

      if (!responseText) break;

      const cleanJson = responseText.replace(/^\)\]\}'\n/, '');
      let data = null;
      try {
        data = JSON.parse(cleanJson);
      } catch {
        break;
      }

      const items = data?.[0]?.[1] || [];
      if (!items.length) break;

      for (const item of items) {
        if (leads.length >= limit) break;
        const d = item?.[14];
        if (!d || !d[11]) continue;

        // Skip permanently closed businesses if filter enabled
        if (filterClosed && isPermanentlyClosed(d)) {
          continue;
        }

        const businessName = d[11];
        const placeId = d[78] || d[10] || null;
        if (placeId && seenPlaceIds.has(placeId)) continue;
        if (placeId) seenPlaceIds.add(placeId);

        // 1. Website & Social URL parsing
        let websiteUrl = null;
        let facebookUrl = null;
        let instagramUrl = null;
        let linkedinUrl = null;
        let twitterUrl = null;

        if (d[7]) {
          const rawUrl = d[7][0] || '';
          if (rawUrl.startsWith('/url?') || rawUrl.startsWith('http://www.google.com/url?') || rawUrl.startsWith('https://www.google.com/url?')) {
            try {
              const u = new URL(rawUrl.startsWith('/') ? `https://www.google.com${rawUrl}` : rawUrl);
              const q = u.searchParams.get('q');
              websiteUrl = q || rawUrl;
            } catch {
              websiteUrl = rawUrl;
            }
          } else if (d[7][1]) {
            websiteUrl = `https://${d[7][1]}`;
          } else {
            websiteUrl = rawUrl || null;
          }

          if (websiteUrl) {
            try {
              const u = new URL(websiteUrl);
              u.searchParams.delete('utm_source');
              u.searchParams.delete('utm_medium');
              u.searchParams.delete('utm_campaign');
              u.searchParams.delete('utm_content');
              u.searchParams.delete('opi');
              websiteUrl = u.toString();
            } catch {}
          }
        }

        if (websiteUrl && (websiteUrl.includes('facebook.com') || websiteUrl.includes('fb.me'))) {
          facebookUrl = cleanFacebookUrl(websiteUrl);
          websiteUrl = null;
        }

        // Deep recursive social scan in protobuf node
        function scanDForSocials(obj) {
          if (typeof obj === 'string') {
            if (!facebookUrl && (obj.includes('facebook.com/') || obj.includes('fb.me/'))) {
              const clean = cleanFacebookUrl(obj);
              if (clean) facebookUrl = clean;
            }
            if (!instagramUrl && obj.includes('instagram.com/')) {
              const clean = cleanInstagramUrl(obj);
              if (clean) instagramUrl = clean;
            }
            if (!linkedinUrl && obj.includes('linkedin.com/')) {
              const clean = cleanLinkedinUrl(obj);
              if (clean) linkedinUrl = clean;
            }
            if (!twitterUrl && (obj.includes('twitter.com/') || obj.includes('x.com/'))) {
              const clean = cleanTwitterUrl(obj);
              if (clean) twitterUrl = clean;
            }
          } else if (Array.isArray(obj)) {
            obj.forEach(scanDForSocials);
          }
        }
        scanDForSocials(d);

        // 2. Category & Address parsing
        const category = d[13] ? d[13][0] : null;
        const address = d[18] || (d[2] ? d[2].join(', ') : null);
        const addressParts = parseAddress(address || '');
        const city = d[82]?.[3] || addressParts.city || null;
        const state = addressParts.state || null;
        const country = d[243] || addressParts.country || 'US';

        // 3. Ratings & Reviews
        const rating = d[4]?.[7] ? parseFloat(d[4][7]) : null;
        let reviews = d[4]?.[8] ? parseInt(d[4][8]) : null;
        if (!reviews && d[4]?.[3]?.[1] && typeof d[4][3][1] === 'string') {
          const revMatch = d[4][3][1].match(/(\d+[\d,]*)/);
          if (revMatch) reviews = parseInt(revMatch[1].replace(/,/g, ''));
        }

        // 4. Coordinates
        const lat = d[9] ? parseFloat(d[9][2]) : null;
        const lng = d[9] ? parseFloat(d[9][3]) : null;

        // 5. Phone number: protobuf field d[178] first, fallback to regex
        let phone = null;
        if (d[178] && Array.isArray(d[178]) && d[178][0]) {
          phone = d[178][0][0] || d[178][0][3] || null;
        }

        if (!phone) {
          function findPhone(obj) {
            if (phone) return;
            if (typeof obj === 'string') {
              const m = obj.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
              if (m && !m[0].includes('000-000') && !m[0].includes('118472')) {
                phone = m[0];
              }
            } else if (Array.isArray(obj)) {
              obj.forEach(findPhone);
            }
          }
          findPhone(d);
        }

        // Dedup checks by phone or domain across quadrants
        if (phone) {
          const normPhone = phone.replace(/\D/g, '').slice(-10);
          if (normPhone.length >= 10) {
            if (seenPhones.has(normPhone)) continue;
            seenPhones.add(normPhone);
          }
        }
        if (websiteUrl) {
          try {
            const domain = new URL(websiteUrl).hostname.replace(/^www\./, '').toLowerCase();
            if (domain && domain.length > 3) {
              if (seenDomains.has(domain)) continue;
              seenDomains.add(domain);
            }
          } catch {}
        }

        // 6. Protobuf rich fields
        const bookingUrl = extractBookingUrl(d);
        const photoUrl = extractPhotoUrl(d);
        const priceLevel = extractPriceLevel(d);
        const hoursStatus = extractHoursStatus(d);

        leads.push({
          business_name: businessName,
          category: category || null,
          address: address || null,
          city,
          state,
          country,
          phone: phone || null,
          website_url: websiteUrl || null,
          facebook_url: facebookUrl || null,
          instagram_url: instagramUrl || null,
          linkedin_url: linkedinUrl || null,
          twitter_url: twitterUrl || null,
          booking_url: bookingUrl || null,
          photo_url: photoUrl || null,
          price_level: priceLevel || null,
          hours_status: hoursStatus || null,
          email: null,
          source: 'google_maps',
          rating: isNaN(rating) ? null : rating,
          reviews: isNaN(reviews) ? null : reviews,
          latitude: isNaN(lat) ? null : lat,
          longitude: isNaN(lng) ? null : lng,
          place_id: placeId || null,
          _extra_emails: [],
          _raw: { source: 'google_maps_native', query, quadrant: quadrantName },
        });
      }
    }
  }

  console.log(`✅ Native Google Maps scraper extracted ${leads.length} leads.`);
  return leads;
}

/**
 * Run the Google Maps scraper (Docker if available, otherwise native fallback).
 * @param {string} queryFilePath - Path to the query file
 * @param {object} [options]
 * @param {number} [options.depth=1] - Scraping depth
 * @param {number} [options.concurrency=2] - Number of concurrent scrapers
 * @param {string} [options.exitOnInactivity='3m'] - Timeout for inactivity
 * @param {boolean} [options.extractEmails=true] - Extract emails from websites
 * @param {number} [options.limit=25] - Max leads
 * @returns {Promise<object[]>} Array of raw lead objects
 */
export async function runScraper(queryFilePath, options = {}) {
  throw new Error(GOOGLE_MAPS_SCRAPER_DISABLED);

  // Legacy Docker/native runner retained for reference; never execute it implicitly.
  const {
    depth = 1,
    concurrency = 2,
    exitOnInactivity = '3m',
    extractEmails = true,
    limit = 25,
  } = options;

  const resultsFilename = `results_${Date.now()}.csv`;
  const resultsPath = path.join(DATA_DIR, resultsFilename);

  // Check Docker availability first
  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    console.log('⚡ Docker is not active. Running Multi-Query Native Google Maps Scraper...');
    let queries = [];
    if (fs.existsSync(queryFilePath)) {
      queries = fs.readFileSync(queryFilePath, 'utf-8').split('\n').map(q => q.trim()).filter(Boolean);
    }
    if (queries.length === 0) {
      queries = [path.basename(queryFilePath, '.txt').replace(/_/g, ' ')];
    }

    const aggregated = [];
    const seen = new Set();

    for (const q of queries) {
      if (aggregated.length >= limit) break;
      const batchLimit = Math.max(10, limit - aggregated.length);
      const queryResults = await scrapeGoogleMapsNative(q, { limit: batchLimit });
      for (const lead of queryResults) {
        const key = lead.place_id || `${lead.business_name.toLowerCase()}:${lead.phone || lead.website_url || ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          aggregated.push(lead);
        }
      }
    }

    console.log(`🎯 Multi-query native scraper gathered ${aggregated.length} unique leads across ${queries.length} queries.`);
    return aggregated;
  }

  // Create empty results file (Docker needs it to exist)
  fs.writeFileSync(resultsPath, '', 'utf-8');

  // Convert Windows paths to Docker-compatible paths
  const dockerQueryPath = queryFilePath.replace(/\\/g, '/');
  const dockerResultsPath = resultsPath.replace(/\\/g, '/');

  const emailFlag = extractEmails ? '-email' : '';

  const cmd = [
    'docker run --rm',
    `-v "${dockerQueryPath}:/queries.txt"`,
    `-v "${dockerResultsPath}:/results.csv"`,
    'gosom/google-maps-scraper',
    '-input /queries.txt',
    '-results /results.csv',
    `-depth ${depth}`,
    `-c ${concurrency}`,
    `-exit-on-inactivity ${exitOnInactivity}`,
    emailFlag,
  ].filter(Boolean).join(' ');

  console.log(`\n🔍 Running Google Maps scraper via Docker...`);
  console.log(`   Queries: ${queryFilePath}`);
  console.log(`   Output:  ${resultsPath}`);
  console.log(`   Command: ${cmd}\n`);

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 600000, // 10 minute timeout
      maxBuffer: 50 * 1024 * 1024, // 50 MB buffer
    });

    if (stderr) {
      console.log(`⚠️  Scraper stderr: ${stderr.slice(0, 500)}`);
    }
    if (stdout) {
      console.log(`📝 Scraper output: ${stdout.slice(0, 500)}`);
    }
  } catch (error) {
    console.warn(`\n⚠️ Docker scraper encountered an issue: ${error.message}`);
    console.log(`⚡ Falling back to Multi-Query Native Google Maps Scraper...`);
    let queries = [];
    if (fs.existsSync(queryFilePath)) {
      queries = fs.readFileSync(queryFilePath, 'utf-8').split('\n').map(q => q.trim()).filter(Boolean);
    }
    if (queries.length === 0) {
      queries = [path.basename(queryFilePath, '.txt').replace(/_/g, ' ')];
    }
    const aggregated = [];
    const seen = new Set();
    for (const q of queries) {
      if (aggregated.length >= limit) break;
      const res = await scrapeGoogleMapsNative(q, { limit: limit - aggregated.length });
      for (const lead of res) {
        const key = lead.place_id || `${lead.business_name.toLowerCase()}:${lead.phone || lead.website_url || ''}`;
        if (!seen.has(key)) { seen.add(key); aggregated.push(lead); }
      }
    }
    return aggregated;
  }

  // Parse results CSV
  return parseScraperResults(resultsPath);
}

/**
 * Parse the scraper's CSV output into structured lead objects.
 * @param {string} csvPath - Path to the CSV file
 * @returns {object[]} Array of lead objects
 */
export function parseScraperResults(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.log(`⚠️  Results file not found: ${csvPath}`);
    return [];
  }

  const csvContent = fs.readFileSync(csvPath, 'utf-8').trim();
  if (!csvContent) {
    console.log(`⚠️  Results file is empty: ${csvPath}`);
    return [];
  }

  try {
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });

    return records.map(mapScraperRecord);
  } catch (error) {
    console.error(`❌ Failed to parse CSV: ${error.message}`);
    return [];
  }
}

/**
 * Map a raw scraper CSV record to our lead schema.
 * The google-maps-scraper outputs these columns:
 *   title, category, address, open_hours, popular_times, website, phone,
 *   plus_code, review_count, review_rating, reviews_per_score, latitude,
 *   longitude, cid, status, descriptions, reviews_link, thumbnail,
 *   timezone, price_range, data_id, images, reservations, order_online,
 *   menu, owner, complete_address, about, user_reviews, emails
 */
function mapScraperRecord(record) {
  // Parse address components
  const addressParts = parseAddress(record.complete_address || record.address || '');

  // Parse emails — scraper may return comma-separated list
  const emails = [];
  if (record.emails) {
    emails.push(...record.emails.split(',').map(e => e.trim()).filter(Boolean));
  }

  return {
    business_name: record.title || record.name || 'Unknown',
    category: record.category || null,
    address: record.complete_address || record.address || null,
    city: addressParts.city || null,
    state: addressParts.state || null,
    country: addressParts.country || null,
    phone: record.phone || null,
    website_url: record.website || null,
    facebook_url: null, // Extracted in enrichment step
    email: emails[0] || null, // Primary email
    source: 'google_maps',
    rating: parseFloat(record.review_rating) || null,
    reviews: parseInt(record.review_count) || null,
    latitude: parseFloat(record.latitude) || null,
    longitude: parseFloat(record.longitude) || null,
    place_id: record.cid || record.data_id || null,
    _extra_emails: emails.slice(1), // Additional emails → lead_emails table
    _raw: record, // Keep raw data for debugging
  };
}

/**
 * Address parser to extract city/state/country accurately.
 * Handles both Google Maps formats:
 * - "Street, City, ST 12345"
 * - "Street, City, ST 12345, USA"
 */
export function parseAddress(address) {
  if (!address) return {};

  const parts = address.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return {};

  let city = null;
  let state = null;
  let country = 'US';

  const last = parts[parts.length - 1];
  if (/^(usa|us|united states|uk|united kingdom|canada|australia)$/i.test(last)) {
    country = last.toUpperCase();
    if (parts.length >= 3) {
      const stateZip = parts[parts.length - 2];
      const match = stateZip.match(/([a-zA-Z]{2,})\s*(\d{5}(?:-\d{4})?)?/);
      if (match) state = match[1].toUpperCase();
      city = parts[parts.length - 3];
    } else if (parts.length === 2) {
      city = parts[0];
    }
  } else {
    // Standard Google Maps format: "Street, City, ST 12345"
    const match = last.match(/([a-zA-Z]{2,})\s*(\d{5}(?:-\d{4})?)?/);
    if (match) {
      state = match[1].toUpperCase();
      country = 'US';
      city = parts[parts.length - 2] || null;
    } else if (parts.length >= 2) {
      city = parts[parts.length - 2] || parts[0];
    } else {
      city = parts[0] || null;
    }
  }

  return {
    city: city ? city.trim() : null,
    state: state ? state.trim() : null,
    country: country ? country.trim() : 'US',
  };
}

/**
 * Pull the Docker image if not already present.
 */
export async function ensureDockerImage() {
  throw new Error(GOOGLE_MAPS_SCRAPER_DISABLED);

  // Docker image management is intentionally not an implicit discovery side effect.
  try {
    console.log('📦 Checking for Google Maps scraper Docker image...');
    await execAsync('docker image inspect gosom/google-maps-scraper', { timeout: 15000 });
    console.log('✅ Docker image already present.');
    return true;
  } catch {
    try {
      console.log('⬇️  Pulling gosom/google-maps-scraper image...');
      await execAsync('docker pull gosom/google-maps-scraper', { timeout: 300000 });
      console.log('✅ Docker image pulled successfully.');
      return true;
    } catch (error) {
      console.error(`❌ Failed to pull Docker image: ${error.message}`);
      return false;
    }
  }
}

/**
 * Check if Docker is available and running.
 */
export async function isDockerAvailable() {
  return false;
}

/**
 * Scrape leads via Web Search query permutations (Web SERP).
 * Extracts direct business domains, phone numbers, and snippets without requiring a browser.
 * Falls back gracefully to localized Maps query permutations if search engine is throttled.
 * @param {string} niche - Category
 * @param {string} geography - Location
 * @param {object} [options]
 * @param {number} [options.limit=25]
 * @returns {Promise<object[]>}
 */
export async function scrapeWebQueryLeads(niche, geography, options = {}) {
  throw new Error(SEARCH_SCRAPING_DISABLED);

  // Unofficial SERP scraping is disabled; retain parser logic for an authorized adapter.
  const limit = options.limit || 25;
  console.log(`\n🔍 Running Web Search Query Scraper for: "${niche}" in "${geography}"...`);

  const AGGREGATOR_DOMAINS = new Set([
    'yelp.com', 'yellowpages.com', 'thumbtack.com', 'angi.com', 'bbb.org',
    'tripadvisor.com', 'mapquest.com', 'expertise.com', 'facebook.com',
    'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com',
    'wikipedia.org', 'indeed.com', 'glassdoor.com', 'consumeraffairs.com',
    'webmd.com', 'zocdoc.com', 'reddit.com'
  ]);

  const searchQueries = [
    `${niche} in ${geography}`,
    `best ${niche} ${geography}`,
    `commercial ${niche} ${geography}`,
  ];

  const leads = [];
  const seenDomains = new Set();
  const phoneRegex = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

  let cheerioModule = null;
  try {
    cheerioModule = await import('cheerio');
  } catch {}

  for (const q of searchQueries) {
    if (leads.length >= limit) break;
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
      const res = await fetch(url, {
        headers: getEmulatedHeaders(),
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) continue;
      const html = await res.text();
      if (!cheerioModule) continue;
      const $ = cheerioModule.load(html);

      $('.result').each((i, el) => {
        if (leads.length >= limit) return;
        const title = $(el).find('.result__title').text().trim();
        const snippet = $(el).find('.result__snippet').text().trim();
        let link = $(el).find('.result__url').attr('href') || $(el).find('.result__title a').attr('href');
        if (link && link.includes('uddg=')) {
          const match = link.match(/uddg=([^&]+)/);
          if (match) link = decodeURIComponent(match[1]);
        }

        if (!title || !link || link.includes('duckduckgo.com')) return;

        try {
          const parsedUrl = new URL(link);
          const domain = parsedUrl.hostname.replace(/^www\./, '').toLowerCase();
          if (AGGREGATOR_DOMAINS.has(domain)) return;
          if (seenDomains.has(domain)) return;
          seenDomains.add(domain);

          const cleanName = title.split(/[-|–•]/)[0].trim();
          const phoneMatch = snippet.match(phoneRegex);
          const emailMatch = snippet.match(emailRegex);
          const emails = emailMatch ? [emailMatch[0].toLowerCase()] : [];

          leads.push({
            business_name: cleanName || title,
            category: niche,
            address: geography,
            city: geography.split(',')[0].trim(),
            state: geography.split(',')[1]?.trim() || null,
            country: 'US',
            phone: phoneMatch ? phoneMatch[0] : null,
            website_url: `${parsedUrl.protocol}//${parsedUrl.host}`,
            facebook_url: null,
            email: emails[0] || null,
            source: 'web_search_query',
            rating: null,
            reviews: null,
            latitude: null,
            longitude: null,
            place_id: `web_${domain.replace(/[^a-z0-9]/g, '_')}`,
            _extra_emails: emails.slice(1),
            _raw: { source: 'web_search_query', query: q, snippet },
          });
        } catch {}
      });
    } catch (err) {
      console.warn(`⚠️ Web search query "${q}" skipped: ${err.message}`);
    }
  }

  // Graceful fallback: If Web SERP produced 0 results due to network blocks/captcha,
  // harvest via Google Maps search permutations with B2B contractors / company query
  if (leads.length === 0) {
    try {
      console.log(`⚡ SERP query returned 0 leads. Falling back to Google Maps commercial web search...`);
      const fallbackQuery = `best ${niche} contractors in ${geography}`;
      const mapsLeads = await scrapeGoogleMapsNative(fallbackQuery, { limit, deepScan: false });
      for (const lead of mapsLeads) {
        if (leads.length >= limit) break;
        if (lead.website_url) {
          leads.push({
            ...lead,
            source: 'web_search_query',
          });
        }
      }
    } catch {}
  }

  console.log(`✅ Web search query scraper extracted ${leads.length} leads.`);
  return leads;
}

/**
 * Scrape leads with strong Facebook presence.
 * Combines Google Maps discovery of businesses operating with Facebook pages,
 * businesses without standalone websites, and web search for verified Facebook business pages.
 * @param {string} niche - Category
 * @param {string} geography - Location
 * @param {object} [options]
 * @param {number} [options.limit=25]
 * @returns {Promise<object[]>}
 */
export async function scrapeFacebookLeads(niche, geography, options = {}) {
  throw new Error(FACEBOOK_SCRAPING_DISABLED);

  // Use the official Meta connector instead of browser/search-engine scraping.
  const limit = options.limit || 25;
  console.log(`\nⓕ Running Facebook Business Scraper for: "${niche}" in "${geography}"...`);
  const leads = [];
  const seenUrls = new Set();
  const seenPlaceIds = new Set();

  // Step 1: Scrape Google Maps and prioritize businesses with Facebook or without standalone websites
  try {
    const mapsQuery = `${niche} in ${geography}`;
    const mapsLeads = await scrapeGoogleMapsNative(mapsQuery, {
      limit: Math.max(limit * 2, 20),
      deepScan: options.deepScan,
      filterClosed: options.filterClosed,
    });

    const defaultCity = geography.split(',')[0].trim();

    // First priority: Leads with explicit Facebook URLs from Maps
    for (const lead of mapsLeads) {
      if (leads.length >= limit) break;
      if (lead.facebook_url) {
        if (!seenUrls.has(lead.facebook_url)) {
          seenUrls.add(lead.facebook_url);
          if (lead.place_id) seenPlaceIds.add(lead.place_id);
          leads.push({ ...lead, city: lead.city || defaultCity, source: 'facebook' });
        }
      }
    }

    // Second priority: High-converting businesses with no website (prime Facebook / social prospects)
    for (const lead of mapsLeads) {
      if (leads.length >= limit) break;
      if (!lead.website_url && (!lead.place_id || !seenPlaceIds.has(lead.place_id))) {
        if (lead.place_id) seenPlaceIds.add(lead.place_id);
        leads.push({
          ...lead,
          city: lead.city || defaultCity,
          source: 'facebook',
          site_status: 'NO_SITE',
        });
      }
    }
  } catch (err) {
    console.warn(`⚠️ Google Maps Facebook discovery notice: ${err.message}`);
  }

  // Step 2: Web SERP query for Facebook business pages if more leads needed
  if (leads.length < limit) {
    const searchQueries = [
      `"${niche}" in "${geography}" site:facebook.com`,
      `"${niche}" "${geography}" site:facebook.com`,
    ];

    let cheerioModule = null;
    try { cheerioModule = await import('cheerio'); } catch {}

    const phoneRegex = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

    for (const q of searchQueries) {
      if (leads.length >= limit) break;
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
        const res = await fetch(url, {
          headers: getEmulatedHeaders(),
          signal: AbortSignal.timeout(4500),
        });

        if (!res.ok) continue;
        const html = await res.text();
        if (!cheerioModule) continue;
        const $ = cheerioModule.load(html);

        $('.result').each((i, el) => {
          if (leads.length >= limit) return;
          const rawTitle = $(el).find('.result__title').text().trim();
          const snippet = $(el).find('.result__snippet').text().trim();
          let link = $(el).find('.result__url').attr('href') || $(el).find('.result__title a').attr('href');
          if (link && link.includes('uddg=')) {
            const match = link.match(/uddg=([^&]+)/);
            if (match) link = decodeURIComponent(match[1]);
          }

          if (!link || !link.includes('facebook.com')) return;
          const cleanFb = cleanFacebookUrl(link);
          if (!cleanFb || seenUrls.has(cleanFb)) return;
          seenUrls.add(cleanFb);

          let bizName = rawTitle
            .replace(/\s*[-–|•]\s*(?:Home|About|Services|Reviews|Posts|Photos)?\s*\|\s*Facebook.*/i, '')
            .replace(/\s*[-–|•]\s*Facebook.*/i, '')
            .replace(/\s*[-–|•]\s*(?:Dentist|Plumber|Roofer|Lawyer|Doctor|Clinic|Services).*$/i, '')
            .trim();

          if (!bizName || bizName.length < 2) return;

          const phoneMatch = snippet.match(phoneRegex);
          const emailMatch = snippet.match(emailRegex);

          leads.push({
            business_name: bizName,
            category: niche,
            address: geography,
            city: geography.split(',')[0].trim(),
            state: geography.split(',')[1]?.trim() || null,
            country: 'US',
            phone: phoneMatch ? phoneMatch[0] : null,
            website_url: null,
            facebook_url: cleanFb,
            email: emailMatch ? emailMatch[0].toLowerCase() : null,
            source: 'facebook',
            site_status: 'NO_SITE',
            rating: null,
            reviews: null,
            latitude: null,
            longitude: null,
            place_id: `fb_${cleanFb.replace(/[^a-zA-Z0-9]/g, '_')}`,
            _extra_emails: [],
            _raw: { source: 'facebook_search', query: q, snippet },
          });
        });
      } catch (err) {
        // SERP query skipped
      }
    }
  }

  console.log(`✅ Facebook scraper extracted ${leads.length} leads.`);
  return leads;
}

/**
 * Intelligently fuses two lead records from different engines into a unified contact profile.
 * Merges phones, websites, social links, booking URLs, photos, ratings, and extra emails.
 * @param {object} existing - Target lead in aggregate registry
 * @param {object} incoming - New lead from another engine
 * @returns {object} Mutated fused lead
 */
export function fuseLead(existing, incoming) {
  if (!existing || !incoming) return existing || incoming;

  // 1. Business Name: prioritize cleaner, longer non-default name
  if ((!existing.business_name || existing.business_name === 'Unknown') && incoming.business_name) {
    existing.business_name = incoming.business_name;
  }

  // 2. Category & Address
  if (!existing.category && incoming.category) existing.category = incoming.category;
  if (!existing.address && incoming.address) existing.address = incoming.address;
  if (!existing.city && incoming.city) existing.city = incoming.city;
  if (!existing.state && incoming.state) existing.state = incoming.state;
  if (!existing.country && incoming.country) existing.country = incoming.country;

  // 3. Channels: Phone, Website, Facebook, Booking, Socials
  if (!existing.phone && incoming.phone) existing.phone = incoming.phone;
  if (!existing.website_url && incoming.website_url) existing.website_url = incoming.website_url;
  if (!existing.facebook_url && incoming.facebook_url) existing.facebook_url = incoming.facebook_url;
  if (!existing.instagram_url && incoming.instagram_url) existing.instagram_url = incoming.instagram_url;
  if (!existing.linkedin_url && incoming.linkedin_url) existing.linkedin_url = incoming.linkedin_url;
  if (!existing.twitter_url && incoming.twitter_url) existing.twitter_url = incoming.twitter_url;
  if (!existing.booking_url && incoming.booking_url) existing.booking_url = incoming.booking_url;
  if (!existing.photo_url && incoming.photo_url) existing.photo_url = incoming.photo_url;
  if (!existing.price_level && incoming.price_level) existing.price_level = incoming.price_level;
  if (!existing.hours_status && incoming.hours_status) existing.hours_status = incoming.hours_status;

  // 4. Primary Email & Extra Emails
  if (!existing.email && incoming.email) {
    existing.email = incoming.email;
  }
  const allEmails = new Set([
    ...(existing._extra_emails || []),
    ...(incoming._extra_emails || []),
    ...(incoming.email && incoming.email !== existing.email ? [incoming.email] : [])
  ]);
  if (existing.email) allEmails.delete(existing.email);
  existing._extra_emails = Array.from(allEmails);

  // 5. Ratings, Reviews & Coordinates
  if ((existing.rating == null || isNaN(existing.rating)) && incoming.rating != null) {
    existing.rating = incoming.rating;
    existing.reviews = incoming.reviews;
  }
  if ((existing.latitude == null || isNaN(existing.latitude)) && incoming.latitude != null) {
    existing.latitude = incoming.latitude;
    existing.longitude = incoming.longitude;
  }
  if ((!existing.place_id || existing.place_id.startsWith('fb_') || existing.place_id.startsWith('web_')) && incoming.place_id && !incoming.place_id.startsWith('fb_') && !incoming.place_id.startsWith('web_')) {
    existing.place_id = incoming.place_id;
  }

  // 6. Multi-source attribution
  const existingSources = Array.isArray(existing.sources) ? existing.sources : [existing.source || 'google_maps'];
  const incomingSources = Array.isArray(incoming.sources) ? incoming.sources : [incoming.source || 'google_maps'];
  existing.sources = Array.from(new Set([...existingSources, ...incomingSources]));
  if (existing.sources.length > 1) {
    existing.source = 'combined';
  }

  // 7. Site status adjustment
  if (existing.site_status === 'NO_SITE' && existing.website_url) {
    delete existing.site_status;
  }

  return existing;
}

/**
 * Generates match keys across Place ID, domain, phone, Facebook URL, and fuzzy name.
 * @param {object} lead
 * @returns {string[]}
 */
export function getLeadMatchKeys(lead) {
  const keys = [];
  if (lead.place_id && !lead.place_id.startsWith('fb_') && !lead.place_id.startsWith('web_')) {
    keys.push(`pid:${lead.place_id}`);
  }
  if (lead.website_url) {
    try {
      const domain = new URL(lead.website_url).hostname.replace(/^www\./, '').toLowerCase();
      if (domain && domain.length > 3) keys.push(`dom:${domain}`);
    } catch {}
  }
  if (lead.phone) {
    const p = lead.phone.replace(/\D/g, '');
    if (p.length >= 10) keys.push(`ph:${p.slice(-10)}`);
  }
  if (lead.facebook_url) {
    keys.push(`fb:${lead.facebook_url.toLowerCase()}`);
  }
  if (lead.business_name) {
    const normName = lead.business_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normName.length > 3) {
      keys.push(`name:${normName}:${(lead.city || '').toLowerCase()}`);
    }
  }
  return keys;
}

/**
 * Unified enterprise multi-method lead scraper:
 * - 'google_maps': Multi-quadrant Geographic Grid Tiling & Native Maps
 * - 'facebook': Facebook business engine (leads with active FB pages and/or no website)
 * - 'web_search': Web SERP search query scraper with graceful Maps fallback
 * - 'combined': Merges Google Maps, Facebook, and Web Search with Cross-Engine Lead Fusion!
 * @param {object} config
 * @param {string} config.niche - Category
 * @param {string} config.geography - Location
 * @param {string} [config.method='combined'] - 'combined' | 'google_maps' | 'facebook' | 'web_search'
 * @param {number} [config.limit=25] - Target count
 * @param {object} [config.options] - Extra scraper options (deepScan, filterClosed, gridSize)
 * @returns {Promise<object[]>} Deduplicated and fused array of lead objects
 */
export async function scrapeLeadsMultiMethod(config) {
  const method = config?.method || 'combined';
  if (method === 'facebook') throw new Error(FACEBOOK_SCRAPING_DISABLED);
  if (method === 'web_search') throw new Error(SEARCH_SCRAPING_DISABLED);
  throw new Error(GOOGLE_MAPS_SCRAPER_DISABLED);

  // The legacy aggregator has no authorized provider adapter.
  const { niche, geography, limit = 25, options = {} } = config;
  const targetLimit = limit || 25;
  const aggregated = [];
  const leadRegistry = new Map();

  function addOrMergeLead(lead) {
    const keys = getLeadMatchKeys(lead);
    let matchedLead = null;
    for (const k of keys) {
      if (leadRegistry.has(k)) {
        matchedLead = leadRegistry.get(k);
        break;
      }
    }

    if (matchedLead) {
      fuseLead(matchedLead, lead);
      for (const k of keys) {
        leadRegistry.set(k, matchedLead);
      }
      return matchedLead;
    }

    if (aggregated.length >= targetLimit) return null;

    aggregated.push(lead);
    for (const k of keys) {
      leadRegistry.set(k, lead);
    }
    return lead;
  }

  // 1. Google Maps method
  if (method === 'google_maps' || method === 'combined') {
    const queryFile = generateQueryFile(niche, geography, options);
    const mapsLeads = await runScraper(queryFile, { limit: targetLimit, ...options });
    for (const lead of mapsLeads) {
      addOrMergeLead(lead);
    }
  }

  // 2. Facebook Engine method
  if ((method === 'facebook' || method === 'combined') && aggregated.length < targetLimit) {
    const remaining = targetLimit - aggregated.length;
    const fbLeads = await scrapeFacebookLeads(niche, geography, { limit: remaining, ...options });
    for (const lead of fbLeads) {
      addOrMergeLead(lead);
    }
  }

  // 3. Web Search Query method
  if ((method === 'web_search' || method === 'combined') && aggregated.length < targetLimit) {
    const remaining = targetLimit - aggregated.length;
    const webLeads = await scrapeWebQueryLeads(niche, geography, { limit: remaining, ...options });
    for (const lead of webLeads) {
      addOrMergeLead(lead);
    }
  }

  console.log(`🎯 Multi-method scraper (${method}) gathered ${aggregated.length} total unique leads (Fused across all engines).`);
  return aggregated;
}
