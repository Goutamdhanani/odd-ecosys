import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createAstraTenantStore } from './astra-tenant-store.js';
import { normalizeAstraTenantId, normalizeAstraUserId } from './astra-tenant-context.js';
import { AstraLedgerError } from './astra-ledger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const WRITE_ROLES = new Set(['owner', 'admin', 'operator']);
const RIGHTS = new Set(['synthetic_fixture', 'authorized', 'licensed', 'public_terms_permitted']);
const STRATEGIES = new Set(['constant_label', 'field_map', 'keyword_rules', 'abstain']);
let workerStore = null;

export class AstraEvaluationError extends AstraLedgerError {
  constructor(message, statusCode = 400, code = 'evaluation_invalid') {
    super(message, statusCode, code);
  }
}

function fail(message, statusCode = 400, code = 'evaluation_invalid') {
  throw new AstraEvaluationError(message, statusCode, code);
}

function text(value, field, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${field} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}

function stableJson(value) { return JSON.stringify(stableValue(value)); }
function digest(value) { return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex'); }
function boundedJson(value, field, maxBytes = 32768) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object.`);
  const json = stableJson(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) fail(`${field} exceeds the ${maxBytes}-byte limit.`);
  return JSON.parse(json);
}

function isoDate(value, field) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.valueOf())) fail(`${field} must be an ISO timestamp.`);
  return date.toISOString();
}

function assertActor(actor, tenantId, roles = WRITE_ROLES) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(tenantId).toLowerCase()) {
    fail('Verified tenant membership is required.', 403, 'tenant_membership_required');
  }
  if (!roles.has(actor.tenantRole || actor.role)) fail('Tenant role does not allow this evaluation action.', 403, 'tenant_role_forbidden');
  if (!/^[1-9][0-9]{0,39}$/.test(String(actor.userId || ''))) fail('A verified user is required.', 401, 'authenticated_user_required');
}

function normalizeSourceManifest(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 200) fail('sourceManifest must contain between one and 200 source declarations.');
  const seen = new Set();
  const entries = input.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) fail(`sourceManifest[${index}] must be an object.`);
    const sourceId = text(source.sourceId, `sourceManifest[${index}].sourceId`, 160);
    const sourceHash = String(source.sha256 || '').toLowerCase();
    const rightsBasis = text(source.rightsBasis, `sourceManifest[${index}].rightsBasis`, 80);
    if (!HASH.test(sourceHash)) fail(`sourceManifest[${index}].sha256 must be a SHA-256 digest.`);
    if (!RIGHTS.has(rightsBasis) || source.rightsAttested !== true) fail(`sourceManifest[${index}] must record a permitted rights basis and explicit attestation.`);
    if (seen.has(sourceId)) fail('sourceManifest sourceId values must be unique.');
    seen.add(sourceId);
    return { sourceId, sha256: sourceHash, rightsBasis, rightsAttested: true };
  });
  entries.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return { entries, sha256: digest(entries) };
}

function normalizeDataset(input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Dataset body must be an object.');
  const name = text(input.name, 'name', 160);
  const sourceManifest = normalizeSourceManifest(input.sourceManifest);
  const labelRights = input.labelRights;
  if (!labelRights || typeof labelRights !== 'object' || Array.isArray(labelRights)
    || !RIGHTS.has(labelRights.basis) || labelRights.attested !== true) {
    fail('labelRights must declare a permitted basis and explicit label-use attestation.');
  }
  const classes = input.labelSchema;
  if (!Array.isArray(classes) || classes.length < 2 || classes.length > 50
    || classes.some(label => typeof label !== 'string' || !LABEL.test(label))
    || new Set(classes).size !== classes.length) fail('labelSchema must contain two to 50 unique class labels.');
  const splitPolicy = input.splitPolicy;
  if (!splitPolicy || splitPolicy.type !== 'company_time_holdout') fail('splitPolicy.type must be company_time_holdout.');
  const validationAfter = splitPolicy.validationAfter == null ? null : isoDate(splitPolicy.validationAfter, 'splitPolicy.validationAfter');
  const holdoutAfter = isoDate(splitPolicy.holdoutAfter, 'splitPolicy.holdoutAfter');
  if (validationAfter && Date.parse(validationAfter) >= Date.parse(holdoutAfter)) fail('validationAfter must precede holdoutAfter.');
  if (!Array.isArray(input.examples) || input.examples.length < 2 || input.examples.length > 10000) fail('examples must contain between two and 10,000 frozen examples.');
  const sources = new Set(sourceManifest.entries.map(entry => entry.sourceId));
  const examples = [];
  const exampleKeys = new Set();
  const companySplits = new Map();
  for (const [index, example] of input.examples.entries()) {
    if (!example || typeof example !== 'object' || Array.isArray(example)) fail(`examples[${index}] must be an object.`);
    if (Object.hasOwn(example, 'label') || Object.hasOwn(example, 'target') || Object.hasOwn(example, 'expected')) fail('Labels must be supplied later by the separate annotation and adjudication authorities.');
    const exampleKey = text(example.exampleKey, `examples[${index}].exampleKey`, 160);
    if (exampleKeys.has(exampleKey)) fail('exampleKey values must be unique within a dataset.');
    exampleKeys.add(exampleKey);
    const companyKey = text(example.companyKey, `examples[${index}].companyKey`, 240);
    const observedAt = isoDate(example.observedAt, `examples[${index}].observedAt`);
    const split = Date.parse(observedAt) >= Date.parse(holdoutAfter) ? 'holdout'
      : validationAfter && Date.parse(observedAt) >= Date.parse(validationAfter) ? 'validation' : 'development';
    const companyHash = digest(companyKey.toLowerCase());
    const previousSplit = companySplits.get(companyHash);
    if (previousSplit && previousSplit !== split) fail('A company appears on more than one time split; holdout overlap is forbidden.');
    companySplits.set(companyHash, split);
    const inputPacket = boundedJson(example.input, `examples[${index}].input`, 32768);
    const sourceRefs = example.sourceRefs;
    if (!Array.isArray(sourceRefs) || sourceRefs.length < 1 || sourceRefs.some(id => typeof id !== 'string' || !sources.has(id))) fail(`examples[${index}].sourceRefs must reference the frozen source manifest.`);
    const subgroups = example.subgroups === undefined ? {} : boundedJson(example.subgroups, `examples[${index}].subgroups`, 4096);
    for (const [key, value] of Object.entries(subgroups)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || typeof value !== 'string' || !value.trim() || value.length > 120) fail(`examples[${index}].subgroups contains an invalid dimension.`);
    }
    examples.push({ exampleKey, companyHash, observedAt, split, input: inputPacket, sourceRefs: [...new Set(sourceRefs)].sort(), subgroups });
  }
  if (!examples.some(example => example.split === 'holdout')) fail('A frozen dataset requires at least one time-based holdout example.');
  const manifest = {
    schemaVersion: 'astra-eval-dataset/1.0.0', name, sourceManifest: sourceManifest.entries,
    sourceManifestSha256: sourceManifest.sha256, labelRights: { basis: labelRights.basis, attested: true, attestedBy: String(actor.userId) },
    labelSchema: [...classes], splitPolicy: { type: 'company_time_holdout', validationAfter, holdoutAfter },
    examples: examples.map(({ exampleKey, companyHash, observedAt, split, input, sourceRefs, subgroups }) => ({
      exampleKey, companyHash, observedAt, split, input, sourceRefs, subgroups,
    })),
  };
  return { ...manifest, manifestJson: stableJson(manifest), manifestSha256: digest(manifest), examples };
}

export async function createAstraEvaluationDataset(db, actor, input) {
  assertActor(actor, actor?.tenantId);
  const dataset = normalizeDataset(input, actor);
  const created = await db.query(`INSERT INTO astra.eval_datasets(
    tenant_id,name,source_manifest,source_manifest_sha256,label_rights,label_schema,split_policy,
    manifest,manifest_sha256,created_by
  ) VALUES($1::uuid,$2,$3::jsonb,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
  RETURNING id,tenant_id AS "tenantId",name,source_manifest_sha256 AS "sourceManifestSha256",
    manifest_sha256 AS "manifestSha256",label_schema AS "labelSchema",split_policy AS "splitPolicy",created_at AS "createdAt"`,
  [actor.tenantId, dataset.name, JSON.stringify(dataset.sourceManifest), dataset.sourceManifestSha256,
    JSON.stringify(dataset.labelRights), JSON.stringify(dataset.labelSchema), JSON.stringify(dataset.splitPolicy),
    dataset.manifestJson, dataset.manifestSha256, String(actor.userId)]);
  const row = created.rows[0];
  const ids = [];
  for (const example of dataset.examples) {
    const result = await db.query(`INSERT INTO astra.eval_examples(
      tenant_id,dataset_id,example_key,company_hash,observed_at,split,input_packet,source_refs,subgroups,input_sha256
    ) VALUES($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)
    RETURNING id,example_key AS "exampleKey",split`, [actor.tenantId, row.id, example.exampleKey, example.companyHash,
      example.observedAt, example.split, JSON.stringify(example.input), JSON.stringify(example.sourceRefs),
      JSON.stringify(example.subgroups), digest(example.input)]);
    ids.push(result.rows[0]);
  }
  return { ...row, exampleCount: ids.length, holdoutCount: ids.filter(item => item.split === 'holdout').length,
    examples: ids, status: 'frozen' };
}

async function assertDataset(db, tenantId, datasetId) {
  if (!UUID.test(String(datasetId))) fail('datasetId must be a UUID.');
  const result = await db.query(`SELECT id,created_by,label_schema,manifest_sha256,status FROM astra.eval_datasets
    WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, datasetId]);
  if (!result.rows[0]) fail('Dataset was not found for this tenant.', 404, 'evaluation_dataset_not_found');
  return result.rows[0];
}

