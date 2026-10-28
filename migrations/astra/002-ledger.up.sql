SET ROLE astra_owner;

CREATE TABLE astra.ledger_heads (
  tenant_id uuid PRIMARY KEY REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_hash char(64) NOT NULL CHECK (last_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE astra.events (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  event_type text NOT NULL CHECK (event_type IN (
    'meeting.booked','meeting.held','meeting.cancelled',
    'opportunity.created','opportunity.qualified','opportunity.won','opportunity.lost',
    'revenue.paid','revenue.refunded','outcome.labelled','outcome.corrected','outcome.reversed'
  )),
  entity_type text NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 80),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 500),
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  corrects_event_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 250),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  previous_hash char(64) NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  event_hash char(64) NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,sequence),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,corrects_event_id) REFERENCES astra.events(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((event_type IN ('outcome.corrected','outcome.reversed')) = (corrects_event_id IS NOT NULL))
);
CREATE INDEX astra_events_entity_sequence ON astra.events(tenant_id,entity_type,entity_id,sequence);
CREATE INDEX astra_events_recorded ON astra.events(tenant_id,recorded_at,sequence);
CREATE UNIQUE INDEX astra_events_external_event_dedupe ON astra.events
  (tenant_id,(provenance->>'source'),(provenance->>'externalEventId'))
  WHERE provenance ? 'externalEventId' AND provenance->>'externalEventId' IS NOT NULL;

CREATE TABLE astra.event_outbox (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  sequence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,event_id),
  UNIQUE (tenant_id,sequence),
  FOREIGN KEY (tenant_id,event_id) REFERENCES astra.events(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.consumer_receipts (
  tenant_id uuid NOT NULL,
  consumer text NOT NULL CHECK (length(consumer) BETWEEN 1 AND 120),
  event_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  PRIMARY KEY (tenant_id,consumer,event_id),
  FOREIGN KEY (tenant_id,event_id) REFERENCES astra.events(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.outcome_projection (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  latest_event_id uuid,
  latest_sequence bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,entity_type,entity_id),
  FOREIGN KEY (tenant_id,latest_event_id) REFERENCES astra.events(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_outcome_projection_latest ON astra.outcome_projection(tenant_id,latest_sequence DESC);

CREATE FUNCTION astra.check_event_chain_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, astra AS $$
DECLARE v_last_seq bigint; v_last_hash char(64);
BEGIN
  SELECT last_seq,last_hash INTO v_last_seq,v_last_hash FROM astra.ledger_heads
    WHERE tenant_id=NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR NEW.sequence <> v_last_seq + 1 OR NEW.previous_hash <> v_last_hash THEN
    RAISE EXCEPTION 'Astra event does not extend the tenant ledger head.' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION astra.advance_event_chain_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, astra AS $$
BEGIN
  UPDATE astra.ledger_heads SET last_seq=NEW.sequence,last_hash=NEW.event_hash,updated_at=pg_catalog.clock_timestamp()
    WHERE tenant_id=NEW.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Astra tenant ledger head is missing.' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER astra_event_chain_guard BEFORE INSERT ON astra.events
  FOR EACH ROW EXECUTE FUNCTION astra.check_event_chain_before_insert();
CREATE TRIGGER astra_event_chain_advance AFTER INSERT ON astra.events
  FOR EACH ROW EXECUTE FUNCTION astra.advance_event_chain_after_insert();

CREATE FUNCTION astra.reject_immutable_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Astra ledger rows are append-only; append a correction or reversal event.'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER astra_events_immutable BEFORE UPDATE OR DELETE ON astra.events
  FOR EACH ROW EXECUTE FUNCTION astra.reject_immutable_ledger_mutation();
CREATE TRIGGER astra_outbox_immutable BEFORE UPDATE OR DELETE ON astra.event_outbox
  FOR EACH ROW EXECUTE FUNCTION astra.reject_immutable_ledger_mutation();
CREATE TRIGGER astra_receipts_immutable BEFORE UPDATE OR DELETE ON astra.consumer_receipts
  FOR EACH ROW EXECUTE FUNCTION astra.reject_immutable_ledger_mutation();
CREATE TRIGGER astra_events_no_truncate BEFORE TRUNCATE ON astra.events
  FOR EACH STATEMENT EXECUTE FUNCTION astra.reject_immutable_ledger_mutation();
CREATE TRIGGER astra_outbox_no_truncate BEFORE TRUNCATE ON astra.event_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION astra.reject_immutable_ledger_mutation();
CREATE TRIGGER astra_receipts_no_truncate BEFORE TRUNCATE ON astra.consumer_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION astra.reject_immutable_ledger_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ledger_heads','events','event_outbox','consumer_receipts','outcome_projection'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_owner_all ON astra.%I FOR ALL TO astra_owner USING (true) WITH CHECK (true)', table_name);
    EXECUTE format('CREATE POLICY tenant_app_scope ON astra.%I FOR ALL TO astra_app, astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))', table_name);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE, TRUNCATE ON astra.events, astra.event_outbox, astra.consumer_receipts FROM PUBLIC, astra_app, astra_worker;
GRANT SELECT, INSERT ON astra.events, astra.event_outbox, astra.consumer_receipts TO astra_app, astra_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON astra.ledger_heads FROM PUBLIC, astra_app, astra_worker;
GRANT SELECT, INSERT ON astra.ledger_heads TO astra_app, astra_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON astra.outcome_projection TO astra_app, astra_worker;

RESET ROLE;

