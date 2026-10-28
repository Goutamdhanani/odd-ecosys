import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase32, encodeBase32, totpCode, verifyTotpCode } from '../pipeline/totp.js';

test('RFC 6238 SHA-1 TOTP vectors match all published 8-digit examples', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const cases = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of cases) {
    assert.equal(totpCode(secret, seconds * 1000, { digits: 8 }), expected);
  }
});

test('base32 round-trips authenticator secrets and verification enforces the time window and replay counter', () => {
  const raw = Buffer.from('odd-ecosys-test-secret-2026', 'utf8');
  const encoded = encodeBase32(raw);
  assert.deepEqual(decodeBase32(encoded), raw);
  assert.deepEqual(decodeBase32(`${encoded.slice(0, 4)} ${encoded.slice(4)}=`), raw);
  const timestamp = 1_800_000_000_000;
  const code = totpCode(raw, timestamp);
  assert.equal(verifyTotpCode(raw, code, { timestampMs: timestamp }), Math.floor(timestamp / 30_000));
  assert.equal(verifyTotpCode(raw, code, { timestampMs: timestamp, lastCounter: Math.floor(timestamp / 30_000) }), null);
  assert.equal(verifyTotpCode(raw, code, { timestampMs: timestamp + 90_000 }), null);
});
