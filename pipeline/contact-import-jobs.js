import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';
import { getDb } from './database.js';
import { mapCsvRecord } from './csv-importer.js';
import { deduplicateLeads, normalizeDomain, normalizePhone } from './dedup.js';
import { ContactManagerError, prepareImportedContact } from './contact-manager.js';
import { normalizeLeadCustomFieldInput, saveLeadCustomFields } from './contact-fields.js';

const CHUNK_BYTES = 256 * 1024;
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_STAGED_STORAGE_BYTES = 512 * 1024 * 1024;
const MAX_IMPORT_ROWS = 250_000;
const PROCESS_BATCH_ROWS = 100;
const MAX_RECORD_BYTES = 1024 * 1024;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ContactImportJobError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ContactImportJobError';
    this.statusCode = statusCode;
  }
}

function normalizeId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ContactImportJobError('Import id must be a positive integer.');
  return id;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function publicJob(row) {
  if (!row) return null;
    const progress = row.status === 'uploading'
    ? Math.floor((row.upload_offset / row.expected_bytes) * 100)
    : row.total_rows > 0 ? Math.floor((row.row_cursor / row.total_rows) * 100) : (row.status === 'completed' ? 100 : 0);
  return {
    id: row.id,
    batchId: row.batch_id,
    fileName: row.file_name,
    fileBytes: row.expected_bytes,
    uploadedBytes: row.upload_offset,
    status: row.status,
    progress: Math.max(0, Math.min(100, progress)),
    processedRows: row.row_cursor,
    totalRows: row.total_rows,
    counts: { inserted: row.inserted_count, duplicates: row.duplicate_count, invalid: row.invalid_count },
    rejectionCount: row.invalid_count + row.duplicate_count,
    resumable: row.status === 'uploading' || (row.status === 'failed' && Boolean(row.source_sha256)),
    error: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function stagePath(directory, id) {
  return path.join(directory, `${normalizeId(id)}.csv.part`);
}

function parserFor(filePath) {
  return createReadStream(filePath).pipe(parse({
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
    info: true,
    max_record_size: MAX_RECORD_BYTES,
  }));
}

function findDuplicateKey(lead) {
  return normalizeDomain(lead.website_url)
    || normalizePhone(lead.phone)
    || `${lead.business_name}|${lead.city || ''}`.toLowerCase();
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createContactImportJobs({ db = getDb(), directory = null, schedule = callback => setImmediate(callback) } = {}) {
  const stagingDirectory = directory || path.join(path.dirname(process.env.ODD_DB_PATH
    ? path.resolve(process.env.ODD_DB_PATH)
    : path.resolve(__dirname, '..', 'data', 'pipeline.db')), 'contact-imports');
  const active = new Set();
  const uploading = new Set();
  const resumePending = new Set();

  function getJob(id) {
    const row = db.prepare('SELECT * FROM contact_import_jobs WHERE id=?').get(normalizeId(id));
    return publicJob(row);
  }

  function getJobRow(id) {
    return db.prepare('SELECT * FROM contact_import_jobs WHERE id=?').get(normalizeId(id));
  }

  function listJobs(batchValue, limitValue = 20) {
    const batchId = Number(batchValue);
    if (!Number.isSafeInteger(batchId) || batchId < 1) throw new ContactImportJobError('Choose a valid batch.');
    const limit = Math.min(50, Math.max(1, Number.parseInt(limitValue, 10) || 20));
    return db.prepare(`SELECT * FROM contact_import_jobs WHERE batch_id=? ORDER BY id DESC LIMIT ?`)
      .all(batchId, limit).map(publicJob);
  }

  function createJob(input = {}) {
    const batchId = Number(input.batch_id);
    const size = Number(input.file_bytes);
    const filename = typeof input.file_name === 'string' ? path.basename(input.file_name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) : '';
    const requestKey = typeof input.request_key === 'string' ? input.request_key.trim() : '';
    const columnMap = input.columnMap;
    if (!Number.isSafeInteger(batchId) || batchId < 1) throw new ContactImportJobError('Choose an existing open batch.');
    if (!Number.isSafeInteger(size) || size < 1) throw new ContactImportJobError('CSV file size is invalid.');
    if (size > MAX_IMPORT_BYTES) throw new ContactImportJobError('CSV files are limited to 100 MB.', 413);
    if (!filename || filename.length > 180) throw new ContactImportJobError('CSV filename is invalid.');
    if (!/^[a-z\d][a-z\d._:-]{7,99}$/i.test(requestKey)) throw new ContactImportJobError('Import request key is invalid.');
    if (!columnMap || typeof columnMap !== 'object' || Array.isArray(columnMap)
      || !Object.hasOwn(columnMap, 'business_name') || typeof columnMap.business_name !== 'string' || !columnMap.business_name) {
      throw new ContactImportJobError('Map a CSV column to Business name before importing.');
    }
    if (JSON.stringify(columnMap).length > 8192 || Object.keys(columnMap).length > 50
      || Object.entries(columnMap).some(([key, value]) => !/^[a-z\d_]{1,50}$/.test(key) || typeof value !== 'string' || value.length > 200)) {
      throw new ContactImportJobError('CSV column mapping is invalid.');
    }
    const batch = db.prepare('SELECT id,status FROM batches WHERE id=?').get(batchId);
    if (!batch) throw new ContactImportJobError('Batch not found.', 404);
    if (batch.status !== 'open') throw new ContactImportJobError('Contacts can only be imported into an open batch.', 409);
    const activeCustomFields = db.prepare("SELECT field_key,required FROM contact_field_definitions WHERE status='active'").all();
    const activeCustomKeys = new Set(activeCustomFields.map(field => field.field_key));
    const mappedCustomKeys = Object.keys(columnMap).filter(key => key.startsWith('custom__')).map(key => key.slice('custom__'.length));
    if (mappedCustomKeys.some(key => !activeCustomKeys.has(key))) {
      throw new ContactImportJobError('CSV mapping refers to an unknown or archived custom field. Refresh the mapping and try again.');
    }
    const unmappedRequired = activeCustomFields.find(field => field.required && !columnMap[`custom__${field.field_key}`]);
    if (unmappedRequired) {
      throw new ContactImportJobError(`Map a CSV column to required custom field "${unmappedRequired.field_key}" before importing.`);
    }
    const existing = db.prepare('SELECT * FROM contact_import_jobs WHERE request_key=?').get(requestKey);
    if (existing) {
      if (existing.batch_id !== batchId || existing.expected_bytes !== size || existing.file_name !== filename
        || existing.column_map_json !== JSON.stringify(columnMap)) {
        throw new ContactImportJobError('This import request key already belongs to a different file or mapping.', 409);
      }
      return publicJob(existing);
    }
    const stagedBytes = db.prepare(`SELECT COALESCE(SUM(expected_bytes),0) AS total FROM contact_import_jobs
      WHERE status IN ('uploading','validating','queued','processing') OR (status='failed' AND source_sha256 IS NOT NULL)`).get().total;
    if (stagedBytes + size > MAX_STAGED_STORAGE_BYTES) {
      throw new ContactImportJobError('Local import staging is full. Finish or cancel an existing import before starting another.', 409);
    }
    const result = db.prepare(`INSERT INTO contact_import_jobs(batch_id,request_key,file_name,expected_bytes,column_map_json)
      VALUES(?,?,?,?,?)`).run(batchId, requestKey, filename, size, JSON.stringify(columnMap));
    return getJob(Number(result.lastInsertRowid));
  }

  function queueValidation(id) {
    const changed = db.prepare(`UPDATE contact_import_jobs SET status='validating',updated_at=datetime('now')
      WHERE id=? AND status='uploading' AND upload_offset=expected_bytes`).run(id);
    if (changed.changes) schedule(() => { void validateAndQueue(id); });
  }

  async function uploadChunk(idValue, { start, end, total, bytes }) {
    const id = normalizeId(idValue);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > CHUNK_BYTES) throw new ContactImportJobError('Import chunks must be between 1 and 256 KB.', 413);
    const job = getJobRow(id);
    if (!job) throw new ContactImportJobError('Import job not found.', 404);
    if (job.status !== 'uploading') throw new ContactImportJobError(`Import is ${job.status} and cannot accept upload chunks.`, 409);
    if (uploading.has(id)) throw new ContactImportJobError('Another chunk upload is already in progress for this import.', 409);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)
      || total !== job.expected_bytes || end - start + 1 !== bytes.length || end >= total
      || start % CHUNK_BYTES !== 0 || (bytes.length !== CHUNK_BYTES && end !== total - 1)) {
      throw new ContactImportJobError('Chunk range does not match the import size or fixed chunk boundary.');
    }
    uploading.add(id);
    try {
      const digest = hash(bytes);
      if (start < job.upload_offset) {
        const old = db.prepare('SELECT byte_length,sha256 FROM contact_import_chunks WHERE job_id=? AND byte_offset=?').get(id, start);
        if (!old || old.byte_length !== bytes.length || old.sha256 !== digest) {
          throw new ContactImportJobError('Resumed upload does not match bytes already received for this import.', 409);
        }
        if (job.upload_offset === job.expected_bytes) queueValidation(id);
        return { job: getJob(id), replayed: true };
      }
      if (start !== job.upload_offset) throw new ContactImportJobError(`Upload must continue at byte ${job.upload_offset}.`, 409);
      await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
      const destination = stagePath(stagingDirectory, id);
      let handle;
      try {
        try { handle = await open(destination, fsConstants.O_RDWR); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          handle = await open(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600);
        }
        // A process crash can leave a fsynced tail whose database offset did
        // not commit; truncate back to the durable database offset before append.
        await handle.truncate(job.upload_offset);
        await handle.write(bytes, 0, bytes.length, start);
        await handle.sync();
      } finally {
        await handle?.close();
      }
      const commitChunk = db.transaction(() => {
        const current = db.prepare('SELECT status,upload_offset FROM contact_import_jobs WHERE id=?').get(id);
        if (!current || current.status !== 'uploading' || current.upload_offset !== start) {
          throw new ContactImportJobError('Import upload state changed before this chunk committed.', 409);
        }
        db.prepare('INSERT INTO contact_import_chunks(job_id,byte_offset,byte_length,sha256) VALUES(?,?,?,?)')
          .run(id, start, bytes.length, digest);
        db.prepare(`UPDATE contact_import_jobs SET upload_offset=?,updated_at=datetime('now') WHERE id=?`)
          .run(end + 1, id);
      });
      try { commitChunk(); }
      catch (error) {
        const handle = await open(destination, 'r+').catch(() => null);
        if (handle) { await handle.truncate(job.upload_offset); await handle.close(); }
        throw error;
      }
      const uploaded = getJob(id);
      if (uploaded.uploadedBytes === uploaded.fileBytes) queueValidation(id);
      return { job: getJob(id), replayed: false };
    } finally {
      uploading.delete(id);
    }
  }

  async function validateAndQueue(id) {
    const row = getJobRow(id);
    if (!row || row.status !== 'validating' || row.upload_offset !== row.expected_bytes) return;
    const filename = stagePath(stagingDirectory, id);
    try {
      const info = await stat(filename);
      if (info.size !== row.expected_bytes) throw new ContactImportJobError('Uploaded CSV size did not match its declared size.');
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(filename)) digest.update(chunk);
      const sourceHash = digest.digest('hex');
      const columnMap = JSON.parse(row.column_map_json);
      let count = 0;
      let headers = null;
      for await (const parsed of parserFor(filename)) {
        const record = parsed.record;
        if (!headers) {
          headers = Object.keys(record);
          if (!headers.length) throw new ContactImportJobError('CSV header row is empty.');
          if (!headers.includes(columnMap.business_name)) throw new ContactImportJobError('The mapped business-name column is missing from the CSV.');
          for (const header of Object.values(columnMap)) {
            if (header && !headers.includes(header)) throw new ContactImportJobError('A mapped CSV column does not exist in the file.');
          }
        }
        count++;
        if (count > MAX_IMPORT_ROWS) throw new ContactImportJobError(`CSV files are limited to ${MAX_IMPORT_ROWS.toLocaleString()} data rows.`, 413);
      }
      if (!headers || count === 0) throw new ContactImportJobError('CSV does not contain any data rows.');
      const queue = db.transaction(() => {
        const current = db.prepare('SELECT cancel_requested,status FROM contact_import_jobs WHERE id=?').get(id);
        if (!current || current.status !== 'validating') return false;
        if (current.cancel_requested) {
          db.prepare(`UPDATE contact_import_jobs SET status='cancelled',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(id);
          return false;
        }
        db.prepare(`UPDATE contact_import_jobs SET source_sha256=?,csv_headers_json=?,total_rows=?,status='queued',updated_at=datetime('now'),error_message=NULL WHERE id=?`)
          .run(sourceHash, JSON.stringify(headers), count, id);
        db.prepare('DELETE FROM contact_import_chunks WHERE job_id=?').run(id);
        return true;
      });
      if (queue()) schedule(() => { void processJob(id); });
      else await removeStagedFile(id);
    } catch (error) {
      const message = error instanceof ContactImportJobError ? error.message : 'CSV could not be parsed. Check its quoting and column mapping.';
      db.prepare(`UPDATE contact_import_jobs SET status='failed',error_message=?,finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
        .run(message.slice(0, 500), id);
      db.prepare('DELETE FROM contact_import_chunks WHERE job_id=?').run(id);
      await removeStagedFile(id);
    }
  }

  function processRows(id, rows, columnMap, startCursor) {
    const transaction = db.transaction(() => {
      const job = db.prepare('SELECT * FROM contact_import_jobs WHERE id=?').get(id);
      if (!job || job.status !== 'processing' || job.cancel_requested) return { cancelled: true };
      const insertLead = db.prepare(`INSERT INTO leads (
        batch_id,business_name,category,address,city,state,country,phone,website_url,facebook_url,email,source,rating,reviews,
        source_details,source_url,consent_recorded_at,consent_method,consent_evidence_url,
        normalized_domain,normalized_phone,status,discovered_at,updated_at
      ) VALUES (${Array(21).fill('?').join(',')}, 'discovered',datetime('now'),datetime('now'))`);
      const insertEmail = db.prepare(`INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary)
        VALUES(?,?,'csv_import','unknown',?)`);
      const insertEvent = db.prepare(`INSERT INTO events(lead_id,event_type,event_at,meta_json)
        VALUES(?,'contact_imported',datetime('now'),?)`);
      const insertRejection = db.prepare(`INSERT OR REPLACE INTO contact_import_rejections(job_id,row_number,reason,fields_json)
        VALUES(?,?,?,?)`);
      const getKey = db.prepare('SELECT 1 FROM contact_import_dedupe_keys WHERE job_id=? AND dedupe_key=?');
      const putKey = db.prepare('INSERT OR IGNORE INTO contact_import_dedupe_keys(job_id,dedupe_key) VALUES(?,?)');
      const checkEmail = db.prepare(`SELECT 1 FROM leads WHERE lower(trim(email))=? UNION ALL
        SELECT 1 FROM lead_emails WHERE lower(trim(email))=? LIMIT 1`);
      const checkSuppression = db.prepare('SELECT 1 FROM suppression_list WHERE lower(trim(email))=? LIMIT 1');
      let inserted = 0, duplicates = 0, invalid = 0;
      for (let index = 0; index < rows.length; index++) {
        const { record, rowNumber } = rows[index];
        let lead = mapCsvRecord(record, columnMap);
        lead._row_number = rowNumber;
        let prepared;
        let customFieldValues;
        try {
          if (!lead.business_name || lead.business_name === 'Unknown') throw new ContactManagerError('Missing business name.');
          prepared = prepareImportedContact(lead);
          const customInput = Object.fromEntries(Object.entries(columnMap)
            .filter(([key]) => key.startsWith('custom__'))
            .map(([key, header]) => [key.slice('custom__'.length), record[header] ?? '']));
          customFieldValues = normalizeLeadCustomFieldInput(db, customInput, { requireAll: true });
        } catch (error) {
          invalid++;
          insertRejection.run(id, rowNumber, String(error.message || 'Invalid row').slice(0, 500), JSON.stringify(record));
          continue;
        }
        const dedupeKey = findDuplicateKey(prepared);
        if (getKey.get(id, dedupeKey)) {
          duplicates++;
          insertRejection.run(id, rowNumber, 'duplicate_within_batch', JSON.stringify(record));
          continue;
        }
        const databaseDuplicate = deduplicateLeads([{ ...prepared }]).duplicates[0];
        if (databaseDuplicate) {
          duplicates++;
          insertRejection.run(id, rowNumber, `duplicate_${databaseDuplicate._dupReason || 'contact'}`, JSON.stringify(record));
          continue;
        }
        const emails = [...new Set([prepared.email, ...prepared._extra_emails].filter(Boolean))];
        if (emails.some(email => checkSuppression.get(email))) {
          invalid++;
          insertRejection.run(id, rowNumber, 'suppressed_email', JSON.stringify(record));
          continue;
        }
        if (emails.some(email => checkEmail.get(email, email))) {
          duplicates++;
          insertRejection.run(id, rowNumber, 'duplicate_email', JSON.stringify(record));
          continue;
        }
        const result = insertLead.run(job.batch_id, prepared.business_name, prepared.category, prepared.address,
          prepared.city, prepared.state, prepared.country, prepared.phone, prepared.website_url, prepared.facebook_url,
          prepared.email, 'csv_import', prepared.rating, prepared.reviews,
          prepared.source_details, prepared.source_url, prepared.consent_recorded_at, prepared.consent_method, prepared.consent_evidence_url,
          normalizeDomain(prepared.website_url), normalizePhone(prepared.phone));
        const leadId = Number(result.lastInsertRowid);
        emails.forEach((email, emailIndex) => insertEmail.run(leadId, email, Number(emailIndex === 0 && email === prepared.email)));
        saveLeadCustomFields(db, leadId, customFieldValues);
        insertEvent.run(leadId, JSON.stringify({ batch_id: job.batch_id, csv_row: rowNumber, import_job_id: id }));
        putKey.run(id, dedupeKey);
        inserted++;
      }
      const lastRecord = startCursor + rows.length;
      db.prepare(`UPDATE contact_import_jobs SET row_cursor=?,inserted_count=inserted_count+?,duplicate_count=duplicate_count+?,
        invalid_count=invalid_count+?,updated_at=datetime('now') WHERE id=?`)
        .run(lastRecord, inserted, duplicates, invalid, id);
      db.prepare('UPDATE batches SET lead_count=(SELECT COUNT(*) FROM leads WHERE batch_id=?) WHERE id=?')
        .run(job.batch_id, job.batch_id);
      return { cancelled: false };
    });
    return transaction();
  }

  async function processJob(idValue) {
    const id = normalizeId(idValue);
    if (active.has(id)) return;
    active.add(id);
    const row = getJobRow(id);
    if (!row || !['queued', 'processing'].includes(row.status)) { active.delete(id); return; }
    if (row.cancel_requested) {
      db.prepare(`UPDATE contact_import_jobs SET status='cancelled',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(id);
      await removeStagedFile(id);
      active.delete(id);
      return;
    }
    db.prepare(`UPDATE contact_import_jobs SET status='processing',updated_at=datetime('now') WHERE id=?`).run(id);
    try {
      const columnMap = JSON.parse(row.column_map_json);
      let ordinal = 0;
      let pending = [];
      for await (const parsed of parserFor(stagePath(stagingDirectory, id))) {
        ordinal++;
        if (ordinal <= row.row_cursor) continue;
        pending.push({ record: parsed.record, rowNumber: Math.max(2, Number(parsed.info.lines) || ordinal + 1) });
        if (pending.length >= PROCESS_BATCH_ROWS) {
          const result = processRows(id, pending, columnMap, ordinal - pending.length);
          pending = [];
          if (result.cancelled) break;
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      if (pending.length) processRows(id, pending, columnMap, ordinal - pending.length);
      const current = getJobRow(id);
      if (current?.cancel_requested) {
        db.prepare(`UPDATE contact_import_jobs SET status='cancelled',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(id);
      } else if (current && current.row_cursor === current.total_rows) {
        db.prepare(`UPDATE contact_import_jobs SET status='completed',finished_at=datetime('now'),updated_at=datetime('now'),error_message=NULL WHERE id=?`).run(id);
      } else if (current && current.status === 'processing') {
        throw new ContactImportJobError('Import stopped before all rows were committed. Resume it to continue.', 409);
      }
      const finished = getJobRow(id);
      if (finished?.status === 'completed' || finished?.status === 'cancelled') {
        db.prepare('DELETE FROM contact_import_chunks WHERE job_id=?').run(id);
        db.prepare('DELETE FROM contact_import_dedupe_keys WHERE job_id=?').run(id);
        await removeStagedFile(id);
      }
    } catch (error) {
      db.prepare(`UPDATE contact_import_jobs SET status='failed',error_message=?,finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
        .run(error instanceof ContactImportJobError ? error.message.slice(0, 500) : 'Import could not be completed. Check local storage and retry from the last saved row.', id);
    } finally {
      active.delete(id);
      if (resumePending.delete(id)) schedule(() => { void processJob(id); });
    }
  }

  async function removeStagedFile(id) {
    try { await unlink(stagePath(stagingDirectory, id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  function cancel(idValue) {
    const id = normalizeId(idValue);
    const row = getJobRow(id);
    if (!row) throw new ContactImportJobError('Import job not found.', 404);
    if (['completed', 'cancelled', 'failed'].includes(row.status)) return getJob(id);
    if (uploading.has(id)) throw new ContactImportJobError('Wait for the current upload chunk to finish, then cancel the import.', 409);
    if (row.status === 'uploading') {
      db.prepare(`UPDATE contact_import_jobs SET status='cancelled',cancel_requested=1,finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(id);
      db.prepare('DELETE FROM contact_import_chunks WHERE job_id=?').run(id);
      void removeStagedFile(id).catch(() => {});
      return getJob(id);
    }
    db.prepare(`UPDATE contact_import_jobs SET cancel_requested=1,updated_at=datetime('now') WHERE id=?`).run(id);
    return getJob(id);
  }

  async function resume(idValue) {
    const id = normalizeId(idValue);
    const row = getJobRow(id);
    if (!row) throw new ContactImportJobError('Import job not found.', 404);
    if (row.status === 'uploading') return getJob(id);
    if (['queued', 'validating', 'processing'].includes(row.status)) return getJob(id);
    if (row.status !== 'failed' || !row.source_sha256) throw new ContactImportJobError('This import cannot be resumed.', 409);
    let digest;
    try {
      const info = await stat(stagePath(stagingDirectory, id));
      if (info.size !== row.expected_bytes) throw new ContactImportJobError('Staged CSV file is incomplete; it cannot be resumed.', 409);
      const hasher = createHash('sha256');
      for await (const chunk of createReadStream(stagePath(stagingDirectory, id))) hasher.update(chunk);
      digest = hasher.digest('hex');
    } catch (error) {
      if (error instanceof ContactImportJobError) throw error;
      throw new ContactImportJobError('Staged CSV file is no longer available; upload it again as a new import.', 409);
    }
    if (digest !== row.source_sha256) throw new ContactImportJobError('Staged CSV integrity check failed; it cannot be resumed.', 409);
    db.prepare(`UPDATE contact_import_jobs SET status='queued',error_message=NULL,finished_at=NULL,updated_at=datetime('now') WHERE id=? AND status='failed'`)
      .run(id);
    if (active.has(id)) resumePending.add(id);
    else schedule(() => { void processJob(id); });
    return getJob(id);
  }

  function rejections(idValue, { limit = 100, offset = 0 } = {}) {
    const id = normalizeId(idValue);
    if (!getJobRow(id)) throw new ContactImportJobError('Import job not found.', 404);
    const safeLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
    const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
    const rows = db.prepare(`SELECT row_number AS row,reason,fields_json FROM contact_import_rejections
      WHERE job_id=? ORDER BY row_number LIMIT ? OFFSET ?`).all(id, safeLimit, safeOffset)
      .map(row => ({ row: row.row, reason: row.reason, fields: JSON.parse(row.fields_json) }));
    return { rows, limit: safeLimit, offset: safeOffset, total: db.prepare('SELECT COUNT(*) AS count FROM contact_import_rejections WHERE job_id=?').get(id).count };
  }

  function * rejectionCsv(idValue) {
    const id = normalizeId(idValue);
    const job = getJobRow(id);
    if (!job) throw new ContactImportJobError('Import job not found.', 404);
    const headers = JSON.parse(job.csv_headers_json || '[]');
    yield `\uFEFF${['row', 'reason', ...headers].map(csvCell).join(',')}\r\n`;
    const rows = db.prepare(`SELECT row_number,reason,fields_json FROM contact_import_rejections
      WHERE job_id=? ORDER BY row_number`).iterate(id);
    for (const row of rows) {
      const fields = JSON.parse(row.fields_json);
      yield `${[row.row_number, row.reason, ...headers.map(header => fields[header] ?? '')].map(csvCell).join(',')}\r\n`;
    }
  }

  async function recover() {
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    db.prepare(`UPDATE contact_import_jobs SET status='cancelled',cancel_requested=1,error_message='Upload expired after seven days; select the file and start a new import.',finished_at=datetime('now'),updated_at=datetime('now')
      WHERE status='uploading' AND updated_at < datetime('now','-7 days')`).run();
    db.prepare(`UPDATE contact_import_jobs SET source_sha256=NULL,error_message='Saved import file expired after seven days; start a new import.',finished_at=datetime('now'),updated_at=datetime('now')
      WHERE status='failed' AND source_sha256 IS NOT NULL AND updated_at < datetime('now','-7 days')`).run();
    db.prepare(`UPDATE contact_import_jobs SET status='queued',updated_at=datetime('now') WHERE status='processing' AND cancel_requested=0`).run();
    db.prepare(`UPDATE contact_import_jobs SET status='cancelled',finished_at=datetime('now'),updated_at=datetime('now')
      WHERE status IN ('processing','validating') AND cancel_requested=1`).run();
    const cancelled = db.prepare(`SELECT id FROM contact_import_jobs WHERE status='cancelled' ORDER BY id`).all();
    for (const job of cancelled) {
      await removeStagedFile(job.id);
      db.prepare('DELETE FROM contact_import_chunks WHERE job_id=?').run(job.id);
      db.prepare('DELETE FROM contact_import_dedupe_keys WHERE job_id=?').run(job.id);
    }
    const expiredFailures = db.prepare(`SELECT id FROM contact_import_jobs WHERE status='failed' AND source_sha256 IS NULL ORDER BY id`).all();
    for (const job of expiredFailures) await removeStagedFile(job.id);
    const completeUploads = db.prepare(`SELECT id FROM contact_import_jobs WHERE status='uploading' AND upload_offset=expected_bytes ORDER BY id`).all();
    for (const job of completeUploads) queueValidation(job.id);
    const pending = db.prepare(`SELECT id FROM contact_import_jobs WHERE status='queued' ORDER BY id`).all();
    for (const job of pending) schedule(() => { void processJob(job.id); });
    const validating = db.prepare(`SELECT id FROM contact_import_jobs WHERE status='validating' ORDER BY id`).all();
    for (const job of validating) schedule(() => { void validateAndQueue(job.id); });
  }

  return { createJob, getJob, listJobs, uploadChunk, cancel, resume, rejections, rejectionCsv, recover, chunkBytes: CHUNK_BYTES };
}
