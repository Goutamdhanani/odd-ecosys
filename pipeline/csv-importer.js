// ============================================================
//  ODD-ECOSYS Pipeline — CSV Lead Importer
//  Parses CSV files into the lead schema
//  Supports google-maps-scraper output + custom formats
// ============================================================

import fs from 'fs';
import { parse } from 'csv-parse/sync';

/**
 * Column mapping profiles for different CSV formats.
 */
const COLUMN_MAPS = {
  // google-maps-scraper output format
  'google-maps-scraper': {
    business_name: ['title', 'name', 'business_name'],
    category:      ['category', 'type', 'business_type'],
    address:       ['complete_address', 'address', 'full_address'],
    phone:         ['phone', 'phone_number', 'telephone'],
    website_url:   ['website', 'website_url', 'url', 'site'],
    email:         ['emails', 'email', 'email_address'],
    rating:        ['review_rating', 'rating', 'stars'],
    reviews:       ['review_count', 'reviews', 'num_reviews'],
    latitude:      ['latitude', 'lat'],
    longitude:     ['longitude', 'lng', 'lon'],
    place_id:      ['cid', 'data_id', 'place_id', 'google_id'],
  },

  // Generic / manual format
  'generic': {
    business_name: ['business_name', 'company', 'name', 'business', 'company_name'],
    category:      ['category', 'industry', 'type', 'niche'],
    address:       ['address', 'full_address', 'street_address'],
    city:          ['city', 'town', 'locality'],
    state:         ['state', 'region', 'province', 'county'],
    country:       ['country', 'nation'],
    phone:         ['phone', 'phone_number', 'telephone', 'tel', 'mobile'],
    website_url:   ['website', 'website_url', 'url', 'site', 'web'],
    facebook_url:  ['facebook', 'facebook_url', 'fb', 'fb_url', 'facebook_page'],
    email:         ['email', 'email_address', 'contact_email', 'emails'],
    rating:        ['rating', 'stars', 'review_rating', 'score'],
    reviews:       ['reviews', 'review_count', 'num_reviews', 'review_num'],
  },
};

/**
 * Import leads from a CSV file.
 * @param {string} csvPath - Path to the CSV file
 * @param {object} [options]
 * @param {string} [options.format='auto'] - CSV format: 'google-maps-scraper' | 'generic' | 'auto'
 * @param {object} [options.defaults] - Default values for missing fields
 * @param {object} [options.columnMap] - Custom column mapping overrides
 * @returns {{ leads: object[], errors: string[], stats: object }}
 */
export function importFromCsv(csvPath, options = {}) {
  const { format = 'auto', defaults = {}, columnMap = {} } = options;

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  const csvContent = fs.readFileSync(csvPath, 'utf-8').trim();
  if (!csvContent) {
    return { leads: [], errors: ['CSV file is empty'], stats: { total: 0, valid: 0, invalid: 0 } };
  }

  let records;
  try {
    records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      bom: true, // Handle BOM
    });
  } catch (error) {
    return { leads: [], errors: [`CSV parse error: ${error.message}`], stats: { total: 0, valid: 0, invalid: 0 } };
  }

  if (records.length === 0) {
    return { leads: [], errors: ['No records found in CSV'], stats: { total: 0, valid: 0, invalid: 0 } };
  }

  // Detect format if auto
  const detectedFormat = format === 'auto' ? detectFormat(Object.keys(records[0])) : format;
  const map = { ...COLUMN_MAPS[detectedFormat] || COLUMN_MAPS['generic'], ...columnMap };

  console.log(`📄 Importing ${records.length} records from CSV (format: ${detectedFormat})`);

  const leads = [];
  const errors = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    try {
      const lead = mapRecord(record, map, defaults);

      // Validate: must have a business name at minimum
      if (!lead.business_name || lead.business_name === 'Unknown') {
        errors.push(`Row ${i + 2}: Missing business name`);
        continue;
      }

      lead.source = lead.source || 'csv_import';
      leads.push(lead);
    } catch (error) {
      errors.push(`Row ${i + 2}: ${error.message}`);
    }
  }

  return {
    leads,
    errors,
    stats: {
      total: records.length,
      valid: leads.length,
      invalid: records.length - leads.length,
    },
  };
}

/**
 * Detect CSV format based on column headers.
 */
function detectFormat(headers) {
  const lowerHeaders = headers.map(h => h.toLowerCase());

  // google-maps-scraper has distinctive columns
  if (lowerHeaders.includes('title') && lowerHeaders.includes('review_rating')) {
    return 'google-maps-scraper';
  }
  if (lowerHeaders.includes('cid') || lowerHeaders.includes('data_id')) {
    return 'google-maps-scraper';
  }
  if (lowerHeaders.includes('complete_address') || lowerHeaders.includes('plus_code')) {
    return 'google-maps-scraper';
  }

  return 'generic';
}

/**
 * Map a CSV record to our lead schema using the column map.
 */
function mapRecord(record, map, defaults) {
  const lead = { ...defaults };

  for (const [field, possibleColumns] of Object.entries(map)) {
    if (Array.isArray(possibleColumns)) {
      for (const col of possibleColumns) {
        // Case-insensitive column matching
        const matchedKey = Object.keys(record).find(k => k.toLowerCase() === col.toLowerCase());
        if (matchedKey && record[matchedKey]) {
          lead[field] = record[matchedKey].trim();
          break;
        }
      }
    }
  }

  // Parse numeric fields
  if (lead.rating) lead.rating = parseFloat(lead.rating) || null;
  if (lead.reviews) lead.reviews = parseInt(lead.reviews) || null;
  if (lead.latitude) lead.latitude = parseFloat(lead.latitude) || null;
  if (lead.longitude) lead.longitude = parseFloat(lead.longitude) || null;

  // Handle comma-separated emails from scraper
  if (lead.email && lead.email.includes(',')) {
    const emails = lead.email.split(',').map(e => e.trim()).filter(Boolean);
    lead.email = emails[0];
    lead._extra_emails = emails.slice(1);
  }

  // Ensure business_name
  lead.business_name = lead.business_name || 'Unknown';

  return lead;
}

/**
 * Generate a sample CSV template file.
 * @param {string} outputPath
 */
export function generateTemplate(outputPath) {
  const header = 'business_name,category,address,city,state,country,phone,website,email,facebook_url,rating,reviews';
  const sample = 'Acme Dental,Dentist,"123 Main St",Austin,TX,US,(512) 555-0100,acmedental.com,info@acmedental.com,https://facebook.com/acmedental,4.5,120';

  fs.writeFileSync(outputPath, `${header}\n${sample}\n`, 'utf-8');
  console.log(`📝 Template CSV created: ${outputPath}`);
}
