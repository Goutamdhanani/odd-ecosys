#!/usr/bin/env node

/**
 * Derived acceptance-contract importer and fail-closed bookkeeping checker.
 *
 * This is locally authored tooling. It is not the missing supplied
 * ACCEPTANCE_MATRIX.json or validate_acceptance.py, and it cannot authenticate
 * a reviewer or approve a task.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TASK_ID = /^[SX]\d{2}$/;
const CASE_ID = /^[SX]\d{2}-(?:B\d{2}|\d{2})$/;

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseTaskSections(matrixText) {
  const sections = [...matrixText.matchAll(/^## (S\d{2}|X\d{2}) — (.+)$/gm)];
  const tasks = new Map();

  for (let index = 0; index < sections.length; index += 1) {
    const match = sections[index];
    const start = match.index + match[0].length;
    const end = sections[index + 1]?.index ?? matrixText.length;
    const body = matrixText.slice(start, end);
    const id = match[1];
    const heading = match[2].trim();
    const priority = body.match(/^\*\*Priority:\*\*\s*([^·\n]+?)\s*·/m)?.[1]?.trim();
    const dependenciesText = body.match(/^\*\*Priority:\*\*.*?\*\*Dependencies:\*\*\s*([^\n]+)/m)?.[1]?.trim();
    const dependencies = dependenciesText && dependenciesText.toLowerCase() !== 'none'
      ? dependenciesText.split(',').map(value => value.trim()).filter(Boolean)
      : [];
    const delivered = body.match(/^\*\*Desired delivered capability:\*\*\s*(.+)$/m)?.[1]?.trim();
    const acceptance = body.match(/^\*\*Luna must accept only if:\*\*\s*(.+)$/m)?.[1]?.trim();
    const cases = [];

    for (const line of body.split(/\r?\n/)) {
      const originalCase = line.match(/^\s*-\s+`((?:S|X)\d{2}-B\d{2})`\s+—\s+(.+)$/);
      if (originalCase) {
        cases.push({
          id: originalCase[1],
          kind: 'original-backlog-test',
          requirement: originalCase[2].trim(),
          sourceReference: `ACCEPTANCE_MATRIX.md#${id.toLowerCase()}`,
        });
      }
    }

    const supplementalLine = body.match(/^\*\*Additional executable cases \(see main contract\):\*\*\s*(.+)$/m)?.[1];
    const supplementalIds = supplementalLine
      ? [...supplementalLine.matchAll(/`((?:S|X)\d{2}-\d{2})`/g)].map(value => value[1])
      : [];

    assert(TASK_ID.test(id), `Invalid task ID in matrix: ${id}`);
    assert(priority, `${id}: missing priority`);
    assert(delivered, `${id}: missing desired capability`);
    assert(acceptance, `${id}: missing acceptance rule`);
    assert(new Set(cases.map(testCase => testCase.id)).size === cases.length, `${id}: duplicate original case ID`);
    assert(new Set(supplementalIds).size === supplementalIds.length, `${id}: duplicate supplemental case ID`);

    tasks.set(id, {
      id,
      title: heading,
      priority,
      dependencies,
      desiredCapability: delivered,
      acceptanceRule: acceptance,
      testCases: cases,
      supplementalCaseIds: supplementalIds,
    });
  }

  return tasks;
}

function parseSupplementalRecipes(continuousText) {
  const recipes = new Map();
  const pattern = /^\s*(?:-\s+|\d+\.\s+)`((?:S|X)\d{2}-\d{2})`\s+\*\*(.+?):\*\*\s*(.+)$/gm;
  for (const match of continuousText.matchAll(pattern)) {
    const [, id, title, recipe] = match;
    assert(!recipes.has(id), `Duplicate supplemental recipe in continuous contract: ${id}`);
    recipes.set(id, {
      id,
      kind: 'supplemental-contract-case',
      title: title.trim(),
      requirement: recipe.trim(),
      sourceReference: 'ASTRA_LUNA_CONTINUOUS_EXECUTION.md#4',
    });
  }
  return recipes;
}

function assertAuthoritativeOrder(order, tasks) {
  assert(Array.isArray(order) && order.length === tasks.size, 'combined-backlog.json topologicalOrder is missing or incomplete');
  assert(new Set(order).size === order.length, 'combined-backlog.json topologicalOrder contains duplicate IDs');
  for (const id of order) assert(tasks.has(id), `combined-backlog.json topologicalOrder contains unknown task ${id}`);
  const position = new Map(order.map((id, index) => [id, index]));
  for (const [id, task] of tasks) {
    for (const dependency of task.dependencies) {
      assert(position.has(dependency), `${id}: prerequisite ${dependency} is absent from topologicalOrder`);
      assert(position.get(dependency) < position.get(id), `${id}: prerequisite ${dependency} appears after its dependent`);
    }
  }
}

export function deriveAcceptanceContract({ matrixText, continuousText, backlogText, provenance }) {
  const sourceBacklog = JSON.parse(backlogText);
  const backlogTasks = sourceBacklog.tasks;
  assert(Array.isArray(backlogTasks), 'combined-backlog.json has no tasks array');
  const authoritative = new Map(backlogTasks.map(task => [task.id, task]));
  assert(authoritative.size === backlogTasks.length, 'combined-backlog.json has duplicate task IDs');

  const matrixTasks = parseTaskSections(matrixText);
  const recipes = parseSupplementalRecipes(continuousText);
  const issues = [];
  const sourceIds = [...authoritative.keys()].sort();
  const matrixIds = [...matrixTasks.keys()].sort();
  const missingInMatrix = sourceIds.filter(id => !matrixTasks.has(id));
  const unexpectedInMatrix = matrixIds.filter(id => !authoritative.has(id));
  assert(sourceBacklog.taskCount === 52, `Expected source backlog taskCount 52; got ${sourceBacklog.taskCount}`);
  assert(authoritative.size === 52, `Expected 52 authoritative tasks; got ${authoritative.size}`);
  assert(missingInMatrix.length === 0, `Matrix is missing task IDs: ${missingInMatrix.join(', ')}`);
  assert(unexpectedInMatrix.length === 0, `Matrix contains unknown task IDs: ${unexpectedInMatrix.join(', ')}`);

  const tasks = backlogTasks.map(sourceTask => {
    const matrixTask = matrixTasks.get(sourceTask.id);
    const sourceDeps = [...sourceTask.dependencies].sort();
    const matrixDeps = [...matrixTask.dependencies].sort();
    assert(JSON.stringify(sourceDeps) === JSON.stringify(matrixDeps),
      `${sourceTask.id}: matrix prerequisites disagree with combined-backlog.json`);
    assert(matrixDeps.every(id => authoritative.has(id)), `${sourceTask.id}: orphan prerequisite`);

    const sourceTests = matrixTask.testCases.map(testCase => ({ ...testCase }));
    const supplementalTests = matrixTask.supplementalCaseIds.map(id => {
      const recipe = recipes.get(id);
      if (!recipe) {
        issues.push(`${sourceTask.id}: supplemental case ${id} is referenced by matrix but has no recipe in the continuous contract`);
        return {
          id,
          kind: 'supplemental-contract-case',
          requirement: 'See the referenced continuous contract case; recipe was not found during import.',
          sourceReference: 'ASTRA_LUNA_CONTINUOUS_EXECUTION.md (missing case detail)',
        };
      }
      return { ...recipe };
    });
    for (const testCase of sourceTests) {
      assert(CASE_ID.test(testCase.id), `${sourceTask.id}: invalid test-case ID ${testCase.id}`);
    }
    for (const testCase of supplementalTests) {
      assert(CASE_ID.test(testCase.id), `${sourceTask.id}: invalid supplemental-case ID ${testCase.id}`);
    }

    return {
      id: sourceTask.id,
      title: matrixTask.title,
      priority: matrixTask.priority,
      dependencies: [...sourceTask.dependencies],
      backlogStatusAtImport: sourceTask.status,
      desiredCapability: matrixTask.desiredCapability,
      acceptanceRule: matrixTask.acceptanceRule,
      originalBacklogCases: sourceTests,
      supplementalCases: supplementalTests,
      matrixReviewDeliverable: 'changed code/manifest digest, exact test logs, regression result, migration and rollback evidence when applicable, security/privacy effects, reviewer session, and explicit independent verdict',
      statusAtImport: 'NOT_ACCEPTED',
    };
  });

  const x14 = authoritative.get('X14');
  assert(x14, 'Authoritative backlog lacks X14');
  assert(x14.dependencies.includes('S33') === false, 'Unexpected S33 prerequisite on X14');
  assert(authoritative.get('S33')?.dependencies.includes('X14'), 'Authoritative combined-backlog.json lacks required X14 -> S33 dependency');

  const taskDAG = Object.fromEntries(backlogTasks.map(task => [task.id, [...task.dependencies]]));
  assertAuthoritativeOrder(sourceBacklog.topologicalOrder, authoritative);
  const supplied = provenance.suppliedFiles;
  const contract = {
    schemaVersion: 1,
    artifactType: 'locally-derived-acceptance-requirements-map',
    provenance: {
      derivedBy: 'tools/astra/derive-acceptance.mjs',
      sources: {
        acceptanceMatrix: supplied.acceptanceMatrix,
        continuousExecutionContract: supplied.continuousExecutionContract,
        authoritativeBacklog: {
          path: 'docs/astra/combined-backlog.json',
          sha256: sha256(backlogText),
        },
      },
      missingOriginalCompanions: supplied.missingOriginalCompanions,
      disclaimer: 'This derived map is not either missing original companion and cannot authenticate a Luna reviewer or establish task acceptance.',
    },
    taskCount: 52,
    taskIds: sourceIds,
    taskDAG,
    topologicalOrder: [...sourceBacklog.topologicalOrder],
    requiredEdges: [{ from: 'X14', to: 'S33', source: 'combined-backlog.json' }],
    optionalOutsideInitialLaunch: ['X16'],
    importIssues: issues,
    tasks,
  };
  return contract;
}

/**
 * Verify dossier bookkeeping only. A valid result intentionally remains
 * REVIEW_PENDING because a JSON field cannot prove reviewer identity.
 */
