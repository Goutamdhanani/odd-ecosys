-- S35 offline, detached Ed25519 customer approval with human-reviewed key enrollment.
BEGIN;
SET ROLE astra_owner;
ALTER TABLE astra.post_sale_case_studies ADD CONSTRAINT post_sale_case_tenant_id_project_unique UNIQUE(tenant_id,id,project_id);

CREATE TABLE astra.customer_approval_keys (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  account_id uuid NOT NULL,
  public_key_pem text NOT NULL CHECK(length(public_key_pem) BETWEEN 1 AND 4096),
  key_fingerprint_sha256 char(64) NOT NULL CHECK(key_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  identity_evidence_sha256 char(64) NOT NULL CHECK(identity_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  rights_evidence_sha256 char(64) NOT NULL CHECK(rights_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  identity_basis text NOT NULL DEFAULT 'human_reviewed' CHECK(identity_basis='human_reviewed'),
  enrolled_by text NOT NULL CHECK(enrolled_by ~ '^[1-9][0-9]{0,39}$'),
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_by text CHECK(confirmed_by IS NULL OR confirmed_by ~ '^[1-9][0-9]{0,39}$'),
  confirmed_at timestamptz,
  revoked_by text CHECK(revoked_by IS NULL OR revoked_by ~ '^[1-9][0-9]{0,39}$'),
  revoked_at timestamptz,
  revocation_reason text CHECK(revocation_reason IS NULL OR length(revocation_reason) BETWEEN 1 AND 500),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,project_id,key_fingerprint_sha256), UNIQUE(tenant_id,id,project_id,account_id),
  FOREIGN KEY(tenant_id,project_id) REFERENCES astra.post_sale_projects(tenant_id,id) ON DELETE RESTRICT,
  CHECK((confirmed_by IS NULL)=(confirmed_at IS NULL)),
  CHECK((revoked_by IS NULL)=(revoked_at IS NULL) AND (revoked_at IS NULL)=(revocation_reason IS NULL)),
  CHECK(confirmed_by IS NULL OR confirmed_by<>enrolled_by)
);
CREATE INDEX customer_approval_keys_binding_idx ON astra.customer_approval_keys(tenant_id,project_id,account_id) WHERE confirmed_at IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE astra.customer_approval_project_revocations (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), project_id uuid NOT NULL,
  revoked_by text NOT NULL CHECK(revoked_by ~ '^[1-9][0-9]{0,39}$'),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500), revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,project_id),
  FOREIGN KEY(tenant_id,project_id) REFERENCES astra.post_sale_projects(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.customer_approval_challenges (
  tenant_id uuid NOT NULL, id uuid NOT NULL, project_id uuid NOT NULL, account_id uuid NOT NULL,
  case_study_id uuid NOT NULL, case_study_version integer NOT NULL CHECK(case_study_version>0), customer_key_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose='case_study_customer_consent'), action text NOT NULL CHECK(action IN ('approve','reject')),
  challenge_bytes text NOT NULL CHECK(length(challenge_bytes) BETWEEN 1 AND 32768),
  challenge_sha256 char(64) NOT NULL CHECK(challenge_sha256 ~ '^[a-f0-9]{64}$'),
  nonce text NOT NULL CHECK(length(nonce) BETWEEN 32 AND 128), issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  forwarded_by text NOT NULL CHECK(forwarded_by ~ '^[1-9][0-9]{0,39}$'), used_at timestamptz,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,nonce),
  FOREIGN KEY(tenant_id,project_id) REFERENCES astra.post_sale_projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,case_study_id,project_id) REFERENCES astra.post_sale_case_studies(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,customer_key_id,project_id,account_id) REFERENCES astra.customer_approval_keys(tenant_id,id,project_id,account_id) ON DELETE RESTRICT,
  CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '30 minutes')
);

