import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateAcceptanceBookkeeping } from '../tools/astra/derive-acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIREMENTS_PATH = path.join(ROOT, 'docs/astra/acceptance-contract/requirements-map.json');
const BACKLOG_PATH = path.join(ROOT, 'docs/astra/combined-backlog.json');
const tempRoots = [];

after(async () => {
  await Promise.all(tempRoots.map(tempRoot => rm(tempRoot, { recursive: true, force: true })));
});

async function makeDossier({ requiredCaseIds = ['S02-B01', 'S02-01'] } = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'astra-acceptance-'));
  tempRoots.push(tempRoot);
  const logsDir = path.join(tempRoot, 'logs');
  await mkdir(logsDir, { recursive: true });
  const candidatePath = path.join(tempRoot, 'candidate.patch');
  const reviewPath = path.join(tempRoot, 'luna-review.json');
  const notesPath = path.join(tempRoot, 'luna-review.md');
  const candidate = Buffer.from('synthetic frozen candidate patch\n');
  await writeFile(candidatePath, candidate);
  await writeFile(notesPath, 'Synthetic independent review notes.\n');
  const requiredTests = [];
  for (const id of requiredCaseIds) {
    const log = Buffer.from(`${id}: PASS\n`);
    const logPath = path.join(logsDir, `${id}.log`);
    await writeFile(logPath, log);
    requiredTests.push({ id, result: 'PASS', log_path: `logs/${id}.log`, log_sha256: sha256(log) });
  }
  const review = {
    task_id: 'S02',
    candidate_patch_sha256: sha256(candidate),
    reviewer_model: 'Luna',
    reviewer_session: 'synthetic-distinct-session',
    reviewer_independent: true,
    decision: 'ACCEPTED',
    required_tests: requiredTests,
    critical_findings_open: 0,
    high_findings_open: 0,
    tested_exact_candidate: true,
    legacy_regression: 'PASS',
    review_notes_path: 'luna-review.md',
  };
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  return { candidatePath, reviewPath, notesPath, logsDir, requiredCaseIds, review };
}

test('derived matrix covers exactly the existing 52-task DAG and required release edge', async () => {
  const map = JSON.parse(await readFile(REQUIREMENTS_PATH, 'utf8'));
  const backlog = JSON.parse(await readFile(BACKLOG_PATH, 'utf8'));
  assert.equal(map.artifactType, 'locally-derived-acceptance-requirements-map');
  assert.equal(map.taskCount, 52);
  assert.deepEqual(map.importIssues, []);
  assert.deepEqual(map.taskIds, backlog.tasks.map(task => task.id).sort());
  assert.deepEqual(map.taskDAG, Object.fromEntries(backlog.tasks.map(task => [task.id, task.dependencies])));
  assert.deepEqual(map.topologicalOrder, backlog.topologicalOrder);
  assert.ok(backlog.tasks.find(task => task.id === 'S33').dependencies.includes('X14'));
  assert.deepEqual(map.optionalOutsideInitialLaunch, ['X16']);
  assert.ok(map.provenance.missingOriginalCompanions.includes('E:/ACCEPTANCE_MATRIX.json'));
  assert.ok(map.provenance.missingOriginalCompanions.includes('E:/validate_acceptance.py'));
  assert.ok(map.tasks.every(task => task.statusAtImport === 'NOT_ACCEPTED'));
  assert.ok(map.tasks.every(task => task.originalBacklogCases.every(testCase => /-B\d{2}$/.test(testCase.id))));
});

test('valid review bookkeeping stays REVIEW_PENDING because session identity needs independent verification', async () => {
  const dossier = await makeDossier();
  const result = await validateAcceptanceBookkeeping(dossier);
  assert.equal(result.status, 'REVIEW_PENDING');
  assert.equal(result.bookkeepingValid, true);
  assert.equal(result.reviewerIdentityVerified, false);
  assert.match(result.issues.join(' '), /out-of-band session verification/);
});

test('changed candidate hash cannot pass bookkeeping', async () => {
  const dossier = await makeDossier();
  await writeFile(dossier.candidatePath, 'changed candidate patch\n');
  const result = await validateAcceptanceBookkeeping(dossier);
  assert.equal(result.bookkeepingValid, false);
  assert.match(result.issues.join(' '), /digest does not match/);
});

test('missing review cannot pass bookkeeping', async () => {
  const dossier = await makeDossier();
  await rm(dossier.reviewPath);
  const result = await validateAcceptanceBookkeeping(dossier);
  assert.equal(result.bookkeepingValid, false);
  assert.match(result.issues.join(' '), /Review JSON unavailable/);
});

test('missing required case cannot pass bookkeeping', async () => {
  const dossier = await makeDossier();
  dossier.review.required_tests.pop();
  await writeFile(dossier.reviewPath, JSON.stringify(dossier.review));
  const result = await validateAcceptanceBookkeeping(dossier);
  assert.equal(result.bookkeepingValid, false);
  assert.match(result.issues.join(' '), /Required case S02-01 is missing/);
});

test('non-pass review case cannot pass bookkeeping', async () => {
  const dossier = await makeDossier();
  dossier.review.required_tests[0].result = 'SKIP';
  await writeFile(dossier.reviewPath, JSON.stringify(dossier.review));
  const result = await validateAcceptanceBookkeeping(dossier);
  assert.equal(result.bookkeepingValid, false);
  assert.match(result.issues.join(' '), /did not PASS/);
});

test('tampered log cannot pass bookkeeping', async () => {
  const dossier = await makeDossier();
  await writeFile(path.join(dossier.logsDir, 'S02-B01.log'), 'edited after review\n');
  const result = await validateAcceptanceBookkeeping(dossier);
  assert.equal(result.bookkeepingValid, false);
  assert.match(result.issues.join(' '), /log digest mismatch/);
});

test('claimed reviewer identity fields alone cannot yield ACCEPTED', async () => {
  const dossier = await makeDossier();
  dossier.review.reviewer_session = 'invented-session-id';
  dossier.review.reviewer_independent = true;
  dossier.review.reviewer_model = 'Luna';
  await writeFile(dossier.reviewPath, JSON.stringify(dossier.review));
  const result = await validateAcceptanceBookkeeping(dossier);
  assert.equal(result.status, 'REVIEW_PENDING');
  assert.equal(result.bookkeepingValid, true);
  assert.equal(result.reviewerIdentityVerified, false);
});

test('missing reviewer session cannot pass bookkeeping', async () => {
  const dossier = await makeDossier();
  dossier.review.reviewer_session = '';
  await writeFile(dossier.reviewPath, JSON.stringify(dossier.review));
  const result = await validateAcceptanceBookkeeping(dossier);
  assert.equal(result.bookkeepingValid, false);
  assert.match(result.issues.join(' '), /Reviewer session provenance is missing/);
});
