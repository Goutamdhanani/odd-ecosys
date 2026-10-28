import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createAstraTenantStore } from '../pipeline/astra-tenant-store.js';
import { canAccessOperatorWorkspace, handleAstraApiRequest } from '../pipeline/astra-api.js';
import { createAstraContextProof } from '../pipeline/astra-tenant-context.js';

const secret = 'workspace-discovery-fixture-secret-0123456789';
const activeWorkspace = {
  id: 'e1c6bdfb-13b1-4b1a-8f3a-e4c4682c4b77', name: 'Example workspace', role: 'reviewer', status: 'active',
};

function responseRecorder() {
  return {
    writableEnded: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; this.writableEnded = true; },
  };
}

test('GET /api/astra/workspaces binds discovery to the authenticated session and derives capabilities from tenant roles', async () => {
  const calls = [];
  const store = {
    async listMyWorkspaces(args) { calls.push(args); return [{ ...activeWorkspace }]; },
  };
  const res = responseRecorder();
  const handled = await handleAstraApiRequest({
    req: { method: 'GET' }, res,
    // The query is not passed as identity; only the session id is trusted.
    pathname: '/api/astra/workspaces', session: { id: 7, role: 'owner' }, store,
  });
  assert.equal(handled, true);
  assert.deepEqual(calls, [{ userId: '7' }]);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    workspaces: [activeWorkspace],
    capabilities: { customerConsole: true, operatorWorkspace: false },
    releaseReady: false,
  }, 'a global owner role does not grant Astra operator capability');

  assert.equal(await canAccessOperatorWorkspace({ session: { id: 7, role: 'owner' }, store }), false);
  const operatorStore = { async listMyWorkspaces() { return [{ ...activeWorkspace, role: 'operator' }]; } };
  assert.equal(await canAccessOperatorWorkspace({ session: { id: 7, role: 'reviewer' }, store: operatorStore }), true,
    'an actual tenant operator membership permits the advanced workspace regardless of global role');
});

test('workspace discovery refuses anonymous requests and ignores client principal fields', async () => {
  let calls = 0;
  const store = { async listMyWorkspaces() { calls += 1; return []; } };
  const anonymous = responseRecorder();
  assert.equal(await handleAstraApiRequest({ req: { method: 'GET' }, res: anonymous,
    pathname: '/api/astra/workspaces', session: null, store }), true);
  assert.equal(anonymous.status, 401);
  assert.equal(calls, 0);

  const forged = responseRecorder();
  await handleAstraApiRequest({ req: { method: 'GET', url: '/api/astra/workspaces?userId=1' }, res: forged,
    pathname: '/api/astra/workspaces', session: { id: 23, role: 'operator' }, store: {
      async listMyWorkspaces({ userId }) { calls += 1; assert.equal(userId, '23'); return []; },
    } });
  assert.equal(forged.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(forged.body).workspaces, []);
});

test('tenant store emits a short-lived, single-use signed discovery assertion for the verified user', async () => {
  const queries = [];
  const databaseNow = Date.now() + 5000;
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes('FROM pg_catalog.pg_roles AS r')) return { rows: [{
        rolsuper: false, rolbypassrls: false, app_member: true, owner_member: false,
        worker_member: false, privileged_member: false,
      }] };
      if (sql.includes('extract(epoch FROM clock_timestamp()) * 1000')) return { rows: [{ now_ms: String(databaseNow) }] };
      if (sql.includes('astra.list_my_workspaces')) return { rows: [{ ...activeWorkspace }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const store = createAstraTenantStore({ pool, contextSecret: secret });
  try {
    const rows = await store.listMyWorkspaces({ userId: 42 });
    assert.deepEqual(rows, [activeWorkspace]);
    const call = queries.find(entry => entry.sql.includes('astra.list_my_workspaces'));
    assert.ok(call);
    const [signedUserId, expiresAt, nonce, signature] = call.values;
    assert.equal(signedUserId, '42');
    assert.match(String(nonce), /^[0-9a-f-]{36}$/);
    assert.equal(typeof expiresAt, 'number');
    assert.equal(expiresAt, Math.floor(databaseNow / 1000) + 30,
      'proof expiry is based on the same database clock used by the verifier');
    const message = `discover_workspaces\n-\n${signedUserId}\n${expiresAt}\n${nonce}`;
    assert.equal(signature, createHmac('sha256', secret).update(message).digest('hex'));
  } finally {
    await store.close();
  }
});

test('032 grants only a security-definer discovery function and filters active tenant membership rows', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../migrations/astra/032-workspace-discovery.up.sql', import.meta.url), 'utf8');
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog, astra/i);
  assert.match(sql, /m\.user_id = p_user_id AND m\.revoked_at IS NULL AND t\.status = 'active'/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION astra\.list_my_workspaces\(text, bigint, uuid, text\) TO astra_app/i);
  assert.match(sql, /REVOKE ALL ON astra\.workspace_discovery_nonces FROM PUBLIC, astra_app, astra_worker/i);
  assert.doesNotMatch(sql, /GRANT\s+SELECT\s+ON\s+astra\.(?:tenants|memberships)\s+TO\s+astra_app/i);
  assert.match(sql, /p_expires_at > v_now \+ 30/);
  assert.match(sql, /INSERT INTO astra\.workspace_discovery_nonces/);
});

