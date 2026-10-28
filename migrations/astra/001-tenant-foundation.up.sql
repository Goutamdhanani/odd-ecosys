-- Astra tenant foundation, migration 001.
-- Apply only to a disposable PostgreSQL 16 candidate using a migration
-- principal allowed to create roles/extensions and SET ROLE astra_owner.
-- This migration creates no tenant and assigns no legacy rows or users.

BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'astra_owner') THEN
    CREATE ROLE astra_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    RAISE EXCEPTION 'Role astra_owner already exists; inspect its ownership and privilege state before applying migration 001.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'astra_app') THEN
    CREATE ROLE astra_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    RAISE EXCEPTION 'Role astra_app already exists; inspect its ownership and privilege state before applying migration 001.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'astra_worker') THEN
    CREATE ROLE astra_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    RAISE EXCEPTION 'Role astra_worker already exists; inspect its ownership and privilege state before applying migration 001.';
  END IF;
END
$roles$;

-- Refuse to adopt a pre-existing schema whose owner, objects, or grants have
-- not been reviewed. This migration must never take ownership of user data.
CREATE SCHEMA astra AUTHORIZATION astra_owner;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

DO $extension$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_extension AS e
    JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace
    WHERE e.extname = 'pgcrypto' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'pgcrypto must be installed in public for Astra context signing.';
  END IF;
END
$extension$;

SET ROLE astra_owner;

