// Persistent host supervisor. The model runs only inside Docker, one turn at a time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { validateKey, nextReset } from './gateway.mjs';
import { runtimePath } from './paths.mjs';

const runtime = runtimePath();
const configPath = path.join(runtime, 'config.json');
if (!fs.existsSync(configPath)) throw new Error('Run node tools/freeinference/bootstrap.mjs first');
const config = JSON.parse(fs.readFileSync(configPath));
const statePath = path.join(runtime, 'runner-state.json');
const stopPath = path.join(runtime, 'STOP');
const lockPath = path.join(runtime, 'runner.lock');
const read = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
if (process.argv.includes('--status')) { console.log(JSON.stringify(read(statePath), null, 2)); process.exit(0); }
if (process.argv.includes('--stop')) {
  fs.writeFileSync(stopPath, new Date().toISOString());
  console.log('Stop requested. The active agent container will be stopped; checkpoints are preserved.');
  process.exit(0);
}
if (process.argv.includes('--resume')) fs.rmSync(stopPath, { force: true });
if (fs.existsSync(stopPath)) { console.log('Stopped by user. Add --resume to restart.'); process.exit(0); }
try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); }
catch {
  const previousPid = Number(fs.readFileSync(lockPath, 'utf8'));
  let exists = false;
  try { process.kill(previousPid, 0); exists = true; } catch {}
  if (exists) { console.log('A supervisor is already running.'); process.exit(0); }
  fs.rmSync(lockPath);
  fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
}
let state = { schemaVersion: 1, ...read(statePath), pid: process.pid, model: config.model, workspace: config.workspace, releaseReady: false };
function checkpoint(status, details = {}) {
  state = { ...state, ...details, status, updatedAt: new Date().toISOString() };
  const temp = `${statePath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2)); fs.renameSync(temp, statePath);
}
const composeArgs = ['compose', '-f', path.join(runtime, 'compose.json')];
const sync = (args, timeout = 30000) => execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
const sleep = async ms => {
  const end = Date.now() + ms;
  while (Date.now() < end && !fs.existsSync(stopPath)) {
    await new Promise(resolve => setTimeout(resolve, Math.min(5000, end - Date.now())));
    checkpoint(state.status);
  }
};
const logs = path.join(runtime, 'logs'); fs.mkdirSync(logs, { recursive: true });
async function command(args, timeout, logFile, onEvent = () => {}) {
  return await new Promise(resolve => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = fs.createWriteStream(logFile, { flags: 'a' });
    let pending = '', sessionId = null, timedOut = false, stopped = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const watch = setInterval(() => {
      checkpoint(state.status);
      if (fs.existsSync(stopPath)) { stopped = true; child.kill(); }
    }, 5000);
    const data = chunk => {
      output.write(chunk);
      pending += chunk.toString();
      while (pending.includes('\n')) {
        const index = pending.indexOf('\n'), line = pending.slice(0, index); pending = pending.slice(index + 1);
        try {
          const event = JSON.parse(line);
          sessionId = event.sessionID || event.sessionId || sessionId;
          onEvent(event);
        } catch {}
      }
      if (pending.length > 200000) pending = pending.slice(-200000);
    };
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.once('error', () => {});
    child.once('close', code => {
      clearTimeout(timer); clearInterval(watch); output.end();
      // Killing docker exec does not reliably kill the exec process. Stop agent itself.
      if (timedOut || stopped) { try { sync([...composeArgs, 'stop', '-t', '10', 'agent']); } catch {} }
      resolve({ code, sessionId, timedOut, stopped });
    });
  });
}
function fingerprint() {
  const hash = crypto.createHash('sha256');
  const walk = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (['.git', 'node_modules', 'data', 'orchestration', '.opencode'].includes(name)) continue;
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(file);
      else { hash.update(path.relative(config.workspace, file)); hash.update(fs.readFileSync(file)); }
    }
  };
  walk(config.workspace);
  const tasks = read(path.join(config.workspace, 'orchestration', 'tasks.json'), []);
  hash.update(JSON.stringify(tasks));
  return hash.digest('hex');
}
function releaseLedgerValid() {
  const requirements = read(path.join(config.workspace, 'orchestration', 'requirements.json'), []);
  const tasks = read(path.join(config.workspace, 'orchestration', 'tasks.json'), []);
  const project = read(path.join(config.workspace, 'orchestration', 'state.json'));
  const expected = Array.from({ length: 96 }, (_, index) => `F${String(index + 1).padStart(3, '0')}`);
  return project.releaseReady === true && Array.isArray(requirements) &&
    new Set(requirements.map(row => row.id)).size === requirements.length &&
    expected.every(id => requirements.some(row => row.id === id && row.status === 'passed' && row.evidence?.length && row.tests?.length && (!row.liveValidationRequired || row.liveValidation === 'passed'))) &&
    Array.isArray(tasks) && Array.from({ length: 24 }, (_, index) => `P${String(index).padStart(2, '0')}`).every(id => tasks.some(row => row.id === id && row.status === 'passed' && row.evidence?.length));
}
try {
  let prepared = false;
  for (;;) {
    if (fs.existsSync(stopPath)) { checkpoint('stopped'); break; }
    let key = '';
    try { key = fs.readFileSync(config.keyPath, 'utf8'); } catch {}
    if (!validateKey(key)) {
      checkpoint('awaiting_credentials', { blocker: 'Full FreeInference key required in the local key file', nextAction: 'Save key locally; supervisor checks every 30 seconds' });
      await sleep(config.retryMs); continue;
    }
    key = ''; // Never pass the actual key to the agent environment or prompt.
    try { sync(['info', '--format', '{{.ServerVersion}}'], 15000); }
    catch { checkpoint('awaiting_docker', { blocker: 'Docker Desktop must be running' }); await sleep(60000); continue; }
    try {
      sync([...composeArgs, 'up', '-d']);
      if (!prepared) {
        checkpoint('preparing_dependencies');
        const result = await command([...composeArgs, 'exec', '-T', 'agent', 'npm', 'ci'], 600000, path.join(logs, 'dependencies.log'));
        if (result.code !== 0) throw new Error('Agent dependency installation failed; see dependencies.log');
        prepared = true;
      }
      const quota = read(path.join(runtime, 'gateway-state', 'quota.json'));
      if (quota.blockedUntil && Date.parse(quota.blockedUntil) > Date.now()) {
        checkpoint('waiting_quota', { nextAttemptAt: quota.blockedUntil, blocker: 'Daily quota/budget; resumes automatically after UTC reset' });
        await sleep(Math.min(Date.parse(quota.blockedUntil) - Date.now() + 2000, 60000)); continue;
      }
      checkpoint('validating_model');
      const raw = sync([...composeArgs, 'exec', '-T', 'gateway', 'node', '/runtime/probe.mjs'], 45000);
      const probe = JSON.parse(raw.trim());
      if (!probe.ok) throw new Error('Configured model is unavailable to this account');
      const turn = (state.turn || 0) + 1, before = fingerprint();
      const logFile = path.join(logs, `turn-${String(turn).padStart(5, '0')}.ndjson`);
      const priorityTaskPath = path.join(config.workspace, 'orchestration', 'CURRENT_COLLABORATION.md');
      const priorityTask = fs.existsSync(priorityTaskPath) ? fs.readFileSync(priorityTaskPath, 'utf8') : '';
      const prompt = `${priorityTask}\n\nContinue odd-ecosys implementation under AGENTS.md and ORCHESTRATOR_GLM_5_3.md, respecting the latest human authorization in orchestration/OWNERSHIP.md. Read durable ledgers and your assigned resume checkpoint. Perform the next concrete reviewable ticket inside your assigned file ownership, implement it, run meaningful tests against synthetic fixtures, inspect failures and persist actual evidence. Do not merely describe work. No skipped requirements, no fake successes, no weakened tests. Record external blockers while continuing independent authorized local work. Work only in /workspace. Update your assigned checkpoint and exact next action before ending. Never edit Codex-owned files or restart shared infrastructure. Source changes are isolated until reviewed and synchronized. Current supervisor turn: ${turn}; consecutive turns without code/ticket progress: ${state.noProgress || 0}. If earlier attempts failed, investigate logs/checkpoints and select a different valid approach. Keep releaseReady false until all local and live gates have been demonstrated.`;
      const args = [...composeArgs, 'exec', '-T', 'agent', 'opencode', 'run', '--format', 'json', '--model', `freeinference/${config.model}`, '--title', 'odd-ecosys sequential production implementation'];
      if (state.sessionId) args.push('--session', state.sessionId);
      args.push(prompt);
      let agentError = false;
      checkpoint('working', { turn, logFile, blocker: null, nextAttemptAt: null });
      const result = await command(args, config.maxTurnMs, logFile, event => { if (event.type === 'error') agentError = true; });
      const after = fingerprint(), noProgress = before === after ? (state.noProgress || 0) + 1 : 0;
      checkpoint('checkpointed', { sessionId: result.sessionId || state.sessionId || null, lastExitCode: result.code, agentError, timedOut: result.timedOut, noProgress, snapshotHash: after });
      if (result.stopped) continue;
      if (releaseLedgerValid()) {
        checkpoint('verifying_release');
        const checks = await command([...composeArgs, 'exec', '-T', 'agent', 'npm', 'test'], 600000, path.join(logs, `release-${turn}.log`));
        // Attestation is outside the model-mounted workspace and must bind to current code.
        const attestation = read(path.join(runtime, 'release-attestation.json'));
        if (checks.code === 0 && attestation.snapshotHash === after && attestation.liveGatesVerified === true && attestation.sourceSynchronized === true) {
          checkpoint('complete', { releaseReady: true }); break;
        }
        checkpoint('awaiting_release_evidence', { blocker: 'Independent live-gate evidence and reviewed source synchronization required' });
        await sleep(3600000); continue;
      }
      if (noProgress >= 3) {
        checkpoint('needs_attention', { blocker: 'Repeated turns without source/ticket progress; retained checkpoint, retry frequency reduced' });
        await sleep(noProgress >= 10 ? 3600000 : 300000);
      } else await sleep(agentError || result.code !== 0 ? Math.min(600000, 30000 * 2 ** Math.min(noProgress, 4)) : 3000);
    } catch (err) {
      const quota = read(path.join(runtime, 'gateway-state', 'quota.json'));
      const kind = quota.lastFailure?.kind;
      checkpoint(kind === 'credentials' || kind === 'access' ? 'awaiting_provider_access' : 'retrying', {
        blocker: err.message.startsWith('Command failed') ? `Provider/container operation failed${kind ? `: ${kind}` : ''}; inspect local logs` : err.message,
        nextAttemptAt: new Date(Date.now() + (kind === 'credentials' || kind === 'access' ? 300000 : 60000)).toISOString(),
      });
      await sleep(kind === 'credentials' || kind === 'access' ? 300000 : 60000);
    }
  }
} finally {
  if (fs.existsSync(lockPath) && fs.readFileSync(lockPath, 'utf8') === String(process.pid)) fs.rmSync(lockPath);
}