export async function validateAcceptanceBookkeeping({ candidatePath, reviewPath, requiredCaseIds }) {
  const candidateBytes = await readFile(candidatePath);
  const candidateHash = sha256(candidateBytes);
  const candidateDir = path.dirname(path.resolve(candidatePath));
  const issues = [];
  let review;
  try {
    review = JSON.parse(await readFile(reviewPath, 'utf8'));
  } catch (error) {
    return { status: 'REVIEW_PENDING', bookkeepingValid: false, candidateSha256: candidateHash, issues: [`Review JSON unavailable or invalid: ${error.message}`] };
  }

  if (review.decision !== 'ACCEPTED') issues.push('Independent reviewer decision is not ACCEPTED.');
  if (review.candidate_patch_sha256 !== candidateHash) issues.push('Reviewer digest does not match the current candidate patch.');
  if (!review.tested_exact_candidate) issues.push('Reviewer did not attest to testing the exact candidate.');
  if (review.reviewer_model !== 'Luna') issues.push('Reviewer model must be Luna.');
  if (review.reviewer_independent !== true) issues.push('Independent reviewer flag is absent.');
  if (typeof review.reviewer_session !== 'string' || !review.reviewer_session.trim()) issues.push('Reviewer session provenance is missing.');
  if (review.critical_findings_open !== 0) issues.push('Critical findings remain open or are unspecified.');
  if (review.high_findings_open !== 0) issues.push('High findings remain open or are unspecified.');
  if (review.legacy_regression !== 'PASS') issues.push('Legacy regression result is not PASS.');

  const required = [...new Set(requiredCaseIds ?? [])].sort();
  const results = Array.isArray(review.required_tests) ? review.required_tests : [];
  const resultIds = results.map(result => result?.id);
  if (new Set(resultIds).size !== resultIds.length) issues.push('Reviewer test list contains duplicate case IDs.');
  for (const id of required) {
    if (!results.some(result => result?.id === id)) issues.push(`Required case ${id} is missing from reviewer results.`);
  }
  for (const result of results) {
    if (result?.result !== 'PASS') issues.push(`Reviewer case ${String(result?.id)} did not PASS.`);
    if (typeof result?.log_path !== 'string' || !result.log_path.trim()) {
      issues.push(`Reviewer case ${String(result?.id)} has no log path.`);
      continue;
    }
    const logPath = path.resolve(candidateDir, result.log_path);
    if (!logPath.startsWith(`${candidateDir}${path.sep}`)) {
      issues.push(`Reviewer case ${String(result.id)} log path escapes the dossier.`);
      continue;
    }
    try {
      const logBytes = await readFile(logPath);
      if (sha256(logBytes) !== result.log_sha256) issues.push(`Reviewer case ${result.id} log digest mismatch.`);
    } catch {
      issues.push(`Reviewer case ${String(result.id)} log is missing or unreadable.`);
    }
  }

  const notesPath = typeof review.review_notes_path === 'string'
    ? path.resolve(candidateDir, review.review_notes_path)
    : '';
  if (!notesPath || !notesPath.startsWith(`${candidateDir}${path.sep}`)) {
    issues.push('Reviewer notes path is missing or escapes the dossier.');
  } else {
    try {
      await readFile(notesPath);
    } catch {
      issues.push('Reviewer notes file is missing or unreadable.');
    }
  }

  // Reviewer session/model fields are claims in editable evidence. This guard
  // cannot verify that a genuine, separate Luna session authored the review.
  issues.push('Reviewer identity and independence require out-of-band session verification.');
  return {
    status: 'REVIEW_PENDING',
    bookkeepingValid: issues.length === 1,
    candidateSha256: candidateHash,
    reviewerIdentityVerified: false,
    issues,
  };
}

