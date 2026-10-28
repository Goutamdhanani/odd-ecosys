-- S34/X13: immutable, tenant-scoped benchmark cohorts and observed evidence.
-- Additive only. No benchmark is run and no model/provider egress is enabled.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.economics_benchmark_cohorts (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  target_accounts integer NOT NULL CHECK(target_accounts BETWEEN 500 AND 1000),
  eligible_accounts integer NOT NULL CHECK(eligible_accounts >= 0),
  permitted_accounts integer NOT NULL CHECK(permitted_accounts BETWEEN 0 AND 1000),
  shortfall integer NOT NULL CHECK(shortfall BETWEEN 0 AND 1000),
  evidence_age_days integer NOT NULL CHECK(evidence_age_days BETWEEN 1 AND 3650),
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  prepared_by text NOT NULL CHECK(prepared_by ~ '^[1-9][0-9]{0,39}$'),
  prepared_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,id),
  CHECK(shortfall=GREATEST(0,target_accounts-permitted_accounts)),
  CHECK(permitted_accounts<=eligible_accounts),
  CHECK(jsonb_typeof(manifest->'members')='array' AND jsonb_array_length(manifest->'members')=permitted_accounts)
);

CREATE TABLE astra.economics_benchmark_cohort_members (
  tenant_id uuid NOT NULL,
  cohort_id uuid NOT NULL,
  account_id uuid NOT NULL,
  normalized_domain text NOT NULL CHECK(length(normalized_domain) BETWEEN 1 AND 253),
  source_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_captured_at timestamptz NOT NULL,
  rights_policy text NOT NULL CHECK(rights_policy IN ('user_provided','licensed','public_terms_permitted')),
  rights_expires_at timestamptz,
  source_rights_sha256 char(64) NOT NULL CHECK(source_rights_sha256 ~ '^[a-f0-9]{64}$'),
  member_sha256 char(64) NOT NULL CHECK(member_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(tenant_id,cohort_id,account_id),
  UNIQUE(tenant_id,cohort_id,account_id,evidence_id),
  FOREIGN KEY(tenant_id,cohort_id) REFERENCES astra.economics_benchmark_cohorts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,account_id,normalized_domain) REFERENCES astra.research_accounts(tenant_id,id,normalized_domain) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,source_id) REFERENCES astra.research_sources(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,evidence_id,evidence_sha256) REFERENCES astra.research_evidence(tenant_id,id,content_sha256) ON DELETE RESTRICT
);
CREATE INDEX astra_benchmark_cohort_recent ON astra.economics_benchmark_cohorts(tenant_id,prepared_at DESC,id);

CREATE FUNCTION astra.check_economics_benchmark_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c astra.economics_benchmark_cohorts%ROWTYPE; s astra.research_sources%ROWTYPE; e astra.research_evidence%ROWTYPE;
BEGIN
  SELECT * INTO c FROM astra.economics_benchmark_cohorts WHERE tenant_id=NEW.tenant_id AND id=NEW.cohort_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(c.manifest->'members') m
    WHERE m->>'accountId'=NEW.account_id::text AND m->>'normalizedDomain'=NEW.normalized_domain
      AND m->>'sourceId'=NEW.source_id::text AND m->>'evidenceId'=NEW.evidence_id::text
      AND m->>'evidenceSha256'=trim(NEW.evidence_sha256) AND m->>'memberSha256'=trim(NEW.member_sha256)
      AND m->>'sourceRightsSha256'=trim(NEW.source_rights_sha256)
  ) THEN RAISE EXCEPTION 'Benchmark member does not match the frozen cohort manifest.' USING ERRCODE='23514'; END IF;
  SELECT * INTO s FROM astra.research_sources WHERE tenant_id=NEW.tenant_id AND id=NEW.source_id;
  SELECT * INTO e FROM astra.research_evidence WHERE tenant_id=NEW.tenant_id AND id=NEW.evidence_id;
  IF NOT FOUND OR s.normalized_domain IS DISTINCT FROM NEW.normalized_domain OR s.rights_policy IS DISTINCT FROM NEW.rights_policy
    OR date_trunc('milliseconds',s.rights_expires_at) IS DISTINCT FROM date_trunc('milliseconds',NEW.rights_expires_at) OR NOT s.rights_attested OR NOT s.robots_allowed
    OR s.rights_policy NOT IN ('user_provided','licensed','public_terms_permitted')
    OR (s.rights_expires_at IS NOT NULL AND s.rights_expires_at<=c.prepared_at)
    OR e.source_id IS DISTINCT FROM NEW.source_id OR e.normalized_domain IS DISTINCT FROM NEW.normalized_domain
    OR e.content_sha256 IS DISTINCT FROM NEW.evidence_sha256 OR date_trunc('milliseconds',e.captured_at) IS DISTINCT FROM date_trunc('milliseconds',NEW.evidence_captured_at)
    OR e.captured_at<c.prepared_at-(c.evidence_age_days*interval '1 day') THEN
    RAISE EXCEPTION 'Benchmark member source rights or evidence is not current and permitted.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER economics_benchmark_member_binding BEFORE INSERT ON astra.economics_benchmark_cohort_members
  FOR EACH ROW EXECUTE FUNCTION astra.check_economics_benchmark_member();

