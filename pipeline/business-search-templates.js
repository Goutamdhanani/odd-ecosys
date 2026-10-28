const MAX_TEMPLATES_PER_USER = 50;
const MAX_NAME_LENGTH = 80;
const MAX_TEMPLATE_LENGTH = 300;
const SUPPORTED_PLACEHOLDERS = new Set(['company', 'category', 'city', 'region', 'country']);

export class BusinessSearchTemplateError extends Error {
  constructor(message, statusCode = 400, code = 'business_search_template_invalid') {
    super(message);
    this.name = 'BusinessSearchTemplateError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function accountIdFor(actor) {
  if (!['owner', 'admin', 'operator'].includes(actor?.role)) {
    throw new BusinessSearchTemplateError('Sign in as an owner, admin or operator to manage search templates.', 403, 'business_search_template_forbidden');
  }
  const id = Number(actor.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new BusinessSearchTemplateError('Your account could not be identified. Sign in again and retry.', 401, 'business_search_template_account_missing');
  }
  return id;
}

function normalizeName(value) {
  if (typeof value !== 'string') throw new BusinessSearchTemplateError('Enter a name for this search template.');
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new BusinessSearchTemplateError(`Template names must be between 1 and ${MAX_NAME_LENGTH} characters.`);
  }
  return name;
}

function normalizeTemplate(value) {
  if (typeof value !== 'string') throw new BusinessSearchTemplateError('Enter a search pattern.');
  const queryTemplate = value.trim().replace(/\s+/g, ' ');
  if (queryTemplate.length < 3 || queryTemplate.length > MAX_TEMPLATE_LENGTH) {
    throw new BusinessSearchTemplateError(`Search patterns must be between 3 and ${MAX_TEMPLATE_LENGTH} characters.`);
  }
  const placeholders = [...queryTemplate.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
  if (!placeholders.length || placeholders.some(value => !SUPPORTED_PLACEHOLDERS.has(value))
    || /[{}]/.test(queryTemplate.replace(/\{[^{}]+\}/g, ''))) {
    throw new BusinessSearchTemplateError('Use at least one supported placeholder: {company}, {category}, {city}, {region}, or {country}.');
  }
  return queryTemplate;
}

function view(row) {
  return { id: Number(row.id), name: row.name, query_template: row.query_template,
    created_at: row.created_at, updated_at: row.updated_at };
}

export function createBusinessSearchTemplates({ db } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('Database is required.');

  function list(actor) {
    const userId = accountIdFor(actor);
    return db.prepare(`SELECT id,name,query_template,created_at,updated_at
      FROM lead_business_search_templates WHERE user_id=? ORDER BY updated_at DESC,id DESC`).all(userId).map(view);
  }

  function save(input = {}, actor, templateId = null) {
    const userId = accountIdFor(actor);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BusinessSearchTemplateError('Enter valid search-template details.');
    }
    const name = normalizeName(input.name);
    const queryTemplate = normalizeTemplate(input.query_template);
    const id = templateId === null ? null : Number(templateId);
    if (id !== null && (!Number.isSafeInteger(id) || id < 1)) {
      throw new BusinessSearchTemplateError('Search template not found.', 404, 'business_search_template_missing');
    }
    try {
      if (id === null) {
        const result = db.transaction(() => {
          const count = Number(db.prepare('SELECT COUNT(*) AS count FROM lead_business_search_templates WHERE user_id=?').get(userId).count);
          if (count >= MAX_TEMPLATES_PER_USER) {
            throw new BusinessSearchTemplateError(`You can save up to ${MAX_TEMPLATES_PER_USER} templates. Delete one before saving another.`, 409, 'business_search_template_limit');
          }
          return db.prepare(`INSERT INTO lead_business_search_templates(user_id,name,query_template)
            VALUES(?,?,?)`).run(userId, name, queryTemplate);
        }).immediate();
        return view(db.prepare(`SELECT id,name,query_template,created_at,updated_at
          FROM lead_business_search_templates WHERE id=? AND user_id=?`).get(Number(result.lastInsertRowid), userId));
      }
      const updated = db.prepare(`UPDATE lead_business_search_templates SET name=?,query_template=?,updated_at=datetime('now')
        WHERE id=? AND user_id=?`).run(name, queryTemplate, id, userId);
      if (!updated.changes) throw new BusinessSearchTemplateError('Search template not found.', 404, 'business_search_template_missing');
      return view(db.prepare(`SELECT id,name,query_template,created_at,updated_at
        FROM lead_business_search_templates WHERE id=? AND user_id=?`).get(id, userId));
    } catch (error) {
      if (error instanceof BusinessSearchTemplateError) throw error;
      if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new BusinessSearchTemplateError('You already have a search template with that name.', 409, 'business_search_template_name_exists');
      }
      throw error;
    }
  }

  function remove(templateIdInput, actor) {
    const userId = accountIdFor(actor);
    const id = Number(templateIdInput);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new BusinessSearchTemplateError('Search template not found.', 404, 'business_search_template_missing');
    }
    const removed = db.prepare('DELETE FROM lead_business_search_templates WHERE id=? AND user_id=?').run(id, userId);
    if (!removed.changes) throw new BusinessSearchTemplateError('Search template not found.', 404, 'business_search_template_missing');
    return { deleted: true, id };
  }

  return { list, save, remove };
}
