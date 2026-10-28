-- Bounded tenant learning, allocation, offline optimizer protocol and private skills.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.learning_artifacts (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  version text NOT NULL CHECK(length(version) BETWEEN 1 AND 80),
  source_dataset_id uuid NOT NULL,
  source_release_id uuid NOT NULL,
  artifact jsonb NOT NULL CHECK(jsonb_typeof(artifact)='object'),
  artifact_sha256 char(64) NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','approved','revoked')),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  promoted_by text CHECK(promoted_by IS NULL OR promoted_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  promoted_at timestamptz,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,name,version),
  FOREIGN KEY(tenant_id,source_dataset_id) REFERENCES astra.eval_datasets(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,source_release_id) REFERENCES astra.release_artifacts(tenant_id,id) ON DELETE RESTRICT,
  CHECK((status='approved')=(promoted_at IS NOT NULL AND promoted_by IS NOT NULL))
);
CREATE TABLE astra.learning_reviews (
  tenant_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  reviewer_id text NOT NULL CHECK(reviewer_id ~ '^[1-9][0-9]{0,39}$'),
  decision text NOT NULL CHECK(decision IN ('approve','reject')),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 240),
  artifact_sha256 char(64) NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,artifact_id,reviewer_id),
  FOREIGN KEY(tenant_id,artifact_id) REFERENCES astra.learning_artifacts(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.allocation_plans (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE astra.learning_optimizer_jobs (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  dataset_id uuid NOT NULL,
  candidate_prompt text NOT NULL CHECK(length(candidate_prompt)<=12000),
  budget jsonb NOT NULL CHECK(jsonb_typeof(budget)='object'),
  state text NOT NULL CHECK(state IN ('blocked','prepared','completed','failed')),
  diagnostic text NOT NULL CHECK(length(diagnostic)<=500),
  requested_by text NOT NULL CHECK(requested_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,dataset_id) REFERENCES astra.eval_datasets(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.skills (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  version text NOT NULL CHECK(length(version) BETWEEN 1 AND 80),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 12000),
  scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object'),
  license text NOT NULL CHECK(length(license) BETWEEN 1 AND 200),
  provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'),
  provenance_sha256 char(64) NOT NULL CHECK(provenance_sha256 ~ '^[a-f0-9]{64}$'),
  test_manifest jsonb NOT NULL CHECK(jsonb_typeof(test_manifest)='object'),
  evaluation_run_id uuid NOT NULL,
  manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN ('candidate','evaluating','approved','canary','active','revoked')),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  updated_by text CHECK(updated_by IS NULL OR updated_by ~ '^[1-9][0-9]{0,39}$'),
  transition_reason text CHECK(transition_reason IS NULL OR length(transition_reason)<=240),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,name,version),
  FOREIGN KEY(tenant_id,evaluation_run_id) REFERENCES astra.eval_runs(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX learning_artifacts_approved ON astra.learning_artifacts(tenant_id,status,created_at DESC);
CREATE INDEX astra_skills_resolve ON astra.skills(tenant_id,status,name,version);

CREATE FUNCTION astra.guard_learning_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.tenant_id,NEW.id,NEW.name,NEW.version,NEW.source_dataset_id,NEW.source_release_id,NEW.artifact,NEW.artifact_sha256,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.name,OLD.version,OLD.source_dataset_id,OLD.source_release_id,OLD.artifact,OLD.artifact_sha256,OLD.created_by,OLD.created_at)
    OR NOT ((OLD.status='pending_review' AND NEW.status IN ('pending_review','approved')) OR (OLD.status=NEW.status))
    OR (OLD.status='approved' AND (NEW.promoted_by,NEW.promoted_at) IS DISTINCT FROM (OLD.promoted_by,OLD.promoted_at))
    OR (OLD.status='pending_review' AND NEW.status='pending_review' AND (NEW.promoted_by,NEW.promoted_at) IS DISTINCT FROM (OLD.promoted_by,OLD.promoted_at))
  THEN RAISE EXCEPTION 'Learning artifact facts are immutable.' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER learning_artifact_guard BEFORE UPDATE OR DELETE ON astra.learning_artifacts FOR EACH ROW EXECUTE FUNCTION astra.guard_learning_artifact();
CREATE FUNCTION astra.guard_learning_skill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.tenant_id,NEW.id,NEW.name,NEW.version,NEW.body,NEW.scope,NEW.license,NEW.provenance,NEW.provenance_sha256,NEW.test_manifest,NEW.evaluation_run_id,NEW.manifest_sha256,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.name,OLD.version,OLD.body,OLD.scope,OLD.license,OLD.provenance,OLD.provenance_sha256,OLD.test_manifest,OLD.evaluation_run_id,OLD.manifest_sha256,OLD.created_by,OLD.created_at)
    OR OLD.status='revoked' OR NOT ((OLD.status=NEW.status) OR (OLD.status='candidate' AND NEW.status IN ('evaluating','revoked')) OR (OLD.status='evaluating' AND NEW.status IN ('approved','revoked')) OR (OLD.status='approved' AND NEW.status IN ('canary','active','revoked')) OR (OLD.status='canary' AND NEW.status IN ('active','revoked')) OR (OLD.status='active' AND NEW.status='revoked'))
  THEN RAISE EXCEPTION 'Skill versions are immutable and lifecycle transitions are bounded.' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER astra_skill_guard BEFORE UPDATE OR DELETE ON astra.skills FOR EACH ROW EXECUTE FUNCTION astra.guard_learning_skill();
CREATE FUNCTION astra.guard_learning_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Learning evidence is append only.' USING ERRCODE='55000'; END $$;
CREATE TRIGGER learning_review_guard BEFORE UPDATE OR DELETE ON astra.learning_reviews FOR EACH ROW EXECUTE FUNCTION astra.guard_learning_append_only();
CREATE TRIGGER allocation_plan_guard BEFORE UPDATE OR DELETE ON astra.allocation_plans FOR EACH ROW EXECUTE FUNCTION astra.guard_learning_append_only();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['learning_artifacts','learning_reviews','allocation_plans','learning_optimizer_jobs','skills'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))',t||'_tenant_scope',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON astra.%I TO astra_app,astra_worker',t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION astra.guard_learning_artifact() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_learning_skill() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_learning_append_only() FROM PUBLIC;
COMMIT;
