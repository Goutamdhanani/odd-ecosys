import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runtimePath } from './paths.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const orchestration = path.join(root, 'orchestration');
const docs = path.join(root, 'docs');
fs.mkdirSync(orchestration, { recursive: true }); fs.mkdirSync(docs, { recursive: true });
const spec = fs.readFileSync(path.join(root, 'ORCHESTRATOR_GLM_5_3.md'), 'utf8');
const requirements = [...spec.matchAll(/^\| (F\d{3}) \| (P\d{2}) \| (.+?) \|$/gm)].map(([, id, phase, description]) => ({ id, phase, description, status: 'pending', implementation: [], tests: [`T-${id}`], evidence: [], liveValidationRequired: true, liveValidation: 'pending', releaseBlockers: ['Implementation and local/live validation pending'], lastVerifiedRevision: null }));
if (requirements.length !== 96) throw new Error(`Expected 96 requirement records; found ${requirements.length}`);
const defects = [...spec.matchAll(/^\| (B\d{2}) \| (.+?) \| (.+?) \|$/gm)].map(([, id, description, acceptance]) => ({ id, description, acceptance, status: 'pending', tests: [], evidence: [] }));
defects.push({ id: 'B27', description: 'Verifier cache refresh interval keeps completed CLI process alive', acceptance: 'All CLI commands exit after completion without force-exit', status: 'implemented_unverified', tests: ['tests/cli.test.mjs'], evidence: [] });
defects.push({ id: 'B28', description: 'Dependency audit found high vulnerabilities in nodemailer, undici and cheerio dependency paths', acceptance: 'Dependency updates are pinned/reconciled and tests plus audit pass', status: 'implemented_unverified', tests: ['npm test', 'npm audit'], evidence: [] });
const phases = [...spec.matchAll(/^### (P\d{2}) — (.+)$/gm)].map(([, id, description], index) => ({ id, description, dependencies: index ? [`P${String(index - 1).padStart(2, '0')}`] : [], status: index ? 'pending' : 'in_progress', requirements: requirements.filter(row => row.phase === id).map(row => row.id), evidence: [], blockers: [] }));
const writeInitial = (name, value) => {
  const file = path.join(orchestration, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
writeInitial('requirements.json', requirements); writeInitial('defects.json', defects); writeInitial('tasks.json', phases);
let gitScope;
try { gitScope = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim(); } catch { gitScope = null; }
writeInitial('state.json', { schemaVersion: 1, projectRoot: root, isolatedWorkspace: path.join(runtimePath(), 'workspace'), gitScope, phase: 'P00', task: 'baseline-inventory-and-runner-validation', architecture: 'Warmbly candidate; unverified', releaseReady: false, lastVerifiedRevision: null, nextAction: 'Validate isolated environment and complete P00 inventory/gates; then remaining P01 defects', blockers: ['FreeInference key not configured', 'Live provider/integration credentials and release validation pending'], updatedAt: new Date().toISOString() });
const files = [], exports = [], routes = [], actions = [];
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', 'orchestration', 'docs'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { scan(absolute); continue; }
    const buffer = fs.readFileSync(absolute), source = buffer.toString();
    files.push({ path: relative, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
    if (relative.endsWith('.js') || relative.endsWith('.mjs')) {
      for (const [, name] of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) exports.push({ file: relative, name });
    }
    source.split(/\r?\n/).forEach((line, index) => {
      if (relative === 'server.js' && /pathname\s*===|pathname\.match/.test(line)) routes.push({ file: relative, line: index + 1, expression: line.trim(), coverage: 'unverified' });
      if (relative.startsWith('js/') && /onclick=|addEventListener\(/.test(line)) actions.push({ file: relative, line: index + 1, expression: line.trim(), coverage: 'unverified' });
    });
  }
}
scan(root);
const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts;
const inventory = { generatedAt: new Date().toISOString(), projectRoot: root, gitScope, excludedPrivateDirectories: ['data', 'node_modules'], files, exports, routeExpressions: routes, actionExpressions: actions, scripts, coverageStatus: 'Source extraction; dynamic route/action resolution and full test mapping still pending' };
fs.writeFileSync(path.join(docs, 'inventory.json'), JSON.stringify(inventory, null, 2));
fs.writeFileSync(path.join(docs, 'INVENTORY.md'), `# Current source inventory\n\nGenerated: ${inventory.generatedAt}. Root: ${root}. Parent Git scope: ${gitScope}. Scoped Git repository is created separately for the sanitized agent workspace.\n\n${files.length} source/config/document/tool files; ${exports.length} exported functions; ${routes.length} route expressions; ${actions.length} UI action expressions. This is extracted source, not proof every runtime branch has coverage. Full records and line references are in inventory.json. Private data contents are excluded.\n\n## Pages\n\nDashboard, leads/discovery, qualification, verification, personalization/approval, mailboxes, campaigns/A-B testing, batches and analytics are implemented by js/app.js plus corresponding js modules. Cross-page interactions and every actionable control require P00 coverage mapping and later browser evidence.\n\n## Commands\n\n${Object.entries(scripts).map(([key, command]) => `- **${key}:** \`${command}\``).join('\n')}\n\n## Remaining inventory work\n\nResolve regex routes/method branches, UI event handlers and all request/response schemas into executable contract tests. Map every feature ID and defect to positive/negative/error/restart coverage. Do not mark this extraction as complete test coverage.\n`);
if (!fs.existsSync(path.join(orchestration, 'RESUME.md'))) fs.writeFileSync(path.join(orchestration, 'RESUME.md'), '# Resume checkpoint\n\nP00 is in progress. The host source has initial CLI and SMTP truthfulness fixes plus meaningful regression tests. Complete baseline inventory coverage, verify isolated Docker/native dependencies, record source-bound evidence and restore check, then finish B04–B13 and remaining P01 truthfulness defects. B27 records CLI process liveness; B28 records dependency advisories. Requirements F001–F096 remain pending. No production readiness claimed. Read runner README and complete the full orchestrator in dependency order. Provider key stays outside the model workspace; no real database/data/credentials are copied to the model workspace.\n');
console.log(JSON.stringify({ requirements: requirements.length, defects: defects.length, phases: phases.length, files: files.length, routeExpressions: routes.length, actionExpressions: actions.length }));
