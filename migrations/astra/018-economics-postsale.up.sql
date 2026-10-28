-- S34/X13 measured economics, persisted tenant quota hooks and S35 post-sale evidence.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.economics_tenant_quotas (
  tenant_id uuid PRIMARY KEY REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  tier text NOT NULL CHECK(length(tier) BETWEEN 1 AND 40),
  daily_limit_microusd bigint NOT NULL CHECK(daily_limit_microusd BETWEEN 0 AND 9000000000000000),
  concurrency_limit integer NOT NULL CHECK(concurrency_limit BETWEEN 1 AND 10000),
  max_task_tokens integer NOT NULL CHECK(max_task_tokens BETWEEN 1 AND 100000000),
  max_trace_bytes integer NOT NULL CHECK(max_trace_bytes BETWEEN 1 AND 1000000000),
  enabled boolean NOT NULL DEFAULT false,
  updated_by text NOT NULL CHECK(updated_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE astra.economics_quota_reservations (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  estimated_microusd bigint NOT NULL CHECK(estimated_microusd BETWEEN 1 AND 9000000000000000),
  tokens integer NOT NULL CHECK(tokens BETWEEN 1 AND 100000000),
  trace_bytes integer NOT NULL CHECK(trace_bytes BETWEEN 0 AND 1000000000),
  state text NOT NULL CHECK(state IN ('reserved','completed','failed','uncertain')),
  actual_microusd bigint CHECK(actual_microusd BETWEEN 0 AND 9000000000000000),
  provider_bill_id text CHECK(provider_bill_id IS NULL OR length(provider_bill_id)<=200),
  provenance jsonb CHECK(provenance IS NULL OR jsonb_typeof(provenance)='object'),
  provenance_sha256 char(64) CHECK(provenance_sha256 IS NULL OR provenance_sha256 ~ '^[a-f0-9]{64}$'),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), reconciled_at timestamptz,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,idempotency_key),
  CHECK((state='reserved' AND reconciled_at IS NULL) OR (state<>'reserved' AND reconciled_at IS NOT NULL)),
  CHECK(state<>'completed' OR actual_microusd IS NOT NULL)
);
CREATE INDEX economics_quota_active ON astra.economics_quota_reservations(tenant_id,state,reserved_at);

CREATE FUNCTION astra.reserve_economics_quota(p_tenant uuid,p_id uuid,p_key text,p_cost bigint,p_tokens integer,p_trace integer)
RETURNS TABLE(accepted boolean,duplicate boolean,reserved_microusd bigint,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,astra AS $$
DECLARE q astra.economics_tenant_quotas%ROWTYPE; old astra.economics_quota_reservations%ROWTYPE; spend numeric; active_count bigint;
BEGIN
  IF NOT astra.context_allows(p_tenant) THEN RAISE EXCEPTION 'Verified tenant context is required.' USING ERRCODE='42501'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant::text,0));
  SELECT * INTO old FROM astra.economics_quota_reservations WHERE tenant_id=p_tenant AND idempotency_key=p_key;
  IF FOUND THEN RETURN QUERY SELECT old.id=p_id, true, old.estimated_microusd, old.state; RETURN; END IF;
  SELECT * INTO q FROM astra.economics_tenant_quotas WHERE tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR NOT q.enabled OR p_cost<1 OR p_tokens<1 OR p_trace<0 OR p_tokens>q.max_task_tokens OR p_trace>q.max_trace_bytes THEN
    RETURN QUERY SELECT false,false,0::bigint,'blocked'::text; RETURN;
  END IF;
  SELECT COALESCE(sum(CASE WHEN state='completed' THEN actual_microusd WHEN state='failed' THEN 0 ELSE estimated_microusd END),0),count(*) FILTER(WHERE state IN ('reserved','uncertain'))
    INTO spend,active_count FROM astra.economics_quota_reservations WHERE tenant_id=p_tenant AND reserved_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF spend+p_cost>q.daily_limit_microusd OR active_count>=q.concurrency_limit THEN RETURN QUERY SELECT false,false,0::bigint,'blocked'::text; RETURN; END IF;
  INSERT INTO astra.economics_quota_reservations(tenant_id,id,idempotency_key,estimated_microusd,tokens,trace_bytes,state) VALUES(p_tenant,p_id,p_key,p_cost,p_tokens,p_trace,'reserved');
  RETURN QUERY SELECT true,false,p_cost,'reserved'::text;
