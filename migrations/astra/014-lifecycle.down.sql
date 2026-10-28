BEGIN;
SET ROLE astra_owner;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM astra.lifecycle_export_requests)
     OR EXISTS (SELECT 1 FROM astra.lifecycle_export_artifacts)
     OR EXISTS (SELECT 1 FROM astra.lifecycle_requests)
     OR EXISTS (SELECT 1 FROM astra.lifecycle_suppression_retention)
     OR EXISTS (SELECT 1 FROM astra.lifecycle_tombstone_guards) THEN
    RAISE EXCEPTION 'Migration 014 contains lifecycle records or export artifacts; preserve them and use a reviewed forward migration.';
  END IF;
END
$guard$;
DO $triggers$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_trigger g ON g.tgrelid=c.oid
    WHERE n.nspname='astra' AND g.tgname='lifecycle_tombstone_guard'
  LOOP EXECUTE pg_catalog.format('DROP TRIGGER lifecycle_tombstone_guard ON astra.%I',t.relname); END LOOP;
END
$triggers$;
DROP FUNCTION astra.lifecycle_reject_resurrection();
DROP TABLE astra.lifecycle_tombstone_guards;
DROP TABLE astra.lifecycle_suppression_retention;
DROP TABLE astra.lifecycle_export_artifacts;
DROP TABLE astra.lifecycle_requests;
DROP TABLE astra.lifecycle_export_requests;
RESET ROLE;
COMMIT;
