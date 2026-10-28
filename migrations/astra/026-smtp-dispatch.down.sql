BEGIN;
SET ROLE astra_owner;

DROP INDEX IF EXISTS astra.astra_connector_evidence_config_lookup;
DROP TRIGGER IF EXISTS astra_connector_evidence_configuration ON astra.connector_evidence;
DROP FUNCTION IF EXISTS astra.bind_connector_evidence_configuration();
REVOKE ALL ON FUNCTION astra.connector_configuration_hash(text,text,jsonb,text) FROM astra_worker;
DROP FUNCTION IF EXISTS astra.connector_configuration_hash(text,text,jsonb,text);
ALTER TABLE astra.connector_evidence DROP COLUMN IF EXISTS configuration_hash;

RESET ROLE;
COMMIT;
