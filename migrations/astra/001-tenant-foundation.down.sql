-- Reversible only while this foundation contains no user or migration data.
-- Later Astra migrations must be rolled back first.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM astra.tenants)
     OR EXISTS (SELECT 1 FROM astra.memberships)
     OR EXISTS (SELECT 1 FROM astra.legacy_migration_runs)
     OR EXISTS (SELECT 1 FROM astra.legacy_row_mappings)
     OR EXISTS (SELECT 1 FROM astra.legacy_quarantine) THEN
    RAISE EXCEPTION 'Astra foundation contains data; migration 001 down is refused.';
  END IF;
END
$guard$;

SET ROLE astra_owner;
DROP POLICY IF EXISTS tenants_owner_all ON astra.tenants;
DROP POLICY IF EXISTS tenants_app_scope ON astra.tenants;
DROP POLICY IF EXISTS memberships_owner_all ON astra.memberships;
DROP POLICY IF EXISTS memberships_app_scope ON astra.memberships;
DROP POLICY IF EXISTS context_keys_owner_only ON astra.context_keys;
DROP POLICY IF EXISTS context_nonces_owner_only ON astra.context_nonces;
DROP FUNCTION IF EXISTS astra.create_tenant(text, text, bigint, uuid, text);
DROP FUNCTION IF EXISTS astra.begin_tenant_context(uuid, text, bigint, uuid, text);
DROP FUNCTION IF EXISTS astra.consume_context_proof(uuid, text, text, bigint, uuid, text);
DROP FUNCTION IF EXISTS astra.install_context_verifier(bytea);
DROP FUNCTION IF EXISTS astra.context_allows(uuid);
DROP TABLE astra.legacy_quarantine;
DROP TABLE astra.legacy_row_mappings;
DROP TABLE astra.legacy_migration_runs;
DROP TABLE astra.context_keys;
DROP TABLE astra.context_nonces;
DROP TABLE astra.memberships;
DROP TABLE astra.tenants;
ALTER DEFAULT PRIVILEGES FOR ROLE astra_owner IN SCHEMA astra
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM astra_app, astra_worker;
RESET ROLE;

DROP SCHEMA astra RESTRICT;
DROP ROLE astra_worker;
DROP ROLE astra_app;
DROP ROLE astra_owner;
-- pgcrypto may predate Astra or be used by other schemas, so it is retained.
COMMIT;
