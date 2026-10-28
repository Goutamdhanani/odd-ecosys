const TRUE_SIGNALS = new Set([true, 1]);

function isTrue(...values) {
  return values.some(value => TRUE_SIGNALS.has(value));
}

/**
 * Project legacy saved results through the current mailbox-evidence policy
 * without changing the stored result or its provenance.
 */
export function deriveVerificationClassification(storedStatus, result = {}) {
  const status = ['deliverable', 'risky', 'undeliverable', 'unknown'].includes(storedStatus)
    ? storedStatus
    : 'unknown';
  if (status !== 'risky' || !result || typeof result !== 'object') {
    return { status, adjustment: null };
  }

  const evidence = result.verification_evidence && typeof result.verification_evidence === 'object'
    ? result.verification_evidence : null;
  const attributes = result.attributes && typeof result.attributes === 'object' ? result.attributes : {};
  const reason = result.general?.reason || result.reason || '';
  const hasExplicitRisk = isTrue(
    result.is_disposable, result.is_role_account, result.is_catch_all,
    attributes.disposable, attributes.role, attributes.accept_all, attributes.mailbox_full,
    evidence?.disposable, evidence?.role_account,
  ) || evidence?.disposable_status === 'known_disposable'
    || evidence?.provider_verdict === 'risky'
    || result.reacher?.is_reachable === 'risky'
    || evidence?.smtp_status === 'catch_all'
    || evidence?.smtp_status === 'full_inbox';
  const isFreeProvider = isTrue(result.is_free_provider, attributes.free);
  const completeUnversionedLegacyEvidence = evidence
    && !Object.hasOwn(evidence, 'schema_version')
    && evidence.syntax_status === 'valid'
    && evidence.dns_status === 'mail_route_present'
    && typeof evidence.provider === 'string'
    && evidence.provider.trim() !== ''
    && evidence.provider !== 'unknown'
    && evidence.smtp_status === 'not_attempted'
    && evidence.mailbox_status === 'unconfirmed'
    && evidence.disposable_status === 'not_in_checked_list'
    && evidence.disposable_evidence_source === 'local_known_domain_list'
    && evidence.role_account === false
    && evidence.disposable === false
    && (evidence.verifier_engine === 'local_dns' || result.engine === 'local_dns')
    && (evidence.provider_verdict === null || evidence.provider_verdict === undefined)
    && result.checks?.regex === true
    && result.checks?.mx === true;
  const onlyUnconfirmedProviderRoute = (evidence?.schema_version === 1
    && evidence.mailbox_status === 'unconfirmed'
    && evidence.dns_status === 'mail_route_present'
    || completeUnversionedLegacyEvidence)
    && isFreeProvider
    && !hasExplicitRisk
    && /\bmail route\s*[·—–-]\s*mailbox unconfirmed\b/i.test(String(reason));

  return onlyUnconfirmedProviderRoute
    ? { status: 'unknown', adjustment: 'legacy_free_provider_risky' }
    : { status, adjustment: null };
}
