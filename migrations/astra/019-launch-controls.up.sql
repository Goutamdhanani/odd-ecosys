BEGIN;
SET ROLE astra_owner;
CREATE TABLE astra.launch_releases (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  version text NOT NULL CHECK(length(version) BETWEEN 1 AND 80),
  source_release_id uuid NOT NULL,
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  prior_stable_release_id uuid,
  status text NOT NULL CHECK(status IN ('pending_approval','approved_not_deployed','rejected','revoked')),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,name,version),
  FOREIGN KEY(tenant_id,source_release_id) REFERENCES astra.release_artifacts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,prior_stable_release_id) REFERENCES astra.launch_releases(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.launch_release_signoffs (
  tenant_id uuid NOT NULL,
  release_id uuid NOT NULL,
  approval_role text NOT NULL CHECK(approval_role IN ('owner','reviewer')),
  decision text NOT NULL CHECK(decision IN ('approve','reject')),
  reason_code text NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 80),
  manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by text NOT NULL CHECK(approved_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,release_id,approval_role),
  FOREIGN KEY(tenant_id,release_id) REFERENCES astra.launch_releases(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.launch_release_events (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  release_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('shadow_prepared','canary_prepared','pointer_activated','rollback_recorded','revoked','task_invalidated')),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,release_id) REFERENCES astra.launch_releases(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.launch_active_pointers (
  tenant_id uuid PRIMARY KEY REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  release_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  changed_by text NOT NULL CHECK(changed_by ~ '^[1-9][0-9]{0,39}$'),
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY(tenant_id,release_id) REFERENCES astra.launch_releases(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES astra.campaigns(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE astra.launch_validation_reports (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  baseline_run_id uuid NOT NULL,
  candidate_run_id uuid NOT NULL,
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object'),
  report_sha256 char(64) NOT NULL CHECK(report_sha256 ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,baseline_run_id) REFERENCES astra.eval_runs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,candidate_run_id) REFERENCES astra.eval_runs(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_launch_releases_recent ON astra.launch_releases(tenant_id,created_at DESC);
CREATE FUNCTION astra.guard_launch_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.tenant_id,NEW.id,NEW.name,NEW.version,NEW.source_release_id,NEW.manifest,NEW.manifest_sha256,NEW.prior_stable_release_id,NEW.created_by,NEW.created_at)
   IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.name,OLD.version,OLD.source_release_id,OLD.manifest,OLD.manifest_sha256,OLD.prior_stable_release_id,OLD.created_by,OLD.created_at)
   OR NOT ((OLD.status=NEW.status) OR (OLD.status='pending_approval' AND NEW.status IN ('approved_not_deployed','rejected','revoked')) OR (OLD.status='approved_not_deployed' AND NEW.status='revoked'))
 THEN RAISE EXCEPTION 'Launch release manifests are immutable and lifecycle transitions are bounded.' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER launch_release_guard BEFORE UPDATE OR DELETE ON astra.launch_releases FOR EACH ROW EXECUTE FUNCTION astra.guard_launch_release();
CREATE FUNCTION astra.guard_launch_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Launch evidence records are append only.' USING ERRCODE='55000'; END $$;
CREATE TRIGGER launch_signoff_guard BEFORE UPDATE OR DELETE ON astra.launch_release_signoffs FOR EACH ROW EXECUTE FUNCTION astra.guard_launch_append_only();
CREATE TRIGGER launch_event_guard BEFORE UPDATE OR DELETE ON astra.launch_release_events FOR EACH ROW EXECUTE FUNCTION astra.guard_launch_append_only();
CREATE TRIGGER launch_validation_guard BEFORE UPDATE OR DELETE ON astra.launch_validation_reports FOR EACH ROW EXECUTE FUNCTION astra.guard_launch_append_only();
CREATE FUNCTION astra.guard_launch_active_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m jsonb; release_status text; release_hash char(64); role_count integer; approver_count integer; source_status text; source_role_count integer; source_approver_count integer; campaign_mailbox uuid;
BEGIN
 SELECT status,manifest,manifest_sha256 INTO release_status,m,release_hash FROM astra.launch_releases WHERE tenant_id=NEW.tenant_id AND id=NEW.release_id;
 IF release_status<>'approved_not_deployed' OR release_hash<>NEW.manifest_sha256 OR m->>'campaignId'<>NEW.campaign_id::text OR jsonb_array_length(COALESCE(m->'blockingEvidence','[]'::jsonb))<>0 THEN
  RAISE EXCEPTION 'Launch pointer requires an exact compatible approved manifest with no blocking evidence.' USING ERRCODE='55000';
 END IF;
 SELECT count(DISTINCT approval_role),count(DISTINCT approved_by) INTO role_count,approver_count FROM astra.launch_release_signoffs WHERE tenant_id=NEW.tenant_id AND release_id=NEW.release_id AND decision='approve' AND manifest_sha256=NEW.manifest_sha256;
 IF role_count<>2 OR approver_count<>2 THEN RAISE EXCEPTION 'Launch pointer requires independent owner and reviewer signoffs.' USING ERRCODE='55000'; END IF;
 SELECT status INTO source_status FROM astra.release_artifacts WHERE tenant_id=NEW.tenant_id AND id=(SELECT source_release_id FROM astra.launch_releases WHERE tenant_id=NEW.tenant_id AND id=NEW.release_id);
 SELECT count(DISTINCT approval_role),count(DISTINCT approved_by) INTO source_role_count,source_approver_count FROM astra.release_approvals WHERE tenant_id=NEW.tenant_id AND release_id=(SELECT source_release_id FROM astra.launch_releases WHERE tenant_id=NEW.tenant_id AND id=NEW.release_id) AND decision='approve';
 IF source_status<>'approved_not_deployed' OR source_role_count<>2 OR source_approver_count<>2 THEN RAISE EXCEPTION 'Source evaluation release lacks independent signoffs.' USING ERRCODE='55000'; END IF;
 SELECT mailbox_id INTO campaign_mailbox FROM astra.campaigns WHERE tenant_id=NEW.tenant_id AND id=NEW.campaign_id;
 IF EXISTS(SELECT 1 FROM astra.operational_kill_switches k WHERE k.tenant_id=NEW.tenant_id AND k.enabled=true AND ((k.scope='tenant' AND k.scope_id='00000000-0000-0000-0000-000000000000'::uuid) OR (k.scope='campaign' AND k.scope_id=NEW.campaign_id) OR (k.scope='mailbox' AND k.scope_id=campaign_mailbox))) THEN
  RAISE EXCEPTION 'Operational kill switch blocks launch pointer transition.' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER launch_active_pointer_guard BEFORE INSERT OR UPDATE ON astra.launch_active_pointers FOR EACH ROW EXECUTE FUNCTION astra.guard_launch_active_pointer();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['launch_releases','launch_release_signoffs','launch_release_events','launch_validation_reports','launch_active_pointers'] LOOP
  EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))',t||'_tenant_scope',t);
    IF t='launch_releases' OR t='launch_active_pointers' THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON astra.%I TO astra_app,astra_worker',t);
  ELSE
   EXECUTE format('GRANT SELECT,INSERT ON astra.%I TO astra_app,astra_worker',t);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION astra.guard_launch_release() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_launch_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_launch_active_pointer() FROM PUBLIC;
REVOKE DELETE,TRUNCATE ON astra.launch_active_pointers,astra.launch_releases,astra.launch_release_signoffs,astra.launch_release_events,astra.launch_validation_reports FROM PUBLIC,astra_app,astra_worker;
COMMIT;


