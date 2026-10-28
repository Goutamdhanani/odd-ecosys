import { allocateAstraResearch } from './astra-learning.js';

/** Public allocation facade. Callers must supply source-policy filtering and an approved ranker projection. */
export function allocateAstraResearchBatch(items, options={}) {
  const allowed = options.allowedSourceIds instanceof Set ? options.allowedSourceIds : new Set();
  return allocateAstraResearch(items, {
    budget: options.budget,
    exploration: options.exploration,
    seed: options.seed,
    approvedArtifact: options.approvedArtifact || null,
    sourceAllowed: item => typeof item.sourceId === 'string' && allowed.has(item.sourceId),
  });
}
