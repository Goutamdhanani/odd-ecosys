-- X14 execution-ticket emergency revocation for the app plane.
--
-- astra.execution_tickets is worker-role only by design (migration 012 grants
-- UPDATE solely to astra_worker). Release revocation and pointer activation run
-- inside tenant app transactions, so their ticket invalidation must go through
-- this audited SECURITY DEFINER boundary instead of a direct UPDATE.

CREATE OR REPLACE FUNCTION astra.revoke_issued_execution_tickets(
  p_tenant_id uuid,
  p_campaign_id uuid,
  p_reason text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, astra
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF p_tenant_id IS NULL OR p_campaign_id IS NULL
     OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 240 THEN
    RAISE EXCEPTION 'invalid ticket revocation parameters' USING ERRCODE = '22023';
  END IF;
  UPDATE astra.execution_tickets
     SET revoked_at = COALESCE(revoked_at, clock_timestamp()),
         revoke_reason = COALESCE(revoke_reason, p_reason)
   WHERE tenant_id = p_tenant_id
     AND campaign_id = p_campaign_id
     AND state = 'issued';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$function$;

GRANT EXECUTE ON FUNCTION astra.revoke_issued_execution_tickets(uuid, uuid, text) TO astra_app, astra_worker;
REVOKE ALL ON FUNCTION astra.revoke_issued_execution_tickets(uuid, uuid, text) FROM PUBLIC;