-- Tenant-scoped permission, inbox, review-task and disabled CRM outbox foundation.
-- This is additive: it creates no tenant, imports no legacy rows and enables no transport.
SET ROLE astra_owner;

CREATE TABLE astra.permission_decisions (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('recipient','domain','account','channel')),
  subject_value text NOT NULL CHECK (length(subject_value) BETWEEN 1 AND 320),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 120),
  lawful_basis text NOT NULL CHECK (lawful_basis IN ('consent','contract','legal_obligation','vital_interests','public_task','legitimate_interests','unknown')),
  geography text NOT NULL CHECK (length(geography) BETWEEN 1 AND 80),
  decision text NOT NULL CHECK (decision IN ('granted','denied','withdrawn','expired')),
  consent_expires_at timestamptz,
  source_proof jsonb NOT NULL CHECK (jsonb_typeof(source_proof)='object'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX astra_permission_current ON astra.permission_decisions(tenant_id,subject_type,subject_value,purpose,created_at DESC);

CREATE TABLE astra.suppression_decisions (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('recipient','domain','account','channel','purpose')),
  scope_value text NOT NULL CHECK (length(scope_value) BETWEEN 1 AND 320),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX astra_suppression_lookup ON astra.suppression_decisions(tenant_id,scope,scope_value,created_at DESC);

CREATE TABLE astra.mailboxes (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  provider text NOT NULL CHECK (provider IN ('manual','unknown')),
  provider_mailbox_id text CHECK (provider_mailbox_id IS NULL OR length(provider_mailbox_id) BETWEEN 1 AND 500),
  configuration_status text NOT NULL CHECK (configuration_status IN ('configured','unknown')) DEFAULT 'unknown',
  capability_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capability_evidence)='object'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,provider,provider_mailbox_id)
);

CREATE TABLE astra.inbox_threads (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  mailbox_id uuid NOT NULL,
  external_thread_id text NOT NULL CHECK (length(external_thread_id) BETWEEN 1 AND 500),
  recipient text CHECK (recipient IS NULL OR length(recipient) <= 320),
  subject text CHECK (subject IS NULL OR length(subject) <= 998),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,mailbox_id,external_thread_id),
  FOREIGN KEY (tenant_id,mailbox_id) REFERENCES astra.mailboxes(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.inbox_messages (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  mailbox_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  in_reply_to_message_id uuid,
  external_message_id text NOT NULL CHECK (length(external_message_id) BETWEEN 1 AND 500),
  in_reply_to text CHECK (in_reply_to IS NULL OR length(in_reply_to) <= 500),
  sender text CHECK (sender IS NULL OR length(sender) <= 320),
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recipients)='array'),
  subject text CHECK (subject IS NULL OR length(subject) <= 998),
  body_text text NOT NULL CHECK (length(body_text) <= 100000),
  received_at timestamptz NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,mailbox_id,external_message_id),
  FOREIGN KEY (tenant_id,mailbox_id) REFERENCES astra.mailboxes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id) REFERENCES astra.inbox_threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,in_reply_to_message_id) REFERENCES astra.inbox_messages(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_inbox_messages_thread ON astra.inbox_messages(tenant_id,thread_id,received_at DESC);

CREATE TABLE astra.reply_tasks (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  message_id uuid NOT NULL,
  classification text NOT NULL CHECK (classification IN ('opt_out','hard_negative','positive','question','other','unknown')),
  classification_method text NOT NULL CHECK (classification_method IN ('deterministic_rule','operator_review','abstain')),
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal)='object'),
  status text NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review','approved','rejected')),
  actor_id text NOT NULL CHECK (actor_id ~ '^[1-9][0-9]{0,39}$'),
  reviewed_by text CHECK (reviewed_by IS NULL OR reviewed_by ~ '^[1-9][0-9]{0,39}$'),
  review_note text CHECK (review_note IS NULL OR length(review_note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,message_id),
  FOREIGN KEY (tenant_id,message_id) REFERENCES astra.inbox_messages(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX astra_reply_tasks_review ON astra.reply_tasks(tenant_id,status,created_at DESC);

CREATE TABLE astra.crm_settings (
  tenant_id uuid PRIMARY KEY REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'twenty' CHECK (provider='twenty'),
  commercial_approved boolean NOT NULL DEFAULT false,
  explicit_opt_in boolean NOT NULL DEFAULT false,
  transport_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE astra.crm_mappings (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  entity_type text NOT NULL CHECK (entity_type='company'),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 500),
  provider text NOT NULL DEFAULT 'twenty' CHECK (provider='twenty'),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 500),
  field_authority jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_authority)='object'),
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance)='object'),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,entity_type,entity_id,provider),
  UNIQUE (tenant_id,provider,external_id)
);

