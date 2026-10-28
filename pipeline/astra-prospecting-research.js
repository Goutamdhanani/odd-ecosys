import { runAstraGenerationTask } from './astra-glm-gateway.js';
import { GLM_ACTUAL_MODEL, GLM_ACTUAL_PROVIDER } from './astra-egress.js';

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
const personal = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\d ().-]{7,}\d)|\b(?:Dr\.|Mr\.|Ms\.|Mrs\.)\s+[A-Z]/i;

export function prepareProspectingResearchInput({ job, page }) {
  const fullText = normalize(page?.visibleText);
  const sourceExcerpts = fullText.split(/(?<=[.!?])\s+/).filter(value => value.length >= 20 && value.length <= 320 && !personal.test(value)).slice(0, 8);
  if (!sourceExcerpts.length) throw Object.assign(new Error('No minimized, attributable business excerpt is available.'), { code: 'prospecting_ai_evidence_missing' });
  const input = { industry: normalize(job.payload.category), country: normalize(job.payload.country),
    city: normalize(job.payload.city), objective: normalize(job.payload.goal), sourceExcerpts,
    capturedPageFacts: { hasMetaDescription: Boolean(page.metaDescription), suppliedPageCount: 1,
      visibleCallToActionCount: page.ctas?.length || 0 },
    instructionsForInterpretation: 'Suggest one concise useful business opportunity grounded in an exact supplied excerpt. Keep rationale to one short sentence. Rationale is a review proposal, not a proven need. Do not infer site-wide absence or financial lift. Return no opportunities if the evidence is insufficient.' };
  if (personal.test(JSON.stringify(input))) throw Object.assign(new Error('Research input includes unsupported personal data.'), { code: 'prospecting_ai_minimization_required' });
  return input;
}

export function createAstraProspectingResearch({ env = process.env, runTask = runAstraGenerationTask } = {}) {
  return Object.freeze({
    async analyze({ job, page, evidenceId, sourceEvidence, signal, beforeRequest, onCheckpoint = async () => {} }) {
      if (env.ASTRA_PROSPECTING_RESEARCH_ENABLED !== 'true') return { status: 'blocked', code: 'prospecting_ai_disabled', reason: 'AI research is not enabled for this workspace.', responseVerified: null, opportunities: [] };
      let attempted = false;
      try {
        if (sourceEvidence?.sourceRightsUsable !== true || !sourceEvidence.contentSha256 || typeof beforeRequest !== 'function') {
          throw Object.assign(new Error('Current source rights and a durable request reservation are required.'), { code: 'prospecting_ai_source_or_reservation_missing' });
        }
        const input = prepareProspectingResearchInput({ job, page });
        await beforeRequest();
        const result = await runTask({ task: 'business_research', input, dataClassification: 'public-business-evidence', signal,
          researchContext: { tenantId: job.tenantId, jobId: job.id, sourceOrigin: new URL(page.sourceUrl).origin,
            sourceRightsUsable: true, snapshotVerified: true },
          onDispatch: () => { attempted = true; } });
        const receipt = result.usage || {};
        if (result.responseStatus !== 'verified' || result.actual?.provider !== GLM_ACTUAL_PROVIDER || result.actual?.model !== GLM_ACTUAL_MODEL) {
          throw Object.assign(new Error('Research needs a verified response from the approved model.'), { code: 'prospecting_ai_unverified_response' });
        }
        const opportunities = result.data.opportunities.map(item => {
          const quote = normalize(item.evidenceExcerpt);
          if (!normalize(page.visibleText).includes(quote) || !input.sourceExcerpts.some(excerpt => excerpt.includes(quote))
            || personal.test(JSON.stringify(item)) || [...item.rationale.matchAll(/\d+(?:\.\d+)?/g)].some(match => !quote.includes(match[0]))) {
            throw Object.assign(new Error('The generated opportunity lacks an exact permitted source excerpt.'), { code: 'prospecting_ai_unsupported_claim' });
          }
          return { ...item, evidenceExcerpt: quote, evidenceId, sourceEvidenceId: sourceEvidence.id,
            sourceUrl: page.sourceUrl, kind: 'review_proposal', humanReviewRequired: true };
        });
        const response = { status: 'completed', opportunities, responseVerified: true,
          actualProvider: result.actual.provider, actualModel: result.actual.model, usage: {
            inputTokens: receipt.inputTokens ?? null, outputTokens: receipt.outputTokens ?? null,
            reasoningTokens: receipt.reasoningTokens ?? null, actualCostMicrousd: receipt.actualCostMicrousd ?? null,
            actualCostSource: receipt.actualCostSource ?? null }, providerRequestId: receipt.providerRequestId ?? null };
        await onCheckpoint(response);
        return response;
      } catch (error) {
        const status = attempted || error.uncertain === true ? 'uncertain' : 'blocked';
        const receipt = error.providerReceipt;
        const result = { status, code: /^[a-z0-9_]+$/i.test(error.code || '') ? error.code : 'prospecting_ai_failed',
          reason: status === 'uncertain' ? 'An AI request may have completed. This result is held without an automatic retry.' : 'AI research could not start under the current permissions or evidence.',
          responseVerified: receipt?.responseVerified === true ? true : null, opportunities: [],
          actualProvider: receipt?.responseVerified === true ? receipt.actualProvider : null,
          actualModel: receipt?.responseVerified === true ? receipt.actualModel : null,
          providerStatus: Number.isInteger(error.statusCode) ? error.statusCode : null,
          usage: receipt ? { inputTokens: receipt.inputTokens ?? null, outputTokens: receipt.outputTokens ?? null,
            reasoningTokens: receipt.reasoningTokens ?? null, actualCostMicrousd: receipt.actualCostMicrousd ?? null,
            actualCostSource: receipt.actualCostSource ?? null } : null };
        await onCheckpoint(result);
        return result;
      }
    },
  });
}
