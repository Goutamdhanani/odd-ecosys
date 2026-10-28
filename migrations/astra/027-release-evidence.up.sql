-- X07/X08/X14/X15: additive, tenant-scoped durable bindings for the immutable launch evidence references.
-- Stable notice: apply after 026; never rewrite deployed 001-026 facts or this migration after release.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.launch_release_evidence (
  tenant_id uuid NOT NULL,
  launch_release_id uuid NOT NULL,
  calibration_artifact_id uuid,
  calibration_artifact_sha256 char(64) CHECK(calibration_artifact_sha256 IS NULL OR calibration_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  conformance_run_id uuid,
  conformance_summary_sha256 char(64) CHECK(conformance_summary_sha256 IS NULL OR conformance_summary_sha256 ~ '^[a-f0-9]{64}$'),
  validation_report_id uuid,
  validation_report_sha256 char(64) CHECK(validation_report_sha256 IS NULL OR validation_report_sha256 ~ '^[a-f0-9]{64}$'),
  outcome_report_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,launch_release_id),
  FOREIGN KEY(tenant_id,launch_release_id) REFERENCES astra.launch_releases(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,calibration_artifact_id) REFERENCES astra.learning_artifacts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,conformance_run_id) REFERENCES astra.conformance_runs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,validation_report_id) REFERENCES astra.launch_validation_reports(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,outcome_report_id) REFERENCES astra.bandit_evaluation_reports(tenant_id,id) ON DELETE RESTRICT,
  CHECK((calibration_artifact_id IS NULL)=(calibration_artifact_sha256 IS NULL)),
  CHECK((conformance_run_id IS NULL)=(conformance_summary_sha256 IS NULL)),
  CHECK((validation_report_id IS NULL)=(validation_report_sha256 IS NULL))
);

CREATE FUNCTION astra.guard_launch_release_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Launch evidence bindings are immutable and append-only.' USING ERRCODE='55000';
END $$;
CREATE TRIGGER launch_release_evidence_immutable BEFORE UPDATE OR DELETE ON astra.launch_release_evidence
  FOR EACH ROW EXECUTE FUNCTION astra.guard_launch_release_evidence_immutable();

CREATE FUNCTION astra.check_launch_release_evidence_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m jsonb;
BEGIN
  SELECT manifest INTO m FROM astra.launch_releases WHERE tenant_id=NEW.tenant_id AND id=NEW.launch_release_id;
  IF m IS NULL
    OR m #>> '{evidence,calibration,id}' IS DISTINCT FROM NEW.calibration_artifact_id::text
    OR m #>> '{evidence,calibration,artifactSha256}' IS DISTINCT FROM trim(NEW.calibration_artifact_sha256)
    OR m #>> '{evidence,conformance,id}' IS DISTINCT FROM NEW.conformance_run_id::text
    OR m #>> '{evidence,conformance,summarySha256}' IS DISTINCT FROM trim(NEW.conformance_summary_sha256)
    OR m #>> '{evidence,validation,id}' IS DISTINCT FROM NEW.validation_report_id::text
    OR m #>> '{evidence,validation,reportSha256}' IS DISTINCT FROM trim(NEW.validation_report_sha256)
    OR m #>> '{evidence,validation,outcomeReportId}' IS DISTINCT FROM NEW.outcome_report_id::text
  THEN RAISE EXCEPTION 'Launch evidence binding does not match the immutable release manifest.' USING ERRCODE='23514'; END IF;
  IF NEW.calibration_artifact_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM astra.learning_artifacts a JOIN astra.release_artifacts s ON(s.tenant_id,s.id)=(a.tenant_id,a.source_release_id)
      WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.calibration_artifact_id
      AND a.status='approved' AND a.artifact_sha256=NEW.calibration_artifact_sha256
      AND a.source_release_id=(m #>> '{sourceRelease,id}')::uuid AND a.source_dataset_id=(m #>> '{evaluation,datasetId}')::uuid
      AND s.status='approved_not_deployed' AND s.candidate_id=(m #>> '{evaluation,candidateId}')::uuid
      AND s.evaluation_run_id=(m #>> '{evaluation,runId}')::uuid
  ) THEN RAISE EXCEPTION 'Calibration reference is not an approved compatible artifact.' USING ERRCODE='23514'; END IF;
  IF NEW.conformance_run_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM astra.conformance_runs c WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.conformance_run_id
      AND c.state='completed' AND c.summary_sha256=NEW.conformance_summary_sha256
      AND (c.evaluation_binding #>> '{evaluationRun,id}')=(m #>> '{evaluation,runId}')
      AND (c.evaluation_binding #>> '{evaluationRun,snapshotSha256}')=(m #>> '{evaluation,snapshotSha256}')
      AND (c.evaluation_binding #>> '{dataset,id}')=(m #>> '{evaluation,datasetId}')
      AND (c.evaluation_binding #>> '{dataset,manifestSha256}')=(m #>> '{evaluation,datasetManifestSha256}')
      AND (c.evaluation_binding #>> '{candidate,id}')=(m #>> '{evaluation,candidateId}')
      AND (c.evaluation_binding #>> '{candidate,manifestSha256}')=(m #>> '{evaluation,candidateManifestSha256}')
  ) THEN RAISE EXCEPTION 'Conformance reference is not a completed durable run.' USING ERRCODE='23514'; END IF;
  IF NEW.validation_report_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM astra.launch_validation_reports v WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.validation_report_id
      AND v.report_sha256=NEW.validation_report_sha256
  ) THEN RAISE EXCEPTION 'Comparison reference does not match the persisted validation report.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER launch_release_evidence_binding_guard BEFORE INSERT ON astra.launch_release_evidence
  FOR EACH ROW EXECUTE FUNCTION astra.check_launch_release_evidence_binding();

ALTER TABLE astra.launch_release_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.launch_release_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY launch_release_evidence_owner_all ON astra.launch_release_evidence
  FOR ALL TO astra_owner USING(true) WITH CHECK(true);
CREATE POLICY launch_release_evidence_tenant_scope ON astra.launch_release_evidence
  FOR ALL TO astra_app,astra_worker
  USING(astra.context_allows(tenant_id)) WITH CHECK(astra.context_allows(tenant_id));
GRANT SELECT,INSERT ON astra.launch_release_evidence TO astra_app,astra_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.launch_release_evidence FROM PUBLIC,astra_app,astra_worker;
REVOKE ALL ON FUNCTION astra.guard_launch_release_evidence_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.check_launch_release_evidence_binding() FROM PUBLIC;

RESET ROLE;
COMMIT;