const fixtureUrl = process.env.ASTRA_WORKSPACE_TEST_DATABASE_URL;
const fixtureSecret = process.env.ASTRA_WORKSPACE_TEST_CONTEXT_SECRET;
test('032 real fixture: users see only active memberships; proof replay/expiry/malformed input and app table reads fail', {
  skip: !fixtureUrl || !fixtureSecret ? 'requires a new disposable PostgreSQL fixture migrated through 032' : false,
}, async () => {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: fixtureUrl, max: 3, connectionTimeoutMillis: 3000 });
  const store = createAstraTenantStore({ pool, contextSecret: fixtureSecret });
  const client = await pool.connect();
  const suffix = randomUUID();
  // Session IDs in the host auth system are JS-safe SQLite integers; use the
  // same representation in this tenant fixture instead of synthetic 19-digit IDs.
  const userOne = String(Math.floor(Math.random() * 8_000_000_000_000) + 1);
  const userTwo = String(Number(userOne) + 1);
  const invitationEmail = `r18-${suffix.slice(0, 20)}@example.test`;
  try {
    const tenantOne = await store.createTenant({ name: `R18 discovery A ${suffix}`, userId: userOne });
    const tenantTwo = await store.createTenant({ name: `R18 discovery B ${suffix}`, userId: userTwo });
    const invitation = await store.createInvitation({
      tenantId: tenantTwo.tenantId, userId: userTwo, email: invitationEmail, role: 'operator',
    });
    const accepted = await store.acceptInvitation({ token: invitation.token, userId: userOne, email: invitationEmail });
    assert.equal(accepted.tenantId, tenantTwo.tenantId);

    const oneWorkspaces = await store.listMyWorkspaces({ userId: userOne });
    const twoWorkspaces = await store.listMyWorkspaces({ userId: userTwo });
    assert.deepEqual(oneWorkspaces.map(row => row.id).sort(), [tenantOne.tenantId, tenantTwo.tenantId].sort());
    assert.deepEqual(twoWorkspaces.map(row => row.id), [tenantTwo.tenantId]);
    assert.equal(oneWorkspaces.find(row => row.id === tenantTwo.tenantId).role, 'operator');

    await store.revokeMembership({ tenantId: tenantTwo.tenantId, userId: userTwo, targetUserId: userOne });
    assert.deepEqual((await store.listMyWorkspaces({ userId: userOne })).map(row => row.id), [tenantOne.tenantId]);

    async function invokeProof(proof) {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE astra_app');
        const result = await client.query(
          'SELECT id, name, role, status FROM astra.list_my_workspaces($1::text, $2::bigint, $3::uuid, $4::text)',
          [userOne, proof.expiresAt, proof.nonce, proof.proof],
        );
        await client.query('COMMIT');
        return result.rows;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    const databaseClock = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms');
    const databaseNow = Number(databaseClock.rows[0].now_ms);
    assert.ok(Number.isSafeInteger(databaseNow));
    const replayable = createAstraContextProof({ userId: userOne, action: 'discover_workspaces', secret: fixtureSecret, now: databaseNow });
    await invokeProof(replayable);
    await assert.rejects(invokeProof(replayable), error => error.code === '42501');
    const expired = createAstraContextProof({ userId: userOne, action: 'discover_workspaces', secret: fixtureSecret, now: databaseNow - 60000 });
    await assert.rejects(invokeProof(expired), error => error.code === '42501');
    await assert.rejects(invokeProof({ ...createAstraContextProof({ userId: userOne, action: 'discover_workspaces', secret: fixtureSecret, now: databaseNow }), proof: '0'.repeat(64) }),
      error => error.code === '42501');

    for (const statement of ['SELECT id FROM astra.tenants LIMIT 1', 'SELECT tenant_id FROM astra.memberships LIMIT 1']) {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE astra_app');
        const directRead = await client.query(statement);
        assert.deepEqual(directRead.rows, [], 'RLS denies unscoped app-role reads without a signed tenant context');
      } finally {
        await client.query('ROLLBACK');
      }
    }
    const badNonce = createAstraContextProof({ userId: userOne, action: 'discover_workspaces', secret: fixtureSecret });
    await assert.rejects(invokeProof({ ...badNonce, nonce: randomUUID(), proof: 'malformed' }), error => error.code === '42501');
  } finally {
    client.release();
    await store.close();
    await pool.end();
  }
});
