-- S26/S29 and X06-X08: tenant-frozen evaluation inputs, independent labels,
-- deterministic offline runs, and a release record that never promotes live.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.eval_datasets (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  source_manifest jsonb NOT NULL CHECK(jsonb_typeof(source_manifest)='array'),
  source_manifest_sha256 char(64) NOT NULL CHECK(source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  label_rights jsonb NOT NULL CHECK(jsonb_typeof(label_rights)='object'),
  label_schema jsonb NOT NULL CHECK(jsonb_typeof(label_schema)='array'),
  split_policy jsonb NOT NULL CHECK(jsonb_typeof(split_policy)='object'),
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'frozen' CHECK(status='frozen'),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,name,manifest_sha256)
);
CREATE TABLE astra.eval_examples (
  tenant_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  example_key text NOT NULL CHECK(length(example_key) BETWEEN 1 AND 160),
  company_hash char(64) NOT NULL CHECK(company_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  split text NOT NULL CHECK(split IN ('development','validation','holdout')),
  input_packet jsonb NOT NULL CHECK(jsonb_typeof(input_packet)='object'),
  source_refs jsonb NOT NULL CHECK(jsonb_typeof(source_refs)='array'),
  subgroups jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(subgroups)='object'),
  input_sha256 char(64) NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,dataset_id,id), UNIQUE(tenant_id,dataset_id,example_key),
  FOREIGN KEY(tenant_id,dataset_id) REFERENCES astra.eval_datasets(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_eval_examples_split ON astra.eval_examples(tenant_id,dataset_id,split,company_hash,observed_at);

CREATE TABLE astra.eval_annotations (
  tenant_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  example_id uuid NOT NULL,
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
  annotated_by text NOT NULL CHECK(annotated_by ~ '^[1-9][0-9]{0,39}$'),
  annotated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,dataset_id,example_id,annotated_by),
  FOREIGN KEY(tenant_id,dataset_id,example_id) REFERENCES astra.eval_examples(tenant_id,dataset_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.eval_adjudications (
  tenant_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  example_id uuid NOT NULL,
  final_label text NOT NULL CHECK(length(final_label) BETWEEN 1 AND 80),
  adjudicated_by text NOT NULL CHECK(adjudicated_by ~ '^[1-9][0-9]{0,39}$'),
  annotation_agreement boolean,
  adjudicated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,dataset_id,example_id),
  FOREIGN KEY(tenant_id,dataset_id,example_id) REFERENCES astra.eval_examples(tenant_id,dataset_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.eval_candidates (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  version text NOT NULL CHECK(length(version) BETWEEN 1 AND 80),
  variant_id text NOT NULL CHECK(variant_id IN ('H0','H1','H2','H3')),
  strategy text NOT NULL CHECK(strategy IN ('constant_label','field_map','keyword_rules','abstain')),
  config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),
  allowed_labels jsonb NOT NULL CHECK(jsonb_typeof(allowed_labels)='array'),
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,name,version), UNIQUE(tenant_id,id,manifest_sha256)
);
CREATE TABLE astra.eval_scorers (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  version text NOT NULL CHECK(length(version) BETWEEN 1 AND 80),
  class_labels jsonb NOT NULL CHECK(jsonb_typeof(class_labels)='array'),
  critical_harm_labels jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(critical_harm_labels)='array'),
  abstain_label text,
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,name,version), UNIQUE(tenant_id,id,manifest_sha256)
);

