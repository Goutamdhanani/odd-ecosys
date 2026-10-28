const CONTACT_PROVENANCE_FIELDS = Object.freeze([
  'source_details',
  'source_url',
  'consent_recorded_at',
  'consent_method',
  'consent_evidence_url',
]);

export class ContactProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContactProvenanceError';
    this.statusCode = 400;
  }
}

function optionalText(field, value, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ContactProvenanceError(`${field} must be text.`);
  const clean = value.trim();
  if (!clean) return null;
  if (clean.length > maxLength) throw new ContactProvenanceError(`${field} must be ${maxLength} characters or fewer.`);
  return clean;
}

function optionalHttpUrl(field, value) {
  const clean = optionalText(field, value, 2000);
  if (clean === null) return null;
  let parsed;
  try { parsed = new URL(clean); } catch { throw new ContactProvenanceError(`${field} must be an http or https URL.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ContactProvenanceError(`${field} must be an http or https URL without embedded credentials.`);
  }
  return parsed.href;
}

function optionalCalendarDate(value) {
  const clean = optionalText('Consent evidence date', value, 10);
  if (clean === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw new ContactProvenanceError('Consent evidence date must use YYYY-MM-DD.');
  }
  const [year, month, day] = clean.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ContactProvenanceError('Consent evidence date must be a real calendar date.');
  }
  return clean;
}

/**
 * Normalize operator-entered provenance. Null means no record was supplied;
 * this helper never infers consent from an import source or from contact age.
 */
export function normalizeContactProvenance(input = {}, { base = {} } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContactProvenanceError('Contact source and consent evidence must be an object.');
  }
  const unknown = Object.keys(input).filter(field => !CONTACT_PROVENANCE_FIELDS.includes(field));
  if (unknown.length) throw new ContactProvenanceError(`Unsupported provenance field: ${unknown.join(', ')}.`);

  const valueFor = field => Object.hasOwn(input, field) ? input[field] : base[field];
  const result = {
    source_details: optionalText('Source details', valueFor('source_details'), 500),
    source_url: optionalHttpUrl('Source URL', valueFor('source_url')),
    consent_recorded_at: optionalCalendarDate(valueFor('consent_recorded_at')),
    consent_method: optionalText('Consent method', valueFor('consent_method'), 160),
    consent_evidence_url: optionalHttpUrl('Consent evidence URL', valueFor('consent_evidence_url')),
  };

  const hasConsentDetails = result.consent_recorded_at !== null || result.consent_method !== null || result.consent_evidence_url !== null;
  if (hasConsentDetails && (!result.consent_recorded_at || !result.consent_method)) {
    throw new ContactProvenanceError('Record both a consent evidence date and method, or clear all consent evidence fields.');
  }
  return result;
}

export function hasContactProvenanceInput(input = {}) {
  return CONTACT_PROVENANCE_FIELDS.some(field => Object.hasOwn(input || {}, field));
}

export function getContactProvenanceFields() {
  return [...CONTACT_PROVENANCE_FIELDS];
}
