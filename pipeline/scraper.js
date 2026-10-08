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

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUERIES_DIR = path.join(__dirname, 'queries');
const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure directories exist
if (!fs.existsSync(QUERIES_DIR)) fs.mkdirSync(QUERIES_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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
    'dentists': ['dental clinic', 'dental office', 'dental practice'],
    'plumbers': ['plumbing services', 'plumbing company', 'plumber'],
    'roofers': ['roofing company', 'roofing contractor', 'roof repair'],
    'hvac': ['hvac company', 'air conditioning repair', 'heating and cooling'],
    'salons': ['hair salon', 'beauty salon', 'barber shop'],
    'electricians': ['electrical contractor', 'electrical services'],
    'landscapers': ['landscaping company', 'lawn care service'],
    'auto repair': ['auto mechanic', 'car repair shop', 'auto body shop'],
  };

  const variations = nicheVariations[niche.toLowerCase()] || [];
  for (const variant of variations) {
    queries.push(`${variant} in ${geography}`);
  }

  if (options.additionalQueries) {
    queries.push(...options.additionalQueries);
  }

  const filename = `${niche.toLowerCase().replace(/\s+/g, '-')}_${geography.toLowerCase().replace(/\s+/g, '-')}_${Date.now()}.txt`;
  const filepath = path.join(QUERIES_DIR, filename);
  fs.writeFileSync(filepath, queries.join('\n'), 'utf-8');

  return filepath;
}

/**
 * Run the Google Maps scraper via Docker.
 * @param {string} queryFilePath - Path to the query file
 * @param {object} [options]
 * @param {number} [options.depth=1] - Scraping depth
 * @param {number} [options.concurrency=2] - Number of concurrent scrapers
 * @param {string} [options.exitOnInactivity='3m'] - Timeout for inactivity
 * @param {boolean} [options.extractEmails=true] - Extract emails from websites
 * @returns {Promise<object[]>} Array of raw lead objects
 */
export async function runScraper(queryFilePath, options = {}) {
  const {
    depth = 1,
    concurrency = 2,
    exitOnInactivity = '3m',
    extractEmails = true,
  } = options;

  const resultsFilename = `results_${Date.now()}.csv`;
  const resultsPath = path.join(DATA_DIR, resultsFilename);

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

  console.log(`\n🔍 Running Google Maps scraper...`);
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
    // If Docker isn't available or scraper fails, return empty
    console.error(`\n❌ Scraper failed: ${error.message}`);
    console.log(`\n💡 Tip: If Docker isn't running, use CSV import instead:`);
    console.log(`   node pipeline/cli.js import --csv ./data/your-leads.csv\n`);
    return [];
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
 * Simple address parser to extract city/state/country.
 * Handles common US and UK address formats.
 */
function parseAddress(address) {
  if (!address) return {};

  const parts = address.split(',').map(p => p.trim());

  if (parts.length >= 3) {
    // Typical: "123 Main St, Austin, TX 78701, USA"
    const city = parts[parts.length - 3] || null;
    const stateZip = parts[parts.length - 2] || '';
    const country = parts[parts.length - 1] || null;
    const state = stateZip.replace(/\d+/g, '').trim() || null;

    return { city, state, country };
  }

  if (parts.length === 2) {
    return { city: parts[0], state: null, country: parts[1] };
  }

  return { city: parts[0] || null };
}

/**
 * Pull the Docker image if not already present.
 */
export async function ensureDockerImage() {
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
  try {
    await execAsync('docker info', { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}
