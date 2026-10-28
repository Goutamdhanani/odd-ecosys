-- Tenant connector credentials, provenance and trusted provider receipts.
-- All transports remain disabled unless a server operator explicitly enables them.
BEGIN;
SET ROLE astra_owner;

ALTER TABLE astra.mailboxes DROP CONSTRAINT IF EXISTS mailboxes_provider_check;
ALTER TABLE astra.mailboxes ADD CONSTRAINT mailboxes_provider_check CHECK (provider IN ('manual','unknown','smtp_imap'));

CREATE TABLE astra.connector_configs (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('reacher','smtp_imap','twenty')),
  connector_key text NOT NULL CHECK (length(connector_key) BETWEEN 1 AND 120),
  endpoint_host text CHECK (endpoint_host IS NULL OR length(endpoint_host) BETWEEN 1 AND 253),
  public_config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(public_config)='object'),
  credentials_ciphertext text NOT NULL CHECK (length(credentials_ciphertext) BETWEEN 1 AND 20000),
  credential_fingerprint char(64) NOT NULL CHECK (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  approval jsonb NOT NULL CHECK (jsonb_typeof(approval)='object'),
  state text NOT NULL DEFAULT 'configured' CHECK (state IN ('configured','disabled','revoked')),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,provider,connector_key)
);

CREATE TABLE astra.connector_evidence (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  connector_id uuid NOT NULL,
  mailbox_id uuid,
  capability text NOT NULL CHECK (length(capability) BETWEEN 1 AND 80),
  outcome text NOT NULL CHECK (outcome IN ('supported','unsupported','unknown','denied')),
  source text NOT NULL CHECK (source IN ('provider_probe','operator_approval','provider_receipt','manual_ingest')),
  environment text NOT NULL CHECK (environment IN ('provider_observed','synthetic','operator_attested')),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance)='object'),
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,connector_id) REFERENCES astra.connector_configs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,mailbox_id) REFERENCES astra.mailboxes(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.mailbox_connectors (
  tenant_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  provider_mailbox_id text NOT NULL CHECK (length(provider_mailbox_id) BETWEEN 1 AND 500),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,mailbox_id), UNIQUE (tenant_id,connector_id,provider_mailbox_id),
  FOREIGN KEY (tenant_id,mailbox_id) REFERENCES astra.mailboxes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,connector_id) REFERENCES astra.connector_configs(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.connector_jobs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  connector_id uuid NOT NULL,
  mailbox_id uuid,
  candidate_id uuid,
  job_type text NOT NULL CHECK (job_type IN ('probe_mailbox','sync_mailbox','verify_candidate')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','attempting','completed','failed','uncertain','blocked')),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  diagnostic_code text CHECK (diagnostic_code IS NULL OR diagnostic_code ~ '^[a-z0-9_]{1,120}$'),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,connector_id) REFERENCES astra.connector_configs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,mailbox_id) REFERENCES astra.mailboxes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,candidate_id) REFERENCES astra.research_identity_candidates(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((job_type IN ('probe_mailbox','sync_mailbox') AND mailbox_id IS NOT NULL AND candidate_id IS NULL)
      OR (job_type='verify_candidate' AND candidate_id IS NOT NULL AND mailbox_id IS NULL))
);
CREATE INDEX astra_connector_jobs_queue ON astra.connector_jobs(tenant_id,state,created_at);

