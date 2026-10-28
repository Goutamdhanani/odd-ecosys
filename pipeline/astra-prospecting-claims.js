import { createResearchClaim } from './astra-claims.js';
import { resolveCurrentResearchClaims } from './astra-current-claims.js';
import { getResearchEvidence } from './astra-evidence.js';

function blocked(message, code = 'prospect_campaign_proof_unavailable') {
  return Object.assign(new Error(message), { name: 'AstraProspectingError', statusCode: 409, code, publicMessage: message });
}

/** Match complete literal words, never a country code embedded in another word. */
export function literalProspectFact(text, requested, { plural = false } = {}) {
  if (typeof text !== 'string' || typeof requested !== 'string' || !requested.trim()) return null;
  const parts = requested.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (plural) parts[parts.length - 1] = parts.at(-1).replace(/s$/i, '') + 's?';
  const match = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${parts.join('\\s+')})(?=$|[^\\p{L}\\p{N}])`, 'iu').exec(text);
  if (!match) return null;
  const start = match.index + match[0].length - match[1].length;
  return { value: match[1], exactExcerpt: text.slice(Math.max(0, start - 65), start + match[1].length + 90) };
}

/** Transfer saved website facts to the existing claim contract; never fabricate ISO-code proof. */
export async function prepareProspectCampaignClaims(db, actor, { contact, job }, {
  readEvidence = getResearchEvidence, readClaims = resolveCurrentResearchClaims, createClaim = createResearchClaim,
  now = () => new Date(),
} = {}) {
  if (!actor?.tenantId || contact?.tenantId !== actor.tenantId || job?.tenantId !== actor.tenantId
    || contact.jobId !== job.id || contact.qualification?.status !== 'qualified') {
    throw blocked('This workspace has no qualified saved prospect for that request.', 'prospect_not_found');
  }
  const sourceIds = [...new Set((contact.contact?.research?.opportunities || []).map(item => item.sourceEvidenceId).filter(Boolean))];
  if (sourceIds.length !== 1) throw blocked('The saved prospect needs one unambiguous research source.');
  const evidence = await readEvidence(db, actor.tenantId, sourceIds[0]);
  const accountId = contact.contact?.crm?.accountId;
  const account = accountId && await db.query('SELECT normalized_domain FROM astra.research_accounts WHERE tenant_id=$1 AND id=$2::uuid', [actor.tenantId, accountId]);
  if (!evidence?.sourceRightsUsable || !account?.rows[0] || account.rows[0].normalized_domain !== evidence.normalizedDomain) {
    throw blocked('The saved business and its current source rights could not be verified.');
  }
  // Serialize repeated customer clicks without creating duplicate proof records.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`prospect-claims:${actor.tenantId}:${accountId}`]);
  const current = await readClaims(db, { tenantId: actor.tenantId, subjectKey: evidence.normalizedDomain });
  const expiry = Math.min(now().valueOf() + 7 * 86400_000,
    evidence.rightsExpiresAt ? new Date(evidence.rightsExpiresAt).valueOf() : Infinity,
    new Date(job.payload?.sourceRights?.rightsExpiresAt).valueOf());
  if (!Number.isFinite(expiry) || expiry <= now().valueOf()) throw blocked('Research source permission expired. Refresh approved evidence before campaign preparation.');
  const requests = [['industry', job.payload.category, true], ['country', job.payload.country, false]];
  const claims = [], blockers = [];
  for (const [predicate, requested, plural] of requests) {
    const fact = literalProspectFact(evidence.extractedText, requested, { plural });
    if (!fact) { blockers.push(`${predicate}_literal_source_fact_missing`); continue; }
    const valid = current.filter(item => item.valid && item.predicate === predicate);
    if (valid.length) {
      // Existing/corrected facts belong to their owner. Do not silently replace them.
      const values = new Set(valid.map(item => item.value.toLocaleLowerCase()));
      if (values.size !== 1 || !values.has(fact.value.toLocaleLowerCase())) { blockers.push(`${predicate}_existing_claim_requires_review`); continue; }
      claims.push({ claimId: valid[0].claimId, predicate, value: valid[0].value, replayed: true });
      continue;
    }
    const claim = await createClaim(db, actor, { evidenceId: evidence.id, contentSha256: evidence.contentSha256,
      subjectKey: evidence.normalizedDomain, predicate, value: fact.value, exactExcerpt: fact.exactExcerpt,
      expiresAt: new Date(expiry).toISOString() });
    if (claim.status !== 'supported') { blockers.push(`${predicate}_${claim.abstainReason || 'proof_unavailable'}`); continue; }
    claims.push({ claimId: claim.id, predicate, value: claim.value, replayed: false });
  }
  return { accountId, sourceEvidenceId: evidence.id, claims, blockers, ready: blockers.length === 0 && claims.length === 2,
    noCampaignApproval: true, noSend: true };
}
