#!/usr/bin/env node

/**
 * S01 commercial-gate register reader.
 *
 * This is an editable local review aid. It is not wired into application
 * inference routes, does not inspect payloads or network traffic, and cannot
 * establish that old egress paths are closed or that an approval is genuine.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REGISTRY_PATH = path.join(ROOT, 'docs/astra/commercial-gates.json');
export const TARGET = Object.freeze({ provider: 'glm-5.3-api', model: 'GLM-5.3' });

export class CommercialGateDeniedError extends Error {
  constructor(reason, gateId = null) {
    super(`Commercial gate denied: ${reason}`);
    this.name = 'CommercialGateDeniedError';
    this.code = 'commercial_gate_denied';
    this.reason = reason;
    this.gateId = gateId;
  }
}

export async function readCommercialGateRegistry({ root = ROOT } = {}) {
  const filename = path.join(root, 'docs/astra/commercial-gates.json');
  return JSON.parse(await readFile(filename, 'utf8'));
}

function validApproval(decision, nowMs) {
  if (decision?.status !== 'approved' || decision.enabled !== true) return false;
  const evidence = decision.approvalEvidence;
  if (!evidence || typeof evidence !== 'object') return false;
  if (!String(evidence.approvedBy || '').trim()) return false;
  if (!String(evidence.documentPath || '').trim()) return false;
  if (!/^[a-f\d]{64}$/i.test(evidence.documentSha256 || '')) return false;
  const approvedAt = Date.parse(evidence.approvedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  return Number.isFinite(approvedAt) && Number.isFinite(expiresAt)
    && approvedAt <= nowMs && expiresAt > nowMs;
}

/**
 * Evaluate an exact GLM fixture operation against the register. This helper
 * is intentionally not an application gateway and never makes network calls.
 */
export function evaluateCommercialGate(registry, {
  gateId = 'glm-api-inference',
  provider,
  model,
  dataClassification = 'unknown',
  now = new Date(),
} = {}) {
  if (!registry || registry.schemaVersion !== 1 || !Array.isArray(registry.decisions)) {
    return { allowed: false, reason: 'registry_invalid', missingDecisions: [] };
  }
  if (gateId !== 'glm-api-inference') {
    return { allowed: false, reason: 'unsupported_operation', missingDecisions: [] };
  }
  if (provider !== TARGET.provider || model !== TARGET.model) {
    return { allowed: false, reason: 'unsupported_provider_or_model', missingDecisions: [] };
  }
  if (registry.runtimeGate?.syntheticFixtureOnly !== true
    || registry.runtimeGate?.acceptedDataClassification !== 'synthetic-fixture'
    || dataClassification !== registry.runtimeGate.acceptedDataClassification) {
    return { allowed: false, reason: 'data_classification_not_allowed', missingDecisions: [] };
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) return { allowed: false, reason: 'invalid_clock', missingDecisions: [] };
  const decisionsById = new Map(registry.decisions.map(decision => [decision.id, decision]));
  const required = registry.runtimeGate?.requiredDecisionIds;
  if (!Array.isArray(required) || required.length === 0) {
    return { allowed: false, reason: 'required_decisions_missing', missingDecisions: [] };
  }
  const missingDecisions = required.filter(id => !validApproval(decisionsById.get(id), nowMs));
  if (missingDecisions.length) {
    return { allowed: false, reason: 'approval_missing_expired_or_unsupported', missingDecisions };
  }
  return { allowed: true, reason: 'approved_register_scope', missingDecisions: [] };
}

/**
 * Execute a caller-supplied operation only when the local register permits it.
 * The callback is deliberately generic for deterministic tests; production app
 * code does not currently call this function and must not be described as
 * protected by it.
 */
export async function runIfCommercialGateApproved(registry, request, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required.');
  const verdict = evaluateCommercialGate(registry, request);
  if (!verdict.allowed) throw new CommercialGateDeniedError(verdict.reason, request?.gateId || 'glm-api-inference');
  return callback();
}

