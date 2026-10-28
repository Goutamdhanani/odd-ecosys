import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-archive-json-references-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
const { initDb, closeDb } = await import('../pipeline/database.js');
const { archiveBatch, restoreBatch } = await import('../pipeline/archiver.js');
let db = initDb();
after(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

db.exec(`CREATE TABLE custom_note_refs (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  related_lead_ids_json TEXT,
  related_send_ids_json TEXT,
  note TEXT NOT NULL
)`);

let nextId = 2000;
function seed({ withSend = true } = {}) {
  const id = nextId++;
  db.prepare("INSERT INTO batches(id,name,phase,status) VALUES(?,?,'test','open')").run(id, `Synthetic archive JSON ${id}`);
  db.prepare("INSERT INTO leads(id,batch_id,business_name,status) VALUES(?,?,?,'sent')").run(id, id, `Synthetic contact ${id}`);
  if (withSend) db.prepare("INSERT INTO sends(id,lead_id,status,subject_snapshot) VALUES(?,?,'sent',?)")
    .run(id, id, `Saved synthetic subject ${id}`);
  return id;
}

function state() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return tables.map(({ name }) => {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { table: name, count: rows.length, rows };
  });
}

function assertBlockedWithoutMutation(batchId, message) {
  const before = state();
  assert.throws(() => archiveBatch(batchId), error => error.statusCode === 409 && message.test(error.message));
  assert.deepEqual(state(), before, 'every pre-existing table count and row, including both batches and the shared note, remains unchanged');
}

for (const kind of ['lead', 'send']) {
  test(`a captured note cannot archive shared JSON ${kind} references to another batch`, () => {
    const owned = seed();
    const other = seed();
    const column = `related_${kind}_ids_json`;
    db.prepare(`INSERT INTO custom_note_refs(id,lead_id,${column},note) VALUES(?,?,?,?)`)
      .run(owned, owned, JSON.stringify([owned, other]), `Synthetic shared ${kind} note`);
    try {
      assertBlockedWithoutMutation(owned, /custom_note_refs.*outside.*snapshot/i);
      assert.equal(db.prepare('SELECT batch_id FROM leads WHERE id=?').get(other).batch_id, other);
      assert.equal(db.prepare('SELECT lead_id FROM sends WHERE id=?').get(other).lead_id, other);
      assert.equal(db.prepare(`SELECT ${column} AS ids FROM custom_note_refs WHERE id=?`).get(owned).ids, JSON.stringify([owned, other]));
    } finally {
      db.prepare('DELETE FROM custom_note_refs WHERE id=?').run(owned);
    }
  });
}

test('captured JSON reference arrays reject invalid IDs before any mutation, even without matching sends', () => {
  const owned = seed();
  const withoutSend = seed({ withSend: false });
  const invalidIds = [null, true, false, '2000', '', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, []];
  for (const kind of ['lead', 'send']) {
    const column = `related_${kind}_ids_json`;
    for (const invalid of invalidIds) {
      // Do not depend on finding an in-snapshot ID before validating a captured
      // row. The no-send batch also has an empty snapshot send-ID set.
      for (const [leadId, ids] of [[owned, [owned, invalid]], [withoutSend, [invalid]]]) {
        db.prepare(`INSERT INTO custom_note_refs(id,lead_id,${column},note) VALUES(?,?,?,?)`)
          .run(leadId, leadId, JSON.stringify(ids), 'Synthetic invalid reference');
        try {
          assertBlockedWithoutMutation(leadId, /custom_note_refs.*invalid.*reference ID/i);
        } finally {
          db.prepare('DELETE FROM custom_note_refs WHERE id=?').run(leadId);
        }
      }
    }
  }
});

test('captured JSON references must belong to the snapshot even when none matches its IDs', () => {
  const other = seed();
  for (const kind of ['lead', 'send']) {
    const owned = seed({ withSend: kind !== 'send' });
    const column = `related_${kind}_ids_json`;
    db.prepare(`INSERT INTO custom_note_refs(id,lead_id,${column},note) VALUES(?,?,?,?)`)
      .run(owned, owned, JSON.stringify([other]), 'Synthetic outside-only reference');
    try {
      assertBlockedWithoutMutation(owned, /custom_note_refs.*outside.*snapshot/i);
    } finally {
      db.prepare('DELETE FROM custom_note_refs WHERE id=?').run(owned);
    }
  }
});

test('valid captured same-batch lead/send JSON arrays archive and restore their exact note after restart', () => {
  const owned = seed();
  const second = nextId++;
  db.prepare("INSERT INTO leads(id,batch_id,business_name,status) VALUES(?,?,?,'sent')").run(second, owned, `Synthetic second ${second}`);
  db.prepare("INSERT INTO sends(id,lead_id,status) VALUES(?,?,'sent')").run(second, second);
  const leadIds = JSON.stringify([owned, second]);
  const sendIds = JSON.stringify([second, owned]);
  db.prepare('INSERT INTO custom_note_refs(id,lead_id,related_lead_ids_json,related_send_ids_json,note) VALUES(?,?,?,?,?)')
    .run(owned, owned, leadIds, sendIds, 'Synthetic captured note; preserve exact arrays');
  const note = db.prepare('SELECT * FROM custom_note_refs WHERE id=?').get(owned);
  const leads = db.prepare('SELECT * FROM leads WHERE batch_id=? ORDER BY id').all(owned);
  const sends = db.prepare('SELECT * FROM sends WHERE lead_id IN (?,?) ORDER BY id').all(owned, second);
  const archived = archiveBatch(owned);
  assert.equal(archived.archivedLeads, 2);
  assert.equal(archived.archivedSends, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM custom_note_refs WHERE id=?').get(owned).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM batch_archive_snapshots WHERE batch_id=? AND restored_at IS NULL').get(owned).n, 1);
  closeDb();
  db = initDb();
  const restored = restoreBatch(owned);
  assert.equal(restored.restoredLeads, 2);
  assert.equal(restored.restoredSends, 2);
  assert.deepEqual(db.prepare('SELECT * FROM custom_note_refs WHERE id=?').get(owned), note);
  assert.deepEqual(db.prepare('SELECT * FROM leads WHERE batch_id=? ORDER BY id').all(owned), leads);
  assert.deepEqual(db.prepare('SELECT * FROM sends WHERE lead_id IN (?,?) ORDER BY id').all(owned, second), sends);
  assert.equal(db.prepare('SELECT status FROM batches WHERE id=?').get(owned).status, 'open');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
