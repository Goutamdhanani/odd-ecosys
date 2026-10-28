-- Tenant-scoped export, deletion-plan and retention lifecycle records.
-- Deletion requests only prepare plans. No business row or immutable ledger
-- history is physically removed by this migration or its workers.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.lifecycle_export_requests (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 40),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','complete','failed','expired')),
  row_limit integer NOT NULL DEFAULT 50000 CHECK (row_limit BETWEEN 1 AND 100000),
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(manifest)='object'),
  error_code text,
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (pg_catalog.clock_timestamp() + interval '7 days'),
  PRIMARY KEY (tenant_id,id),
  CHECK ((status='failed') = (error_code IS NOT NULL))
);
CREATE INDEX lifecycle_export_queue ON astra.lifecycle_export_requests(requested_at)
  WHERE status='queued';

CREATE TABLE astra.lifecycle_export_artifacts (
  tenant_id uuid NOT NULL,
  export_id uuid NOT NULL,
  content_type text NOT NULL DEFAULT 'application/gzip',
  filename text NOT NULL,
  content bytea NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (tenant_id,export_id),
  FOREIGN KEY (tenant_id,export_id) REFERENCES astra.lifecycle_export_requests(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.lifecycle_requests (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  request_type text NOT NULL CHECK (request_type IN ('deletion','retention')),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 40),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','cancelled','plan_ready','blocked')),
  targets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(targets)='array'),
  retention_policy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(retention_policy)='object'),
  inventory jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(inventory)='object'),
  receipt jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(receipt)='object'),
  legal_hold boolean NOT NULL DEFAULT false,
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  planned_at timestamptz,
  cancelled_at timestamptz,
  PRIMARY KEY (tenant_id,id)
);

-- Minimal normalized suppression digests and legal hold metadata survive a
-- deletion plan. Digests are keyed per tenant; raw addresses are not stored.
CREATE TABLE astra.lifecycle_suppression_retention (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  reason_code text NOT NULL CHECK (reason_code IN ('unsubscribe','complaint','legal_hold','deletion_request','other')),
  source_request_id uuid,
  retained_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz,
  PRIMARY KEY (tenant_id,digest),
  FOREIGN KEY (tenant_id,source_request_id) REFERENCES astra.lifecycle_requests(tenant_id,id) ON DELETE RESTRICT
);

-- Targeted identifiers are retained as a suppression guard so a planned
-- deletion cannot be undone by re-importing the same object identifier.
CREATE TABLE astra.lifecycle_tombstone_guards (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  table_name text NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  object_id text NOT NULL CHECK (length(object_id) BETWEEN 1 AND 500),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (tenant_id,table_name,object_id),
  FOREIGN KEY (tenant_id,request_id) REFERENCES astra.lifecycle_requests(tenant_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION astra.lifecycle_reject_resurrection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,astra AS $function$
DECLARE v_id text;
BEGIN
  -- Research blobs use their digest as identity, and workflow attempts inherit
  -- identity from their parent workflow rather than exposing a single id.
  v_id := CASE TG_TABLE_NAME
    WHEN 'research_blobs' THEN pg_catalog.to_jsonb(NEW)->>'sha256'
    WHEN 'workflow_attempts' THEN pg_catalog.to_jsonb(NEW)->>'workflow_id'
    ELSE pg_catalog.to_jsonb(NEW)->>'id'
  END;
  IF v_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM astra.lifecycle_tombstone_guards g
    WHERE g.tenant_id = (pg_catalog.to_jsonb(NEW)->>'tenant_id')::uuid
      AND g.table_name = TG_TABLE_NAME AND g.object_id = v_id
  ) THEN
    RAISE EXCEPTION 'Astra lifecycle tombstone prevents object resurrection.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;

-- Guard insert/update paths for tenant-owned rows with stable identities. The
-- workflow attempt key follows its parent workflow; blobs use their digest.
-- Other composite/link tables and external stores need their own adapters.
DO $guard$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='astra' AND c.relkind='r'
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
      AND (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attname='id' AND NOT a.attisdropped)
        OR (c.relname='research_blobs' AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attname='sha256' AND NOT a.attisdropped))
        OR (c.relname='workflow_attempts' AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workflow_id' AND NOT a.attisdropped)))
      AND c.relname NOT IN ('lifecycle_export_requests','lifecycle_export_artifacts','lifecycle_requests','lifecycle_tombstone_guards')
  LOOP
    EXECUTE pg_catalog.format('CREATE TRIGGER lifecycle_tombstone_guard BEFORE INSERT OR UPDATE ON astra.%I FOR EACH ROW EXECUTE FUNCTION astra.lifecycle_reject_resurrection()',t.relname);
  END LOOP;
END
$guard$;

DO $rls$
DECLARE n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['lifecycle_export_requests','lifecycle_export_artifacts','lifecycle_requests','lifecycle_suppression_retention','lifecycle_tombstone_guards'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE pg_catalog.format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',n);
    EXECUTE pg_catalog.format('CREATE POLICY lifecycle_owner_all ON astra.%I FOR ALL TO astra_owner USING (true) WITH CHECK (true)',n);
    EXECUTE pg_catalog.format('CREATE POLICY lifecycle_app_scope ON astra.%I FOR ALL TO astra_app USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))',n);
    EXECUTE pg_catalog.format('CREATE POLICY lifecycle_worker_scope ON astra.%I FOR ALL TO astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))',n);
  END LOOP;
END
$rls$;

GRANT SELECT ON astra.lifecycle_export_requests,astra.lifecycle_requests TO astra_app;
GRANT INSERT(tenant_id,requested_by,row_limit) ON astra.lifecycle_export_requests TO astra_app;
GRANT INSERT(tenant_id,request_type,requested_by,targets,retention_policy,inventory,legal_hold) ON astra.lifecycle_requests TO astra_app;
GRANT UPDATE(status,cancelled_at,planned_at,receipt) ON astra.lifecycle_requests TO astra_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON astra.lifecycle_export_requests,astra.lifecycle_requests TO astra_worker;
GRANT SELECT,INSERT,UPDATE ON astra.lifecycle_export_artifacts,astra.lifecycle_suppression_retention,astra.lifecycle_tombstone_guards TO astra_worker;
GRANT SELECT ON astra.lifecycle_export_artifacts TO astra_app;
GRANT SELECT,INSERT ON astra.lifecycle_suppression_retention TO astra_app;
GRANT SELECT,INSERT,DELETE ON astra.lifecycle_tombstone_guards TO astra_app;
REVOKE DELETE,TRUNCATE ON astra.lifecycle_export_artifacts,astra.lifecycle_suppression_retention FROM PUBLIC,astra_app,astra_worker;
REVOKE TRUNCATE ON astra.lifecycle_tombstone_guards FROM PUBLIC,astra_app,astra_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.events,astra.event_outbox,astra.consumer_receipts FROM astra_app,astra_worker;

RESET ROLE;
COMMIT;
