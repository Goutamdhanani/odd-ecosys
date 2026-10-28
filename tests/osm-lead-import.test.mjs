import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_OSM_FEATURES, parseOsmExport } from '../pipeline/osm-importer.js';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-osm-import-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('OSM synthetic import','discovery','open')").run().lastInsertRowid);
const baselineId = Number(db.prepare(`
  INSERT INTO leads(batch_id,business_name,city,website_url,normalized_domain,status)
  VALUES (?,'Existing OSM duplicate','Pune','https://already.example.test','already.example.test','discovered')
`).run(batchId).lastInsertRowid);
db.prepare("INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary) VALUES (?,'existing@example.test','manual','unknown',1)").run(baselineId);

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function feature(type, id, properties = {}) {
  return { type: 'Feature', id: `${type}/${id}`, properties: { '@id': `${type}/${id}`, ...properties }, geometry: null };
}

const geojson = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    feature('way', 510, {
      name: 'OSM Studio', shop: 'art', 'addr:street': 'River Road', 'addr:housenumber': '12', 'addr:city': 'Pune',
      phone: '+91 20 1234 5678', website: 'www.osm-studio.example.test', 'contact:email': 'hello@osm-studio.example.test; team@osm-studio.example.test',
      '@timestamp': '2026-10-08T10:00:00Z',
    }),
    feature('way', 510, { name: 'Duplicate OSM Studio', shop: 'art' }),
    feature('node', 511, { shop: 'bakery', 'addr:city': 'Pune' }),
    feature('relation', 512, { name: 'Existing OSM duplicate', website: 'https://already.example.test', 'addr:city': 'Pune' }),
  ],
});

test('OSM import requires attribution acknowledgement and previews bounded, sourced GeoJSON without writes', async () => {
  const before = db.prepare('SELECT COUNT(*) AS count FROM leads').get().count;
  const denied = await request('/api/leads/import/openstreetmap/preview', { batch_id: batchId, export: geojson });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /ODbL attribution/i);

  const preview = await request('/api/leads/import/openstreetmap/preview', {
    batch_id: batchId, export: geojson, attribution_acknowledged: true,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.featureCount, 4);
  assert.equal(preview.body.candidateCount, 2);
  assert.equal(preview.body.existingSourceDuplicates, 0);
  assert.deepEqual(preview.body.rejections.map(row => row.reason), ['duplicate_osm_object_in_export', 'missing_business_name']);
  assert.equal(preview.body.sample[0].source_url, 'https://www.openstreetmap.org/way/510');
  assert.match(preview.body.sample[0].source_details, /ODbL.*2026-10-08T10:00:00Z/);
  assert.deepEqual(preview.body.attribution, {
    label: '© OpenStreetMap contributors · Open Database License (ODbL)',
    url: 'https://www.openstreetmap.org/copyright',
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, before, 'preview is read-only');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0, 'preview never creates sending work');
});

