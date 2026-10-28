BEGIN;
SET ROLE astra_owner;
DROP TABLE astra.workflow_attempts;
DROP FUNCTION astra.guard_workflow_attempt_identity();
RESET ROLE;
COMMIT;