export async function annotateAstraEvaluationDataset(db, actor, datasetId, annotations) {
  assertActor(actor, actor?.tenantId, new Set(['reviewer']));
  const dataset = await assertDataset(db, actor.tenantId, datasetId);
  if (dataset.created_by === String(actor.userId)) fail('Dataset author cannot annotate its labels.', 403, 'annotation_author_separation_required');
  if (!Array.isArray(annotations) || annotations.length < 1 || annotations.length > 500) fail('annotations must contain one to 500 labels.');
  const labels = new Set(dataset.label_schema);
  const normalized = annotations.map((row, index) => {
    if (!row || !UUID.test(String(row.exampleId || '')) || !labels.has(row.label)) fail(`annotations[${index}] requires an exampleId and a declared class label.`);
    return { exampleId: String(row.exampleId).toLowerCase(), label: row.label };
  });
  if (new Set(normalized.map(row => row.exampleId)).size !== normalized.length) fail('Each example may appear only once in an annotation request.');
  const out = [];
  for (const row of normalized) {
    const result = await db.query(`INSERT INTO astra.eval_annotations(tenant_id,dataset_id,example_id,label,annotated_by)
      SELECT $1::uuid,$2::uuid,e.id,$4,$5 FROM astra.eval_examples e
      WHERE e.tenant_id=$1::uuid AND e.dataset_id=$2::uuid AND e.id=$3::uuid
      ON CONFLICT DO NOTHING RETURNING example_id AS "exampleId",label,annotated_at AS "annotatedAt"`,
    [actor.tenantId, datasetId, row.exampleId, row.label, String(actor.userId)]);
    if (!result.rows[0]) fail('Annotation was duplicate or its example was not found.', 409, 'annotation_duplicate_or_missing');
    out.push(result.rows[0]);
  }
  return { datasetId, annotations: out };
}

