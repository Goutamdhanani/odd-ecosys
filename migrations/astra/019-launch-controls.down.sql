BEGIN;
SET ROLE astra_owner;
DROP TABLE IF EXISTS astra.launch_active_pointers;
DROP TABLE IF EXISTS astra.launch_validation_reports;
DROP TABLE IF EXISTS astra.launch_release_events;
DROP TABLE IF EXISTS astra.launch_release_signoffs;
DROP TABLE IF EXISTS astra.launch_releases;
DROP FUNCTION IF EXISTS astra.guard_launch_append_only();
DROP FUNCTION IF EXISTS astra.guard_launch_release();
DROP FUNCTION IF EXISTS astra.guard_launch_active_pointer();
COMMIT;


