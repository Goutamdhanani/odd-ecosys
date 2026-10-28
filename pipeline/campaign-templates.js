import { getDb } from './database.js';

export class CampaignTemplateError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'CampaignTemplateError';
    this.statusCode = statusCode;
  }
}

const TEMPLATE_COLUMNS = `id,name,subject_line AS subjectLine,body_text AS bodyText,status,created_at AS createdAt,updated_at AS updatedAt`;

function normalizeTemplate(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CampaignTemplateError('Template data must be an object.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const subjectLine = typeof input.subjectLine === 'string' ? input.subjectLine : '';
  const bodyText = typeof input.bodyText === 'string' ? input.bodyText : '';
  if (!name) throw new CampaignTemplateError('Template name is required.');
  if (name.length > 120) throw new CampaignTemplateError('Template name must be 120 characters or fewer.');
  if (!subjectLine.trim()) throw new CampaignTemplateError('Template subject cannot be empty.');
  if (subjectLine.length > 998) throw new CampaignTemplateError('Template subject must be 998 characters or fewer.');
  if (!bodyText.trim()) throw new CampaignTemplateError('Template body cannot be empty.');
  if (bodyText.length > 50000) throw new CampaignTemplateError('Template body must be 50,000 characters or fewer.');
  return { name, subjectLine, bodyText };
}

function templateId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new CampaignTemplateError('Template id must be a positive integer.');
  return id;
}

function recordTemplateEvent(db, eventType, templateIdValue, data = {}) {
  db.prepare('INSERT INTO events(event_type,event_at,meta_json) VALUES (?,datetime(\'now\'),?)')
    .run(eventType, JSON.stringify({ template_id: templateIdValue, ...data }));
}

function isUniqueError(error) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export function listCampaignTemplates({ includeArchived = false } = {}) {
  const db = getDb();
  const where = includeArchived ? '' : "WHERE status='active'";
  return db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM campaign_copy_templates ${where} ORDER BY lower(name),id`).all();
}

export function createCampaignTemplate(input) {
  const template = normalizeTemplate(input);
  const db = getDb();
  try {
    return db.transaction(() => {
      const result = db.prepare('INSERT INTO campaign_copy_templates(name,subject_line,body_text) VALUES (?,?,?)')
        .run(template.name, template.subjectLine, template.bodyText);
      const id = Number(result.lastInsertRowid);
      recordTemplateEvent(db, 'campaign_copy_template_created', id, { name: template.name });
      return db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM campaign_copy_templates WHERE id=?`).get(id);
    })();
  } catch (error) {
    if (isUniqueError(error)) throw new CampaignTemplateError('A template with that name already exists.', 409);
    throw error;
  }
}

export function updateCampaignTemplate(value, input) {
  const id = templateId(value);
  const template = normalizeTemplate(input);
  const db = getDb();
  try {
    return db.transaction(() => {
      const current = db.prepare('SELECT id,name,status FROM campaign_copy_templates WHERE id=?').get(id);
      if (!current) throw new CampaignTemplateError('Template not found.', 404);
      if (current.status !== 'active') throw new CampaignTemplateError('Restore an archived template before editing it.', 409);
      db.prepare(`UPDATE campaign_copy_templates SET name=?,subject_line=?,body_text=?,updated_at=datetime('now') WHERE id=?`)
        .run(template.name, template.subjectLine, template.bodyText, id);
      recordTemplateEvent(db, 'campaign_copy_template_updated', id, { name: template.name });
      return db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM campaign_copy_templates WHERE id=?`).get(id);
    })();
  } catch (error) {
    if (isUniqueError(error)) throw new CampaignTemplateError('A template with that name already exists.', 409);
    throw error;
  }
}

export function setCampaignTemplateArchived(value, archived = true) {
  const id = templateId(value);
  const db = getDb();
  return db.transaction(() => {
    const current = db.prepare('SELECT id,name,status FROM campaign_copy_templates WHERE id=?').get(id);
    if (!current) throw new CampaignTemplateError('Template not found.', 404);
    const nextStatus = archived ? 'archived' : 'active';
    if (current.status === nextStatus) return db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM campaign_copy_templates WHERE id=?`).get(id);
    if (!archived) {
      const nameTaken = db.prepare('SELECT id FROM campaign_copy_templates WHERE name=? COLLATE NOCASE AND id<>?').get(current.name, id);
      if (nameTaken) throw new CampaignTemplateError('Cannot restore this template because its name is already in use.', 409);
    }
    db.prepare(`UPDATE campaign_copy_templates SET status=?,updated_at=datetime('now') WHERE id=?`).run(nextStatus, id);
    recordTemplateEvent(db, archived ? 'campaign_copy_template_archived' : 'campaign_copy_template_restored', id, { name: current.name });
    return db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM campaign_copy_templates WHERE id=?`).get(id);
  })();
}
