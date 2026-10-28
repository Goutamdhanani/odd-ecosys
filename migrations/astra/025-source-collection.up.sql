-- S09/S10 explicit, policy-gated remote source collection and untrusted discovery candidates.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.source_collection_jobs (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  job_type text NOT NULL CHECK(job_type IN ('fetch','search')),
  status text NOT NULL CHECK(status IN ('queued','running','completed','blocked','failed')),
  blocked_reason text CHECK(blocked_reason IS NULL OR blocked_reason IN ('remote_transport_disabled','source_rights_unknown_or_expired','s01_approval_unknown_or_expired','worker_unavailable')),
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{2,79}$'),
  request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
  approval_references jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(approval_references)='array' AND jsonb_array_length(approval_references)<=8),
  rights_record jsonb NOT NULL CHECK(jsonb_typeof(rights_record)='object'),
  source_id uuid,
  evidence_id uuid,
  result_count integer NOT NULL DEFAULT 0 CHECK(result_count BETWEEN 0 AND 1000),
  latest_run_id uuid,
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,id,job_type),
  FOREIGN KEY(tenant_id,source_id) REFERENCES astra.research_sources(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,evidence_id) REFERENCES astra.research_evidence(tenant_id,id) ON DELETE RESTRICT,
  CHECK((source_id IS NULL)=(evidence_id IS NULL)),
  CHECK((status IN ('completed','blocked','failed'))=(finished_at IS NOT NULL)),
  CHECK((status IN ('running','completed','failed') OR (status='blocked' AND latest_run_id IS NOT NULL))=(started_at IS NOT NULL)),
  CHECK((status='blocked')=(blocked_reason IS NOT NULL) OR (status='blocked' AND blocked_reason IS NULL AND error_code IS NOT NULL)),
  CHECK((status='failed')=(error_code IS NOT NULL) OR (status='failed' AND error_code IS NOT NULL))
);
CREATE INDEX source_collection_jobs_recent ON astra.source_collection_jobs(tenant_id,created_at DESC,id);
CREATE INDEX source_collection_jobs_queue ON astra.source_collection_jobs(status,created_at) WHERE status='queued';

CREATE TABLE astra.source_collection_runs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  job_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('started','completed','blocked','failed')),
  provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'),
  outcome jsonb CHECK(outcome IS NULL OR jsonb_typeof(outcome)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,id,job_id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES astra.source_collection_jobs(tenant_id,id) ON DELETE RESTRICT,
  CHECK((status='started')=(finished_at IS NULL)),
  CHECK((status='started')=(outcome IS NULL))
);
ALTER TABLE astra.source_collection_jobs ADD CONSTRAINT source_collection_job_run_fk
  FOREIGN KEY(tenant_id,latest_run_id,id) REFERENCES astra.source_collection_runs(tenant_id,id,job_id) ON DELETE RESTRICT;
CREATE INDEX source_collection_runs_job ON astra.source_collection_runs(tenant_id,job_id,created_at DESC);

CREATE TABLE astra.source_collection_observations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  job_id uuid NOT NULL,
  job_type text NOT NULL DEFAULT 'fetch' CHECK(job_type='fetch'),
  run_id uuid NOT NULL,
  normalized_domain text NOT NULL CHECK(length(normalized_domain) BETWEEN 1 AND 253),
  etag text CHECK(etag IS NULL OR length(etag)<=512),
  last_modified text CHECK(last_modified IS NULL OR length(last_modified)<=120),
  content_sha256 char(64) NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_id uuid NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('captured','not_modified','hash_unchanged')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,job_id,job_type) REFERENCES astra.source_collection_jobs(tenant_id,id,job_type) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,run_id,job_id) REFERENCES astra.source_collection_runs(tenant_id,id,job_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,evidence_id,content_sha256) REFERENCES astra.research_evidence(tenant_id,id,content_sha256) ON DELETE RESTRICT
);
CREATE INDEX source_collection_observations_domain ON astra.source_collection_observations(tenant_id,normalized_domain,observed_at DESC,id DESC);

