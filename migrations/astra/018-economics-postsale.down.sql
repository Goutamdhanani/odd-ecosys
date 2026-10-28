BEGIN;
SET ROLE astra_owner;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM astra.economics_quota_reservations) OR EXISTS(SELECT 1 FROM astra.economics_vendor_bills)
    OR EXISTS(SELECT 1 FROM astra.economics_reviewer_effort) OR EXISTS(SELECT 1 FROM astra.post_sale_projects)
    OR EXISTS(SELECT 1 FROM astra.post_sale_milestones) OR EXISTS(SELECT 1 FROM astra.post_sale_evidence)
    OR EXISTS(SELECT 1 FROM astra.post_sale_case_studies) OR EXISTS(SELECT 1 FROM astra.post_sale_renewal_signals)
    OR EXISTS(SELECT 1 FROM astra.economics_tenant_quotas) THEN
    RAISE EXCEPTION 'Migration 018 contains quota or post-sale evidence; preserve it and use a reviewed forward migration.';
  END IF;
END $$;
DROP FUNCTION astra.canonical_outcome_events(uuid);
DROP FUNCTION astra.reconcile_economics_quota(uuid,uuid,text,bigint,text,jsonb,text);
DROP FUNCTION astra.reserve_economics_quota(uuid,uuid,text,bigint,integer,integer);
DROP TRIGGER post_sale_evidence_guard ON astra.post_sale_evidence;
DROP TRIGGER economics_bill_immutable ON astra.economics_vendor_bills;
DROP TRIGGER economics_effort_immutable ON astra.economics_reviewer_effort;
DROP TRIGGER post_sale_project_guard ON astra.post_sale_projects;
DROP TRIGGER post_sale_milestone_guard ON astra.post_sale_milestones;
DROP TRIGGER post_sale_case_guard ON astra.post_sale_case_studies;
DROP TRIGGER post_sale_renewal_guard ON astra.post_sale_renewal_signals;
DROP TABLE astra.post_sale_renewal_signals;
DROP TABLE astra.post_sale_case_studies;
DROP TABLE astra.post_sale_evidence;
DROP TABLE astra.post_sale_milestones;
DROP TABLE astra.post_sale_projects;
DROP TABLE astra.economics_reviewer_effort;
DROP TABLE astra.economics_vendor_bills;
DROP TABLE astra.economics_quota_reservations;
DROP TABLE astra.economics_tenant_quotas;
DROP FUNCTION astra.guard_post_sale_evidence();
DROP FUNCTION astra.guard_economics_immutable();
RESET ROLE;
COMMIT;
