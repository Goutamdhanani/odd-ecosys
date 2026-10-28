import { createHash, createHmac, randomUUID } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_ID_PATTERN = /^[1-9][0-9]{0,39}$/;
const TENANT_ROLES = new Set(['owner', 'admin', 'operator', 'reviewer']);

export class AstraTenantContextError extends Error {
  constructor(message, statusCode = 404, code = 'tenant_context_invalid') {
    super(message);
    this.name = 'AstraTenantContextError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizeAstraTenantId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AstraTenantContextError('Tenant was not found.', 404, 'tenant_not_found');
  }
  return value.toLowerCase();
}

export function normalizeAstraUserId(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !USER_ID_PATTERN.test(text)) {
    throw new AstraTenantContextError('A valid authenticated user is required.', 401, 'authenticated_user_required');
  }
  return text;
}

/** Sign a short-lived, single-use identity assertion for PostgreSQL. */
export function createAstraContextProof({ tenantId = null, userId, action, secret, now = Date.now() }) {
  const normalizedUserId = normalizeAstraUserId(userId);
  const normalizedTenantId = tenantId === null ? '-' : normalizeAstraTenantId(tenantId);
  if (!['access', 'create_tenant', 'discover_workspaces'].includes(action)
    || (action === 'access' && normalizedTenantId === '-')
    || (action !== 'access' && normalizedTenantId !== '-')) {
    throw new AstraTenantContextError('Tenant context action is invalid.', 400, 'tenant_action_invalid');
  }
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new AstraTenantContextError('Tenant context signing is not configured.', 503, 'tenant_context_signing_unavailable');
  }
  const expiresAt = Math.floor(now / 1000) + 30;
  const nonce = randomUUID();
  const message = `${action}\n${normalizedTenantId}\n${normalizedUserId}\n${expiresAt}\n${nonce}`;
  const proof = createHmac('sha256', Buffer.from(secret, 'utf8')).update(message, 'utf8').digest('hex');
  return Object.freeze({ tenantId: normalizedTenantId === '-' ? null : normalizedTenantId, userId: normalizedUserId, action, expiresAt, nonce, proof });
}

/**
 * Build the database identity exclusively from the existing authenticated
 * session. Request headers and body fields are never consulted here.
 */
export function trustedAstraPrincipal(session) {
  if (!session) {
    throw new AstraTenantContextError('Sign-in required.', 401, 'sign_in_required');
  }
  const userId = normalizeAstraUserId(session.id);
  return {
    id: Number(userId),
    userId,
    email: typeof session.email === 'string' ? session.email : null,
    sessionRole: typeof session.role === 'string' ? session.role : null,
  };
}

export function tenantAstraActor(principal, tenantId, tenantRole) {
  const normalizedTenantId = normalizeAstraTenantId(tenantId);
  if (!TENANT_ROLES.has(tenantRole)) {
    throw new AstraTenantContextError('Tenant membership was not found.', 404, 'tenant_membership_not_found');
  }
  return Object.freeze({
    ...principal,
    tenantId: normalizedTenantId,
    tenantRole,
    // Existing domain services commonly consume `role`; within tenant routes
    // it intentionally reflects the verified membership, never the global role.
    role: tenantRole,
  });
}

export function isAstraTenantRole(value) {
  return TENANT_ROLES.has(value);
}
function hashTenantScopedName(namespace, value) {
  if (typeof namespace !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(namespace)) {
    throw new AstraTenantContextError('Tenant namespace is invalid.', 400, 'tenant_namespace_invalid');
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new AstraTenantContextError('Tenant-scoped key is invalid.', 400, 'tenant_key_invalid');
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Return a collision-resistant cache name that cannot cross tenant prefixes. */
export function tenantCacheKey({ tenantId, namespace, key }) {
  const tenant = normalizeAstraTenantId(tenantId);
  return `astra:tenant:${tenant}:${namespace}:${hashTenantScopedName(namespace, key)}`;
}

/** Return an opaque tenant namespace for object storage keys. */
export function tenantObjectKey({ tenantId, namespace = 'objects', key }) {
  const tenant = normalizeAstraTenantId(tenantId);
  const digest = hashTenantScopedName(namespace, key);
  return `tenants/${tenant}/${namespace}/${digest}`;
}

/** Reject a worker payload whose selected job does not match its DB context. */
export function assertAstraTenantJobScope({ tenantId, actorTenantId, userId, actorUserId }) {
  const tenant = normalizeAstraTenantId(tenantId);
  const actorTenant = normalizeAstraTenantId(actorTenantId);
  const user = normalizeAstraUserId(userId);
  const actorUser = normalizeAstraUserId(actorUserId);
  if (tenant !== actorTenant || user !== actorUser) {
    throw new AstraTenantContextError('Tenant job was not found.', 404, 'tenant_job_not_found');
  }
  return Object.freeze({ tenantId: tenant, userId: user });
}

/** Build an immutable caller/export scope to pass to a streaming exporter. */
export function createAstraExportContext({ tenantId, userId, exportId, maxRows }) {
  const tenant = normalizeAstraTenantId(tenantId);
  const user = normalizeAstraUserId(userId);
  if (typeof exportId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(exportId)) {
    throw new AstraTenantContextError('Export was not found.', 404, 'tenant_export_not_found');
  }
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100000) {
    throw new AstraTenantContextError('Export row limit is invalid.', 400, 'tenant_export_limit_invalid');
  }
  return Object.freeze({ tenantId: tenant, userId: user, exportId, maxRows });
}

/** Reject a queued/downloaded export whose scope differs from the auth scope. */
export function assertAstraExportContext(context, { tenantId, userId }) {
  const expectedTenant = normalizeAstraTenantId(tenantId);
  const expectedUser = normalizeAstraUserId(userId);
  const exportTenant = normalizeAstraTenantId(context?.tenantId);
  const exportUser = normalizeAstraUserId(context?.userId);
  if (context?.exportId === undefined || exportTenant !== expectedTenant || exportUser !== expectedUser) {
    throw new AstraTenantContextError('Export was not found.', 404, 'tenant_export_not_found');
  }
  return context;
}

/** Place export artifacts under a tenant-specific, opaque object key. */
export function tenantExportKey({ tenantId, exportId, filename }) {
  const tenant = normalizeAstraTenantId(tenantId);
  if (typeof exportId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(exportId)
    || typeof filename !== 'string' || !filename.trim() || filename.length > 512) {
    throw new AstraTenantContextError('Export object key is invalid.', 400, 'tenant_export_key_invalid');
  }
  const digest = createHash('sha256').update(filename, 'utf8').digest('hex');
  return `tenants/${tenant}/exports/${exportId}/${digest}`;
}