CREATE TABLE astra.source_collection_candidates (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  job_id uuid NOT NULL,
  job_type text NOT NULL DEFAULT 'search' CHECK(job_type='search'),
  position integer NOT NULL CHECK(position BETWEEN 1 AND 30),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 280),
  canonical_domain text NOT NULL CHECK(length(canonical_domain) BETWEEN 1 AND 253),
  source_url text NOT NULL CHECK(length(source_url) BETWEEN 8 AND 2048),
  snippet text NOT NULL DEFAULT '' CHECK(length(snippet)<=600),
  engine text NOT NULL DEFAULT '' CHECK(length(engine)<=80),
  independence_key text NOT NULL CHECK(length(independence_key) BETWEEN 1 AND 300),
  lineage jsonb NOT NULL CHECK(jsonb_typeof(lineage)='object'),
  candidate_only boolean NOT NULL DEFAULT true CHECK(candidate_only),
  verified_contact boolean NOT NULL DEFAULT false CHECK(NOT verified_contact),
  source_content_untrusted boolean NOT NULL DEFAULT true CHECK(source_content_untrusted),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,job_id,canonical_domain),
  UNIQUE(tenant_id,job_id,position),
  FOREIGN KEY(tenant_id,job_id,job_type) REFERENCES astra.source_collection_jobs(tenant_id,id,job_type) ON DELETE RESTRICT
);
CREATE INDEX source_collection_candidates_domain ON astra.source_collection_candidates(tenant_id,canonical_domain,created_at DESC);

CREATE FUNCTION astra.guard_source_collection_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.tenant_id,NEW.id,NEW.job_type,NEW.request,NEW.approval_references,NEW.rights_record,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.job_type,OLD.request,OLD.approval_references,OLD.rights_record,OLD.created_by,OLD.created_at)
  THEN RAISE EXCEPTION 'Source collection request facts are immutable.' USING ERRCODE='55000'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status='queued' AND NEW.status IN ('running','blocked'))
    OR (OLD.status='running' AND NEW.status IN ('completed','blocked','failed')))
  THEN RAISE EXCEPTION 'Source collection job transition is invalid.' USING ERRCODE='55000'; END IF;
  IF OLD.latest_run_id IS NOT NULL AND NEW.latest_run_id IS DISTINCT FROM OLD.latest_run_id
  THEN RAISE EXCEPTION 'A source collection job run binding is immutable.' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_collection_job_guard BEFORE UPDATE OR DELETE ON astra.source_collection_jobs
  FOR EACH ROW EXECUTE FUNCTION astra.guard_source_collection_job();

CREATE FUNCTION astra.guard_source_collection_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.tenant_id,NEW.id,NEW.job_id,NEW.created_at,NEW.provenance)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.job_id,OLD.created_at,OLD.provenance)
    OR OLD.status<>'started' OR NEW.status NOT IN ('completed','blocked','failed') OR NEW.outcome IS NULL OR NEW.finished_at IS NULL
  THEN RAISE EXCEPTION 'Source collection run provenance is immutable and run completion is one-way.' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_collection_run_guard BEFORE UPDATE OR DELETE ON astra.source_collection_runs
  FOR EACH ROW EXECUTE FUNCTION astra.guard_source_collection_run();

CREATE FUNCTION astra.guard_source_collection_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Source discovery candidates are append-only untrusted observations.' USING ERRCODE='55000'; END $$;
CREATE TRIGGER source_collection_candidate_guard BEFORE UPDATE OR DELETE ON astra.source_collection_candidates
  FOR EACH ROW EXECUTE FUNCTION astra.guard_source_collection_candidate();
CREATE TRIGGER source_collection_observation_guard BEFORE UPDATE OR DELETE ON astra.source_collection_observations
  FOR EACH ROW EXECUTE FUNCTION astra.guard_source_collection_candidate();

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['source_collection_jobs','source_collection_runs','source_collection_candidates','source_collection_observations'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_owner USING(true) WITH CHECK(true)',tab||'_owner_all',tab);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING(astra.context_allows(tenant_id)) WITH CHECK(astra.context_allows(tenant_id))',tab||'_tenant_scope',tab);
    EXECUTE format('REVOKE ALL ON astra.%I FROM PUBLIC',tab);
  END LOOP;
END $$;
GRANT SELECT,INSERT ON astra.source_collection_jobs TO astra_app;
GRANT SELECT ON astra.source_collection_runs,astra.source_collection_candidates TO astra_app;
GRANT SELECT ON astra.source_collection_observations TO astra_app;
GRANT SELECT,INSERT,UPDATE ON astra.source_collection_jobs,astra.source_collection_runs TO astra_worker;
GRANT SELECT,INSERT ON astra.source_collection_candidates,astra.source_collection_observations TO astra_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.source_collection_jobs,astra.source_collection_runs,astra.source_collection_candidates,astra.source_collection_observations FROM PUBLIC,astra_app,astra_worker;
GRANT UPDATE(status,blocked_reason,error_code,source_id,evidence_id,result_count,latest_run_id,started_at,finished_at,updated_at)
  ON astra.source_collection_jobs TO astra_worker;
GRANT UPDATE(status,outcome,finished_at,updated_at) ON astra.source_collection_runs TO astra_worker;
REVOKE ALL ON FUNCTION astra.guard_source_collection_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_source_collection_run() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_source_collection_candidate() FROM PUBLIC;

RESET ROLE;
COMMIT;