END $$;

CREATE FUNCTION astra.reconcile_economics_quota(p_tenant uuid,p_id uuid,p_state text,p_actual bigint,p_bill text,p_provenance jsonb,p_provenance_hash text)
RETURNS SETOF astra.economics_quota_reservations LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,astra AS $$
DECLARE row astra.economics_quota_reservations%ROWTYPE; normalized jsonb;
BEGIN
  IF NOT astra.context_allows(p_tenant) THEN RAISE EXCEPTION 'Verified tenant context is required.' USING ERRCODE='42501'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant::text,0));
  IF p_state NOT IN ('completed','failed','uncertain') OR p_actual<0 OR p_actual>9000000000000000 OR jsonb_typeof(p_provenance)<>'object' OR p_provenance_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid quota reconciliation.' USING ERRCODE='22023'; END IF;
  SELECT * INTO row FROM astra.economics_quota_reservations WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
  IF NOT FOUND OR row.state<>'reserved' THEN RETURN; END IF;
  normalized:=p_provenance || jsonb_build_object('observedAt',coalesce(p_provenance->>'observedAt',clock_timestamp()::text));
  UPDATE astra.economics_quota_reservations SET state=p_state,actual_microusd=CASE WHEN p_state='completed' THEN p_actual ELSE NULL END,
    provider_bill_id=p_bill,provenance=normalized,provenance_sha256=p_provenance_hash,reconciled_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=p_id RETURNING * INTO row;
  RETURN NEXT row;
END $$;

CREATE TABLE astra.economics_vendor_bills (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT, id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK(length(provider) BETWEEN 1 AND 80), provider_bill_id text NOT NULL CHECK(length(provider_bill_id) BETWEEN 1 AND 200),
  amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 0 AND 9000000000000000), currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  billed_at timestamptz NOT NULL, linked_usage_id uuid, provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'),
  provenance_sha256 char(64) NOT NULL CHECK(provenance_sha256 ~ '^[a-f0-9]{64}$'), recorded_by text NOT NULL CHECK(recorded_by ~ '^[1-9][0-9]{0,39}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,provider,provider_bill_id)
);
CREATE INDEX economics_vendor_bills_recent ON astra.economics_vendor_bills(tenant_id,billed_at DESC);
CREATE TABLE astra.economics_reviewer_effort (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT, id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid, category text NOT NULL CHECK(category IN ('exception_review','quality_review','correction','escalation','other')),
  minutes integer NOT NULL CHECK(minutes BETWEEN 0 AND 1000000), occurred_at timestamptz NOT NULL,
  provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'), created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id)
);

