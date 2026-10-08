// ============================================================
//  ODD-ECOSYS Pipeline — Dedup Engine
//  Deduplicates leads on ingest by normalized domain + phone
// ============================================================

import { getDb } from './database.js';

/**
 * Normalize a domain for dedup comparison.
 * Strips protocol, www., trailing slashes, lowercases.
 * @param {string|null} url
 * @returns {string|null}
 */
export function normalizeDomain(url) {
  if (!url) return null;
  try {
    let domain = url.toLowerCase().trim();
    // Remove protocol
    domain = domain.replace(/^https?:\/\//, '');
    // Remove www.
    domain = domain.replace(/^www\./, '');
    // Remove trailing slash and path
    domain = domain.split('/')[0];
    // Remove port
    domain = domain.split(':')[0];
    return domain || null;
  } catch {
    return null;
  }
}

/**
 * Normalize a phone number for dedup comparison.
 * Strips everything except digits.
 * @param {string|null} phone
 * @returns {string|null}
 */
export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  // Must have at least 7 digits to be meaningful
  return digits.length >= 7 ? digits : null;
}

/**
 * Check if a lead already exists in the database.
 * Uses normalized domain + phone as composite key.
 * Falls back to business_name + city if no domain/phone.
 * @param {object} lead
 * @returns {{ isDuplicate: boolean, existingId: number|null, matchField: string|null }}
 */
export function checkDuplicate(lead) {
  const db = getDb();
  const normDomain = normalizeDomain(lead.website_url);
  const normPhone = normalizePhone(lead.phone);

  // Primary: match by domain (strongest signal)
  if (normDomain) {
    const existing = db.prepare(
      'SELECT id FROM leads WHERE normalized_domain = ? LIMIT 1'
    ).get(normDomain);

    if (existing) {
      return { isDuplicate: true, existingId: existing.id, matchField: 'domain' };
    }
  }

  // Secondary: match by phone (if no domain match but phone is present)
  if (normPhone) {
    const existing = db.prepare(
      'SELECT id FROM leads WHERE normalized_phone = ? LIMIT 1'
    ).get(normPhone);

    if (existing) {
      return { isDuplicate: true, existingId: existing.id, matchField: 'phone' };
    }
  }

  // Tertiary: match by exact business name + city (fuzzy fallback)
  if (lead.business_name && lead.city) {
    const existing = db.prepare(
      'SELECT id FROM leads WHERE LOWER(business_name) = LOWER(?) AND LOWER(city) = LOWER(?) LIMIT 1'
    ).get(lead.business_name, lead.city);

    if (existing) {
      return { isDuplicate: true, existingId: existing.id, matchField: 'name+city' };
    }
  }

  return { isDuplicate: false, existingId: null, matchField: null };
}

/**
 * Deduplicate a batch of leads, returning only unique ones.
 * Also deduplicates within the batch itself.
 * @param {object[]} leads - Array of lead objects
 * @returns {{ unique: object[], duplicates: object[], stats: object }}
 */
export function deduplicateLeads(leads) {
  const unique = [];
  const duplicates = [];
  const seenInBatch = new Map(); // domain/phone → index in unique[]

  for (const lead of leads) {
    const normDomain = normalizeDomain(lead.website_url);
    const normPhone = normalizePhone(lead.phone);

    // Check within this batch first
    const batchKey = normDomain || normPhone || `${lead.business_name}|${lead.city}`.toLowerCase();
    if (batchKey && seenInBatch.has(batchKey)) {
      duplicates.push({ ...lead, _dupReason: 'within_batch', _dupKey: batchKey });
      continue;
    }

    // Check against existing database
    const dbCheck = checkDuplicate(lead);
    if (dbCheck.isDuplicate) {
      duplicates.push({
        ...lead,
        _dupReason: `db_${dbCheck.matchField}`,
        _dupExistingId: dbCheck.existingId,
      });
      continue;
    }

    // Not a duplicate — add to unique set
    lead.normalized_domain = normDomain;
    lead.normalized_phone = normPhone;
    if (batchKey) seenInBatch.set(batchKey, unique.length);
    unique.push(lead);
  }

  return {
    unique,
    duplicates,
    stats: {
      total: leads.length,
      unique: unique.length,
      duplicates: duplicates.length,
      within_batch: duplicates.filter(d => d._dupReason === 'within_batch').length,
      existing_db: duplicates.filter(d => d._dupReason?.startsWith('db_')).length,
    },
  };
}
