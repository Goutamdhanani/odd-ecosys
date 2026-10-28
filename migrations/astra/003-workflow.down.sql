SET ROLE astra_owner;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM astra.events WHERE event_type LIKE 'workflow.%') THEN
    RAISE EXCEPTION 'Cannot remove workflow event types while workflow events exist.' USING ERRCODE='55000';
  END IF;
END $$;
DROP TABLE astra.workflows;
DROP FUNCTION astra.guard_workflow_identity();
ALTER TABLE astra.events DROP CONSTRAINT events_event_type_check;
ALTER TABLE astra.events ADD CONSTRAINT events_event_type_check CHECK (event_type IN (
  'meeting.booked','meeting.held','meeting.cancelled','opportunity.created','opportunity.qualified',
  'opportunity.won','opportunity.lost','revenue.paid','revenue.refunded','outcome.labelled',
  'outcome.corrected','outcome.reversed'
));
RESET ROLE;