CREATE TABLE astra.post_sale_projects (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT, id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL, won_event_id uuid NOT NULL, paid_event_id uuid NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','delivered','closed')), created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,account_id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES astra.research_accounts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,won_event_id) REFERENCES astra.events(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,paid_event_id) REFERENCES astra.events(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.post_sale_milestones (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), project_id uuid NOT NULL, milestone_key text NOT NULL CHECK(length(milestone_key) BETWEEN 1 AND 80),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160), authorized_by text NOT NULL CHECK(authorized_by ~ '^[1-9][0-9]{0,39}$'), authorization_ref text NOT NULL CHECK(length(authorization_ref) BETWEEN 1 AND 500),
  due_at timestamptz, state text NOT NULL DEFAULT 'authorized' CHECK(state IN ('authorized','delivered','accepted','blocked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,project_id,milestone_key),
  FOREIGN KEY(tenant_id,project_id) REFERENCES astra.post_sale_projects(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.post_sale_evidence (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), project_id uuid NOT NULL, milestone_id uuid,
  kind text NOT NULL CHECK(kind IN ('delivery','analytics','baseline','observed','outcome')),
  source_ref text NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 1000), source_rights jsonb NOT NULL CHECK(jsonb_typeof(source_rights)='object'),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'), snapshot_sha256 char(64) NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz NOT NULL, expires_at timestamptz, consent_revoked_at timestamptz, created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,project_id) REFERENCES astra.post_sale_projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,milestone_id) REFERENCES astra.post_sale_milestones(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.post_sale_case_studies (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), project_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'), content_sha256 char(64) NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_ids uuid[] NOT NULL, operator_attested_by text NOT NULL CHECK(operator_attested_by ~ '^[1-9][0-9]{0,39}$'), operator_attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  customer_approval_evidence_id uuid, approved boolean NOT NULL DEFAULT false CHECK(NOT approved), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,project_id,version), FOREIGN KEY(tenant_id,project_id) REFERENCES astra.post_sale_projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,customer_approval_evidence_id) REFERENCES astra.post_sale_evidence(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.post_sale_renewal_signals (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), project_id uuid NOT NULL, signal text NOT NULL CHECK(signal IN ('renewal','expansion')),
  evidence_ids uuid[] NOT NULL, permission_evaluation jsonb NOT NULL CHECK(jsonb_typeof(permission_evaluation)='object' AND permission_evaluation->>'allowed'='true'),
  state text NOT NULL DEFAULT 'observed' CHECK(state IN ('observed','review_required','dismissed')), created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,project_id) REFERENCES astra.post_sale_projects(tenant_id,id) ON DELETE RESTRICT
);

