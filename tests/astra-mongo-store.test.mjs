import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { createAstraMongoStore } from '../pipeline/astra-mongo-store.js';
import { createAstraPersistence } from '../pipeline/astra-persistence.js';

const TENANT = '4fe0fbc8-4bfd-4df9-8826-27af6fbe5d8a';
const JOB = 'd8dd1ec0-5a8e-4e79-b5bd-40240fc187e5';
const EVIDENCE = 'b17d258b-cd7d-49e3-897a-40a56c8f97bb';

// Local in-memory Mongo API double. These tests are unit/mock evidence only;
// no network connection or real Atlas deployment is involved.
function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((part) => matches(doc, part));
    const actual = doc[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === '$in') return value.includes(actual);
        if (operator === '$gt') return actual > value;
        if (operator === '$lte') return actual <= value;
        if (operator === '$ne') return actual !== value;
        return false;
      });
    }
    return actual === expected;
  });
}

class MemoryCollection {
  static delayNextFindOneMs = 0;
  constructor() { this.docs = []; }
  async createIndex() { return 'mock-index'; }
  async findOne(filter, options = {}) {
    const delayMs = MemoryCollection.delayNextFindOneMs;
    MemoryCollection.delayNextFindOneMs = 0;
    if (delayMs) await new Promise((resolve, reject) => {
      const timer = setTimeout(finish, delayMs);
      function finish() {
        options.signal?.removeEventListener('abort', abort);
        resolve();
      }
      function abort() {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        const error = new Error('mock operation aborted');
        error.name = 'AbortError';
        reject(error);
      }
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
    return this.docs.find((item) => matches(item, filter)) ?? null;
  }
  async insertOne(doc) {
    this.docs.push(structuredClone(doc));
    return { insertedId: doc.id };
  }
  async updateOne(filter, update) {
    const doc = this.docs.find((item) => matches(item, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    for (const [key, value] of Object.entries(update.$set ?? {})) doc[key] = structuredClone(value);
    for (const [key, value] of Object.entries(update.$inc ?? {})) doc[key] = (doc[key] ?? 0) + value;
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async findOneAndUpdate(filter, update, options = {}) {
    const docs = this.docs.filter((item) => matches(item, filter));
    const sort = options.sort ?? {};
    docs.sort((left, right) => {
      for (const [key, direction] of Object.entries(sort)) {
        if (left[key] < right[key]) return -direction;
        if (left[key] > right[key]) return direction;
      }
      return 0;
    });
    const doc = docs[0];
    if (!doc) return null;
    for (const [key, value] of Object.entries(update.$set ?? {})) doc[key] = structuredClone(value);
    for (const [key, value] of Object.entries(update.$inc ?? {})) doc[key] = (doc[key] ?? 0) + value;
    return structuredClone(doc);
  }
  find(filter) {
    const query = { sortBy: {}, max: Infinity };
    query.sort = (spec) => { query.sortBy = spec; return query; };
    query.limit = (max) => { query.max = max; return query; };
    query.toArray = async () => {
      const docs = this.docs.filter((item) => matches(item, filter));
      docs.sort((left, right) => {
        for (const [key, direction] of Object.entries(query.sortBy)) {
          if (left[key] < right[key]) return -direction;
          if (left[key] > right[key]) return direction;
        }
        return 0;
      });
      return structuredClone(docs.slice(0, query.max));
    };
    return query;
  }
  async countDocuments(filter) { return this.docs.filter((item) => matches(item, filter)).length; }
}

class MemoryDatabase {
  constructor() { this.collections = new Map(); this.hello = { ok: 1, setName: 'mock-replica-set' }; }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name);
  }
  async command(command) { return command.ping ? { ok: 1 } : this.hello; }
  admin() { return { command: async () => this.hello }; }
}

class MemoryMongoClient {
  static instances = [];
  constructor(uri, options) {
    this.uri = uri;
    this.options = options;
    this.database = new MemoryDatabase();
    this.connected = false;
    MemoryMongoClient.instances.push(this);
  }
  async connect() { this.connected = true; }
  db(name) { this.databaseName = name; return this.database; }
  startSession() {
    return {
      startTransaction() { this.active = true; },
      inTransaction() { return this.active; },
      async commitTransaction() { this.active = false; },
      async abortTransaction() { this.active = false; },
      async endSession() {},
    };
  }
  async close() { this.connected = false; }
}

class RollbackMemoryMongoClient extends MemoryMongoClient {
  startSession() {
    const session = super.startSession();
    let snapshot;
    session.startTransaction = () => {
      snapshot = new Map([...this.database.collections].map(([name, collection]) => [name, structuredClone(collection.docs)]));
      session.active = true;
    };
    session.abortTransaction = async () => {
      for (const [name, collection] of this.database.collections) {
        collection.docs = snapshot?.has(name) ? structuredClone(snapshot.get(name)) : [];
      }
      session.active = false;
    };
    return session;
  }
}

function rejectDuplicateInsert(collection, predicate) {
  const insertOne = collection.insertOne.bind(collection);
  collection.insertOne = async (document, ...args) => {
    if (predicate(document)) {
      const error = new Error('E11000 duplicate key error index private-test-index');
      error.code = 11000;
      throw error;
    }
    return insertOne(document, ...args);
  };
}

function mongoOptions(overrides = {}) {
  return {
    uri: 'mongodb+srv://redacted.invalid/example',
    databaseName: 'astra_test_prospecting_unit',
    integrationMode: 'prospecting-test',
    allowedTestDatabases: ['astra_test_prospecting_unit'],
    MongoClientClass: MemoryMongoClient,
    ...overrides,
  };
}

test('Mongo integration mode requires separate URI, database and explicit test allowlist', async () => {
  assert.throws(() => createAstraPersistence({ env: { ASTRA_PERSISTENCE_BACKEND: 'mongodb' } }), { code: 'persistence_configuration_invalid' });
  assert.throws(() => createAstraMongoStore(mongoOptions({ integrationMode: 'production' })), { code: 'persistence_configuration_invalid' });
  assert.throws(() => createAstraMongoStore(mongoOptions({ allowedTestDatabases: [] })), { code: 'persistence_configuration_invalid' });
  assert.throws(() => createAstraMongoStore(mongoOptions({ databaseName: 'astra_test_prospecting_unit?tls=false' })), { code: 'persistence_configuration_invalid' });
  assert.throws(() => createAstraMongoStore(mongoOptions({ databaseName: 'admin', allowedTestDatabases: ['admin'] })), { code: 'persistence_configuration_invalid' });
  assert.throws(() => createAstraMongoStore(mongoOptions({ clientOptions: { tlsInsecure: true } })), { code: 'persistence_configuration_invalid' });
  assert.throws(() => createAstraMongoStore(mongoOptions({ clientOptions: { TLSINSECURE: 'true' } })), { code: 'persistence_configuration_invalid' });
  for (const query of [
    'tlsInsecure=true', 'TLSInSeCuRe=true', '%74lsInsecure=true',
    'tlsAllowInvalidCertificates=true', 'tlsAllowInvalidHostnames=true', 'ssl=false', 'tls=false',
  ]) {
    assert.throws(() => createAstraMongoStore(mongoOptions({ uri: `mongodb://127.0.0.1/test?${query}` })), { code: 'persistence_configuration_invalid' }, query);
  }
  assert.throws(() => createAstraMongoStore(mongoOptions({ clientOptions: { tlsAllowInvalidCertificates: true } })), { code: 'persistence_configuration_invalid' });
  assert.throws(() => createAstraMongoStore(mongoOptions({ clientOptions: { tlsAllowInvalidHostnames: true } })), { code: 'persistence_configuration_invalid' });
  assert.throws(() => createAstraMongoStore(mongoOptions({ clientOptions: { rejectUnauthorized: false } })), { code: 'persistence_configuration_invalid' });
  // Driver constructor parses case-insensitive and percent-encoded URI keys before any network I/O.
  for (const query of ['tlsInsecure=true', 'TLSINSECURE=true', '%74lsInsecure=true']) {
    const parsed = new MongoClient(`mongodb://127.0.0.1/test?${query}`, { tls: true });
    try { assert.equal(parsed.options.tlsInsecure, true); }
    finally { await parsed.close(); }
  }
  const insecureCertificates = new MongoClient('mongodb://127.0.0.1/test?tlsAllowInvalidCertificates=true', { tls: true });
  try { assert.equal(insecureCertificates.options.rejectUnauthorized, false); }
  finally { await insecureCertificates.close(); }
  const insecureHostname = new MongoClient('mongodb://127.0.0.1/test?tlsAllowInvalidHostnames=true', { tls: true });
  try { assert.equal(typeof insecureHostname.options.checkServerIdentity, 'function'); }
  finally { await insecureHostname.close(); }
  assert.equal(MemoryMongoClient.instances.length, 0, 'validation must finish before constructing any client');
  const multiHost = createAstraMongoStore(mongoOptions({ uri: 'mongodb://mongo-a:27017,mongo-b:27017/test?tls=true' }));
  assert.equal(multiHost.backend, 'mongodb', 'multi-host URI parsing must not depend on WHATWG URL host parsing');
  await multiHost.close();
});

test('default persistence remains the existing PostgreSQL query boundary', async () => {
  const client = { query: async () => ({ rows: [] }), marker: 'existing-postgres-client' };
  const adapter = createAstraPersistence({ env: {}, postgresClient: client });
  assert.equal(adapter.backend, 'postgres');
  assert.deepEqual(await adapter.query('SELECT 1'), { rows: [] });
  assert.equal(adapter.client, client);
  assert.throws(() => createAstraPersistence({ env: { ASTRA_PERSISTENCE_BACKEND: 'mongodb' }, postgresClient: client }), { code: 'persistence_configuration_invalid' });
});

test('mock replica-set backend reports truthful health and exposes tenant-scoped worker repositories', async () => {
  const store = createAstraMongoStore(mongoOptions());
  const initial = await store.health();
  assert.deepEqual(initial, { ok: false, backend: 'mongodb', transactionsSupported: null, ready: false });
  const connected = await store.connect();
  assert.deepEqual(connected, { ok: true, backend: 'mongodb', database: 'astra_test_prospecting_unit', transactionsSupported: true, ready: true });
  assert.equal(MemoryMongoClient.instances.at(-1).options.tls, true);
  assert.equal(MemoryMongoClient.instances.at(-1).options.tlsInsecure, undefined);
  assert.equal((await store.health()).ready, true);
  assert.throws(() => store.forTenant({ tenantId: { $ne: TENANT } }), { code: 'invalid_uuid' });

  const repo = store.forTenant({ tenantId: TENANT });
  const created = await repo.jobs.create({ id: JOB, idempotencyKey: 'create-1', payload: { query: 'synthetic account lookup', options: { limit: 5, source: 'public' } } });
  assert.equal(created.job.state, 'queued');
  assert.equal(created.job.tenantId, TENANT);
  assert.equal((await repo.jobs.create({ idempotencyKey: 'create-1', payload: { options: { source: 'public', limit: 5 }, query: 'synthetic account lookup' } })).replayed, true);
  await assert.rejects(repo.jobs.create({ idempotencyKey: 'create-1', payload: { query: 'changed' } }), { code: 'idempotency_conflict' });
  await assert.rejects(repo.jobs.create({ idempotencyKey: 'operator', payload: { filter: { $where: 'true' } } }), { code: 'invalid_document' });

  const claimed = await repo.jobs.claim({ workerId: 'worker-a', leaseMs: 10_000 });
  assert.equal(claimed.job.id, JOB);
  assert.equal(claimed.lease.fence, 1);
  assert.equal(await repo.jobs.claim({ workerId: 'worker-b' }), null);
  const checkpoint = await repo.jobs.checkpoint(JOB, {
    workerId: 'worker-a', fence: 1, expectedVersion: claimed.job.version,
    idempotencyKey: 'cp-1', checkpoint: { page: 2, cursor: 'opaque-safe-token' },
  });
  assert.equal(checkpoint.replayed, false);
  assert.equal((await repo.jobs.checkpoint(JOB, {
    workerId: 'worker-a', fence: 1, expectedVersion: claimed.job.version,
    idempotencyKey: 'cp-1', checkpoint: { page: 2, cursor: 'opaque-safe-token' },
  })).replayed, true);
  await assert.rejects(repo.jobs.checkpoint(JOB, {
    workerId: 'worker-a', fence: 1, expectedVersion: claimed.job.version,
    idempotencyKey: 'cp-2', checkpoint: { page: 3 },
  }), { code: 'lease_lost' });

  const evidence = await repo.evidence.record({ jobId: JOB, idempotencyKey: 'ev-1', sourceKey: 'public-source:alpha', evidence: { url: 'https://public.example/evidence', excerpt: 'synthetic proof' } });
  assert.equal(evidence.replayed, false);
  assert.equal((await repo.evidence.record({ jobId: JOB, idempotencyKey: 'ev-1', sourceKey: 'public-source:alpha', evidence: { url: 'https://public.example/evidence', excerpt: 'synthetic proof' } })).replayed, true);
  const qualified = await repo.contacts.qualify({
    jobId: JOB, idempotencyKey: 'contact-1', identityKey: 'person:synthetic-1',
    contact: { name: 'Synthetic Prospect', email: 'person@example.invalid' },
    qualification: { status: 'qualified', reason: 'synthetic test evidence met threshold' }, evidenceIds: [evidence.evidence.id],
  });
  assert.equal(qualified.contact.tenantId, TENANT);
  await assert.rejects(repo.contacts.qualify({
    jobId: JOB, idempotencyKey: 'contact-2', identityKey: 'person:synthetic-1',
    contact: { name: 'Different Person' }, qualification: { status: 'qualified' }, evidenceIds: [evidence.evidence.id],
  }), { code: 'identity_conflict' });
  await assert.rejects(repo.contacts.qualify({
    jobId: JOB, idempotencyKey: 'unqualified', identityKey: 'person:synthetic-2',
    contact: { name: 'Not Qualified' }, qualification: { status: 'unknown' }, evidenceIds: [evidence.evidence.id],
  }), { code: 'invalid_document' });

  await assert.rejects(repo.jobs.transition(JOB, {
    action: 'complete', expectedVersion: checkpoint.job.version, idempotencyKey: 'complete-1', workerId: 'worker-a', fence: 9,
  }), { code: 'lease_lost' });
  const outcome = await repo.outcomes.append({ jobId: JOB, idempotencyKey: 'outcome-1', outcome: { disposition: 'needs_review', reason: 'synthetic fixture' } });
  assert.equal(outcome.replayed, false);
  assert.equal((await repo.outcomes.append({ jobId: JOB, idempotencyKey: 'outcome-1', outcome: { disposition: 'needs_review', reason: 'synthetic fixture' } })).replayed, true);

  const transitioned = await repo.jobs.transition(JOB, { action: 'pause', expectedVersion: checkpoint.job.version, idempotencyKey: 'pause-1', reason: 'operator requested' });
  assert.equal(transitioned.job.state, 'paused');
  assert.equal((await repo.jobs.events(JOB)).some((event) => event.type === 'job.checkpointed'), true);
  const otherTenant = store.forTenant({ tenantId: '7fea4394-c54e-4b42-81cf-d7b5022caace' });
  assert.equal(await otherTenant.jobs.get(JOB), null);
  assert.equal((await otherTenant.contacts.list()).length, 0);
  await store.close();
});

test('duplicate-key job creation preserves the public conflict and aborts partial writes', async () => {
  const store = createAstraMongoStore(mongoOptions({ MongoClientClass: RollbackMemoryMongoClient }));
  await store.connect();
  const client = RollbackMemoryMongoClient.instances.at(-1);
  const events = client.database.collection('prospecting_events');
  rejectDuplicateInsert(events, (document) => document.type === 'job.created');

  await assert.rejects(store.forTenant({ tenantId: TENANT }).jobs.create({ idempotencyKey: 'duplicate-create', payload: { query: 'synthetic' } }), (error) => {
    assert.equal(error.code, 'unique_conflict');
    assert.equal(error.status, 409);
    assert.equal(error.message, 'A unique tenant record already exists; retry the same idempotency key to read its result.');
    assert.equal(error.message.includes('E11000'), false);
    assert.equal(error.message.includes('private-test-index'), false);
    return true;
  });
  assert.equal(client.database.collection('prospecting_jobs').docs.length, 0);
  assert.equal(events.docs.length, 0);
  await store.close();
});

test('duplicate-key evidence write preserves the public conflict and aborts partial writes', async () => {
  const store = createAstraMongoStore(mongoOptions({ MongoClientClass: RollbackMemoryMongoClient }));
  await store.connect();
  const client = RollbackMemoryMongoClient.instances.at(-1);
  const tenant = store.forTenant({ tenantId: TENANT });
  await tenant.jobs.create({ id: JOB, idempotencyKey: 'evidence-parent-job', payload: {} });
  const idempotency = client.database.collection('prospecting_idempotency_receipts');
  rejectDuplicateInsert(idempotency, (document) => document.namespace === 'evidence');

  await assert.rejects(tenant.evidence.record({ jobId: JOB, idempotencyKey: 'duplicate-evidence', sourceKey: 'synthetic-source', evidence: { quote: 'synthetic evidence' } }), (error) => {
    assert.equal(error.code, 'unique_conflict');
    assert.equal(error.status, 409);
    assert.equal(error.message, 'A unique tenant record already exists; retry the same idempotency key to read its result.');
    assert.equal(error.message.includes('E11000'), false);
    assert.equal(error.message.includes('private-test-index'), false);
    return true;
  });
  assert.equal(client.database.collection('prospecting_source_evidence').docs.length, 0);
  assert.equal(idempotency.docs.some((document) => document.namespace === 'evidence'), false);
  assert.equal(client.database.collection('prospecting_jobs').docs.length, 1, 'the preexisting parent job survives rollback');
  await store.close();
});

test('standalone Mongo servers report transactions unsupported and never become ready', async () => {
  class StandaloneClient extends MemoryMongoClient {
    constructor(uri, options) { super(uri, options); this.database.hello = { ok: 1 }; }
  }
  const store = createAstraMongoStore(mongoOptions({ MongoClientClass: StandaloneClient }));
  const status = await store.connect();
  assert.deepEqual(status, { ok: true, backend: 'mongodb', database: 'astra_test_prospecting_unit', transactionsSupported: false, ready: false });
  await assert.rejects(store.forTenant({ tenantId: TENANT }).jobs.create({ idempotencyKey: 'x', payload: {} }), { code: 'transaction_unsupported' });
  await store.close();
});

test('connection failures are sanitized before reaching callers', async () => {
  class FailingConnectClient extends MemoryMongoClient {
    async connect() { throw new Error('mongodb+srv://user:secret@private-host.example/secret-db'); }
  }
  const store = createAstraMongoStore(mongoOptions({ MongoClientClass: FailingConnectClient }));
  await assert.rejects(store.connect(), (error) => {
    assert.equal(error.code, 'mongodb_connect_failed');
    assert.equal(error.message.includes('private-host'), false);
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
});

test('identity deduplication binds every accepted evidence idempotency key to its request fingerprint', async () => {
  const store = createAstraMongoStore(mongoOptions());
  await store.connect();
  const tenant = store.forTenant({ tenantId: TENANT });
  await tenant.jobs.create({ id: JOB, idempotencyKey: 'identity-evidence-job', payload: {} });
  const input = { jobId: JOB, sourceKey: 'source-a', evidence: { quote: 'same source bytes' } };
  const first = await tenant.evidence.record({ ...input, idempotencyKey: 'evidence-key-1' });
  const identityReplay = await tenant.evidence.record({ ...input, idempotencyKey: 'evidence-key-2' });
  assert.equal(identityReplay.replayed, true);
  assert.equal(identityReplay.evidence.id, first.evidence.id);
  assert.equal((await tenant.evidence.record({ ...input, idempotencyKey: 'evidence-key-2' })).evidence.id, first.evidence.id);
  await assert.rejects(tenant.evidence.record({
    jobId: JOB, idempotencyKey: 'evidence-key-2', sourceKey: 'source-b', evidence: { quote: 'different bytes' },
  }), { code: 'idempotency_conflict' });
  await store.close();
});

test('contact identity deduplication reserves a new idempotency key for the canonical request', async () => {
  const store = createAstraMongoStore(mongoOptions());
  await store.connect();
  const tenant = store.forTenant({ tenantId: TENANT });
  await tenant.jobs.create({ id: JOB, idempotencyKey: 'identity-contact-job', payload: {} });
  const evidence = await tenant.evidence.record({ jobId: JOB, idempotencyKey: 'contact-evidence', sourceKey: 'source', evidence: { quote: 'proof' } });
  const base = {
    jobId: JOB, identityKey: 'person:one', contact: { name: 'One' },
    qualification: { status: 'qualified' }, evidenceIds: [evidence.evidence.id],
  };
  const first = await tenant.contacts.qualify({ ...base, idempotencyKey: 'contact-key-1' });
  const identityReplay = await tenant.contacts.qualify({ ...base, idempotencyKey: 'contact-key-2' });
  assert.equal(identityReplay.replayed, true);
  assert.equal(identityReplay.contact.id, first.contact.id);
  assert.equal((await tenant.contacts.qualify({ ...base, idempotencyKey: 'contact-key-2' })).contact.id, first.contact.id);
  await assert.rejects(tenant.contacts.qualify({
    ...base, idempotencyKey: 'contact-key-2', identityKey: 'person:two', contact: { name: 'Two' },
  }), { code: 'idempotency_conflict' });
  await store.close();
});

test('transaction deadline aborts delayed work before it can issue later writes', async () => {
  const store = createAstraMongoStore(mongoOptions({ transactionTimeoutMs: 100 }));
  await store.connect();
  const tenant = store.forTenant({ tenantId: TENANT });
  const start = Date.now();
  MemoryCollection.delayNextFindOneMs = 220;
  try {
    await assert.rejects(tenant.jobs.create({ idempotencyKey: 'slow-operation', payload: {} }), { code: 'transaction_timeout' });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 180, `deadline should bound the awaited work, elapsed=${elapsed}ms`);
    await new Promise((resolve) => setTimeout(resolve, 240));
    assert.equal((await tenant.jobs.list()).length, 0, 'the timed-out callback must not write after abort');
  } finally {
    MemoryCollection.delayNextFindOneMs = 0;
    await store.close();
  }
});

test('commit receives the precommit remaining budget and a timed-out commit is uncertain', async () => {
  class TimeoutAwareCommitClient extends MemoryMongoClient {
    static lastCommitOptions;
    startSession() {
      const session = super.startSession();
      session.commitTransaction = async (options) => {
        TimeoutAwareCommitClient.lastCommitOptions = options;
        await new Promise((resolve) => setTimeout(resolve, options.timeoutMS));
        session.active = false;
        const error = new Error('mock commit operation deadline');
        error.name = 'MongoOperationTimeoutError';
        error.hasErrorLabel = (label) => label === 'UnknownTransactionCommitResult';
        throw error;
      };
      return session;
    }
  }
  const store = createAstraMongoStore(mongoOptions({ MongoClientClass: TimeoutAwareCommitClient, transactionTimeoutMs: 100 }));
  await store.connect();
  const tenant = store.forTenant({ tenantId: TENANT });
  const started = Date.now();
  try {
    await assert.rejects(tenant.jobs.create({ idempotencyKey: 'commit-budget', payload: {} }), (error) => {
      assert.equal(error.code, 'uncertain_commit');
      assert.equal(error.commitState, 'unknown');
      assert.equal(error.reconciliationRequired, true);
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(TimeoutAwareCommitClient.lastCommitOptions.timeoutMS > 0);
    assert.ok(TimeoutAwareCommitClient.lastCommitOptions.timeoutMS <= 100);
    assert.ok(TimeoutAwareCommitClient.lastCommitOptions.timeoutMS >= 70, 'fast transaction work should leave most of the budget for commit');
    assert.ok(elapsed < 180, `commit timeout must bound the call, elapsed=${elapsed}ms`);
  } finally { await store.close(); }
});

test('late successful commit cannot be returned as an ordinary transaction success', async () => {
  class LateSuccessCommitClient extends MemoryMongoClient {
    static lastCommitOptions;
    startSession() {
      const session = super.startSession();
      session.commitTransaction = async (options) => {
        LateSuccessCommitClient.lastCommitOptions = options;
        await new Promise((resolve) => setTimeout(resolve, 220));
        session.active = false;
        session.committed = true;
      };
      return session;
    }
  }
  const store = createAstraMongoStore(mongoOptions({ MongoClientClass: LateSuccessCommitClient, transactionTimeoutMs: 100 }));
  await store.connect();
  const tenant = store.forTenant({ tenantId: TENANT });
  try {
    await assert.rejects(tenant.jobs.create({ idempotencyKey: 'commit-late-success', payload: {} }), (error) => {
      assert.equal(error.code, 'transaction_commit_late');
      assert.equal(error.commitState, 'committed');
      assert.equal(error.reconciliationRequired, true);
      return true;
    });
    assert.ok(LateSuccessCommitClient.lastCommitOptions.timeoutMS > 0);
    assert.ok(LateSuccessCommitClient.lastCommitOptions.timeoutMS <= 100);
  } finally { await store.close(); }
});

test('late unknown commit acknowledgement remains uncertain rather than becoming a plain timeout', async () => {
  class LateUnknownCommitClient extends MemoryMongoClient {
    static lastCommitOptions;
    static serverMayHaveCommitted = false;
    startSession() {
      const session = super.startSession();
      session.commitTransaction = async (options) => {
        LateUnknownCommitClient.lastCommitOptions = options;
        await new Promise((resolve) => setTimeout(resolve, 220));
        LateUnknownCommitClient.serverMayHaveCommitted = true;
        session.active = false;
        const error = new Error('mock commit acknowledgement unavailable');
        error.hasErrorLabel = (label) => label === 'UnknownTransactionCommitResult';
        throw error;
      };
      return session;
    }
  }
  const store = createAstraMongoStore(mongoOptions({ MongoClientClass: LateUnknownCommitClient, transactionTimeoutMs: 100 }));
  await store.connect();
  const tenant = store.forTenant({ tenantId: TENANT });
  try {
    await assert.rejects(tenant.jobs.create({ idempotencyKey: 'commit-late-unknown', payload: {} }), (error) => {
      assert.equal(error.code, 'uncertain_commit');
      assert.equal(error.commitState, 'unknown');
      assert.equal(error.reconciliationRequired, true);
      assert.equal(error.message.includes('commit acknowledgement unavailable'), false);
      return true;
    });
    assert.equal(LateUnknownCommitClient.serverMayHaveCommitted, true);
    assert.ok(LateUnknownCommitClient.lastCommitOptions.timeoutMS > 0);
    assert.ok(LateUnknownCommitClient.lastCommitOptions.timeoutMS <= 100);
  } finally { await store.close(); }
});

