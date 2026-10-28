-- Refuse to drop frozen sources, labels, reports, approvals, or rollback facts.
BEGIN;
SET ROLE astra_owner;
DO $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM astra.eval_datasets) OR EXISTS(SELECT 1 FROM astra.eval_examples)
    OR EXISTS(SELECT 1 FROM astra.eval_annotations) OR EXISTS(SELECT 1 FROM astra.eval_adjudications)
    OR EXISTS(SELECT 1 FROM astra.eval_candidates) OR EXISTS(SELECT 1 FROM astra.eval_scorers)
    OR EXISTS(SELECT 1 FROM astra.eval_runs) OR EXISTS(SELECT 1 FROM astra.eval_run_results)
    OR EXISTS(SELECT 1 FROM astra.release_artifacts) OR EXISTS(SELECT 1 FROM astra.release_approvals)
    OR EXISTS(SELECT 1 FROM astra.release_rollbacks) THEN
    RAISE EXCEPTION 'Migration 013 contains durable evaluation or release facts; archive them before removing this schema.';
  END IF;
END
$guard$;
DROP TABLE astra.release_rollbacks;
DROP TABLE astra.release_approvals;
DROP TABLE astra.release_artifacts;
DROP TABLE astra.eval_run_results;
DROP TABLE astra.eval_runs;
DROP TABLE astra.eval_scorers;
DROP TABLE astra.eval_candidates;
DROP TABLE astra.eval_adjudications;
DROP TABLE astra.eval_annotations;
DROP TABLE astra.eval_examples;
DROP TABLE astra.eval_datasets;
DROP FUNCTION astra.guard_release_approval_independence();
DROP FUNCTION astra.guard_release_identity();
DROP FUNCTION astra.guard_eval_run_transition();
DROP FUNCTION astra.guard_eval_immutable();
RESET ROLE;
COMMIT;
