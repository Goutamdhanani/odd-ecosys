BEGIN;
SET ROLE astra_owner;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM astra.ai_usage_requests WHERE task='business_goal_planning')
    OR EXISTS (SELECT 1 FROM astra.ai_tenant_policies WHERE 'business_goal_planning'=ANY(allowed_tasks)) THEN
    RAISE EXCEPTION 'Guided goal usage reservations or policies exist; retain migration 037 until an explicit evidence-retention plan is approved.';
  END IF;
END $$;
ALTER TABLE astra.ai_usage_requests DROP CONSTRAINT IF EXISTS ai_usage_requests_task_check;
ALTER TABLE astra.ai_usage_requests ADD CONSTRAINT ai_usage_requests_task_check
  CHECK (task IN ('personalization_draft','subject_polish','fact_check','optimizer_dev_prediction'));
ALTER TABLE astra.ai_tenant_policies DROP CONSTRAINT IF EXISTS ai_tenant_policies_allowed_tasks_check;
ALTER TABLE astra.ai_tenant_policies ADD CONSTRAINT ai_tenant_policies_allowed_tasks_check
  CHECK (allowed_tasks <@ ARRAY['personalization_draft','subject_polish','fact_check','optimizer_dev_prediction']::text[]);
RESET ROLE;
COMMIT;
