import { createAstraMongoStore } from './astra-mongo-store.js';

const PROSPECTING_MODE = 'prospecting-test';

function configurationError(message, code = 'persistence_configuration_invalid') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseDatabaseAllowlist(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * Explicit persistence boundary. Existing SQL callers keep receiving their
 * PostgreSQL client; Mongo is available only to the isolated prospecting
 * integration mode and receives a database name separate from its URI.
 */
export function createAstraPersistence({
  env = process.env,
  postgresClient,
  mongoFactory = createAstraMongoStore,
  mongoClientClass,
  allowedMongoTestDatabases,
} = {}) {
  const backend = String(env.ASTRA_PERSISTENCE_BACKEND ?? 'postgres').trim().toLowerCase();
  if (backend === 'postgres') {
    if (!postgresClient || typeof postgresClient.query !== 'function') {
      throw configurationError('PostgreSQL persistence requires an existing query client.');
    }
    return Object.freeze({
      backend: 'postgres',
      client: postgresClient,
      query: postgresClient.query.bind(postgresClient),
      close: async () => {},
    });
  }

  if (backend !== 'mongodb') {
    throw configurationError('Unsupported persistence backend.');
  }
  if (env.ASTRA_INTEGRATION_MODE !== PROSPECTING_MODE) {
    throw configurationError('MongoDB requires ASTRA_INTEGRATION_MODE=prospecting-test.');
  }
  const uri = String(env.MONGODB_URI ?? '').trim();
  const databaseName = String(env.MONGODB_DATABASE ?? '').trim();
  if (!uri || !databaseName) {
    throw configurationError('MongoDB requires MONGODB_URI and a separate MONGODB_DATABASE.');
  }
  if (!/^astra_test_(?!(?:admin|prod(?:uction)?|customer|live)(?:_|$))[a-z0-9_-]{1,48}$/i.test(databaseName)) {
    throw configurationError('MongoDB requires an explicitly named astra_test_* database.');
  }
  const allowlist = parseDatabaseAllowlist(
    allowedMongoTestDatabases ?? env.ASTRA_MONGODB_TEST_DATABASES,
  );
  if (!allowlist.includes(databaseName)) {
    throw configurationError('MongoDB database is not in ASTRA_MONGODB_TEST_DATABASES.');
  }

  return mongoFactory({
    uri,
    databaseName,
    integrationMode: PROSPECTING_MODE,
    allowedTestDatabases: allowlist,
    MongoClientClass: mongoClientClass,
  });
}

