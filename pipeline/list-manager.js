import { getDb } from './database.js';

const MAX_LIST_NAME = 120;
const MAX_DESCRIPTION = 1000;
const MAX_MEMBERS_PER_REQUEST = 500;

export class ListManagerError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ListManagerError';
    this.statusCode = statusCode;
  }
}

function normalizeListId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ListManagerError('List id must be a positive integer.');
  return id;
}

function listProjection(where = '') {
  return `
    SELECT l.*,
      (SELECT COUNT(*) FROM contact_list_members m WHERE m.list_id = l.id) AS contact_count
    FROM contact_lists l ${where}
  `;
}

export function listContactLists({ includeArchived = true, search = '', limit = 100, offset = 0 } = {}) {
  const db = getDb();
  const predicates = [];
  const values = [];
  if (!includeArchived) predicates.push("l.status = 'active'");
  if (search) {
    predicates.push('(l.name LIKE ? OR l.description LIKE ?)');
    values.push(`%${search}%`, `%${search}%`);
  }
  const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
  const count = db.prepare(`SELECT COUNT(*) AS total FROM contact_lists l ${where}`).get(...values).total;
  const items = db.prepare(`${listProjection(where)} ORDER BY CASE l.status WHEN 'active' THEN 0 ELSE 1 END, l.name COLLATE NOCASE, l.id LIMIT ? OFFSET ?`)
    .all(...values, limit, offset);
  return { items, pagination: { total: count, limit, offset, hasMore: offset + items.length < count } };
}

export function getContactList(value) {
  const db = getDb();
  return db.prepare(listProjection('WHERE l.id = ?')).get(normalizeListId(value)) || null;
}

export function exportContactList(value) {
  const db = getDb();
  const id = normalizeListId(value);
  const list = getContactList(id);
  if (!list) return null;
  const rows = db.prepare(`
    SELECT l.id AS contact_id, l.business_name, l.email,
      COALESCE((SELECT le.verification_status FROM lead_emails le
        WHERE le.lead_id = l.id AND lower(trim(le.email)) = lower(trim(l.email))
        ORDER BY le.is_primary DESC, le.id DESC LIMIT 1), 'unknown') AS verification_status,
      l.category, l.city, l.country, l.phone, l.website_url, l.status, m.added_at
    FROM contact_list_members m
    JOIN leads l ON l.id = m.lead_id
    WHERE m.list_id = ?
    ORDER BY l.business_name COLLATE NOCASE, l.id
  `).iterate(id);
  return { list, rows };
}

