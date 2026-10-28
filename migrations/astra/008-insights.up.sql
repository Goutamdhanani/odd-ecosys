-- S23-S25: tenant-local temporal memory, fixed account experiments and
-- ledger-backed analytics. No customer records or experiment assignments are
-- created by this migration.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.memory_items (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  memory_kind text NOT NULL CHECK (memory_kind IN ('fact','episode','preference','strategy')),
  subject_type text NOT NULL CHECK (subject_type IN ('tenant','account','contact','opportunity','meeting','invoice')),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 500),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 120),
  memory_key text NOT NULL CHECK (length(memory_key) BETWEEN 1 AND 160),
  value jsonb NOT NULL CHECK (jsonb_typeof(value) IN ('object','array','string','number','boolean')),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  confidence text NOT NULL CHECK (confidence IN ('high','medium','low','unknown')),
  authority text NOT NULL CHECK (authority IN ('crm','human','system','source')),
  sensitivity text NOT NULL CHECK (sensitivity IN ('public','internal','personal','confidential')),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance)='object'),
  permission_decision_id uuid NOT NULL,
  permission_subject_type text NOT NULL CHECK (permission_subject_type IN ('recipient','domain','account','channel')),
  permission_subject_value text NOT NULL CHECK (length(permission_subject_value) BETWEEN 1 AND 320),
  source_event_id uuid,
  source_evidence_id uuid,
  rights_policy text NOT NULL CHECK (rights_policy IN ('synthetic_fixture','user_provided','licensed','public_terms_permitted','internal_event')),
  rights_expires_at timestamptz,
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  supersedes_memory_id uuid,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', memory_key), 'A') ||
    setweight(to_tsvector('simple', value::text), 'B')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,permission_decision_id) REFERENCES astra.permission_decisions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_event_id) REFERENCES astra.events(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_evidence_id) REFERENCES astra.research_evidence(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,supersedes_memory_id) REFERENCES astra.memory_items(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((source_event_id IS NOT NULL) <> (source_evidence_id IS NOT NULL)),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (expires_at IS NULL OR expires_at > valid_from),
  CHECK (rights_expires_at IS NULL OR rights_expires_at > created_at),
  CHECK (sensitivity='public' OR permission_subject_type IN ('account','recipient','channel'))
);
CREATE INDEX astra_memory_subject_time ON astra.memory_items(tenant_id,subject_type,subject_id,valid_from DESC);
CREATE INDEX astra_memory_fulltext ON astra.memory_items USING gin(search_vector);
CREATE INDEX astra_memory_permission ON astra.memory_items(tenant_id,permission_subject_type,permission_subject_value,purpose);

