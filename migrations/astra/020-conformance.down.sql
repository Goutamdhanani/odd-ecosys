BEGIN;
SET ROLE astra_owner;
DO $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM astra.conformance_case_results) OR EXISTS(SELECT 1 FROM astra.conformance_runs) THEN
    RAISE EXCEPTION 'Migration 020 contains durable conformance run or case receipts; archive them before removing this schema.';
  END IF;
END
$guard$;
DROP TABLE astra.conformance_case_results;
DROP TABLE astra.conformance_runs;
DROP FUNCTION astra.guard_conformance_case_insert();
DROP FUNCTION astra.guard_conformance_case_immutable();
DROP FUNCTION astra.guard_conformance_run_transition();
RESET ROLE;
COMMIT;
