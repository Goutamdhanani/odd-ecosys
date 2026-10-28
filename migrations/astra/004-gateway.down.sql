-- S06/S07 rollback is deliberately refused after tenant policy or request data
-- has been written so an operator cannot silently erase metering evidence.
BEGIN;
SET ROLE astra_owner;
DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM astra.ai_tenant_policies)
     OR EXISTS (SELECT 1 FROM astra.ai_usage_requests)
     OR EXISTS (SELECT 1 FROM astra.ai_global_limits WHERE enabled OR daily_budget_microusd <> 0
       OR breaker_state <> 'closed' OR failure_count <> 0) THEN
    RAISE EXCEPTION 'Migration 004 contains tenant configuration or usage evidence; preserve it and use a reviewed forward migration.';
  END IF;
END
$rollback$;
DROP FUNCTION astra.ai_global_reserved_today();
DROP TABLE astra.ai_usage_requests;
DROP TABLE astra.ai_tenant_policies;
DROP TABLE astra.ai_global_limits;
RESET ROLE;
COMMIT;