export async function adjudicateAstraEvaluationDataset(db, actor, datasetId, adjudications) {
  assertActor(actor, actor?.tenantId, new Set(['owner']));
  const dataset = await assertDataset(db, actor.tenantId, datasetId);
  if (dataset.created_by === String(actor.userId)) fail('Dataset author cannot adjudicate its labels.', 403, 'adjudication_author_separation_required');
  if (!Array.isArray(adjudications) || adjudications.length < 1 || adjudications.length > 500) fail('adjudications must contain one to 500 labels.');
  const labels = new Set(dataset.label_schema);
  const normalized = adjudications.map((row, index) => {
    if (!row || !UUID.test(String(row.exampleId || '')) || !labels.has(row.finalLabel)) fail(`adjudications[${index}] requires an exampleId and a declared finalLabel.`);
    return { exampleId: String(row.exampleId).toLowerCase(), label: row.finalLabel };
  });
  if (new Set(normalized.map(row => row.exampleId)).size !== normalized.length) fail('Each example may appear only once in an adjudication request.');
  const out = [];
  for (const row of normalized) {
    const result = await db.query(`INSERT INTO astra.eval_adjudications(tenant_id,dataset_id,example_id,final_label,adjudicated_by,annotation_agreement)
      SELECT $1::uuid,$2::uuid,e.id,$4,$5,
        (SELECT bool_and(a.label=$4) FROM astra.eval_annotations a WHERE a.tenant_id=$1::uuid AND a.dataset_id=$2::uuid AND a.example_id=e.id)
      FROM astra.eval_examples e WHERE e.tenant_id=$1::uuid AND e.dataset_id=$2::uuid AND e.id=$3::uuid
        AND EXISTS(SELECT 1 FROM astra.eval_annotations a WHERE a.tenant_id=$1::uuid AND a.dataset_id=$2::uuid AND a.example_id=e.id AND a.annotated_by<>$5)
      ON CONFLICT DO NOTHING RETURNING example_id AS "exampleId",final_label AS "finalLabel",adjudicated_at AS "adjudicatedAt"`,
    [actor.tenantId, datasetId, row.exampleId, row.label, String(actor.userId)]);
    if (!result.rows[0]) fail('Adjudication needs a separately authored annotation and an unadjudicated example.', 409, 'adjudication_separation_or_duplicate');
    out.push(result.rows[0]);
  }
  return { datasetId, adjudications: out };
}

