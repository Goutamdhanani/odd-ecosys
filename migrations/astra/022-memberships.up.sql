-- Tenant membership administration and single-use invitations, migration 022.
-- Apply only to a disposable Astra PostgreSQL candidate with migration owner.
BEGIN;

SET ROLE astra_owner;

CREATE TABLE astra.invitations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320 AND email = lower(btrim(email))),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'reviewer')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id text NOT NULL CHECK (length(created_by_user_id) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_by_user_id text CHECK (accepted_by_user_id IS NULL OR length(accepted_by_user_id) BETWEEN 1 AND 40),
  CHECK (expires_at > created_at),
  CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL)),
  CHECK (revoked_at IS NULL OR accepted_at IS NULL)
);
CREATE INDEX invitations_tenant_pending_idx ON astra.invitations (tenant_id, created_at DESC)
  WHERE revoked_at IS NULL AND accepted_at IS NULL;

CREATE TABLE astra.membership_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  actor_user_id text NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 40),
  action text NOT NULL CHECK (action IN ('invitation.created', 'invitation.revoked', 'invitation.accepted', 'membership.role_changed', 'membership.revoked')),
  target_user_id text CHECK (target_user_id IS NULL OR length(target_user_id) BETWEEN 1 AND 40),
  invitation_id uuid REFERENCES astra.invitations(id) ON DELETE RESTRICT,
  previous_role text CHECK (previous_role IS NULL OR previous_role IN ('owner', 'admin', 'operator', 'reviewer')),
  next_role text CHECK (next_role IS NULL OR next_role IN ('owner', 'admin', 'operator', 'reviewer')),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX membership_audit_tenant_time_idx ON astra.membership_audit (tenant_id, occurred_at DESC);