-- The adapter receipt binds the provider's positive result to one exact candidate
-- address digest and immutable response digest. Callers cannot forge this row.
CREATE TABLE astra.verification_adapter_receipts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  candidate_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider='reacher'),
  address_sha256 char(64) NOT NULL CHECK (address_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_sha256 char(64) NOT NULL CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  classification text NOT NULL CHECK (classification IN ('verified','invalid','catch_all','stale','unknown')),
  environment text NOT NULL CHECK (environment IN ('provider_observed','synthetic')),
  provider_status text NOT NULL CHECK (length(provider_status) BETWEEN 1 AND 80),
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,provider,receipt_sha256),
  FOREIGN KEY (tenant_id,candidate_id) REFERENCES astra.research_identity_candidates(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,connector_id) REFERENCES astra.connector_configs(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE astra.campaign_verification_records DROP CONSTRAINT IF EXISTS campaign_verification_records_classification_check;
ALTER TABLE astra.campaign_verification_records ADD CONSTRAINT campaign_verification_records_classification_check
  CHECK (classification IN ('unknown','catch_all','stale','invalid','manual_review_pending','verified'));
ALTER TABLE astra.campaign_verification_records ADD COLUMN adapter_receipt_id uuid;
ALTER TABLE astra.campaign_verification_records ADD COLUMN address_sha256 char(64) CHECK (address_sha256 IS NULL OR address_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE astra.campaign_verification_records ADD CONSTRAINT campaign_verification_adapter_receipt_fk
  FOREIGN KEY (tenant_id,adapter_receipt_id) REFERENCES astra.verification_adapter_receipts(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE astra.campaign_verification_records ADD CONSTRAINT campaign_verification_positive_requires_receipt
  CHECK (classification <> 'verified' OR (adapter_receipt_id IS NOT NULL AND address_sha256 IS NOT NULL));

CREATE TABLE astra.crm_webhook_receipts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  connector_id uuid NOT NULL,
  external_event_id text NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 500),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  imported_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,connector_id,external_event_id),
  FOREIGN KEY (tenant_id,connector_id) REFERENCES astra.connector_configs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,imported_event_id) REFERENCES astra.events(tenant_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION astra.connector_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Connector evidence and provider receipts are append-only.' USING ERRCODE='55000'; END $$;
CREATE FUNCTION astra.connector_config_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connector configuration cannot be deleted.' USING ERRCODE='55000'; END IF;
  IF (NEW.tenant_id,NEW.id,NEW.provider,NEW.connector_key,NEW.created_by,NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.provider,OLD.connector_key,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Connector identity is immutable.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION astra.connector_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connector jobs cannot be deleted.' USING ERRCODE='55000'; END IF;
  IF (NEW.tenant_id,NEW.id,NEW.connector_id,NEW.mailbox_id,NEW.candidate_id,NEW.job_type,NEW.payload,NEW.created_by,NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.connector_id,OLD.mailbox_id,OLD.candidate_id,OLD.job_type,OLD.payload,OLD.created_by,OLD.created_at)
     OR NOT ((OLD.state='queued' AND NEW.state IN ('attempting','failed','blocked')) OR (OLD.state='attempting' AND NEW.state IN ('completed','failed','uncertain','blocked'))) THEN
    RAISE EXCEPTION 'Connector job identity or state transition is invalid.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION astra.guard_campaign_verification_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt astra.verification_adapter_receipts%ROWTYPE;
BEGIN
  IF NEW.classification='verified' THEN
    SELECT * INTO receipt FROM astra.verification_adapter_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.adapter_receipt_id;
    IF NOT FOUND OR receipt.candidate_id<>NEW.candidate_id OR receipt.address_sha256<>NEW.address_sha256
      OR receipt.classification<>'verified' OR receipt.environment<>'provider_observed' OR receipt.expires_at<=now() THEN
      RAISE EXCEPTION 'Verified evidence requires a current provider-observed receipt bound to the exact candidate and address.' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER astra_connector_config_guard BEFORE UPDATE OR DELETE ON astra.connector_configs FOR EACH ROW EXECUTE FUNCTION astra.connector_config_guard();
CREATE TRIGGER astra_connector_job_guard BEFORE UPDATE OR DELETE ON astra.connector_jobs FOR EACH ROW EXECUTE FUNCTION astra.connector_job_guard();
CREATE TRIGGER astra_campaign_verification_receipt_guard BEFORE INSERT ON astra.campaign_verification_records FOR EACH ROW EXECUTE FUNCTION astra.guard_campaign_verification_receipt();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['connector_evidence','mailbox_connectors','verification_adapter_receipts','crm_webhook_receipts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON astra.%I FOR EACH ROW EXECUTE FUNCTION astra.connector_append_only_guard()', 'astra_'||t||'_immutable',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON astra.%I FOR EACH STATEMENT EXECUTE FUNCTION astra.connector_append_only_guard()', 'astra_'||t||'_no_truncate',t);
  END LOOP;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['connector_configs','connector_evidence','mailbox_connectors','connector_jobs','verification_adapter_receipts','crm_webhook_receipts'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_owner USING (true) WITH CHECK (true)',t||'_owner_all',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))',t||'_tenant_scope',t);
  END LOOP;
END $$;
GRANT INSERT,UPDATE ON astra.connector_configs TO astra_app,astra_worker;
GRANT SELECT ON astra.connector_configs TO astra_worker;
GRANT SELECT (tenant_id,id,provider,connector_key,endpoint_host,public_config,credential_fingerprint,approval,state,created_by,created_at,updated_at) ON astra.connector_configs TO astra_app;
GRANT SELECT,INSERT ON astra.mailbox_connectors TO astra_app,astra_worker;
GRANT SELECT,INSERT ON astra.connector_jobs TO astra_app;
GRANT SELECT,INSERT,UPDATE ON astra.connector_jobs TO astra_worker;
GRANT SELECT ON astra.connector_evidence,astra.verification_adapter_receipts TO astra_app;
GRANT SELECT,INSERT ON astra.connector_evidence,astra.verification_adapter_receipts TO astra_worker;
GRANT SELECT,INSERT ON astra.crm_webhook_receipts TO astra_app,astra_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.mailbox_connectors FROM PUBLIC,astra_app,astra_worker;
REVOKE DELETE,TRUNCATE ON astra.connector_configs,astra.connector_evidence,astra.connector_jobs,astra.verification_adapter_receipts,astra.crm_webhook_receipts FROM PUBLIC,astra_app,astra_worker;
REVOKE UPDATE ON astra.connector_evidence,astra.verification_adapter_receipts,astra.crm_webhook_receipts FROM PUBLIC,astra_app,astra_worker;
REVOKE INSERT ON astra.connector_evidence,astra.verification_adapter_receipts FROM astra_app;
REVOKE ALL ON FUNCTION astra.connector_append_only_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.connector_config_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.connector_job_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_campaign_verification_receipt() FROM PUBLIC;
RESET ROLE;
COMMIT;
