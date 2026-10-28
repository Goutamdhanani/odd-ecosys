-- Invitation hardening: database-authoritative default expiry and acceptance time,
-- plus inviter revocation/demotion invalidation without rewriting audit history.
BEGIN;
SET ROLE astra_owner;

CREATE OR REPLACE FUNCTION astra.create_invitation(
  p_tenant_id uuid, p_actor_user_id text, p_email text, p_role text,
  p_token_hash text, p_expires_at timestamptz
)
RETURNS TABLE(invitation_id uuid, created_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, astra
AS $function$
DECLARE v_actor_role text; v_id uuid; v_created timestamptz; v_expiry timestamptz;
BEGIN
  v_expiry := COALESCE(p_expires_at, pg_catalog.clock_timestamp() + interval '7 days');
  IF p_tenant_id IS NULL OR p_actor_user_id IS NULL OR length(p_actor_user_id) NOT BETWEEN 1 AND 40
     OR p_email IS NULL OR length(p_email) NOT BETWEEN 3 AND 320 OR p_email <> lower(btrim(p_email))
     OR p_role NOT IN ('owner', 'admin', 'operator', 'reviewer')
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR v_expiry <= pg_catalog.clock_timestamp() + interval '15 minutes'
     OR v_expiry > pg_catalog.clock_timestamp() + interval '7 days' THEN
    RAISE EXCEPTION 'invitation input invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT astra.context_allows(p_tenant_id)
     OR pg_catalog.current_setting('astra.user_id', true) IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'tenant authorization required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM astra.tenants WHERE id = p_tenant_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant authorization required' USING ERRCODE = '42501'; END IF;
  SELECT m.role INTO v_actor_role FROM astra.memberships AS m
   WHERE m.tenant_id = p_tenant_id AND m.user_id = p_actor_user_id AND m.revoked_at IS NULL FOR UPDATE;
  IF v_actor_role NOT IN ('owner', 'admin') OR (p_role = 'owner' AND v_actor_role <> 'owner') THEN
    RAISE EXCEPTION 'tenant authorization required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO astra.invitations (tenant_id, email, role, token_hash, created_by_user_id, expires_at)
  VALUES (p_tenant_id, p_email, p_role, p_token_hash, p_actor_user_id, v_expiry)
  RETURNING id, astra.invitations.created_at INTO v_id, v_created;
  INSERT INTO astra.membership_audit (tenant_id, actor_user_id, action, invitation_id, next_role)
  VALUES (p_tenant_id, p_actor_user_id, 'invitation.created', v_id, p_role);
  RETURN QUERY SELECT v_id, v_created, v_expiry;
END
$function$;

CREATE OR REPLACE FUNCTION astra.accept_invitation(
  p_token_hash text, p_tenant_id uuid, p_user_id text, p_email_hash text,
  p_expires_at bigint, p_nonce uuid, p_proof text
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, astra
AS $function$
DECLARE v_inv astra.invitations%ROWTYPE; v_secret bytea; v_expected text; v_now bigint; v_role text; v_resolved_tenant uuid; v_inviter_role text;
BEGIN
  v_now := floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_tenant_id IS NULL
     OR p_user_id IS NULL OR length(p_user_id) NOT BETWEEN 1 AND 40
     OR p_email_hash IS NULL OR p_email_hash !~ '^[0-9a-f]{64}$'
     OR p_nonce IS NULL OR p_proof IS NULL OR p_proof !~ '^[0-9a-f]{64}$'
     OR p_expires_at < v_now OR p_expires_at > v_now + 30 THEN
    RAISE EXCEPTION 'invitation acceptance rejected' USING ERRCODE = '42501';
  END IF;
  SELECT secret INTO v_secret FROM astra.context_keys WHERE singleton = true;
  IF v_secret IS NULL THEN RAISE EXCEPTION 'invitation verifier unavailable' USING ERRCODE = '55000'; END IF;
  v_expected := pg_catalog.encode(public.hmac(pg_catalog.convert_to(
    'accept_invitation' || E'\n' || p_token_hash || E'\n' || p_tenant_id::text || E'\n' || p_user_id || E'\n' || p_email_hash || E'\n' || p_expires_at::text || E'\n' || p_nonce::text,
    'UTF8'), v_secret, 'sha256'), 'hex');
  IF v_expected IS DISTINCT FROM p_proof THEN RAISE EXCEPTION 'invitation acceptance rejected' USING ERRCODE = '42501'; END IF;
  SELECT tenant_id INTO v_resolved_tenant FROM astra.invitations WHERE token_hash = p_token_hash;
  IF NOT FOUND OR v_resolved_tenant <> p_tenant_id THEN RAISE EXCEPTION 'invitation acceptance rejected' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM astra.tenants WHERE id = v_resolved_tenant AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation acceptance rejected' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_inv FROM astra.invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_inv.tenant_id <> p_tenant_id OR v_inv.revoked_at IS NOT NULL
     OR v_inv.accepted_at IS NOT NULL OR v_inv.expires_at <= pg_catalog.clock_timestamp()
     OR pg_catalog.encode(public.digest(pg_catalog.convert_to(v_inv.email, 'UTF8'), 'sha256'), 'hex') <> p_email_hash THEN
    RAISE EXCEPTION 'invitation acceptance rejected' USING ERRCODE = '42501';
  END IF;
  DELETE FROM astra.invitation_nonces WHERE expires_at < pg_catalog.clock_timestamp();
  INSERT INTO astra.invitation_nonces (nonce, expires_at) VALUES (p_nonce, pg_catalog.to_timestamp(p_expires_at));
  v_role := v_inv.role;
  SELECT role INTO v_inviter_role FROM astra.memberships
   WHERE tenant_id = v_inv.tenant_id AND user_id = v_inv.created_by_user_id AND revoked_at IS NULL;
  IF v_inviter_role IS NULL OR v_inviter_role NOT IN ('owner', 'admin')
     OR (v_role = 'owner' AND v_inviter_role <> 'owner')
     OR EXISTS (
       SELECT 1 FROM astra.membership_audit AS a
       WHERE a.tenant_id = v_inv.tenant_id
         AND a.target_user_id = v_inv.created_by_user_id
         AND a.action IN ('membership.role_changed', 'membership.revoked')
         AND a.occurred_at > v_inv.created_at
     ) THEN
    RAISE EXCEPTION 'invitation acceptance rejected' USING ERRCODE = '42501';
  END IF;
  INSERT INTO astra.memberships (tenant_id, user_id, role, granted_by_user_id, revoked_at)
  VALUES (v_inv.tenant_id, p_user_id, v_role, v_inv.created_by_user_id, NULL)
  ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role,
    granted_by_user_id = EXCLUDED.granted_by_user_id, revoked_at = NULL
  WHERE astra.memberships.revoked_at IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'active membership already exists' USING ERRCODE = '23505'; END IF;
  UPDATE astra.invitations SET accepted_at = pg_catalog.clock_timestamp(), accepted_by_user_id = p_user_id WHERE id = v_inv.id;
  INSERT INTO astra.membership_audit (tenant_id, actor_user_id, action, target_user_id, invitation_id, next_role)
  VALUES (v_inv.tenant_id, p_user_id, 'invitation.accepted', p_user_id, v_inv.id, v_role);
  RETURN v_role;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'invitation acceptance rejected' USING ERRCODE = '42501';
END
$function$;

COMMIT;
