import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.NODE_ENV = 'production';
delete process.env.APP_URL;
delete process.env.ODD_PUBLIC_BASE_URL;
delete process.env.COMPANY_PHYSICAL_ADDRESS;
delete process.env.COMPLIANCE_SECRET;

const compliance = await import('../pipeline/compliance.js');

test('missing public HTTPS unsubscribe URL and business mailing address block compliant sending', () => {
  const readiness = compliance.getComplianceReadiness();
  assert.equal(readiness.ok, false);
  assert.deepEqual(readiness.blockers.sort(), [
    'https_unsubscribe_endpoint_not_configured',
    'physical_mailing_address_not_configured',
  ]);
  assert.deepEqual(compliance.buildComplianceEnvelope('person@example.test', 1), {
    ok: false,
    blockers: ['https_unsubscribe_endpoint_not_configured', 'physical_mailing_address_not_configured'],
  });
});

test('a known historical default signing key cannot forge a legacy unsubscribe token', () => {
  const email = 'person@example.test';
  const leadId = 1;
  const legacyHash = createHash('sha256')
    .update(`${email}:${leadId}:oddecosys-compliance-secret-key-2026`)
    .digest('hex').slice(0, 16);
  const knownDefaultToken = Buffer.from(`${email}:${leadId}:${legacyHash}`).toString('base64url');
  assert.deepEqual(compliance.verifyUnsubscribeToken(knownDefaultToken), { valid: false, email: null, leadId: null });
});

test('a configured HTTPS origin and non-placeholder mailing address make the compliance gate ready', () => {
  process.env.APP_URL = 'https://mail.example.test';
  process.env.COMPANY_PHYSICAL_ADDRESS = '18 Harbor Road, Example City, ZZ 00001';
  const readiness = compliance.getComplianceReadiness();
  assert.equal(readiness.ok, true);
  assert.deepEqual(readiness.blockers, []);
  assert.equal(readiness.unsubscribeEndpointConfigured, true);
  assert.equal(readiness.physicalAddressConfigured, true);
});
