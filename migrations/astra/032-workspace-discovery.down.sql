-- Roll back only workspace discovery objects introduced by migration 032.
BEGIN;
SET ROLE astra_owner;
DROP FUNCTION IF EXISTS astra.list_my_workspaces(text, bigint, uuid, text);
DROP TABLE IF EXISTS astra.workspace_discovery_nonces;
RESET ROLE;
COMMIT;
