import { randomUUID } from 'node:crypto';
import { AstraResearchError, getResearchEvidence, researchSha256 } from './astra-evidence.js';
import { resolveCurrentResearchClaims } from './astra-current-claims.js';
import { readAstraSourceRights } from './astra-source-rights.js';

function required(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new AstraResearchError(`${field} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}

function futureDate(value) {
  const d = new Date(value);
  if (!value || !Number.isFinite(d.valueOf()) || d.valueOf() <= Date.now()) throw new AstraResearchError('expiresAt must be a future ISO-compatible date.');
  return d.toISOString();
}

export async function createResearchClaim(db, actor, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AstraResearchError('Claim must be an object.');
  const evidenceId = required(input.evidenceId, 'evidenceId', 36);
  const subjectKey = required(input.subjectKey, 'subjectKey', 300).toLowerCase();
  const predicate = required(input.predicate, 'predicate', 120).toLowerCase();
  const value = required(input.value, 'value', 2000);
  const excerpt = required(input.exactExcerpt, 'exactExcerpt', 1000);
  const expiresAt = futureDate(input.expiresAt);
  const evidence = await getResearchEvidence(db, actor.tenantId, evidenceId);
  if (!evidence) throw new AstraResearchError('Evidence was not found for this tenant.', 404, 'evidence_not_found');
  const sourceRights = (await readAstraSourceRights(db, actor.tenantId, [evidence.sourceId])).get(String(evidence.sourceId).toLowerCase());
  if (sourceRights?.status === 'revoked') throw new AstraResearchError('Claim proof source rights were revoked.', 403, 'source_rights_revoked');
  if (evidence.normalizedDomain !== subjectKey) throw new AstraResearchError('Claim proof must belong to the exact normalized subject domain.', 409, 'claim_proof_domain_mismatch');
  const excerptExact = evidence.extractedText.includes(excerpt);
  const valueLiteral = excerpt.toLocaleLowerCase().includes(value.toLocaleLowerCase());
  const hashMatches = typeof input.contentSha256 === 'string' && input.contentSha256 === evidence.contentSha256;
  const rightsActive = !evidence.rightsExpiresAt || new Date(evidence.rightsExpiresAt).valueOf() > Date.now();
  const withinRights = !evidence.rightsExpiresAt || new Date(expiresAt).valueOf() <= new Date(evidence.rightsExpiresAt).valueOf();
  let status = 'supported', abstainReason = null;
  if (!excerptExact || !hashMatches) { status = 'abstained'; abstainReason = 'proof_mismatch'; }
  else if (!valueLiteral) { status = 'abstained'; abstainReason = 'claim_value_not_literal_in_excerpt'; }
  else if (!rightsActive || !withinRights || evidence.robotsAllowed !== true || evidence.rightsAttested !== true || !sourceRights?.usable) { status = 'abstained'; abstainReason = sourceRights?.status === 'revoked' ? 'source_rights_revoked' : 'source_rights_expired_or_shorter_than_claim'; }

  let contradiction = null;
  if (status === 'supported') {
    const prior = await db.query(`SELECT id FROM astra.research_claims WHERE tenant_id=$1 AND subject_key=$2 AND predicate=$3 AND status='supported'`,
      [actor.tenantId, subjectKey, predicate]);
    const effective = await resolveCurrentResearchClaims(db, { tenantId: actor.tenantId, claimIds: prior.rows.map(row => row.id) });
    contradiction = effective.find(item => item.valid && item.value !== value) || null;
    if (contradiction) { status = 'abstained'; abstainReason = 'contradictory_active_claim'; }
  }
  const id = randomUUID();
  const r = await db.query(`INSERT INTO astra.research_claims(tenant_id,id,evidence_id,content_sha256,subject_key,predicate,claim_value,exact_excerpt,expires_at,status,abstain_reason,contradicts_claim_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id,evidence_id AS "evidenceId",content_sha256 AS "contentSha256",subject_key AS "subjectKey",predicate,claim_value AS value,exact_excerpt AS "exactExcerpt",expires_at AS "expiresAt",status,abstain_reason AS "abstainReason",contradicts_claim_id AS "contradictsClaimId",created_at AS "createdAt"`,
  [actor.tenantId, id, evidenceId, evidence.contentSha256, subjectKey, predicate, value, excerpt, expiresAt, status, abstainReason, contradiction?.claimId || null]);
  return r.rows[0];
}

export async function correctResearchClaim(db, actor, claimId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AstraResearchError('Correction must be an object.');
  if (!['corrected', 'retracted'].includes(input.correctionType)) throw new AstraResearchError('correctionType must be corrected or retracted.');
  const reason = required(input.reason, 'reason', 1000);
  const replacementValue = input.correctionType === 'corrected' ? required(input.replacementValue, 'replacementValue', 2000) : null;
  const target = await db.query(`SELECT id,subject_key,expires_at AS "expiresAt" FROM astra.research_claims WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, claimId]);
  if (!target.rowCount) throw new AstraResearchError('Claim was not found.', 404, 'claim_not_found');
  let evidenceId = null, contentSha256 = null, exactExcerpt = null;
  if (input.correctionType === 'corrected') {
    evidenceId = required(input.evidenceId, 'evidenceId', 36);
    contentSha256 = required(input.contentSha256, 'contentSha256', 64);
    exactExcerpt = required(input.exactExcerpt, 'exactExcerpt', 1000);
    const evidence = await getResearchEvidence(db, actor.tenantId, evidenceId);
    const sourceRights = evidence
      ? (await readAstraSourceRights(db, actor.tenantId, [evidence.sourceId])).get(String(evidence.sourceId).toLowerCase())
      : null;
    if (!evidence || evidence.normalizedDomain !== target.rows[0].subject_key || evidence.contentSha256 !== contentSha256 || !evidence.extractedText.includes(exactExcerpt)
      || !exactExcerpt.toLocaleLowerCase().includes(replacementValue.toLocaleLowerCase())
      || (evidence.rightsExpiresAt && (new Date(evidence.rightsExpiresAt).valueOf() <= Date.now()
        || new Date(evidence.rightsExpiresAt).valueOf() < new Date(target.rows[0].expiresAt).valueOf()))
      || evidence.robotsAllowed !== true || evidence.rightsAttested !== true || !sourceRights?.usable) {
      throw new AstraResearchError('A corrected value requires same-domain current rights and an exact evidence excerpt that supports the replacement through the claim expiry.', 409, 'correction_proof_invalid');
    }
  }
  const r = await db.query(`INSERT INTO astra.research_claim_corrections(tenant_id,id,claim_id,correction_type,replacement_value,evidence_id,content_sha256,exact_excerpt,reason,created_by,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()) RETURNING id,claim_id AS "claimId",correction_type AS "correctionType",replacement_value AS "replacementValue",evidence_id AS "evidenceId",content_sha256 AS "contentSha256",exact_excerpt AS "exactExcerpt",reason,created_at AS "createdAt"`,
  [actor.tenantId, randomUUID(), claimId, input.correctionType, replacementValue, evidenceId, contentSha256, exactExcerpt, reason, String(actor.userId)]);
  return r.rows[0];
}

