-- S14/S15/S18/S19/S20 tenant-scoped campaign pipeline. Plans are offline only.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.campaigns (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','paused','stopped')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  offer_version_id bigint NOT NULL CHECK (offer_version_id > 0),
  offer_content jsonb NOT NULL CHECK (jsonb_typeof(offer_content)='object'),
  offer_content_hash char(64) NOT NULL CHECK (offer_content_hash ~ '^[a-f0-9]{64}$'),
  mailbox_id uuid NOT NULL,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 120),
  geography jsonb NOT NULL CHECK (jsonb_typeof(geography)='array'),
  schedule_at timestamptz,
  spend_limit_minor bigint NOT NULL CHECK (spend_limit_minor BETWEEN 0 AND 100000000000),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  copy_version integer NOT NULL DEFAULT 0 CHECK (copy_version >= 0),
  subject text CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 100),
  body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 4000),
  claims_map jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(claims_map)='array'),
  copy_hash char(64) CHECK (copy_hash IS NULL OR copy_hash ~ '^[a-f0-9]{64}$'),
  audience_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(audience_snapshot)='array'),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,mailbox_id) REFERENCES astra.mailboxes(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_campaigns_recent ON astra.campaigns(tenant_id,created_at DESC);

CREATE TABLE astra.campaign_qualifications (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  campaign_id uuid NOT NULL,
  account_id uuid NOT NULL,
  candidate_id uuid,
  status text NOT NULL CHECK (status IN ('fit','blocked')),
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons)='array'),
  claim_refs jsonb NOT NULL CHECK (jsonb_typeof(claim_refs)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,campaign_id,account_id), UNIQUE (tenant_id,campaign_id,candidate_id),
  FOREIGN KEY (tenant_id,campaign_id) REFERENCES astra.campaigns(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,account_id) REFERENCES astra.research_accounts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,candidate_id) REFERENCES astra.research_identity_candidates(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_campaign_qualifications_candidate ON astra.campaign_qualifications(tenant_id,campaign_id,candidate_id);

CREATE TABLE astra.campaign_verification_records (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  campaign_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 120),
  classification text NOT NULL CHECK (classification IN ('unknown','catch_all','stale','invalid','manual_review_pending')),
  expires_at timestamptz NOT NULL,
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 1000),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,campaign_id,candidate_id) REFERENCES astra.campaign_qualifications(tenant_id,campaign_id,candidate_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,candidate_id) REFERENCES astra.research_identity_candidates(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,evidence_id) REFERENCES astra.research_evidence(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_campaign_verification_latest ON astra.campaign_verification_records(tenant_id,campaign_id,candidate_id,created_at DESC);

CREATE TABLE astra.campaign_approvals (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  campaign_id uuid NOT NULL,
  campaign_version integer NOT NULL CHECK (campaign_version > 0),
  approval_hash char(64) NOT NULL CHECK (approval_hash ~ '^[a-f0-9]{64}$'),
  offer_version_id bigint NOT NULL CHECK (offer_version_id > 0),
  offer_content_hash char(64) NOT NULL CHECK (offer_content_hash ~ '^[a-f0-9]{64}$'),
  copy_hash char(64) NOT NULL CHECK (copy_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  approved_by text NOT NULL CHECK (approved_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,campaign_id) REFERENCES astra.campaigns(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_campaign_approvals_current ON astra.campaign_approvals(tenant_id,campaign_id,expires_at DESC);

CREATE TABLE astra.campaign_dispatch_plans (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  campaign_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  plan_hash char(64) NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object'),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,campaign_id,idempotency_key),
  FOREIGN KEY (tenant_id,campaign_id) REFERENCES astra.campaigns(tenant_id,id) ON DELETE RESTRICT,
  CHECK (plan->>'liveTransport'='disabled')
);

-- Claim is a durable single-use fence record. This schema intentionally has
-- no transition to a transport-ready state; this release always quarantines.
CREATE TABLE astra.campaign_dispatch_claims (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  campaign_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  fence bigint NOT NULL CHECK (fence > 0),
  claim_token uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  state text NOT NULL CHECK (state='quarantined'),
  blockers jsonb NOT NULL CHECK (jsonb_typeof(blockers)='array'),
  claimed_by text NOT NULL CHECK (claimed_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,plan_id), UNIQUE (tenant_id,campaign_id,idempotency_key),
  FOREIGN KEY (tenant_id,campaign_id) REFERENCES astra.campaigns(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,plan_id) REFERENCES astra.campaign_dispatch_plans(tenant_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION astra.campaign_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Campaign evidence, approvals, and offline dispatch plans are append-only.' USING ERRCODE='55000';
END $$;
CREATE FUNCTION astra.campaign_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Campaign records cannot be deleted.' USING ERRCODE='55000'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Campaign identity is immutable.' USING ERRCODE='55000';
  END IF;
  IF (NEW.name,NEW.offer_version_id,NEW.offer_content,NEW.offer_content_hash,NEW.mailbox_id,NEW.purpose,NEW.geography,NEW.schedule_at,
      NEW.spend_limit_minor,NEW.currency,NEW.copy_version,NEW.subject,NEW.body,NEW.claims_map,NEW.copy_hash,NEW.audience_snapshot)
     IS DISTINCT FROM
     (OLD.name,OLD.offer_version_id,OLD.offer_content,OLD.offer_content_hash,OLD.mailbox_id,OLD.purpose,OLD.geography,OLD.schedule_at,
      OLD.spend_limit_minor,OLD.currency,OLD.copy_version,OLD.subject,OLD.body,OLD.claims_map,OLD.copy_hash,OLD.audience_snapshot)
     AND NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Material campaign changes require a new version.' USING ERRCODE='55000';
  END IF;
  IF NEW.version<OLD.version OR NEW.state NOT IN ('draft','paused','stopped') THEN
    RAISE EXCEPTION 'Campaign version and state transition are invalid.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER astra_campaign_row_guard BEFORE UPDATE OR DELETE ON astra.campaigns FOR EACH ROW EXECUTE FUNCTION astra.campaign_row_guard();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['campaign_qualifications','campaign_verification_records','campaign_approvals','campaign_dispatch_plans','campaign_dispatch_claims'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON astra.%I FOR EACH ROW EXECUTE FUNCTION astra.campaign_immutable_guard()', 'astra_'||t||'_immutable',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON astra.%I FOR EACH STATEMENT EXECUTE FUNCTION astra.campaign_immutable_guard()', 'astra_'||t||'_no_truncate',t);
  END LOOP;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns','campaign_qualifications','campaign_verification_records','campaign_approvals','campaign_dispatch_plans','campaign_dispatch_claims'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_owner USING (true) WITH CHECK (true)',t||'_owner_all',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))',t||'_tenant_scope',t);
  END LOOP;
END $$;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.campaign_qualifications,astra.campaign_verification_records,astra.campaign_approvals,astra.campaign_dispatch_plans,astra.campaign_dispatch_claims FROM PUBLIC,astra_app,astra_worker;
GRANT SELECT,INSERT,UPDATE ON astra.campaigns,astra.campaign_qualifications TO astra_app,astra_worker;
GRANT SELECT,INSERT ON astra.campaign_verification_records,astra.campaign_approvals,astra.campaign_dispatch_plans,astra.campaign_dispatch_claims TO astra_app,astra_worker;
REVOKE DELETE,TRUNCATE ON astra.campaigns,astra.campaign_qualifications FROM PUBLIC,astra_app,astra_worker;
REVOKE UPDATE ON astra.campaign_verification_records,astra.campaign_approvals,astra.campaign_dispatch_plans,astra.campaign_dispatch_claims FROM PUBLIC,astra_app,astra_worker;
REVOKE ALL ON FUNCTION astra.campaign_immutable_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.campaign_row_guard() FROM PUBLIC;
RESET ROLE;
COMMIT;
