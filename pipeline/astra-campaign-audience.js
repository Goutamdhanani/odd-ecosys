import { resolveCurrentResearchClaims } from './astra-current-claims.js';
import { readAstraSourceRights } from './astra-source-rights.js';

const PERMITTED_RIGHTS = new Set(['synthetic_fixture','user_provided','licensed','public_terms_permitted']);

/**
 * Validate the saved, approval-hashed qualification against the current proof
 * and exact identity evidence. Qualification receipts are immutable history;
 * they are intentionally never consulted here.
 */
export async function isCurrentAstraQualification(client, tenantId, audienceRow) {
  const { accountId, candidateId, domain, email, emailEvidenceId, emailSourceId, claimRefs } = audienceRow || {};
  if (!accountId || !candidateId || !domain || !email || !emailEvidenceId || !emailSourceId
    || !Array.isArray(claimRefs) || !claimRefs.length) return false;
  const claimIds = claimRefs.map(ref => ref?.claimId).filter(Boolean);
  if (claimIds.length !== claimRefs.length) return false;
  const resolved = await resolveCurrentResearchClaims(client,{tenantId,claimIds});
  if (resolved.length !== claimIds.length) return false;
  const current = new Map(resolved.map(ref => [ref.claimId,ref]));
  for (const prior of claimRefs) {
    const ref=current.get(prior.claimId);
    if (!ref?.valid || ref.subjectKey!==String(domain).toLowerCase() || ref.predicate!==prior.predicate
      || ref.value!==prior.value || ref.proof?.evidenceId!==prior.evidenceId
      || ref.proof?.contentSha256!==prior.contentSha256 || ref.proof?.sourceId!==prior.sourceId
      || ref.proof?.exactExcerpt!==prior.exactExcerpt) return false;
  }
  if (!claimRefs.some(ref=>ref.predicate==='industry') || !claimRefs.some(ref=>ref.predicate==='country')) return false;

  const candidate=await client.query(`SELECT c.normalized_value,c.account_id,c.normalized_domain,c.evidence_id AS candidate_evidence_id,c.exact_excerpt,
      e.source_id AS candidate_source_id,e.normalized_domain AS evidence_domain,e.extracted_text,e.extracted_emails,
      s.normalized_domain AS source_domain,s.rights_policy,s.rights_expires_at,s.robots_allowed,s.rights_attested
    FROM astra.research_identity_candidates c
    JOIN astra.research_evidence e ON(e.tenant_id,e.id)=(c.tenant_id,c.evidence_id)
    JOIN astra.research_sources s ON(s.tenant_id,s.id)=(e.tenant_id,e.source_id)
    WHERE c.tenant_id=$1 AND c.account_id=$2::uuid AND c.id=$3::uuid`,[tenantId,accountId,candidateId]);
  const row=candidate.rows[0];
  const emailRights = row?.candidate_source_id
    ? (await readAstraSourceRights(client,tenantId,[row.candidate_source_id])).get(String(row.candidate_source_id).toLowerCase()) : null;
  return Boolean(row && row.normalized_value===email && row.normalized_domain===String(domain).toLowerCase()
    && row.candidate_evidence_id===emailEvidenceId && row.candidate_source_id===emailSourceId
    && row.evidence_domain===row.normalized_domain && row.source_domain===row.normalized_domain
    && row.extracted_emails?.some(value=>String(value).toLowerCase()===String(email).toLowerCase())
    && row.exact_excerpt?.includes(email) && row.extracted_text?.includes(row.exact_excerpt)
    && row.robots_allowed && row.rights_attested && PERMITTED_RIGHTS.has(row.rights_policy) && emailRights?.usable
    && (!row.rights_expires_at || new Date(row.rights_expires_at).valueOf()>Date.now()));
}

/** Read only the campaign's current approval-bound audience, never receipt rows. */
export async function readCurrentAstraCampaignAudience(client, tenantId, campaignId) {
  const result=await client.query(`SELECT version,audience_snapshot FROM astra.campaigns
    WHERE tenant_id=$1 AND id=$2::uuid`,[tenantId,campaignId]);
  if (!result.rowCount) return null;
  const saved=Array.isArray(result.rows[0].audience_snapshot)?result.rows[0].audience_snapshot:[];
  const rows=[];
  for (const item of saved) {
    const emailRights = item.emailSourceId
      ? (await readAstraSourceRights(client,tenantId,[item.emailSourceId])).get(String(item.emailSourceId).toLowerCase()) : null;
    const row={...item,account_id:item.accountId,candidate_id:item.candidateId,
      normalized_value:item.email,normalized_domain:item.domain,claim_refs:item.claimRefs,
      emailSourceRightsStatus:emailRights?.status || 'unavailable',emailRightsRevokedAt:emailRights?.revokedAt || null,
      emailRightsRevocationEventId:emailRights?.revocationEventId || null,emailRightsRevocationReason:emailRights?.reason || null};
    if (item.status==='fit' && (!emailRights?.usable || !await isCurrentAstraQualification(client,tenantId,item))) {
      row.status='blocked';
      const reason=emailRights?.status==='revoked'?'contact_source_rights_revoked':'qualification_proof_stale';
      row.reasons=[...new Set([...(Array.isArray(item.reasons)?item.reasons:[]),reason])];
      row.current=false;
    } else row.current=item.status==='fit';
    rows.push(row);
  }
  return {campaignVersion:Number(result.rows[0].version),rows};
}

export async function findCurrentAstraCampaignAudienceMember(client, tenantId, campaignId, candidateId) {
  const audience=await readCurrentAstraCampaignAudience(client,tenantId,campaignId);
  return audience?.rows.find(row=>row.candidate_id===candidateId && row.current) || null;
}
