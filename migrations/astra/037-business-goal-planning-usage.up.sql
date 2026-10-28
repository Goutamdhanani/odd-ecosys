-- S37: allow guided goal planning to use the existing durable GLM budget ledger.
-- Defaults remain disabled; this migration grants no tenant or global egress.
BEGIN;
SET ROLE astra_owner;

ALTER TABLE astra.ai_tenant_policies DROP CONSTRAINT IF EXISTS ai_tenant_policies_allowed_tasks_check;
ALTER TABLE astra.ai_tenant_policies ADD CONSTRAINT ai_tenant_policies_allowed_tasks_check
  CHECK (allowed_tasks <@ ARRAY['personalization_draft','subject_polish','fact_check','optimizer_dev_prediction','business_goal_planning']::text[]);
ALTER TABLE astra.ai_usage_requests DROP CONSTRAINT IF EXISTS ai_usage_requests_task_check;
ALTER TABLE astra.ai_usage_requests ADD CONSTRAINT ai_usage_requests_task_check
  CHECK (task IN ('personalization_draft','subject_polish','fact_check','optimizer_dev_prediction','business_goal_planning'));

RESET ROLE;
COMMIT;