async function main(args) {
  const [command = 'derive', ...rest] = args;
  const options = Object.fromEntries(rest.map((arg, index) => {
    if (!arg.startsWith('--')) return [arg, rest[index + 1]];
    return [arg.slice(2), rest[index + 1]];
  }).filter(([key]) => key));

  if (command === 'derive') {
    const matrixPath = options.matrix ?? 'E:/ACCEPTANCE_MATRIX.md';
    const continuousPath = options.continuous ?? 'E:/ASTRA_LUNA_CONTINUOUS_EXECUTION.md';
    const backlogPath = options.backlog ?? path.join(ROOT, 'docs/astra/combined-backlog.json');
    const outputPath = options.out ?? path.join(ROOT, 'docs/astra/acceptance-contract/requirements-map.json');
    const [matrixText, continuousText, backlogText] = await Promise.all([
      readFile(matrixPath, 'utf8'), readFile(continuousPath, 'utf8'), readFile(backlogPath, 'utf8'),
    ]);
    const contract = deriveAcceptanceContract({
      matrixText,
      continuousText,
      backlogText,
      provenance: {
        suppliedFiles: {
          acceptanceMatrix: { path: matrixPath, sha256: sha256(matrixText) },
          continuousExecutionContract: { path: continuousPath, sha256: sha256(continuousText) },
          missingOriginalCompanions: ['E:/ACCEPTANCE_MATRIX.json', 'E:/validate_acceptance.py'],
        },
      },
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ outputPath, taskCount: contract.taskCount, issueCount: contract.importIssues.length, matrixSha256: contract.provenance.sources.acceptanceMatrix.sha256, continuousSha256: contract.provenance.sources.continuousExecutionContract.sha256, backlogSha256: contract.provenance.sources.authoritativeBacklog.sha256 }, null, 2)}\n`);
    return;
  }

  if (command === 'validate') {
    const candidatePath = options.candidate;
    const reviewPath = options.review;
    const requiredPath = options.required;
    assert(candidatePath && reviewPath && requiredPath, 'Usage: validate --candidate PATCH --review luna-review.json --required case-ids.json');
    const requiredCaseIds = JSON.parse(await readFile(requiredPath, 'utf8'));
    const result = await validateAcceptanceBookkeeping({ candidatePath, reviewPath, requiredCaseIds });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.bookkeepingValid) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
