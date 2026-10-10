import { parse as parseCsv } from 'csv-parse/sync';

export const OSM_ATTRIBUTION = Object.freeze({
  label: '© OpenStreetMap contributors · Open Database License (ODbL)',
  url: 'https://www.openstreetmap.org/copyright',
});

export const MAX_OSM_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_OSM_FEATURES = 5000;

export class OsmImportError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'OsmImportError';
    this.statusCode = statusCode;
  }
}

function text(value, max = 500) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function osmObjectId(properties, featureId) {
  const direct = text(properties['@id'] ?? properties.osm_id ?? properties.osm_identifier ?? featureId, 160);
  const directMatch = /(?:^|\/)(node|way|relation)\/(\d+)$/i.exec(direct);
  if (directMatch) return `${directMatch[1].toLowerCase()}/${directMatch[2]}`;

  const type = text(properties['@type'] ?? properties.osm_type ?? properties.type, 30).toLowerCase();
  const id = text(properties.id ?? featureId, 40);
  if (['node', 'way', 'relation'].includes(type) && /^\d+$/.test(id)) return `${type}/${id}`;
  return null;
}

function property(properties, ...keys) {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const clean = text(value, 2000);
      if (clean) return clean;
    }
  }
  return '';
}

function cleanWebsite(value) {
  const raw = text(value, 2000);
  if (!raw) return '';
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return raw;
    return url.href;
  } catch {
    return raw;
  }
}

function mapProperties(rawProperties, featureId, row) {
  if (!rawProperties || typeof rawProperties !== 'object' || Array.isArray(rawProperties)) {
    return { rejection: { row, reason: 'invalid_properties' } };
  }
  const properties = rawProperties.tags && typeof rawProperties.tags === 'object' && !Array.isArray(rawProperties.tags)
    ? { ...rawProperties, ...rawProperties.tags }
    : rawProperties;
  const objectId = osmObjectId(properties, featureId);
  if (!objectId) return { rejection: { row, reason: 'missing_or_invalid_osm_object_id' } };
  const businessName = property(properties, 'name', 'official_name', 'brand');
  const [type, id] = objectId.split('/');
  const street = [property(properties, 'addr:housenumber', 'house_number'), property(properties, 'addr:street', 'street')]
    .filter(Boolean).join(' ');
  const address = property(properties, 'addr:full', 'address') || street;
  const category = property(properties,
    'shop', 'amenity', 'office', 'craft', 'healthcare', 'tourism', 'industrial', 'leisure', 'man_made', 'building');
  if (!businessName) return {
    objectId,
    rejection: {
      row, osm_id: objectId, reason: 'missing_business_name',
      fields: { osm_id: objectId, category, city: property(properties, 'addr:city', 'addr:town', 'city', 'town', 'addr:place'), source_url: `https://www.openstreetmap.org/${type}/${id}` },
    },
  };
  const timestamp = property(properties, '@timestamp', 'timestamp', 'osm_timestamp', 'last_update', 'last_updated').slice(0, 120);
  const emails = property(properties, 'contact:email', 'email', 'contact_email').replace(/[;\s]+/g, ',');
  const website = cleanWebsite(property(properties, 'contact:website', 'website', 'url'));
  return {
    record: {
      row,
      osm_id: objectId,
      business_name: businessName,
      category,
      address,
      city: property(properties, 'addr:city', 'addr:town', 'city', 'town', 'addr:place'),
      state: property(properties, 'addr:state', 'addr:province', 'state'),
      country: property(properties, 'addr:country', 'country'),
      phone: property(properties, 'contact:phone', 'phone', 'telephone'),
      website_url: website,
      email: emails,
      source_details: `OpenStreetMap · ODbL · feature ${row}${timestamp ? ` · source timestamp: ${timestamp}` : ''}`.slice(0, 500),
      source_url: `https://www.openstreetmap.org/${type}/${id}`,
    },
  };
}

function parseInput(input) {
  if (typeof input !== 'string' || !input.trim()) throw new OsmImportError('Choose a non-empty OpenStreetMap export.');
  if (Buffer.byteLength(input, 'utf8') > MAX_OSM_IMPORT_BYTES) {
    throw new OsmImportError('OpenStreetMap exports must be 5 MB or smaller.', 413);
  }
  const first = input.trimStart()[0];
  if (first === '{' || first === '[') {
    let parsed;
    try { parsed = JSON.parse(input); } catch { throw new OsmImportError('The GeoJSON export is not valid JSON.'); }
    if (!parsed || parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
      throw new OsmImportError('GeoJSON must contain a FeatureCollection.');
    }
    return { format: 'geojson', rows: parsed.features.map((feature, index) => ({
      properties: feature?.properties,
      id: feature?.id,
      invalidFeature: feature?.type !== 'Feature',
      row: index + 1,
    })) };
  }

  let rows;
  try {
    rows = parseCsv(input, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true });
  } catch {
    throw new OsmImportError('The CSV export could not be parsed.');
  }
  return { format: 'csv', rows: rows.map((properties, index) => ({ properties, id: properties['@id'], row: index + 1 })) };
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

const CSV_FIELDS = [
  'business_name', 'category', 'address', 'city', 'state', 'country', 'phone',
  'website_url', 'email', 'source_details', 'source_url',
];

export function parseOsmExport(input) {
  const { rows: sourceRows, format } = parseInput(input);
  if (sourceRows.length > MAX_OSM_FEATURES) throw new OsmImportError(`OpenStreetMap imports are limited to ${MAX_OSM_FEATURES} features.`, 413);
  const records = [];
  const rejections = [];
  const seenObjectIds = new Set();

  for (const sourceRow of sourceRows) {
    if (sourceRow.invalidFeature) {
      rejections.push({ row: sourceRow.row, reason: 'invalid_geojson_feature' });
      continue;
    }
    const mapped = mapProperties(sourceRow.properties, sourceRow.id, sourceRow.row);
    if (mapped.rejection) {
      rejections.push(mapped.rejection);
      continue;
    }
    if (seenObjectIds.has(mapped.record.osm_id)) {
      rejections.push({
        row: sourceRow.row,
        osm_id: mapped.record.osm_id,
        reason: 'duplicate_osm_object_in_export',
        fields: { osm_id: mapped.record.osm_id, business_name: mapped.record.business_name, source_url: mapped.record.source_url },
      });
      continue;
    }
    seenObjectIds.add(mapped.record.osm_id);
    records.push(mapped.record);
  }

  const csv = [CSV_FIELDS.map(csvCell).join(','), ...records.map(record => CSV_FIELDS.map(field => csvCell(record[field])).join(','))].join('\r\n');
  return {
    inputFormat: format,
    featureCount: sourceRows.length,
    records,
    rejections,
    csv,
  };
}
