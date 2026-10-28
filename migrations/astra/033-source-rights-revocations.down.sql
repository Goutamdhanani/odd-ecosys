-- Roll back only migration 033's additive source-rights revocation objects.
BEGIN;
SET ROLE astra_owner;

DROP TRIGGER research_source_rights_revocations_append_only ON astra.research_source_rights_revocations;
DROP TABLE astra.research_source_rights_revocations;
DROP FUNCTION astra.guard_source_rights_revocation_append_only();

RESET ROLE;
COMMIT;