export async function listResearchClaims(db, tenantId, { limit = 50 } = {}) {
  const bounded = Math.max(1, Math.min(100, Number(limit) || 50));
  const r = await db.query(`SELECT c.id,c.evidence_id AS "evidenceId",c.content_sha256 AS "contentSha256",c.subject_key AS "subjectKey",c.predicate,
    c.claim_value AS value,c.exact_excerpt AS "exactExcerpt",c.expires_at AS "expiresAt",c.status,c.abstain_reason AS "abstainReason",
    c.contradicts_claim_id AS "contradictsClaimId",c.created_at AS "createdAt"
    FROM astra.research_claims c WHERE c.tenant_id=$1 ORDER BY c.created_at DESC LIMIT $2`, [tenantId, bounded]);
  const current = await resolveCurrentResearchClaims(db, { tenantId, claimIds: r.rows.map(row => row.id) });
  const currentById = new Map(current.map(row => [row.claimId, row]));
  return r.rows.map(row => {
    const effective = currentById.get(row.id);
    return { ...row, latestCorrection: effective?.correctionType || null, currentValue: effective?.value ?? row.value,
      currentClaimStatus: effective?.status || 'blocked', currentClaimBlockers: effective?.blockers || ['current_proof_missing'], currentProof: effective?.proof || null };
  });
}

export { researchSha256 };
