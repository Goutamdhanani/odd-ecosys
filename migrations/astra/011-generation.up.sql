-- S06/S18/S21: bounded, tenant-scoped campaign and reply generation jobs.
-- Defaults keep both budgeting and provider egress disabled.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.generation_tenant_policies (
  tenant_id uuid PRIMARY KEY REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  allowed_tasks text[] NOT NULL DEFAULT '{}'::text[],
  daily_budget_microusd bigint NOT NULL DEFAULT 0 CHECK (daily_budget_microusd BETWEEN 0 AND 9000000000000000),
  reservation_microusd bigint NOT NULL DEFAULT 0 CHECK (reservation_microusd BETWEEN 0 AND 9000000000000000),
  max_input_tokens integer NOT NULL DEFAULT 0 CHECK (max_input_tokens BETWEEN 0 AND 128000),
  max_output_tokens integer NOT NULL DEFAULT 0 CHECK (max_output_tokens BETWEEN 0 AND 16384),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (allowed_tasks <@ ARRAY['campaign_generation','reply_classification']::text[]),
  CHECK (NOT enabled OR (cardinality(allowed_tasks)>0 AND daily_budget_microusd>0 AND reservation_microusd>0
    AND max_input_tokens>0 AND max_output_tokens>0))
);

CREATE TABLE astra.generation_jobs (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  task text NOT NULL CHECK (task IN ('campaign_generation','reply_classification')),
  campaign_id uuid,
  reply_message_id uuid,
  campaign_copy_version integer,
  offer_version_id bigint,
  offer_content_hash char(64),
  reply_content_hash char(64),
  claim_provenance jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(claim_provenance)='array'),
  evidence_hash char(64) NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  placeholder_version integer NOT NULL DEFAULT 1 CHECK (placeholder_version>0),
  placeholder_hash char(64) NOT NULL CHECK (placeholder_hash ~ '^[a-f0-9]{64}$'),
  placeholder_map jsonb NOT NULL CHECK (jsonb_typeof(placeholder_map)='object'),
  input_payload jsonb NOT NULL CHECK (jsonb_typeof(input_payload)='object'),
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','completed','blocked','failed','uncertain','cancelled')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  reserved_microusd bigint NOT NULL CHECK (reserved_microusd BETWEEN 0 AND 9000000000000000),
  input_tokens integer CHECK (input_tokens>=0),
  output_tokens integer CHECK (output_tokens>=0),
  actual_cost_microusd bigint CHECK (actual_cost_microusd BETWEEN 0 AND 9000000000000000),
  provider_request_id text CHECK (provider_request_id IS NULL OR length(provider_request_id)<=200),
  result_payload jsonb CHECK (result_payload IS NULL OR jsonb_typeof(result_payload)='object'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,campaign_id) REFERENCES astra.campaigns(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,reply_message_id) REFERENCES astra.inbox_messages(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((task='campaign_generation' AND campaign_id IS NOT NULL AND campaign_copy_version IS NOT NULL
      AND offer_version_id IS NOT NULL AND offer_content_hash IS NOT NULL AND reply_message_id IS NULL AND reply_content_hash IS NULL)
    OR (task='reply_classification' AND reply_message_id IS NOT NULL AND reply_content_hash IS NOT NULL AND campaign_id IS NULL
      AND campaign_copy_version IS NULL AND offer_version_id IS NULL AND offer_content_hash IS NULL)),
  CHECK (state NOT IN ('queued','running','uncertain') OR reserved_microusd>0),
  CHECK (state<>'completed' OR actual_cost_microusd IS NOT NULL OR reserved_microusd>0)
);
CREATE INDEX astra_generation_jobs_queue ON astra.generation_jobs(tenant_id,state,created_at,id);
CREATE INDEX astra_generation_jobs_campaign ON astra.generation_jobs(tenant_id,campaign_id,created_at DESC);
CREATE INDEX astra_generation_jobs_reply ON astra.generation_jobs(tenant_id,reply_message_id,created_at DESC);

CREATE FUNCTION astra.generation_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Generation jobs are append-only.' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Generation jobs and request provenance are append-only.' USING ERRCODE='55000'; END IF;
  IF (NEW.tenant_id,NEW.id,NEW.task,NEW.campaign_id,NEW.reply_message_id,NEW.campaign_copy_version,NEW.offer_version_id,
      NEW.offer_content_hash,NEW.reply_content_hash,NEW.claim_provenance,NEW.evidence_hash,NEW.placeholder_version,
      NEW.placeholder_hash,NEW.placeholder_map,NEW.input_payload,NEW.input_hash,NEW.idempotency_key,NEW.created_by,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.id,OLD.task,OLD.campaign_id,OLD.reply_message_id,OLD.campaign_copy_version,OLD.offer_version_id,
      OLD.offer_content_hash,OLD.reply_content_hash,OLD.claim_provenance,OLD.evidence_hash,OLD.placeholder_version,
      OLD.placeholder_hash,OLD.placeholder_map,OLD.input_payload,OLD.input_hash,OLD.idempotency_key,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Generation request provenance is immutable.' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.state='queued' AND NEW.state IN ('running','blocked','cancelled','failed'))
      OR (OLD.state='running' AND NEW.state IN ('completed','blocked','failed','uncertain'))) THEN
    RAISE EXCEPTION 'Generation job state transition is invalid.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER astra_generation_jobs_guard BEFORE UPDATE OR DELETE ON astra.generation_jobs
  FOR EACH ROW EXECUTE FUNCTION astra.generation_job_guard();
CREATE TRIGGER astra_generation_jobs_no_truncate BEFORE TRUNCATE ON astra.generation_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION astra.generation_job_guard();

ALTER TABLE astra.generation_tenant_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.generation_tenant_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE astra.generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.generation_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY generation_policy_owner_all ON astra.generation_tenant_policies
  FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY generation_policy_tenant_scope ON astra.generation_tenant_policies
  FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id));
CREATE POLICY generation_jobs_owner_all ON astra.generation_jobs
  FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY generation_jobs_tenant_scope ON astra.generation_jobs
  FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id));
REVOKE ALL ON astra.generation_tenant_policies,astra.generation_jobs FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON astra.generation_tenant_policies TO astra_app,astra_worker;
GRANT SELECT,INSERT,UPDATE ON astra.generation_jobs TO astra_app,astra_worker;
REVOKE DELETE,TRUNCATE ON astra.generation_tenant_policies,astra.generation_jobs FROM PUBLIC,astra_app,astra_worker;
REVOKE ALL ON FUNCTION astra.generation_job_guard() FROM PUBLIC;

CREATE FUNCTION astra.generation_reserved_today()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,astra
AS $function$
  SELECT COALESCE(SUM(reserved_microusd),0)::bigint
  FROM astra.generation_jobs
  WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND state IN ('queued','running','uncertain','completed')
$function$;
REVOKE ALL ON FUNCTION astra.generation_reserved_today() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astra.generation_reserved_today() TO astra_app,astra_worker;
RESET ROLE;
COMMIT;
