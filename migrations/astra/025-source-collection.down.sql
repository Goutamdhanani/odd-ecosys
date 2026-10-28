BEGIN;
SET ROLE astra_owner;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM astra.source_collection_observations) OR EXISTS(SELECT 1 FROM astra.source_collection_candidates) OR EXISTS(SELECT 1 FROM astra.source_collection_runs)
    OR EXISTS(SELECT 1 FROM astra.source_collection_jobs)
  THEN RAISE EXCEPTION 'Source collection requests, runs, or discovery candidates exist; rollback would destroy provenance.' USING ERRCODE='55000'; END IF;
END $$;
ALTER TABLE astra.source_collection_jobs DROP CONSTRAINT source_collection_job_run_fk;
DROP TRIGGER source_collection_candidate_guard ON astra.source_collection_candidates;
DROP TRIGGER source_collection_observation_guard ON astra.source_collection_observations;
DROP TRIGGER source_collection_run_guard ON astra.source_collection_runs;
DROP TRIGGER source_collection_job_guard ON astra.source_collection_jobs;
DROP TABLE astra.source_collection_candidates;
DROP TABLE astra.source_collection_observations;
DROP TABLE astra.source_collection_runs;
DROP TABLE astra.source_collection_jobs;
DROP FUNCTION astra.guard_source_collection_candidate();
DROP FUNCTION astra.guard_source_collection_run();
DROP FUNCTION astra.guard_source_collection_job();
RESET ROLE;
COMMIT;
