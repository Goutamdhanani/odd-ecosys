-- X02/X03 bounded local runtime and fenced execution attempts.
-- This is additive: existing workflow rows remain readable and their old
-- checkpoints remain in place until a new runtime attempt replaces them.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.workflow_attempts (
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  lease_token_sha256 char(64) NOT NULL CHECK (lease_token_sha256 ~ '^[a-f0-9]{64}$'),
  runtime_version text NOT NULL CHECK (runtime_version = 'astra-runtime/1.0.0'),
  migration_compatibility integer NOT NULL CHECK (migration_compatibility = 9),
  context_hash char(64) NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
  policy_refs jsonb NOT NULL CHECK (jsonb_typeof(policy_refs)='array'),
  evidence_refs jsonb NOT NULL CHECK (jsonb_typeof(evidence_refs)='array'),
  usage_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(usage_refs)='array'),
  checkpoint_version text CHECK (checkpoint_version IS NULL OR checkpoint_version='astra-runtime-checkpoint/1.0.0'),
  checkpoint jsonb CHECK (checkpoint IS NULL OR jsonb_typeof(checkpoint)='object'),
  canonical_progress_hash char(64) CHECK (canonical_progress_hash IS NULL OR canonical_progress_hash ~ '^[a-f0-9]{64}$'),
  novelty_hash char(64) CHECK (novelty_hash IS NULL OR novelty_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('running','checkpointed','completed','manual_review','cancelled','fenced')),
  started_at timestamptz NOT NULL DEFAULT now(),
  checkpointed_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id,workflow_id,attempt),
  FOREIGN KEY (tenant_id,workflow_id) REFERENCES astra.workflows(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_workflow_attempts_recent ON astra.workflow_attempts(tenant_id,workflow_id,attempt DESC);
ALTER TABLE astra.workflow_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.workflow_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_attempt_owner_all ON astra.workflow_attempts FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY workflow_attempt_scope ON astra.workflow_attempts FOR ALL TO astra_app,astra_worker
  USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id));
GRANT SELECT,INSERT,UPDATE ON astra.workflow_attempts TO astra_app,astra_worker;
REVOKE DELETE,TRUNCATE ON astra.workflow_attempts FROM PUBLIC,astra_app,astra_worker;
CREATE FUNCTION astra.guard_workflow_attempt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Workflow attempt references cannot be deleted.' USING ERRCODE='55000'; END IF;
  IF (NEW.tenant_id,NEW.workflow_id,NEW.attempt,NEW.lease_token_sha256,NEW.runtime_version,NEW.migration_compatibility,
      NEW.context_hash,NEW.policy_refs,NEW.evidence_refs,NEW.started_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.workflow_id,OLD.attempt,OLD.lease_token_sha256,OLD.runtime_version,OLD.migration_compatibility,
      OLD.context_hash,OLD.policy_refs,OLD.evidence_refs,OLD.started_at) THEN
    RAISE EXCEPTION 'Workflow attempt identity and pinned references are immutable.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER astra_workflow_attempt_identity_guard BEFORE UPDATE OR DELETE ON astra.workflow_attempts
  FOR EACH ROW EXECUTE FUNCTION astra.guard_workflow_attempt_identity();
REVOKE ALL ON FUNCTION astra.guard_workflow_attempt_identity() FROM PUBLIC;

RESET ROLE;
COMMIT;
