import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

const GOOGLE_CLIENT_ID_DEFAULT = '714630939237-1be5d3rv8rephvtugp6one5aispfqecg.apps.googleusercontent.com';
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const MAX_JWKS_BYTES = 64 * 1024;

export function getGoogleClientId() {
  if (process.env.ODD_GOOGLE_LOGIN_ENABLED === 'false') return '';
  const configured = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientId = configured || GOOGLE_CLIENT_ID_DEFAULT;
  return /^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(clientId) ? clientId : '';
}

function isAuthoritativeGoogleEmail(payload) {
  const emailDomain = String(payload.email || '').toLowerCase().split('@').at(-1);
  if (emailDomain === 'gmail.com' || emailDomain === 'googlemail.com') return true;
  const hostedDomain = typeof payload.hd === 'string' ? payload.hd.trim().toLowerCase() : '';
  return Boolean(hostedDomain && hostedDomain === emailDomain);
}

function equalNonce(left, right) {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function boundedJwksFetch(fetchImpl, resource, options) {
  const response = await fetchImpl(resource, {
    method: 'GET',
    redirect: 'error',
    headers: options.headers,
    signal: options.signal,
  });
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_JWKS_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Google signing key response exceeded its size limit.');
  }
  if (!response.body) return new Response(null, { status: response.status, headers: response.headers });

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JWKS_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Google signing key response exceeded its size limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Build a Google Identity Services verifier. The caller can inject fetch and
 * time for isolated tests; production always fetches Google's fixed HTTPS JWKS.
 */
export function createGoogleIdTokenVerifier({ clientId = getGoogleClientId(), fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  if (!clientId) throw new Error('Google sign-in is not configured.');
  if (typeof fetchImpl !== 'function') throw new Error('Google signing-key transport is unavailable.');
  const jwks = createRemoteJWKSet(GOOGLE_JWKS_URL, {
    timeoutDuration: 5000,
    cooldownDuration: 30_000,
    cacheMaxAge: 5 * 60_000,
    [customFetch]: (resource, options) => boundedJwksFetch(fetchImpl, resource, options),
  });

  return async function verifyGoogleIdToken(token, nonce) {
    if (typeof token !== 'string' || token.length < 100 || token.length > 16 * 1024) {
      throw new Error('Google sign-in could not be verified.');
    }
    if (typeof nonce !== 'string' || nonce.length < 32 || nonce.length > 128) {
      throw new Error('Google sign-in could not be verified.');
    }
    try {
      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        algorithms: ['RS256'],
        audience: clientId,
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        maxTokenAge: '10m',
        clockTolerance: 30,
        currentDate: now(),
      });
      if (protectedHeader.typ && protectedHeader.typ !== 'JWT') throw new Error('Invalid token type.');
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) throw new Error('Invalid authorized presenter.');
      if (payload.azp && payload.azp !== clientId) throw new Error('Invalid authorized presenter.');
      if (typeof payload.nonce !== 'string' || !equalNonce(payload.nonce, nonce)) throw new Error('Invalid one-time nonce.');
      if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new Error('Invalid subject.');
      if (typeof payload.email !== 'string' || payload.email_verified !== true || !isAuthoritativeGoogleEmail(payload)) {
        throw new Error('Google must verify an authoritative Gmail or Workspace address for this account.');
      }
      return {
        subject: payload.sub,
        email: payload.email.trim().toLowerCase(),
        hostedDomain: typeof payload.hd === 'string' ? payload.hd.toLowerCase() : null,
      };
    } catch {
      throw new Error('Google sign-in could not be verified. Check the Google account and try again.');
    }
  };
}

let defaultVerifier;
export function verifyGoogleIdToken(token, nonce) {
  if (!defaultVerifier) defaultVerifier = createGoogleIdTokenVerifier();
  return defaultVerifier(token, nonce);
}
