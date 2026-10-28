SET ROLE astra_owner;

DROP TABLE IF EXISTS astra.outcome_projection;
DROP TABLE IF EXISTS astra.consumer_receipts;
DROP TABLE IF EXISTS astra.event_outbox;
DROP TABLE IF EXISTS astra.events;
DROP TABLE IF EXISTS astra.ledger_heads;
DROP FUNCTION IF EXISTS astra.reject_immutable_ledger_mutation();
DROP FUNCTION IF EXISTS astra.advance_event_chain_after_insert();
DROP FUNCTION IF EXISTS astra.check_event_chain_before_insert();

RESET ROLE;

