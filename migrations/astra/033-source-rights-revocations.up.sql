-- R20: durable tenant/source-scoped rights revocations. This is additive;
-- captured source rows and all historical evidence stay byte-for-byte intact.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.research_source_rights_revocations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT public.gen_random_uuid(),
  source_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  revoked_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_id, idempotency_key),
  FOREIGN KEY (tenant_id, source_id) REFERENCES astra.research_sources(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX research_source_rights_revocations_latest
  ON astra.research_source_rights_revocations(tenant_id, source_id, revoked_at DESC, id DESC);

ALTER TABLE astra.research_source_rights_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE astra.research_source_rights_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY research_source_rights_revocations_owner_all
  ON astra.research_source_rights_revocations FOR ALL TO astra_owner
  USING (true) WITH CHECK (true);
CREATE POLICY research_source_rights_revocations_tenant_scope
  ON astra.research_source_rights_revocations FOR ALL TO astra_app, astra_worker
  USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id));

CREATE FUNCTION astra.guard_source_rights_revocation_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Source-rights revocations are append-only.' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER research_source_rights_revocations_append_only
  BEFORE UPDATE OR DELETE ON astra.research_source_rights_revocations
  FOR EACH ROW EXECUTE FUNCTION astra.guard_source_rights_revocation_append_only();

REVOKE ALL ON astra.research_source_rights_revocations FROM PUBLIC, astra_app, astra_worker;
GRANT SELECT, INSERT ON astra.research_source_rights_revocations TO astra_app;
GRANT SELECT ON astra.research_source_rights_revocations TO astra_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON astra.research_source_rights_revocations FROM PUBLIC, astra_app, astra_worker;
REVOKE ALL ON FUNCTION astra.guard_source_rights_revocation_append_only() FROM PUBLIC;

RESET ROLE;
COMMIT;
