import { readAstraSourceRights } from './astra-source-rights.js';

/**
 * Resolve a claim to the exact evidence and source that currently support it.
 * Corrections are append-only; equal newest timestamps are intentionally
 * ambiguous and never ordered by their random UUIDs.
 */
export async function resolveCurrentResearchClaims(client, { tenantId, subjectKey = null, claimIds = null }) {
  if (!Array.isArray(claimIds) && (typeof subjectKey !== 'string' || !subjectKey)) return [];
  const filters = [];
  const values = [tenantId];
  if (Array.isArray(claimIds)) {
    values.push([...new Set(claimIds)]);
    filters.push(`c.id=ANY($${values.length}::uuid[])`);
  }
  if (subjectKey !== null) {
    values.push(String(subjectKey).trim().toLowerCase());
    filters.push(`c.subject_key=$${values.length}`);
  }
  const result = await client.query(`SELECT
      c.id AS claim_id,c.subject_key,c.predicate,c.claim_value,c.exact_excerpt AS claim_excerpt,
      c.content_sha256 AS claim_sha256,c.evidence_id AS claim_evidence_id,c.expires_at,c.status,c.created_at AS claim_created_at,
      latest.id AS correction_id,latest.correction_type,latest.replacement_value,latest.evidence_id AS corrected_evidence_id,
      latest.content_sha256 AS corrected_sha256,latest.exact_excerpt AS corrected_excerpt,
      latest.created_at AS corrected_at,COALESCE(latest.latest_count,0)::int AS latest_count,
      effective.id AS proof_evidence_id,effective.content_sha256 AS proof_sha256,
      effective.extracted_text AS proof_text,effective.normalized_domain AS proof_domain,
      proof_source.id AS proof_source_id,proof_source.source_url AS proof_source_url,
      proof_source.normalized_domain AS proof_source_domain,proof_source.rights_policy AS proof_rights_policy,
      proof_source.rights_expires_at AS proof_rights_expires_at,
      proof_source.robots_allowed AS proof_robots_allowed,proof_source.rights_attested AS proof_rights_attested
    FROM astra.research_claims c
    LEFT JOIN LATERAL (
      SELECT x.id,x.correction_type,x.replacement_value,x.evidence_id,x.content_sha256,x.exact_excerpt,x.created_at,
        COUNT(*) OVER() AS latest_count
      FROM astra.research_claim_corrections x
      WHERE x.tenant_id=c.tenant_id AND x.claim_id=c.id
        AND x.created_at=(SELECT MAX(newest.created_at) FROM astra.research_claim_corrections newest
          WHERE newest.tenant_id=c.tenant_id AND newest.claim_id=c.id)
    ) latest ON true
    LEFT JOIN astra.research_evidence effective ON (effective.tenant_id,effective.id)=
      (c.tenant_id,CASE WHEN latest.id IS NULL THEN c.evidence_id ELSE latest.evidence_id END)
    LEFT JOIN astra.research_sources proof_source ON (proof_source.tenant_id,proof_source.id)=
      (effective.tenant_id,effective.source_id)
    WHERE c.tenant_id=$1 AND (${filters.join(' OR ')})
    ORDER BY c.predicate,c.created_at DESC,c.id`, values);

  const rights = await readAstraSourceRights(client, tenantId, result.rows.map(row => row.proof_source_id).filter(Boolean));

  const grouped = new Map();
  for (const row of result.rows) {
    const existing = grouped.get(row.claim_id);
    if (existing) {
      existing.ambiguousCorrection = true;
      continue;
    }
    const corrected = row.correction_id !== null;
    const value = corrected ? row.replacement_value : row.claim_value;
    const exactExcerpt = corrected ? row.corrected_excerpt : row.claim_excerpt;
    const contentSha256 = corrected ? row.corrected_sha256 : row.claim_sha256;
    const evidenceId = corrected ? row.corrected_evidence_id : row.claim_evidence_id;
    const blockers = [];
    const sourceRights = row.proof_source_id ? rights.get(String(row.proof_source_id).toLowerCase()) : null;
    if (row.latest_count > 1) blockers.push('latest_correction_timestamp_ambiguous');
    if (row.correction_type === 'retracted') blockers.push('claim_retracted');
    if (row.status !== 'supported') blockers.push('claim_not_supported');
    if (new Date(row.expires_at).valueOf() <= Date.now()) blockers.push('claim_expired');
    if (!row.proof_evidence_id || row.proof_evidence_id !== evidenceId
      || String(row.proof_sha256 || '').trim() !== String(contentSha256 || '').trim()) blockers.push('effective_proof_missing_or_hash_mismatch');
    if (!row.proof_source_id || !row.proof_source_url || row.proof_source_domain !== row.proof_domain) blockers.push('effective_proof_source_mismatch');
    if (row.proof_domain !== row.subject_key || row.proof_source_domain !== row.subject_key) blockers.push('effective_proof_domain_mismatch');
    if (!row.proof_robots_allowed || !row.proof_rights_attested
      || !['synthetic_fixture','user_provided','licensed','public_terms_permitted'].includes(row.proof_rights_policy)) blockers.push('effective_proof_rights_unavailable');
    if (!sourceRights?.usable) blockers.push(sourceRights?.status === 'revoked' ? 'effective_proof_rights_revoked' : 'effective_proof_rights_unavailable');
    if (row.proof_rights_expires_at && new Date(row.proof_rights_expires_at).valueOf() <= Date.now()) blockers.push('effective_proof_rights_expired');
    if (row.proof_rights_expires_at && new Date(row.proof_rights_expires_at).valueOf() < new Date(row.expires_at).valueOf()) blockers.push('effective_proof_rights_shorter_than_claim');
    if (typeof exactExcerpt !== 'string' || !exactExcerpt || !row.proof_text?.includes(exactExcerpt)) blockers.push('effective_proof_excerpt_mismatch');
    if (typeof value !== 'string' || !value || !exactExcerpt?.toLocaleLowerCase().includes(value.toLocaleLowerCase())) blockers.push('effective_proof_value_not_literal');
    const proof = row.proof_evidence_id ? {
      evidenceId: row.proof_evidence_id,
      sourceId: row.proof_source_id,
      sourceUrl: row.proof_source_url,
      domain: row.proof_domain,
      contentSha256: String(row.proof_sha256 || '').trim(),
      exactExcerpt,
      rightsPolicy: row.proof_rights_policy,
      rightsExpiresAt: row.proof_rights_expires_at,
      rightsAttested: row.proof_rights_attested === true,
      robotsAllowed: row.proof_robots_allowed === true,
      sourceRightsStatus: sourceRights?.status || 'unavailable',
      rightsRevokedAt: sourceRights?.revokedAt || null,
      rightsRevocationEventId: sourceRights?.revocationEventId || null,
      rightsRevocationReason: sourceRights?.reason || null,
      correctionId: corrected ? row.correction_id : null,
      correctionType: corrected ? row.correction_type : null,
      correctedAt: corrected ? row.corrected_at : null,
    } : null;
    grouped.set(row.claim_id, {
      claimId: row.claim_id,
      subjectKey: row.subject_key,
      predicate: row.predicate,
      value,
      expiresAt: row.expires_at,
      status: blockers.length ? 'blocked' : 'supported',
      valid: blockers.length === 0,
      blockers,
      proof,
      correctionId: corrected ? row.correction_id : null,
      correctionType: corrected ? row.correction_type : null,
    });
  }
  for (const claim of grouped.values()) {
    if (claim.ambiguousCorrection) {
      claim.valid = false;
      claim.status = 'blocked';
      claim.blockers = [...new Set([...claim.blockers, 'latest_correction_timestamp_ambiguous'])];
      delete claim.ambiguousCorrection;
    }
  }
  return [...grouped.values()];
}

export async function requireCurrentResearchClaims(client, options) {
  return (await resolveCurrentResearchClaims(client, options)).filter(claim => claim.valid);
}

