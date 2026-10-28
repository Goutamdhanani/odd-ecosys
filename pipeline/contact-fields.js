const FIELD_TYPES = new Set(['text', 'number', 'date', 'boolean', 'select']);
const MAX_FIELDS = 30;

export class ContactFieldError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ContactFieldError';
    this.statusCode = statusCode;
  }
}

function positiveId(value, label = 'Field id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ContactFieldError(`${label} must be a positive integer.`);
  return id;
}

function fieldKey(name) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function normalizeOptions(type, input) {
  if (type !== 'select') {
    if (input !== undefined && input !== null && input !== '') throw new ContactFieldError('Only select fields can have options.');
    return [];
  }
  if (!Array.isArray(input) || input.length < 2 || input.length > 30) {
    throw new ContactFieldError('Select fields need between 2 and 30 options.');
  }
  const options = input.map(value => {
    if (typeof value !== 'string') throw new ContactFieldError('Select options must be text.');
    const option = value.trim();
    if (!option || option.length > 100) throw new ContactFieldError('Select options must be 1–100 characters.');
    return option;
  });
  if (new Set(options.map(value => value.toLocaleLowerCase())).size !== options.length) {
    throw new ContactFieldError('Select options must be unique.');
  }
  return options;
}

function serializeDefinition(row) {
  return row ? {
    id: row.id,
    name: row.name,
    fieldKey: row.field_key,
    type: row.field_type,
    required: Boolean(row.required),
    options: JSON.parse(row.options_json || '[]'),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

export function listContactFieldDefinitions(db, { includeArchived = false } = {}) {
  const rows = db.prepare(`SELECT * FROM contact_field_definitions
    ${includeArchived ? '' : "WHERE status='active'"}
    ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END,sort_order,id`).all();
  return rows.map(serializeDefinition);
}

export function createContactField(db, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContactFieldError('Field definition must be an object.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const type = input.type;
  if (!name || name.length > 50) throw new ContactFieldError('Field name must be 1–50 characters.');
  if (!FIELD_TYPES.has(type)) throw new ContactFieldError('Choose a supported field type.');
  if (typeof input.required !== 'undefined' && typeof input.required !== 'boolean') throw new ContactFieldError('Required must be true or false.');
  const key = fieldKey(name);
  if (!key) throw new ContactFieldError('Field name needs at least one letter or number.');
  const options = normalizeOptions(type, input.options);
  const result = db.transaction(() => {
    const count = db.prepare("SELECT COUNT(*) AS count FROM contact_field_definitions WHERE status='active'").get().count;
    if (count >= MAX_FIELDS) throw new ContactFieldError(`A workspace can have at most ${MAX_FIELDS} active custom fields.`, 409);
    if (db.prepare('SELECT id FROM contact_field_definitions WHERE field_key=?').get(key)) {
      throw new ContactFieldError('A field with that stable key already exists; choose a different name.', 409);
    }
    try {
      const inserted = db.prepare(`INSERT INTO contact_field_definitions(name,field_key,field_type,required,options_json,sort_order)
        VALUES(?,?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM contact_field_definitions),0))`)
        .run(name, key, type, Number(Boolean(input.required)), JSON.stringify(options));
      return db.prepare('SELECT * FROM contact_field_definitions WHERE id=?').get(Number(inserted.lastInsertRowid));
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ContactFieldError('A custom field with that name already exists.', 409);
      throw error;
    }
  })();
  return serializeDefinition(result);
}

export function updateContactField(db, value, updates = {}) {
  const id = positiveId(value);
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new ContactFieldError('Field changes must be an object.');
  const allowed = new Set(['name', 'required', 'options']);
  const unknown = Object.keys(updates).filter(key => !allowed.has(key));
  if (unknown.length) throw new ContactFieldError(`Unsupported field change: ${unknown.join(', ')}.`);
  if (!Object.keys(updates).length) throw new ContactFieldError('Provide a field change.');
  return db.transaction(() => {
    const current = db.prepare("SELECT * FROM contact_field_definitions WHERE id=? AND status='active'").get(id);
    if (!current) return null;
    const name = Object.hasOwn(updates, 'name') ? (typeof updates.name === 'string' ? updates.name.trim() : '') : current.name;
    const required = Object.hasOwn(updates, 'required') ? updates.required : Boolean(current.required);
    const options = Object.hasOwn(updates, 'options') ? normalizeOptions(current.field_type, updates.options) : JSON.parse(current.options_json || '[]');
    if (!name || name.length > 50) throw new ContactFieldError('Field name must be 1–50 characters.');
    if (typeof required !== 'boolean') throw new ContactFieldError('Required must be true or false.');
    if (current.field_type === 'select' && Object.hasOwn(updates, 'options')) {
      const invalid = db.prepare(`SELECT v.value_json FROM lead_custom_field_values v WHERE v.field_id=?`).all(id)
        .some(row => {
          const value = JSON.parse(row.value_json);
          return value !== null && !options.includes(value);
        });
      if (invalid) throw new ContactFieldError('One or more existing values use an option that would be removed.', 409);
    }
    try {
      db.prepare(`UPDATE contact_field_definitions SET name=?,required=?,options_json=?,updated_at=datetime('now') WHERE id=?`)
        .run(name, Number(required), JSON.stringify(options), id);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ContactFieldError('A custom field with that name already exists.', 409);
      throw error;
    }
    return serializeDefinition(db.prepare('SELECT * FROM contact_field_definitions WHERE id=?').get(id));
  }).immediate();
}

export function archiveContactField(db, value) {
  const id = positiveId(value);
  const changed = db.prepare(`UPDATE contact_field_definitions SET status='archived',updated_at=datetime('now')
    WHERE id=? AND status='active'`).run(id);
  return changed.changes ? serializeDefinition(db.prepare('SELECT * FROM contact_field_definitions WHERE id=?').get(id)) : null;
}

function normalizeValue(definition, input) {
  if (input === null || input === undefined || input === '') {
    if (definition.required) throw new ContactFieldError(`${definition.name} is required.`);
    return null;
  }
  if (definition.field_type === 'text') {
    if (typeof input !== 'string' || input.length > 5000) throw new ContactFieldError(`${definition.name} must be text up to 5,000 characters.`);
    const text = input.trim();
    if (!text && definition.required) throw new ContactFieldError(`${definition.name} is required.`);
    return text || null;
  }
  if (definition.field_type === 'number') {
    const number = typeof input === 'number' ? input : (typeof input === 'string' && input.trim() ? Number(input) : NaN);
    if (!Number.isFinite(number) || Math.abs(number) > 1e12) throw new ContactFieldError(`${definition.name} must be a finite number within ±1,000,000,000,000.`);
    return number;
  }
  if (definition.field_type === 'date') {
    if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) throw new ContactFieldError(`${definition.name} must be a valid YYYY-MM-DD date.`);
    const date = new Date(`${input}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input) throw new ContactFieldError(`${definition.name} must be a valid YYYY-MM-DD date.`);
    return input;
  }
  if (definition.field_type === 'boolean') {
    if (input === true || input === 'true') return true;
    if (input === false || input === 'false') return false;
    throw new ContactFieldError(`${definition.name} must be true or false.`);
  }
  const options = JSON.parse(definition.options_json || '[]');
  if (typeof input !== 'string' || !options.includes(input)) throw new ContactFieldError(`${definition.name} must match one of its configured options.`);
  return input;
}

export function normalizeContactFieldFilter(db, keyValue, input, { allowArchived = false } = {}) {
  if (typeof keyValue !== 'string' || !/^[a-z0-9_]{1,40}$/.test(keyValue)) {
    throw new ContactFieldError('Choose a valid custom field.');
  }
  const definition = db.prepare(`SELECT * FROM contact_field_definitions
    WHERE field_key=? ${allowArchived ? '' : "AND status='active'"}`).get(keyValue);
  if (!definition) throw new ContactFieldError('Choose an existing active custom field.');
  const normalized = normalizeValue({ ...definition, required: 0 }, input);
  if (normalized === null) throw new ContactFieldError('Enter a value for the custom field filter.');
  return {
    fieldId: Number(definition.id),
    fieldKey: definition.field_key,
    type: definition.field_type,
    status: definition.status,
    value: normalized,
    valueJson: JSON.stringify(normalized),
  };
}

export function normalizeLeadCustomFieldInput(db, input, { requireAll = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContactFieldError('Custom field values must be an object.');
  const definitions = db.prepare("SELECT * FROM contact_field_definitions WHERE status='active' ORDER BY sort_order,id").all();
  const byKey = new Map(definitions.map(definition => [definition.field_key, definition]));
  const provided = Object.keys(input);
  if (provided.some(key => !byKey.has(key))) throw new ContactFieldError('One or more custom fields are unknown or archived.');
  if (requireAll) {
    const missing = definitions.find(definition => definition.required && !Object.hasOwn(input, definition.field_key));
    if (missing) throw new ContactFieldError(`${missing.name} is required.`);
  }
  return Object.fromEntries(provided.map(key => [key, normalizeValue(byKey.get(key), input[key])]));
}

export function saveLeadCustomFields(db, leadIdValue, input, { requireAll = false } = {}) {
  const leadId = positiveId(leadIdValue, 'Contact id');
  const values = normalizeLeadCustomFieldInput(db, input, { requireAll });
  const definitions = new Map(db.prepare("SELECT id,field_key FROM contact_field_definitions WHERE status='active'").all()
    .map(definition => [definition.field_key, definition]));
  const changed = [];
  const select = db.prepare('SELECT value_json FROM lead_custom_field_values WHERE lead_id=? AND field_id=?');
  const upsert = db.prepare(`INSERT INTO lead_custom_field_values(lead_id,field_id,value_json,updated_at)
    VALUES(?,?,?,datetime('now')) ON CONFLICT(lead_id,field_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`);
  const remove = db.prepare('DELETE FROM lead_custom_field_values WHERE lead_id=? AND field_id=?');
  for (const [key, value] of Object.entries(values)) {
    const definition = definitions.get(key);
    const encoded = value === null ? null : JSON.stringify(value);
    const old = select.get(leadId, definition.id)?.value_json ?? null;
    if (old === encoded) continue;
    if (encoded === null) remove.run(leadId, definition.id);
    else upsert.run(leadId, definition.id, encoded);
    changed.push(key);
  }
  return changed;
}

export function listLeadCustomFields(db, leadIdValue) {
  const leadId = positiveId(leadIdValue, 'Contact id');
  return db.prepare(`SELECT f.name,f.field_key,f.field_type,f.required,f.options_json,f.status,v.value_json
    FROM contact_field_definitions f LEFT JOIN lead_custom_field_values v ON v.field_id=f.id AND v.lead_id=?
    ORDER BY f.sort_order,f.id`).all(leadId).map(row => ({
    name: row.name,
    fieldKey: row.field_key,
    type: row.field_type,
    required: Boolean(row.required),
    options: JSON.parse(row.options_json || '[]'),
    status: row.status,
    value: row.value_json === null ? null : JSON.parse(row.value_json),
  }));
}
