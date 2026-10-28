import { AstraTenantContextError } from './astra-tenant-context.js';
import { createAstraInvitationToken, normalizeAstraInvitationEmail } from './astra-invitation-context.js';

function requireObject(value, message = 'Request body must be an object.') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AstraTenantContextError(message, 400, 'invalid_request');
  }
  return value;
}

async function bodyOf(req, context) {
  return requireObject(await context.readJson(req));
}

export function registerAstraMembershipRoutes(registerAstraApiRoute) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('Astra route registration function is required.');
  registerAstraApiRoute({
    method: 'GET',
    path: /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-f-]{36})\/memberships$/i,
    handler: async (_req, _res, context) => {
      const result = await context.db.query(`
        SELECT user_id AS "userId", role, granted_by_user_id AS "grantedByUserId",
               created_at AS "createdAt", revoked_at AS "revokedAt"
        FROM astra.memberships WHERE tenant_id = $1::uuid ORDER BY revoked_at NULLS FIRST, created_at, user_id
      `, [context.actor.tenantId]);
      return { memberships: result.rows };
    },
  });
  registerAstraApiRoute({
    method: 'GET',
    path: /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-f-]{36})\/memberships\/invitations$/i,
    allowedRoles: ['owner', 'admin'],
    handler: async (_req, _res, context) => {
      const result = await context.db.query(`
        SELECT id, email, role, created_by_user_id AS "createdByUserId", created_at AS "createdAt",
               expires_at AS "expiresAt", revoked_at AS "revokedAt", accepted_at AS "acceptedAt"
        FROM astra.invitations WHERE tenant_id = $1::uuid ORDER BY created_at DESC LIMIT 100
      `, [context.actor.tenantId]);
      return { invitations: result.rows };
    },
  });
  registerAstraApiRoute({
    method: 'POST',
    path: /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-f-]{36})\/memberships\/invitations$/i,
    allowedRoles: ['owner', 'admin'],
    handler: async (req, _res, context) => {
      const body = await bodyOf(req, context);
      const days = body.expiresInDays === undefined ? 7 : Number(body.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 7) {
        throw new AstraTenantContextError('Invitation expiry must be between 1 and 7 days.', 400, 'invitation_expiry_invalid');
      }
      const email = normalizeAstraInvitationEmail(body.email);
      const { token, tokenHash } = createAstraInvitationToken();
      // A seven-day deadline is derived by PostgreSQL itself inside
      // create_invitation, avoiding app/database clock skew at the hard cap.
      const expiresAt = days === 7 ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      const result = await context.db.query(
        'SELECT invitation_id AS id, created_at AS "createdAt", expires_at AS "expiresAt" FROM astra.create_invitation($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::timestamptz)',
        [context.actor.tenantId, context.actor.userId, email, body.role, tokenHash, expiresAt],
      );
      if (!result.rows[0]?.id) throw new AstraTenantContextError('Invitation was not created.', 503, 'astra_invitation_create_failed');
      // The raw token is intentionally returned only in this response. It is
      // not stored by the server, logged, or emitted by list endpoints.
      return { status: 201, body: { invitation: result.rows[0], token } };
    },
  });
  registerAstraApiRoute({
    method: 'PATCH',
    path: /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-f-]{36})\/memberships\/(?<targetUserId>[1-9][0-9]{0,39})$/i,
    allowedRoles: ['owner', 'admin'],
    handler: async (req, _res, context) => {
      const body = await bodyOf(req, context);
      const result = await context.db.query('SELECT astra.change_membership_role($1::uuid, $2::text, $3::text, $4::text) AS role',
        [context.actor.tenantId, context.actor.userId, context.params.targetUserId, body.role]);
      return { membership: { tenantId: context.actor.tenantId, userId: context.params.targetUserId, role: result.rows[0]?.role } };
    },
  });
  registerAstraApiRoute({
    method: 'DELETE',
    path: /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-f-]{36})\/memberships\/(?<targetUserId>[1-9][0-9]{0,39})$/i,
    allowedRoles: ['owner', 'admin'],
    handler: async (_req, _res, context) => {
      await context.db.query('SELECT astra.revoke_membership($1::uuid, $2::text, $3::text)',
        [context.actor.tenantId, context.actor.userId, context.params.targetUserId]);
      return { membership: { tenantId: context.actor.tenantId, userId: context.params.targetUserId, revoked: true } };
    },
  });
  registerAstraApiRoute({
    method: 'DELETE',
    path: /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-f-]{36})\/memberships\/invitations\/(?<invitationId>[0-9a-f-]{36})$/i,
    allowedRoles: ['owner', 'admin'],
    handler: async (_req, _res, context) => {
      await context.db.query('SELECT astra.revoke_invitation($1::uuid, $2::text, $3::uuid)',
        [context.actor.tenantId, context.actor.userId, context.params.invitationId]);
      return { invitation: { id: context.params.invitationId, revoked: true } };
    },
  });
}
