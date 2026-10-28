-- S06/S07: tenant-scoped GLM-5.3 gateway policy and exact-cost reservations.
-- This migration is additive and creates no tenant policy or enabled egress.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.ai_global_limits (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  daily_budget_microusd bigint NOT NULL DEFAULT 0 CHECK (daily_budget_microusd BETWEEN 0 AND 9000000000000000),
  breaker_state text NOT NULL DEFAULT 'closed' CHECK (breaker_state IN ('closed','open','half_open')),
  breaker_open_until timestamptz,
  breaker_probe_request_id uuid,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO astra.ai_global_limits(singleton) VALUES (true);

CREATE TABLE astra.ai_tenant_policies (
  tenant_id uuid PRIMARY KEY REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  allowed_tasks text[] NOT NULL DEFAULT '{}'::text[],
  daily_budget_microusd bigint NOT NULL DEFAULT 0 CHECK (daily_budget_microusd BETWEEN 0 AND 9000000000000000),
  reservation_microusd bigint NOT NULL DEFAULT 0 CHECK (reservation_microusd BETWEEN 0 AND 9000000000000000),
  max_input_tokens integer NOT NULL DEFAULT 0 CHECK (max_input_tokens BETWEEN 0 AND 128000),
  max_output_tokens integer NOT NULL DEFAULT 0 CHECK (max_output_tokens BETWEEN 0 AND 16384),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (allowed_tasks <@ ARRAY['personalization_draft','subject_polish','fact_check']::text[]),
  CHECK (NOT enabled OR (cardinality(allowed_tasks) > 0 AND daily_budget_microusd > 0
    AND reservation_microusd > 0 AND max_input_tokens > 0 AND max_output_tokens > 0))
);

CREATE TABLE astra.ai_usage_requests (
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  task text NOT NULL CHECK (task IN ('personalization_draft','subject_polish','fact_check')),
  provider text NOT NULL CHECK (provider = 'glm-5.3-api'),
  model text NOT NULL CHECK (model = 'GLM-5.3'),
  data_classification text NOT NULL CHECK (data_classification IN ('synthetic-fixture','unknown','private','confidential','regulated')),
  offer_version_id text CHECK (offer_version_id IS NULL OR offer_version_id ~ '^[1-9][0-9]{0,18}$'),
  state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled','uncertain')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  input_payload jsonb NOT NULL CHECK (jsonb_typeof(input_payload) = 'object'),
  input_hash char(64) NOT NULL DEFAULT repeat('0',64) CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  max_input_tokens integer NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 128000),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 16384),
  reserved_microusd bigint NOT NULL CHECK (reserved_microusd BETWEEN 0 AND 9000000000000000),
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  cost_microusd bigint CHECK (cost_microusd BETWEEN 0 AND 9000000000000000),
  provider_request_id text CHECK (length(provider_request_id) <= 200),
  error_code text CHECK (error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  CHECK ((state = 'succeeded') = (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cost_microusd IS NOT NULL)),
  CHECK (state <> 'uncertain' OR reserved_microusd >= COALESCE(cost_microusd,0))
);
CREATE INDEX astra_ai_usage_tenant_recent ON astra.ai_usage_requests(tenant_id,created_at DESC);
CREATE INDEX astra_ai_usage_global_recent ON astra.ai_usage_requests(created_at DESC);

ALTER TABLE astra.ai_global_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.ai_global_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE astra.ai_tenant_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.ai_tenant_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE astra.ai_usage_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.ai_usage_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_global_owner_all ON astra.ai_global_limits
  FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY ai_global_app_read ON astra.ai_global_limits
  FOR SELECT TO astra_app, astra_worker USING (true);
CREATE POLICY ai_global_app_breaker_update ON astra.ai_global_limits
  FOR UPDATE TO astra_app, astra_worker USING (true) WITH CHECK (true);
CREATE POLICY ai_tenant_policy_owner_all ON astra.ai_tenant_policies
  FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY ai_tenant_policy_scope ON astra.ai_tenant_policies
  FOR ALL TO astra_app, astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id));
CREATE POLICY ai_usage_owner_all ON astra.ai_usage_requests
  FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY ai_usage_tenant_scope ON astra.ai_usage_requests
  FOR ALL TO astra_app, astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id));

-- astra_app can lock the global row for a serializable cap check and update only
-- breaker counters. It cannot enable global egress or raise the global budget.
GRANT SELECT ON astra.ai_global_limits TO astra_app, astra_worker;
GRANT UPDATE (breaker_state,breaker_open_until,breaker_probe_request_id,failure_count,updated_at) ON astra.ai_global_limits TO astra_app, astra_worker;
GRANT SELECT, INSERT, UPDATE ON astra.ai_tenant_policies TO astra_app, astra_worker;
GRANT SELECT, INSERT, UPDATE ON astra.ai_usage_requests TO astra_app, astra_worker;
REVOKE DELETE, TRUNCATE ON astra.ai_usage_requests FROM PUBLIC, astra_app, astra_worker;
REVOKE ALL ON astra.ai_global_limits, astra.ai_tenant_policies, astra.ai_usage_requests FROM PUBLIC;
GRANT SELECT, UPDATE (breaker_state,breaker_open_until,breaker_probe_request_id,failure_count,updated_at) ON astra.ai_global_limits TO astra_app, astra_worker;
GRANT SELECT, INSERT, UPDATE ON astra.ai_tenant_policies, astra.ai_usage_requests TO astra_app, astra_worker;

CREATE FUNCTION astra.ai_global_reserved_today()
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, astra
AS $function$
DECLARE v_total bigint;
BEGIN
  SELECT COALESCE(SUM(reserved_microusd),0)::bigint INTO v_total
  FROM astra.ai_usage_requests
  WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND state IN ('queued','running','uncertain','succeeded');
  RETURN v_total;
END
$function$;
REVOKE ALL ON FUNCTION astra.ai_global_reserved_today() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astra.ai_global_reserved_today() TO astra_app, astra_worker;

RESET ROLE;
COMMIT;
