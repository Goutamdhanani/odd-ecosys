BEGIN;
SET ROLE astra_owner;
DROP TRIGGER IF EXISTS launch_release_evidence_immutable ON astra.launch_release_evidence;
DROP TRIGGER IF EXISTS launch_release_evidence_binding_guard ON astra.launch_release_evidence;
DROP FUNCTION IF EXISTS astra.guard_launch_release_evidence_immutable();
DROP FUNCTION IF EXISTS astra.check_launch_release_evidence_binding();
DROP TABLE IF EXISTS astra.launch_release_evidence;
RESET ROLE;
COMMIT;