function normalizeCandidate(input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Candidate body must be an object.');
  const hasProviderField = value => value && typeof value === 'object'
    && Object.entries(value).some(([key, nested]) => /model|provider|grader|endpoint|api.?key/i.test(key) || hasProviderField(nested));
  if (hasProviderField(input)) fail('Evaluation candidates are deterministic local transforms; model and provider fields are not accepted.');
  const name = text(input.name, 'name', 160);
  const version = text(input.version, 'version', 80);
  const variantId = text(input.variantId, 'variantId', 8);
  if (!/^H[0-3]$/.test(variantId)) fail('variantId must be one of H0, H1, H2, or H3.');
  const strategy = text(input.strategy, 'strategy', 40);
  if (!STRATEGIES.has(strategy)) fail('strategy must be an allowlisted deterministic strategy.');
  const config = boundedJson(input.config || {}, 'config', 8192);
  const labels = Array.isArray(input.allowedLabels) ? [...new Set(input.allowedLabels.map(label => text(label, 'allowedLabels', 80)))].sort() : [];
  if (strategy === 'constant_label' && (!labels.includes(config.label) || Object.keys(config).some(key => key !== 'label'))) fail('constant_label config requires one declared allowed label.');
  if (strategy === 'field_map') {
    if (typeof config.field !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,120}$/.test(config.field)
      || !config.mapping || typeof config.mapping !== 'object' || Array.isArray(config.mapping)
      || Object.keys(config.mapping).length > 200 || Object.values(config.mapping).some(label => !labels.includes(label))
      || (config.fallback !== undefined && config.fallback !== null && !labels.includes(config.fallback))) fail('field_map config must map a bounded input field to declared labels.');
  }
  if (strategy === 'keyword_rules') {
    if (!Array.isArray(config.rules) || config.rules.length < 1 || config.rules.length > 100
      || config.rules.some(rule => !rule || typeof rule.term !== 'string' || !rule.term.trim() || rule.term.length > 120 || !labels.includes(rule.label))
      || (config.fallback !== undefined && config.fallback !== null && !labels.includes(config.fallback))) fail('keyword_rules requires one to 100 literal substring rules with declared labels.');
  }
  const candidate = { schemaVersion: 'astra-eval-candidate/1.0.0', name, version, variantId, strategy, config, allowedLabels: labels, executionMode: 'deterministic_local' };
  return { ...candidate, manifestJson: stableJson(candidate), manifestSha256: digest(candidate), createdBy: String(actor.userId) };
}

export async function registerAstraEvaluationCandidate(db, actor, input) {
  assertActor(actor, actor?.tenantId);
  const candidate = normalizeCandidate(input, actor);
  const result = await db.query(`INSERT INTO astra.eval_candidates(tenant_id,name,version,variant_id,strategy,config,allowed_labels,manifest,manifest_sha256,created_by)
    VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
    RETURNING id,name,version,variant_id AS "variantId",strategy,config,allowed_labels AS "allowedLabels",manifest_sha256 AS "manifestSha256",created_at AS "createdAt"`,
  [actor.tenantId, candidate.name, candidate.version, candidate.variantId, candidate.strategy, JSON.stringify(candidate.config),
    JSON.stringify(candidate.allowedLabels), candidate.manifestJson, candidate.manifestSha256, candidate.createdBy]);
  return result.rows[0];
}

export async function registerAstraEvaluationScorer(db, actor, input) {
  assertActor(actor, actor?.tenantId, new Set(['owner', 'admin']));
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Scorer body must be an object.');
  const name = text(input.name, 'name', 160);
  const version = text(input.version, 'version', 80);
  const classLabels = input.classLabels;
  const criticalHarmLabels = input.criticalHarmLabels ?? [];
  if (!Array.isArray(classLabels) || classLabels.length < 2 || classLabels.length > 50
    || classLabels.some(label => typeof label !== 'string' || !LABEL.test(label)) || new Set(classLabels).size !== classLabels.length
    || !Array.isArray(criticalHarmLabels) || criticalHarmLabels.some(label => !classLabels.includes(label))) fail('Scorer classes and critical-harm labels are invalid.');
  const abstainLabel = input.abstainLabel === undefined ? null : text(input.abstainLabel, 'abstainLabel', 80);
  if (abstainLabel && classLabels.includes(abstainLabel)) fail('abstainLabel must be distinct from the scored classes.');
  if (Object.keys(input).some(key => /model|provider|grader|endpoint|api.?key/i.test(key))) fail('Scorers are deterministic local metrics; model and provider fields are not accepted.');
  const scorer = { schemaVersion: 'astra-eval-scorer/1.0.0', name, version, classLabels: [...classLabels],
    criticalHarmLabels: [...criticalHarmLabels], abstainLabel, costBasis: 'offline_deterministic_cost_not_metered' };
  const result = await db.query(`INSERT INTO astra.eval_scorers(tenant_id,name,version,class_labels,critical_harm_labels,abstain_label,manifest,manifest_sha256,created_by)
    VALUES($1::uuid,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9)
    RETURNING id,name,version,class_labels AS "classLabels",critical_harm_labels AS "criticalHarmLabels",abstain_label AS "abstainLabel",manifest_sha256 AS "manifestSha256",created_at AS "createdAt"`,
  [actor.tenantId, name, version, JSON.stringify(scorer.classLabels), JSON.stringify(scorer.criticalHarmLabels), abstainLabel,
    stableJson(scorer), digest(scorer), String(actor.userId)]);
  return result.rows[0];
}

