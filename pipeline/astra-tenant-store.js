import { Pool } from 'pg';
import {
  AstraTenantContextError,
  createAstraContextProof,
  normalizeAstraTenantId,
  normalizeAstraUserId,
} from './astra-tenant-context.js';
import {
  createAstraInvitationAcceptanceProof,
  createAstraInvitationToken,
  hashAstraInvitationToken,
  normalizeAstraInvitationEmail,
} from './astra-invitation-context.js';

export class AstraTenantStoreError extends Error {
  constructor(message, statusCode = 503, code = 'astra_storage_unavailable') {
    super(message);
    this.name = 'AstraTenantStoreError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function requireTenantName(value) {
  if (typeof value !== 'string') {
    throw new AstraTenantContextError('Tenant name is required.', 400, 'tenant_name_required');
  }
  const name = value.trim();
  if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AstraTenantContextError('Tenant name must be 1–160 printable characters.', 400, 'tenant_name_invalid');
  }
  return name;
}

function authorizationError(error) {
  // The membership function and FORCE RLS both deliberately use SQLSTATE
  // 42501. Translate it without returning database details or object existence.
  if (error?.code === '42501') {
    return new AstraTenantContextError('Tenant was not found.', 404, 'tenant_not_found');
  }
  if (error?.code === '23514' && error?.message === 'the last active tenant owner cannot be removed') {
    return new AstraTenantContextError('The last active tenant owner cannot be removed.', 409, 'last_owner_required');
  }
  return error;
}