CREATE TABLE astra.invitation_nonces (
  nonce uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE astra.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE astra.membership_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.membership_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE astra.invitation_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.invitation_nonces FORCE ROW LEVEL SECURITY;

CREATE POLICY invitations_owner_all ON astra.invitations FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY invitations_app_scope ON astra.invitations FOR SELECT TO astra_app
  USING (astra.context_allows(tenant_id));
CREATE POLICY membership_audit_owner_all ON astra.membership_audit FOR ALL TO astra_owner USING (true) WITH CHECK (true);
CREATE POLICY membership_audit_app_scope ON astra.membership_audit FOR SELECT TO astra_app
  USING (astra.context_allows(tenant_id));
CREATE POLICY invitation_nonces_owner_only ON astra.invitation_nonces FOR ALL TO astra_owner USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION astra.create_invitation(
  p_tenant_id uuid, p_actor_user_id text, p_email text, p_role text,
  p_token_hash text, p_expires_at timestamptz
)
RETURNS TABLE(invitation_id uuid, created_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, astra
AS $function$
DECLARE v_actor_role text; v_id uuid; v_created timestamptz;
BEGIN
  IF p_tenant_id IS NULL OR p_actor_user_id IS NULL OR length(p_actor_user_id) NOT BETWEEN 1 AND 40
     OR p_email IS NULL OR length(p_email) NOT BETWEEN 3 AND 320 OR p_email <> lower(btrim(p_email))
     OR p_role NOT IN ('owner', 'admin', 'operator', 'reviewer')
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_expires_at <= pg_catalog.clock_timestamp() + interval '15 minutes'
     OR p_expires_at > pg_catalog.clock_timestamp() + interval '7 days' THEN
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
  VALUES (p_tenant_id, p_email, p_role, p_token_hash, p_actor_user_id, p_expires_at)
  RETURNING id, astra.invitations.created_at INTO v_id, v_created;
  INSERT INTO astra.membership_audit (tenant_id, actor_user_id, action, invitation_id, next_role)
  VALUES (p_tenant_id, p_actor_user_id, 'invitation.created', v_id, p_role);
  RETURN QUERY SELECT v_id, v_created, p_expires_at;
END
$function$;

CREATE OR REPLACE FUNCTION astra.change_membership_role(
  p_tenant_id uuid, p_actor_user_id text, p_target_user_id text, p_role text
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, astra
AS $function$
DECLARE v_actor_role text; v_previous text; v_owners bigint;
BEGIN
  IF p_tenant_id IS NULL OR p_actor_user_id IS NULL OR length(p_actor_user_id) NOT BETWEEN 1 AND 40
     OR p_target_user_id IS NULL OR length(p_target_user_id) NOT BETWEEN 1 AND 40
     OR p_role NOT IN ('owner', 'admin', 'operator', 'reviewer') THEN
    RAISE EXCEPTION 'membership input invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT astra.context_allows(p_tenant_id)
     OR pg_catalog.current_setting('astra.user_id', true) IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'tenant authorization required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM astra.tenants WHERE id = p_tenant_id FOR UPDATE;
  SELECT role INTO v_actor_role FROM astra.memberships WHERE tenant_id = p_tenant_id AND user_id = p_actor_user_id AND revoked_at IS NULL;
  SELECT role INTO v_previous FROM astra.memberships WHERE tenant_id = p_tenant_id AND user_id = p_target_user_id AND revoked_at IS NULL FOR UPDATE;
  IF v_actor_role NOT IN ('owner', 'admin') OR v_previous IS NULL
     OR ((v_previous = 'owner' OR p_role = 'owner') AND v_actor_role <> 'owner') THEN
    RAISE EXCEPTION 'tenant authorization required' USING ERRCODE = '42501';
  END IF;
  IF v_previous = 'owner' AND p_role <> 'owner' THEN
    SELECT count(*) INTO v_owners FROM astra.memberships WHERE tenant_id = p_tenant_id AND role = 'owner' AND revoked_at IS NULL;
    IF v_owners <= 1 THEN RAISE EXCEPTION 'the last active tenant owner cannot be removed' USING ERRCODE = '23514'; END IF;
  END IF;
  UPDATE astra.memberships SET role = p_role WHERE tenant_id = p_tenant_id AND user_id = p_target_user_id;
  INSERT INTO astra.membership_audit (tenant_id, actor_user_id, action, target_user_id, previous_role, next_role)
  VALUES (p_tenant_id, p_actor_user_id, 'membership.role_changed', p_target_user_id, v_previous, p_role);
  RETURN p_role;
END
$function$;

CREATE OR REPLACE FUNCTION astra.revoke_membership(
  p_tenant_id uuid, p_actor_user_id text, p_target_user_id text
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, astra
AS $function$
DECLARE v_actor_role text; v_previous text; v_owners bigint;
BEGIN
  IF p_tenant_id IS NULL OR p_actor_user_id IS NULL OR length(p_actor_user_id) NOT BETWEEN 1 AND 40
     OR p_target_user_id IS NULL OR length(p_target_user_id) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'membership input invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT astra.context_allows(p_tenant_id)
     OR pg_catalog.current_setting('astra.user_id', true) IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'tenant authorization required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM astra.tenants WHERE id = p_tenant_id FOR UPDATE;
  SELECT role INTO v_actor_role FROM astra.memberships WHERE tenant_id = p_tenant_id AND user_id = p_actor_user_id AND revoked_at IS NULL;
  SELECT role INTO v_previous FROM astra.memberships WHERE tenant_id = p_tenant_id AND user_id = p_target_user_id AND revoked_at IS NULL FOR UPDATE;
  IF v_actor_role NOT IN ('owner', 'admin') OR v_previous IS NULL OR (v_previous = 'owner' AND v_actor_role <> 'owner') THEN
    RAISE EXCEPTION 'tenant authorization required' USING ERRCODE = '42501';
  END IF;
  IF v_previous = 'owner' THEN
    SELECT count(*) INTO v_owners FROM astra.memberships WHERE tenant_id = p_tenant_id AND role = 'owner' AND revoked_at IS NULL;
    IF v_owners <= 1 THEN RAISE EXCEPTION 'the last active tenant owner cannot be removed' USING ERRCODE = '23514'; END IF;
  END IF;
  UPDATE astra.memberships SET revoked_at = pg_catalog.clock_timestamp()
   WHERE tenant_id = p_tenant_id AND user_id = p_target_user_id;
  INSERT INTO astra.membership_audit (tenant_id, actor_user_id, action, target_user_id, previous_role)
  VALUES (p_tenant_id, p_actor_user_id, 'membership.revoked', p_target_user_id, v_previous);
END
$function$;

CREATE OR REPLACE FUNCTION astra.revoke_invitation(
  p_tenant_id uuid, p_actor_user_id text, p_invitation_id uuid
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, astra
AS $function$
DECLARE v_actor_role text; v_role text;
BEGIN
  IF p_tenant_id IS NULL OR p_actor_user_id IS NULL OR length(p_actor_user_id) NOT BETWEEN 1 AND 40 OR p_invitation_id IS NULL THEN
    RAISE EXCEPTION 'invitation input invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT astra.context_allows(p_tenant_id)
     OR pg_catalog.current_setting('astra.user_id', true) IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'tenant authorization required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM astra.tenants WHERE id = p_tenant_id FOR UPDATE;
  SELECT role INTO v_actor_role FROM astra.memberships WHERE tenant_id = p_tenant_id AND user_id = p_actor_user_id AND revoked_at IS NULL;
  SELECT role INTO v_role FROM astra.invitations WHERE tenant_id = p_tenant_id AND id = p_invitation_id
   AND revoked_at IS NULL AND accepted_at IS NULL FOR UPDATE;
  IF v_actor_role NOT IN ('owner', 'admin') OR v_role IS NULL OR (v_role = 'owner' AND v_actor_role <> 'owner') THEN
    RAISE EXCEPTION 'tenant authorization required' USING ERRCODE = '42501';
  END IF;
  UPDATE astra.invitations SET revoked_at = pg_catalog.clock_timestamp() WHERE id = p_invitation_id;
  INSERT INTO astra.membership_audit (tenant_id, actor_user_id, action, invitation_id, next_role)
  VALUES (p_tenant_id, p_actor_user_id, 'invitation.revoked', p_invitation_id, v_role);
END
$function$;

-- This capability lookup reveals only the tenant UUID to a caller holding a
-- 256-bit random invitation token. All acceptance conditions are rechecked
-- under row lock by accept_invitation.
CREATE OR REPLACE FUNCTION astra.prepare_invitation_acceptance(p_token_hash text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, astra
AS $function$
DECLARE v_tenant uuid;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  SELECT tenant_id INTO v_tenant FROM astra.invitations
   WHERE token_hash = p_token_hash AND revoked_at IS NULL AND accepted_at IS NULL
     AND expires_at > pg_catalog.clock_timestamp();
  RETURN v_tenant;
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
  IF v_inviter_role NOT IN ('owner', 'admin') OR (v_role = 'owner' AND v_inviter_role <> 'owner') THEN
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

REVOKE ALL ON astra.invitations, astra.membership_audit, astra.invitation_nonces FROM PUBLIC, astra_app, astra_worker;
GRANT SELECT ON astra.invitations, astra.membership_audit TO astra_app;
GRANT EXECUTE ON FUNCTION astra.create_invitation(uuid, text, text, text, text, timestamptz) TO astra_app;
GRANT EXECUTE ON FUNCTION astra.change_membership_role(uuid, text, text, text) TO astra_app;
GRANT EXECUTE ON FUNCTION astra.revoke_membership(uuid, text, text) TO astra_app;
GRANT EXECUTE ON FUNCTION astra.revoke_invitation(uuid, text, uuid) TO astra_app;
GRANT EXECUTE ON FUNCTION astra.prepare_invitation_acceptance(text) TO astra_app;
GRANT EXECUTE ON FUNCTION astra.accept_invitation(text, uuid, text, text, bigint, uuid, text) TO astra_app;
REVOKE ALL ON FUNCTION astra.create_invitation(uuid, text, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.change_membership_role(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.revoke_membership(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.revoke_invitation(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.prepare_invitation_acceptance(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.accept_invitation(text, uuid, text, text, bigint, uuid, text) FROM PUBLIC;

RESET ROLE;
COMMIT;
