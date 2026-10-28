-- Decision semantics, campaign-scoped autonomy, mailbox binding and fenced send tickets.
-- Additive foundation only. No transport is enabled by this migration.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.decisions (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  action text NOT NULL CHECK(action IN ('ACT','ABSTAIN','REVIEW','RESEARCH_MORE','WAIT')),
  policy_status text NOT NULL CHECK(policy_status IN ('allowed','denied','unknown')),
  target text,
  horizon text,
  conditioning jsonb NOT NULL CHECK(jsonb_typeof(conditioning)='object'),
  source_refs jsonb NOT NULL CHECK(jsonb_typeof(source_refs)='array'),
  support jsonb NOT NULL CHECK(jsonb_typeof(support)='array'),
  uncertainty jsonb,
  prediction jsonb,
  utility jsonb,
  risk jsonb,
  reversibility text NOT NULL CHECK(reversibility IN ('reversible','partially_reversible','irreversible','unknown')),
  basis text NOT NULL CHECK(length(basis) BETWEEN 1 AND 80),
  legacy_action text CHECK(legacy_action IS NULL OR legacy_action IN ('ACT','BLOCK')),
  decision_hash char(64) NOT NULL CHECK(decision_hash ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,idempotency_key),
  CHECK(policy_status<>'denied' OR action<>'ACT'),
  CHECK(prediction IS NULL OR (jsonb_typeof(prediction)='object' AND prediction ? 'calibrationVersion' AND prediction ? 'outcome' AND prediction ? 'action' AND prediction ? 'horizonDays' AND prediction ? 'cohort' AND prediction ? 'calibrationEvidence' AND prediction ? 'probability' AND prediction ? 'expiresAt'))
);
CREATE INDEX astra_decisions_recent ON astra.decisions(tenant_id,created_at DESC);

