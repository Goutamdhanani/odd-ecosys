// ============================================================
//  ODD-ECOSYS Pipeline — SQLite Database Layer
//  Uses better-sqlite3 (synchronous, WAL mode)
//  Schema matches plan.md §16
// ============================================================

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tests and development workers must select a separate database before import.
export function getDbPath() {
  return process.env.ODD_DB_PATH
    ? path.resolve(process.env.ODD_DB_PATH)
    : path.join(__dirname, '..', 'data', 'pipeline.db');
}

let _db = null;

/**
 * Get the singleton database instance.
 * Initializes on first call or reconnects if closed / target path changed.
 */
export function getDb() {
  const currentPath = getDbPath();
  if (!_db || !_db.open || _db.name !== currentPath) {
    if (_db && _db.open) {
      try { _db.close(); } catch {}
    }
    // Ensure data directory exists
    const dataDir = path.dirname(currentPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    _db = new Database(currentPath);

    // Performance & safety pragmas
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
  }
  return _db;
}

/**
 * Initialize the database schema.
 * Safe to call multiple times — uses IF NOT EXISTS.
 */
export function initDb() {
  const db = getDb();

  db.exec(`
    -- === Batches (the cohort engine) ===
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      lead_count INTEGER DEFAULT 0,
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    );

    -- === Core lead record ===
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES batches(id),
      business_name TEXT NOT NULL,
      category TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      country TEXT,
      phone TEXT,
      website_url TEXT,
      facebook_url TEXT,
      email TEXT,
      source TEXT,
      site_status TEXT,
      site_score INTEGER,
      site_reasons TEXT,
      fb_active INTEGER,
      status TEXT NOT NULL DEFAULT 'discovered',
      disqualification_reason TEXT,
      rating REAL,
      reviews INTEGER,
      latitude REAL,
      longitude REAL,
      place_id TEXT,
      normalized_domain TEXT,
      normalized_phone TEXT,
      screenshot_path TEXT,
      site_checked_at TEXT,
      confidence INTEGER,
      site_reasons_json TEXT,
      booking_url TEXT,
      photo_url TEXT,
      price_level TEXT,
      hours_status TEXT,
      instagram_url TEXT,
      linkedin_url TEXT,
      twitter_url TEXT,
      discovered_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_batch ON leads(batch_id);
    CREATE INDEX IF NOT EXISTS idx_leads_dedup ON leads(normalized_domain, normalized_phone);

    -- === Emails discovered per lead (a business can have >1) ===
    CREATE TABLE IF NOT EXISTS lead_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      email TEXT NOT NULL,
      source TEXT,
      verification_status TEXT,
      confidence_score INTEGER DEFAULT 0,
      is_primary INTEGER DEFAULT 0,
      is_catch_all INTEGER DEFAULT 0,
      is_role_account INTEGER DEFAULT 0,
      verified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lead_emails_lead ON lead_emails(lead_id);

    -- === Global suppression list ===
    CREATE TABLE IF NOT EXISTS suppression_list (
      email TEXT PRIMARY KEY,
      reason TEXT,
      added_at TEXT DEFAULT (datetime('now'))
    );

    -- === Mailboxes ===
    CREATE TABLE IF NOT EXISTS mailboxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      domain TEXT NOT NULL,
      provider TEXT,
      warmup_status TEXT DEFAULT 'warming',
      warmup_started_at TEXT,
      daily_limit INTEGER DEFAULT 0,
      health_score REAL DEFAULT 100.0,
      active INTEGER DEFAULT 1
    );

    -- === Domains ===
    CREATE TABLE IF NOT EXISTS domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT UNIQUE NOT NULL,
      spf_ok INTEGER DEFAULT 0,
      dkim_ok INTEGER DEFAULT 0,
      dmarc_ok INTEGER DEFAULT 0,
      blacklisted INTEGER DEFAULT 0,
      last_checked_at TEXT
    );

    -- === Personalized copy per lead ===
    CREATE TABLE IF NOT EXISTS personalizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      subject_variant TEXT,
      subject_line TEXT,
      body_variant TEXT,
      body_text TEXT,
      model_used TEXT,
      guardrail_passed INTEGER DEFAULT 0,
      fact_check_passed INTEGER DEFAULT 0,
      approved INTEGER DEFAULT 0,
      generated_at TEXT DEFAULT (datetime('now'))
    );

    -- === Campaigns & sends ===
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sequence_step INTEGER DEFAULT 1,
      template_ref TEXT
    );

    CREATE TABLE IF NOT EXISTS sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      mailbox_id INTEGER REFERENCES mailboxes(id),
      campaign_id INTEGER REFERENCES campaigns(id),
      personalization_id INTEGER REFERENCES personalizations(id),
      variant TEXT,
      scheduled_at TEXT,
      sent_at TEXT,
      status TEXT DEFAULT 'scheduled'
    );

    -- === Events ===
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      send_id INTEGER REFERENCES sends(id),
      lead_id INTEGER,
      event_type TEXT NOT NULL,
      event_at TEXT DEFAULT (datetime('now')),
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_send ON events(send_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id);

    -- === Archive tables ===
    CREATE TABLE IF NOT EXISTS leads_archive (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER,
      business_name TEXT,
      category TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      country TEXT,
      phone TEXT,
      website_url TEXT,
      facebook_url TEXT,
      email TEXT,
      source TEXT,
      site_status TEXT,
      site_score INTEGER,
      site_reasons TEXT,
      fb_active INTEGER,
      status TEXT,
      disqualification_reason TEXT,
      rating REAL,
      reviews INTEGER,
      latitude REAL,
      longitude REAL,
      place_id TEXT,
      normalized_domain TEXT,
      normalized_phone TEXT,
      discovered_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sends_archive (
      id INTEGER PRIMARY KEY,
      lead_id INTEGER,
      mailbox_id INTEGER,
      campaign_id INTEGER,
      personalization_id INTEGER,
      variant TEXT,
      scheduled_at TEXT,
      sent_at TEXT,
      status TEXT
    );
  `);

  // ── Migrations for existing databases ────────────────────
  runMigrations(db);

  return db;
}

/**
 * Close the database connection.
 */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Run schema migrations for existing databases.
 * Adds columns that didn't exist in Stage 3.
 */
function runMigrations(db) {
  const migrations = [
    // Stage 4
    { column: 'screenshot_path',  table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN screenshot_path TEXT' },
    { column: 'site_checked_at',  table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN site_checked_at TEXT' },
    { column: 'confidence',       table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN confidence INTEGER' },
    { column: 'site_reasons_json',table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN site_reasons_json TEXT' },
    // Stage 5 — lead_emails enrichment
    { column: 'is_disposable',    table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN is_disposable INTEGER DEFAULT 0' },
    { column: 'is_free_provider', table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN is_free_provider INTEGER DEFAULT 0' },
    { column: 'mx_host',          table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN mx_host TEXT' },
    { column: 'smtp_code',        table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN smtp_code INTEGER' },
    { column: 'smtp_response',    table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN smtp_response TEXT' },
    { column: 'verification_json',table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN verification_json TEXT' },
    { column: 'retry_count',      table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN retry_count INTEGER DEFAULT 0' },
    { column: 'confidence_score', table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN confidence_score INTEGER DEFAULT 0' },
    { column: 'is_primary',       table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN is_primary INTEGER DEFAULT 0' },
    // Stage 6/7 — campaigns & sends enrichment
    { column: 'status',            table: 'campaigns',   sql: "ALTER TABLE campaigns ADD COLUMN status TEXT DEFAULT 'draft'" },
    { column: 'batch_ids_json',    table: 'campaigns',   sql: 'ALTER TABLE campaigns ADD COLUMN batch_ids_json TEXT' },
    { column: 'created_at',        table: 'campaigns',   sql: "ALTER TABLE campaigns ADD COLUMN created_at TEXT DEFAULT (datetime('now'))" },
    { column: 'error_message',     table: 'sends',       sql: 'ALTER TABLE sends ADD COLUMN error_message TEXT' },
    // Mailbox SMTP & Real DNS columns
    { column: 'smtp_host',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN smtp_host TEXT' },
    { column: 'smtp_port',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN smtp_port INTEGER DEFAULT 587' },
    { column: 'smtp_user',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN smtp_user TEXT' },
    { column: 'smtp_pass',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN smtp_pass TEXT' },
    { column: 'smtp_secure',       table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN smtp_secure INTEGER DEFAULT 0' },
    { column: 'from_name',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN from_name TEXT' },
    { column: 'spf_ok',            table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN spf_ok INTEGER DEFAULT 0' },
    { column: 'dkim_ok',           table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN dkim_ok INTEGER DEFAULT 0' },
    { column: 'dmarc_ok',          table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN dmarc_ok INTEGER DEFAULT 0' },
    { column: 'blacklisted',       table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN blacklisted INTEGER DEFAULT 0' },
    { column: 'dns_checked_at',    table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN dns_checked_at TEXT' },
    { column: 'dns_records_json',  table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN dns_records_json TEXT' },
    // B04/B05 — observed DNS outcome statuses (unknown/no_selector_found/listed/unavailable...)
    { column: 'dkim_status',       table: 'mailboxes',   sql: "ALTER TABLE mailboxes ADD COLUMN dkim_status TEXT DEFAULT 'unknown'" },
    { column: 'blacklist_status',  table: 'mailboxes',   sql: "ALTER TABLE mailboxes ADD COLUMN blacklist_status TEXT DEFAULT 'unknown'" },
    { column: 'dkim_status',       table: 'domains',     sql: "ALTER TABLE domains ADD COLUMN dkim_status TEXT DEFAULT 'unknown'" },
    { column: 'blacklist_status',  table: 'domains',     sql: "ALTER TABLE domains ADD COLUMN blacklist_status TEXT DEFAULT 'unknown'" },
    // B07 — fact-check outcome status (passed/failed/unavailable)
    { column: 'fact_check_status', table: 'personalizations', sql: "ALTER TABLE personalizations ADD COLUMN fact_check_status TEXT" },
    // B09 — remote CRM identity persisted after a verified upstream write
    { column: 'crm_remote_id',     table: 'leads',       sql: 'ALTER TABLE leads ADD COLUMN crm_remote_id TEXT' },
    { column: 'crm_synced_at',     table: 'leads',       sql: 'ALTER TABLE leads ADD COLUMN crm_synced_at TEXT' },
    { column: 'crm_sync_status',   table: 'leads',       sql: "ALTER TABLE leads ADD COLUMN crm_sync_status TEXT DEFAULT 'not_synced'" },
    // Enterprise Scraping & Rich Lead Metadata
    { column: 'booking_url',       table: 'leads',       sql: 'ALTER TABLE leads ADD COLUMN booking_url TEXT' },
    { column: 'photo_url',         table: 'leads',       sql: 'ALTER TABLE leads ADD COLUMN photo_url TEXT' },
    { column: 'price_level',       table: 'leads',       sql: 'ALTER TABLE leads ADD COLUMN price_level TEXT' },
    { column: 'hours_status',      table: 'leads',       sql: 'ALTER TABLE leads ADD COLUMN hours_status TEXT' },
    { column: 'instagram_url',     table: 'leads',       sql: 'ALTER TABLE leads ADD COLUMN instagram_url TEXT' },
    { column: 'linkedin_url',      table: 'leads',       sql: 'ALTER TABLE leads ADD COLUMN linkedin_url TEXT' },
    { column: 'twitter_url',       table: 'leads',       sql: 'ALTER TABLE leads ADD COLUMN twitter_url TEXT' },
  ];

  for (const m of migrations) {
    try {
      const info = db.prepare(`PRAGMA table_info(${m.table})`).all();
      if (!info.some(col => col.name === m.column)) {
        db.exec(m.sql);
      }
    } catch { /* Column might already exist */ }
  }
}

/**
 * Get database stats for monitoring.
 */
export function getDbStats() {
  const db = getDb();
  return {
    leads_total: db.prepare('SELECT COUNT(*) as count FROM leads').get().count,
    leads_discovered: db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'discovered'").get().count,
    leads_checking: db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'checking'").get().count,
    leads_enriched: db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'enriching'").get().count,
    leads_site_checked: db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'site_checked'").get().count,
    leads_verified: db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'verified'").get().count,
    leads_queued: db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'queued'").get().count,
    leads_sent: db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'sent'").get().count,
    leads_replied: db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'replied'").get().count,
    leads_won: db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'won'").get().count,
    leads_disqualified: db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'disqualified'").get().count,
    batches_open: db.prepare("SELECT COUNT(*) as count FROM batches WHERE status = 'open'").get().count,
    batches_closed: db.prepare("SELECT COUNT(*) as count FROM batches WHERE status = 'closed'").get().count,
    suppression_count: db.prepare('SELECT COUNT(*) as count FROM suppression_list').get().count,
  };
}
