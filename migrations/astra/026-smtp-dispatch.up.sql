-- Bind each newly observed connector capability to the exact configuration
-- that was active when the provider result was recorded. Historical evidence
-- remains immutable and NULL; it cannot authorize dispatch after this migration.
BEGIN;
SET ROLE astra_owner;

ALTER TABLE astra.connector_evidence
  ADD COLUMN configuration_hash char(64) CHECK(configuration_hash IS NULL OR configuration_hash ~ '^[a-f0-9]{64}$');

CREATE FUNCTION astra.connector_configuration_hash(
  p_provider text,
  p_endpoint_host text,
  p_public_config jsonb,
  p_credential_fingerprint text
) RETURNS char(64)
LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog,astra
AS $$
  SELECT pg_catalog.encode(public.digest(
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'provider',p_provider,
      'endpointHost',p_endpoint_host,
      'publicConfig',p_public_config,
      'credentialFingerprint',pg_catalog.btrim(p_credential_fingerprint)
    )::text,'UTF8'),'sha256'),'hex')::char(64)
$$;

CREATE FUNCTION astra.bind_connector_evidence_configuration() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,astra
AS $$
DECLARE config astra.connector_configs%ROWTYPE;
BEGIN
  SELECT * INTO config FROM astra.connector_configs
    WHERE tenant_id=NEW.tenant_id AND id=NEW.connector_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connector evidence requires a current tenant connector configuration.' USING ERRCODE='23503';
  END IF;
  NEW.configuration_hash:=astra.connector_configuration_hash(
    config.provider,config.endpoint_host,config.public_config,config.credential_fingerprint);
  RETURN NEW;
END $$;

CREATE TRIGGER astra_connector_evidence_configuration
  BEFORE INSERT ON astra.connector_evidence
  FOR EACH ROW EXECUTE FUNCTION astra.bind_connector_evidence_configuration();

CREATE INDEX astra_connector_evidence_config_lookup
  ON astra.connector_evidence(tenant_id,connector_id,mailbox_id,capability,configuration_hash,expires_at DESC)
  WHERE outcome='supported' AND environment='provider_observed';

REVOKE ALL ON FUNCTION astra.connector_configuration_hash(text,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.bind_connector_evidence_configuration() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astra.connector_configuration_hash(text,text,jsonb,text) TO astra_worker;
GRANT EXECUTE ON FUNCTION astra.bind_connector_evidence_configuration() TO astra_worker;

RESET ROLE;
COMMIT;
