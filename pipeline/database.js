// ============================================================
//  ODD-ECOSYS Pipeline — SQLite Database Layer
//  Uses better-sqlite3 (synchronous, WAL mode)
//  Schema matches plan.md §16
// ============================================================

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { migrateMailboxCredentials } from './credential-vault.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tests and development workers must select a separate database before import.
const DB_PATH = process.env.ODD_DB_PATH
  ? path.resolve(process.env.ODD_DB_PATH)
  : path.join(__dirname, '..', 'data', 'pipeline.db');

let _db = null;

/**
 * Get the singleton database instance.
 * Initializes on first call.
 */
export function getDb() {
  if (!_db) {
    // Ensure data directory exists
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    _db = new Database(DB_PATH);

    // Performance & safety pragmas
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
    _db.pragma('secure_delete = ON');
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

    -- Durable workspace-wide outbound-send pause and its operator audit trail.
    CREATE TABLE IF NOT EXISTS sending_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
      reason TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by INTEGER,
      updated_by_role TEXT
    );
    INSERT OR IGNORE INTO sending_control(id, paused, reason) VALUES (1, 0, '');
    CREATE TABLE IF NOT EXISTS sending_control_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paused INTEGER NOT NULL CHECK (paused IN (0,1)),
      reason TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      actor_id INTEGER,
      actor_role TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sending_control_events_changed
      ON sending_control_events(changed_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS sending_schedule_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      timezone TEXT NOT NULL,
      start_hour INTEGER NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
      end_hour INTEGER NOT NULL CHECK (end_hour BETWEEN 1 AND 24),
      weekdays_only INTEGER NOT NULL CHECK (weekdays_only IN (0,1)),
      min_interval_ms INTEGER NOT NULL CHECK (min_interval_ms BETWEEN 0 AND 3600000),
      max_interval_ms INTEGER NOT NULL CHECK (max_interval_ms BETWEEN 0 AND 3600000),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by INTEGER,
      updated_by_role TEXT,
      CHECK (start_hour < end_hour),
      CHECK (min_interval_ms <= max_interval_ms)
    );
    CREATE TABLE IF NOT EXISTS sending_schedule_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_json TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      actor_id INTEGER,
      actor_role TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sending_schedule_events_changed
      ON sending_schedule_events(changed_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS imap_sync_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
      interval_minutes INTEGER NOT NULL DEFAULT 10 CHECK (interval_minutes BETWEEN 5 AND 60),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by INTEGER,
      updated_by_role TEXT
    );
    INSERT OR IGNORE INTO imap_sync_settings(id,enabled,interval_minutes) VALUES(1,0,10);
    CREATE TABLE IF NOT EXISTS imap_sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
      interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 5 AND 60),
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      actor_id INTEGER,
      actor_role TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_imap_sync_events_changed
      ON imap_sync_events(changed_at DESC,id DESC);

    -- F011 — restartable, bounded-memory CSV imports. Raw CSV is held only in
    -- a private per-database staging directory and removed when the job ends.
    CREATE TABLE IF NOT EXISTS contact_import_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
      request_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      expected_bytes INTEGER NOT NULL CHECK(expected_bytes BETWEEN 1 AND 104857600),
      upload_offset INTEGER NOT NULL DEFAULT 0,
      column_map_json TEXT NOT NULL,
      csv_headers_json TEXT NOT NULL DEFAULT '[]',
      source_sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','validating','queued','processing','completed','cancelled','failed')),
      row_cursor INTEGER NOT NULL DEFAULT 0,
      total_rows INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      invalid_count INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contact_import_jobs_batch
      ON contact_import_jobs(batch_id,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS contact_import_chunks (
      job_id INTEGER NOT NULL REFERENCES contact_import_jobs(id) ON DELETE CASCADE,
      byte_offset INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY(job_id,byte_offset)
    );
    CREATE TABLE IF NOT EXISTS contact_import_dedupe_keys (
      job_id INTEGER NOT NULL REFERENCES contact_import_jobs(id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL,
      PRIMARY KEY(job_id,dedupe_key)
    );
    CREATE TABLE IF NOT EXISTS contact_import_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES contact_import_jobs(id) ON DELETE CASCADE,
      row_number INTEGER NOT NULL,
      reason TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      UNIQUE(job_id,row_number)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_import_rejections_job
      ON contact_import_rejections(job_id,row_number);

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
      source_details TEXT,
      source_url TEXT,
      consent_recorded_at TEXT,
      consent_method TEXT,
      consent_evidence_url TEXT,
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
      discovered_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_batch ON leads(batch_id);
    CREATE INDEX IF NOT EXISTS idx_leads_dedup ON leads(normalized_domain, normalized_phone);

    -- F014a — typed custom fields for the current single local workspace.
    CREATE TABLE IF NOT EXISTS contact_field_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      field_key TEXT NOT NULL UNIQUE,
      field_type TEXT NOT NULL CHECK(field_type IN ('text','number','date','boolean','select')),
      required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0,1)),
      options_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS lead_custom_field_values (
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      field_id INTEGER NOT NULL REFERENCES contact_field_definitions(id) ON DELETE RESTRICT,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(lead_id,field_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_custom_field_value_field ON lead_custom_field_values(field_id,value_json);

    -- === Emails discovered per lead (a business can have >1) ===
    CREATE TABLE IF NOT EXISTS lead_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      email TEXT NOT NULL,
      source TEXT,
      verification_status TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      confidence_score INTEGER,
      is_catch_all INTEGER DEFAULT 0,
      is_role_account INTEGER DEFAULT 0,
      verified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lead_emails_lead ON lead_emails(lead_id);

    -- Operator-configured, official Meta Lead Ads connection. The Page token is
    -- encrypted by credential-vault.js before it is written here.
    CREATE TABLE IF NOT EXISTS lead_source_connections (
      provider TEXT PRIMARY KEY CHECK(provider IN ('meta_lead_ads')),
      page_id TEXT NOT NULL,
      graph_version TEXT NOT NULL,
      access_token_enc TEXT NOT NULL,
      webhook_app_secret_enc TEXT,
      webhook_verify_token_hash TEXT,
      webhook_page_subscribed_at TEXT,
      connection_status TEXT NOT NULL DEFAULT 'unverified' CHECK(connection_status IN ('unverified','verified')),
      last_test_at TEXT,
      last_import_at TEXT,
      rate_limit_until TEXT,
      rate_limit_recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(rate_limit_recovery_required IN (0,1)),
      rate_usage_json TEXT,
      rate_usage_observed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-provider external IDs make manually requested imports replay-safe.
    -- Raw Meta payloads and personal field data are deliberately not copied here.
    CREATE TABLE IF NOT EXISTS lead_source_records (
      provider TEXT NOT NULL CHECK(provider IN ('meta_lead_ads')),
      external_id TEXT NOT NULL,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      page_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      source_created_at TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(provider, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_source_records_lead
      ON lead_source_records(lead_id, provider);

    -- Opaque per-form cursor only (never a provider paging URL or credential).
    -- Saved after the matching contact/source-ID import commits successfully.
    CREATE TABLE IF NOT EXISTS meta_lead_form_cursors (
      page_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      after_cursor TEXT,
      has_more INTEGER NOT NULL DEFAULT 0 CHECK(has_more IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(page_id, form_id)
    );

    -- Separate opaque cursor for the operator-paged form catalog. Lead
    -- submission cursors stay isolated per form in meta_lead_form_cursors.
    CREATE TABLE IF NOT EXISTS meta_lead_form_list_cursors (
      page_id TEXT PRIMARY KEY,
      after_cursor TEXT,
      has_more INTEGER NOT NULL DEFAULT 0 CHECK(has_more IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- A form's operator-approved field mapping and destination batch are the
    -- minimum configuration needed to turn signed webhook notifications into
    -- contacts. The saved batch is revalidated as open for every import.
    CREATE TABLE IF NOT EXISTS meta_lead_form_settings (
      page_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
      field_map_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(page_id, form_id)
    );

    -- Store only non-PII routing IDs/status, never the raw webhook body or
    -- contact fields. Unique Page/form/lead identity makes Meta retries safe.
    CREATE TABLE IF NOT EXISTS meta_lead_webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      source_created_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','imported','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(page_id, form_id, lead_id)
    );
    CREATE INDEX IF NOT EXISTS idx_meta_lead_webhook_queue
      ON meta_lead_webhook_events(status, received_at, id);

    -- One explicitly requested public-website email scan per contact. A row
    -- reserves the attempt before network access so concurrent clicks cannot
    -- cause duplicate crawls. Discovered addresses remain unverified.
    CREATE TABLE IF NOT EXISTS lead_website_email_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('running','completed','blocked','failed','interrupted')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      page_count INTEGER NOT NULL DEFAULT 0,
      found_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      website_url TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lead_website_email_scans_status
      ON lead_website_email_scans(status, started_at);

    -- A 429 response pauses every future crawl of that host until the stored
    -- Retry-After time, including work queued by another job or after restart.
    CREATE TABLE IF NOT EXISTS website_host_cooldowns (
      hostname TEXT PRIMARY KEY,
      not_before TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lead_email_source_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_email_id INTEGER NOT NULL REFERENCES lead_emails(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      evidence_type TEXT NOT NULL DEFAULT 'website_html',
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_email_id, source_url)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_email_source_evidence_email
      ON lead_email_source_evidence(lead_email_id, observed_at DESC);

    -- Operator-triggered refresh generations retain each page outcome and
    -- preserve email presence history without replacing earlier observations.
    CREATE TABLE IF NOT EXISTS lead_website_email_refreshes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK(generation >= 1),
      website_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','blocked','failed','interrupted')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      page_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      UNIQUE(lead_id,generation)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_website_email_refreshes_lead
      ON lead_website_email_refreshes(lead_id,generation DESC);

    CREATE TABLE IF NOT EXISTS lead_website_email_refresh_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refresh_id INTEGER NOT NULL REFERENCES lead_website_email_refreshes(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      fetch_mode TEXT NOT NULL CHECK(fetch_mode IN ('http','rendered')),
      outcome TEXT NOT NULL CHECK(outcome IN ('fetched','blocked','unavailable','missing','unsupported')),
      content_hash TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(refresh_id,source_url,fetch_mode)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_website_email_refresh_pages_source
      ON lead_website_email_refresh_pages(source_url,fetch_mode,refresh_id DESC);

    CREATE TABLE IF NOT EXISTS lead_website_email_refresh_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refresh_id INTEGER NOT NULL REFERENCES lead_website_email_refreshes(id) ON DELETE CASCADE,
      lead_email_id INTEGER NOT NULL REFERENCES lead_emails(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      fetch_mode TEXT NOT NULL CHECK(fetch_mode IN ('http','rendered')),
      state TEXT NOT NULL CHECK(state IN ('present','not_present')),
      prior_content_hash TEXT,
      prior_raw_excerpt TEXT,
      prior_extractor_version TEXT,
      content_hash TEXT,
      raw_excerpt TEXT,
      extractor_version TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(refresh_id,lead_email_id,source_url,fetch_mode)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_website_email_refresh_observations_source
      ON lead_website_email_refresh_observations(lead_email_id,source_url,refresh_id DESC);

    -- Structured website contact-routing facts stay attached to the exact
    -- email/source observation that disclosed them (sales, support, etc.).
    CREATE TABLE IF NOT EXISTS lead_email_contact_point_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evidence_id INTEGER NOT NULL REFERENCES lead_email_source_evidence(id) ON DELETE CASCADE,
      contact_type TEXT,
      contact_name TEXT,
      contact_title TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lead_email_contact_point_evidence_source
      ON lead_email_contact_point_evidence(evidence_id,id);

    CREATE TABLE IF NOT EXISTS lead_profile_source_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      source_key TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      raw_excerpt TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id,source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_profile_source_evidence_lead
      ON lead_profile_source_evidence(lead_id,observed_at DESC);

    CREATE TABLE IF NOT EXISTS epch_directory_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
      source_id TEXT NOT NULL DEFAULT 'epch',
      source_url TEXT NOT NULL DEFAULT 'https://epch.in/member',
      status TEXT NOT NULL CHECK(status IN ('queued','running','pause_requested','paused','cancel_requested','cancelled','completed','partial','failed')),
      page_limit INTEGER NOT NULL DEFAULT 50,
      pages_completed INTEGER NOT NULL DEFAULT 0,
      records_seen INTEGER NOT NULL DEFAULT 0,
      businesses_created INTEGER NOT NULL DEFAULT 0,
      emails_created INTEGER NOT NULL DEFAULT 0,
      duplicates INTEGER NOT NULL DEFAULT 0,
      suppressed_emails_skipped INTEGER NOT NULL DEFAULT 0,
      current_page_url TEXT,
      next_page_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      error_code TEXT,
      retry_after_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_epch_directory_jobs_status
      ON epch_directory_jobs(status,created_at DESC);
    CREATE TABLE IF NOT EXISTS epch_directory_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES epch_directory_jobs(id) ON DELETE CASCADE,
      page_url TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','blocked','skipped')),
      record_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT,
      error_code TEXT,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(job_id,page_url)
    );
    CREATE INDEX IF NOT EXISTS idx_epch_directory_pages_status
      ON epch_directory_pages(job_id,status,page_number);
    CREATE TABLE IF NOT EXISTS epch_directory_businesses (
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
      business_key TEXT NOT NULL,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(batch_id,business_key)
    );
    CREATE TABLE IF NOT EXISTS epch_directory_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES epch_directory_jobs(id) ON DELETE CASCADE,
      page_id INTEGER NOT NULL REFERENCES epch_directory_pages(id) ON DELETE CASCADE,
      record_key TEXT NOT NULL,
      lead_id INTEGER REFERENCES leads(id) ON DELETE RESTRICT,
      contact_person_name TEXT,
      contact_title TEXT,
      emails_json TEXT NOT NULL DEFAULT '[]',
      source_url TEXT NOT NULL,
      raw_excerpt TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('imported','duplicate','suppressed_email','invalid')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(job_id,record_key)
    );
    CREATE INDEX IF NOT EXISTS idx_epch_directory_records_job
      ON epch_directory_records(job_id,status,id);

    -- Durable single-worker website discovery. Network work is at-least-once;
    -- unique job/lead rows and idempotent evidence writes prevent duplicate
    -- business/email associations after a process restart.
    CREATE TABLE IF NOT EXISTS website_discovery_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK(status IN ('queued','running','pause_requested','paused','cancel_requested','cancelled','completed','partial','failed')),
      source TEXT NOT NULL DEFAULT 'website_seed',
      task_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_website_discovery_jobs_status
      ON website_discovery_jobs(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS website_discovery_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES website_discovery_jobs(id) ON DELETE CASCADE,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
      canonical_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','blocked','failed','skipped','cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      error_code TEXT,
      found_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(job_id, lead_id),
      UNIQUE(job_id, canonical_url)
    );
    CREATE INDEX IF NOT EXISTS idx_website_discovery_tasks_status
      ON website_discovery_tasks(job_id, status, id);

    -- ALL-LEAD-019 — operator-configured SearXNG discovery. Search responses
    -- are minimized to inspectable public result fields; provider credentials
    -- are encrypted and candidate imports remain separate from search.
    CREATE TABLE IF NOT EXISTS lead_search_provider_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      endpoint_url TEXT NOT NULL,
      api_token_enc TEXT,
      last_request_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS lead_search_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
      parent_job_id INTEGER REFERENCES lead_search_jobs(id) ON DELETE SET NULL,
      root_job_id INTEGER REFERENCES lead_search_jobs(id) ON DELETE SET NULL,
      page_number INTEGER NOT NULL DEFAULT 1 CHECK(page_number >= 1),
      provider TEXT NOT NULL DEFAULT 'searxng',
      query TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
      result_count INTEGER NOT NULL DEFAULT 0,
      rejected_result_count INTEGER NOT NULL DEFAULT 0,
      has_more INTEGER NOT NULL DEFAULT 0 CHECK(has_more IN (0,1)),
      next_page_number INTEGER,
      elapsed_ms INTEGER,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lead_search_jobs_batch
      ON lead_search_jobs(batch_id,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS lead_search_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES lead_search_jobs(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      website_url TEXT NOT NULL,
      canonical_domain TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      engine TEXT NOT NULL DEFAULT '',
      imported_lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      imported_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(job_id,canonical_domain)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_search_results_job
      ON lead_search_results(job_id,position,id);

    -- === User-managed contact lists ===
    CREATE TABLE IF NOT EXISTS contact_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contact_lists_status ON contact_lists(status, name);

    CREATE TABLE IF NOT EXISTS contact_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      filters_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contact_segments_name ON contact_segments(name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS contact_list_members (
      list_id INTEGER NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (list_id, lead_id)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_list_members_lead ON contact_list_members(lead_id, list_id);

    -- === Contact tags ===
    CREATE TABLE IF NOT EXISTS contact_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contact_tags_status ON contact_tags(status, name);

    CREATE TABLE IF NOT EXISTS lead_contact_tags (
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES contact_tags(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (lead_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_contact_tags_tag ON lead_contact_tags(tag_id, lead_id);

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
    CREATE TABLE IF NOT EXISTS mailbox_rotation_state (
      pool_key TEXT NOT NULL,
      mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      current_weight INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (pool_key, mailbox_id)
    );
    CREATE TABLE IF NOT EXISTS imap_sync_mailbox_state (
      mailbox_id INTEGER PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
      last_attempt_at TEXT,
      last_success_at TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      last_fetched INTEGER,
      last_imported INTEGER,
      last_duplicates INTEGER,
      last_skipped INTEGER,
      last_cursor_uid INTEGER
    );
    -- A calendar ramp never grants campaign-send access by itself. This row is
    -- written only after an owner/admin reviews real SMTP and Inbox evidence.
    CREATE TABLE IF NOT EXISTS mailbox_warmup_reviews (
      mailbox_id INTEGER PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('approved','held')),
      policy_version TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      reviewed_by INTEGER,
      reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    -- Durable per-request AI usage. Prompts and response bodies are deliberately
    -- excluded; unknown tokens/rates stay NULL instead of being reconstructed.
    CREATE TABLE IF NOT EXISTS ai_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL CHECK (provider IN ('ollama','bedrock')),
      operation TEXT NOT NULL,
      model_id TEXT NOT NULL,
      region TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
      input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
      usage_source TEXT,
      provider_request_id TEXT,
      error_code TEXT,
      rate_card_id TEXT,
      rate_card_source TEXT,
      rate_card_effective_from TEXT,
      rate_card_retrieved_at TEXT,
      input_usd_per_million REAL,
      output_usd_per_million REAL,
      cost_usd REAL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_events_started ON ai_usage_events(started_at,id);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_events_provider_operation ON ai_usage_events(provider,operation,status);

    -- === Campaigns & sends ===
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sequence_step INTEGER DEFAULT 1,
      template_ref TEXT
    );

    -- Immutable, content-addressed configuration captured at first successful queue.
    CREATE TABLE IF NOT EXISTS campaign_launches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version > 0),
      snapshot_json TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (campaign_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_launches_campaign ON campaign_launches(campaign_id, version);
    CREATE TRIGGER IF NOT EXISTS campaign_launches_no_update
      BEFORE UPDATE ON campaign_launches
      BEGIN SELECT RAISE(ABORT, 'campaign launch snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_launches_no_delete
      BEFORE DELETE ON campaign_launches
      BEGIN SELECT RAISE(ABORT, 'campaign launch snapshots are immutable'); END;

    CREATE TABLE IF NOT EXISTS campaign_senders (
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (campaign_id, mailbox_id)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_senders_mailbox ON campaign_senders(mailbox_id, campaign_id);

    -- === Persisted campaign sequence drafts (execution is separately gated) ===
    CREATE TABLE IF NOT EXISTS campaign_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      delay_days INTEGER NOT NULL DEFAULT 0 CHECK (delay_days BETWEEN 0 AND 365),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (campaign_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_steps_order ON campaign_steps(campaign_id, position);

    CREATE TABLE IF NOT EXISTS campaign_step_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      step_id INTEGER NOT NULL REFERENCES campaign_steps(id) ON DELETE CASCADE,
      variant_key TEXT NOT NULL CHECK (variant_key IN ('A', 'B', 'C', 'D')),
      allocation_pct INTEGER NOT NULL CHECK (allocation_pct BETWEEN 0 AND 100),
      subject_line TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (step_id, variant_key)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_step_variants_step ON campaign_step_variants(step_id, variant_key);

    CREATE TABLE IF NOT EXISTS campaign_copy_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      subject_line TEXT NOT NULL,
      body_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_copy_templates_status ON campaign_copy_templates(status,name);

    CREATE TABLE IF NOT EXISTS verification_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','running','cancel_requested','cancelled','completed','interrupted','failed')),
      total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
      processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0 AND processed <= total),
      deliverable INTEGER NOT NULL DEFAULT 0 CHECK (deliverable >= 0),
      risky INTEGER NOT NULL DEFAULT 0 CHECK (risky >= 0),
      undeliverable INTEGER NOT NULL DEFAULT 0 CHECK (undeliverable >= 0),
      current_lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      cancel_requested_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_verification_jobs_batch ON verification_jobs(batch_id,id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_jobs_single_active ON verification_jobs((1))
      WHERE status IN ('queued','running','cancel_requested');

    CREATE TABLE IF NOT EXISTS qualification_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','running','cancel_requested','cancelled','completed','interrupted','failed')),
      total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
      processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0 AND processed <= total),
      failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
      status_counts_json TEXT NOT NULL DEFAULT '{}',
      current_lead_ids_json TEXT NOT NULL DEFAULT '[]',
      scoring_profile_version INTEGER,
      scoring_profile_hash TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      cancel_requested_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_qualification_jobs_batch ON qualification_jobs(batch_id,id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_qualification_jobs_single_active ON qualification_jobs((1))
      WHERE status IN ('queued','running','cancel_requested');

    CREATE TABLE IF NOT EXISTS sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      mailbox_id INTEGER REFERENCES mailboxes(id),
      campaign_id INTEGER REFERENCES campaigns(id),
      campaign_launch_id INTEGER REFERENCES campaign_launches(id) ON DELETE RESTRICT,
      personalization_id INTEGER REFERENCES personalizations(id),
      campaign_step_id INTEGER REFERENCES campaign_steps(id) ON DELETE SET NULL,
      variant TEXT,
      subject_snapshot TEXT,
      body_snapshot TEXT,
      in_reply_to_message_id TEXT,
      scheduled_at TEXT,
      sent_at TEXT,
      status TEXT DEFAULT 'scheduled'
    );
    CREATE TABLE IF NOT EXISTS send_capacity_reservations (
      send_id INTEGER PRIMARY KEY REFERENCES sends(id) ON DELETE CASCADE,
      mailbox_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      capacity_day TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved','accepted','uncertain','released')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_send_capacity_mailbox_day
      ON send_capacity_reservations(mailbox_id,capacity_day,state);
    CREATE INDEX IF NOT EXISTS idx_send_capacity_domain_day
      ON send_capacity_reservations(domain,capacity_day,state);
    CREATE TABLE IF NOT EXISTS mailbox_send_pacing (
      mailbox_id INTEGER PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
      next_allowed_at TEXT NOT NULL,
      last_send_id INTEGER REFERENCES sends(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      send_id INTEGER REFERENCES sends(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_email ON unsubscribe_tokens(email, created_at);

    -- === Immutable recipient snapshots for campaign audiences ===
    CREATE TABLE IF NOT EXISTS campaign_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      source_list_id INTEGER REFERENCES contact_lists(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
      defer_until TEXT,
      defer_manual_review INTEGER NOT NULL DEFAULT 0 CHECK (defer_manual_review IN (0,1)),
      enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (campaign_id, lead_id)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_enrollments_status ON campaign_enrollments(campaign_id, status, enrolled_at);
    CREATE INDEX IF NOT EXISTS idx_campaign_enrollments_lead ON campaign_enrollments(lead_id, campaign_id);

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

    CREATE TABLE IF NOT EXISTS reply_inbox_state (
      event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      read_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
      source_details TEXT,
      source_url TEXT,
      consent_recorded_at TEXT,
      consent_method TEXT,
      consent_evidence_url TEXT,
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
      campaign_launch_id INTEGER,
      personalization_id INTEGER,
      campaign_step_id INTEGER,
      variant TEXT,
      subject_snapshot TEXT,
      body_snapshot TEXT,
      in_reply_to_message_id TEXT,
      scheduled_at TEXT,
      sent_at TEXT,
      status TEXT
    );
  `);

  // ── Migrations for existing databases ────────────────────
  runMigrations(db);


  // Preserve pre-audience queued and completed campaign recipients. This only
  // snapshots relationships already represented by real send rows.
  db.exec(`
    INSERT OR IGNORE INTO campaign_enrollments (campaign_id, lead_id, status)
    SELECT DISTINCT campaign_id, lead_id, 'active'
    FROM sends
    WHERE campaign_id IS NOT NULL AND lead_id IS NOT NULL
      AND status IN ('scheduled', 'sent', 'failed')
  `);

  // Preserve sender behavior for legacy campaigns from real transport records.
  db.exec(`
    INSERT OR IGNORE INTO campaign_senders (campaign_id, mailbox_id)
    SELECT DISTINCT campaign_id, mailbox_id
    FROM sends
    WHERE campaign_id IS NOT NULL AND mailbox_id IS NOT NULL
  `);

  // When a private key is configured, upgrade legacy mailbox passwords and
  // complete key rotations before any API or worker can use mailbox rows.
  migrateMailboxCredentials(db);

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
    { column: 'last_fetched', table: 'imap_sync_mailbox_state', sql: 'ALTER TABLE imap_sync_mailbox_state ADD COLUMN last_fetched INTEGER' },
    { column: 'last_imported', table: 'imap_sync_mailbox_state', sql: 'ALTER TABLE imap_sync_mailbox_state ADD COLUMN last_imported INTEGER' },
    { column: 'last_duplicates', table: 'imap_sync_mailbox_state', sql: 'ALTER TABLE imap_sync_mailbox_state ADD COLUMN last_duplicates INTEGER' },
    { column: 'last_skipped', table: 'imap_sync_mailbox_state', sql: 'ALTER TABLE imap_sync_mailbox_state ADD COLUMN last_skipped INTEGER' },
    { column: 'last_cursor_uid', table: 'imap_sync_mailbox_state', sql: 'ALTER TABLE imap_sync_mailbox_state ADD COLUMN last_cursor_uid INTEGER' },
    { column: 'csv_headers_json', table: 'contact_import_jobs', sql: `ALTER TABLE contact_import_jobs ADD COLUMN csv_headers_json TEXT NOT NULL DEFAULT '[]'` },
    // F014c — operator-entered source and consent evidence metadata. Existing rows
    // remain null, which means no evidence was recorded; it does not infer consent.
    { column: 'source_details', table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN source_details TEXT' },
    { column: 'source_url', table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN source_url TEXT' },
    { column: 'consent_recorded_at', table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN consent_recorded_at TEXT' },
    { column: 'consent_method', table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN consent_method TEXT' },
    { column: 'consent_evidence_url', table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN consent_evidence_url TEXT' },
    { column: 'source_details', table: 'leads_archive', sql: 'ALTER TABLE leads_archive ADD COLUMN source_details TEXT' },
    { column: 'source_url', table: 'leads_archive', sql: 'ALTER TABLE leads_archive ADD COLUMN source_url TEXT' },
    { column: 'consent_recorded_at', table: 'leads_archive', sql: 'ALTER TABLE leads_archive ADD COLUMN consent_recorded_at TEXT' },
    { column: 'consent_method', table: 'leads_archive', sql: 'ALTER TABLE leads_archive ADD COLUMN consent_method TEXT' },
    { column: 'consent_evidence_url', table: 'leads_archive', sql: 'ALTER TABLE leads_archive ADD COLUMN consent_evidence_url TEXT' },
    // Stage 4
    { column: 'screenshot_path',  table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN screenshot_path TEXT' },
    { column: 'site_checked_at',  table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN site_checked_at TEXT' },
    { column: 'confidence',       table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN confidence INTEGER' },
    { column: 'site_reasons_json',table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN site_reasons_json TEXT' },
    // Stage 5 — lead_emails enrichment
    { column: 'is_disposable',    table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN is_disposable INTEGER DEFAULT 0' },
    { column: 'is_free_provider', table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN is_free_provider INTEGER DEFAULT 0' },
    { column: 'is_primary',       table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0' },
    { column: 'confidence_score', table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN confidence_score INTEGER' },
    { column: 'mx_host',          table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN mx_host TEXT' },
    { column: 'smtp_code',        table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN smtp_code INTEGER' },
    { column: 'smtp_response',    table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN smtp_response TEXT' },
    { column: 'verification_json',table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN verification_json TEXT' },
    { column: 'retry_count',      table: 'lead_emails', sql: 'ALTER TABLE lead_emails ADD COLUMN retry_count INTEGER DEFAULT 0' },
    // Stage 6/7 — campaigns & sends enrichment
    { column: 'status',            table: 'campaigns',   sql: "ALTER TABLE campaigns ADD COLUMN status TEXT DEFAULT 'draft'" },
    { column: 'batch_ids_json',    table: 'campaigns',   sql: 'ALTER TABLE campaigns ADD COLUMN batch_ids_json TEXT' },
    { column: 'created_at',        table: 'campaigns',   sql: "ALTER TABLE campaigns ADD COLUMN created_at TEXT DEFAULT (datetime('now'))" },
    { column: 'error_message',     table: 'sends',       sql: 'ALTER TABLE sends ADD COLUMN error_message TEXT' },
    { column: 'campaign_launch_id', table: 'sends', sql: 'ALTER TABLE sends ADD COLUMN campaign_launch_id INTEGER REFERENCES campaign_launches(id) ON DELETE RESTRICT' },
    { column: 'campaign_step_id', table: 'sends', sql: 'ALTER TABLE sends ADD COLUMN campaign_step_id INTEGER REFERENCES campaign_steps(id) ON DELETE SET NULL' },
    { column: 'subject_snapshot', table: 'sends', sql: 'ALTER TABLE sends ADD COLUMN subject_snapshot TEXT' },
    { column: 'body_snapshot', table: 'sends', sql: 'ALTER TABLE sends ADD COLUMN body_snapshot TEXT' },
    { column: 'in_reply_to_message_id', table: 'sends', sql: 'ALTER TABLE sends ADD COLUMN in_reply_to_message_id TEXT' },
    { column: 'campaign_step_id', table: 'sends_archive', sql: 'ALTER TABLE sends_archive ADD COLUMN campaign_step_id INTEGER' },
    { column: 'campaign_launch_id', table: 'sends_archive', sql: 'ALTER TABLE sends_archive ADD COLUMN campaign_launch_id INTEGER' },
    { column: 'subject_snapshot', table: 'sends_archive', sql: 'ALTER TABLE sends_archive ADD COLUMN subject_snapshot TEXT' },
    { column: 'body_snapshot', table: 'sends_archive', sql: 'ALTER TABLE sends_archive ADD COLUMN body_snapshot TEXT' },
    { column: 'in_reply_to_message_id', table: 'sends_archive', sql: 'ALTER TABLE sends_archive ADD COLUMN in_reply_to_message_id TEXT' },
    { column: 'defer_until', table: 'campaign_enrollments', sql: 'ALTER TABLE campaign_enrollments ADD COLUMN defer_until TEXT' },
    { column: 'defer_manual_review', table: 'campaign_enrollments', sql: 'ALTER TABLE campaign_enrollments ADD COLUMN defer_manual_review INTEGER NOT NULL DEFAULT 0' },
    // Mailbox SMTP & Real DNS columns
    { column: 'smtp_host',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN smtp_host TEXT' },
    { column: 'smtp_port',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN smtp_port INTEGER DEFAULT 587' },
    { column: 'smtp_user',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN smtp_user TEXT' },
    { column: 'smtp_pass',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN smtp_pass TEXT' },
    { column: 'smtp_secure',       table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN smtp_secure INTEGER DEFAULT 0' },
    // F043 — mailbox receive configuration. IMAP is TLS-only; 993 is implicit
    // TLS and 143 requires STARTTLS before credentials are sent.
    { column: 'imap_host',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN imap_host TEXT' },
    { column: 'imap_port',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN imap_port INTEGER DEFAULT 993' },
    { column: 'imap_user',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN imap_user TEXT' },
    { column: 'imap_pass',         table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN imap_pass TEXT' },
    { column: 'imap_secure',       table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN imap_secure INTEGER NOT NULL DEFAULT 1' },
    { column: 'imap_aliases_json', table: 'mailboxes',   sql: "ALTER TABLE mailboxes ADD COLUMN imap_aliases_json TEXT NOT NULL DEFAULT '[]'" },
    // F065 — durable IMAP incremental cursor. UIDVALIDITY is text because
    // IMAP exposes it as an unsigned 32-bit value and clients may parse BigInt.
    { column: 'imap_uid_validity', table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN imap_uid_validity TEXT' },
    { column: 'imap_last_uid',     table: 'mailboxes',   sql: 'ALTER TABLE mailboxes ADD COLUMN imap_last_uid INTEGER NOT NULL DEFAULT 0' },
    { column: 'imap_backfill_before_uid', table: 'mailboxes', sql: 'ALTER TABLE mailboxes ADD COLUMN imap_backfill_before_uid INTEGER NOT NULL DEFAULT 0' },
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
    // ALL-LEAD-007/008 — encrypted webhook App Secret and one-way verify token;
    // record the last successful Page subscription request without storing API responses.
    { column: 'webhook_app_secret_enc', table: 'lead_source_connections', sql: 'ALTER TABLE lead_source_connections ADD COLUMN webhook_app_secret_enc TEXT' },
    { column: 'webhook_verify_token_hash', table: 'lead_source_connections', sql: 'ALTER TABLE lead_source_connections ADD COLUMN webhook_verify_token_hash TEXT' },
    { column: 'webhook_page_subscribed_at', table: 'lead_source_connections', sql: 'ALTER TABLE lead_source_connections ADD COLUMN webhook_page_subscribed_at TEXT' },
    // ALL-LEAD-053 — sanitized provider usage and durable manual recovery gate.
    { column: 'rate_limit_until', table: 'lead_source_connections', sql: 'ALTER TABLE lead_source_connections ADD COLUMN rate_limit_until TEXT' },
    { column: 'rate_limit_recovery_required', table: 'lead_source_connections', sql: 'ALTER TABLE lead_source_connections ADD COLUMN rate_limit_recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(rate_limit_recovery_required IN (0,1))' },
    { column: 'rate_usage_json', table: 'lead_source_connections', sql: 'ALTER TABLE lead_source_connections ADD COLUMN rate_usage_json TEXT' },
    { column: 'rate_usage_observed_at', table: 'lead_source_connections', sql: 'ALTER TABLE lead_source_connections ADD COLUMN rate_usage_observed_at TEXT' },
    // ALL-LEAD-012 — durable website extraction progress and inspectable
    // deterministic evidence. Legacy evidence remains intact with null excerpt/hash.
    { column: 'attempt_count', table: 'lead_website_email_scans', sql: 'ALTER TABLE lead_website_email_scans ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1' },
    { column: 'visited_paths_json', table: 'lead_website_email_scans', sql: "ALTER TABLE lead_website_email_scans ADD COLUMN visited_paths_json TEXT NOT NULL DEFAULT '[]'" },
    { column: 'pending_paths_json', table: 'lead_website_email_scans', sql: "ALTER TABLE lead_website_email_scans ADD COLUMN pending_paths_json TEXT NOT NULL DEFAULT '[]'" },
    { column: 'rendered_paths_json', table: 'lead_website_email_scans', sql: "ALTER TABLE lead_website_email_scans ADD COLUMN rendered_paths_json TEXT NOT NULL DEFAULT '[]'" },
    { column: 'retry_after_at', table: 'lead_website_email_scans', sql: 'ALTER TABLE lead_website_email_scans ADD COLUMN retry_after_at TEXT' },
    { column: 'website_url', table: 'lead_website_email_scans', sql: 'ALTER TABLE lead_website_email_scans ADD COLUMN website_url TEXT' },
    { column: 'raw_excerpt', table: 'lead_email_source_evidence', sql: 'ALTER TABLE lead_email_source_evidence ADD COLUMN raw_excerpt TEXT' },
    { column: 'content_hash', table: 'lead_email_source_evidence', sql: 'ALTER TABLE lead_email_source_evidence ADD COLUMN content_hash TEXT' },
    { column: 'extractor_version', table: 'lead_email_source_evidence', sql: 'ALTER TABLE lead_email_source_evidence ADD COLUMN extractor_version TEXT' },
    { column: 'contact_person_name', table: 'leads', sql: 'ALTER TABLE leads ADD COLUMN contact_person_name TEXT' },
    { column: 'contact_person_name', table: 'leads_archive', sql: 'ALTER TABLE leads_archive ADD COLUMN contact_person_name TEXT' },
    { column: 'attempt_count', table: 'epch_directory_jobs', sql: 'ALTER TABLE epch_directory_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0' },
    { column: 'source_id', table: 'epch_directory_jobs', sql: "ALTER TABLE epch_directory_jobs ADD COLUMN source_id TEXT NOT NULL DEFAULT 'epch'" },
    { column: 'retry_after_at', table: 'epch_directory_jobs', sql: 'ALTER TABLE epch_directory_jobs ADD COLUMN retry_after_at TEXT' },
    { column: 'contact_title', table: 'epch_directory_records', sql: 'ALTER TABLE epch_directory_records ADD COLUMN contact_title TEXT' },
    // ALL-LEAD-020 — each explicit SearXNG results page is a separate durable child job.
    { column: 'has_more', table: 'lead_search_jobs', sql: 'ALTER TABLE lead_search_jobs ADD COLUMN has_more INTEGER NOT NULL DEFAULT 0 CHECK(has_more IN (0,1))' },
    { column: 'next_page_number', table: 'lead_search_jobs', sql: 'ALTER TABLE lead_search_jobs ADD COLUMN next_page_number INTEGER' },
    { column: 'parent_job_id', table: 'lead_search_jobs', sql: 'ALTER TABLE lead_search_jobs ADD COLUMN parent_job_id INTEGER REFERENCES lead_search_jobs(id) ON DELETE SET NULL' },
    { column: 'root_job_id', table: 'lead_search_jobs', sql: 'ALTER TABLE lead_search_jobs ADD COLUMN root_job_id INTEGER REFERENCES lead_search_jobs(id) ON DELETE SET NULL' },
    { column: 'page_number', table: 'lead_search_jobs', sql: 'ALTER TABLE lead_search_jobs ADD COLUMN page_number INTEGER NOT NULL DEFAULT 1 CHECK(page_number >= 1)' },
    { column: 'page_number', table: 'lead_search_results', sql: 'ALTER TABLE lead_search_results ADD COLUMN page_number INTEGER NOT NULL DEFAULT 1' },
  ];

  for (const m of migrations) {
    try {
      const info = db.prepare(`PRAGMA table_info(${m.table})`).all();
      if (!info.some(col => col.name === m.column)) {
        db.exec(m.sql);
      }
    } catch { /* Column might already exist */ }
  }

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sends_campaign_step_lead
    ON sends(campaign_step_id, lead_id) WHERE campaign_step_id IS NOT NULL`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS sends_launch_snapshot_immutable
    BEFORE UPDATE OF campaign_id,campaign_launch_id,lead_id,mailbox_id,personalization_id,
      campaign_step_id,variant,subject_snapshot,body_snapshot,in_reply_to_message_id ON sends
    WHEN OLD.campaign_launch_id IS NOT NULL AND (
      OLD.campaign_id IS NOT NEW.campaign_id
      OR OLD.campaign_launch_id IS NOT NEW.campaign_launch_id
      OR OLD.lead_id IS NOT NEW.lead_id
      OR OLD.mailbox_id IS NOT NEW.mailbox_id
      OR OLD.personalization_id IS NOT NEW.personalization_id
      OR OLD.campaign_step_id IS NOT NEW.campaign_step_id
      OR OLD.variant IS NOT NEW.variant
      OR OLD.subject_snapshot IS NOT NEW.subject_snapshot
      OR OLD.body_snapshot IS NOT NEW.body_snapshot
      OR OLD.in_reply_to_message_id IS NOT NEW.in_reply_to_message_id
    )
    BEGIN SELECT RAISE(ABORT, 'launched send content and version binding are immutable'); END`);
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
