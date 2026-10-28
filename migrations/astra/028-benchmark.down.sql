BEGIN;
SET ROLE astra_owner;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM astra.economics_benchmark_quote_reviews)
    OR EXISTS(SELECT 1 FROM astra.economics_benchmark_quotes)
    OR EXISTS(SELECT 1 FROM astra.economics_benchmark_reports)
    OR EXISTS(SELECT 1 FROM astra.economics_benchmark_observations)
    OR EXISTS(SELECT 1 FROM astra.economics_benchmark_cohort_members)
    OR EXISTS(SELECT 1 FROM astra.economics_benchmark_cohorts) THEN
    RAISE EXCEPTION 'Benchmark evidence exists; migration rollback is refused.' USING ERRCODE='55000';
  END IF;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['economics_benchmark_cohorts','economics_benchmark_cohort_members','economics_benchmark_observations','economics_benchmark_reports','economics_benchmark_quotes','economics_benchmark_quote_reviews'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON astra.%I',t||'_append_only',t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON astra.%I',t||'_no_truncate',t);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS astra.economics_benchmark_append_only();
DROP TRIGGER IF EXISTS economics_benchmark_member_binding ON astra.economics_benchmark_cohort_members;
DROP FUNCTION IF EXISTS astra.check_economics_benchmark_member();
DROP TABLE astra.economics_benchmark_quote_reviews;
DROP TABLE astra.economics_benchmark_quotes;
DROP TABLE astra.economics_benchmark_reports;
DROP TABLE astra.economics_benchmark_observations;
DROP TABLE astra.economics_benchmark_cohort_members;
DROP TABLE astra.economics_benchmark_cohorts;
RESET ROLE;
COMMIT;
