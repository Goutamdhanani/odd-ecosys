import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeBase32(value) {
  const bytes = Buffer.from(value);
  let output = '';
  let bits = 0;
  let buffer = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value) {
  const normalized = String(value || '').toUpperCase().replace(/[=\s-]/g, '');
  if (!normalized || normalized.length > 128 || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error('Authenticator secret is invalid.');
  }
  const bytes = [];
  let bits = 0;
  let buffer = 0;
  for (const character of normalized) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw new Error('Authenticator secret encoding is invalid.');
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return encodeBase32(randomBytes(20));
}

export function createTotpUri(secret, account, issuer = 'Odd Ecosys') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export function totpCode(secret, timestampMs = Date.now(), { stepSeconds = 30, digits = 6 } = {}) {
  if (!Buffer.isBuffer(secret) || secret.length < 10 || !Number.isFinite(timestampMs)
    || !Number.isInteger(stepSeconds) || stepSeconds < 1 || ![6, 8].includes(digits)) {
    throw new Error('TOTP parameters are invalid.');
  }
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export function verifyTotpCode(secret, value, {
  timestampMs = Date.now(), stepSeconds = 30, window = 1, digits = 6, lastCounter = -1,
} = {}) {
  const code = String(value || '').trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(code) || !Number.isFinite(timestampMs)
    || !Number.isInteger(window) || window < 0 || window > 2) return null;
  const current = Math.floor(timestampMs / 1000 / stepSeconds);
  const supplied = Buffer.from(code);
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = current + delta;
    if (counter <= lastCounter || counter < 0) continue;
    const candidate = Buffer.from(totpCode(secret, counter * stepSeconds * 1000, { stepSeconds, digits }));
    if (candidate.length === supplied.length && timingSafeEqual(candidate, supplied)) return counter;
  }
  return null;
}
