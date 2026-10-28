import { readCommercialGateRegistry, evaluateCommercialGate } from '../tools/astra/commercial-gates.mjs';
import { FREEINFERENCE_CANONICAL_MODEL } from './astra-freeinference-client.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const GLM_PROVIDER = 'glm-5.3-api';
export const GLM_MODEL = 'GLM-5.3';
export const GLM_ENDPOINT = 'https://freeinference.org/v1/chat/completions';
export const GLM_ACTUAL_PROVIDER = 'freeinference';
export const GLM_ACTUAL_MODEL = FREEINFERENCE_CANONICAL_MODEL;

const TASKS = new Set(['personalization_draft', 'subject_polish', 'fact_check', 'campaign_generation', 'reply_classification', 'optimizer_dev_prediction', 'business_research', 'business_goal_planning']);
const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:\+?\d[\d ()-]{7,}\d)\b/,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
];

export class AstraGlmGatewayError extends Error {
  constructor(message, code = 'glm_gateway_unavailable', statusCode = 503) {
    super(message);
    this.name = 'AstraGlmGatewayError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function assertAllowedGlmTask(task) {
  if (!TASKS.has(task)) throw new AstraGlmGatewayError('The requested model task is not allowed.', 'glm_task_forbidden', 400);
  return task;
}

function scrubValue(value, depth = 0) {
  if (depth > 8) throw new AstraGlmGatewayError('Model input exceeds the supported structure.', 'glm_input_invalid', 400);
  if (value === null || typeof value === 'boolean' || Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    if (value.length > 12000 || PII_PATTERNS.some(pattern => pattern.test(value))) {
      throw new AstraGlmGatewayError('Model input contains unsupported personal data or exceeds its limit.', 'glm_input_minimization_required', 400);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new AstraGlmGatewayError('Model input exceeds the supported structure.', 'glm_input_invalid', 400);
    return value.map(item => scrubValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') throw new AstraGlmGatewayError('Model input must be JSON data.', 'glm_input_invalid', 400);
  const entries = Object.entries(value);
  if (entries.length > 80) throw new AstraGlmGatewayError('Model input exceeds the supported structure.', 'glm_input_invalid', 400);
  const output = {};
  for (const [key, item] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || /email|phone|address|contact|name|token|secret|credential|prompt/i.test(key)) {
      throw new AstraGlmGatewayError('Model input contains a field that is not approved for egress.', 'glm_input_minimization_required', 400);
    }
    output[key] = scrubValue(item, depth + 1);
  }
  return output;
}

export function minimizeGlmInput(value, dataClassification = 'unknown') {
  if (!['synthetic-fixture', 'public-business-evidence', 'private', 'confidential', 'regulated', 'unknown'].includes(dataClassification)) {
    throw new AstraGlmGatewayError('Model input data classification is invalid.', 'glm_data_classification_denied', 403);
  }
  return scrubValue(value);
}

export async function assertGlmEgressApproved({ task, dataClassification, gateId = 'glm-api-inference', registryReader = readCommercialGateRegistry, now = new Date(), researchContext = null }) {
  assertAllowedGlmTask(task);
  // The local preview never contacts a provider. A separate, explicitly approved
  // deployment may opt out after its privacy and commercial gates are recorded.
  if (process.env.ASTRA_GLM_LOCAL_PREVIEW !== 'false') {
    throw new AstraGlmGatewayError('GLM egress is disabled in the local preview.', 'glm_local_preview_egress_denied', 503);
  }
  if (process.env.ASTRA_GLM_EGRESS_ENABLED !== 'true') {
    throw new AstraGlmGatewayError('GLM provider egress is disabled by the application gate.', 'glm_egress_disabled', 503);
  }
  if (!process.env.FREEINFERENCE_API_KEY || !process.env.FREEINFERENCE_API_KEY.trim()) {
    throw new AstraGlmGatewayError('The FreeInference provider credential is not configured.', 'glm_credentials_unavailable', 503);
  }
  if (task === 'business_research') {
    await assertBusinessResearchAuthorization(researchContext, dataClassification, now);
    return { provider: GLM_PROVIDER, model: GLM_MODEL, endpoint: GLM_ENDPOINT, purpose: task,
      actualProvider: GLM_ACTUAL_PROVIDER, actualModel: GLM_ACTUAL_MODEL };
  }
  let registry;
  try { registry = await registryReader(); }
  catch { throw new AstraGlmGatewayError('The GLM approval register is unavailable.', 'glm_approval_unavailable', 503); }
  const verdict = evaluateCommercialGate(registry, {
    gateId,
    provider: GLM_PROVIDER,
    model: GLM_MODEL,
    dataClassification,
    now,
  });
  if (!verdict.allowed) {
    throw new AstraGlmGatewayError(`GLM egress is blocked by approval gate: ${verdict.reason}.`, 'glm_approval_denied', 403);
  }
  return { provider: GLM_PROVIDER, model: GLM_MODEL, endpoint: GLM_ENDPOINT, purpose: task,
    actualProvider: GLM_ACTUAL_PROVIDER, actualModel: GLM_ACTUAL_MODEL };
}

// Separate, explicitly scoped nonproduction capability. It does not approve
// private prompts, other model tasks, source access, sending or deployment.
async function assertBusinessResearchAuthorization(context, classification, now) {
  const denied = () => new AstraGlmGatewayError('Business research needs a current, scoped owner authorization.', 'prospecting_ai_approval_required', 403);
  let grant;
  try { grant = JSON.parse(process.env.ASTRA_PROSPECTING_RESEARCH_APPROVAL || 'null'); } catch { throw denied(); }
  if (process.env.ASTRA_INTEGRATION_MODE !== 'prospecting-test' || classification !== 'public-business-evidence'
    || !context || context.sourceRightsUsable !== true || context.snapshotVerified !== true
    || grant?.status !== 'approved' || grant.provider !== GLM_ACTUAL_PROVIDER || grant.model !== GLM_ACTUAL_MODEL
    || grant.operation !== 'business_research' || grant.environment !== 'isolated-integration'
    || !Array.isArray(grant.tenantIds) || !grant.tenantIds.includes(context.tenantId)
    || !Array.isArray(grant.sourceOrigins) || !grant.sourceOrigins.includes(context.sourceOrigin)
    || !Number.isInteger(grant.maxRequests) || grant.maxRequests < 1 || grant.maxRequests > 6
    || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now.valueOf()
    || !Number.isFinite(Date.parse(grant.approvedAt)) || Date.parse(grant.approvedAt) > now.valueOf()
    || typeof grant.referencePath !== 'string' || !/^[a-f0-9]{64}$/.test(grant.referenceSha256 || '')) throw denied();
  let evidence;
  try { evidence = await readFile(grant.referencePath); } catch { throw denied(); }
  if (createHash('sha256').update(evidence).digest('hex') !== grant.referenceSha256) throw denied();
}

export async function getGlmEgressGateStatus({ registryReader = readCommercialGateRegistry, now = new Date() } = {}) {
  if (process.env.ASTRA_GLM_LOCAL_PREVIEW !== 'false') return { enabled: false, blocker: 'local_preview_egress_denied' };
  if (process.env.ASTRA_GLM_EGRESS_ENABLED !== 'true') return { enabled: false, blocker: 'application_egress_disabled' };
  if (!process.env.FREEINFERENCE_API_KEY?.trim()) return { enabled: false, blocker: 'provider_credentials_unavailable' };
  let registry;
  try { registry = await registryReader(); }
  catch { return { enabled: false, blocker: 'approval_register_unavailable' }; }
  const verdict = evaluateCommercialGate(registry, {
    gateId: 'glm-api-inference',
    provider: GLM_PROVIDER, model: GLM_MODEL, dataClassification: 'synthetic-fixture', now,
  });
  return verdict.allowed
    ? { enabled: true, blocker: null, logicalProvider: GLM_PROVIDER, logicalModel: GLM_MODEL,
      actualProvider: GLM_ACTUAL_PROVIDER, actualModel: GLM_ACTUAL_MODEL, endpoint: GLM_ENDPOINT }
    : { enabled: false, blocker: verdict.reason };
}

export { scrubValue as sanitizeGlmInput };
