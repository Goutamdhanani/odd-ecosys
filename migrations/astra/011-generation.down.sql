BEGIN;
SET ROLE astra_owner;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM astra.generation_jobs) OR EXISTS (SELECT 1 FROM astra.generation_tenant_policies) THEN
    RAISE EXCEPTION 'Generation history or policy exists; preserve it before rollback.' USING ERRCODE='55000';
  END IF;
END $$;
DROP TRIGGER astra_generation_jobs_no_truncate ON astra.generation_jobs;
DROP TRIGGER astra_generation_jobs_guard ON astra.generation_jobs;
DROP FUNCTION astra.generation_reserved_today();
DROP FUNCTION astra.generation_job_guard();
DROP TABLE astra.generation_jobs;
DROP TABLE astra.generation_tenant_policies;
RESET ROLE;
COMMIT;
