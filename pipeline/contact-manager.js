import { getDb } from './database.js';
import { deduplicateLeads, normalizeDomain, normalizePhone } from './dedup.js';
import { parseCsvContent, previewCsvContent, previewCsvSampleContent } from './csv-importer.js';
import { listLeadCustomFields, saveLeadCustomFields } from './contact-fields.js';
import { getContactProvenanceFields, hasContactProvenanceInput, normalizeContactProvenance } from './contact-provenance.js';

const CONTACT_FIELDS = {
  business_name: { max: 200, required: true },
  category: { max: 120 },
  address: { max: 500 },
  city: { max: 120 },
  state: { max: 120 },
  country: { max: 120 },
  phone: { max: 80 },
  website_url: { max: 2000, url: true },
  facebook_url: { max: 2000, url: true },
  email: { max: 320, email: true },
};
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5000;
const MAX_CONTACT_TAGS = 100;
const MAX_BULK_TAG_CONTACTS = 500;
const CONTACT_PROVENANCE_KEYS = getContactProvenanceFields();

export function prepareImportedContact(lead) {
  const values = Object.fromEntries(Object.entries(CONTACT_FIELDS).map(([field, rule]) => [
    field,
    normalizeValue(field, lead[field], rule),
  ]));
  const extras = [...new Set((lead._extra_emails || [])
    .map(email => normalizeValue('email', email, CONTACT_FIELDS.email)))].filter(email => email !== values.email);
  return {
    ...values,
    ...normalizeContactProvenance(Object.fromEntries(CONTACT_PROVENANCE_KEYS.map(field => [field, lead[field]]))),
    rating: lead.rating ?? null,
    reviews: lead.reviews ?? null,
    _extra_emails: extras,
    _row_number: lead._row_number,
    _original_record: lead._original_record || {},
  };
}

export class ContactManagerError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ContactManagerError';
    this.statusCode = statusCode;
  }
}

function normalizeLeadId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ContactManagerError('Contact id must be a positive integer.');
  return id;
}