-- A tenant-visible canonical projection over append-only facts. Corrections replace their target;
-- reversals remove their target; paid status accounts for net refunds by currency.
CREATE FUNCTION astra.canonical_outcome_events(p_tenant uuid)
RETURNS TABLE(event_id uuid,event_type text,entity_type text,entity_id text,stage text,source text,recorded_at timestamptz,positive_net_revenue boolean)
LANGUAGE sql STABLE SET search_path=pg_catalog,astra AS $$
  WITH candidates AS (
    SELECT e.tenant_id,e.id,e.event_type,e.entity_type,e.entity_id,e.recorded_at,e.provenance->>'source' AS source,
      CASE WHEN e.event_type='outcome.corrected' THEN e.payload#>>'{replacement,stage}'
        WHEN e.payload ? 'stage' THEN e.payload->>'stage'
        ELSE e.event_type END AS stage,
      COALESCE((e.payload->>'amountMinor')::numeric,(e.payload#>>'{replacement,amountMinor}')::numeric,0) AS amount_minor,
      COALESCE(e.payload->>'currency',e.payload#>>'{replacement,currency}') AS currency
    FROM astra.events e WHERE e.tenant_id=p_tenant
      AND e.event_type IN ('opportunity.won','revenue.paid','revenue.refunded','outcome.labelled','outcome.corrected','outcome.reversed')
      AND NOT EXISTS(SELECT 1 FROM astra.events c WHERE c.tenant_id=e.tenant_id AND c.corrects_event_id=e.id AND c.event_type IN ('outcome.corrected','outcome.reversed'))
  ), revenue AS (
    SELECT tenant_id,entity_type,entity_id,currency,
      sum(CASE WHEN stage IN ('revenue_paid','revenue.paid') THEN amount_minor WHEN stage IN ('revenue_refunded','revenue.refunded') THEN -amount_minor ELSE 0 END) net_minor
    FROM candidates WHERE currency IS NOT NULL GROUP BY tenant_id,entity_type,entity_id,currency
  )
  SELECT c.id,c.event_type,c.entity_type,c.entity_id,c.stage,c.source,c.recorded_at,
    EXISTS(SELECT 1 FROM revenue r WHERE r.tenant_id=c.tenant_id AND r.entity_type=c.entity_type AND r.entity_id=c.entity_id AND r.net_minor>0)
  FROM candidates c WHERE c.stage IN ('opportunity.won','opportunity_won','revenue.paid','revenue_paid')
    AND c.event_type<>'outcome.reversed'
$$;

CREATE FUNCTION astra.guard_economics_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Economics source evidence is append only.' USING ERRCODE='55000'; END $$;
CREATE TRIGGER economics_bill_immutable BEFORE UPDATE OR DELETE ON astra.economics_vendor_bills FOR EACH ROW EXECUTE FUNCTION astra.guard_economics_immutable();
CREATE TRIGGER economics_effort_immutable BEFORE UPDATE OR DELETE ON astra.economics_reviewer_effort FOR EACH ROW EXECUTE FUNCTION astra.guard_economics_immutable();
CREATE FUNCTION astra.guard_post_sale_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.tenant_id,NEW.id,NEW.project_id,NEW.milestone_id,NEW.kind,NEW.source_ref,NEW.source_rights,NEW.snapshot,NEW.snapshot_sha256,NEW.captured_at,NEW.expires_at,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.project_id,OLD.milestone_id,OLD.kind,OLD.source_ref,OLD.source_rights,OLD.snapshot,OLD.snapshot_sha256,OLD.captured_at,OLD.expires_at,OLD.created_by,OLD.created_at)
    OR (OLD.consent_revoked_at IS NOT NULL AND NEW.consent_revoked_at IS DISTINCT FROM OLD.consent_revoked_at)
  THEN RAISE EXCEPTION 'Post-sale evidence is immutable; consent revocation is one way.' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER post_sale_evidence_guard BEFORE UPDATE OR DELETE ON astra.post_sale_evidence FOR EACH ROW EXECUTE FUNCTION astra.guard_post_sale_evidence();
CREATE TRIGGER post_sale_project_guard BEFORE UPDATE OR DELETE ON astra.post_sale_projects FOR EACH ROW EXECUTE FUNCTION astra.guard_economics_immutable();
CREATE TRIGGER post_sale_milestone_guard BEFORE UPDATE OR DELETE ON astra.post_sale_milestones FOR EACH ROW EXECUTE FUNCTION astra.guard_economics_immutable();
CREATE TRIGGER post_sale_case_guard BEFORE UPDATE OR DELETE ON astra.post_sale_case_studies FOR EACH ROW EXECUTE FUNCTION astra.guard_economics_immutable();
CREATE TRIGGER post_sale_renewal_guard BEFORE UPDATE OR DELETE ON astra.post_sale_renewal_signals FOR EACH ROW EXECUTE FUNCTION astra.guard_economics_immutable();

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['economics_tenant_quotas','economics_quota_reservations','economics_vendor_bills','economics_reviewer_effort','post_sale_projects','post_sale_milestones','post_sale_evidence','post_sale_case_studies','post_sale_renewal_signals'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',tab); EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_owner USING(true) WITH CHECK(true)',tab||'_owner_all',tab);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING(astra.context_allows(tenant_id)) WITH CHECK(astra.context_allows(tenant_id))',tab||'_tenant_scope',tab);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON astra.%I TO astra_app,astra_worker',tab);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION astra.reserve_economics_quota(uuid,uuid,text,bigint,integer,integer) TO astra_app,astra_worker;
GRANT EXECUTE ON FUNCTION astra.reconcile_economics_quota(uuid,uuid,text,bigint,text,jsonb,text) TO astra_app,astra_worker;
GRANT EXECUTE ON FUNCTION astra.canonical_outcome_events(uuid) TO astra_app,astra_worker;
REVOKE ALL ON FUNCTION astra.reserve_economics_quota(uuid,uuid,text,bigint,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.reconcile_economics_quota(uuid,uuid,text,bigint,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.canonical_outcome_events(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_economics_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_post_sale_evidence() FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.economics_vendor_bills,astra.economics_reviewer_effort,astra.post_sale_projects,astra.post_sale_milestones,astra.post_sale_case_studies,astra.post_sale_renewal_signals FROM astra_app,astra_worker;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON astra.economics_quota_reservations FROM astra_app,astra_worker;
RESET ROLE;
COMMIT;