CREATE TABLE astra.customer_approval_receipts (
  tenant_id uuid NOT NULL, receipt_id uuid NOT NULL, challenge_id uuid NOT NULL, project_id uuid NOT NULL,
  case_study_id uuid NOT NULL, signer_key_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('approve','reject')),
  challenge_sha256 char(64) NOT NULL CHECK(challenge_sha256 ~ '^[a-f0-9]{64}$'),
  signature_base64 text NOT NULL CHECK(length(signature_base64)=88), signature_sha256 char(64) NOT NULL CHECK(signature_sha256 ~ '^[a-f0-9]{64}$'),
  forwarded_by text NOT NULL CHECK(forwarded_by ~ '^[1-9][0-9]{0,39}$'),
  verification text NOT NULL DEFAULT 'ed25519_signature_verified_against_human_reviewed_key' CHECK(verification='ed25519_signature_verified_against_human_reviewed_key'),
  identity_basis text NOT NULL DEFAULT 'human_reviewed' CHECK(identity_basis='human_reviewed'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,receipt_id), UNIQUE(tenant_id,challenge_id),
  FOREIGN KEY(tenant_id,challenge_id) REFERENCES astra.customer_approval_challenges(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,project_id) REFERENCES astra.post_sale_projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,case_study_id) REFERENCES astra.post_sale_case_studies(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,signer_key_id) REFERENCES astra.customer_approval_keys(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX customer_approval_receipts_case_idx ON astra.customer_approval_receipts(tenant_id,case_study_id,created_at DESC);

CREATE FUNCTION astra.guard_customer_approval_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.tenant_id,NEW.id,NEW.project_id,NEW.account_id,NEW.public_key_pem,NEW.key_fingerprint_sha256,NEW.identity_evidence_sha256,NEW.rights_evidence_sha256,NEW.identity_basis,NEW.enrolled_by,NEW.enrolled_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.project_id,OLD.account_id,OLD.public_key_pem,OLD.key_fingerprint_sha256,OLD.identity_evidence_sha256,OLD.rights_evidence_sha256,OLD.identity_basis,OLD.enrolled_by,OLD.enrolled_at)
    OR (OLD.confirmed_at IS NOT NULL AND (NEW.confirmed_by,NEW.confirmed_at) IS DISTINCT FROM (OLD.confirmed_by,OLD.confirmed_at))
    OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_by,NEW.revoked_at,NEW.revocation_reason) IS DISTINCT FROM (OLD.revoked_by,OLD.revoked_at,OLD.revocation_reason))
    OR (OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL AND (NEW.confirmed_by IS NULL OR NEW.confirmed_by=OLD.enrolled_by))
    OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND (NEW.revoked_by IS NULL OR NEW.revocation_reason IS NULL))
    OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NULL) OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL)
  THEN RAISE EXCEPTION 'Customer approval key facts are immutable; confirmation and revocation are one-way.' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION astra.guard_customer_approval_key_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.revocation_reason IS NOT NULL
  THEN RAISE EXCEPTION 'Customer key enrollment must begin pending review.' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_approval_key_insert_guard BEFORE INSERT ON astra.customer_approval_keys FOR EACH ROW EXECUTE FUNCTION astra.guard_customer_approval_key_insert();
CREATE TRIGGER customer_approval_key_guard BEFORE UPDATE OR DELETE ON astra.customer_approval_keys FOR EACH ROW EXECUTE FUNCTION astra.guard_customer_approval_key();
CREATE FUNCTION astra.guard_customer_approval_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.tenant_id,NEW.id,NEW.project_id,NEW.account_id,NEW.case_study_id,NEW.case_study_version,NEW.customer_key_id,NEW.purpose,NEW.action,NEW.challenge_bytes,NEW.challenge_sha256,NEW.nonce,NEW.issued_at,NEW.expires_at,NEW.forwarded_by)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.project_id,OLD.account_id,OLD.case_study_id,OLD.case_study_version,OLD.customer_key_id,OLD.purpose,OLD.action,OLD.challenge_bytes,OLD.challenge_sha256,OLD.nonce,OLD.issued_at,OLD.expires_at,OLD.forwarded_by)
    OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at) THEN RAISE EXCEPTION 'Approval challenge bindings are immutable and single use.' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_approval_challenge_guard BEFORE UPDATE OR DELETE ON astra.customer_approval_challenges FOR EACH ROW EXECUTE FUNCTION astra.guard_customer_approval_challenge();
CREATE FUNCTION astra.guard_customer_approval_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Customer approval receipts and revocation facts are append only.' USING ERRCODE='55000'; END $$;
CREATE TRIGGER customer_approval_project_revocation_guard BEFORE UPDATE OR DELETE ON astra.customer_approval_project_revocations FOR EACH ROW EXECUTE FUNCTION astra.guard_customer_approval_immutable();
CREATE TRIGGER customer_approval_receipt_guard BEFORE UPDATE OR DELETE ON astra.customer_approval_receipts FOR EACH ROW EXECUTE FUNCTION astra.guard_customer_approval_immutable();

