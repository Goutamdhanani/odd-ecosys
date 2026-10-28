import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath, domainToASCII } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(MODULE_DIR, '..', 'config', 'email-intelligence');
const DATA_PATH = path.join(DATA_DIR, 'disposable-domains.txt');
const METADATA_PATH = path.join(DATA_DIR, 'metadata.json');

const PIN = Object.freeze({
  commit: '3ebb7fef055e3757dfc9bb46b1297ee2b0d11fe7',
  sha256: 'ba19d6735fc2224db58d3eaa9bb294de43437a488133c4271fb07d0ad4436fc7',
  bytes: 1521263,
  count: 98465,
});

// Kept in sync with the verifier's pre-existing 18-domain provider set.
const FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com',
  'me.com', 'mail.com', 'protonmail.com', 'proton.me', 'zoho.com',
  'yandex.com', 'gmx.com', 'fastmail.com',
]);

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SOURCE = 'local_disposable_dataset';
let cachedState;

function normalizeDomain(input) {
  if (typeof input !== 'string' || !input || input !== input.trim()
    || /[\p{Cc}\p{Z}%/?#\\:\[\]@]/u.test(input)) return null;
  const candidate = input;
  if (candidate.startsWith('.') || candidate.endsWith('.') || candidate.includes('..')) return null;
  let ascii;
  try { ascii = domainToASCII(candidate); } catch { return null; }
  const normalized = ascii.toLowerCase();
  // WHATWG host parsing treats numeric-looking names as IPv4 shorthand
  // (for example, 127.1 or 0x7f000001). Such inputs are not email domains.
  if (isIP(normalized) !== 0) return null;
  return DOMAIN_PATTERN.test(normalized) ? normalized : null;
}

function validDatasetMetadata(metadata, bytes, sha256, count) {
  return metadata && typeof metadata === 'object'
    && metadata.source_commit === PIN.commit
    && metadata.dataset_sha256 === PIN.sha256
    && metadata.dataset_bytes === PIN.bytes
    && metadata.nonempty_unique_domain_count === PIN.count
    && bytes === PIN.bytes && sha256 === PIN.sha256 && count === PIN.count;
}

function buildState(datasetBytes, metadata, checkedAt = () => new Date().toISOString()) {
  try {
    if (!(datasetBytes instanceof Uint8Array)) return { available: false, domains: null, checkedAt };
    const bytes = datasetBytes.byteLength;
    if (bytes !== PIN.bytes) return { available: false, domains: null, checkedAt };
    const sha256 = createHash('sha256').update(datasetBytes).digest('hex');
    if (sha256 !== PIN.sha256) return { available: false, domains: null, checkedAt };
    const text = new TextDecoder('utf-8', { fatal: true }).decode(datasetBytes);
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const domains = new Set();
    for (const line of lines) {
      const entry = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!DOMAIN_PATTERN.test(entry) || domains.has(entry)) return { available: false, domains: null, checkedAt };
      domains.add(entry);
    }
    if (!validDatasetMetadata(metadata, bytes, sha256, domains.size)) {
      return { available: false, domains: null, checkedAt };
    }
    return { available: true, domains, checkedAt };
  } catch {
    return { available: false, domains: null, checkedAt };
  }
}

function loadBundledState() {
  if (cachedState) return cachedState;
  try {
    const bytes = readFileSync(DATA_PATH);
    const metadata = JSON.parse(readFileSync(METADATA_PATH, 'utf8'));
    cachedState = buildState(bytes, metadata);
  } catch {
    cachedState = { available: false, domains: null, checkedAt: () => new Date().toISOString() };
  }
  return cachedState;
}

function findMatchedDomain(domain, domains) {
  const labels = domain.split('.');
  for (let index = 0; index < labels.length - 1; index++) {
    const candidate = labels.slice(index).join('.');
    if (domains.has(candidate)) return candidate;
  }
  return null;
}

function classifyWithState(state, { domain, localPart, rolePrefixes = [] } = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const matchedDomain = state.available && normalizedDomain
    ? findMatchedDomain(normalizedDomain, state.domains)
    : null;
  const match = state.available && normalizedDomain ? matchedDomain !== null : null;
  const isRole = typeof localPart === 'string' && Array.isArray(rolePrefixes)
    && rolePrefixes.some(prefix => typeof prefix === 'string' && prefix.length > 0
      && localPart.toLowerCase() === prefix.toLowerCase());
  const isFree = normalizedDomain !== null && FREE_PROVIDERS.has(normalizedDomain);
  return {
    is_disposable: match,
    is_role_account: isRole,
    is_free_provider: isFree,
    classification_evidence: {
      source: SOURCE,
      dataset_commit: PIN.commit,
      dataset_sha256: PIN.sha256,
      matched_domain: matchedDomain,
      checked_at: state.checkedAt(),
      dataset_available: state.available,
      match,
    },
  };
}

export function classifyEmailType(input) {
  return classifyWithState(loadBundledState(), input);
}

export function getEmailTypeDatasetStatus() {
  const state = loadBundledState();
  return {
    available: state.available,
    source: SOURCE,
    dataset_commit: PIN.commit,
    dataset_sha256: PIN.sha256,
  };
}

// Isolated fixture seam used by tests; it never alters or replaces the bundled files.
export function createEmailTypeIntelligenceForTesting({ datasetBytes, metadata, checkedAt } = {}) {
  const state = buildState(datasetBytes, metadata, checkedAt);
  return {
    classifyEmailType: input => classifyWithState(state, input),
    getEmailTypeDatasetStatus: () => ({
      available: state.available,
      source: SOURCE,
      dataset_commit: PIN.commit,
      dataset_sha256: PIN.sha256,
    }),
  };
}
