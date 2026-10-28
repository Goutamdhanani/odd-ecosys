BEGIN;
SET ROLE astra_owner;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM astra.customer_approval_receipts) OR EXISTS(SELECT 1 FROM astra.customer_approval_challenges)
    OR EXISTS(SELECT 1 FROM astra.customer_approval_project_revocations) OR EXISTS(SELECT 1 FROM astra.customer_approval_keys)
  THEN RAISE EXCEPTION 'Customer approval facts exist; migration rollback would destroy approval or revocation evidence.' USING ERRCODE='55000'; END IF;
END $$;
DROP FUNCTION astra.record_customer_approval_receipt(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,text,text);
DROP TRIGGER customer_approval_receipt_guard ON astra.customer_approval_receipts;
DROP TRIGGER customer_approval_project_revocation_guard ON astra.customer_approval_project_revocations;
DROP TRIGGER customer_approval_challenge_guard ON astra.customer_approval_challenges;
DROP TRIGGER customer_approval_key_guard ON astra.customer_approval_keys;
DROP TRIGGER customer_approval_key_insert_guard ON astra.customer_approval_keys;
DROP TABLE astra.customer_approval_receipts;
DROP TABLE astra.customer_approval_challenges;
DROP TABLE astra.customer_approval_project_revocations;
DROP TABLE astra.customer_approval_keys;
DROP FUNCTION astra.guard_customer_approval_immutable();
DROP FUNCTION astra.guard_customer_approval_challenge();
DROP FUNCTION astra.guard_customer_approval_key();
DROP FUNCTION astra.guard_customer_approval_key_insert();
ALTER TABLE astra.post_sale_case_studies DROP CONSTRAINT post_sale_case_tenant_id_project_unique;
RESET ROLE;
COMMIT;
