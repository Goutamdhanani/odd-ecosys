import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { locationFile, runtimePath } from './paths.mjs';

const source = path.resolve(import.meta.dirname, '../..');
const runtime = runtimePath();
const workspace = path.join(runtime, 'workspace');
fs.mkdirSync(runtime, { recursive: true });
fs.writeFileSync(locationFile, JSON.stringify({ runtime }, null, 2));
if (fs.existsSync(path.join(runtime, 'config.json'))) {
  console.log('Runtime already exists; preserved working copy and checkpoints.');
  process.exit(0);
}
fs.mkdirSync(workspace, { recursive: true });
const hash = crypto.createHash('sha256');
const files = [];
const roots = ['config', 'css', 'js', 'pipeline', 'tests', 'tools', 'orchestration', 'docs'];
const top = ['index.html', 'server.js', 'package.json', 'package-lock.json', '.gitignore', 'plan.md', 'real.md', 'PROJECT_ANALYSIS.md', 'ORCHESTRATOR_GLM_5_3.md'];
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, /password|api[_-]?key|secret|access[_-]?token|refresh[_-]?token/i.test(key) ? null : scrub(child)]));
}
function copy(relative) {
  const input = path.join(source, relative);
  if (!fs.existsSync(input)) return;
  if (fs.lstatSync(input).isSymbolicLink()) throw new Error(`Symlinks require manual review: ${relative}`);
  if (fs.statSync(input).isDirectory()) {
    for (const name of fs.readdirSync(input)) {
      if (/^(node_modules|\.git|data|evidence|backups|\.env.*)$/.test(name)) continue;
      copy(path.join(relative, name));
    }
    return;
  }
  if (/\.(db|key|pem|pfx|csv|txt)$/i.test(input)) return;
  if (!/\.(js|mjs|json|html|css|md|ya?ml)$/.test(input) && !['.gitignore', 'Dockerfile'].includes(path.basename(input))) return;
  let content = fs.readFileSync(input, 'utf8');
  if (relative.startsWith(`config${path.sep}`) && input.endsWith('.json')) content = JSON.stringify(scrub(JSON.parse(content)), null, 2) + '\n';
  if (/hyi-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
    throw new Error(`Possible credential in source: ${relative}; refusing provider workspace copy`);
  }
  const output = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, content);
  files.push({ path: relative.replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(content).digest('hex') });
  hash.update(relative).update(content);
}
top.forEach(copy); roots.forEach(copy);
const token = crypto.randomBytes(32).toString('hex');
const config = { schemaVersion: 1, source, runtime, workspace, keyPath: path.join(os.homedir(), '.codex', 'secrets', 'freeinference.key'), model: 'glm-5.3-flash', image: 'odd-ecosys-coder:1.18.34', maxTurnMs: 1800000, retryMs: 30000, dailyBudget: null, baselineHash: hash.digest('hex'), createdAt: new Date().toISOString() };
fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(runtime, 'snapshot.json'), JSON.stringify({ ...config, files }, null, 2));
fs.writeFileSync(path.join(runtime, 'gateway.env'), `GATEWAY_TOKEN=${token}\nCODING_MODEL=${config.model}\n`);
const agentConfig = {
  $schema: 'https://opencode.ai/config.json', model: `freeinference/${config.model}`, small_model: `freeinference/${config.model}`,
  enabled_providers: ['freeinference'], share: 'disabled', autoupdate: false,
  instructions: ['AGENTS.md'],
  provider: { freeinference: { npm: '@ai-sdk/openai-compatible', name: 'FreeInference isolated gateway', options: { baseURL: 'http://gateway:8080/v1', apiKey: '{env:GATEWAY_TOKEN}' }, models: { [config.model]: { name: 'GLM 5.3 Flash', limit: { context: 1000000, output: 8192 } } } } },
  permission: { '*': 'allow', external_directory: 'deny', task: 'deny', question: 'deny', doom_loop: 'deny', read: { '*': 'allow', '.env*': 'deny', '*.key': 'deny' }, bash: { '*': 'allow', 'git push*': 'deny', 'docker*': 'deny', 'ssh*': 'deny', 'printenv*': 'deny', 'env': 'deny' } },
};
fs.writeFileSync(path.join(runtime, 'opencode.json'), JSON.stringify(agentConfig, null, 2));
fs.writeFileSync(path.join(workspace, 'AGENTS.md'), `# Mandatory implementation contract\n\nRead ORCHESTRATOR_GLM_5_3.md and orchestration/RESUME.md. This is a sanitized isolated development copy. Execute one reviewable ticket per turn; the supervisor will resume you. Work sequentially P00–P23, with actual tests and recorded evidence. No random/simulated production success, no fake cost/delivery/verification/CRM result. Reuse audited OSS; do not rewrite equivalent infrastructure. No external mail or production deployment, no purchases, no scraping real private data. Use only synthetic fixture data in tests. Never copy credentials, private mailbox/lead content or host data into prompts. The real API key is held by a separate gateway container. Do not attempt to access it. Preserve all scope IDs and exact blockers; do not disable/delete/weaken tests to pass. Missing credentials never means success. Provider failures require checkpointing and resumable work. Keep releaseReady false until every local and live gate has real evidence. Code in this copy needs review/synchronization into the source project. No pushing, automatic deployment or pretending synchronization occurred. Before ending every turn, update RESUME.md and state.json with exact next action.\n`);
for (const command of [['init'], ['config', 'user.name', 'odd-ecosys local runner'], ['config', 'user.email', 'runner@localhost'], ['add', '--', '.'], ['commit', '-m', 'Sanitized development baseline']]) {
  execFileSync('git', command, { cwd: workspace, stdio: 'pipe' });
}
const volume = value => value.replaceAll('\\', '/');
const compose = {
  name: 'odd-ecosys-runner',
  services: {
    gateway: { image: config.image, user: '0:0', command: ['node', '/runtime/gateway.mjs'], env_file: [volume(path.join(runtime, 'gateway.env'))], volumes: [`${volume(path.join(source, 'tools', 'freeinference'))}:/runtime:ro`, `${volume(config.keyPath)}:/run/secrets/freeinference.key:ro`, `${volume(path.join(runtime, 'gateway-state'))}:/state`], restart: 'unless-stopped', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], mem_limit: '512m', pids_limit: 100 },
    agent: { image: config.image, working_dir: '/workspace', env_file: [volume(path.join(runtime, 'gateway.env'))], environment: { OPENCODE_CONFIG: '/agent-config/opencode.json', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_SHARE: 'true', NODE_ENV: 'test', ODD_DB_PATH: '/tmp/odd-agent.db' }, volumes: [`${volume(workspace)}:/workspace`, `${volume(path.join(runtime, 'opencode.json'))}:/agent-config/opencode.json:ro`, 'agent-state:/home/node/.local/share', 'agent-cache:/home/node/.cache'], cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], mem_limit: '6g', pids_limit: 300, restart: 'unless-stopped' },
  },
  volumes: { 'agent-state': {}, 'agent-cache': {} },
};
fs.mkdirSync(path.join(runtime, 'gateway-state'), { recursive: true });
fs.writeFileSync(path.join(runtime, 'compose.json'), JSON.stringify(compose, null, 2));
console.log(JSON.stringify({ workspace, filesCopied: files.length, baselineHash: config.baselineHash, model: config.model, realDataCopied: false }));
