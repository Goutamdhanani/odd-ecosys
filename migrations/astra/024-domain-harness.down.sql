BEGIN;
SET ROLE astra_owner;
DROP TRIGGER IF EXISTS astra_domain_harness_binding_no_truncate ON astra.domain_harness_bindings;
DROP TRIGGER IF EXISTS astra_domain_harness_binding_guard ON astra.domain_harness_bindings;
DROP TABLE IF EXISTS astra.domain_harness_bindings;
DROP FUNCTION IF EXISTS astra.guard_domain_harness_binding();
RESET ROLE;
COMMIT;
