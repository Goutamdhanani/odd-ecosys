-- S09-S13: tenant-scoped, append-only evidence, deterministic identity/audit, and sourced claims.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.research_sources (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  source_url text NOT NULL CHECK (length(source_url) BETWEEN 8 AND 2048),
  normalized_domain text NOT NULL CHECK (length(normalized_domain) BETWEEN 1 AND 253),
  rights_policy text NOT NULL CHECK (rights_policy IN ('synthetic_fixture','user_provided','licensed','public_terms_permitted')),
  rights_expires_at timestamptz,
  robots_allowed boolean NOT NULL CHECK (robots_allowed),
  rights_attested boolean NOT NULL CHECK (rights_attested),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,normalized_domain)
);

CREATE TABLE astra.research_blobs (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 1048576 AND octet_length(content)=byte_length),
  media_type text NOT NULL CHECK (media_type LIKE 'text/html%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,sha256)
);

CREATE TABLE astra.research_evidence (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  source_id uuid NOT NULL,
  normalized_domain text NOT NULL CHECK (length(normalized_domain) BETWEEN 1 AND 253),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz NOT NULL,
  extractor_version text NOT NULL CHECK (length(extractor_version) BETWEEN 1 AND 80),
  extracted_text text NOT NULL CHECK (length(extracted_text) <= 250000),
  document_title text NOT NULL DEFAULT '' CHECK (length(document_title) <= 500),
  headings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(headings)='array'),
  meta_description text NOT NULL DEFAULT '' CHECK (length(meta_description) <= 2000),
  extracted_emails jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(extracted_emails)='array'),
  coverage_status text NOT NULL CHECK (coverage_status='single_page_snapshot'),
  source_content_untrusted boolean NOT NULL CHECK (source_content_untrusted),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,content_sha256), UNIQUE (tenant_id,id,normalized_domain),
  FOREIGN KEY (tenant_id,source_id,normalized_domain) REFERENCES astra.research_sources(tenant_id,id,normalized_domain) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,content_sha256) REFERENCES astra.research_blobs(tenant_id,sha256) ON DELETE RESTRICT
);
CREATE INDEX astra_research_evidence_recent ON astra.research_evidence(tenant_id,captured_at DESC);
CREATE INDEX astra_research_evidence_source ON astra.research_evidence(tenant_id,source_id,captured_at DESC);

CREATE TABLE astra.research_accounts (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  normalized_domain text NOT NULL CHECK (length(normalized_domain) BETWEEN 1 AND 253),
  display_domain text NOT NULL CHECK (length(display_domain) BETWEEN 1 AND 253),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,normalized_domain), UNIQUE (tenant_id,id,normalized_domain)
);

CREATE TABLE astra.research_identity_candidates (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  account_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  normalized_domain text NOT NULL CHECK (length(normalized_domain) BETWEEN 1 AND 253),
  candidate_type text NOT NULL CHECK (candidate_type IN ('email')),
  normalized_value text NOT NULL CHECK (length(normalized_value) BETWEEN 3 AND 320),
  display_value text NOT NULL CHECK (length(display_value) BETWEEN 3 AND 320),
  exact_excerpt text NOT NULL CHECK (length(exact_excerpt) BETWEEN 1 AND 1000),
  verification_state text NOT NULL CHECK (verification_state='unverified'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,account_id,evidence_id,candidate_type,normalized_value),
  FOREIGN KEY (tenant_id,account_id,normalized_domain) REFERENCES astra.research_accounts(tenant_id,id,normalized_domain) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,evidence_id,normalized_domain) REFERENCES astra.research_evidence(tenant_id,id,normalized_domain) ON DELETE RESTRICT
);

CREATE TABLE astra.research_audits (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  evidence_id uuid NOT NULL,
  audit_version text NOT NULL CHECK (length(audit_version) BETWEEN 1 AND 80),
  coverage_status text NOT NULL CHECK (coverage_status='partial'),
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,evidence_id) REFERENCES astra.research_evidence(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.research_claims (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  evidence_id uuid NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  subject_key text NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 300),
  predicate text NOT NULL CHECK (length(predicate) BETWEEN 1 AND 120),
  claim_value text NOT NULL CHECK (length(claim_value) BETWEEN 1 AND 2000),
  exact_excerpt text NOT NULL CHECK (length(exact_excerpt) BETWEEN 1 AND 1000),
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('supported','abstained')),
  abstain_reason text CHECK (abstain_reason IN ('proof_mismatch','claim_value_not_literal_in_excerpt','source_rights_expired_or_shorter_than_claim','contradictory_active_claim')),
  contradicts_claim_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,evidence_id,content_sha256) REFERENCES astra.research_evidence(tenant_id,id,content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,contradicts_claim_id) REFERENCES astra.research_claims(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((status='supported' AND abstain_reason IS NULL) OR (status='abstained' AND abstain_reason IS NOT NULL)),
  CHECK ((abstain_reason='contradictory_active_claim') = (contradicts_claim_id IS NOT NULL))
);
CREATE INDEX astra_research_claim_lookup ON astra.research_claims(tenant_id,subject_key,predicate,expires_at DESC);

CREATE TABLE astra.research_claim_corrections (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  claim_id uuid NOT NULL,
  correction_type text NOT NULL CHECK (correction_type IN ('corrected','retracted')),
  replacement_value text CHECK (replacement_value IS NULL OR length(replacement_value) BETWEEN 1 AND 2000),
  evidence_id uuid,
  content_sha256 char(64) CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),
  exact_excerpt text CHECK (exact_excerpt IS NULL OR length(exact_excerpt) BETWEEN 1 AND 1000),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,claim_id) REFERENCES astra.research_claims(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,evidence_id,content_sha256) REFERENCES astra.research_evidence(tenant_id,id,content_sha256) ON DELETE RESTRICT,
  CHECK ((correction_type='corrected' AND replacement_value IS NOT NULL AND evidence_id IS NOT NULL AND content_sha256 IS NOT NULL AND exact_excerpt IS NOT NULL)
    OR (correction_type='retracted' AND replacement_value IS NULL AND evidence_id IS NULL AND content_sha256 IS NULL AND exact_excerpt IS NULL))
);

CREATE TABLE astra.research_reports (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  workflow_id uuid NOT NULL,
  report jsonb NOT NULL CHECK (jsonb_typeof(report)='object'),
  report_sha256 char(64) NOT NULL CHECK (report_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,workflow_id),
  FOREIGN KEY (tenant_id,workflow_id) REFERENCES astra.workflows(tenant_id,id) ON DELETE RESTRICT
);

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['research_sources','research_blobs','research_evidence','research_accounts','research_identity_candidates','research_audits','research_claims','research_claim_corrections','research_reports'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_owner USING (true) WITH CHECK (true)',t||'_owner_all',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))',t||'_tenant_scope',t);
    EXECUTE format('REVOKE ALL ON astra.%I FROM PUBLIC',t);
    EXECUTE format('GRANT SELECT,INSERT ON astra.%I TO astra_app,astra_worker',t);
  END LOOP;
END
$rls$;

CREATE FUNCTION astra.research_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Research evidence records are append-only.' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION astra.research_append_only_guard() FROM PUBLIC;
DO $append_only$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['research_sources','research_blobs','research_evidence','research_identity_candidates','research_audits','research_claims','research_claim_corrections','research_reports'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON astra.%I FOR EACH ROW EXECUTE FUNCTION astra.research_append_only_guard()',t||'_append_only',t);
  END LOOP;
END
$append_only$;

RESET ROLE;
COMMIT;
