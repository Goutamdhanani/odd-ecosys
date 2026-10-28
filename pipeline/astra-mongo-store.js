import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient } from 'mongodb';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_STATES = new Set(['queued', 'running', 'paused', 'cancelled', 'completed', 'failed']);
const TERMINAL = new Set(['cancelled', 'completed', 'failed']);
const PROSPECTING_MODE = 'prospecting-test';

function storeError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw storeError(`${label} must be a UUID.`, 'invalid_uuid');
  }
  return value.toLowerCase();
}

function safeJson(value, path = 'value', depth = 0, ancestors = new Set()) {
  if (depth > 24) throw storeError(`${path} is too deeply nested.`, 'invalid_document');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw storeError(`${path} must contain finite numbers.`, 'invalid_document');
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw storeError(`${path} cannot be circular.`, 'invalid_document');
    ancestors.add(value);
    const result = value.map((item, index) => safeJson(item, `${path}[${index}]`, depth + 1, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw storeError(`${path} must contain plain JSON values.`, 'invalid_document');
  }
  if (ancestors.has(value)) throw storeError(`${path} cannot be circular.`, 'invalid_document');
  ancestors.add(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || key.startsWith('$') || key.includes('.')) {
      throw storeError(`${path} contains a reserved field name.`, 'invalid_document');
    }
    result[key] = safeJson(item, `${path}.${key}`, depth + 1, ancestors);
  }
  ancestors.delete(value);
  return result;
}

function idempotencyKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || value.trim() !== value) {
    throw storeError('idempotencyKey must be a non-empty string of at most 200 characters.', 'invalid_idempotency_key');
  }
  return value;
}

function assertStrictTlsConfiguration(uri, options) {
  const relaxedBooleanOptions = new Set([
    'tlsinsecure', 'tlsallowinvalidcertificates', 'tlsallowinvalidhostnames',
  ]);
  const disabledTlsOptions = new Set(['tls', 'ssl']);
  const enabled = (value) => String(value).toLowerCase() === 'true';
  const queryIndex = uri.indexOf('?');
  const query = queryIndex < 0 ? '' : uri.slice(queryIndex + 1).split('#', 1)[0];
  const searchParams = new URLSearchParams(query);
  for (const [key, value] of searchParams.entries()) {
    const normalizedKey = key.toLowerCase();
    if (relaxedBooleanOptions.has(normalizedKey) && enabled(value)) {
      throw storeError('MongoDB TLS certificate and hostname verification must remain enabled.', 'persistence_configuration_invalid', 500);
    }
    if (disabledTlsOptions.has(normalizedKey) && !enabled(value)) {
      throw storeError('MongoDB TLS must remain enabled.', 'persistence_configuration_invalid', 500);
    }
  }
  for (const [key, value] of Object.entries(options)) {
    const normalizedKey = key.toLowerCase();
    if (relaxedBooleanOptions.has(normalizedKey) && enabled(value)) {
      throw storeError('MongoDB TLS certificate and hostname verification must remain enabled.', 'persistence_configuration_invalid', 500);
    }
    if (disabledTlsOptions.has(normalizedKey) && !enabled(value)) {
      throw storeError('MongoDB TLS must remain enabled.', 'persistence_configuration_invalid', 500);
    }
  }
  if (options.rejectUnauthorized === false || typeof options.checkServerIdentity === 'function') {
    throw storeError('MongoDB TLS certificate and hostname verification must remain enabled.', 'persistence_configuration_invalid', 500);
  }
}

function stableHash(value) {
  const canonical = (item) => Array.isArray(item)
    ? item.map(canonical)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]))
      : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function publicError(error) {
  if (error?.code === 11000) return storeError('A unique tenant record already exists; retry the same idempotency key to read its result.', 'unique_conflict', 409);
  if (error?.code && ['invalid_uuid', 'invalid_document', 'invalid_idempotency_key', 'idempotency_conflict', 'unique_conflict', 'version_conflict', 'lease_lost', 'invalid_transition', 'job_not_found', 'evidence_required', 'identity_conflict', 'idempotency_record_missing', 'transaction_unsupported', 'mongodb_not_connected', 'transaction_timeout', 'uncertain_commit', 'transaction_commit_late'].includes(error.code)) {
    return error;
  }
  // Driver errors, server names, connection strings and command details stay private.
  return storeError('MongoDB operation failed; see protected server diagnostics.', 'mongodb_operation_failed', 503);
}