CREATE TABLE astra.economics_benchmark_observations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  cohort_id uuid NOT NULL,
  account_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  source_kind text NOT NULL CHECK(source_kind IN ('generation','connector','workflow')),
  domain_job_id uuid,
  workflow_state text NOT NULL CHECK(workflow_state IN ('queued','running','checkpointed','completed','failed','manual_review','cancelled')),
  source_sha256 char(64) NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  metrics jsonb NOT NULL CHECK(jsonb_typeof(metrics)='object'),
  metrics_sha256 char(64) NOT NULL CHECK(metrics_sha256 ~ '^[a-f0-9]{64}$'),
  queue_wait_ms bigint CHECK(queue_wait_ms IS NULL OR queue_wait_ms BETWEEN 0 AND 9000000000000),
  runtime_ms bigint CHECK(runtime_ms IS NULL OR runtime_ms BETWEEN 0 AND 9000000000000),
  actual_cost_microusd bigint CHECK(actual_cost_microusd IS NULL OR actual_cost_microusd BETWEEN 0 AND 9000000000000000),
  reviewer_minutes integer CHECK(reviewer_minutes IS NULL OR reviewer_minutes BETWEEN 0 AND 100000000),
  observed_at timestamptz NOT NULL,
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,cohort_id,workflow_id),
  UNIQUE(tenant_id,cohort_id,account_id),
  FOREIGN KEY(tenant_id,cohort_id) REFERENCES astra.economics_benchmark_cohorts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,cohort_id,account_id,evidence_id) REFERENCES astra.economics_benchmark_cohort_members(tenant_id,cohort_id,account_id,evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,workflow_id) REFERENCES astra.workflows(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_benchmark_observations_cost ON astra.economics_benchmark_observations(tenant_id,cohort_id,actual_cost_microusd)
  WHERE actual_cost_microusd IS NOT NULL;

CREATE TABLE astra.economics_benchmark_reports (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  cohort_id uuid NOT NULL,
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object'),
  report_sha256 char(64) NOT NULL CHECK(report_sha256 ~ '^[a-f0-9]{64}$'),
  actual_cost_samples integer NOT NULL CHECK(actual_cost_samples>=0),
  quota_ceiling_microusd bigint CHECK(quota_ceiling_microusd IS NULL OR quota_ceiling_microusd BETWEEN 0 AND 9000000000000000),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,cohort_id) REFERENCES astra.economics_benchmark_cohorts(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_benchmark_reports_recent ON astra.economics_benchmark_reports(tenant_id,cohort_id,created_at DESC,id);

CREATE TABLE astra.economics_benchmark_quotes (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  cohort_id uuid NOT NULL,
  vendor text NOT NULL CHECK(length(vendor) BETWEEN 1 AND 120),
  evidence_reference text NOT NULL CHECK(length(evidence_reference) BETWEEN 1 AND 2000),
  evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_provenance jsonb NOT NULL CHECK(jsonb_typeof(evidence_provenance)='object'),
  provenance_sha256 char(64) NOT NULL CHECK(provenance_sha256 ~ '^[a-f0-9]{64}$'),
  quote_sha256 char(64) NOT NULL CHECK(quote_sha256 ~ '^[a-f0-9]{64}$'),
  amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 0 AND 9000000000000000),
  currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  unit text NOT NULL CHECK(length(unit) BETWEEN 1 AND 80),
  effective_from date NOT NULL,
  effective_until date,
  submitted_by text NOT NULL CHECK(submitted_by ~ '^[1-9][0-9]{0,39}$'),
  submitted_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,cohort_id) REFERENCES astra.economics_benchmark_cohorts(tenant_id,id) ON DELETE RESTRICT,
  CHECK(effective_until IS NULL OR effective_until>=effective_from)
);

CREATE TABLE astra.economics_benchmark_quote_reviews (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  quote_id uuid NOT NULL,
  reviewer_id text NOT NULL CHECK(reviewer_id ~ '^[1-9][0-9]{0,39}$'),
  reviewer_role text NOT NULL CHECK(reviewer_role IN ('owner','admin','operator','reviewer')),
  verdict text NOT NULL CHECK(verdict IN ('approved','rejected')),
  rationale_code text NOT NULL CHECK(rationale_code ~ '^[a-z][a-z0-9_.:-]{1,79}$'),
  reviewed_at timestamptz NOT NULL,
  review_sha256 char(64) NOT NULL CHECK(review_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,quote_id,reviewer_id),
  FOREIGN KEY(tenant_id,quote_id) REFERENCES astra.economics_benchmark_quotes(tenant_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION astra.economics_benchmark_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Benchmark cohort and evidence records are immutable and append-only.' USING ERRCODE='55000'; END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['economics_benchmark_cohorts','economics_benchmark_cohort_members','economics_benchmark_observations','economics_benchmark_reports','economics_benchmark_quotes','economics_benchmark_quote_reviews'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_owner USING(true) WITH CHECK(true)',t||'_owner_all',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING(astra.context_allows(tenant_id)) WITH CHECK(astra.context_allows(tenant_id))',t||'_tenant_scope',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON astra.%I FOR EACH ROW EXECUTE FUNCTION astra.economics_benchmark_append_only()',t||'_append_only',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON astra.%I FOR EACH STATEMENT EXECUTE FUNCTION astra.economics_benchmark_append_only()',t||'_no_truncate',t);
    EXECUTE format('REVOKE ALL ON astra.%I FROM PUBLIC',t);
    EXECUTE format('GRANT SELECT,INSERT ON astra.%I TO astra_app,astra_worker',t);
    EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON astra.%I FROM PUBLIC,astra_app,astra_worker',t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION astra.economics_benchmark_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.check_economics_benchmark_member() FROM PUBLIC;

RESET ROLE;
COMMIT;
