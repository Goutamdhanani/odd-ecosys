BEGIN;
SET ROLE astra_owner;

ALTER TABLE astra.events DROP CONSTRAINT events_event_type_check;
ALTER TABLE astra.events ADD CONSTRAINT events_event_type_check CHECK (event_type IN (
  'meeting.booked','meeting.held','meeting.cancelled',
  'opportunity.created','opportunity.qualified','opportunity.won','opportunity.lost',
  'revenue.paid','revenue.refunded','outcome.labelled','outcome.corrected','outcome.reversed',
  'campaign.created','campaign.qualified','campaign.draft_saved','campaign.approved',
  'campaign.dispatch_plan_prepared','campaign.dispatch_quarantined',
  'workflow.scheduled','workflow.claimed','workflow.checkpointed','workflow.completed',
  'workflow.failed','workflow.cancelled'
));

CREATE TABLE astra.research_workflow_requests (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 250),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  workflow_id uuid NOT NULL,
  actor_id text NOT NULL CHECK (actor_id ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,request_key),
  UNIQUE (tenant_id,workflow_id),
  FOREIGN KEY (tenant_id,workflow_id) REFERENCES astra.workflows(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE astra.research_workflow_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.research_workflow_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_owner_all ON astra.research_workflow_requests FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY tenant_app_scope ON astra.research_workflow_requests FOR ALL TO astra_app, astra_worker
  USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id));
GRANT SELECT,INSERT ON astra.research_workflow_requests TO astra_app;
GRANT SELECT ON astra.research_workflow_requests TO astra_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.research_workflow_requests FROM PUBLIC,astra_app,astra_worker;

RESET ROLE;
COMMIT;
