-- Roll back S28 optimizer execution schema only. Does not delete historical
-- optimizer jobs or usage requests; dependent evidence must be removed by an
-- explicit owner-controlled data-retention operation before this migration.
BEGIN;
SET ROLE astra_owner;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM astra.learning_optimizer_calls)
    OR EXISTS (SELECT 1 FROM astra.learning_optimizer_results)
    OR EXISTS (SELECT 1 FROM astra.learning_optimizer_provenance)
    OR EXISTS (SELECT 1 FROM astra.learning_optimizer_jobs WHERE result IS NOT NULL OR state IN ('running','uncertain'))
    OR EXISTS (SELECT 1 FROM astra.ai_usage_requests WHERE task='optimizer_dev_prediction')
    OR EXISTS (SELECT 1 FROM astra.ai_tenant_policies WHERE 'optimizer_dev_prediction'=ANY(allowed_tasks)) THEN
    RAISE EXCEPTION 'S28 optimizer evidence or reservations exist; retain migration 029 until an explicit evidence-retention plan is approved.';
  END IF;
END $$;
DROP INDEX IF EXISTS astra.learning_optimizer_calls_job;
DROP INDEX IF EXISTS astra.learning_optimizer_recent;
DROP TABLE IF EXISTS astra.learning_optimizer_provenance;
DROP TABLE IF EXISTS astra.learning_optimizer_results;
DROP TABLE IF EXISTS astra.learning_optimizer_calls;
ALTER TABLE astra.learning_optimizer_jobs
  DROP CONSTRAINT IF EXISTS learning_optimizer_job_dataset_unique,
  DROP CONSTRAINT IF EXISTS learning_optimizer_job_state_times,
  DROP CONSTRAINT IF EXISTS learning_optimizer_job_result_pair,
  DROP COLUMN IF EXISTS result,
  DROP COLUMN IF EXISTS selected_prompt_sha256,
  DROP COLUMN IF EXISTS selected_prompt,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS started_at,
  DROP COLUMN IF EXISTS lease_until,
  DROP COLUMN IF EXISTS worker_fence,
  DROP COLUMN IF EXISTS diagnostic_code,
  DROP COLUMN IF EXISTS engine;
ALTER TABLE astra.learning_optimizer_jobs DROP CONSTRAINT IF EXISTS learning_optimizer_jobs_state_check;
ALTER TABLE astra.learning_optimizer_jobs ADD CONSTRAINT learning_optimizer_jobs_state_check
  CHECK (state IN ('blocked','prepared','completed','failed'));
ALTER TABLE astra.ai_usage_requests DROP CONSTRAINT IF EXISTS ai_usage_requests_task_check;
ALTER TABLE astra.ai_usage_requests ADD CONSTRAINT ai_usage_requests_task_check
  CHECK (task IN ('personalization_draft','subject_polish','fact_check'));
ALTER TABLE astra.ai_tenant_policies DROP CONSTRAINT IF EXISTS ai_tenant_policies_allowed_tasks_check;
ALTER TABLE astra.ai_tenant_policies ADD CONSTRAINT ai_tenant_policies_allowed_tasks_check
  CHECK (allowed_tasks <@ ARRAY['personalization_draft','subject_polish','fact_check']::text[]);
RESET ROLE;
COMMIT;
