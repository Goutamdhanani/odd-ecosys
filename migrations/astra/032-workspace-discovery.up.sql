-- Signed, one-use identity proof for tenant discovery before a tenant context exists.
-- Apply only to the isolated migration candidate through migration 031.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.workspace_discovery_nonces (
  nonce uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE astra.workspace_discovery_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.workspace_discovery_nonces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_discovery_nonces_owner_only ON astra.workspace_discovery_nonces
  FOR ALL TO astra_owner USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION astra.list_my_workspaces(
  p_user_id text, p_expires_at bigint, p_nonce uuid, p_proof text
)
RETURNS TABLE(id uuid, name text, role text, status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, astra
AS $function$
DECLARE
  v_now bigint;
  v_secret bytea;
  v_expected text;
BEGIN
  v_now := floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint;
  IF p_user_id IS NULL OR p_user_id !~ '^[1-9][0-9]{0,39}$'
     OR p_nonce IS NULL OR p_proof IS NULL OR p_proof !~ '^[0-9a-f]{64}$'
     OR p_expires_at <= v_now OR p_expires_at > v_now + 30 THEN
    RAISE EXCEPTION 'workspace discovery rejected' USING ERRCODE = '42501';
  END IF;
  SELECT secret INTO v_secret FROM astra.context_keys WHERE singleton = true;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'workspace discovery verifier unavailable' USING ERRCODE = '55000';
  END IF;
  v_expected := pg_catalog.encode(public.hmac(pg_catalog.convert_to(
    'discover_workspaces' || E'\n-\n' || p_user_id || E'\n' || p_expires_at::text || E'\n' || p_nonce::text,
    'UTF8'), v_secret, 'sha256'), 'hex');
  IF v_expected IS DISTINCT FROM p_proof THEN
    RAISE EXCEPTION 'workspace discovery rejected' USING ERRCODE = '42501';
  END IF;

  DELETE FROM astra.workspace_discovery_nonces WHERE expires_at < pg_catalog.clock_timestamp();
  INSERT INTO astra.workspace_discovery_nonces(nonce, expires_at)
  VALUES (p_nonce, pg_catalog.to_timestamp(p_expires_at));

  RETURN QUERY
    SELECT t.id, t.name, m.role, t.status
    FROM astra.memberships AS m
    JOIN astra.tenants AS t ON t.id = m.tenant_id
    WHERE m.user_id = p_user_id AND m.revoked_at IS NULL AND t.status = 'active'
    ORDER BY t.name, t.id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'workspace discovery rejected' USING ERRCODE = '42501';
END
$function$;

REVOKE ALL ON astra.workspace_discovery_nonces FROM PUBLIC, astra_app, astra_worker;
GRANT EXECUTE ON FUNCTION astra.list_my_workspaces(text, bigint, uuid, text) TO astra_app;
REVOKE ALL ON FUNCTION astra.list_my_workspaces(text, bigint, uuid, text) FROM PUBLIC;

RESET ROLE;
COMMIT;