CREATE TABLE astra.memory_links (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  from_memory_id uuid NOT NULL,
  to_memory_id uuid NOT NULL,
  link_type text NOT NULL CHECK (link_type IN ('contradicts','supports')),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance)='object'),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,from_memory_id,to_memory_id,link_type),
  CHECK (from_memory_id <> to_memory_id),
  FOREIGN KEY (tenant_id,from_memory_id) REFERENCES astra.memory_items(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,to_memory_id) REFERENCES astra.memory_items(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.memory_tombstones (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  memory_item_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  actor_id text NOT NULL CHECK (actor_id ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,memory_item_id),
  FOREIGN KEY (tenant_id,memory_item_id) REFERENCES astra.memory_items(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.experiments (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  hypothesis text NOT NULL CHECK (length(hypothesis) BETWEEN 1 AND 2000),
  unit text NOT NULL DEFAULT 'account' CHECK (unit='account'),
  arms jsonb NOT NULL CHECK (jsonb_typeof(arms)='array' AND jsonb_array_length(arms) BETWEEN 2 AND 8),
  primary_metric text NOT NULL CHECK (primary_metric IN ('meeting.held','opportunity.qualified','opportunity.won','revenue.paid')),
  primary_horizon_days integer NOT NULL CHECK (primary_horizon_days BETWEEN 1 AND 365),
  attribution_window_days integer NOT NULL CHECK (attribution_window_days BETWEEN 1 AND 365),
  stopping_rule jsonb NOT NULL CHECK (jsonb_typeof(stopping_rule)='object'),
  max_accounts integer NOT NULL CHECK (max_accounts BETWEEN 2 AND 1000000),
  max_cost_microusd bigint NOT NULL CHECK (max_cost_microusd BETWEEN 1 AND 9000000000000000),
  strata jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(strata)='array'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object'),
  plan_sha256 char(64) NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  allocation_key bytea NOT NULL CHECK (octet_length(allocation_key)=32),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','paused','closed')),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX astra_experiments_recent ON astra.experiments(tenant_id,created_at DESC);

CREATE TABLE astra.experiment_assignments (
  tenant_id uuid NOT NULL,
  experiment_id uuid NOT NULL,
  account_id uuid NOT NULL,
  arm_id text NOT NULL CHECK (length(arm_id) BETWEEN 1 AND 80),
  propensity numeric(12,11) NOT NULL CHECK (propensity > 0 AND propensity <= 1),
  stratum text NOT NULL DEFAULT 'all' CHECK (length(stratum) BETWEEN 1 AND 120),
  eligibility jsonb NOT NULL CHECK (jsonb_typeof(eligibility)='object'),
  assignment_hash char(64) NOT NULL CHECK (assignment_hash ~ '^[0-9a-f]{64}$'),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,experiment_id,account_id),
  FOREIGN KEY (tenant_id,experiment_id) REFERENCES astra.experiments(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,account_id) REFERENCES astra.research_accounts(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_experiment_assignment_arm ON astra.experiment_assignments(tenant_id,experiment_id,arm_id,assigned_at);

CREATE TABLE astra.experiment_exposures (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  experiment_id uuid NOT NULL,
  account_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  exposure_type text NOT NULL CHECK (exposure_type IN ('send_submitted','control_eligible','other_known')),
  verification_status text NOT NULL CHECK (verification_status IN ('declared','verified','unsupported')),
  occurred_at timestamptz NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,experiment_id,account_id,source_event_id),
  FOREIGN KEY (tenant_id,experiment_id,account_id) REFERENCES astra.experiment_assignments(tenant_id,experiment_id,account_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_event_id) REFERENCES astra.events(tenant_id,id) ON DELETE RESTRICT,
  CHECK (verification_status <> 'verified' OR evidence->>'declaration'='operator_declared')
);
CREATE INDEX astra_experiment_exposures_account ON astra.experiment_exposures(tenant_id,experiment_id,account_id,occurred_at);

CREATE FUNCTION astra.guard_experiment_exposure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, astra AS $$
DECLARE v_event_type text; v_entity_type text; v_entity_id text; v_payload jsonb; v_assigned_at timestamptz; v_window integer;
BEGIN
  SELECT event_type,entity_type,entity_id,payload INTO v_event_type,v_entity_type,v_entity_id,v_payload
    FROM astra.events WHERE tenant_id=NEW.tenant_id AND id=NEW.source_event_id;
  IF NOT FOUND OR v_entity_type <> 'account' OR v_entity_id <> NEW.account_id::text THEN
    RAISE EXCEPTION 'Experiment exposure source must identify the same canonical account.' USING ERRCODE='23514';
  END IF;
  IF NEW.verification_status='verified' AND NOT (
    v_event_type='campaign.exposure_verified'
    AND v_payload->>'exposureType'=NEW.exposure_type AND v_payload->>'confirmed'='true'
  ) THEN
    RAISE EXCEPTION 'Only an explicit immutable exposure verification event can verify an exposure.' USING ERRCODE='23514';
  END IF;
  SELECT a.assigned_at,e.attribution_window_days INTO v_assigned_at,v_window
    FROM astra.experiment_assignments a JOIN astra.experiments e
      ON (e.tenant_id,e.id)=(a.tenant_id,a.experiment_id)
    WHERE a.tenant_id=NEW.tenant_id AND a.experiment_id=NEW.experiment_id AND a.account_id=NEW.account_id;
  IF NOT FOUND OR NEW.occurred_at<v_assigned_at
      OR NEW.occurred_at>v_assigned_at+make_interval(days=>v_window) THEN
    RAISE EXCEPTION 'Experiment exposure is outside the assigned account attribution window.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER astra_experiment_exposure_guard BEFORE INSERT ON astra.experiment_exposures
  FOR EACH ROW EXECUTE FUNCTION astra.guard_experiment_exposure();

-- Declarations remain available to a future adapter, but no automatic sender
-- or exposure inference is installed here. Analytics reads the actual event
-- ledger and usage reservations directly.
CREATE FUNCTION astra.reject_insights_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Astra insight evidence is append-only.' USING ERRCODE='55000';
END;
$$;
DO $immutable$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['memory_items','memory_links','memory_tombstones','experiment_assignments','experiment_exposures'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON astra.%I FOR EACH ROW EXECUTE FUNCTION astra.reject_insights_immutable_mutation()', 'astra_'||table_name||'_immutable', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON astra.%I FOR EACH STATEMENT EXECUTE FUNCTION astra.reject_insights_immutable_mutation()', 'astra_'||table_name||'_no_truncate', table_name);
  END LOOP;
  EXECUTE 'CREATE TRIGGER astra_experiments_plan_immutable BEFORE UPDATE OR DELETE ON astra.experiments FOR EACH ROW EXECUTE FUNCTION astra.reject_insights_immutable_mutation()';
  EXECUTE 'CREATE TRIGGER astra_experiments_no_truncate BEFORE TRUNCATE ON astra.experiments FOR EACH STATEMENT EXECUTE FUNCTION astra.reject_insights_immutable_mutation()';
END
$immutable$;

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['memory_items','memory_links','memory_tombstones','experiments','experiment_assignments','experiment_exposures'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY insights_owner_all ON astra.%I FOR ALL TO astra_owner USING (true) WITH CHECK (true)', table_name);
    EXECUTE format('CREATE POLICY insights_tenant_scope ON astra.%I FOR ALL TO astra_app, astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))', table_name);
  END LOOP;
END
$rls$;

REVOKE ALL ON astra.memory_items, astra.memory_links, astra.memory_tombstones,
  astra.experiments, astra.experiment_assignments, astra.experiment_exposures FROM PUBLIC;
GRANT SELECT, INSERT ON astra.memory_items, astra.memory_links, astra.memory_tombstones,
  astra.experiments, astra.experiment_assignments, astra.experiment_exposures TO astra_app, astra_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON astra.memory_items, astra.memory_links, astra.memory_tombstones,
  astra.experiments, astra.experiment_assignments, astra.experiment_exposures FROM PUBLIC, astra_app, astra_worker;

RESET ROLE;
COMMIT;
