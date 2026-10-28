-- Durable, immutable links from the singular Astra workflow to existing
-- canonical generation and connector jobs. This table never stores prompts.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.domain_harness_bindings (
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('generation','connector')),
  domain_job_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('verification','drafting','reply_classification')),
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  evidence_hash char(64) NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  policy_hash char(64) NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,workflow_id),
  UNIQUE (tenant_id,source_kind,domain_job_id),
  FOREIGN KEY (tenant_id,workflow_id) REFERENCES astra.workflows(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((source_kind='generation' AND purpose IN ('drafting','reply_classification'))
      OR (source_kind='connector' AND purpose='verification'))
);
CREATE INDEX astra_domain_harness_bindings_job ON astra.domain_harness_bindings(tenant_id,domain_job_id,created_at DESC);

CREATE FUNCTION astra.guard_domain_harness_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked astra.workflows%ROWTYPE;
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Domain harness bindings are immutable.' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Domain harness bindings are immutable.' USING ERRCODE='55000'; END IF;
  SELECT * INTO linked FROM astra.workflows w WHERE w.tenant_id=NEW.tenant_id AND w.id=NEW.workflow_id;
  IF NOT FOUND OR linked.task->>'purpose' IS DISTINCT FROM NEW.purpose
    OR linked.task->'runRef'->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text
    OR linked.task->'runRef'->>'recordId' IS DISTINCT FROM NEW.domain_job_id::text
    OR linked.task->'versionPins'->>'domainJobKind' IS DISTINCT FROM NEW.source_kind
    OR linked.task->'versionPins'->>'domainJobId' IS DISTINCT FROM NEW.domain_job_id::text
    OR linked.task->'versionPins'->>'inputHash' IS DISTINCT FROM btrim(NEW.input_hash)
    OR linked.task->'versionPins'->>'evidenceHash' IS DISTINCT FROM btrim(NEW.evidence_hash)
    OR linked.task->'versionPins'->>'policyHash' IS DISTINCT FROM btrim(NEW.policy_hash) THEN
    RAISE EXCEPTION 'Workflow task does not match the immutable domain job binding.' USING ERRCODE='23514';
  END IF;
  IF NEW.source_kind='generation' AND NOT EXISTS (
    SELECT 1 FROM astra.generation_jobs g WHERE g.tenant_id=NEW.tenant_id AND g.id=NEW.domain_job_id
      AND g.state='queued' AND g.input_hash=btrim(NEW.input_hash) AND g.evidence_hash=btrim(NEW.evidence_hash)
      AND ((NEW.purpose='drafting' AND g.task='campaign_generation') OR (NEW.purpose='reply_classification' AND g.task='reply_classification'))
  ) THEN RAISE EXCEPTION 'Generation job does not match the pinned workflow task.' USING ERRCODE='23514'; END IF;
  IF NEW.source_kind='connector' AND NOT EXISTS (
    SELECT 1 FROM astra.connector_jobs j JOIN astra.connector_configs c ON (c.tenant_id,c.id)=(j.tenant_id,j.connector_id)
    WHERE j.tenant_id=NEW.tenant_id AND j.id=NEW.domain_job_id AND j.state='queued' AND j.job_type='verify_candidate' AND c.provider='reacher'
  ) THEN RAISE EXCEPTION 'Verification job does not match the pinned workflow task.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER astra_domain_harness_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON astra.domain_harness_bindings
  FOR EACH ROW EXECUTE FUNCTION astra.guard_domain_harness_binding();
CREATE TRIGGER astra_domain_harness_binding_no_truncate BEFORE TRUNCATE ON astra.domain_harness_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION astra.guard_domain_harness_binding();

ALTER TABLE astra.domain_harness_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.domain_harness_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY domain_harness_bindings_owner_all ON astra.domain_harness_bindings
  FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY domain_harness_bindings_tenant_scope ON astra.domain_harness_bindings
  FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id));
REVOKE ALL ON astra.domain_harness_bindings FROM PUBLIC;
GRANT SELECT,INSERT ON astra.domain_harness_bindings TO astra_app,astra_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.domain_harness_bindings FROM PUBLIC,astra_app,astra_worker;
REVOKE ALL ON FUNCTION astra.guard_domain_harness_binding() FROM PUBLIC;
RESET ROLE;
COMMIT;