function normalizeValue(field, value, rule) {
  if (value === undefined || value === null || value === '') {
    if (rule.required) throw new ContactManagerError(`${field.replaceAll('_', ' ')} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new ContactManagerError(`${field.replaceAll('_', ' ')} must be text.`);
  const clean = value.trim();
  if (!clean && rule.required) throw new ContactManagerError(`${field.replaceAll('_', ' ')} is required.`);
  if (!clean) return null;
  if (clean.length > rule.max) throw new ContactManagerError(`${field.replaceAll('_', ' ')} must be ${rule.max} characters or fewer.`);
  if (rule.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new ContactManagerError('Enter a valid email address.');
  if (rule.url) {
    let parsed;
    try { parsed = new URL(clean); } catch { throw new ContactManagerError(`${field.replaceAll('_', ' ')} must be an http or https URL.`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new ContactManagerError(`${field.replaceAll('_', ' ')} must be an http or https URL.`);
    }
  }
  return rule.email ? clean.toLowerCase() : clean;
}

function isGloballySuppressed(db, email) {
  const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!clean) return false;
  return Boolean(db.prepare('SELECT 1 FROM suppression_list WHERE lower(trim(email))=? LIMIT 1').get(clean));
}

export function createContact(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContactManagerError('Contact details must be an object.');
  const allowedFields = new Set([...Object.keys(CONTACT_FIELDS), ...CONTACT_PROVENANCE_KEYS, 'batch_id', 'custom_fields']);
  const unknown = Object.keys(input).filter(key => !allowedFields.has(key));
  if (unknown.length) throw new ContactManagerError(`Unsupported contact field: ${unknown.join(', ')}.`);

  const batchId = Number(input.batch_id);
  if (!Number.isSafeInteger(batchId) || batchId < 1) throw new ContactManagerError('Choose an existing open batch.');
  const values = Object.fromEntries(Object.entries(CONTACT_FIELDS).map(([field, rule]) => [
    field,
    Object.hasOwn(input, field) || rule.required ? normalizeValue(field, input[field], rule) : null,
  ]));
  const provenance = normalizeContactProvenance(Object.fromEntries(CONTACT_PROVENANCE_KEYS.map(field => [field, input[field]])));

  const db = getDb();
  return db.transaction(() => {
    const batch = db.prepare('SELECT id,status FROM batches WHERE id = ?').get(batchId);
    if (!batch) throw new ContactManagerError('Batch not found.', 404);
    if (batch.status !== 'open') throw new ContactManagerError('Contacts can only be added to an open batch.', 409);

    if (values.email) {
      if (isGloballySuppressed(db, values.email)) {
        throw new ContactManagerError('That email address is globally suppressed and cannot be added.', 409);
      }
      const duplicate = db.prepare(`
        SELECT id FROM leads WHERE lower(trim(email)) = ?
        UNION ALL
        SELECT lead_id AS id FROM lead_emails WHERE lower(trim(email)) = ?
        LIMIT 1
      `).get(values.email, values.email);
      if (duplicate) throw new ContactManagerError('That email address already belongs to a contact.', 409);
    }

    const fields = Object.keys(CONTACT_FIELDS);
    const result = db.prepare(`
      INSERT INTO leads (
        batch_id, ${fields.join(', ')}, source, ${CONTACT_PROVENANCE_KEYS.join(', ')}, normalized_domain, normalized_phone,
        status, discovered_at, updated_at
      ) VALUES (
        ?, ${fields.map(() => '?').join(', ')}, 'manual', ${CONTACT_PROVENANCE_KEYS.map(() => '?').join(', ')}, ?, ?,
        'discovered', datetime('now'), datetime('now')
      )
    `).run(
      batchId,
      ...fields.map(field => values[field]),
      ...CONTACT_PROVENANCE_KEYS.map(field => provenance[field]),
      normalizeDomain(values.website_url),
      normalizePhone(values.phone),
    );
    const contactId = Number(result.lastInsertRowid);

    if (values.email) {
      db.prepare(`
        INSERT INTO lead_emails (lead_id,email,source,verification_status,is_primary)
        VALUES (?,?,'manual','unknown',1)
      `).run(contactId, values.email);
    }

    const changedCustomFields = saveLeadCustomFields(db, contactId, input.custom_fields || {}, { requireAll: true });

    db.prepare(`
      UPDATE batches SET lead_count = (SELECT COUNT(*) FROM leads WHERE batch_id = ?)
      WHERE id = ?
    `).run(batchId, batchId);
    db.prepare(`
      INSERT INTO events (lead_id,event_type,event_at,meta_json)
      VALUES (?,'contact_created',datetime('now'),?)
    `).run(contactId, JSON.stringify({ batch_id: batchId, source: 'manual' }));

    const contact = db.prepare('SELECT * FROM leads WHERE id = ?').get(contactId);
    return {
      contact,
      customFields: listLeadCustomFields(db, contactId),
      emailEvidence: values.email ? { email: values.email, verification_status: 'unknown' } : null,
      verificationRequired: Boolean(values.email),
    };
  })();
}

export function previewContactsImport(value, csvContent, columnMap = {}) {
  const batchId = Number(value);
  if (!Number.isSafeInteger(batchId) || batchId < 1) throw new ContactManagerError('Choose an existing open batch.');
  if (typeof csvContent !== 'string' || !csvContent.trim()) throw new ContactManagerError('Choose a non-empty CSV file.');
  if (Buffer.byteLength(csvContent, 'utf8') > MAX_IMPORT_BYTES) throw new ContactManagerError('CSV files must be 5 MB or smaller.', 413);

  const db = getDb();
  const batch = db.prepare('SELECT id,status FROM batches WHERE id = ?').get(batchId);
  if (!batch) throw new ContactManagerError('Batch not found.', 404);
  if (batch.status !== 'open') throw new ContactManagerError('Contacts can only be imported into an open batch.', 409);

  try {
    const preview = previewCsvContent(csvContent, { columnMap });
    return { batchId, ...preview };
  } catch (error) {
    if (error instanceof ContactManagerError) throw error;
    throw new ContactManagerError(error.message || 'CSV preview could not be created.');
  }
}

export async function previewContactsImportSample(value, csvContent, columnMap = {}) {
  const batchId = Number(value);
  if (!Number.isSafeInteger(batchId) || batchId < 1) throw new ContactManagerError('Choose an existing open batch.');
  if (typeof csvContent !== 'string' || !csvContent.trim()) throw new ContactManagerError('Choose a non-empty CSV sample.');
  if (Buffer.byteLength(csvContent, 'utf8') > MAX_IMPORT_BYTES) throw new ContactManagerError('CSV preview samples are limited to 5 MB.', 413);
  const db = getDb();
  const batch = db.prepare('SELECT id,status FROM batches WHERE id=?').get(batchId);
  if (!batch) throw new ContactManagerError('Batch not found.', 404);
  if (batch.status !== 'open') throw new ContactManagerError('Contacts can only be imported into an open batch.', 409);
  try {
    return { batchId, ...(await previewCsvSampleContent(csvContent, { columnMap })) };
  } catch (error) {
    if (error instanceof ContactManagerError) throw error;
    throw new ContactManagerError(error.message || 'CSV preview sample could not be created.');
  }
}

export function importContactsToBatch(value, csvContent, columnMap = {}, sourceKind = 'csv_import', sourceOptions = {}) {
  if (!['csv_import', 'openstreetmap', 'meta_lead_ads'].includes(sourceKind)) throw new ContactManagerError('Unsupported contact import source.');
  if (!sourceOptions || typeof sourceOptions !== 'object' || Array.isArray(sourceOptions)) throw new ContactManagerError('Import source metadata must be an object.');
  const sourceRecordsByRow = sourceOptions.sourceRecordsByRow || {};
  if (!sourceRecordsByRow || typeof sourceRecordsByRow !== 'object' || Array.isArray(sourceRecordsByRow)) throw new ContactManagerError('Import source records must be an object.');
  if (sourceKind !== 'meta_lead_ads' && Object.keys(sourceRecordsByRow).length) throw new ContactManagerError('External source identities are only supported for Meta Lead Ads imports.');
  const batchId = Number(value);
  if (!Number.isSafeInteger(batchId) || batchId < 1) throw new ContactManagerError('Choose an existing open batch.');
  if (typeof csvContent !== 'string' || !csvContent.trim()) throw new ContactManagerError('Choose a non-empty CSV file.');
  if (Buffer.byteLength(csvContent, 'utf8') > MAX_IMPORT_BYTES) throw new ContactManagerError('CSV files must be 5 MB or smaller.', 413);

  const db = getDb();
  const batch = db.prepare('SELECT id,status FROM batches WHERE id = ?').get(batchId);
  if (!batch) throw new ContactManagerError('Batch not found.', 404);
  if (batch.status !== 'open') throw new ContactManagerError('Contacts can only be imported into an open batch.', 409);

  const preview = previewContactsImport(batchId, csvContent, columnMap);
  if (!preview.mapping.business_name) throw new ContactManagerError('Map a CSV column to Business name before importing.');
  const parsed = parseCsvContent(csvContent, { columnMap: preview.mapping });
  if (parsed.stats.total > MAX_IMPORT_ROWS) throw new ContactManagerError(`CSV files are limited to ${MAX_IMPORT_ROWS} rows.`, 413);

  const invalidErrors = [...parsed.errors];
  const rejectedRows = [...(parsed.rejectedRows || [])];
  const candidates = [];
  const seenExternalIds = new Set();
  const sourceIdentityDuplicates = [];
  const findSourceRecord = db.prepare('SELECT lead_id FROM lead_source_records WHERE provider=? AND external_id=? LIMIT 1');
  for (const lead of parsed.leads) {
    try {
      let externalSourceRecord = null;
      if (sourceKind === 'meta_lead_ads') {
        const sourceRecord = sourceRecordsByRow[String(lead._row_number)];
        const externalId = typeof sourceRecord?.external_id === 'string' ? sourceRecord.external_id.trim() : '';
        if (!/^\d{1,40}$/.test(externalId)) throw new ContactManagerError('Meta lead is missing a valid external lead ID.');
        if (seenExternalIds.has(externalId)) {
          sourceIdentityDuplicates.push({ ...lead, _dupReason: 'meta_external_id' });
          continue;
        }
        seenExternalIds.add(externalId);
        const existing = findSourceRecord.get('meta_lead_ads', externalId);
        if (existing) {
          sourceIdentityDuplicates.push({ ...lead, _dupReason: 'meta_external_id', _dupExistingId: existing.lead_id });
          continue;
        }
        const pageId = typeof sourceRecord.page_id === 'string' ? sourceRecord.page_id : '';
        const formId = typeof sourceRecord.form_id === 'string' ? sourceRecord.form_id : '';
        const sourceCreatedAt = typeof sourceRecord.source_created_at === 'string' ? sourceRecord.source_created_at.slice(0, 40) : null;
        if (!/^\d{1,32}$/.test(pageId) || !/^\d{1,32}$/.test(formId)) throw new ContactManagerError('Meta source page and form IDs must be numeric.');
        externalSourceRecord = { external_id: externalId, page_id: pageId, form_id: formId, source_created_at: sourceCreatedAt };
      }
      candidates.push({ ...prepareImportedContact(lead), source: sourceKind, _external_source_record: externalSourceRecord });
    } catch (error) {
      invalidErrors.push(`Row ${lead._row_number}: ${error.message}`);
      rejectedRows.push({ row: lead._row_number, reason: error.message, fields: lead._original_record || {} });
    }
  }

  const sourceDuplicates = [...sourceIdentityDuplicates];
  const dedupCandidates = candidates.filter(lead => {
    if (sourceKind !== 'openstreetmap' || !lead.source_url) return true;
    const existing = db.prepare('SELECT id FROM leads WHERE source_url=? LIMIT 1').get(lead.source_url);
    if (!existing) return true;
    sourceDuplicates.push({ ...lead, _dupReason: 'osm_source_url', _dupExistingId: existing.id });
    return false;
  });
  const deduped = deduplicateLeads(dedupCandidates);
  deduped.duplicates.unshift(...sourceDuplicates);
  const seenEmails = new Set(db.prepare(`
    SELECT lower(trim(email)) AS email FROM leads WHERE email IS NOT NULL AND trim(email) != ''
    UNION
    SELECT lower(trim(email)) AS email FROM lead_emails WHERE trim(email) != ''
  `).all().map(row => row.email));
  const checkSuppression = db.prepare('SELECT 1 FROM suppression_list WHERE lower(trim(email))=? LIMIT 1');
  const uniqueRows = [];
  const duplicateRows = deduped.duplicates.map(lead => ({ row: lead._row_number, reason: `duplicate_${lead._dupReason || 'contact'}` }));
  for (const duplicate of deduped.duplicates) {
    rejectedRows.push({
      row: duplicate._row_number,
      reason: `duplicate_${duplicate._dupReason || 'contact'}`,
      fields: duplicate._original_record || {},
    });
  }

  for (const lead of deduped.unique) {
    const emails = [...new Set([lead.email, ...lead._extra_emails].filter(Boolean))];
    if (emails.some(email => checkSuppression.get(email))) {
      const reason = 'suppressed_email';
      invalidErrors.push(`Row ${lead._row_number}: one or more addresses are globally suppressed.`);
      rejectedRows.push({ row: lead._row_number, reason, fields: lead._original_record || {} });
      continue;
    }
    const duplicateEmail = emails.some(email => seenEmails.has(email));
    if (duplicateEmail) {
      duplicateRows.push({ row: lead._row_number, reason: 'duplicate_email' });
      rejectedRows.push({ row: lead._row_number, reason: 'duplicate_email', fields: lead._original_record || {} });
      continue;
    }
    for (const email of emails) seenEmails.add(email);
    uniqueRows.push(lead);
  }

  const concurrentSourceDuplicates = [];
  const checkSourceRecordDuringWrite = db.prepare('SELECT lead_id FROM lead_source_records WHERE provider=? AND external_id=? LIMIT 1');
  const insertBatch = db.transaction(() => {
    const insertLead = db.prepare(`
      INSERT INTO leads (
        batch_id,business_name,category,address,city,state,country,phone,website_url,facebook_url,
        email,source,source_details,source_url,consent_recorded_at,consent_method,consent_evidence_url,
        rating,reviews,normalized_domain,normalized_phone,status,discovered_at,updated_at
      ) VALUES (${Array(21).fill('?').join(',')}, 'discovered',datetime('now'),datetime('now'))
    `);
    const insertEmail = db.prepare(`
      INSERT INTO lead_emails (lead_id,email,source,verification_status,is_primary)
      VALUES (?,?,?,'unknown',?)
    `);
    const insertEvent = db.prepare(`
      INSERT INTO events (lead_id,event_type,event_at,meta_json)
      VALUES (?,'contact_imported',datetime('now'),?)
    `);
    let inserted = 0;

    for (const lead of uniqueRows) {
      if (sourceKind === 'meta_lead_ads') {
        const external = lead._external_source_record;
        if (checkSourceRecordDuringWrite.get('meta_lead_ads', external.external_id)) {
          concurrentSourceDuplicates.push({ ...lead, _dupReason: 'meta_external_id' });
          continue;
        }
      }
      const result = insertLead.run(
        batchId,lead.business_name,lead.category,lead.address,lead.city,lead.state,lead.country,
        lead.phone,lead.website_url,lead.facebook_url,lead.email,lead.source,lead.source_details,lead.source_url,
        lead.consent_recorded_at,lead.consent_method,lead.consent_evidence_url,lead.rating,lead.reviews,
        lead.normalized_domain ?? normalizeDomain(lead.website_url),
        lead.normalized_phone ?? normalizePhone(lead.phone),
      );
      const leadId = Number(result.lastInsertRowid);
      const emails = [...new Set([lead.email, ...lead._extra_emails].filter(Boolean))];
      emails.forEach((email, index) => insertEmail.run(leadId, email, sourceKind, index === 0 && email === lead.email ? 1 : 0));
      const eventMeta = { batch_id: batchId, source: sourceKind };
      if (sourceKind === 'openstreetmap') {
        eventMeta.osm_feature_row = Number(/(?:^| · )feature (\d+)/.exec(lead.source_details || '')?.[1]) || null;
        eventMeta.osm_object_id = lead.source_url?.replace('https://www.openstreetmap.org/', '') || null;
      } else if (sourceKind === 'meta_lead_ads') {
        const sourceRecord = lead._external_source_record;
        if (!sourceRecord) throw new ContactManagerError('Meta source identity was lost during import.');
        db.prepare(`INSERT INTO lead_source_records(provider,external_id,lead_id,page_id,form_id,source_created_at)
          VALUES ('meta_lead_ads',?,?,?,?,?)`).run(
          sourceRecord.external_id, leadId, sourceRecord.page_id, sourceRecord.form_id, sourceRecord.source_created_at,
        );
        eventMeta.meta_lead_id = sourceRecord.external_id;
        eventMeta.meta_form_id = sourceRecord.form_id;
      } else eventMeta.csv_row = lead._row_number;
      insertEvent.run(leadId, JSON.stringify(eventMeta));
      inserted++;
    }

    db.prepare(`
      UPDATE batches SET lead_count = (SELECT COUNT(*) FROM leads WHERE batch_id = ?)
      WHERE id = ?
    `).run(batchId, batchId);
    return inserted;
  }).immediate;
  const inserted = uniqueRows.length ? insertBatch() : 0;
  for (const duplicate of concurrentSourceDuplicates) {
    duplicateRows.push({ row: duplicate._row_number, reason: 'duplicate_meta_external_id' });
    rejectedRows.push({ row: duplicate._row_number, reason: 'duplicate_meta_external_id', fields: duplicate._original_record || {} });
  }

  return {
    batchId,
    counts: {
      parsed: parsed.stats.total,
      inserted,
      duplicates: duplicateRows.length,
      invalid: parsed.stats.invalid + invalidErrors.length - parsed.errors.length,
    },
    duplicates: duplicateRows.slice(0, 100),
    errors: invalidErrors.slice(0, 100),
    rejections: rejectedRows.slice(0, MAX_IMPORT_ROWS),
  };
}

export function updateContact(value, updates = {}) {
  const id = normalizeLeadId(value);
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new ContactManagerError('Contact changes must be an object.');
  const keys = Object.keys(updates);
  const customFieldsProvided = Object.hasOwn(updates, 'custom_fields');
  const provenanceProvided = hasContactProvenanceInput(updates);
  const standardKeys = keys.filter(key => key !== 'custom_fields' && !CONTACT_PROVENANCE_KEYS.includes(key));
  const unknown = standardKeys.filter(key => !Object.hasOwn(CONTACT_FIELDS, key));
  if (unknown.length) throw new ContactManagerError(`Unsupported contact field: ${unknown.join(', ')}.`);
  if (!standardKeys.length && !customFieldsProvided && !provenanceProvided) throw new ContactManagerError('Provide at least one contact field to update.');

  const db = getDb();
  return db.transaction(() => {
    const current = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!current) return null;

    const changes = {};
    for (const field of standardKeys) {
      changes[field] = normalizeValue(field, updates[field], CONTACT_FIELDS[field]);
    }
    const provenanceInput = Object.fromEntries(CONTACT_PROVENANCE_KEYS
      .filter(field => Object.hasOwn(updates, field)).map(field => [field, updates[field]]));
    const provenanceChanges = provenanceProvided
      ? normalizeContactProvenance(provenanceInput, { base: current })
      : {};
    if (changes.email && db.prepare('SELECT id FROM leads WHERE lower(email) = ? AND id != ? LIMIT 1').get(changes.email.toLowerCase(), id)) {
      throw new ContactManagerError('That email address is already assigned to another contact.', 409);
    }
    if (changes.email && isGloballySuppressed(db, changes.email)) {
      throw new ContactManagerError('That email address is globally suppressed and cannot be assigned to a contact.', 409);
    }
    const changedContactFields = Object.keys(changes).filter(field => (current[field] ?? null) !== changes[field]);
    const changedProvenanceFields = CONTACT_PROVENANCE_KEYS
      .filter(field => provenanceProvided && (current[field] ?? null) !== provenanceChanges[field]);
    const changedFields = [...changedContactFields, ...changedProvenanceFields];
    const changedCustomFields = customFieldsProvided ? saveLeadCustomFields(db, id, updates.custom_fields) : [];
    if (!changedFields.length && !changedCustomFields.length) {
      return { contact: current, changedFields, changedCustomFields, customFields: listLeadCustomFields(db, id), reviewRequired: false, verificationRequired: false, cancelledSends: 0 };
    }

    const assignments = [
      ...changedContactFields.map(field => `${field} = ?`),
      ...changedProvenanceFields.map(field => `${field} = ?`),
      "updated_at = datetime('now')",
    ];
    db.prepare(`UPDATE leads SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...changedContactFields.map(field => changes[field]),
        ...changedProvenanceFields.map(field => provenanceChanges[field]), id);

    const personalizationRelevant = changedContactFields.length > 0 || changedCustomFields.length > 0;
    if (personalizationRelevant) {
      db.prepare('UPDATE personalizations SET approved = 0, guardrail_passed = 0, fact_check_passed = 0 WHERE lead_id = ?').run(id);
    }

    if (changedContactFields.includes('email') && changes.email) {
      const existingEvidence = db.prepare('SELECT id FROM lead_emails WHERE lead_id = ? AND lower(email) = ? LIMIT 1').get(id, changes.email);
      if (!existingEvidence) {
        db.prepare(`INSERT INTO lead_emails (lead_id,email,source,verification_status,verified_at)
          VALUES (?,?,'manual_edit','unknown',NULL)`).run(id, changes.email);
      }
    }

    const pendingSends = personalizationRelevant
      ? db.prepare("SELECT id FROM sends WHERE lead_id = ? AND status = 'scheduled'").all(id) : [];
    const inFlightSends = personalizationRelevant
      ? db.prepare("SELECT COUNT(*) AS count FROM sends WHERE lead_id = ? AND status = 'processing'").get(id).count : 0;
    const cancelled = personalizationRelevant ? db.prepare(`
      UPDATE sends SET status = 'cancelled', sent_at = NULL,
        error_message = 'Contact details changed; verify and review copy before rescheduling.'
      WHERE lead_id = ? AND status = 'scheduled'
    `).run(id) : { changes: 0 };
    const event = db.prepare(`
      INSERT INTO events (send_id, lead_id, event_type, event_at, meta_json)
      VALUES (NULL, ?, 'contact_updated', datetime('now'), ?)
    `);
    event.run(id, JSON.stringify({ changedFields, changedCustomFields }));
    if (cancelled.changes) {
      const blockedEvent = db.prepare(`
        INSERT INTO events (send_id, lead_id, event_type, event_at, meta_json)
        VALUES (?, ?, 'send_blocked', datetime('now'), ?)
      `);
      for (const send of pendingSends) {
        blockedEvent.run(send.id, id, JSON.stringify({ reason: 'contact_updated_reapproval_required' }));
      }
    }

    const contact = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    return {
      contact,
      changedFields,
      changedCustomFields,
      customFields: listLeadCustomFields(db, id),
      reviewRequired: personalizationRelevant,
      verificationRequired: changedContactFields.includes('email') && Boolean(changes.email),
      cancelledSends: cancelled.changes,
      inFlightSends,
    };
  })();
}