export function createAstraTenantStore({ pool = null, connectionString = process.env.ASTRA_DATABASE_URL, contextSecret = process.env.ASTRA_CONTEXT_SECRET } = {}) {
  let ownedPool = null;
  let closed = false;

  function getPool() {
    if (closed) throw new AstraTenantStoreError('Astra storage is closed.');
    if (pool) return pool;
    if (!connectionString) {
      throw new AstraTenantStoreError('Tenant storage is not configured.', 503, 'astra_storage_not_configured');
    }
    if (!ownedPool) {
      ownedPool = new Pool({
        connectionString,
        application_name: 'odd-ecosys-astra',
        max: 5,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 10000,
      });
      // A pool-level error has no request to return it to. Do not print the
      // error object: drivers may include connection details in diagnostics.
      ownedPool.on('error', () => {});
    }
    return ownedPool;
  }

  async function inTransaction(work, targetRole = 'astra_app') {
    if (!['astra_app', 'astra_worker'].includes(targetRole)) {
      throw new AstraTenantStoreError('Tenant database role is invalid.', 503, 'astra_database_role_invalid');
    }
    let client;
    let began = false;
    try {
      client = await getPool().connect();
      const roleCheck = await client.query(`
        SELECT r.rolsuper, r.rolbypassrls,
               pg_catalog.pg_has_role(session_user, 'astra_app', 'MEMBER') AS app_member,
               pg_catalog.pg_has_role(session_user, 'astra_owner', 'MEMBER') AS owner_member,
               pg_catalog.pg_has_role(session_user, 'astra_worker', 'MEMBER') AS worker_member,
               EXISTS (
                 SELECT 1 FROM pg_catalog.pg_roles AS privileged
                 WHERE (privileged.rolsuper OR privileged.rolbypassrls)
                   AND pg_catalog.pg_has_role(session_user, privileged.oid, 'MEMBER')
               ) AS privileged_member
        FROM pg_catalog.pg_roles AS r
        WHERE r.rolname = session_user
      `);
      const login = roleCheck.rows[0];
      const targetMember = targetRole === 'astra_app' ? login?.app_member : login?.worker_member;
      const oppositeMember = targetRole === 'astra_app' ? login?.worker_member : login?.app_member;
      if (!login || login.rolsuper || login.rolbypassrls || login.privileged_member
        || !targetMember || login.owner_member || oppositeMember) {
        throw new AstraTenantStoreError('Tenant storage requires a non-privileged application database role.', 503, 'astra_database_role_invalid');
      }
      await client.query('BEGIN');
      began = true;
      await client.query(`SET LOCAL ROLE ${targetRole}`);
      const result = await work(client);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (client && began) {
        try { await client.query('ROLLBACK'); } catch { /* release discards an unusable connection */ }
      }
      throw authorizationError(error);
    } finally {
      client?.release();
    }
  }

  async function withTenant({ tenantId, userId }, callback) {
    const normalizedTenantId = normalizeAstraTenantId(tenantId);
    const normalizedUserId = normalizeAstraUserId(userId);
    const proof = createAstraContextProof({ tenantId: normalizedTenantId, userId: normalizedUserId, action: 'access', secret: contextSecret });
    if (typeof callback !== 'function') throw new TypeError('withTenant requires a callback.');
    return inTransaction(async client => {
      const result = await client.query(
        'SELECT astra.begin_tenant_context($1::uuid, $2::text, $3::bigint, $4::uuid, $5::text) AS tenant_role',
        [normalizedTenantId, normalizedUserId, proof.expiresAt, proof.nonce, proof.proof],
      );
      const tenantRole = result.rows[0]?.tenant_role;
      if (!tenantRole) throw new AstraTenantContextError('Tenant was not found.', 404, 'tenant_not_found');
      return callback(client, Object.freeze({ tenantId: normalizedTenantId, userId: normalizedUserId, tenantRole }));
    });
  }

  async function withWorkerTenant({ tenantId, userId }, callback) {
    const normalizedTenantId = normalizeAstraTenantId(tenantId);
    const normalizedUserId = normalizeAstraUserId(userId);
    const proof = createAstraContextProof({ tenantId: normalizedTenantId, userId: normalizedUserId, action: 'access', secret: contextSecret });
    if (typeof callback !== 'function') throw new TypeError('withWorkerTenant requires a callback.');
    return inTransaction(async client => {
      const result = await client.query(
        'SELECT astra.begin_tenant_context($1::uuid, $2::text, $3::bigint, $4::uuid, $5::text) AS tenant_role',
        [normalizedTenantId, normalizedUserId, proof.expiresAt, proof.nonce, proof.proof],
      );
      const tenantRole = result.rows[0]?.tenant_role;
      if (!tenantRole) throw new AstraTenantContextError('Tenant was not found.', 404, 'tenant_not_found');
      return callback(client, Object.freeze({ tenantId: normalizedTenantId, userId: normalizedUserId, tenantRole }));
    }, 'astra_worker');
  }

  async function createTenant({ name, userId }) {
    const safeName = requireTenantName(name);
    const normalizedUserId = normalizeAstraUserId(userId);
    const proof = createAstraContextProof({ userId: normalizedUserId, action: 'create_tenant', secret: contextSecret });
    return inTransaction(async client => {
      const result = await client.query(
        'SELECT astra.create_tenant($1::text, $2::text, $3::bigint, $4::uuid, $5::text) AS tenant_id',
        [safeName, normalizedUserId, proof.expiresAt, proof.nonce, proof.proof],
      );
      const tenantId = result.rows[0]?.tenant_id;
      if (typeof tenantId !== 'string') {
        throw new AstraTenantStoreError('Tenant creation did not return an identifier.', 503, 'astra_tenant_create_failed');
      }
      return { tenantId, tenantRole: 'owner' };
    });
  }

  /** Discover only active memberships for the identity signed by this server. */
  async function listMyWorkspaces({ userId }) {
    const normalizedUserId = normalizeAstraUserId(userId);
    return inTransaction(async client => {
      // Bind expiry to the same database clock that will validate it. Using
      // process Date.now() can put a nominal 30-second proof 31 seconds ahead
      // of PostgreSQL across a second boundary or small host clock skew.
      const dbClock = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms');
      const dbNow = Number(dbClock.rows[0]?.now_ms);
      if (!Number.isSafeInteger(dbNow) || dbNow <= 0) {
        throw new AstraTenantStoreError('Workspace discovery clock is unavailable.', 503, 'workspace_discovery_clock_unavailable');
      }
      const proof = createAstraContextProof({
        userId: normalizedUserId, action: 'discover_workspaces', secret: contextSecret, now: dbNow,
      });
      const result = await client.query(
        'SELECT id, name, role, status FROM astra.list_my_workspaces($1::text, $2::bigint, $3::uuid, $4::text)',
        [normalizedUserId, proof.expiresAt, proof.nonce, proof.proof],
      );
      return result.rows;
    });
  }

  async function listMemberships({ tenantId, userId }) {
    return withTenant({ tenantId, userId }, async client => {
      const result = await client.query(`
        SELECT user_id AS "userId", role, granted_by_user_id AS "grantedByUserId",
               created_at AS "createdAt", revoked_at AS "revokedAt"
        FROM astra.memberships WHERE tenant_id = $1::uuid ORDER BY revoked_at NULLS FIRST, created_at, user_id
      `, [normalizeAstraTenantId(tenantId)]);
      return result.rows;
    });
  }

  async function listInvitations({ tenantId, userId }) {
    return withTenant({ tenantId, userId }, async client => {
      const result = await client.query(`
        SELECT id, email, role, created_by_user_id AS "createdByUserId", created_at AS "createdAt",
               expires_at AS "expiresAt", revoked_at AS "revokedAt", accepted_at AS "acceptedAt"
        FROM astra.invitations WHERE tenant_id = $1::uuid ORDER BY created_at DESC LIMIT 100
      `, [normalizeAstraTenantId(tenantId)]);
      return result.rows;
    });
  }

  async function createInvitation({ tenantId, userId, email, role, expiresAt }) {
    const normalizedTenantId = normalizeAstraTenantId(tenantId);
    const normalizedUserId = normalizeAstraUserId(userId);
    const normalizedEmail = normalizeAstraInvitationEmail(email);
    if (!['owner', 'admin', 'operator', 'reviewer'].includes(role)) {
      throw new AstraTenantContextError('Invitation role is invalid.', 400, 'invitation_role_invalid');
    }
    let expiryIso = null;
    if (expiresAt !== undefined && expiresAt !== null) {
      const expiry = new Date(expiresAt);
      if (!Number.isFinite(expiry.valueOf())) {
        throw new AstraTenantContextError('Invitation expiry is invalid.', 400, 'invitation_expiry_invalid');
      }
      expiryIso = expiry.toISOString();
    }
    const { token, tokenHash } = createAstraInvitationToken();
    const row = await withTenant({ tenantId: normalizedTenantId, userId: normalizedUserId }, async client => {
      const result = await client.query(
        'SELECT invitation_id AS id, created_at AS "createdAt", expires_at AS "expiresAt" FROM astra.create_invitation($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::timestamptz)',
        [normalizedTenantId, normalizedUserId, normalizedEmail, role, tokenHash, expiryIso],
      );
      if (!result.rows[0]?.id) throw new AstraTenantStoreError('Invitation was not created.', 503, 'astra_invitation_create_failed');
      return result.rows[0];
    });
    return { invitation: row, token };
  }

  async function changeMembershipRole({ tenantId, userId, targetUserId, role }) {
    const normalizedTenantId = normalizeAstraTenantId(tenantId);
    const normalizedUserId = normalizeAstraUserId(userId);
    const normalizedTarget = normalizeAstraUserId(targetUserId);
    if (!['owner', 'admin', 'operator', 'reviewer'].includes(role)) {
      throw new AstraTenantContextError('Membership role is invalid.', 400, 'membership_role_invalid');
    }
    return withTenant({ tenantId: normalizedTenantId, userId: normalizedUserId }, async client => {
      const result = await client.query('SELECT astra.change_membership_role($1::uuid, $2::text, $3::text, $4::text) AS role',
        [normalizedTenantId, normalizedUserId, normalizedTarget, role]);
      return { tenantId: normalizedTenantId, userId: normalizedTarget, role: result.rows[0]?.role };
    });
  }

  async function revokeMembership({ tenantId, userId, targetUserId }) {
    const normalizedTenantId = normalizeAstraTenantId(tenantId);
    const normalizedUserId = normalizeAstraUserId(userId);
    const normalizedTarget = normalizeAstraUserId(targetUserId);
    await withTenant({ tenantId: normalizedTenantId, userId: normalizedUserId }, async client => {
      await client.query('SELECT astra.revoke_membership($1::uuid, $2::text, $3::text)',
        [normalizedTenantId, normalizedUserId, normalizedTarget]);
    });
    return { tenantId: normalizedTenantId, userId: normalizedTarget, revoked: true };
  }

  async function revokeInvitation({ tenantId, userId, invitationId }) {
    const normalizedTenantId = normalizeAstraTenantId(tenantId);
    const normalizedUserId = normalizeAstraUserId(userId);
    if (typeof invitationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invitationId)) {
      throw new AstraTenantContextError('Invitation was not found or is no longer available.', 404, 'invitation_unavailable');
    }
    await withTenant({ tenantId: normalizedTenantId, userId: normalizedUserId }, async client => {
      await client.query('SELECT astra.revoke_invitation($1::uuid, $2::text, $3::uuid)',
        [normalizedTenantId, normalizedUserId, invitationId]);
    });
    return { id: invitationId, revoked: true };
  }

  async function acceptInvitation({ token, userId, email }) {
    const tokenHash = hashAstraInvitationToken(token);
    const normalizedUserId = normalizeAstraUserId(userId);
    try {
      return await inTransaction(async client => {
        const resolved = await client.query('SELECT astra.prepare_invitation_acceptance($1::text) AS tenant_id', [tokenHash]);
        const tenantId = resolved.rows[0]?.tenant_id;
        if (!tenantId) throw new AstraTenantContextError('Invitation was not found or is no longer available.', 404, 'invitation_unavailable');
        // Use PostgreSQL's clock in this already-verified app-role transaction.
        // The database remains authoritative for its strict 30-second proof TTL.
        const dbClock = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms');
        const dbNow = Number(dbClock.rows[0]?.now_ms);
        if (!Number.isSafeInteger(dbNow) || dbNow <= 0) {
          throw new AstraTenantStoreError('Invitation verifier time is unavailable.', 503, 'invitation_clock_unavailable');
        }
        const boundProof = createAstraInvitationAcceptanceProof({ tokenHash, tenantId, userId: normalizedUserId, email, secret: contextSecret, now: dbNow });
        const result = await client.query(
          'SELECT astra.accept_invitation($1::text, $2::uuid, $3::text, $4::text, $5::bigint, $6::uuid, $7::text) AS role',
          [boundProof.tokenHash, boundProof.tenantId, boundProof.userId, boundProof.emailHash,
            boundProof.expiresAt, boundProof.nonce, boundProof.proof],
        );
        return { tenantId: boundProof.tenantId, tenantRole: result.rows[0]?.role };
      });
    } catch (error) {
      if (error?.code === '42501' || error?.code === 'tenant_not_found') {
        throw new AstraTenantContextError('Invitation was not found or is no longer available.', 404, 'invitation_unavailable');
      }
      throw error;
    }
  }

  async function close() {
    closed = true;
    if (ownedPool) {
      const current = ownedPool;
      ownedPool = null;
      await current.end();
    }
  }

  return Object.freeze({
    withTenant, withWorkerTenant, createTenant, listMyWorkspaces,
    listMemberships, listInvitations, createInvitation, changeMembershipRole,
    revokeMembership, revokeInvitation, acceptInvitation, close,
  });
}
