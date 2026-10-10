// ============================================================
//  ODD-ECOSYS Pipeline — CSV Lead Importer
//  Parses CSV files into the lead schema
//  Supports google-maps-scraper output + custom formats
// ============================================================

import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { parse as createCsvParser } from 'csv-parse';
import { Readable } from 'node:stream';

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
    source_details: ['source_details', 'lead_source', 'source_notes'],
    source_url:     ['source_url', 'source_reference_url', 'source_page'],
    consent_recorded_at: ['consent_recorded_at', 'consent_evidence_date', 'consent_date'],
    consent_method: ['consent_method', 'consent_channel', 'consent_context'],
    consent_evidence_url: ['consent_evidence_url', 'consent_proof_url', 'consent_url'],
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
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  return parseCsvContent(fs.readFileSync(csvPath, 'utf-8'), options);
}

export function parseCsvContent(csvContent, options = {}) {
  const { format = 'auto', defaults = {}, columnMap = {} } = options;
  if (typeof csvContent !== 'string') throw new TypeError('CSV content must be text.');
  csvContent = csvContent.trim();
  if (!csvContent) {
    return { leads: [], errors: ['CSV file is empty'], rejectedRows: [], stats: { total: 0, valid: 0, invalid: 0 } };
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
    return { leads: [], errors: [`CSV parse error: ${error.message}`], rejectedRows: [], stats: { total: 0, valid: 0, invalid: 0 } };
  }

  if (records.length === 0) {
    return { leads: [], errors: ['No records found in CSV'], rejectedRows: [], stats: { total: 0, valid: 0, invalid: 0 } };
  }

  // Detect format if auto
  const detectedFormat = format === 'auto' ? detectFormat(Object.keys(records[0])) : format;
  const map = { ...COLUMN_MAPS[detectedFormat] || COLUMN_MAPS['generic'], ...columnMap };

  console.log(`📄 Importing ${records.length} records from CSV (format: ${detectedFormat})`);

  const leads = [];
  const errors = [];
  const rejectedRows = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    try {
      const lead = mapRecord(record, map, defaults);
      lead._row_number = i + 2;
      lead._original_record = { ...record };

      // Validate: must have a business name at minimum
      if (!lead.business_name || lead.business_name === 'Unknown') {
        const reason = 'Missing business name';
        errors.push(`Row ${i + 2}: ${reason}`);
        rejectedRows.push({ row: i + 2, reason, fields: { ...record } });
        continue;
      }

      lead.source = lead.source || 'csv_import';
      leads.push(lead);
    } catch (error) {
      errors.push(`Row ${i + 2}: ${error.message}`);
      rejectedRows.push({ row: i + 2, reason: error.message, fields: { ...record } });
    }
  }

  return {
    leads,
    errors,
    rejectedRows,
    stats: {
      total: records.length,
      valid: leads.length,
      invalid: records.length - leads.length,
    },
  };
}

export function previewCsvContent(csvContent, { columnMap = {} } = {}) {
  if (typeof csvContent !== 'string') throw new TypeError('CSV content must be text.');
  const clean = csvContent.trim();
  if (!clean) throw new Error('Choose a non-empty CSV file.');
  const records = parse(clean, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  });
  if (!records.length) throw new Error('No records found in CSV.');
  if (!columnMap || typeof columnMap !== 'object' || Array.isArray(columnMap)) throw new Error('Column mapping must be an object.');

  return buildPreview(Object.keys(records[0]), records, columnMap, records.length);
}

export async function previewCsvSampleContent(csvContent, { columnMap = {} } = {}) {
  if (typeof csvContent !== 'string') throw new TypeError('CSV content must be text.');
  if (!csvContent.trim()) throw new Error('Choose a non-empty CSV file.');
  if (!columnMap || typeof columnMap !== 'object' || Array.isArray(columnMap)) throw new Error('Column mapping must be an object.');
  const records = [];
  for await (const record of Readable.from([csvContent]).pipe(createCsvParser({
    columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true, to: 5,
  }))) {
    records.push(record);
  }
  if (!records.length) throw new Error('No complete data rows were found in the preview sample.');
  return buildPreview(Object.keys(records[0]), records, columnMap, null);
}

function buildPreview(headers, records, columnMap, totalRows) {
  if (!columnMap || typeof columnMap !== 'object' || Array.isArray(columnMap)) throw new Error('Column mapping must be an object.');
  const detectedFormat = detectFormat(headers);
  const profile = { ...COLUMN_MAPS.generic, ...(COLUMN_MAPS[detectedFormat] || {}) };
  const mapping = {};
  for (const [field, aliases] of Object.entries(profile)) {
    const selected = Object.hasOwn(columnMap, field)
      ? columnMap[field]
      : headers.find(header => aliases.some(alias => header.toLowerCase() === alias.toLowerCase())) || '';
    if (typeof selected !== 'string' || (selected && !headers.includes(selected))) {
      throw new Error(`Choose a CSV column that exists for ${field.replaceAll('_', ' ')}.`);
    }
    mapping[field] = selected;
  }
  for (const [field, header] of Object.entries(columnMap)) {
    if (!field.startsWith('custom__')) continue;
    if (!/^custom__[a-z\d_]{1,40}$/.test(field) || typeof header !== 'string' || (header && !headers.includes(header))) {
      throw new Error('Custom field mapping must reference an existing CSV column.');
    }
    mapping[field] = header;
  }
  const selectedMap = Object.fromEntries(Object.entries(mapping).map(([field, header]) => [field, header]));
  const sample = records.slice(0, 5).map(record => {
    const lead = mapRecord(record, selectedMap, {});
    return Object.fromEntries([...Object.keys(profile), ...Object.keys(mapping).filter(field => field.startsWith('custom__'))]
      .map(field => [field, lead[field] ?? '']));
  });
  return { headers, mapping, totalRows, sample };
}

/** Map a single streamed CSV record using a reviewed field-to-header mapping. */
export function mapCsvRecord(record, columnMap = {}) {
  return mapRecord(record, columnMap, {});
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
    const columns = Array.isArray(possibleColumns) ? possibleColumns
      : typeof possibleColumns === 'string' ? [possibleColumns] : [];
    if (columns.length) {
      for (const col of columns) {
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
