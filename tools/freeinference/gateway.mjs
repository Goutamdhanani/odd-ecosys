// Credential gateway. Only this container receives the real FreeInference key.
import http from 'node:http';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

export function classifyFailure(status, text = '') {
  if (/concurrent request/i.test(text)) return 'concurrency';
  if (/quota|daily limit|insufficient.*credit|budget.*exceed/i.test(text)) return 'quota';
  if (status === 401) return 'credentials';
  if (status === 403) return 'access';
  if (status === 429) return 'throttle';
  if (status >= 500) return 'transient';
  return 'request';
}
export function nextReset(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}
export function validateKey(value) {
  const key = value.trim();
  return key.length >= 20 && !/[\s*]/.test(key) && !/paste|placeholder|your.*key/i.test(key);
}
export function validateChat(body, model) {
  if (body.model !== model) throw new Error('Only the configured account model is permitted');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('Messages are required');
  body.max_tokens = Math.min(Number(body.max_tokens) || 8192, 8192);
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) throw new Error('Invalid output limit');
  delete body.max_completion_tokens;
  return body;
}

// dailyLimit=null leaves the plan quota authoritative; reservedDollars is then telemetry only.
export async function startGateway({ keyPath, token, model = 'glm-5.3-flash', stateDir, upstream = 'https://freeinference.org/v1', port = 8080, dailyLimit = null }) {
  if (!token || token.length < 24) throw new Error('Gateway token is required');
  if (dailyLimit !== null && (!Number.isFinite(dailyLimit) || dailyLimit <= 0)) throw new Error('Daily limit must be null (provider enforced) or a positive finite number');
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, 'quota.json');
  let tail = Promise.resolve();
  const save = state => {
    const temp = `${statePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, statePath);
  };
  const load = () => {
    const today = new Date().toISOString().slice(0, 10);
    let state;
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { state = {}; }
    return state.day === today ? state : { day: today, reservedDollars: 0, requests: 0, blockedUntil: null };
  };
  function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  }
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'Local gateway authentication required' });
    if (req.url === '/health') return json(res, 200, { ok: true, ...load() });
    if (!((req.method === 'GET' && req.url === '/v1/models') || (req.method === 'POST' && req.url === '/v1/chat/completions'))) {
      return json(res, 404, { error: 'Endpoint not permitted' });
    }
    // Queue all calls, including auxiliary model discovery, through one slot.
    const work = async () => {
      if (res.destroyed) return;
      let key;
      try { key = fs.readFileSync(keyPath, 'utf8').trim(); } catch { return json(res, 503, { error: 'Missing local API key', kind: 'credentials' }); }
      if (!validateKey(key)) return json(res, 503, { error: 'Missing or masked local API key', kind: 'credentials' });
      let payload;
      if (req.method === 'POST') {
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 1500000) return json(res, 413, { error: 'Request exceeds coding context budget' });
          chunks.push(chunk);
        }
        try { payload = JSON.stringify(validateChat(JSON.parse(Buffer.concat(chunks).toString()), model)); }
        catch (err) { return json(res, 400, { error: err.message }); }
        // A byte upper bound is deliberately conservative. Provider quota is authoritative.
        const reserve = Buffer.byteLength(payload) * 0.3 / 1000000 + 8192 / 1000000;
        const state = load();
        if (state.blockedUntil && Date.parse(state.blockedUntil) > Date.now()) {
          return json(res, 429, { error: 'Daily quota exhausted', kind: 'quota', retryAt: state.blockedUntil });
        }
        if (dailyLimit !== null && state.reservedDollars + reserve > dailyLimit) {
          state.blockedUntil = nextReset(); save(state);
          return json(res, 429, { error: 'Local conservative daily budget reached', kind: 'quota', retryAt: state.blockedUntil });
        }
        state.reservedDollars += reserve; state.requests++; save(state);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 180000);
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      try {
        const remote = await fetch(`${upstream}${req.url.slice(3)}`, {
          method: req.method, signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          ...(payload ? { body: payload } : {}),
        });
        if (!remote.ok) {
          const body = await remote.text();
          const kind = classifyFailure(remote.status, body);
          const state = load();
          state.lastFailure = { kind, status: remote.status, at: new Date().toISOString() };
          if (kind === 'quota') state.blockedUntil = nextReset();
          save(state);
          // Do not leak upstream echoed data, headers or key to agent logs.
          return json(res, remote.status, { error: `FreeInference request failed: ${kind}`, kind, retryAt: state.blockedUntil });
        }
        res.writeHead(remote.status, { 'content-type': remote.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
        await pipeline(Readable.fromWeb(remote.body), res);
      } catch (err) {
        if (!res.headersSent) json(res, 502, { error: err.name === 'AbortError' ? 'Provider timeout' : 'Provider network failure', kind: 'transient' });
        else res.destroy();
      } finally { clearTimeout(timeout); }
    };
    const pending = tail.then(work);
    tail = pending.catch(() => { if (!res.headersSent) json(res, 500, { error: 'Gateway operation failed' }); else res.destroy(); });
  });
  await new Promise(resolve => server.listen(port, '0.0.0.0', resolve));
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await startGateway({ keyPath: process.env.KEY_PATH || '/run/secrets/freeinference.key', token: process.env.GATEWAY_TOKEN, model: process.env.CODING_MODEL, stateDir: '/state' });
}