function transactionOperationOptions(transaction, extra = {}) {
  const remainingMs = transaction.deadline - Date.now();
  if (transaction.signal.aborted || remainingMs <= 0) throw storeError('Transaction deadline exceeded.', 'transaction_timeout', 503);
  return { ...extra, session: transaction.session, signal: transaction.signal, timeoutMS: Math.max(1, remainingMs) };
}

async function commitWithDeadline(session, deadline, sleepMs, onAttempt = () => {}) {
  let commitAttempted = false;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      if (commitAttempted) throw uncertainCommitError();
      throw storeError('Transaction deadline exceeded before commit began.', 'transaction_timeout', 503);
    }
    commitAttempted = true;
    onAttempt();
    try {
      await session.commitTransaction({ timeoutMS: remainingMs });
    } catch (error) {
      const unknown = Boolean(error?.hasErrorLabel?.('UnknownTransactionCommitResult'));
      const driverTimedOut = error?.name === 'MongoOperationTimeoutError';
      if (unknown || driverTimedOut || Date.now() >= deadline) {
        if (Date.now() >= deadline || driverTimedOut) throw uncertainCommitError();
        await delay(Math.min(sleepMs, Math.max(0, deadline - Date.now())));
        continue;
      }
      throw error;
    }
    if (Date.now() >= deadline) throw lateCommitError();
    return;
  }
}

function uncertainCommitError() {
  const error = storeError('MongoDB commit was attempted but its outcome was not confirmed before the deadline; recovery is required.', 'uncertain_commit', 503);
  error.commitState = 'unknown';
  error.reconciliationRequired = true;
  return error;
}

function lateCommitError() {
  const error = storeError('MongoDB confirmed the commit after its configured deadline; recovery must read using the same idempotency key.', 'transaction_commit_late', 503);
  error.commitState = 'committed';
  error.reconciliationRequired = true;
  return error;
}