CREATE TABLE astra.tenants (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_by_user_id text NOT NULL CHECK (length(created_by_user_id) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE astra.memberships (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 40),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'reviewer')),
  granted_by_user_id text NOT NULL CHECK (length(granted_by_user_id) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX memberships_user_active_idx
  ON astra.memberships (user_id, tenant_id) WHERE revoked_at IS NULL;

-- This key is private to the NOLOGIN table owner and is used to sign the
-- transaction-local identity context. A caller cannot authorize itself merely
-- by setting a custom PostgreSQL GUC to a guessed tenant or user ID.
CREATE TABLE astra.context_keys (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  secret bytea CHECK (secret IS NULL OR octet_length(secret) >= 32),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
INSERT INTO astra.context_keys (singleton, secret)
VALUES (true, NULL);

CREATE TABLE astra.context_nonces (
  nonce uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

-- Migration bookkeeping contains only source fingerprints and decisions, not
-- legacy row payloads, credentials, or customer content. The original SQLite
-- source remains untouched until a separately approved cutover.
CREATE TABLE astra.legacy_migration_runs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  source_database_fingerprint text NOT NULL CHECK (length(source_database_fingerprint) = 64),
  source_schema_version text NOT NULL,
  migration_fingerprint text NOT NULL CHECK (length(migration_fingerprint) = 64),
  status text NOT NULL CHECK (status IN ('prepared', 'running', 'complete', 'rolled_back', 'blocked')),
  started_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  mapped_count bigint NOT NULL DEFAULT 0 CHECK (mapped_count >= 0),
  quarantined_count bigint NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
  created_by_user_id text
);

CREATE TABLE astra.legacy_row_mappings (
  source_database_fingerprint text NOT NULL CHECK (length(source_database_fingerprint) = 64),
  source_table text NOT NULL CHECK (length(source_table) BETWEEN 1 AND 128),
  source_pk text NOT NULL CHECK (length(source_pk) BETWEEN 1 AND 512),
  target_tenant_id uuid REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  target_table text,
  target_id text,
  decision text NOT NULL CHECK (decision IN ('mapped', 'quarantined')),
  row_checksum text NOT NULL CHECK (length(row_checksum) = 64),
  relationship_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(relationship_refs) = 'array'),
  reason_code text,
  migration_run_id uuid NOT NULL REFERENCES astra.legacy_migration_runs(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (source_database_fingerprint, source_table, source_pk),
  CHECK (
    (decision = 'mapped' AND target_tenant_id IS NOT NULL AND target_table IS NOT NULL AND target_id IS NOT NULL AND reason_code IS NULL)
    OR
    (decision = 'quarantined' AND target_tenant_id IS NULL AND target_table IS NULL AND target_id IS NULL AND reason_code IS NOT NULL)
  )
);

CREATE TABLE astra.legacy_quarantine (
  source_database_fingerprint text NOT NULL CHECK (length(source_database_fingerprint) = 64),
  source_table text NOT NULL CHECK (length(source_table) BETWEEN 1 AND 128),
  source_pk text NOT NULL CHECK (length(source_pk) BETWEEN 1 AND 512),
  reason_code text NOT NULL CHECK (reason_code IN (
    'owner_unknown', 'parent_unmapped', 'conflicting_parent', 'orphan_reference',
    'policy_unknown', 'unresolved_send_state', 'other'
  )),
  row_checksum text NOT NULL CHECK (length(row_checksum) = 64),
  relationship_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(relationship_refs) = 'array'),
  migration_run_id uuid NOT NULL REFERENCES astra.legacy_migration_runs(id) ON DELETE RESTRICT,
  quarantined_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (source_database_fingerprint, source_table, source_pk)
);

ALTER TABLE astra.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE astra.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE astra.context_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.context_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE astra.context_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.context_nonces FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION astra.context_allows(p_tenant_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, astra
AS $function$
DECLARE
  v_tenant text;
  v_user text;
  v_signature text;
  v_secret bytea;
  v_expected text;
  v_active boolean;
BEGIN
  v_tenant := pg_catalog.current_setting('astra.tenant_id', true);
  v_user := pg_catalog.current_setting('astra.user_id', true);
  v_signature := pg_catalog.current_setting('astra.context_signature', true);
  IF v_tenant IS NULL OR v_user IS NULL OR v_signature IS NULL
     OR v_tenant <> p_tenant_id::text THEN
    RETURN false;
  END IF;

  SELECT secret INTO v_secret FROM astra.context_keys WHERE singleton = true;
  IF v_secret IS NULL THEN RETURN false; END IF;
  v_expected := pg_catalog.encode(
    public.hmac(pg_catalog.convert_to(v_tenant || E'\n' || v_user, 'UTF8'), v_secret, 'sha256'),
    'hex'
  );
  IF v_signature <> v_expected THEN RETURN false; END IF;
  SELECT EXISTS (
    SELECT 1 FROM astra.memberships AS m
    JOIN astra.tenants AS t ON t.id = m.tenant_id
    WHERE m.tenant_id = p_tenant_id AND m.user_id = v_user
      AND m.revoked_at IS NULL AND t.status = 'active'
  ) INTO v_active;
  RETURN v_active;
END
$function$;

CREATE POLICY tenants_owner_all ON astra.tenants
  FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY tenants_app_scope ON astra.tenants
  FOR ALL TO astra_app, astra_worker
  USING (astra.context_allows(id)) WITH CHECK (astra.context_allows(id));

CREATE POLICY memberships_owner_all ON astra.memberships
  FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY memberships_app_scope ON astra.memberships
  FOR SELECT TO astra_app, astra_worker
  USING (astra.context_allows(tenant_id));

CREATE POLICY context_keys_owner_only ON astra.context_keys
  FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY context_nonces_owner_only ON astra.context_nonces
  FOR ALL TO astra_owner USING (true) WITH CHECK (true);

-- The deployment operator supplies the exact ASTRA_CONTEXT_SECRET bytes
-- through a protected migration session after applying this migration. The
-- NOLOGIN owner role is the only role allowed to install it.
CREATE OR REPLACE FUNCTION astra.install_context_verifier(p_secret bytea)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, astra
AS $function$
BEGIN
  IF p_secret IS NULL OR octet_length(p_secret) < 32 THEN
    RAISE EXCEPTION 'A context verifier of at least 32 bytes is required.' USING ERRCODE = '22023';
  END IF;
  UPDATE astra.context_keys SET secret = p_secret WHERE singleton = true AND secret IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Context verifier is already installed or unavailable.' USING ERRCODE = '55000';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION astra.consume_context_proof(
  p_tenant_id uuid, p_user_id text, p_action text, p_expires_at bigint, p_nonce uuid, p_proof text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, astra
AS $function$
DECLARE
  v_secret bytea;
  v_expected text;
  v_tenant text;
BEGIN
  IF p_user_id IS NULL OR length(p_user_id) NOT BETWEEN 1 AND 40
     OR p_action IS NULL OR p_proof IS NULL
     OR p_action NOT IN ('access', 'create_tenant')
     OR p_nonce IS NULL OR p_expires_at IS NULL OR p_proof !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'tenant proof rejected' USING ERRCODE = '42501';
  END IF;
  IF (p_action = 'access' AND p_tenant_id IS NULL)
     OR (p_action = 'create_tenant' AND p_tenant_id IS NOT NULL) THEN
    RAISE EXCEPTION 'tenant proof rejected' USING ERRCODE = '42501';
  END IF;
  IF p_expires_at < floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint
     OR p_expires_at > floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint + 60 THEN
    RAISE EXCEPTION 'tenant proof expired' USING ERRCODE = '42501';
  END IF;
  SELECT secret INTO v_secret FROM astra.context_keys WHERE singleton = true;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'tenant proof verifier unavailable' USING ERRCODE = '55000';
  END IF;
  v_tenant := COALESCE(p_tenant_id::text, '-');
  v_expected := pg_catalog.encode(public.hmac(
    pg_catalog.convert_to(p_action || E'\n' || v_tenant || E'\n' || p_user_id || E'\n' || p_expires_at::text || E'\n' || p_nonce::text, 'UTF8'),
    v_secret, 'sha256'), 'hex');
  IF v_expected IS DISTINCT FROM p_proof THEN
    RAISE EXCEPTION 'tenant proof rejected' USING ERRCODE = '42501';
  END IF;
  DELETE FROM astra.context_nonces WHERE expires_at < pg_catalog.clock_timestamp();
  INSERT INTO astra.context_nonces (nonce, expires_at)
  VALUES (p_nonce, pg_catalog.to_timestamp(p_expires_at));
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'tenant proof already consumed' USING ERRCODE = '42501';
END
$function$;

CREATE OR REPLACE FUNCTION astra.begin_tenant_context(
  p_tenant_id uuid, p_user_id text, p_expires_at bigint, p_nonce uuid, p_proof text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, astra
AS $function$
DECLARE
  v_role text;
  v_secret bytea;
  v_signature text;
BEGIN
  IF p_user_id IS NULL OR length(p_user_id) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'tenant membership required' USING ERRCODE = '42501';
  END IF;

  PERFORM astra.consume_context_proof(p_tenant_id, p_user_id, 'access', p_expires_at, p_nonce, p_proof);

  SELECT m.role INTO v_role
  FROM astra.memberships AS m
  JOIN astra.tenants AS t ON t.id = m.tenant_id
  WHERE m.tenant_id = p_tenant_id
    AND m.user_id = p_user_id
    AND m.revoked_at IS NULL
    AND t.status = 'active';
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'tenant membership required' USING ERRCODE = '42501';
  END IF;

  SELECT secret INTO v_secret FROM astra.context_keys WHERE singleton = true;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'tenant context key unavailable' USING ERRCODE = '55000';
  END IF;
  v_signature := pg_catalog.encode(
    public.hmac(pg_catalog.convert_to(p_tenant_id::text || E'\n' || p_user_id, 'UTF8'), v_secret, 'sha256'),
    'hex'
  );

  PERFORM pg_catalog.set_config('astra.tenant_id', p_tenant_id::text, true);
  PERFORM pg_catalog.set_config('astra.user_id', p_user_id, true);
  PERFORM pg_catalog.set_config('astra.context_signature', v_signature, true);
  RETURN v_role;
END
$function$;

CREATE OR REPLACE FUNCTION astra.create_tenant(
  p_name text, p_user_id text, p_expires_at bigint, p_nonce uuid, p_proof text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, astra
AS $function$
DECLARE
  v_tenant_id uuid;
BEGIN
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 160
     OR p_user_id IS NULL OR length(p_user_id) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'tenant input invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM astra.consume_context_proof(NULL, p_user_id, 'create_tenant', p_expires_at, p_nonce, p_proof);

  INSERT INTO astra.tenants (name, created_by_user_id)
  VALUES (btrim(p_name), p_user_id)
  RETURNING id INTO v_tenant_id;
  INSERT INTO astra.memberships (tenant_id, user_id, role, granted_by_user_id)
  VALUES (v_tenant_id, p_user_id, 'owner', p_user_id);
  RETURN v_tenant_id;
END
$function$;

REVOKE ALL ON astra.context_keys FROM PUBLIC, astra_app, astra_worker;
REVOKE ALL ON astra.context_nonces FROM PUBLIC, astra_app, astra_worker;
REVOKE ALL ON astra.tenants, astra.memberships, astra.legacy_migration_runs,
  astra.legacy_row_mappings, astra.legacy_quarantine FROM PUBLIC, astra_app, astra_worker;
GRANT USAGE ON SCHEMA astra TO astra_app, astra_worker;
GRANT SELECT ON astra.tenants, astra.memberships TO astra_app, astra_worker;
GRANT EXECUTE ON FUNCTION astra.context_allows(uuid) TO astra_app, astra_worker;
GRANT EXECUTE ON FUNCTION astra.begin_tenant_context(uuid, text, bigint, uuid, text) TO astra_app, astra_worker;
GRANT EXECUTE ON FUNCTION astra.create_tenant(text, text, bigint, uuid, text) TO astra_app;
REVOKE ALL ON FUNCTION astra.context_allows(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.begin_tenant_context(uuid, text, bigint, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.create_tenant(text, text, bigint, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.consume_context_proof(uuid, text, text, bigint, uuid, text) FROM PUBLIC, astra_app, astra_worker;
REVOKE ALL ON FUNCTION astra.install_context_verifier(bytea) FROM PUBLIC, astra_app, astra_worker;

-- Later tenant data tables owned by astra_owner inherit only tenant-row DML
-- rights. Every such table still needs ENABLE + FORCE ROW LEVEL SECURITY and a
-- context_allows(tenant_id) policy in its migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA astra
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO astra_app, astra_worker;

RESET ROLE;
COMMIT;
