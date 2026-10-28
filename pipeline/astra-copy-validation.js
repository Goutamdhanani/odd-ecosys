import { canonicalJson, sha256 } from './astra-ledger.js';
import { resolveCurrentResearchClaims } from './astra-current-claims.js';
import { readCurrentAstraCampaignAudience } from './astra-campaign-audience.js';

export const ASTRA_COPY_SUBJECT = 'Research note';
const TEMPLATE_PREFIX = 'source-quote-v1:';
const hash = value => sha256(canonicalJson(value));
const iso = value => value == null ? null : new Date(value).toISOString();

function templateFor(claim) {
  if (!claim?.valid || !claim.proof?.sourceUrl || !claim.proof?.contentSha256 || !claim.proof?.exactExcerpt) return null;
  const domain = String(claim.subjectKey || '').toLowerCase();
  const renderedText = `According to ${claim.proof.sourceUrl}, the source states: “${claim.proof.exactExcerpt}”`;
  const templateId = TEMPLATE_PREFIX + hash({ claimId: claim.claimId, domain, renderedText, sourceHash: claim.proof.contentSha256 });
  return { templateId, claimId: claim.claimId, renderedText, placement: 'body', businessDomain: domain,
    source: { evidenceId: claim.proof.evidenceId, sourceId: claim.proof.sourceId, url: claim.proof.sourceUrl,
      hash: claim.proof.contentSha256, expiresAt: iso(claim.expiresAt), exactExcerpt: claim.proof.exactExcerpt,
      rightsPolicy: claim.proof.rightsPolicy, rightsExpiresAt: iso(claim.proof.rightsExpiresAt),
      correctionId: claim.proof.correctionId || null } };
}

/** Templates are built only from current source proof for currently qualified campaign businesses. */
export async function getAstraCopyTemplates(client, { tenantId, campaign }) {
  if (!tenantId || !campaign?.id) return [];
  const audience = await readCurrentAstraCampaignAudience(client, tenantId, campaign.id);
  const domains = [...new Set((audience?.rows || []).filter(row => row.current && row.normalized_domain)
    .map(row => String(row.normalized_domain).toLowerCase()))].sort();
  const templates = [{ templateId: 'subject:research-note-v1', claimId: null, renderedText: ASTRA_COPY_SUBJECT,
    placement: 'subject', businessDomain: null, source: null }];
  for (const domain of domains) {
    const claims = await resolveCurrentResearchClaims(client, { tenantId, subjectKey: domain });
    for (const claim of claims) {
      const template = templateFor(claim);
      if (template) templates.push(template);
    }
  }
  return templates.sort((a, b) => String(a.businessDomain || '').localeCompare(String(b.businessDomain || '')) || String(a.claimId || '').localeCompare(String(b.claimId || '')));
}

const bodyLines = body => typeof body === 'string' && body.length ? body.split('\n') : [];

export function validateAstraCopyAgainstTemplates({ subject, body, claimsMap, templates = [] }) {
  const reasons = [];
  const byId = new Map(templates.map(item => [item.templateId, item]));
  const lines = bodyLines(body);
  const inputMappings = Array.isArray(claimsMap) ? claimsMap : [];
  const mappings = [];
  const proofs = [];
  if (subject !== ASTRA_COPY_SUBJECT) reasons.push('subject_not_supported_template');
  if (!lines.length) reasons.push('body_has_no_supported_template');
  if (String(body || '').includes('\r') || lines.some(line => line.length === 0)) reasons.push('copy_whitespace_or_separator_edited');
  if (!Array.isArray(claimsMap) || inputMappings.length !== lines.length || lines.length > 50) reasons.push('copy_template_coverage_incomplete');
  const used = new Set();
  for (const line of lines) {
    const supplied = inputMappings.find(item => item && item.sentence === line && typeof item.templateId === 'string');
    const template = supplied && byId.get(supplied.templateId);
    if (!template || template.renderedText !== line || template.placement !== 'body' || used.has(template.templateId)
      || !Array.isArray(supplied.claimIds) || supplied.claimIds.length !== 1
      || String(supplied.claimIds[0]).toLowerCase() !== template.claimId.toLowerCase()) {
      reasons.push('copy_contains_unmapped_or_unsupported_text');
      continue;
    }
    used.add(template.templateId);
    mappings.push({ sentence: line, claimIds: [template.claimId], templateId: template.templateId });
    proofs.push({ templateId: template.templateId, claimId: template.claimId, businessDomain: template.businessDomain,
      source: template.source, renderedText: template.renderedText });
  }
  if (new Set(proofs.map(item => item.businessDomain)).size > 1) reasons.push('mixed_business_copy_requires_separate_drafts');
  const uniqueReasons = [...new Set(reasons)];
  return { status: uniqueReasons.length ? 'unverified' : 'verified', eligible: uniqueReasons.length === 0,
    reasons: uniqueReasons, mappings, proofs, templates };
}

/** Build persisted, server-authored copy proof. Client validation/status/proof fields are never read. */
export async function validateAstraCopyDraft(client, { tenantId, campaign, subject, body, claimsMap }) {
  const templates = await getAstraCopyTemplates(client, { tenantId, campaign });
  return validateAstraCopyAgainstTemplates({ subject, body, claimsMap, templates });
}

/** Recheck copy hash, exact full-copy coverage and all current source/business bindings. */
export async function validatePersistedAstraCopy(client, { tenantId, campaign }) {
  const stored = campaign?.claims_map;
  if (!Array.isArray(stored)) return { eligible: false, status: 'unverified', reasons: ['verified_template_proof_missing'] };
  const metadata = stored.filter(item => item && item.kind === 'copy_validation');
  const mappings = stored.filter(item => !item || item.kind !== 'copy_validation');
  const validation = metadata.length === 1 ? metadata[0] : null;
  if (!validation || validation.schemaVersion !== 1 || validation.status !== 'verified' || validation.eligible !== true
    || !Array.isArray(validation.proofs) || validation.subjectHash !== sha256(String(campaign.subject || ''))
    || validation.bodyHash !== sha256(String(campaign.body || ''))) return { eligible: false, status: 'unverified', reasons: ['verified_template_proof_missing'] };
  const expectedHash = sha256(canonicalJson({ subject: campaign.subject, body: campaign.body, claimsMap: stored,
    offerVersionId: Number(campaign.offer_version_id), offerContentHash: campaign.offer_content_hash }));
  if (!campaign.copy_hash || expectedHash !== campaign.copy_hash) return { eligible: false, status: 'unverified', reasons: ['copy_hash_integrity_failed'] };
  const current = await validateAstraCopyDraft(client, { tenantId, campaign, subject: campaign.subject, body: campaign.body, claimsMap: mappings });
  if (!current.eligible || canonicalJson(current.mappings) !== canonicalJson(mappings)
    || canonicalJson(current.proofs) !== canonicalJson(validation.proofs)) {
    return { eligible: false, status: 'unverified', reasons: [...new Set([...current.reasons, 'source_or_business_snapshot_changed'])] };
  }
  return { eligible: true, status: 'verified', reasons: [], proofs: current.proofs };
}