CREATE TABLE astra.eval_runs (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  dataset_id uuid NOT NULL,
  scorer_id uuid NOT NULL,
  candidate_refs jsonb NOT NULL CHECK(jsonb_typeof(candidate_refs)='array'),
  budget jsonb NOT NULL CHECK(jsonb_typeof(budget)='object'),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  snapshot_sha256 char(64) NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  requested_by text NOT NULL CHECK(requested_by ~ '^[1-9][0-9]{0,39}$'),
  state text NOT NULL CHECK(state IN ('queued','running','completed','failed')),
  report jsonb CHECK(report IS NULL OR jsonb_typeof(report)='object'),
  report_sha256 char(64) CHECK(report_sha256 IS NULL OR report_sha256 ~ '^[a-f0-9]{64}$'),
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-zA-Z0-9_.:-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,dataset_id) REFERENCES astra.eval_datasets(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,scorer_id) REFERENCES astra.eval_scorers(tenant_id,id) ON DELETE RESTRICT,
  CHECK((state IN ('completed','failed'))=(completed_at IS NOT NULL)),
  CHECK((report IS NULL)=(report_sha256 IS NULL)),
  CHECK(state<>'completed' OR (report IS NOT NULL AND report_sha256 IS NOT NULL AND error_code IS NULL)),
  CHECK(state<>'failed' OR (report IS NULL AND report_sha256 IS NULL AND error_code IS NOT NULL))
);
CREATE INDEX astra_eval_runs_recent ON astra.eval_runs(tenant_id,created_at DESC);
CREATE TABLE astra.eval_run_results (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  variant_id text NOT NULL CHECK(variant_id IN ('H0','H1','H2','H3')),
  metrics jsonb NOT NULL CHECK(jsonb_typeof(metrics)='object'),
  elapsed_ms numeric(14,3) NOT NULL CHECK(elapsed_ms>=0),
  result_sha256 char(64) NOT NULL CHECK(result_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,run_id,candidate_id), UNIQUE(tenant_id,run_id,variant_id),
  FOREIGN KEY(tenant_id,run_id) REFERENCES astra.eval_runs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,candidate_id) REFERENCES astra.eval_candidates(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.release_artifacts (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  version text NOT NULL CHECK(length(version) BETWEEN 1 AND 80),
  candidate_id uuid NOT NULL,
  evaluation_run_id uuid NOT NULL,
  prior_stable_release_id uuid,
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  status text NOT NULL CHECK(status IN ('pending_approval','approved_not_deployed','rejected')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,name,version), UNIQUE(tenant_id,id,manifest_sha256),
  FOREIGN KEY(tenant_id,candidate_id) REFERENCES astra.eval_candidates(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,evaluation_run_id) REFERENCES astra.eval_runs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,prior_stable_release_id) REFERENCES astra.release_artifacts(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.release_approvals (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  release_id uuid NOT NULL,
  approval_role text NOT NULL CHECK(approval_role IN ('owner','reviewer')),
  decision text NOT NULL CHECK(decision IN ('approve','reject')),
  reason_code text NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 80),
  manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by text NOT NULL CHECK(approved_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,release_id,approval_role),
  FOREIGN KEY(tenant_id,release_id) REFERENCES astra.release_artifacts(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.release_rollbacks (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  from_release_id uuid NOT NULL,
  target_release_id uuid NOT NULL,
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  requested_by text NOT NULL CHECK(requested_by ~ '^[1-9][0-9]{0,39}$'),
  status text NOT NULL CHECK(status='recorded_not_deployed'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), CHECK(from_release_id<>target_release_id),
  FOREIGN KEY(tenant_id,from_release_id) REFERENCES astra.release_artifacts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,target_release_id) REFERENCES astra.release_artifacts(tenant_id,id) ON DELETE RESTRICT
);

-- Evaluation source/label/candidate/scorer facts are immutable; only run and
-- release lifecycle state changes are permitted through their state fields.
CREATE FUNCTION astra.guard_eval_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Frozen evaluation facts cannot be updated or deleted.' USING ERRCODE='55000';
END $$;
CREATE TRIGGER eval_datasets_immutable BEFORE UPDATE OR DELETE ON astra.eval_datasets FOR EACH ROW EXECUTE FUNCTION astra.guard_eval_immutable();
CREATE TRIGGER eval_examples_immutable BEFORE UPDATE OR DELETE ON astra.eval_examples FOR EACH ROW EXECUTE FUNCTION astra.guard_eval_immutable();
CREATE TRIGGER eval_annotations_immutable BEFORE UPDATE OR DELETE ON astra.eval_annotations FOR EACH ROW EXECUTE FUNCTION astra.guard_eval_immutable();
CREATE TRIGGER eval_adjudications_immutable BEFORE UPDATE OR DELETE ON astra.eval_adjudications FOR EACH ROW EXECUTE FUNCTION astra.guard_eval_immutable();
CREATE TRIGGER eval_candidates_immutable BEFORE UPDATE OR DELETE ON astra.eval_candidates FOR EACH ROW EXECUTE FUNCTION astra.guard_eval_immutable();
CREATE TRIGGER eval_scorers_immutable BEFORE UPDATE OR DELETE ON astra.eval_scorers FOR EACH ROW EXECUTE FUNCTION astra.guard_eval_immutable();
CREATE TRIGGER eval_run_results_immutable BEFORE UPDATE OR DELETE ON astra.eval_run_results FOR EACH ROW EXECUTE FUNCTION astra.guard_eval_immutable();
CREATE TRIGGER release_approvals_immutable BEFORE UPDATE OR DELETE ON astra.release_approvals FOR EACH ROW EXECUTE FUNCTION astra.guard_eval_immutable();
CREATE TRIGGER release_rollbacks_immutable BEFORE UPDATE OR DELETE ON astra.release_rollbacks FOR EACH ROW EXECUTE FUNCTION astra.guard_eval_immutable();

CREATE FUNCTION astra.guard_eval_run_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Evaluation runs are durable.' USING ERRCODE='55000'; END IF;
  IF (NEW.tenant_id,NEW.id,NEW.dataset_id,NEW.scorer_id,NEW.candidate_refs,NEW.budget,NEW.snapshot,
      NEW.snapshot_sha256,NEW.requested_by,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.id,OLD.dataset_id,OLD.scorer_id,OLD.candidate_refs,OLD.budget,OLD.snapshot,
      OLD.snapshot_sha256,OLD.requested_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Evaluation run identity and frozen references are immutable.' USING ERRCODE='55000';
  END IF;
  IF OLD.state NOT IN ('queued','running') OR NEW.state NOT IN ('queued','running','completed','failed')
     OR (OLD.state='queued' AND NEW.state NOT IN ('running','failed'))
     OR (OLD.state='running' AND NEW.state NOT IN ('completed','failed')) THEN
    RAISE EXCEPTION 'Evaluation run state transition is invalid.' USING ERRCODE='55000';
  END IF;
  IF OLD.report IS NOT NULL AND (NEW.report,NEW.report_sha256) IS DISTINCT FROM (OLD.report,OLD.report_sha256) THEN
    RAISE EXCEPTION 'Completed evaluation report is immutable.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER eval_runs_transition BEFORE UPDATE OR DELETE ON astra.eval_runs FOR EACH ROW EXECUTE FUNCTION astra.guard_eval_run_transition();

CREATE FUNCTION astra.guard_release_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Release artifacts are durable.' USING ERRCODE='55000'; END IF;
  IF (NEW.tenant_id,NEW.id,NEW.name,NEW.version,NEW.candidate_id,NEW.evaluation_run_id,NEW.prior_stable_release_id,NEW.manifest,
      NEW.manifest_sha256,NEW.created_by,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.id,OLD.name,OLD.version,OLD.candidate_id,OLD.evaluation_run_id,OLD.prior_stable_release_id,OLD.manifest,
      OLD.manifest_sha256,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Release artifact manifest is immutable.' USING ERRCODE='55000';
  END IF;
  IF OLD.status<>'pending_approval' OR NEW.status NOT IN ('approved_not_deployed','rejected') THEN
    RAISE EXCEPTION 'Release approval state transition is invalid.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_artifact_identity BEFORE UPDATE OR DELETE ON astra.release_artifacts FOR EACH ROW EXECUTE FUNCTION astra.guard_release_identity();

CREATE FUNCTION astra.guard_release_approval_independence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM astra.release_approvals a WHERE a.tenant_id=NEW.tenant_id AND a.release_id=NEW.release_id
    AND a.approval_role<>NEW.approval_role AND a.approved_by=NEW.approved_by) THEN
    RAISE EXCEPTION 'Owner and reviewer signoffs require different users.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_signoff_separation BEFORE INSERT ON astra.release_approvals FOR EACH ROW EXECUTE FUNCTION astra.guard_release_approval_independence();

DO $rls$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['eval_datasets','eval_examples','eval_annotations','eval_adjudications','eval_candidates','eval_scorers','eval_runs','eval_run_results','release_artifacts','release_approvals','release_rollbacks'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_owner USING (true) WITH CHECK (true)',tab||'_owner_all',tab);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))',tab||'_tenant_scope',tab);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON astra.%I TO astra_app,astra_worker',tab);
    EXECUTE format('REVOKE DELETE,TRUNCATE ON astra.%I FROM PUBLIC,astra_app,astra_worker',tab);
  END LOOP;
END
$rls$;
REVOKE ALL ON FUNCTION astra.guard_eval_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_eval_run_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_release_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_release_approval_independence() FROM PUBLIC;
RESET ROLE;
COMMIT;
