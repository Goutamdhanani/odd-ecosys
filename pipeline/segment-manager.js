import { getDb } from './database.js';
import { normalizeContactFieldFilter } from './contact-fields.js';

const LEAD_STATUSES = new Set([
  'discovered', 'enriching', 'site_checked', 'verifying', 'personalizing',
  'awaiting_approval', 'queued', 'sent', 'replied', 'won', 'disqualified', 'lost',
]);
const EMAIL_STATUSES = new Set(['deliverable', 'risky', 'undeliverable', 'unknown', 'no_email']);
const SUPPRESSION_STATUSES = new Set(['suppressed', 'not_suppressed']);
const CONTACT_SORT_FIELDS = new Set(['discovered_at', 'business_name', 'category', 'city', 'status']);
const FILTER_KEYS = new Set(['status', 'batch_id', 'tag_id', 'email_status', 'suppression_status', 'search', 'custom_field_key', 'custom_field_value', 'sort_by', 'sort_order']);

export class ContactSegmentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ContactSegmentError';
    this.statusCode = statusCode;
  }
}

function segmentId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ContactSegmentError('Segment id must be a positive integer.');
  return id;
}

function segmentName(value) {
  if (typeof value !== 'string') throw new ContactSegmentError('Segment name must be text.');
  const name = value.trim();
  if (!name) throw new ContactSegmentError('Segment name is required.');
  if (name.length > 80) throw new ContactSegmentError('Segment names must be 80 characters or fewer.');
  return name;
}

export function normalizeSegmentFilters(value = {}, { allowArchivedKeys = new Set() } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContactSegmentError('Segment filters must be an object.');
  const unsupported = Object.keys(value).filter(key => !FILTER_KEYS.has(key));
  if (unsupported.length) throw new ContactSegmentError(`Unsupported segment filter: ${unsupported.join(', ')}.`);

  const filters = {};
  if (value.status) {
    const status = typeof value.status === 'string' ? value.status.trim() : '';
    if (!LEAD_STATUSES.has(status)) throw new ContactSegmentError('Choose a supported contact status.');
    filters.status = status;
  }
  for (const key of ['batch_id', 'tag_id']) {
    if (!value[key]) continue;
    const id = Number(value[key]);
    if (!Number.isSafeInteger(id) || id < 1) throw new ContactSegmentError(`${key} must be a positive integer.`);
    filters[key] = String(id);
  }
  if (value.email_status) {
    const status = typeof value.email_status === 'string' ? value.email_status.trim() : '';
    if (!EMAIL_STATUSES.has(status)) throw new ContactSegmentError('Choose a supported email verification status.');
    filters.email_status = status;
  }
  if (value.suppression_status) {
    const status = typeof value.suppression_status === 'string' ? value.suppression_status.trim() : '';
    if (!SUPPRESSION_STATUSES.has(status)) throw new ContactSegmentError('Choose suppressed or not suppressed for the email filter.');
    filters.suppression_status = status;
  }
  if (value.search !== undefined && value.search !== null) {
    if (typeof value.search !== 'string') throw new ContactSegmentError('Segment search must be text.');
    const search = value.search.trim();
    if (search.length > 120) throw new ContactSegmentError('Segment search must be 120 characters or fewer.');
    if (search) filters.search = search;
  }
  const hasCustomKey = value.custom_field_key !== undefined && value.custom_field_key !== null && value.custom_field_key !== '';
  const hasCustomValue = value.custom_field_value !== undefined && value.custom_field_value !== null && value.custom_field_value !== '';
  if (hasCustomKey !== hasCustomValue) throw new ContactSegmentError('Choose both a custom field and an exact value.');
  if (hasCustomKey) {
    try {
      const custom = normalizeContactFieldFilter(getDb(), value.custom_field_key, value.custom_field_value, {
        allowArchived: allowArchivedKeys.has(value.custom_field_key),
      });
      filters.custom_field_key = custom.fieldKey;
      filters.custom_field_value = custom.value;
    } catch (error) {
      throw new ContactSegmentError(error.message, error.statusCode || 400);
    }
  }
  if (Object.hasOwn(value, 'sort_by') || Object.hasOwn(value, 'sort_order')) {
    const sortBy = Object.hasOwn(value, 'sort_by') ? value.sort_by : 'discovered_at';
    const sortOrder = Object.hasOwn(value, 'sort_order') ? value.sort_order : 'desc';
    if (typeof sortBy !== 'string' || !CONTACT_SORT_FIELDS.has(sortBy)) {
      throw new ContactSegmentError('Choose a supported contact sort field.');
    }
    if (typeof sortOrder !== 'string' || !['asc', 'desc'].includes(sortOrder)) {
      throw new ContactSegmentError('Contact sort order must be asc or desc.');
    }
    if (sortBy !== 'discovered_at' || sortOrder !== 'desc') {
      filters.sort_by = sortBy;
      filters.sort_order = sortOrder;
    }
  }
  return filters;
}

function publicSegment(row) {
  return {
    id: row.id,
    name: row.name,
    filters: JSON.parse(row.filters_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listContactSegments() {
  return getDb().prepare('SELECT id,name,filters_json,created_at,updated_at FROM contact_segments ORDER BY lower(name),id')
    .all().map(publicSegment);
}

export function createContactSegment(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContactSegmentError('Segment details must be an object.');
  const name = segmentName(input.name);
  const filters = normalizeSegmentFilters(Object.hasOwn(input, 'filters') ? input.filters : {});
  const db = getDb();
  try {
    const id = Number(db.prepare('INSERT INTO contact_segments(name,filters_json) VALUES (?,?)')
      .run(name, JSON.stringify(filters)).lastInsertRowid);
    return publicSegment(db.prepare('SELECT id,name,filters_json,created_at,updated_at FROM contact_segments WHERE id=?').get(id));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ContactSegmentError('A segment with that name already exists.', 409);
    throw error;
  }
}

export function updateContactSegment(value, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContactSegmentError('Segment changes must be an object.');
  const id = segmentId(value);
  const db = getDb();
  const current = db.prepare('SELECT id,name,filters_json,created_at,updated_at FROM contact_segments WHERE id=?').get(id);
  if (!current) return null;
  const name = Object.hasOwn(input, 'name') ? segmentName(input.name) : current.name;
  const currentFilters = JSON.parse(current.filters_json);
  const preservedArchivedKeys = new Set(
    currentFilters.custom_field_key && input.filters?.custom_field_key === currentFilters.custom_field_key
      ? [currentFilters.custom_field_key]
      : [],
  );
  const filters = Object.hasOwn(input, 'filters')
    ? normalizeSegmentFilters(input.filters, { allowArchivedKeys: preservedArchivedKeys })
    : currentFilters;
  try {
    db.prepare("UPDATE contact_segments SET name=?,filters_json=?,updated_at=datetime('now') WHERE id=?")
      .run(name, JSON.stringify(filters), id);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ContactSegmentError('A segment with that name already exists.', 409);
    throw error;
  }
  return publicSegment(db.prepare('SELECT id,name,filters_json,created_at,updated_at FROM contact_segments WHERE id=?').get(id));
}

export function deleteContactSegment(value) {
  const id = segmentId(value);
  const result = getDb().prepare('DELETE FROM contact_segments WHERE id=?').run(id);
  return result.changes > 0;
}