export function deleteContact(value) {
  const id = normalizeLeadId(value);
  const db = getDb();
  return db.transaction(() => {
    const contact = db.prepare('SELECT id,batch_id FROM leads WHERE id=?').get(id);
    if (!contact) return null;

    const activeSendHistory = db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(id).count;
    const hasArchivedSendHistory = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sends_archive'").get()
      ? db.prepare('SELECT 1 FROM sends_archive WHERE lead_id=? LIMIT 1').get(id)
      : null;
    if (activeSendHistory || hasArchivedSendHistory) {
      throw new ContactManagerError('This contact has send history and cannot be permanently deleted. Accepted, rejected, and uncertain SMTP records are retained.', 409);
    }

    // Keep global suppression entries intact: deleting a contact must never
    // undo an unsubscribe, complaint, bounce, or operator suppression.
    db.prepare('DELETE FROM unsubscribe_tokens WHERE lead_id=?').run(id);
    db.prepare('DELETE FROM events WHERE lead_id=?').run(id);
    db.prepare('DELETE FROM personalizations WHERE lead_id=?').run(id);
    db.prepare('DELETE FROM lead_emails WHERE lead_id=?').run(id);
    // Lists, tags, and unsent campaign enrollments have lead foreign keys and
    // are removed by their declared ON DELETE CASCADE constraints.
    db.prepare('DELETE FROM leads WHERE id=?').run(id);
    db.prepare('UPDATE batches SET lead_count=(SELECT COUNT(*) FROM leads WHERE batch_id=?) WHERE id=?')
      .run(contact.batch_id, contact.batch_id);

    return { contactId: id, batchId: contact.batch_id, deleted: true, suppressionHistoryPreserved: true };
  })();
}

