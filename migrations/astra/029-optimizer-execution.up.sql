-- S28 bounded optimizer execution. Additive only; local preview and the S01
-- commercial/privacy gate remain deny-by-default. No migration enables egress.
BEGIN;
SET ROLE astra_owner;

ALTER TABLE astra.ai_tenant_policies DROP CONSTRAINT IF EXISTS ai_tenant_policies_allowed_tasks_check;
ALTER TABLE astra.ai_tenant_policies ADD CONSTRAINT ai_tenant_policies_allowed_tasks_check
  CHECK (allowed_tasks <@ ARRAY['personalization_draft','subject_polish','fact_check','optimizer_dev_prediction']::text[]);
ALTER TABLE astra.ai_usage_requests DROP CONSTRAINT IF EXISTS ai_usage_requests_task_check;
ALTER TABLE astra.ai_usage_requests ADD CONSTRAINT ai_usage_requests_task_check
  CHECK (task IN ('personalization_draft','subject_polish','fact_check','optimizer_dev_prediction'));

ALTER TABLE astra.learning_optimizer_jobs DROP CONSTRAINT IF EXISTS learning_optimizer_jobs_state_check;
ALTER TABLE astra.learning_optimizer_jobs ADD CONSTRAINT learning_optimizer_jobs_state_check
  CHECK (state IN ('blocked','prepared','running','completed','failed','uncertain'));
ALTER TABLE astra.learning_optimizer_jobs
  ADD COLUMN engine text NOT NULL DEFAULT 'native_bounded_v1' CHECK(engine IN ('native_bounded_v1','gepa','dspy')),
  ADD COLUMN diagnostic_code text CHECK(diagnostic_code IS NULL OR diagnostic_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  ADD COLUMN worker_fence uuid,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  ADD COLUMN selected_prompt text CHECK(selected_prompt IS NULL OR length(selected_prompt)<=12000),
  ADD COLUMN selected_prompt_sha256 char(64) CHECK(selected_prompt_sha256 IS NULL OR selected_prompt_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object');
UPDATE astra.learning_optimizer_jobs SET completed_at=created_at
  WHERE state IN ('completed','failed') AND completed_at IS NULL;
ALTER TABLE astra.learning_optimizer_jobs
  ADD CONSTRAINT learning_optimizer_job_result_pair CHECK ((result IS NULL)=(selected_prompt IS NULL AND selected_prompt_sha256 IS NULL)),
  ADD CONSTRAINT learning_optimizer_job_state_times CHECK (
    (state='running' AND worker_fence IS NOT NULL AND lease_until IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (state='prepared' AND completed_at IS NULL AND lease_until IS NULL)
    OR (state='blocked' AND lease_until IS NULL)
    OR (state IN ('completed','failed','uncertain') AND completed_at IS NOT NULL AND lease_until IS NULL)
  ),
  ADD CONSTRAINT learning_optimizer_job_dataset_unique UNIQUE(tenant_id,id,dataset_id);

CREATE TABLE astra.learning_optimizer_calls (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  iteration integer NOT NULL CHECK(iteration BETWEEN 0 AND 11),
  example_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  usage_request_id uuid NOT NULL,
  input_sha256 char(64) NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('queued','running','succeeded','failed','uncertain')),
  prediction text CHECK(prediction IS NULL OR length(prediction) BETWEEN 1 AND 80),
  expected_label text NOT NULL CHECK(length(expected_label) BETWEEN 1 AND 80),
  prediction_sha256 char(64) CHECK(prediction_sha256 IS NULL OR prediction_sha256 ~ '^[a-f0-9]{64}$'),
  diagnostic_code text CHECK(diagnostic_code IS NULL OR diagnostic_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,job_id,idempotency_key),
  UNIQUE(tenant_id,usage_request_id),
  FOREIGN KEY(tenant_id,job_id,dataset_id) REFERENCES astra.learning_optimizer_jobs(tenant_id,id,dataset_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,dataset_id,example_id) REFERENCES astra.eval_examples(tenant_id,dataset_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,usage_request_id) REFERENCES astra.ai_usage_requests(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((state='succeeded')=(prediction IS NOT NULL AND prediction_sha256 IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (state NOT IN ('failed','uncertain') OR completed_at IS NOT NULL)
);

CREATE TABLE astra.learning_optimizer_results (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  iteration integer NOT NULL CHECK(iteration BETWEEN 0 AND 11),
  candidate_prompt text NOT NULL CHECK(length(candidate_prompt) BETWEEN 1 AND 12000),
  candidate_sha256 char(64) NOT NULL CHECK(candidate_sha256 ~ '^[a-f0-9]{64}$'),
  metrics jsonb NOT NULL CHECK(jsonb_typeof(metrics)='object'),
  prediction_sha256 char(64) NOT NULL CHECK(prediction_sha256 ~ '^[a-f0-9]{64}$'),
  dev_set_sha256 char(64) NOT NULL CHECK(dev_set_sha256 ~ '^[a-f0-9]{64}$'),
  input_sha256 char(64) NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN ('candidate','selected_candidate','needs_independent_holdout','not_selected')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,job_id,iteration),
  FOREIGN KEY(tenant_id,job_id) REFERENCES astra.learning_optimizer_jobs(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.learning_optimizer_provenance (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_manifest_sha256 char(64) NOT NULL CHECK(dataset_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  source_manifest_sha256 char(64) NOT NULL CHECK(source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  label_rights_sha256 char(64) NOT NULL CHECK(label_rights_sha256 ~ '^[a-f0-9]{64}$'),
  development_set_sha256 char(64) NOT NULL CHECK(development_set_sha256 ~ '^[a-f0-9]{64}$'),
  partition text NOT NULL CHECK(partition='development'),
  label_rights_basis text NOT NULL CHECK(label_rights_basis='synthetic_fixture'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,job_id),
  FOREIGN KEY(tenant_id,job_id,dataset_id) REFERENCES astra.learning_optimizer_jobs(tenant_id,id,dataset_id) ON DELETE RESTRICT
);

CREATE INDEX learning_optimizer_recent ON astra.learning_optimizer_jobs(tenant_id,created_at DESC);
CREATE INDEX learning_optimizer_calls_job ON astra.learning_optimizer_calls(tenant_id,job_id,iteration,created_at);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['learning_optimizer_calls','learning_optimizer_results','learning_optimizer_provenance'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))',t||'_tenant_scope',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON astra.%I TO astra_app,astra_worker',t);
    EXECUTE format('REVOKE DELETE,TRUNCATE ON astra.%I FROM PUBLIC,astra_app,astra_worker',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON astra.learning_optimizer_jobs TO astra_app,astra_worker;
REVOKE DELETE,TRUNCATE ON astra.learning_optimizer_jobs FROM PUBLIC,astra_app,astra_worker;

RESET ROLE;
COMMIT;
