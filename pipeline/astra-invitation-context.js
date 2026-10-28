import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AstraTenantContextError, normalizeAstraTenantId, normalizeAstraUserId } from './astra-tenant-context.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeAstraInvitationEmail(value) {
  if (typeof value !== 'string') {
    throw new AstraTenantContextError('A valid invitation email is required.', 400, 'invitation_email_invalid');
  }
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || /[\u0000-\u0020\u007f]/.test(email)
    || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    throw new AstraTenantContextError('A valid invitation email is required.', 400, 'invitation_email_invalid');
  }
  return email;
}

export function createAstraInvitationToken() {
  const token = randomBytes(32).toString('base64url');
  return Object.freeze({ token, tokenHash: createHash('sha256').update(token, 'utf8').digest('hex') });
}

export function hashAstraInvitationToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new AstraTenantContextError('Invitation was not found or is no longer available.', 404, 'invitation_unavailable');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashAstraInvitationEmail(email) {
  return createHash('sha256').update(normalizeAstraInvitationEmail(email), 'utf8').digest('hex');
}

/** Bind a 30-second proof to every value resolved from trusted session + token. */
export function createAstraInvitationAcceptanceProof({ tokenHash, tenantId, userId, email, secret, now = Date.now() }) {
  if (typeof tokenHash !== 'string' || !HASH_PATTERN.test(tokenHash)) {
    throw new AstraTenantContextError('Invitation was not found or is no longer available.', 404, 'invitation_unavailable');
  }
  const normalizedTenantId = normalizeAstraTenantId(tenantId);
  const normalizedUserId = normalizeAstraUserId(userId);
  const emailHash = hashAstraInvitationEmail(email);
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new AstraTenantContextError('Tenant invitation signing is not configured.', 503, 'tenant_context_signing_unavailable');
  }
  const expiresAt = Math.floor(now / 1000) + 30;
  const nonce = randomUUID();
  const message = `accept_invitation\n${tokenHash}\n${normalizedTenantId}\n${normalizedUserId}\n${emailHash}\n${expiresAt}\n${nonce}`;
  const proof = createHmac('sha256', Buffer.from(secret, 'utf8')).update(message, 'utf8').digest('hex');
  return Object.freeze({ tokenHash, tenantId: normalizedTenantId, userId: normalizedUserId, emailHash, expiresAt, nonce, proof });
}
