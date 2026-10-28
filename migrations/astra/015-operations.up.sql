BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.operational_telemetry (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  kind text NOT NULL CHECK(kind IN ('task.started','task.completed','task.failed','decision.recorded','queue.observed','usage.observed','dispatcher.blocked','dispatcher.outcome','incident.opened','recovery.requested','recovery.receipt')),
  task_id uuid,
  decision_id uuid,
  canonical_fact_id uuid,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=4096),
  payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,task_id) REFERENCES astra.workflows(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,decision_id) REFERENCES astra.decisions(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_operational_telemetry_time ON astra.operational_telemetry(tenant_id,occurred_at DESC,id DESC);
CREATE INDEX astra_operational_telemetry_task ON astra.operational_telemetry(tenant_id,task_id,occurred_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX astra_operational_telemetry_decision ON astra.operational_telemetry(tenant_id,decision_id,occurred_at DESC) WHERE decision_id IS NOT NULL;

CREATE TABLE astra.operational_kill_switches (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK(scope IN ('tenant','campaign','mailbox')),
  scope_id uuid NOT NULL,
  enabled boolean NOT NULL,
  reason_code text NOT NULL CHECK(reason_code ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  updated_by text NOT NULL CHECK(updated_by ~ '^[1-9][0-9]{0,39}$'),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,scope,scope_id),
  CHECK((scope='tenant' AND scope_id='00000000-0000-0000-0000-000000000000'::uuid) OR (scope<>'tenant' AND scope_id<>'00000000-0000-0000-0000-000000000000'::uuid))
);

CREATE TABLE astra.operational_incidents (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  incident_code text NOT NULL CHECK(incident_code ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  severity text NOT NULL CHECK(severity IN ('low','medium','high','critical')),
  summary_code text NOT NULL CHECK(summary_code ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved')),
  opened_by text NOT NULL CHECK(opened_by ~ '^[1-9][0-9]{0,39}$'),
  opened_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  resolved_by text,
  resolved_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  CHECK((state='open' AND resolved_at IS NULL) OR (state='resolved' AND resolved_at IS NOT NULL))
);

CREATE TABLE astra.recovery_requests (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  incident_id uuid,
  operation text NOT NULL CHECK(operation IN ('backup_restore','restore_drill','backup_verify')),
  request_code text NOT NULL CHECK(request_code ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','recorded','succeeded','failed')),
  requested_by text NOT NULL CHECK(requested_by ~ '^[1-9][0-9]{0,39}$'),
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  receipt_code text CHECK(receipt_code IS NULL OR receipt_code ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  receipt_by text,
  receipt_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,incident_id) REFERENCES astra.operational_incidents(tenant_id,id) ON DELETE RESTRICT,
  CHECK((state='prepared' AND receipt_at IS NULL) OR (state<>'prepared' AND receipt_at IS NOT NULL))
);

CREATE TABLE astra.engagement_privacy_permissions (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  campaign_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  reason_code text NOT NULL CHECK(reason_code ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  updated_by text NOT NULL CHECK(updated_by ~ '^[1-9][0-9]{0,39}$'),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,campaign_id),
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES astra.campaigns(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.engagement_tracking_tokens (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  campaign_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  token_sha256 char(64) NOT NULL CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK(kind IN ('pixel','redirect')),
  enabled boolean NOT NULL DEFAULT false,
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,token_sha256),
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES astra.campaigns(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,recipient_id) REFERENCES astra.research_identity_candidates(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_tracking_token_lookup ON astra.engagement_tracking_tokens(tenant_id,token_sha256);

CREATE TABLE astra.engagement_events (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  tracking_token_id uuid NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('delivered','open','click','bounce','reply','unsubscribe')),
  diagnostic text NOT NULL CHECK(diagnostic IN ('human','proxy','scanner','unknown')),
  provider_event_id text CHECK(provider_event_id IS NULL OR provider_event_id ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  occurred_at timestamptz NOT NULL,
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,tracking_token_id) REFERENCES astra.engagement_tracking_tokens(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX astra_engagement_provider_event_unique ON astra.engagement_events(tenant_id,provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX astra_engagement_event_token_type ON astra.engagement_events(tenant_id,tracking_token_id,event_type,diagnostic,occurred_at DESC);

DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['operational_telemetry','operational_kill_switches','operational_incidents','recovery_requests','engagement_privacy_permissions','engagement_tracking_tokens','engagement_events'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_owner USING(true) WITH CHECK(true)',tab||'_owner_all',tab);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING(astra.context_allows(tenant_id)) WITH CHECK(astra.context_allows(tenant_id))',tab||'_tenant_scope',tab);
  END LOOP;
END $$;

GRANT SELECT,INSERT ON astra.operational_telemetry TO astra_app,astra_worker;
GRANT SELECT,INSERT,UPDATE ON astra.operational_kill_switches TO astra_app,astra_worker;
GRANT SELECT,INSERT,UPDATE ON astra.operational_incidents,astra.recovery_requests,astra.engagement_privacy_permissions TO astra_app,astra_worker;
GRANT SELECT,INSERT ON astra.engagement_tracking_tokens,astra.engagement_events TO astra_app,astra_worker;
REVOKE DELETE,TRUNCATE ON astra.operational_telemetry,astra.operational_kill_switches,astra.operational_incidents,astra.recovery_requests,astra.engagement_privacy_permissions,astra.engagement_tracking_tokens,astra.engagement_events FROM PUBLIC,astra_app,astra_worker;
REVOKE UPDATE ON astra.operational_telemetry,astra.engagement_tracking_tokens,astra.engagement_events FROM PUBLIC,astra_app,astra_worker;

RESET ROLE;
COMMIT;
