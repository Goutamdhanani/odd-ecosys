import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-lead-saved-search-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';

const database = await import('../pipeline/database.js');
const authModule = await import('../pipeline/auth-manager.js');
const discoveryModule = await import('../pipeline/lead-discovery-jobs.js');
let db = database.initDb();
authModule.createAuthManager(db);

function addUser(email, role) {
  const result = db.prepare(`INSERT INTO auth_users(email,password_salt,password_hash,role)
    VALUES(?,?,?,?)`).run(email, 's'.repeat(32), 'h'.repeat(64), role);
  return Number(result.lastInsertRowid);
}

const ownerId = addUser('owner@example.test', 'owner');
const operatorId = addUser('operator@example.test', 'operator');
const reviewerId = addUser('reviewer@example.test', 'reviewer');
const owner = { id: ownerId, role: 'owner' };
const operator = { id: operatorId, role: 'operator' };
const reviewer = { id: reviewerId, role: 'reviewer' };

function createManager() {
  return discoveryModule.createLeadDiscoveryJobs({ db,
    leadSearch: { publicStatus: () => ({ configured: true }) },
    websiteDiscoveryJobs: { getJob: () => null, pause() {}, resume() {}, cancel() {} },
    schedule: () => ({}),
  });
}

let manager = createManager();

after(() => {
  manager?.close();
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('saved discovery searches are validated, private to their owner, and durable across database reopen', () => {
  const saved = manager.saveSearch({ name: '  Jaipur handicrafts  ', country: 'India', state: 'Rajasthan',
    cities: ['Jaipur', 'Jodhpur'], niches: ['Handicraft exporters'], sources: ['searxng', 'epch_directory'],
    target_email_count: 42, max_businesses: 70, max_pages_per_query: 2, max_runtime_minutes: 25,
    provider_api_key: 'must-not-be-persisted' }, owner);
  assert.equal(saved.name, 'Jaipur handicrafts');
  assert.equal(saved.criteria.country, 'India');
  assert.deepEqual(saved.criteria.cities, ['jaipur', 'jodhpur']);
  assert.deepEqual(saved.criteria.sources, ['searxng', 'epch_directory']);
  assert.equal(saved.criteria.target_email_count, 42);
  assert.equal('batch_id' in saved.criteria, false, 'saved criteria can be used with another open batch');
  assert.equal(JSON.stringify(saved).includes('must-not-be-persisted'), false, 'only known search criteria are persisted');
  assert.equal(manager.listSavedSearches(owner).length, 1);
  assert.equal(manager.listSavedSearches(operator).length, 0);

  assert.throws(() => manager.saveSearch({ name: 'JAIPUR HANDICRAFTS', country: 'India', cities: ['Jaipur'],
    niches: ['Handicraft exporter'] }, owner), error => error.code === 'saved_search_name_exists');
  assert.throws(() => manager.saveSearch({ name: 'Mixed directory search', country: 'India', cities: ['Jaipur'],
    niches: ['Handicraft exporter', 'Machine parts'], sources: ['epch_directory'] }, owner),
  error => error.code === 'epch_filter_unsupported');
  assert.throws(() => manager.listSavedSearches(reviewer), error => error.code === 'saved_search_forbidden');
  assert.throws(() => manager.saveSearch({ name: 'No owner', country: 'India', cities: ['Jaipur'], niches: ['Craft'] },
    { id: null, role: 'owner' }), error => error.code === 'saved_search_account_missing');
  assert.throws(() => manager.deleteSavedSearch(saved.id, operator), error => error.code === 'saved_search_missing');

  manager.close();
  manager = null;
  database.closeDb();
  db = database.initDb();
  authModule.createAuthManager(db);
  manager = createManager();
  const recovered = manager.listSavedSearches(owner);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, saved.id);
  assert.deepEqual(recovered[0].criteria.cities, ['jaipur', 'jodhpur']);
  assert.equal(manager.listSavedSearches(operator).length, 0);
  assert.deepEqual(manager.deleteSavedSearch(saved.id, owner), { deleted: true, id: saved.id });
  assert.deepEqual(manager.listSavedSearches(owner), []);
  assert.throws(() => manager.deleteSavedSearch(saved.id, owner), error => error.code === 'saved_search_missing');
});