test('GeoJSON import preserves source identity, attribution and timestamp; rejects duplicates; never verifies or sends', async () => {
  const imported = await request('/api/leads/import/openstreetmap', {
    batch_id: batchId, export: geojson, attribution_acknowledged: true,
  });
  assert.equal(imported.status, 200);
  assert.deepEqual(imported.body.counts, { parsed: 4, inserted: 1, duplicates: 2, invalid: 1 });
  assert.equal(imported.body.duplicates.some(row => row.reason === 'duplicate_db_domain'), true);
  assert.equal(imported.body.duplicates.some(row => row.reason === 'duplicate_osm_object_in_export'), true);
  assert.equal(imported.body.rejections.some(row => row.reason === 'missing_business_name'), true);

  const lead = db.prepare("SELECT * FROM leads WHERE business_name='OSM Studio'").get();
  assert.ok(lead);
  assert.equal(lead.source, 'openstreetmap');
  assert.equal(lead.source_url, 'https://www.openstreetmap.org/way/510');
  assert.match(lead.source_details, /OpenStreetMap · ODbL · feature 1 · source timestamp: 2026-10-08T10:00:00Z/);
  assert.equal(lead.website_url, 'https://www.osm-studio.example.test/');
  assert.deepEqual(db.prepare('SELECT email,source,verification_status,is_primary FROM lead_emails WHERE lead_id=? ORDER BY is_primary DESC,email').all(lead.id), [
    { email: 'hello@osm-studio.example.test', source: 'openstreetmap', verification_status: 'unknown', is_primary: 1 },
    { email: 'team@osm-studio.example.test', source: 'openstreetmap', verification_status: 'unknown', is_primary: 0 },
  ]);
  const event = db.prepare("SELECT meta_json FROM events WHERE lead_id=? AND event_type='contact_imported'").get(lead.id);
  assert.deepEqual(JSON.parse(event.meta_json), {
    batch_id: batchId, source: 'openstreetmap', osm_feature_row: 1, osm_object_id: 'way/510',
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);

  const replayPreview = await request('/api/leads/import/openstreetmap/preview', {
    batch_id: batchId,
    export: JSON.stringify({ type: 'FeatureCollection', features: [feature('way', 510, { name: 'OSM Studio' })] }),
    attribution_acknowledged: true,
  });
  assert.equal(replayPreview.body.existingSourceDuplicates, 1);
  const replay = await request('/api/leads/import/openstreetmap', {
    batch_id: batchId,
    export: JSON.stringify({ type: 'FeatureCollection', features: [feature('way', 510, { name: 'OSM Studio' })] }),
    attribution_acknowledged: true,
  });
  assert.equal(replay.body.counts.inserted, 0);
  assert.equal(replay.body.counts.duplicates, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE source_url='https://www.openstreetmap.org/way/510'").get().count, 1);
});

test('OSM CSV exports use explicit object IDs and pass normal CRM duplicate and validation checks', async () => {
  const csv = [
    '"@id","@timestamp","name","office","addr:city","email","website"',
    '"node/701","2026-10-09T09:30:00Z","CSV OSM Office","consulting","Nagpur","csv-osm@example.test","https://csv-osm.example.test"',
  ].join('\r\n');
  const imported = await request('/api/leads/import/openstreetmap', {
    batch_id: batchId, export: csv, attribution_acknowledged: true,
  });
  assert.equal(imported.status, 200);
  assert.deepEqual(imported.body.counts, { parsed: 1, inserted: 1, duplicates: 0, invalid: 0 });
  const lead = db.prepare("SELECT * FROM leads WHERE source_url='https://www.openstreetmap.org/node/701'").get();
  assert.ok(lead);
  assert.equal(lead.source, 'openstreetmap');
  assert.match(lead.source_details, /source timestamp: 2026-10-09T09:30:00Z/);
  assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=?').get(lead.id).verification_status, 'unknown');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('OSM import rejects malformed data, non-open batches and exports over feature or byte bounds', async () => {
  assert.equal((await request('/api/leads/import/openstreetmap/preview', {
    batch_id: 999999, export: geojson, attribution_acknowledged: true,
  })).status, 404);
  const closedBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Closed OSM','discovery','closed')").run().lastInsertRowid);
  assert.equal((await request('/api/leads/import/openstreetmap/preview', {
    batch_id: closedBatchId, export: geojson, attribution_acknowledged: true,
  })).status, 409);
  assert.equal((await request('/api/leads/import/openstreetmap/preview', {
    batch_id: batchId, export: '{"type":"FeatureCollection","features":', attribution_acknowledged: true,
  })).status, 400);
  assert.throws(() => parseOsmExport(JSON.stringify({ type: 'FeatureCollection', features: Array(MAX_OSM_FEATURES + 1).fill(feature('node', 1, { name: 'Too many' })) })), error => error.statusCode === 413);
  assert.throws(() => parseOsmExport('x'.repeat(5 * 1024 * 1024 + 1)), error => error.statusCode === 413);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});