CREATE TABLE astra.crm_outbox (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type='company'),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 500),
  provider text NOT NULL DEFAULT 'twenty' CHECK (provider='twenty'),
  operation text NOT NULL CHECK (operation IN ('create_company')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 250),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  field_authority jsonb NOT NULL CHECK (jsonb_typeof(field_authority)='object'),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance)='object'),
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held','queued','attempting','uncertain','succeeded','failed')),
  actor_id text NOT NULL CHECK (actor_id ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX astra_crm_outbox_ready ON astra.crm_outbox(tenant_id,state,created_at);

CREATE TABLE astra.crm_attempts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  outbox_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  state text NOT NULL CHECK (state IN ('started','uncertain','succeeded','failed')),
  diagnostic_code text CHECK (diagnostic_code IS NULL OR length(diagnostic_code) <= 120),
  external_id text CHECK (external_id IS NULL OR length(external_id) <= 500),
  created_by text NOT NULL CHECK (created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,outbox_id,attempt_number),
  FOREIGN KEY (tenant_id,outbox_id) REFERENCES astra.crm_outbox(tenant_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION astra.reject_inbox_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Astra decision and attempt history is append-only.' USING ERRCODE='55000';
END; $$;
CREATE FUNCTION astra.guard_inbox_state_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Astra inbox rows cannot be deleted.' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME IN ('inbox_messages','inbox_threads') THEN
    RAISE EXCEPTION 'Astra inbox message and thread content is immutable.' USING ERRCODE='55000';
  ELSIF TG_TABLE_NAME='reply_tasks' THEN
    IF (NEW.tenant_id,NEW.id,NEW.message_id,NEW.classification,NEW.classification_method,NEW.proposal,NEW.actor_id,NEW.created_at)
       IS DISTINCT FROM
       (OLD.tenant_id,OLD.id,OLD.message_id,OLD.classification,OLD.classification_method,OLD.proposal,OLD.actor_id,OLD.created_at)
       OR OLD.status <> 'needs_review' OR NEW.status NOT IN ('approved','rejected')
       OR NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN
      RAISE EXCEPTION 'Astra reply tasks only allow one audited review decision.' USING ERRCODE='55000';
    END IF;
  ELSIF TG_TABLE_NAME='crm_outbox' THEN
    IF (NEW.tenant_id,NEW.id,NEW.entity_type,NEW.entity_id,NEW.provider,NEW.operation,NEW.idempotency_key,NEW.payload,NEW.field_authority,NEW.provenance,NEW.actor_id,NEW.created_at)
       IS DISTINCT FROM
       (OLD.tenant_id,OLD.id,OLD.entity_type,OLD.entity_id,OLD.provider,OLD.operation,OLD.idempotency_key,OLD.payload,OLD.field_authority,OLD.provenance,OLD.actor_id,OLD.created_at)
       OR NOT ((OLD.state='held' AND NEW.state IN ('queued','failed'))
          OR (OLD.state='queued' AND NEW.state IN ('attempting','failed'))
          OR (OLD.state='attempting' AND NEW.state IN ('uncertain','succeeded','failed'))) THEN
      RAISE EXCEPTION 'Astra CRM proposals have immutable content and bounded state transitions.' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['permission_decisions','suppression_decisions','crm_attempts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON astra.%I FOR EACH ROW EXECUTE FUNCTION astra.reject_inbox_append_only_mutation()', 'astra_'||table_name||'_immutable', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON astra.%I FOR EACH STATEMENT EXECUTE FUNCTION astra.reject_inbox_append_only_mutation()', 'astra_'||table_name||'_no_truncate', table_name);
  END LOOP;
END $$;
CREATE TRIGGER astra_inbox_messages_immutable BEFORE UPDATE OR DELETE ON astra.inbox_messages
  FOR EACH ROW EXECUTE FUNCTION astra.guard_inbox_state_update();
CREATE TRIGGER astra_inbox_threads_immutable BEFORE UPDATE OR DELETE ON astra.inbox_threads
  FOR EACH ROW EXECUTE FUNCTION astra.guard_inbox_state_update();
CREATE TRIGGER astra_reply_tasks_review_guard BEFORE UPDATE OR DELETE ON astra.reply_tasks
  FOR EACH ROW EXECUTE FUNCTION astra.guard_inbox_state_update();
CREATE TRIGGER astra_crm_outbox_transition_guard BEFORE UPDATE OR DELETE ON astra.crm_outbox
  FOR EACH ROW EXECUTE FUNCTION astra.guard_inbox_state_update();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['permission_decisions','suppression_decisions','mailboxes','inbox_threads','inbox_messages','reply_tasks','crm_settings','crm_mappings','crm_outbox','crm_attempts'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_owner_all ON astra.%I FOR ALL TO astra_owner USING (true) WITH CHECK (true)', table_name);
    EXECUTE format('CREATE POLICY tenant_app_scope ON astra.%I FOR ALL TO astra_app, astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))', table_name);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE, TRUNCATE ON astra.permission_decisions, astra.suppression_decisions, astra.crm_attempts FROM PUBLIC, astra_app, astra_worker;
GRANT SELECT, INSERT ON astra.permission_decisions, astra.suppression_decisions, astra.crm_attempts TO astra_app, astra_worker;
GRANT SELECT, INSERT, UPDATE ON astra.mailboxes, astra.inbox_threads, astra.inbox_messages, astra.reply_tasks, astra.crm_settings, astra.crm_outbox TO astra_app, astra_worker;
GRANT SELECT, INSERT ON astra.crm_mappings TO astra_app, astra_worker;
REVOKE DELETE, TRUNCATE ON astra.mailboxes, astra.inbox_threads, astra.inbox_messages, astra.reply_tasks, astra.crm_settings, astra.crm_mappings, astra.crm_outbox FROM PUBLIC, astra_app, astra_worker;
REVOKE UPDATE ON astra.crm_mappings FROM PUBLIC, astra_app, astra_worker;

RESET ROLE;
