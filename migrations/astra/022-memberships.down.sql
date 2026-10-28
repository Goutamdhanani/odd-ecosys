-- Roll back migration 022 membership management objects. Existing memberships
-- are retained; invitation and audit history is removed with these objects.
BEGIN;
SET ROLE astra_owner;

DROP FUNCTION astra.accept_invitation(text, uuid, text, text, bigint, uuid, text);
DROP FUNCTION astra.prepare_invitation_acceptance(text);
DROP FUNCTION astra.revoke_invitation(uuid, text, uuid);
DROP FUNCTION astra.revoke_membership(uuid, text, text);
DROP FUNCTION astra.change_membership_role(uuid, text, text, text);
DROP FUNCTION astra.create_invitation(uuid, text, text, text, text, timestamptz);
DROP TABLE astra.invitation_nonces;
DROP TABLE astra.membership_audit;
DROP TABLE astra.invitations;

RESET ROLE;
COMMIT;
