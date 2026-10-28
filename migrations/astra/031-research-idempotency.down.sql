BEGIN;
SET ROLE astra_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM astra.events WHERE event_type LIKE 'campaign.%') THEN
    RAISE EXCEPTION 'Cannot remove campaign event types while campaign events exist.' USING ERRCODE='55000';
  END IF;
END $$;

DROP TABLE astra.research_workflow_requests;

ALTER TABLE astra.events DROP CONSTRAINT events_event_type_check;
ALTER TABLE astra.events ADD CONSTRAINT events_event_type_check CHECK (event_type IN (
  'meeting.booked','meeting.held','meeting.cancelled',
  'opportunity.created','opportunity.qualified','opportunity.won','opportunity.lost',
  'revenue.paid','revenue.refunded','outcome.labelled','outcome.corrected','outcome.reversed',
  'workflow.scheduled','workflow.claimed','workflow.checkpointed','workflow.completed',
  'workflow.failed','workflow.cancelled'
));

RESET ROLE;
COMMIT;
