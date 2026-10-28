SET ROLE astra_owner;

ALTER TABLE astra.events DROP CONSTRAINT events_event_type_check;
ALTER TABLE astra.events ADD CONSTRAINT events_event_type_check CHECK (event_type IN (
  'meeting.booked','meeting.held','meeting.cancelled','opportunity.created','opportunity.qualified',
  'opportunity.won','opportunity.lost','revenue.paid','revenue.refunded','outcome.labelled',
  'outcome.corrected','outcome.reversed','workflow.scheduled','workflow.claimed',
  'workflow.checkpointed','workflow.completed','workflow.failed','workflow.cancelled'
));

CREATE TABLE astra.workflows (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  task_key text NOT NULL CHECK (length(task_key) BETWEEN 1 AND 200),
  task_type text NOT NULL CHECK (task_type IN ('research','verification','drafting','reply_classification')),
  schema_version integer NOT NULL CHECK (schema_version=1),
  task jsonb NOT NULL CHECK (jsonb_typeof(task)='object'),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  context_manifest jsonb NOT NULL CHECK (jsonb_typeof(context_manifest)='object'),
  context_hash char(64) NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('queued','running','checkpointed','completed','failed','manual_review','cancelled')),
  priority smallint NOT NULL CHECK (priority BETWEEN 0 AND 100),
  task_class text NOT NULL CHECK (task_class IN ('interactive','suppression','standard','bulk')),
  actor_id text NOT NULL CHECK (actor_id ~ '^[1-9][0-9]{0,39}$'),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  checkpoint jsonb CHECK (checkpoint IS NULL OR jsonb_typeof(checkpoint)='object'),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,task_key),
  CHECK ((state='running') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX astra_workflows_ready ON astra.workflows(task_class,priority DESC,available_at,created_at)
  WHERE state IN ('queued','checkpointed');
CREATE INDEX astra_workflows_expired ON astra.workflows(lease_until) WHERE state='running';
ALTER TABLE astra.workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.workflows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_owner_all ON astra.workflows FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY tenant_app_scope ON astra.workflows FOR ALL TO astra_app, astra_worker
  USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id));
GRANT SELECT,INSERT,UPDATE ON astra.workflows TO astra_app,astra_worker;
REVOKE DELETE,TRUNCATE ON astra.workflows FROM PUBLIC,astra_app,astra_worker;

CREATE FUNCTION astra.guard_workflow_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Workflow records cannot be deleted.' USING ERRCODE='55000'; END IF;
  IF (NEW.tenant_id,NEW.id,NEW.task_key,NEW.task_type,NEW.schema_version,NEW.task,NEW.payload_hash,
      NEW.context_manifest,NEW.context_hash,NEW.actor_id,NEW.max_attempts,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.id,OLD.task_key,OLD.task_type,OLD.schema_version,OLD.task,OLD.payload_hash,
      OLD.context_manifest,OLD.context_hash,OLD.actor_id,OLD.max_attempts,OLD.created_at) THEN
    RAISE EXCEPTION 'Workflow identity and context are immutable.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER astra_workflow_identity_guard BEFORE UPDATE OR DELETE ON astra.workflows
  FOR EACH ROW EXECUTE FUNCTION astra.guard_workflow_identity();
RESET ROLE;