function normalizeTagName(value) {
  if (typeof value !== 'string') throw new ContactManagerError('Tag name must be text.');
  const name = value.trim();
  if (!name) throw new ContactManagerError('Tag name is required.');
  if (name.length > 50) throw new ContactManagerError('Tag names must be 50 characters or fewer.');
  return name;
}

function normalizeTagId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ContactManagerError('Tag ids must be positive integers.');
  return id;
}

export function listContactTags({ includeArchived = false } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT t.id, t.name, t.status, t.created_at, t.updated_at,
      COUNT(DISTINCT lct.lead_id) AS contact_count
    FROM contact_tags t
    LEFT JOIN lead_contact_tags lct ON lct.tag_id = t.id
    ${includeArchived ? '' : "WHERE t.status = 'active'"}
    GROUP BY t.id
    ORDER BY CASE WHEN t.status = 'active' THEN 0 ELSE 1 END, lower(t.name), t.id
  `).all();
}

export function createContactTag(value) {
  const name = normalizeTagName(value);
  const db = getDb();
  try {
    const result = db.prepare('INSERT INTO contact_tags(name) VALUES (?)').run(name);
    return db.prepare('SELECT id,name,status,created_at,updated_at FROM contact_tags WHERE id=?').get(Number(result.lastInsertRowid));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ContactManagerError('A tag with that name already exists.', 409);
    throw error;
  }
}

export function renameContactTag(value, nameValue) {
  const id = normalizeTagId(value);
  const name = normalizeTagName(nameValue);
  const db = getDb();
  try {
    const changed = db.prepare("UPDATE contact_tags SET name=?,updated_at=datetime('now') WHERE id=? AND status='active'").run(name, id);
    if (!changed.changes) return null;
    return db.prepare('SELECT id,name,status,created_at,updated_at FROM contact_tags WHERE id=?').get(id);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ContactManagerError('A tag with that name already exists.', 409);
    throw error;
  }
}

export function archiveContactTag(value, archived = true) {
  const id = normalizeTagId(value);
  const db = getDb();
  const status = archived ? 'archived' : 'active';
  const changed = db.prepare("UPDATE contact_tags SET status=?,updated_at=datetime('now') WHERE id=? AND status!=?").run(status, id, status);
  const tag = db.prepare('SELECT id,name,status,created_at,updated_at FROM contact_tags WHERE id=?').get(id);
  return tag ? { tag, changed: changed.changes > 0 } : null;
}

export function getContactTags(value) {
  const leadId = normalizeLeadId(value);
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM leads WHERE id=?').get(leadId)) return null;
  return db.prepare(`
    SELECT t.id, t.name FROM lead_contact_tags lct
    JOIN contact_tags t ON t.id=lct.tag_id
    WHERE lct.lead_id=? AND t.status='active'
    ORDER BY lower(t.name),t.id
  `).all(leadId);
}

export function assignContactTags(value, tagValues = [], createName = '') {
  const leadId = normalizeLeadId(value);
  if (!Array.isArray(tagValues)) throw new ContactManagerError('Tag ids must be an array.');
  if (tagValues.length > MAX_CONTACT_TAGS) throw new ContactManagerError(`Assign at most ${MAX_CONTACT_TAGS} tags at a time.`);
  const tagIds = [...new Set(tagValues.map(normalizeTagId))];
  const newName = typeof createName === 'string' && createName.trim() ? normalizeTagName(createName) : null;
  const db = getDb();

  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM leads WHERE id=?').get(leadId)) throw new ContactManagerError('Contact not found.', 404);
    let createdTagId = null;
    if (newName) {
      const existing = db.prepare('SELECT id,status FROM contact_tags WHERE name=?').get(newName);
      if (existing?.status === 'archived') throw new ContactManagerError('That tag is archived. Restore it before assigning it.', 409);
      if (existing) createdTagId = existing.id;
      else createdTagId = Number(db.prepare('INSERT INTO contact_tags(name) VALUES (?)').run(newName).lastInsertRowid);
      tagIds.push(createdTagId);
    }
    const uniqueIds = [...new Set(tagIds)];
    const active = uniqueIds.length
      ? db.prepare(`SELECT id FROM contact_tags WHERE status='active' AND id IN (${uniqueIds.map(() => '?').join(',')})`).all(...uniqueIds).map(row => row.id)
      : [];
    if (active.length !== uniqueIds.length) throw new ContactManagerError('One or more tags are missing or archived.', 409);

    const previous = db.prepare(`
      SELECT lct.tag_id FROM lead_contact_tags lct JOIN contact_tags t ON t.id=lct.tag_id
      WHERE lct.lead_id=? AND t.status='active' ORDER BY lct.tag_id
    `).all(leadId).map(row => row.tag_id);
    db.prepare(`DELETE FROM lead_contact_tags WHERE lead_id=? AND tag_id IN (SELECT id FROM contact_tags WHERE status='active')`).run(leadId);
    const insert = db.prepare('INSERT OR IGNORE INTO lead_contact_tags(lead_id,tag_id) VALUES (?,?)');
    for (const tagId of uniqueIds) insert.run(leadId, tagId);

    const current = [...uniqueIds].sort((a, b) => a - b);
    const before = [...previous].sort((a, b) => a - b);
    if (current.length !== before.length || current.some((id, index) => id !== before[index])) {
      db.prepare(`INSERT INTO events(lead_id,event_type,event_at,meta_json)
        VALUES (?,'contact_tags_updated',datetime('now'),?)`).run(leadId, JSON.stringify({ previousTagIds: before, tagIds: current }));
    }
    return {
      tags: getContactTags(leadId),
      createdTagId,
      added: current.filter(id => !before.includes(id)).length,
      removed: before.filter(id => !current.includes(id)).length,
    };
  })();
}

export function assignContactTagsToMany(leadValues = [], tagValues = []) {
  if (!Array.isArray(leadValues)) throw new ContactManagerError('Contact ids must be an array.');
  if (!leadValues.length) throw new ContactManagerError('Select at least one contact.');
  if (leadValues.length > MAX_BULK_TAG_CONTACTS) {
    throw new ContactManagerError(`Assign tags to at most ${MAX_BULK_TAG_CONTACTS} contacts at a time.`);
  }
  if (!Array.isArray(tagValues)) throw new ContactManagerError('Tag ids must be an array.');
  if (!tagValues.length) throw new ContactManagerError('Select at least one active tag.');
  if (tagValues.length > MAX_CONTACT_TAGS) throw new ContactManagerError(`Assign at most ${MAX_CONTACT_TAGS} tags at a time.`);

  const leadIds = [...new Set(leadValues.map(normalizeLeadId))];
  const tagIds = [...new Set(tagValues.map(normalizeTagId))].sort((a, b) => a - b);
  const db = getDb();

  return db.transaction(() => {
    const existingLeads = db.prepare(`SELECT id FROM leads WHERE id IN (${leadIds.map(() => '?').join(',')})`)
      .all(...leadIds).map(row => row.id);
    if (existingLeads.length !== leadIds.length) {
      throw new ContactManagerError('The contact selection is stale or contains a missing contact. Refresh the list and select contacts again.', 409);
    }

    const activeTags = db.prepare(`SELECT id FROM contact_tags WHERE status='active' AND id IN (${tagIds.map(() => '?').join(',')})`)
      .all(...tagIds).map(row => row.id);
    if (activeTags.length !== tagIds.length) {
      throw new ContactManagerError('One or more tags are missing or archived. Refresh the active tag list and try again.', 409);
    }

    const insert = db.prepare('INSERT OR IGNORE INTO lead_contact_tags(lead_id,tag_id) VALUES (?,?)');
    const addEvent = db.prepare(`INSERT INTO events(lead_id,event_type,event_at,meta_json)
      VALUES (?,'contact_tags_updated',datetime('now'),?)`);
    let changedContacts = 0;
    let assignmentsAdded = 0;
    for (const leadId of leadIds) {
      const addedTagIds = [];
      for (const tagId of tagIds) {
        if (insert.run(leadId, tagId).changes) addedTagIds.push(tagId);
      }
      if (!addedTagIds.length) continue;
      changedContacts++;
      assignmentsAdded += addedTagIds.length;
      addEvent.run(leadId, JSON.stringify({ source: 'bulk', tagIds: addedTagIds }));
    }

    return { selected: leadIds.length, changedContacts, assignmentsAdded, tagIds };
  })();
}
