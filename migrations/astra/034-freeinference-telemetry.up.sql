ALTER TABLE astra.ai_usage_requests
  ADD COLUMN actual_provider text,
  ADD COLUMN actual_model text,
  ADD COLUMN reasoning_tokens integer,
  ADD COLUMN provider_quota jsonb,
  ADD COLUMN actual_cost_source text,
  ADD COLUMN response_verified boolean,
  ADD COLUMN accounting_status text;

ALTER TABLE astra.generation_jobs
  ADD COLUMN actual_provider text,
  ADD COLUMN actual_model text,
  ADD COLUMN reasoning_tokens integer,
  ADD COLUMN provider_quota jsonb,
  ADD COLUMN actual_cost_source text,
  ADD COLUMN response_verified boolean,
  ADD COLUMN accounting_status text;

ALTER TABLE astra.ai_usage_requests
  ADD CONSTRAINT ai_usage_actual_provider_check
    CHECK (actual_provider IS NULL OR actual_provider = 'freeinference'),
  ADD CONSTRAINT ai_usage_actual_model_check
    CHECK (actual_model IS NULL OR actual_model = 'glm-5.3-flash'),
  ADD CONSTRAINT ai_usage_actual_identity_pair_check
    CHECK ((actual_provider IS NULL) = (actual_model IS NULL)),
  ADD CONSTRAINT ai_usage_reasoning_tokens_check
    CHECK (reasoning_tokens IS NULL OR reasoning_tokens BETWEEN 0 AND 1000000),
  ADD CONSTRAINT ai_usage_provider_quota_check
    CHECK (provider_quota IS NULL OR (jsonb_typeof(provider_quota) = 'object'
      AND provider_quota - ARRAY['retry-after','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset',
        'ratelimit-limit','ratelimit-remaining','ratelimit-reset','x-quota-limit','x-quota-remaining','x-quota-reset'] = '{}'::jsonb)),
  ADD CONSTRAINT ai_usage_actual_cost_source_check
    CHECK (actual_cost_source IS NULL OR (actual_cost_source IN ('provider_usage.cost_microusd','provider_reconciliation_hmac')
      AND cost_microusd IS NOT NULL AND (actual_cost_source <> 'provider_usage.cost_microusd' OR response_verified IS TRUE))),
  ADD CONSTRAINT ai_usage_response_verified_check
    CHECK ((response_verified IS DISTINCT FROM true AND actual_provider IS NULL AND actual_model IS NULL)
      OR (response_verified IS TRUE AND actual_provider IS NOT DISTINCT FROM 'freeinference'
        AND actual_model IS NOT DISTINCT FROM 'glm-5.3-flash')),
  ADD CONSTRAINT ai_usage_accounting_status_check
    CHECK (accounting_status IS NULL OR accounting_status IN ('pending','settled','unknown','not_submitted')),
  ADD CONSTRAINT ai_usage_settled_actual_cost_check
    CHECK (accounting_status <> 'settled' OR (cost_microusd IS NOT NULL AND actual_cost_source IS NOT NULL));

ALTER TABLE astra.generation_jobs
  ADD CONSTRAINT generation_actual_provider_check
    CHECK (actual_provider IS NULL OR actual_provider = 'freeinference'),
  ADD CONSTRAINT generation_actual_model_check
    CHECK (actual_model IS NULL OR actual_model = 'glm-5.3-flash'),
  ADD CONSTRAINT generation_actual_identity_pair_check
    CHECK ((actual_provider IS NULL) = (actual_model IS NULL)),
  ADD CONSTRAINT generation_reasoning_tokens_check
    CHECK (reasoning_tokens IS NULL OR reasoning_tokens BETWEEN 0 AND 1000000),
  ADD CONSTRAINT generation_provider_quota_check
    CHECK (provider_quota IS NULL OR (jsonb_typeof(provider_quota) = 'object'
      AND provider_quota - ARRAY['retry-after','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset',
        'ratelimit-limit','ratelimit-remaining','ratelimit-reset','x-quota-limit','x-quota-remaining','x-quota-reset'] = '{}'::jsonb)),
  ADD CONSTRAINT generation_actual_cost_source_check
    CHECK (actual_cost_source IS NULL OR (actual_cost_source IN ('provider_usage.cost_microusd','provider_reconciliation_hmac')
      AND actual_cost_microusd IS NOT NULL AND (actual_cost_source <> 'provider_usage.cost_microusd' OR response_verified IS TRUE))),
  ADD CONSTRAINT generation_response_verified_check
    CHECK ((response_verified IS DISTINCT FROM true AND actual_provider IS NULL AND actual_model IS NULL)
      OR (response_verified IS TRUE AND actual_provider IS NOT DISTINCT FROM 'freeinference'
        AND actual_model IS NOT DISTINCT FROM 'glm-5.3-flash')),
  ADD CONSTRAINT generation_accounting_status_check
    CHECK (accounting_status IS NULL OR accounting_status IN ('pending','settled','unknown','not_submitted')),
  ADD CONSTRAINT generation_settled_actual_cost_check
    CHECK (accounting_status <> 'settled' OR (actual_cost_microusd IS NOT NULL AND actual_cost_source IS NOT NULL));