export async function queueAstraEvaluationRun(db, actor, input) {
  assertActor(actor, actor?.tenantId, new Set(['owner', 'admin']));
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Evaluation run body must be an object.');
  const datasetId = String(input.datasetId || '').toLowerCase();
  const scorerId = String(input.scorerId || '').toLowerCase();
  if (!UUID.test(datasetId) || !UUID.test(scorerId) || !Array.isArray(input.candidateIds) || input.candidateIds.length < 1 || input.candidateIds.length > 4) fail('datasetId, scorerId and one to four candidateIds are required.');
  const candidateIds = [...new Set(input.candidateIds.map(id => String(id).toLowerCase()))];
  if (candidateIds.length !== input.candidateIds.length || candidateIds.some(id => !UUID.test(id))) fail('candidateIds must be unique UUIDs.');
  const budget = input.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)
    || !Number.isSafeInteger(budget.maxExamples) || budget.maxExamples < 1 || budget.maxExamples > 10000
    || !Number.isSafeInteger(budget.maxWallClockMs) || budget.maxWallClockMs < 100 || budget.maxWallClockMs > 600000
    || budget.maxModelCalls !== 0 || budget.maxSpendMicrousd !== 0) fail('budget requires bounded example/time ceilings and zero model calls/spend.');
  const datasetResult = await db.query(`SELECT id,created_by,manifest_sha256 FROM astra.eval_datasets WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='frozen'`, [actor.tenantId, datasetId]);
  const dataset = datasetResult.rows[0];
  if (!dataset) fail('Frozen dataset was not found for this tenant.', 404, 'evaluation_dataset_not_found');
  const scorerResult = await db.query(`SELECT id,created_by,manifest_sha256 FROM astra.eval_scorers WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, scorerId]);
  const scorer = scorerResult.rows[0];
  if (!scorer) fail('Scorer was not found for this tenant.', 404, 'evaluation_scorer_not_found');
  const candidatesResult = await db.query(`SELECT id,variant_id,created_by,manifest_sha256,allowed_labels FROM astra.eval_candidates WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`, [actor.tenantId, candidateIds]);
  if (candidatesResult.rows.length !== candidateIds.length) fail('One or more candidates were not found for this tenant.', 404, 'evaluation_candidate_not_found');
  const variants = new Set(candidatesResult.rows.map(row => row.variant_id));
  if (variants.size !== candidatesResult.rows.length) fail('Each H0-H3 run must use a distinct candidate variant.');
  if (candidatesResult.rows.length === 4 && ['H0', 'H1', 'H2', 'H3'].some(variant => !variants.has(variant))) fail('A matched-budget run must include H0, H1, H2 and H3 exactly once.');
  if (dataset.created_by === String(actor.userId) || scorer.created_by === String(actor.userId)
    || candidatesResult.rows.some(row => row.created_by === String(actor.userId))) fail('Run requester must be independent from the dataset, candidate and scorer owners.', 403, 'evaluation_owner_separation_required');
  if (candidatesResult.rows.some(row => row.created_by === scorer.created_by || row.created_by === dataset.created_by)) fail('Candidate, scorer and dataset governance must use separate authors.', 409, 'evaluation_author_separation_required');
  const labels = await db.query(`SELECT d.label_schema,s.class_labels FROM astra.eval_datasets d CROSS JOIN astra.eval_scorers s
    WHERE d.tenant_id=$1::uuid AND d.id=$2::uuid AND s.tenant_id=d.tenant_id AND s.id=$3::uuid`, [actor.tenantId, datasetId, scorerId]);
  if (stableJson([...labels.rows[0].label_schema].sort()) !== stableJson([...labels.rows[0].class_labels].sort())) fail('Dataset labels and scorer classes must match exactly.');
  const declaredClasses = new Set(labels.rows[0].label_schema);
  if (candidatesResult.rows.some(row => row.allowed_labels.some(label => !declaredClasses.has(label)))) fail('Candidate output labels must belong to the frozen dataset class set.');
  const adjudicationCheck = await db.query(`SELECT COUNT(*) FILTER(WHERE e.split='holdout')::int AS holdout,
      COUNT(a.example_id)::int AS adjudicated
    FROM astra.eval_examples e LEFT JOIN astra.eval_adjudications a
      ON (a.tenant_id,a.dataset_id,a.example_id)=(e.tenant_id,e.dataset_id,e.id)
    WHERE e.tenant_id=$1::uuid AND e.dataset_id=$2::uuid AND e.split='holdout'`, [actor.tenantId, datasetId]);
  if (!adjudicationCheck.rows[0].holdout || adjudicationCheck.rows[0].holdout !== adjudicationCheck.rows[0].adjudicated) fail('Every holdout example must have an independent adjudicated label before evaluation.', 409, 'evaluation_labels_incomplete');
  if (budget.maxExamples < adjudicationCheck.rows[0].holdout) fail('The declared example ceiling is below the frozen holdout size.', 409, 'evaluation_budget_too_small');
  const candidateRefs = candidatesResult.rows.map(row => ({ id: row.id,
    variantId: row.variant_id, manifestSha256: row.manifest_sha256.trim() })).sort((a, b) => a.variantId.localeCompare(b.variantId));
  const snapshot = { datasetId, datasetManifestSha256: dataset.manifest_sha256.trim(), scorerId,
    scorerManifestSha256: scorer.manifest_sha256.trim(), candidates: candidateRefs,
    budget };
  const snapshotSha256 = digest(snapshot);
  const result = await db.query(`INSERT INTO astra.eval_runs(tenant_id,dataset_id,scorer_id,candidate_refs,budget,snapshot,snapshot_sha256,requested_by,state)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,'queued')
    RETURNING id,state,snapshot_sha256 AS "snapshotSha256",created_at AS "createdAt"`,
  [actor.tenantId, datasetId, scorerId, JSON.stringify(candidateRefs), JSON.stringify(budget), stableJson(snapshot), snapshotSha256, String(actor.userId)]);
  return { ...result.rows[0], datasetId, scorerId, candidateCount: candidateIds.length, matchedBudget: candidateIds.length === 4,
    modelCostMicrousd: null, costBasis: 'not_metered_offline_harness', results: null };
}

function getPath(object, path) { return path.split('.').reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, object); }

function predict(candidate, packet) {
  const config = candidate.config;
  if (candidate.strategy === 'abstain') return null;
  if (candidate.strategy === 'constant_label') return config.label;
  if (candidate.strategy === 'field_map') {
    const key = getPath(packet, config.field);
    return Object.hasOwn(config.mapping, String(key)) ? config.mapping[String(key)] : (config.fallback ?? null);
  }
  const field = config.field || 'text';
  const value = getPath(packet, field);
  if (typeof value !== 'string') return config.fallback ?? null;
  const normalized = value.toLocaleLowerCase('en-US');
  for (const rule of config.rules) if (normalized.includes(rule.term.toLocaleLowerCase('en-US'))) return rule.label;
  return config.fallback ?? null;
}

function wilson(successes, count) {
  if (count === 0) return { lower: null, upper: null, status: 'unknown_no_observations' };
  const z = 1.959963984540054;
  const p = successes / count;
  const denominator = 1 + (z * z) / count;
  const center = (p + (z * z) / (2 * count)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * count)) / count)) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), status: 'estimated_95_percent_wilson' };
}

function scorePredictions(examples, candidate, scorer, adjudicationCount) {
  const labels = scorer.class_labels;
  const confusion = new Map(labels.map(actual => [actual, new Map(labels.map(predicted => [predicted, 0]))]));
  const classCounts = new Map(labels.map(label => [label, { support: 0, predicted: 0, truePositive: 0 }]));
  const subgroupRows = new Map();
  let correct = 0;
  let covered = 0;
  let criticalHarm = 0;
  let criticalCases = 0;
  for (const example of examples) {
    const prediction = predict(candidate, example.input_packet);
    const actual = example.final_label;
    const isCovered = prediction !== null && prediction !== scorer.abstain_label;
    if (isCovered) covered += 1;
    if (scorer.critical_harm_labels.includes(actual)) {
      criticalCases += 1;
      if (prediction !== actual) criticalHarm += 1;
    }
    if (labels.includes(actual)) {
      const actualCounts = classCounts.get(actual); actualCounts.support += 1;
      if (labels.includes(prediction)) {
        confusion.get(actual).set(prediction, confusion.get(actual).get(prediction) + 1);
        classCounts.get(prediction).predicted += 1;
        if (prediction === actual) { correct += 1; actualCounts.truePositive += 1; }
      }
    }
  }
  const subgroupDimensions = [...new Set(examples.flatMap(example => Object.keys(example.subgroups || {})))].sort();
  for (const example of examples) {
    const dimensions = example.subgroups || {};
    const prediction = predict(candidate, example.input_packet);
    const actual = example.final_label;
    for (const dimension of subgroupDimensions) {
      const value = typeof dimensions[dimension] === 'string' ? dimensions[dimension] : 'unknown';
      const key = `${dimension}:${value}`;
      if (!subgroupRows.has(key)) subgroupRows.set(key, { dimension, value, count: 0, correct: 0 });
      const subgroup = subgroupRows.get(key); subgroup.count += 1; if (prediction === actual) subgroup.correct += 1;
    }
  }
  const count = examples.length;
  const classMetrics = Object.fromEntries(labels.map(label => {
    const row = classCounts.get(label);
    const precision = row.predicted ? row.truePositive / row.predicted : null;
    const recall = row.support ? row.truePositive / row.support : null;
    const f1 = precision === null || recall === null || precision + recall === 0 ? null : 2 * precision * recall / (precision + recall);
    return [label, { support: row.support, predicted: row.predicted, truePositive: row.truePositive, precision,
      recall, f1, status: row.support === 0 ? 'unknown_no_positive_examples' : row.predicted === 0 ? 'unknown_no_predictions' : 'measured' }];
  }));
  const subgroupUncertainty = [...subgroupRows.values()].map(row => ({ ...row, accuracy: row.count ? row.correct / row.count : null,
    interval: wilson(row.correct, row.count) }));
  return {
    sampleCount: count, accuracy: count ? correct / count : null,
    coverage: count ? covered / count : null, abstentions: count - covered,
    criticalHarmRate: criticalCases ? criticalHarm / criticalCases : null,
    criticalHarmCount: criticalHarm, criticalCaseCount: criticalCases,
    classMetrics, confusionMatrix: Object.fromEntries([...confusion].map(([actual, row]) => [actual, Object.fromEntries(row)])),
    subgroupUncertainty,
    interventions: { adjudicatedExamples: adjudicationCount, evaluatorOverrides: 0, status: 'adjudication_count_observed' },
    cost: { modelCostMicrousd: null, totalCostMicrousd: null, status: 'unknown_not_metered', basis: 'offline_deterministic_harness' },
  };
}

/** Execute one frozen run. This worker path computes all metrics from persisted examples. */
export async function executeAstraEvaluationRun(db, tenantId, runId) {
  const tenant = normalizeAstraTenantId(tenantId);
  if (!UUID.test(String(runId))) fail('runId must be a UUID.');
  const claimed = await db.query(`UPDATE astra.eval_runs SET state='running',started_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='queued'
    RETURNING id,dataset_id,scorer_id,candidate_refs,budget,snapshot,snapshot_sha256`, [tenant, runId]);
  if (!claimed.rows[0]) return { runId, state: 'not_claimed' };
  const run = claimed.rows[0];
  const start = performance.now();
  try {
    const frozen = await db.query(`SELECT d.manifest_sha256 AS dataset_hash,d.source_manifest_sha256,s.manifest_sha256 AS scorer_hash,
      s.class_labels,s.critical_harm_labels,s.abstain_label
      FROM astra.eval_datasets d JOIN astra.eval_scorers s ON s.tenant_id=d.tenant_id
      WHERE d.tenant_id=$1::uuid AND d.id=$2::uuid AND s.id=$3::uuid AND d.status='frozen'`, [tenant, run.dataset_id, run.scorer_id]);
    if (!frozen.rows[0] || frozen.rows[0].dataset_hash.trim() !== run.snapshot.datasetManifestSha256
      || frozen.rows[0].scorer_hash.trim() !== run.snapshot.scorerManifestSha256) fail('Frozen evaluator references changed after queueing.', 409, 'evaluation_snapshot_changed');
    const examplesResult = await db.query(`SELECT e.id,e.input_packet,e.split,e.subgroups,a.final_label,a.annotation_agreement
      FROM astra.eval_examples e JOIN astra.eval_adjudications a
        ON (a.tenant_id,a.dataset_id,a.example_id)=(e.tenant_id,e.dataset_id,e.id)
      WHERE e.tenant_id=$1::uuid AND e.dataset_id=$2::uuid AND e.split='holdout' ORDER BY e.example_key,e.id`, [tenant, run.dataset_id]);
    if (!examplesResult.rows.length || examplesResult.rows.length > run.budget.maxExamples) fail('Holdout is empty or exceeds the frozen run budget.', 409, 'evaluation_budget_exceeded');
    const candidateRefs = run.candidate_refs;
    const ids = candidateRefs.map(item => item.id);
    const candidatesResult = await db.query(`SELECT id,name,version,variant_id,strategy,config,allowed_labels,manifest_sha256,created_by
      FROM astra.eval_candidates WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`, [tenant, ids]);
    if (candidatesResult.rows.length !== candidateRefs.length) fail('One or more frozen candidates are missing.', 409, 'evaluation_candidate_missing');
    const candidates = new Map(candidatesResult.rows.map(candidate => [candidate.id, candidate]));
    const results = [];
    const examples = examplesResult.rows;
    for (const reference of candidateRefs) {
      const candidate = candidates.get(reference.id);
      if (candidate.manifest_sha256.trim() !== reference.manifestSha256) fail('Candidate changed after run queueing.', 409, 'evaluation_snapshot_changed');
      const t0 = performance.now();
      const metrics = scorePredictions(examples, candidate, frozen.rows[0], examples.filter(example => example.annotation_agreement === false).length);
      const elapsedMs = Math.max(0, Math.round((performance.now() - t0) * 1000) / 1000);
      if (performance.now() - start > run.budget.maxWallClockMs) fail('Internal evaluation exceeded its declared wall-clock ceiling.', 408, 'evaluation_timeout');
      const output = { candidateId: candidate.id, candidateVersion: candidate.version, variantId: candidate.variant_id,
        candidateManifestSha256: candidate.manifest_sha256.trim(), elapsedMs, metrics };
      results.push({ ...output, resultSha256: digest(output) });
    }
    for (const output of results) {
      await db.query(`INSERT INTO astra.eval_run_results(tenant_id,run_id,candidate_id,variant_id,metrics,elapsed_ms,result_sha256)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7)`, [tenant, run.id, output.candidateId,
        output.variantId, stableJson(output.metrics), output.elapsedMs, output.resultSha256]);
    }
    const report = { schemaVersion: 'astra-eval-report/1.0.0', runId: run.id, datasetId: run.dataset_id,
      datasetManifestSha256: frozen.rows[0].dataset_hash.trim(), scorerId: run.scorer_id,
      scorerManifestSha256: frozen.rows[0].scorer_hash.trim(), snapshotSha256: run.snapshot_sha256.trim(),
      split: 'holdout', holdoutExamples: examples.length, matchedBudget: candidateRefs.length === 4,
      pairedBy: 'same frozen holdout example IDs', sourceManifestSha256: frozen.rows[0].source_manifest_sha256.trim(),
      budget: run.budget, modelProviderCalls: 0, variants: results,
      metricDictionary: {
        accuracy: 'correct holdout predictions / holdout examples',
        criticalHarmRate: 'incorrect or abstained predictions on critical-harm gold classes / those gold cases; null if no cases',
        coverage: 'non-abstaining predictions / holdout examples',
        classMetrics: 'per-class support, predicted count, precision, recall and F1; undefined denominators are null',
        subgroupUncertainty: 'per declared subgroup, accuracy and 95% Wilson interval; absent subgroup values are grouped as unknown',
        latency: 'measured local deterministic scoring time in milliseconds',
        cost: 'null because provider and infrastructure costs are not metered by this offline harness',
        interventions: 'count of holdout labels where independent annotation disagreed with adjudication',
      },
      adversarialConformance: { status: 'not_configured', prohibitedEffects: null, benignTaskSuccess: null,
        reasonCode: 'sandboxed_application_side_effect_adapter_unavailable' },
      releaseReady: false, evaluatedAt: new Date().toISOString() };
    const reportHash = digest(report);
    await db.query(`UPDATE astra.eval_runs SET state='completed',report=$3::jsonb,report_sha256=$4,completed_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='running'`, [tenant, run.id, stableJson(report), reportHash]);
    return { runId: run.id, state: 'completed', report, reportSha256: reportHash };
  } catch (error) {
    const code = /^[a-z0-9_.:-]{1,64}$/i.test(String(error?.code || '')) ? String(error.code) : 'evaluation_failed';
    await db.query(`UPDATE astra.eval_runs SET state='failed',error_code=$3,completed_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='running'`, [tenant, run.id, code]);
    return { runId: run.id, state: 'failed', errorCode: code };
  }
}

function getWorkerStore() {
  if (!workerStore) workerStore = createAstraTenantStore({ connectionString: process.env.ASTRA_WORKER_DATABASE_URL?.trim() || '' });
  return workerStore;
}

/** Internal worker entry point; callers receive no ability to supply scores or labels. */
export async function requestAstraEvaluationExecution({ store, tenantId, userId, runId }) {
  if (!store && !process.env.ASTRA_WORKER_DATABASE_URL?.trim()) fail('A dedicated Astra worker database connection is not configured.', 503, 'astra_worker_unavailable');
  const worker = store || getWorkerStore();
  return worker.withWorkerTenant({ tenantId: normalizeAstraTenantId(tenantId), userId: normalizeAstraUserId(userId) }, db =>
    executeAstraEvaluationRun(db, tenantId, runId));
}

export async function getAstraEvaluationRun(db, actor, runId) {
  assertActor(actor, actor?.tenantId, new Set(['owner', 'admin', 'operator', 'reviewer']));
  if (!UUID.test(String(runId))) fail('runId must be a UUID.');
  const result = await db.query(`SELECT id,state,snapshot_sha256 AS "snapshotSha256",report_sha256 AS "reportSha256",
      report,error_code AS "errorCode",created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt"
    FROM astra.eval_runs WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, runId]);
  if (!result.rows[0]) return null;
  const run = result.rows[0];
  if (run.report) return { ...run, modelCostMicrousd: null, costBasis: 'not_metered_offline_harness' };
  return { ...run, report: null, results: null, modelCostMicrousd: null, costBasis: 'not_metered_offline_harness' };
}

export const ASTRA_EVALUATION_VARIANTS = Object.freeze(['H0', 'H1', 'H2', 'H3']);
