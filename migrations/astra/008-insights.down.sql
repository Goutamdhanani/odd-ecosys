BEGIN;
SET ROLE astra_owner;

DROP TRIGGER IF EXISTS astra_experiment_exposure_guard ON astra.experiment_exposures;
DROP FUNCTION IF EXISTS astra.guard_experiment_exposure();
DROP TABLE IF EXISTS astra.experiment_exposures;
DROP TABLE IF EXISTS astra.experiment_assignments;
DROP TABLE IF EXISTS astra.experiments;
DROP TABLE IF EXISTS astra.memory_tombstones;
DROP TABLE IF EXISTS astra.memory_links;
DROP TABLE IF EXISTS astra.memory_items;
DROP FUNCTION IF EXISTS astra.reject_insights_immutable_mutation();

RESET ROLE;
COMMIT;
