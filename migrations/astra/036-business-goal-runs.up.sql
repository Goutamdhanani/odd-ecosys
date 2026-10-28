-- Guided business-goal runs: durable customer-intent record with a bounded
-- planner contract and an owner-confirmed start into the existing prospecting
-- service. The app plane owns reads/writes; worker role is granted for the
-- scheduled planner step.

CREATE TABLE astra.business_goal_runs (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  brief text NOT NULL CHECK (length(brief) BETWEEN 1 AND 4000),
  status text NOT NULL CHECK (status IN
    ('draft','planned','awaiting_confirmation','running','completed','blocked','failed','cancelled')),
  plan jsonb CHECK (plan IS NULL OR jsonb_typeof(plan)='object'),
  questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(questions)='array'),
  answers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(answers)='array'),
  state_revision integer NOT NULL DEFAULT 1 CHECK (state_revision > 0),
  blocked_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocked_reasons)='array'),
  start_ref jsonb CHECK (start_ref IS NULL OR jsonb_typeof(start_ref)='object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (status NOT IN ('running','completed','failed') OR started_at IS NOT NULL)
);

ALTER TABLE astra.business_goal_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.business_goal_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY business_goal_runs_tenant_scope ON astra.business_goal_runs
  FOR ALL TO astra_app, astra_worker
  USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id));

GRANT SELECT, INSERT, UPDATE ON astra.business_goal_runs TO astra_app, astra_worker;