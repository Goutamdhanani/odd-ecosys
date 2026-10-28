-- X08: tenant-scoped, explicit one-shot application conformance evidence.
-- Synthetic preview only; this migration never creates fixtures or enables transport.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.conformance_runs (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
  request_sha256 char(64) NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  case_manifest_version text NOT NULL CHECK(length(case_manifest_version) BETWEEN 1 AND 80),
  case_manifest_sha256 char(64) NOT NULL CHECK(case_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  component_hashes jsonb NOT NULL CHECK(jsonb_typeof(component_hashes)='object'),
  evaluation_binding jsonb CHECK(evaluation_binding IS NULL OR jsonb_typeof(evaluation_binding)='object'),
  consent jsonb NOT NULL CHECK(jsonb_typeof(consent)='object'
    AND consent->>'syntheticDatasetConsent'='true'
    AND consent->'tenantRights'->>'basis'='synthetic_fixture'
    AND consent->'tenantRights'->>'attested'='true'),
  requested_by text NOT NULL CHECK(requested_by ~ '^[1-9][0-9]{0,39}$'),
  state text NOT NULL CHECK(state IN ('queued','running','completed','failed')),
  summary jsonb CHECK(summary IS NULL OR jsonb_typeof(summary)='object'),
  summary_sha256 char(64) CHECK(summary_sha256 IS NULL OR summary_sha256 ~ '^[a-f0-9]{64}$'),
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,idempotency_key),
  CHECK((state IN ('completed','failed'))=(completed_at IS NOT NULL)),
  CHECK((summary IS NULL)=(summary_sha256 IS NULL)),
  CHECK(state<>'completed' OR (summary IS NOT NULL AND summary_sha256 IS NOT NULL AND error_code IS NULL)),
  CHECK(state<>'failed' OR (summary IS NULL AND summary_sha256 IS NULL AND error_code IS NOT NULL)),
  CHECK(state NOT IN ('running','completed','failed') OR started_at IS NOT NULL)
);
CREATE INDEX astra_conformance_runs_recent ON astra.conformance_runs(tenant_id,created_at DESC);

CREATE TABLE astra.conformance_case_results (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  case_id text NOT NULL CHECK(case_id IN (
    'source_instruction_read_only_harness','unregistered_side_effect_tool_rejected','source_rights_expiry_denied',
    'cross_tenant_resource_rejected','stale_lease_fence_rejected','duplicate_workflow_idempotency',
    'opt_out_suppression_before_model','transport_effect_receipt')),
  case_version text NOT NULL CHECK(length(case_version) BETWEEN 1 AND 80),
  status text NOT NULL CHECK(status IN ('passed','failed','unknown','not_instrumented')),
  assertions jsonb NOT NULL CHECK(jsonb_typeof(assertions)='array'),
  observations jsonb NOT NULL CHECK(jsonb_typeof(observations)='object'),
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  receipt_sha256 char(64) NOT NULL CHECK(receipt_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,run_id,case_id),
  FOREIGN KEY(tenant_id,run_id) REFERENCES astra.conformance_runs(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_conformance_results_recent ON astra.conformance_case_results(tenant_id,run_id,created_at,case_id);

CREATE FUNCTION astra.guard_conformance_run_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Conformance runs are durable.' USING ERRCODE='55000'; END IF;
  IF (NEW.tenant_id,NEW.id,NEW.idempotency_key,NEW.request_sha256,NEW.case_manifest_version,NEW.case_manifest_sha256,
      NEW.component_hashes,NEW.evaluation_binding,NEW.consent,NEW.requested_by,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.id,OLD.idempotency_key,OLD.request_sha256,OLD.case_manifest_version,OLD.case_manifest_sha256,
      OLD.component_hashes,OLD.evaluation_binding,OLD.consent,OLD.requested_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Conformance run identity and frozen references are immutable.' USING ERRCODE='55000';
  END IF;
  IF OLD.state NOT IN ('queued','running') OR NEW.state NOT IN ('queued','running','completed','failed')
     OR (OLD.state='queued' AND NEW.state NOT IN ('running','failed'))
     OR (OLD.state='running' AND NEW.state NOT IN ('completed','failed')) THEN
    RAISE EXCEPTION 'Conformance run state transition is invalid.' USING ERRCODE='55000';
  END IF;
  IF OLD.summary IS NOT NULL AND (NEW.summary,NEW.summary_sha256) IS DISTINCT FROM (OLD.summary,OLD.summary_sha256) THEN
    RAISE EXCEPTION 'Conformance terminal summary is immutable.' USING ERRCODE='55000';
  END IF;
  IF NEW.state='completed' AND NEW.error_code IS NOT NULL THEN
    RAISE EXCEPTION 'Completed conformance run cannot carry an error code.' USING ERRCODE='55000';
  END IF;
  IF NEW.state='failed' AND NEW.error_code IS NULL THEN
    RAISE EXCEPTION 'Failed conformance run requires a bounded error code.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER astra_conformance_run_transition_guard BEFORE UPDATE OR DELETE ON astra.conformance_runs
  FOR EACH ROW EXECUTE FUNCTION astra.guard_conformance_run_transition();

CREATE FUNCTION astra.guard_conformance_case_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Conformance case receipts are append-only.' USING ERRCODE='55000';
END $$;
CREATE TRIGGER astra_conformance_case_receipt_guard BEFORE UPDATE OR DELETE ON astra.conformance_case_results
  FOR EACH ROW EXECUTE FUNCTION astra.guard_conformance_case_immutable();
CREATE FUNCTION astra.guard_conformance_case_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM astra.conformance_runs r
      WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.run_id AND r.state='running') THEN
    RAISE EXCEPTION 'Conformance case receipts may be appended only while their run is running.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER astra_conformance_case_insert_guard BEFORE INSERT ON astra.conformance_case_results
  FOR EACH ROW EXECUTE FUNCTION astra.guard_conformance_case_insert();

ALTER TABLE astra.conformance_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.conformance_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY conformance_runs_owner_all ON astra.conformance_runs
  FOR ALL TO astra_owner USING(true) WITH CHECK(true);
CREATE POLICY conformance_runs_tenant_scope ON astra.conformance_runs
  FOR ALL TO astra_app,astra_worker
  USING(astra.context_allows(tenant_id)) WITH CHECK(astra.context_allows(tenant_id));

ALTER TABLE astra.conformance_case_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.conformance_case_results FORCE ROW LEVEL SECURITY;
CREATE POLICY conformance_results_owner_all ON astra.conformance_case_results
  FOR ALL TO astra_owner USING(true) WITH CHECK(true);
CREATE POLICY conformance_results_tenant_scope ON astra.conformance_case_results
  FOR ALL TO astra_app,astra_worker
  USING(astra.context_allows(tenant_id)) WITH CHECK(astra.context_allows(tenant_id));

GRANT SELECT,INSERT ON astra.conformance_runs TO astra_app;
GRANT SELECT,INSERT,UPDATE ON astra.conformance_runs TO astra_worker;
GRANT SELECT ON astra.conformance_case_results TO astra_app;
GRANT SELECT,INSERT ON astra.conformance_case_results TO astra_worker;
REVOKE DELETE,TRUNCATE ON astra.conformance_runs,astra.conformance_case_results FROM PUBLIC,astra_app,astra_worker;
REVOKE ALL ON FUNCTION astra.guard_conformance_run_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_conformance_case_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_conformance_case_insert() FROM PUBLIC;

RESET ROLE;
COMMIT;