-- Serialize the final claim. An exact repeated proof returns the original receipt; a different proof cannot reuse it.
CREATE FUNCTION astra.record_customer_approval_receipt(p_tenant uuid,p_challenge uuid,p_receipt uuid,p_signature_hash text,p_signature_base64 text,p_forwarder text,p_signer_key uuid,p_project uuid,p_case uuid,p_action text,p_challenge_hash text)
RETURNS TABLE(receipt_id uuid,created_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,astra AS $$
DECLARE old astra.customer_approval_receipts%ROWTYPE;
BEGIN
  IF NOT astra.context_allows(p_tenant) THEN RAISE EXCEPTION 'Verified tenant context is required.' USING ERRCODE='42501'; END IF;
  IF p_signature_hash !~ '^[a-f0-9]{64}$' OR p_challenge_hash !~ '^[a-f0-9]{64}$' OR length(p_signature_base64)<>88 OR p_action NOT IN ('approve','reject') THEN RAISE EXCEPTION 'Invalid approval proof.' USING ERRCODE='22023'; END IF;
  SELECT * INTO old FROM astra.customer_approval_receipts r WHERE r.tenant_id=p_tenant AND r.challenge_id=p_challenge;
  IF FOUND THEN
    IF old.signature_sha256<>p_signature_hash THEN RAISE EXCEPTION 'Approval challenge already consumed by different proof.' USING ERRCODE='23505'; END IF;
    RETURN QUERY SELECT old.receipt_id,old.created_at; RETURN;
  END IF;
  UPDATE astra.customer_approval_challenges ch SET used_at=clock_timestamp()
    WHERE ch.tenant_id=p_tenant AND ch.id=p_challenge AND ch.used_at IS NULL AND ch.expires_at>clock_timestamp()
      AND ch.project_id=p_project AND ch.case_study_id=p_case AND ch.customer_key_id=p_signer_key AND ch.action=p_action AND ch.challenge_sha256=p_challenge_hash
      AND EXISTS(SELECT 1 FROM astra.customer_approval_keys k WHERE k.tenant_id=ch.tenant_id AND k.id=ch.customer_key_id AND k.project_id=ch.project_id AND k.account_id=ch.account_id AND k.confirmed_at IS NOT NULL AND k.revoked_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM astra.customer_approval_project_revocations pr WHERE pr.tenant_id=ch.tenant_id AND pr.project_id=ch.project_id);
  IF NOT FOUND THEN
    SELECT * INTO old FROM astra.customer_approval_receipts r WHERE r.tenant_id=p_tenant AND r.challenge_id=p_challenge;
    IF FOUND AND old.signature_sha256=p_signature_hash THEN RETURN QUERY SELECT old.receipt_id,old.created_at; RETURN; END IF;
    RAISE EXCEPTION 'Approval challenge is expired, unavailable, or already consumed.' USING ERRCODE='55000';
  END IF;
  INSERT INTO astra.customer_approval_receipts(tenant_id,receipt_id,challenge_id,project_id,case_study_id,signer_key_id,action,challenge_sha256,signature_base64,signature_sha256,forwarded_by)
    VALUES(p_tenant,p_receipt,p_challenge,p_project,p_case,p_signer_key,p_action,p_challenge_hash,p_signature_base64,p_signature_hash,p_forwarder);
  RETURN QUERY SELECT p_receipt,clock_timestamp();
END $$;

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['customer_approval_keys','customer_approval_project_revocations','customer_approval_challenges','customer_approval_receipts'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',tab); EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_owner USING(true) WITH CHECK(true)',tab||'_owner_all',tab);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING(astra.context_allows(tenant_id)) WITH CHECK(astra.context_allows(tenant_id))',tab||'_tenant_scope',tab);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON astra.customer_approval_keys TO astra_app,astra_worker;
GRANT SELECT,INSERT ON astra.customer_approval_project_revocations,astra.customer_approval_challenges TO astra_app,astra_worker;
GRANT SELECT ON astra.customer_approval_receipts TO astra_app,astra_worker;
GRANT EXECUTE ON FUNCTION astra.record_customer_approval_receipt(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,text,text) TO astra_app,astra_worker;
REVOKE ALL ON FUNCTION astra.record_customer_approval_receipt(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_customer_approval_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_customer_approval_key_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_customer_approval_challenge() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_customer_approval_immutable() FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.customer_approval_project_revocations,astra.customer_approval_receipts FROM astra_app,astra_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON astra.customer_approval_challenges FROM astra_app,astra_worker;
REVOKE DELETE,TRUNCATE ON astra.customer_approval_keys FROM astra_app,astra_worker;
RESET ROLE;
COMMIT;
