// Server-owned review records only. Customer goal text cannot attest rights.
// These records do not replace source-collection approvals or live-run budgets.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = new Set(['tenantId', 'status', 'targetIndustry', 'country', 'city',
  'rightsEvidenceReference', 'robotsEvidenceReference', 'rightsReviewedAt', 'rightsExpiresAt',
  'rightsAttested', 'robotsAllowed']);

function label(value, max) {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim().replace(/\s+/g, ' ').toLowerCase() : null;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value ? date.valueOf() : null;
}

function reference(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 500
    && !/[\u0000-\u001f\u007f]|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value);
}

export function createAstraGoalSourceRightsResolver({ env = process.env, now = Date.now } = {}) {
  return async function resolveSourceRights({ actor, plan }) {
    if (!UUID.test(actor?.tenantId || '') || !plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
    const industry = label(plan.targetIndustry, 80), country = label(plan.country, 2), city = label(plan.city || '', 80);
    if (!industry || !country || !/^[a-z]{2}$/.test(country) || city === null) return null;
    const raw = env.ASTRA_GOAL_SOURCE_RIGHTS_JSON;
    if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw, 'utf8') > 65_536) return null;
    let registry;
    try { registry = JSON.parse(raw); } catch { return null; }
    if (!registry || typeof registry !== 'object' || Array.isArray(registry) || registry.version !== 1
      || Object.keys(registry).some(key => !['version', 'grants'].includes(key))
      || !Array.isArray(registry.grants) || registry.grants.length > 100) return null;
    const clock = Number(now());
    if (!Number.isFinite(clock)) return null;
    const matches = registry.grants.filter(grant => grant && typeof grant === 'object' && !Array.isArray(grant)
      && UUID.test(grant.tenantId || '') && grant.tenantId.toLowerCase() === actor.tenantId.toLowerCase()
      && label(grant.targetIndustry, 80) === industry && label(grant.country, 2) === country
      && label(grant.city || '', 80) === city);
    // Duplicate matching records are ambiguous even if one is expired/revoked.
    if (matches.length !== 1) return null;
    const grant = matches[0], reviewed = timestamp(grant.rightsReviewedAt), expires = timestamp(grant.rightsExpiresAt);
    if (Object.keys(grant).some(key => !FIELDS.has(key)) || grant.status !== 'approved' || grant.rightsAttested !== true || grant.robotsAllowed !== true
      || reviewed === null || expires === null || reviewed > clock || expires <= clock || expires <= reviewed
      || !reference(grant.rightsEvidenceReference) || !reference(grant.robotsEvidenceReference)) return null;
    return Object.freeze({
      rightsAttested: true, robotsAllowed: true,
      rightsEvidenceReference: grant.rightsEvidenceReference.trim(),
      robotsEvidenceReference: grant.robotsEvidenceReference.trim(),
      rightsExpiresAt: grant.rightsExpiresAt,
    });
  };
}