CREATE TABLE astra.campaign_authorizations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  campaign_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),
  envelope_hash char(64) NOT NULL CHECK(envelope_hash ~ '^[a-f0-9]{64}$'),
  mode text NOT NULL CHECK(mode IN ('draft','routine_auto','exception_review')),
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,campaign_id,version),
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES astra.campaigns(tenant_id,id) ON DELETE RESTRICT,
  CHECK(envelope->>'mode'=mode)
);
CREATE TABLE astra.authorization_approvals (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(), authorization_id uuid NOT NULL,
  envelope_hash char(64) NOT NULL CHECK(envelope_hash ~ '^[a-f0-9]{64}$'), approved_by text NOT NULL CHECK(approved_by ~ '^[1-9][0-9]{0,39}$'), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,authorization_id),
  FOREIGN KEY(tenant_id,authorization_id) REFERENCES astra.campaign_authorizations(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.authorization_revocations (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(), authorization_id uuid NOT NULL,
  envelope_hash char(64) NOT NULL CHECK(envelope_hash ~ '^[a-f0-9]{64}$'), reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 240),
  revoked_by text NOT NULL CHECK(revoked_by ~ '^[1-9][0-9]{0,39}$'), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,authorization_id),
  FOREIGN KEY(tenant_id,authorization_id) REFERENCES astra.campaign_authorizations(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.authorization_exception_requests (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(), authorization_id uuid NOT NULL,
  campaign_id uuid NOT NULL, recipient_id uuid NOT NULL, intent_hash char(64) NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
  intent jsonb NOT NULL CHECK(jsonb_typeof(intent)='object'), requested_by text NOT NULL CHECK(requested_by ~ '^[1-9][0-9]{0,39}$'), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,authorization_id,recipient_id,intent_hash),
  FOREIGN KEY(tenant_id,authorization_id) REFERENCES astra.campaign_authorizations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES astra.campaigns(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,recipient_id) REFERENCES astra.research_identity_candidates(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.authorization_exception_approvals (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(), request_id uuid NOT NULL,
  intent_hash char(64) NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'), approved_by text NOT NULL CHECK(approved_by ~ '^[1-9][0-9]{0,39}$'), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,request_id),
  FOREIGN KEY(tenant_id,request_id) REFERENCES astra.authorization_exception_requests(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.execution_tickets (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  campaign_id uuid NOT NULL, recipient_id uuid NOT NULL,
  action text NOT NULL CHECK(action='email.send'),
  intent_hash char(64) NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'), intent jsonb NOT NULL CHECK(jsonb_typeof(intent)='object'), recipient_hash char(64) NOT NULL CHECK(recipient_hash ~ '^[a-f0-9]{64}$'), campaign_version integer NOT NULL CHECK(campaign_version>0),
  authorization_id uuid NOT NULL, authorization_version integer NOT NULL CHECK(authorization_version>0), envelope_hash char(64) NOT NULL CHECK(envelope_hash ~ '^[a-f0-9]{64}$'),
  decision_id uuid NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 240), expires_at timestamptz NOT NULL,
  ticket_hash char(64) NOT NULL CHECK(ticket_hash ~ '^[a-f0-9]{64}$'), signature char(64) NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','claimed','succeeded','uncertain','failed')),
  fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0), lease_token uuid, lease_until timestamptz, claimed_by text,
  revoked_at timestamptz, revoke_reason text, completed_at timestamptz, provider_receipt jsonb, error_code text,
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,ticket_hash), UNIQUE(tenant_id,campaign_id,recipient_id,action,intent_hash),
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES astra.campaigns(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,recipient_id) REFERENCES astra.research_identity_candidates(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,authorization_id) REFERENCES astra.campaign_authorizations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,decision_id) REFERENCES astra.decisions(tenant_id,id) ON DELETE RESTRICT,
  CHECK((state='claimed')=(lease_token IS NOT NULL AND lease_until IS NOT NULL AND claimed_by IS NOT NULL)),
  CHECK(state NOT IN ('succeeded','uncertain','failed') OR completed_at IS NOT NULL)
);
CREATE INDEX astra_execution_tickets_pending ON astra.execution_tickets(tenant_id,created_at) WHERE state='issued' AND revoked_at IS NULL;
CREATE TABLE astra.execution_attempts (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(), ticket_id uuid NOT NULL,
  fence bigint NOT NULL CHECK(fence>0), client_idempotency_key text NOT NULL CHECK(length(client_idempotency_key) BETWEEN 1 AND 200),
  outcome text NOT NULL CHECK(outcome IN ('accepted','uncertain','rejected')), provider_receipt jsonb, error_code text,
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,ticket_id,fence), UNIQUE(tenant_id,client_idempotency_key),
  FOREIGN KEY(tenant_id,ticket_id) REFERENCES astra.execution_tickets(tenant_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION astra.autonomy_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Decision, authorization, and execution evidence is append-only.' USING ERRCODE='55000'; END $$;
CREATE FUNCTION astra.execution_ticket_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Execution tickets cannot be deleted.' USING ERRCODE='55000'; END IF;
  IF (NEW.tenant_id,NEW.id,NEW.campaign_id,NEW.recipient_id,NEW.action,NEW.intent_hash,NEW.intent,NEW.recipient_hash,NEW.campaign_version,NEW.authorization_id,NEW.authorization_version,NEW.envelope_hash,NEW.decision_id,NEW.reason,NEW.expires_at,NEW.ticket_hash,NEW.signature,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.campaign_id,OLD.recipient_id,OLD.action,OLD.intent_hash,OLD.intent,OLD.recipient_hash,OLD.campaign_version,OLD.authorization_id,OLD.authorization_version,OLD.envelope_hash,OLD.decision_id,OLD.reason,OLD.expires_at,OLD.ticket_hash,OLD.signature,OLD.created_by,OLD.created_at)
    THEN RAISE EXCEPTION 'Execution ticket authority is immutable.' USING ERRCODE='55000'; END IF;
  IF NOT ((OLD.state='issued' AND NEW.state='claimed') OR (OLD.state='claimed' AND NEW.state IN ('succeeded','uncertain','failed')) OR (OLD.state=NEW.state AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Execution ticket transition is invalid.' USING ERRCODE='55000'; END IF;
  IF NEW.fence<OLD.fence OR (NEW.state='claimed' AND NEW.fence<>OLD.fence+1) THEN RAISE EXCEPTION 'Execution ticket fencing token is invalid.' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER astra_execution_ticket_guard BEFORE UPDATE OR DELETE ON astra.execution_tickets FOR EACH ROW EXECUTE FUNCTION astra.execution_ticket_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['decisions','campaign_authorizations','authorization_approvals','authorization_revocations','authorization_exception_requests','authorization_exception_approvals','execution_attempts'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON astra.%I FOR EACH ROW EXECUTE FUNCTION astra.autonomy_immutable_guard()','astra_'||t||'_immutable',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON astra.%I FOR EACH STATEMENT EXECUTE FUNCTION astra.autonomy_immutable_guard()','astra_'||t||'_truncate',t);
 END LOOP;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['decisions','campaign_authorizations','authorization_approvals','authorization_revocations','authorization_exception_requests','authorization_exception_approvals','execution_tickets','execution_attempts'] LOOP
  EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_owner USING(true) WITH CHECK(true)',t||'_owner_all',t);
  EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING(astra.context_allows(tenant_id)) WITH CHECK(astra.context_allows(tenant_id))',t||'_tenant_scope',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON astra.decisions,astra.campaign_authorizations,astra.authorization_approvals,astra.authorization_revocations,astra.authorization_exception_requests,astra.authorization_exception_approvals,astra.execution_attempts TO astra_app,astra_worker;
GRANT SELECT,INSERT,UPDATE ON astra.execution_tickets TO astra_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.decisions,astra.campaign_authorizations,astra.authorization_approvals,astra.authorization_revocations,astra.authorization_exception_requests,astra.authorization_exception_approvals,astra.execution_attempts FROM PUBLIC,astra_app,astra_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.execution_tickets FROM PUBLIC,astra_app;
REVOKE DELETE,TRUNCATE ON astra.execution_tickets FROM astra_worker;
REVOKE ALL ON FUNCTION astra.autonomy_immutable_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.execution_ticket_guard() FROM PUBLIC;
RESET ROLE;
COMMIT;
