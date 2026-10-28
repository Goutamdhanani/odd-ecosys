-- S12 Opportunity Radar: tenant-scoped source watches and immutable signal provenance.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.radar_watches (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  source_id uuid NOT NULL,
  baseline_evidence_id uuid,
  baseline_sha256 char(64),
  baseline_semantic_sha256 char(64),
  cadence_minutes integer NOT NULL DEFAULT 1440 CHECK (cadence_minutes BETWEEN 60 AND 10080),
  min_cadence_minutes integer NOT NULL DEFAULT 360 CHECK (min_cadence_minutes BETWEEN 60 AND 10080),
  max_cadence_minutes integer NOT NULL DEFAULT 10080 CHECK (max_cadence_minutes BETWEEN 60 AND 10080),
  max_observations_per_day integer NOT NULL DEFAULT 24 CHECK (max_observations_per_day BETWEEN 1 AND 48),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  next_due_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz,
  last_observation_state text NOT NULL DEFAULT 'never_observed' CHECK (last_observation_state IN ('never_observed','no_change','cosmetic_change','semantic_change','source_outage','deleted','rights_expired')),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,source_id),
  FOREIGN KEY (tenant_id,source_id) REFERENCES astra.research_sources(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,baseline_evidence_id,baseline_sha256) REFERENCES astra.research_evidence(tenant_id,id,content_sha256) ON DELETE RESTRICT,
  CHECK (min_cadence_minutes <= cadence_minutes AND cadence_minutes <= max_cadence_minutes),
  CHECK ((baseline_evidence_id IS NULL) = (baseline_sha256 IS NULL)),
  CHECK (baseline_semantic_sha256 IS NULL OR baseline_semantic_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE INDEX astra_radar_watches_due ON astra.radar_watches(tenant_id,status,next_due_at);
CREATE INDEX astra_radar_watches_source ON astra.radar_watches(tenant_id,source_id);

CREATE TABLE astra.radar_watch_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  watch_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created','paused','resumed','refresh_requested','observed','policy_blocked','source_outage','deleted')),
  observation_state text CHECK (observation_state IS NULL OR observation_state IN ('no_change','cosmetic_change','semantic_change','source_outage','deleted','rights_expired')),
  evidence_id uuid,
  content_sha256 char(64) CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),
  semantic_sha256 char(64) CHECK (semantic_sha256 IS NULL OR semantic_sha256 ~ '^[a-f0-9]{64}$'),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance)='object'),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,watch_id) REFERENCES astra.radar_watches(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,evidence_id,content_sha256) REFERENCES astra.research_evidence(tenant_id,id,content_sha256) ON DELETE RESTRICT,
  CHECK ((evidence_id IS NULL) = (content_sha256 IS NULL))
);
CREATE INDEX astra_radar_watch_events_recent ON astra.radar_watch_events(tenant_id,watch_id,created_at DESC);

CREATE TABLE astra.radar_events (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  event_fingerprint char(64) NOT NULL CHECK (event_fingerprint ~ '^[a-f0-9]{64}$'),
  semantic_sha256 char(64) NOT NULL CHECK (semantic_sha256 ~ '^[a-f0-9]{64}$'),
  normalized_summary text NOT NULL CHECK (length(normalized_summary) BETWEEN 1 AND 1000),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  source_count integer NOT NULL DEFAULT 0 CHECK (source_count >= 0),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,event_fingerprint)
);
CREATE INDEX astra_radar_events_fresh ON astra.radar_events(tenant_id,expires_at DESC);

CREATE TABLE astra.radar_event_sources (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  watch_id uuid NOT NULL,
  source_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  exact_excerpt text NOT NULL CHECK (length(exact_excerpt) BETWEEN 1 AND 1000),
  independence_key text NOT NULL CHECK (length(independence_key) BETWEEN 1 AND 253),
  captured_at timestamptz NOT NULL,
  rights_checked_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,event_id,watch_id,evidence_id),
  FOREIGN KEY (tenant_id,event_id) REFERENCES astra.radar_events(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,watch_id,source_id) REFERENCES astra.radar_watches(tenant_id,id,source_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,evidence_id,content_sha256) REFERENCES astra.research_evidence(tenant_id,id,content_sha256) ON DELETE RESTRICT
);
CREATE INDEX astra_radar_event_sources_source ON astra.radar_event_sources(tenant_id,source_id,event_id);

CREATE TABLE astra.radar_signals (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  watch_id uuid NOT NULL,
  source_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  semantic_sha256 char(64) NOT NULL CHECK (semantic_sha256 ~ '^[a-f0-9]{64}$'),
  event_id uuid,
  signal_type text NOT NULL CHECK (signal_type IN ('semantic_change','source_outage','deleted')),
  title text NOT NULL CHECK (length(title) <= 500),
  exact_excerpt text NOT NULL CHECK (length(exact_excerpt) BETWEEN 1 AND 1000),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance)='object'),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  source_content_untrusted boolean NOT NULL DEFAULT true CHECK (source_content_untrusted),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,watch_id,source_id) REFERENCES astra.radar_watches(tenant_id,id,source_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,evidence_id,content_sha256) REFERENCES astra.research_evidence(tenant_id,id,content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,event_id) REFERENCES astra.radar_events(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_radar_signals_fresh ON astra.radar_signals(tenant_id,expires_at DESC,observed_at DESC);
CREATE INDEX astra_radar_signals_watch ON astra.radar_signals(tenant_id,watch_id,observed_at DESC);

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['radar_watches','radar_watch_events','radar_events','radar_event_sources','radar_signals'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_owner USING (true) WITH CHECK (true)',t||'_owner_all',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))',t||'_tenant_scope',t);
    EXECUTE format('REVOKE ALL ON astra.%I FROM PUBLIC',t);
  END LOOP;
END
$rls$;
GRANT SELECT,INSERT,UPDATE ON astra.radar_watches TO astra_app,astra_worker;
GRANT SELECT,INSERT ON astra.radar_watch_events,astra.radar_events,astra.radar_event_sources,astra.radar_signals TO astra_app,astra_worker;

CREATE FUNCTION astra.radar_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Radar provenance records are append-only.' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION astra.radar_append_only_guard() FROM PUBLIC;
DO $immutable$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['radar_watch_events','radar_events','radar_event_sources','radar_signals'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON astra.%I FOR EACH ROW EXECUTE FUNCTION astra.radar_append_only_guard()',t||'_append_only',t);
  END LOOP;
END
$immutable$;

RESET ROLE;
COMMIT;
