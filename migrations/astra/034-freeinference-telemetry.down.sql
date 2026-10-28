ALTER TABLE astra.generation_jobs
  DROP CONSTRAINT IF EXISTS generation_settled_actual_cost_check,
  DROP CONSTRAINT IF EXISTS generation_accounting_status_check,
  DROP CONSTRAINT IF EXISTS generation_response_verified_check,
  DROP CONSTRAINT IF EXISTS generation_actual_cost_source_check,
  DROP CONSTRAINT IF EXISTS generation_provider_quota_check,
  DROP CONSTRAINT IF EXISTS generation_reasoning_tokens_check,
  DROP CONSTRAINT IF EXISTS generation_actual_identity_pair_check,
  DROP CONSTRAINT IF EXISTS generation_actual_model_check,
  DROP CONSTRAINT IF EXISTS generation_actual_provider_check;

ALTER TABLE astra.ai_usage_requests
  DROP CONSTRAINT IF EXISTS ai_usage_settled_actual_cost_check,
  DROP CONSTRAINT IF EXISTS ai_usage_accounting_status_check,
  DROP CONSTRAINT IF EXISTS ai_usage_response_verified_check,
  DROP CONSTRAINT IF EXISTS ai_usage_actual_cost_source_check,
  DROP CONSTRAINT IF EXISTS ai_usage_provider_quota_check,
  DROP CONSTRAINT IF EXISTS ai_usage_reasoning_tokens_check,
  DROP CONSTRAINT IF EXISTS ai_usage_actual_identity_pair_check,
  DROP CONSTRAINT IF EXISTS ai_usage_actual_model_check,
  DROP CONSTRAINT IF EXISTS ai_usage_actual_provider_check;

ALTER TABLE astra.generation_jobs
  DROP COLUMN IF EXISTS accounting_status,
  DROP COLUMN IF EXISTS response_verified,
  DROP COLUMN IF EXISTS actual_cost_source,
  DROP COLUMN IF EXISTS provider_quota,
  DROP COLUMN IF EXISTS reasoning_tokens,
  DROP COLUMN IF EXISTS actual_model,
  DROP COLUMN IF EXISTS actual_provider;

ALTER TABLE astra.ai_usage_requests
  DROP COLUMN IF EXISTS accounting_status,
  DROP COLUMN IF EXISTS response_verified,
  DROP COLUMN IF EXISTS actual_cost_source,
  DROP COLUMN IF EXISTS provider_quota,
  DROP COLUMN IF EXISTS reasoning_tokens,
  DROP COLUMN IF EXISTS actual_model,
  DROP COLUMN IF EXISTS actual_provider;