export function csvCell(value) {
  let text = String(value ?? '');
  // Spreadsheet programs evaluate cells beginning with these characters.
  // Prefix an apostrophe so exported contact data stays inert when opened.
  if (/^[\u0000-\u0020]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createContactList({ name, description = '' } = {}) {
  const db = getDb();
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) throw new ListManagerError('List name is required.');
  if (cleanName.length > MAX_LIST_NAME) throw new ListManagerError(`List name must be ${MAX_LIST_NAME} characters or fewer.`);
  if (typeof description !== 'string') throw new ListManagerError('Description must be text.');
  const cleanDescription = description.trim();
  if (cleanDescription.length > MAX_DESCRIPTION) throw new ListManagerError(`Description must be ${MAX_DESCRIPTION} characters or fewer.`);
  const result = db.prepare('INSERT INTO contact_lists (name, description) VALUES (?, ?)').run(cleanName, cleanDescription);
  return getContactList(result.lastInsertRowid);
}

export function updateContactList(value, updates = {}) {
  const db = getDb();
  const id = normalizeListId(value);
  const current = getContactList(id);
  if (!current) return null;

  const fields = [];
  const values = [];
  if (Object.hasOwn(updates, 'name')) {
    const name = typeof updates.name === 'string' ? updates.name.trim() : '';
    if (!name) throw new ListManagerError('List name is required.');
    if (name.length > MAX_LIST_NAME) throw new ListManagerError(`List name must be ${MAX_LIST_NAME} characters or fewer.`);
    fields.push('name = ?'); values.push(name);
  }
  if (Object.hasOwn(updates, 'description')) {
    if (typeof updates.description !== 'string') throw new ListManagerError('Description must be text.');
    const description = updates.description.trim();
    if (description.length > MAX_DESCRIPTION) throw new ListManagerError(`Description must be ${MAX_DESCRIPTION} characters or fewer.`);
    fields.push('description = ?'); values.push(description);
  }
  if (Object.hasOwn(updates, 'status')) {
    if (!['active', 'archived'].includes(updates.status)) throw new ListManagerError('List status must be active or archived.');
    fields.push('status = ?'); values.push(updates.status);
  }
  if (fields.length === 0) throw new ListManagerError('Provide a list name, description, or status to update.');

  fields.push("updated_at = datetime('now')");
  db.prepare(`UPDATE contact_lists SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
  return getContactList(id);
}

export function listContactListMembers(value, { search = '', limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const id = normalizeListId(value);
  if (!getContactList(id)) return null;
  const predicates = ['m.list_id = ?'];
  const values = [id];
  if (search) {
    predicates.push('(l.business_name LIKE ? OR l.email LIKE ? OR l.city LIKE ?)');
    const term = `%${search}%`;
    values.push(term, term, term);
  }
  const where = predicates.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS total FROM contact_list_members m JOIN leads l ON l.id = m.lead_id WHERE ${where}`).get(...values).total;
  const items = db.prepare(`
    SELECT l.id, l.business_name, l.email, l.city, l.country, l.status, l.discovered_at, m.added_at
    FROM contact_list_members m JOIN leads l ON l.id = m.lead_id
    WHERE ${where}
    ORDER BY l.business_name COLLATE NOCASE, l.id
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset);
  return { items, pagination: { total, limit, offset, hasMore: offset + items.length < total } };
}

export function addContactsToList(value, requestedIds) {
  const db = getDb();
  const id = normalizeListId(value);
  const target = getContactList(id);
  if (!target) throw new ListManagerError('List not found.', 404);
  if (target.status !== 'active') throw new ListManagerError('Archived lists cannot accept new contacts.', 409);
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) throw new ListManagerError('Select at least one contact.');
  if (requestedIds.length > MAX_MEMBERS_PER_REQUEST) throw new ListManagerError(`Add at most ${MAX_MEMBERS_PER_REQUEST} contacts per request.`);
  const ids = [...new Set(requestedIds.map(value => {
    const leadId = Number(value);
    if (!Number.isSafeInteger(leadId) || leadId < 1) throw new ListManagerError('Contact ids must be positive integers.');
    return leadId;
  }))];
  const placeholders = ids.map(() => '?').join(', ');

  return db.transaction(() => {
    const found = db.prepare(`SELECT id FROM leads WHERE id IN (${placeholders})`).all(...ids).map(row => row.id);
    if (found.length !== ids.length) {
      const missing = ids.filter(leadId => !found.includes(leadId));
      throw new ListManagerError(`Contact not found: ${missing.join(', ')}. No contacts were added.`, 404);
    }
    const insert = db.prepare('INSERT OR IGNORE INTO contact_list_members (list_id, lead_id) VALUES (?, ?)');
    let added = 0;
    for (const leadId of ids) added += insert.run(id, leadId).changes;
    return { listId: id, added, alreadyMember: ids.length - added, contactCount: getContactList(id).contact_count };
  })();
}

export function removeContactFromList(value, leadValue) {
  const db = getDb();
  const id = normalizeListId(value);
  const leadId = Number(leadValue);
  if (!Number.isSafeInteger(leadId) || leadId < 1) throw new ListManagerError('Contact id must be a positive integer.');
  if (!getContactList(id)) throw new ListManagerError('List not found.', 404);
  const result = db.prepare('DELETE FROM contact_list_members WHERE list_id = ? AND lead_id = ?').run(id, leadId);
  if (!result.changes) throw new ListManagerError('Contact is not a member of this list.', 404);
  return { listId: id, leadId, removed: true, contactCount: getContactList(id).contact_count };
}