export function createAstraMongoStore({
  uri = process.env.MONGODB_URI,
  databaseName = process.env.MONGODB_DATABASE,
  integrationMode = process.env.ASTRA_INTEGRATION_MODE,
  allowedTestDatabases = String(process.env.ASTRA_MONGODB_TEST_DATABASES ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  MongoClientClass = MongoClient,
  transactionTimeoutMs = 8000,
  transactionRetryDelayMs = 40,
  leaseDurationMs = 30_000,
  clientOptions = {},
} = {}) {
  if (integrationMode !== PROSPECTING_MODE) throw storeError('MongoDB store is restricted to prospecting-test mode.', 'persistence_configuration_invalid', 500);
  if (typeof uri !== 'string' || !uri.trim() || typeof databaseName !== 'string' || !databaseName.trim()) {
    throw storeError('MongoDB requires MONGODB_URI and a separate MONGODB_DATABASE.', 'persistence_configuration_invalid', 500);
  }
  if (!/^astra_test_(?!(?:admin|prod(?:uction)?|customer|live)(?:_|$))[a-z0-9_-]{1,48}$/i.test(databaseName)) throw storeError('MongoDB requires an explicitly named astra_test_* database.', 'persistence_configuration_invalid', 500);
  if (!allowedTestDatabases.includes(databaseName)) throw storeError('MongoDB database is not allowlisted for integration tests.', 'persistence_configuration_invalid', 500);
  assertStrictTlsConfiguration(uri, clientOptions);
  if (!Number.isInteger(transactionTimeoutMs) || transactionTimeoutMs < 100 || transactionTimeoutMs > 60_000) {
    throw storeError('Transaction timeout must be between 100 and 60000 ms.', 'persistence_configuration_invalid', 500);
  }

  // TLS stays enabled. Caller may set connect/server-selection timeouts, never tlsInsecure.
  let client;
  try {
    client = new MongoClientClass(uri, {
      ...clientOptions,
      tls: true,
      rejectUnauthorized: true,
      checkServerIdentity: undefined,
      retryWrites: true,
      appName: clientOptions.appName ?? 'astra-prospecting-integration',
      serverSelectionTimeoutMS: clientOptions.serverSelectionTimeoutMS ?? 5000,
    });
  } catch {
    throw storeError('MongoDB client configuration failed; see protected server diagnostics.', 'mongodb_configuration_failed', 500);
  }
  if (client.options && (client.options.tls !== true || client.options.tlsInsecure === true || client.options.rejectUnauthorized === false || typeof client.options.checkServerIdentity === 'function')) {
    throw storeError('MongoDB driver resolved insecure TLS options; connection is blocked.', 'persistence_configuration_invalid', 500);
  }
  const database = client.db(databaseName);
  const collections = {
    jobs: database.collection('prospecting_jobs'),
    events: database.collection('prospecting_events'),
    outcomes: database.collection('prospecting_outcomes'),
    evidence: database.collection('prospecting_source_evidence'),
    contacts: database.collection('prospecting_qualified_contacts'),
    idempotency: database.collection('prospecting_idempotency_receipts'),
  };
  let connected = false;
  let transactionSupport = null;
  let indexesReady = false;

  async function requireTransactions() {
    if (!connected) throw storeError('MongoDB store is not connected.', 'mongodb_not_connected', 503);
    if (transactionSupport === false) throw storeError('MongoDB deployment does not support transactions.', 'transaction_unsupported', 503);
  }

  async function withTransaction(work) {
    await requireTransactions();
    const deadline = Date.now() + transactionTimeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      const session = client.startSession();
      const controller = new AbortController();
      const transaction = { session, deadline, signal: controller.signal };
      let deadlineExpired = false;
      let commitAttempted = false;
      let deadlineTimer;
      try {
        session.startTransaction({
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority', j: true },
          readPreference: 'primary',
          maxCommitTimeMS: Math.min(2000, transactionTimeoutMs),
        });
        deadlineTimer = setTimeout(() => {
          deadlineExpired = true;
          controller.abort();
        }, Math.max(1, deadline - Date.now()));
        const result = await work(transaction);
        clearTimeout(deadlineTimer);
        if (Date.now() >= deadline) throw storeError('Transaction deadline exceeded.', 'transaction_timeout', 503);
        await commitWithDeadline(session, deadline, transactionRetryDelayMs, () => { commitAttempted = true; });
        return result;
      } catch (error) {
        clearTimeout(deadlineTimer);
        const preservedCommitError = ['uncertain_commit', 'transaction_commit_late'].includes(error?.code);
        const unknownCommit = Boolean(error?.hasErrorLabel?.('UnknownTransactionCommitResult'));
        const driverTimedOut = error?.name === 'MongoOperationTimeoutError';
        if (!preservedCommitError && commitAttempted && (unknownCommit || driverTimedOut || Date.now() >= deadline)) error = uncertainCommitError();
        else if (!preservedCommitError && !commitAttempted && (deadlineExpired || Date.now() >= deadline)) error = storeError('Transaction deadline exceeded before commit began.', 'transaction_timeout', 503);
        controller.abort();
        lastError = error;
        try { if (session.inTransaction()) await session.abortTransaction(); } catch { /* Preserve primary error. */ }
        const unknownCommitAfterNormalization = Boolean(error?.hasErrorLabel?.('UnknownTransactionCommitResult'));
        const transientOperation = Boolean(error?.hasErrorLabel?.('TransientTransactionError'));
        if (commitAttempted || !transientOperation || unknownCommitAfterNormalization || Date.now() >= deadline) throw publicError(error);
        await delay(Math.min(transactionRetryDelayMs, Math.max(0, deadline - Date.now())));
      } finally {
        await session.endSession();
      }
    }
    throw publicError(lastError ?? storeError('Transaction deadline exceeded.', 'transaction_timeout', 503));
  }

  async function nextEventSequence(tenantId, jobId, transaction) {
    const result = await collections.jobs.updateOne(
      { tenantId, id: jobId },
      { $inc: { eventSequence: 1 }, $set: { updatedAt: new Date() } },
      transactionOperationOptions(transaction),
    );
    if (result.matchedCount !== 1) throw storeError('Prospecting job not found.', 'job_not_found', 404);
    const job = await collections.jobs.findOne({ tenantId, id: jobId }, transactionOperationOptions(transaction, { projection: { eventSequence: 1 } }));
    return job.eventSequence;
  }

  async function appendJobEvent(tenantId, jobId, key, type, payload, transaction) {
    const cleanPayload = safeJson(payload ?? {}, 'event.payload');
    const content = { type, payload: cleanPayload };
    const contentHash = stableHash(content);
    const prior = await collections.events.findOne({ tenantId, jobId, idempotencyKey: key }, transactionOperationOptions(transaction));
    if (prior) {
      if (prior.contentHash !== contentHash) throw storeError('Idempotency key was already used for different content.', 'idempotency_conflict', 409);
      return { record: prior, replayed: true };
    }
    const document = {
      tenantId,
      jobId,
      eventId: randomUUID(),
      idempotencyKey: key,
      sequence: await nextEventSequence(tenantId, jobId, transaction),
      type,
      payload: cleanPayload,
      contentHash,
      createdAt: new Date(),
    };
    await collections.events.insertOne(document, transactionOperationOptions(transaction));
    return { record: document, replayed: false };
  }

  async function connect() {
    try {
      await client.connect();
      connected = true;
      const [ping, hello] = await Promise.all([
        database.command({ ping: 1 }),
        database.admin().command({ hello: 1 }),
      ]);
      transactionSupport = Boolean(hello?.setName || hello?.msg === 'isdbgrid');
      if (transactionSupport) {
        await database.command({ ping: 1 });
        await createIndexes();
      }
      return {
        ok: ping?.ok === 1,
        backend: 'mongodb',
        database: databaseName,
        transactionsSupported: transactionSupport,
        ready: Boolean(ping?.ok === 1 && transactionSupport && indexesReady),
      };
    } catch {
      connected = false;
      transactionSupport = null;
      throw storeError('MongoDB connection failed; see protected server diagnostics.', 'mongodb_connect_failed', 503);
    }
  }

  async function createIndexes() {
    if (!connected) throw storeError('MongoDB store is not connected.', 'mongodb_not_connected', 503);
    try {
      await Promise.all([
        collections.jobs.createIndex({ tenantId: 1, id: 1 }, { unique: true, name: 'tenant_job_id' }),
        collections.jobs.createIndex({ tenantId: 1, idempotencyKey: 1 }, { unique: true, name: 'tenant_job_idempotency' }),
        collections.jobs.createIndex({ tenantId: 1, state: 1, leaseUntil: 1, createdAt: 1 }, { name: 'tenant_claimable_jobs' }),
        collections.events.createIndex({ tenantId: 1, jobId: 1, sequence: 1 }, { unique: true, name: 'tenant_job_event_sequence' }),
        collections.events.createIndex({ tenantId: 1, jobId: 1, idempotencyKey: 1 }, { unique: true, name: 'tenant_job_event_idempotency' }),
        collections.outcomes.createIndex({ tenantId: 1, idempotencyKey: 1 }, { unique: true, name: 'tenant_outcome_idempotency' }),
        collections.evidence.createIndex({ tenantId: 1, jobId: 1, sourceKey: 1, contentHash: 1 }, { unique: true, name: 'tenant_job_source_evidence_identity' }),
        collections.evidence.createIndex({ tenantId: 1, jobId: 1, idempotencyKey: 1 }, { unique: true, name: 'tenant_evidence_idempotency' }),
        collections.contacts.createIndex({ tenantId: 1, identityKey: 1 }, { unique: true, name: 'tenant_contact_identity' }),
        collections.contacts.createIndex({ tenantId: 1, jobId: 1, idempotencyKey: 1 }, { unique: true, name: 'tenant_contact_idempotency' }),
        collections.idempotency.createIndex({ tenantId: 1, jobId: 1, namespace: 1, idempotencyKey: 1 }, { unique: true, name: 'tenant_job_namespace_idempotency' }),
      ]);
      indexesReady = true;
    } catch {
      throw storeError('MongoDB index initialization failed; see protected server diagnostics.', 'mongodb_index_initialization_failed', 503);
    }
  }

  function forTenant(context) {
    // This trusted identity is captured once; caller payloads never provide tenant filters.
    const tenantId = requireUuid(context?.tenantId, 'tenantId');

    async function readJob(id) {
      try {
        const jobId = requireUuid(id, 'jobId');
        const job = await collections.jobs.findOne({ tenantId, id: jobId });
        return job ?? null;
      } catch (error) { throw publicError(error); }
    }

    const jobs = Object.freeze({
      async create(input) {
        const key = idempotencyKey(input?.idempotencyKey);
        const payload = safeJson(input?.payload, 'job.payload');
        const requestHash = stableHash(payload);
        const now = new Date();
        const id = requireUuid(input?.id ?? randomUUID(), 'jobId');
        try {
          return await withTransaction(async (transaction) => {
            const prior = await collections.jobs.findOne({ tenantId, idempotencyKey: key }, transactionOperationOptions(transaction));
            if (prior) {
              if (prior.requestHash !== requestHash) throw storeError('Idempotency key was already used for different content.', 'idempotency_conflict', 409);
              return { job: prior, replayed: true };
            }
            const job = {
              tenantId, id, idempotencyKey: key, requestHash, payload,
              state: 'queued', version: 1, fence: 0, eventSequence: 0,
              checkpoint: null, leaseOwner: null, leaseUntil: null,
              createdAt: now, updatedAt: now,
            };
            await collections.jobs.insertOne(job, transactionOperationOptions(transaction));
            await appendJobEvent(tenantId, id, `job-created:${key}`, 'job.created', { version: 1 }, transaction);
            return { job, replayed: false };
          });
        } catch (error) { throw publicError(error); }
      },
      get: readJob,
      async list({ state, limit = 100 } = {}) {
        try {
          const filter = { tenantId };
          if (state !== undefined) {
            if (!JOB_STATES.has(state)) throw storeError('Unknown prospecting job state.', 'invalid_transition');
            filter.state = state;
          }
          const bounded = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 100, 250));
          return await collections.jobs.find(filter).sort({ createdAt: -1, id: 1 }).limit(bounded).toArray();
        } catch (error) { throw publicError(error); }
      },
      async claim({ workerId, leaseMs = leaseDurationMs, jobId = null } = {}) {
        const owner = idempotencyKey(workerId);
        const requestedJob = jobId === null ? null : requireUuid(jobId, 'jobId');
        const duration = Math.max(1000, Math.min(Number.isInteger(leaseMs) ? leaseMs : leaseDurationMs, 300_000));
        try {
          return await withTransaction(async (transaction) => {
            const now = new Date();
            const job = await collections.jobs.findOneAndUpdate(
              { tenantId, ...(requestedJob ? { id: requestedJob } : {}), state: { $in: ['queued', 'running'] }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
              { $set: { state: 'running', leaseOwner: owner, leaseUntil: new Date(now.getTime() + duration), updatedAt: now }, $inc: { fence: 1, version: 1 } },
              transactionOperationOptions(transaction, { sort: { createdAt: 1, id: 1 }, returnDocument: 'after' }),
            );
            if (!job) return null;
            await appendJobEvent(tenantId, job.id, `claim:${job.fence}`, 'job.claimed', { workerId: owner, fence: job.fence, version: job.version }, transaction);
            return { job, lease: { owner, fence: job.fence, until: job.leaseUntil, version: job.version } };
          });
        } catch (error) { throw publicError(error); }
      },
      async checkpoint(id, { workerId, fence, expectedVersion, idempotencyKey: key, checkpoint }) {
        const jobId = requireUuid(id, 'jobId');
        const owner = idempotencyKey(workerId);
        const idem = idempotencyKey(key);
        const cleanCheckpoint = safeJson(checkpoint, 'checkpoint');
        if (!Number.isInteger(fence) || fence < 1 || !Number.isInteger(expectedVersion) || expectedVersion < 1) throw storeError('Lease fence and expectedVersion are required.', 'lease_lost', 409);
        const contentHash = stableHash({ checkpoint: cleanCheckpoint });
        try {
          return await withTransaction(async (transaction) => {
            const prior = await collections.events.findOne({ tenantId, jobId, idempotencyKey: `checkpoint:${idem}` }, transactionOperationOptions(transaction));
            if (prior) {
              if (prior.type !== 'job.checkpointed' || prior.payload?.fence !== fence || stableHash(prior.payload?.checkpoint) !== stableHash(cleanCheckpoint)) throw storeError('Idempotency key was already used for different content.', 'idempotency_conflict', 409);
              return { event: prior, replayed: true };
            }
            const now = new Date();
            const update = await collections.jobs.updateOne(
              { tenantId, id: jobId, state: 'running', leaseOwner: owner, fence, version: expectedVersion, leaseUntil: { $gt: now } },
              { $set: { checkpoint: cleanCheckpoint, updatedAt: now, leaseUntil: new Date(now.getTime() + 300_000) }, $inc: { version: 1 } },
              transactionOperationOptions(transaction),
            );
            if (update.matchedCount !== 1) throw storeError('Job version or lease fence is stale.', 'lease_lost', 409);
            const event = await appendJobEvent(tenantId, jobId, `checkpoint:${idem}`, 'job.checkpointed', { checkpoint: cleanCheckpoint, fence, contentHash }, transaction);
            const job = await collections.jobs.findOne({ tenantId, id: jobId }, transactionOperationOptions(transaction));
            return { event: event.record, job, replayed: event.replayed };
          });
        } catch (error) { throw publicError(error); }
      },
      async transition(id, { action, expectedVersion, idempotencyKey: key, reason = null, workerId, fence }) {
        const jobId = requireUuid(id, 'jobId');
        const idem = idempotencyKey(key);
        const allowed = { pause: ['queued', 'running'], resume: ['paused'], cancel: ['queued', 'running', 'paused'], complete: ['running'], fail: ['running'] };
        if (!allowed[action]) throw storeError('Unsupported prospecting job transition.', 'invalid_transition');
        const workerOwner = action === 'complete' || action === 'fail' ? idempotencyKey(workerId) : null;
        if ((action === 'complete' || action === 'fail') && (!Number.isInteger(fence) || fence < 1)) throw storeError('Completion requires the current lease owner and fence.', 'lease_lost', 409);
        const target = { pause: 'paused', resume: 'queued', cancel: 'cancelled', complete: 'completed', fail: 'failed' }[action];
        const cleanReason = reason === null ? null : safeJson({ reason }, 'reason').reason;
        try {
          return await withTransaction(async (transaction) => {
            const prior = await collections.events.findOne({ tenantId, jobId, idempotencyKey: `transition:${idem}` }, transactionOperationOptions(transaction));
            const eventPayload = { action, state: target, reason: cleanReason };
            if (prior) {
              if (prior.contentHash !== stableHash({ type: 'job.transitioned', payload: eventPayload })) throw storeError('Idempotency key was already used for different content.', 'idempotency_conflict', 409);
              return { job: await collections.jobs.findOne({ tenantId, id: jobId }, transactionOperationOptions(transaction)), replayed: true };
            }
            const current = await collections.jobs.findOne({ tenantId, id: jobId }, transactionOperationOptions(transaction));
            if (!current) throw storeError('Prospecting job not found.', 'job_not_found', 404);
            if (!Number.isInteger(expectedVersion) || expectedVersion !== current.version) throw storeError('Prospecting job version is stale.', 'version_conflict', 409);
            if (!allowed[action].includes(current.state) || TERMINAL.has(current.state)) throw storeError('Transition is not allowed from the current job state.', 'invalid_transition', 409);
            const now = new Date();
            const stateFilter = { tenantId, id: jobId, version: expectedVersion, state: current.state };
            if (workerOwner) Object.assign(stateFilter, { leaseOwner: workerOwner, fence, leaseUntil: { $gt: now } });
            const result = await collections.jobs.updateOne(
              stateFilter,
              { $set: { state: target, leaseOwner: null, leaseUntil: null, updatedAt: now }, $inc: { version: 1 } },
              transactionOperationOptions(transaction),
            );
            if (result.matchedCount !== 1) {
              if (workerOwner) throw storeError('Job lease owner or fence is stale.', 'lease_lost', 409);
              throw storeError('Prospecting job version is stale.', 'version_conflict', 409);
            }
            await appendJobEvent(tenantId, jobId, `transition:${idem}`, 'job.transitioned', eventPayload, transaction);
            return { job: await collections.jobs.findOne({ tenantId, id: jobId }, transactionOperationOptions(transaction)), replayed: false };
          });
        } catch (error) { throw publicError(error); }
      },
      async events(id, { afterSequence = 0, limit = 250 } = {}) {
        const jobId = requireUuid(id, 'jobId');
        try {
          const job = await collections.jobs.findOne({ tenantId, id: jobId }, { projection: { _id: 1 } });
          if (!job) throw storeError('Prospecting job not found.', 'job_not_found', 404);
          return await collections.events.find({ tenantId, jobId, sequence: { $gt: Math.max(0, Number(afterSequence) || 0) } }).sort({ sequence: 1 }).limit(Math.max(1, Math.min(limit, 500))).toArray();
        } catch (error) { throw publicError(error); }
      },
    });

    const evidence = Object.freeze({
      async record(input) {
        const jobId = requireUuid(input?.jobId, 'jobId');
        const key = idempotencyKey(input?.idempotencyKey);
        const sourceKey = idempotencyKey(input?.sourceKey);
        const content = safeJson(input?.evidence, 'evidence');
        const contentHash = stableHash(content);
        const requestHash = stableHash({ sourceKey, evidence: content });
        try {
          return await withTransaction(async (transaction) => {
            const job = await collections.jobs.findOne({ tenantId, id: jobId }, transactionOperationOptions(transaction, { projection: { _id: 1 } }));
            if (!job) throw storeError('Prospecting job not found.', 'job_not_found', 404);
            const receiptFilter = { tenantId, jobId, namespace: 'evidence', idempotencyKey: key };
            const receipt = await collections.idempotency.findOne(receiptFilter, transactionOperationOptions(transaction));
            if (receipt) {
              if (receipt.requestHash !== requestHash) throw storeError('Idempotency key was already used for different content.', 'idempotency_conflict', 409);
              const evidence = await collections.evidence.findOne({ tenantId, jobId, id: receipt.recordId }, transactionOperationOptions(transaction));
              if (!evidence) throw storeError('Evidence idempotency receipt has no evidence record.', 'idempotency_record_missing', 503);
              return { evidence, replayed: true };
            }
            const priorByKey = await collections.evidence.findOne({ tenantId, jobId, idempotencyKey: key }, transactionOperationOptions(transaction));
            if (priorByKey) {
              if (priorByKey.contentHash !== contentHash || priorByKey.sourceKey !== sourceKey) throw storeError('Idempotency key was already used for different content.', 'idempotency_conflict', 409);
              await collections.idempotency.insertOne({ ...receiptFilter, requestHash, recordId: priorByKey.id, createdAt: new Date() }, transactionOperationOptions(transaction));
              return { evidence: priorByKey, replayed: true };
            }
            const priorByIdentity = await collections.evidence.findOne({ tenantId, jobId, sourceKey, contentHash }, transactionOperationOptions(transaction));
            if (priorByIdentity) {
              await collections.idempotency.insertOne({ ...receiptFilter, requestHash, recordId: priorByIdentity.id, createdAt: new Date() }, transactionOperationOptions(transaction));
              return { evidence: priorByIdentity, replayed: true };
            }
            const doc = { tenantId, jobId, id: randomUUID(), sourceKey, idempotencyKey: key, evidence: content, contentHash, createdAt: new Date() };
            await collections.evidence.insertOne(doc, transactionOperationOptions(transaction));
            await collections.idempotency.insertOne({ ...receiptFilter, requestHash, recordId: doc.id, createdAt: new Date() }, transactionOperationOptions(transaction));
            return { evidence: doc, replayed: false };
          });
        } catch (error) { throw publicError(error); }
      },
      async listForJob(id, { limit = 250 } = {}) {
        const jobId = requireUuid(id, 'jobId');
        try { return await collections.evidence.find({ tenantId, jobId }).sort({ createdAt: 1, id: 1 }).limit(Math.max(1, Math.min(limit, 500))).toArray(); }
        catch (error) { throw publicError(error); }
      },
    });

    const outcomes = Object.freeze({
      async append(input) {
        const jobId = requireUuid(input?.jobId, 'jobId');
        const key = idempotencyKey(input?.idempotencyKey);
        const outcome = safeJson(input?.outcome, 'outcome');
        const contentHash = stableHash(outcome);
        try {
          return await withTransaction(async (transaction) => {
            if (!(await collections.jobs.findOne({ tenantId, id: jobId }, transactionOperationOptions(transaction, { projection: { _id: 1 } })))) throw storeError('Prospecting job not found.', 'job_not_found', 404);
            const prior = await collections.outcomes.findOne({ tenantId, idempotencyKey: key }, transactionOperationOptions(transaction));
            if (prior) {
              if (prior.contentHash !== contentHash || prior.jobId !== jobId) throw storeError('Idempotency key was already used for different content.', 'idempotency_conflict', 409);
              return { outcome: prior, replayed: true };
            }
            const doc = { tenantId, jobId, id: randomUUID(), idempotencyKey: key, outcome, contentHash, createdAt: new Date() };
            await collections.outcomes.insertOne(doc, transactionOperationOptions(transaction));
            return { outcome: doc, replayed: false };
          });
        } catch (error) { throw publicError(error); }
      },
      async listForJob(id, { limit = 250 } = {}) {
        const jobId = requireUuid(id, 'jobId');
        try { return await collections.outcomes.find({ tenantId, jobId }).sort({ createdAt: 1, id: 1 }).limit(Math.max(1, Math.min(limit, 500))).toArray(); }
        catch (error) { throw publicError(error); }
      },
    });

    const contacts = Object.freeze({
      async qualify(input) {
        const jobId = requireUuid(input?.jobId, 'jobId');
        const key = idempotencyKey(input?.idempotencyKey);
        const identityKey = idempotencyKey(input?.identityKey).toLowerCase();
        const contact = safeJson(input?.contact, 'contact');
        const qualification = safeJson(input?.qualification, 'qualification');
        if (qualification.status !== 'qualified') throw storeError('Only positively qualified contacts can be persisted.', 'invalid_document');
        const evidenceIds = Array.isArray(input?.evidenceIds) ? input.evidenceIds.map((value) => requireUuid(value, 'evidenceId')) : [];
        if (!evidenceIds.length) throw storeError('Qualified contacts require source evidence.', 'evidence_required');
        const normalizedEvidenceIds = [...evidenceIds].sort();
        const contactHash = stableHash({ identityKey, contact, qualification, evidenceIds: normalizedEvidenceIds });
        const legacyContactHash = stableHash({ contact, qualification, evidenceIds: normalizedEvidenceIds });
        try {
          return await withTransaction(async (transaction) => {
            if (!(await collections.jobs.findOne({ tenantId, id: jobId }, transactionOperationOptions(transaction, { projection: { _id: 1 } })))) throw storeError('Prospecting job not found.', 'job_not_found', 404);
            const evidenceCount = await collections.evidence.countDocuments({ tenantId, jobId, id: { $in: evidenceIds } }, transactionOperationOptions(transaction));
            if (evidenceCount !== new Set(evidenceIds).size) throw storeError('Qualified contact references missing source evidence.', 'evidence_required', 409);
            const receiptFilter = { tenantId, jobId, namespace: 'contact', idempotencyKey: key };
            const receipt = await collections.idempotency.findOne(receiptFilter, transactionOperationOptions(transaction));
            if (receipt) {
              if (receipt.requestHash !== contactHash) throw storeError('Idempotency key was already used for different content.', 'idempotency_conflict', 409);
              const contactRecord = await collections.contacts.findOne({ tenantId, id: receipt.recordId }, transactionOperationOptions(transaction));
              if (!contactRecord) throw storeError('Contact idempotency receipt has no contact record.', 'idempotency_record_missing', 503);
              return { contact: contactRecord, replayed: true };
            }
            const byKey = await collections.contacts.findOne({ tenantId, jobId, idempotencyKey: key }, transactionOperationOptions(transaction));
            if (byKey) {
              const sameLegacyRequest = byKey.identityKey === identityKey && byKey.contentHash === legacyContactHash;
              if (byKey.contentHash !== contactHash && !sameLegacyRequest) throw storeError('Idempotency key was already used for different content.', 'idempotency_conflict', 409);
              await collections.idempotency.insertOne({ ...receiptFilter, requestHash: contactHash, recordId: byKey.id, createdAt: new Date() }, transactionOperationOptions(transaction));
              return { contact: byKey, replayed: true };
            }
            const byIdentity = await collections.contacts.findOne({ tenantId, identityKey }, transactionOperationOptions(transaction));
            if (byIdentity) {
              const sameLegacyRequest = byIdentity.identityKey === identityKey && byIdentity.contentHash === legacyContactHash;
              if (byIdentity.contentHash === contactHash || sameLegacyRequest) {
                await collections.idempotency.insertOne({ ...receiptFilter, requestHash: contactHash, recordId: byIdentity.id, createdAt: new Date() }, transactionOperationOptions(transaction));
                return { contact: byIdentity, replayed: true };
              }
              throw storeError('Contact identity already exists with different qualified evidence.', 'identity_conflict', 409);
            }
            const doc = { tenantId, jobId, id: randomUUID(), idempotencyKey: key, identityKey, contact, qualification, evidenceIds, contentHash: contactHash, createdAt: new Date() };
            await collections.contacts.insertOne(doc, transactionOperationOptions(transaction));
            await collections.idempotency.insertOne({ ...receiptFilter, requestHash: contactHash, recordId: doc.id, createdAt: new Date() }, transactionOperationOptions(transaction));
            return { contact: doc, replayed: false };
          });
        } catch (error) { throw publicError(error); }
      },
      async list({ limit = 250 } = {}) {
        try { return await collections.contacts.find({ tenantId }).sort({ createdAt: -1, id: 1 }).limit(Math.max(1, Math.min(limit, 500))).toArray(); }
        catch (error) { throw publicError(error); }
      },
    });

    return Object.freeze({ tenantId, jobs, evidence, outcomes, contacts });
  }

  async function health() {
    if (!connected) return { ok: false, backend: 'mongodb', transactionsSupported: null, ready: false };
    try {
      const result = await database.command({ ping: 1 });
      return { ok: result?.ok === 1, backend: 'mongodb', transactionsSupported: transactionSupport, ready: result?.ok === 1 && transactionSupport === true && indexesReady };
    } catch {
      return { ok: false, backend: 'mongodb', transactionsSupported: transactionSupport, ready: false };
    }
  }

  return Object.freeze({
    backend: 'mongodb',
    databaseName,
    connect,
    close: async () => {
      connected = false;
      transactionSupport = null;
      try { await client.close(); }
      catch { throw storeError('MongoDB close failed; see protected server diagnostics.', 'mongodb_close_failed', 503); }
    },
    health,
    forTenant,
    get transactionSupport() { return transactionSupport; },
    get indexesReady() { return indexesReady; },
  });
}

