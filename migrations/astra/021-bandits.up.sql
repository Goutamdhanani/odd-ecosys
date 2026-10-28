-- S30 bounded, offline-only delayed-reward evaluation. No traffic allocator is installed.
BEGIN;
SET ROLE astra_owner;

CREATE TABLE astra.bandit_arm_registry (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  experiment_id uuid NOT NULL,
  arm_id text NOT NULL CHECK(length(arm_id) BETWEEN 1 AND 80),
  variant jsonb NOT NULL CHECK(jsonb_typeof(variant)='object'),
  variant_sha256 char(64) NOT NULL CHECK(variant_sha256 ~ '^[a-f0-9]{64}$'),
  release_id uuid NOT NULL,
  release_manifest_sha256 char(64) NOT NULL CHECK(release_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  launch_release_id uuid NOT NULL,
  launch_manifest_sha256 char(64) NOT NULL CHECK(launch_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  registered_by text NOT NULL CHECK(registered_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,experiment_id,arm_id),
  FOREIGN KEY(tenant_id,experiment_id) REFERENCES astra.experiments(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,release_id) REFERENCES astra.release_artifacts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,launch_release_id) REFERENCES astra.launch_releases(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.bandit_evaluation_lanes (
  tenant_id uuid NOT NULL REFERENCES astra.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  experiment_id uuid NOT NULL,
  seed text NOT NULL CHECK(length(seed) BETWEEN 1 AND 120),
  plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
  plan_sha256 char(64) NOT NULL CHECK(plan_sha256 ~ '^[a-f0-9]{64}$'),
  max_exploration_fraction numeric(5,4) NOT NULL CHECK(max_exploration_fraction BETWEEN 0 AND 0.2),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,experiment_id),
  FOREIGN KEY(tenant_id,experiment_id) REFERENCES astra.experiments(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.bandit_lane_proposals (
  tenant_id uuid NOT NULL,
  lane_id uuid NOT NULL,
  experiment_id uuid NOT NULL,
  account_id uuid NOT NULL,
  arm_id text NOT NULL,
  propensity numeric(12,11) NOT NULL CHECK(propensity>0 AND propensity<=1),
  source_assignment_hash char(64) NOT NULL CHECK(source_assignment_hash ~ '^[a-f0-9]{64}$'),
  allocation_hash char(64) NOT NULL CHECK(allocation_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,lane_id,account_id),
  FOREIGN KEY(tenant_id,lane_id,experiment_id) REFERENCES astra.bandit_evaluation_lanes(tenant_id,id,experiment_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,account_id) REFERENCES astra.research_accounts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,experiment_id,arm_id) REFERENCES astra.bandit_arm_registry(tenant_id,experiment_id,arm_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,experiment_id,account_id) REFERENCES astra.experiment_assignments(tenant_id,experiment_id,account_id) ON DELETE RESTRICT
);

CREATE TABLE astra.bandit_observations (
  tenant_id uuid NOT NULL,
  lane_id uuid NOT NULL,
  experiment_id uuid NOT NULL,
  account_id uuid NOT NULL,
  arm_id text NOT NULL,
  propensity numeric(12,11) NOT NULL CHECK(propensity>0 AND propensity<=1),
  assignment_at timestamptz NOT NULL,
  exposure_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  exposed_at timestamptz NOT NULL,
  assignment_hash char(64) NOT NULL CHECK(assignment_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,lane_id,account_id),
  FOREIGN KEY(tenant_id,lane_id,experiment_id) REFERENCES astra.bandit_evaluation_lanes(tenant_id,id,experiment_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,experiment_id,account_id) REFERENCES astra.experiment_assignments(tenant_id,experiment_id,account_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,experiment_id,arm_id) REFERENCES astra.bandit_arm_registry(tenant_id,experiment_id,arm_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,exposure_id) REFERENCES astra.experiment_exposures(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,source_event_id) REFERENCES astra.events(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE astra.bandit_reward_reviews (
  tenant_id uuid NOT NULL,
  lane_id uuid NOT NULL,
  account_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  status text NOT NULL CHECK(status IN ('pending','matured_observed','censored_unknown')),
  reward numeric,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  snapshot_sha256 char(64) NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_by text NOT NULL CHECK(reviewed_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,lane_id,account_id,snapshot_sha256),
  FOREIGN KEY(tenant_id,lane_id,account_id) REFERENCES astra.bandit_observations(tenant_id,lane_id,account_id) ON DELETE RESTRICT,
  CHECK((status='matured_observed')=(reward IS NOT NULL))
);

CREATE TABLE astra.bandit_evaluation_reports (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  lane_id uuid NOT NULL,
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object'),
  report_sha256 char(64) NOT NULL CHECK(report_sha256 ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK(created_by ~ '^[1-9][0-9]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,lane_id) REFERENCES astra.bandit_evaluation_lanes(tenant_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION astra.guard_bandit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Bandit evidence is append only.' USING ERRCODE='55000'; END $$;
CREATE FUNCTION astra.guard_bandit_arm_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c_id uuid; c_hash char(64); r_status text; r_hash char(64); r_roles integer; r_people integer;
        l_id uuid; l_status text; l_hash char(64); l_roles integer; l_people integer;
BEGIN
  SELECT r.candidate_id,c.manifest_sha256,r.status,r.manifest_sha256 INTO c_id,c_hash,r_status,r_hash
    FROM astra.release_artifacts r JOIN astra.eval_candidates c ON(c.tenant_id,c.id)=(r.tenant_id,r.candidate_id)
    WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.release_id;
  IF NOT FOUND OR r_status<>'approved_not_deployed'
    OR NOT (NEW.variant->>'candidateId'=c_id::text OR NEW.variant->>'candidateManifestSha256'=trim(c_hash))
  THEN RAISE EXCEPTION 'Bandit arm is not bound to its frozen approved release candidate.' USING ERRCODE='23514'; END IF;
  SELECT count(DISTINCT approval_role),count(DISTINCT approved_by) INTO r_roles,r_people
    FROM astra.release_approvals WHERE tenant_id=NEW.tenant_id AND release_id=NEW.release_id
      AND decision='approve' AND manifest_sha256=r_hash;
  IF r_roles<>2 OR r_people<>2 THEN RAISE EXCEPTION 'Bandit arm release lacks independent evaluation signoffs.' USING ERRCODE='23514'; END IF;
  SELECT l.id,l.status,l.manifest_sha256 INTO l_id,l_status,l_hash FROM astra.launch_releases l
    WHERE l.tenant_id=NEW.tenant_id AND l.id=NEW.launch_release_id AND l.source_release_id=NEW.release_id;
  IF NOT FOUND OR l_status<>'approved_not_deployed' OR l.manifest_sha256<>NEW.launch_manifest_sha256
    OR l.manifest #>> '{sourceRelease,manifestSha256}'<>trim(r_hash)
    OR jsonb_array_length(COALESCE(l.manifest->'blockingEvidence','[]'::jsonb))<>0
  THEN RAISE EXCEPTION 'Bandit arm lacks exact current-policy launch evidence.' USING ERRCODE='23514'; END IF;
  SELECT count(DISTINCT approval_role),count(DISTINCT approved_by) INTO l_roles,l_people
    FROM astra.launch_release_signoffs WHERE tenant_id=NEW.tenant_id AND release_id=l_id
      AND decision='approve' AND manifest_sha256=l_hash;
  IF l_roles<>2 OR l_people<>2 THEN RAISE EXCEPTION 'Bandit arm launch evidence lacks independent signoffs.' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM astra.operational_kill_switches k WHERE k.tenant_id=NEW.tenant_id AND k.enabled=true)
  THEN RAISE EXCEPTION 'Current operational policy excludes bandit arms while any kill switch is enabled.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION astra.guard_bandit_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_hash char(64); actual_arm text; declared_probability numeric; actual_probability numeric;
BEGIN
  SELECT assignment_hash,arm_id,propensity INTO actual_hash,actual_arm,actual_probability
    FROM astra.experiment_assignments WHERE tenant_id=NEW.tenant_id AND experiment_id=NEW.experiment_id AND account_id=NEW.account_id;
  IF NOT FOUND OR actual_hash<>NEW.source_assignment_hash THEN RAISE EXCEPTION 'Bandit proposal cohort assignment hash does not match S24 evidence.' USING ERRCODE='23514'; END IF;
  SELECT (l.plan->'probabilities'->>NEW.arm_id)::numeric INTO declared_probability
    FROM astra.bandit_evaluation_lanes l WHERE l.tenant_id=NEW.tenant_id AND l.id=NEW.lane_id AND l.experiment_id=NEW.experiment_id;
  IF NOT FOUND OR declared_probability IS NULL OR declared_probability<>NEW.propensity
    OR NEW.propensity<=0 OR NEW.propensity>1
  THEN RAISE EXCEPTION 'Bandit proposal propensity must match the frozen lane plan.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION astra.guard_bandit_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_arm text; actual_p numeric; actual_time timestamptz; actual_hash char(64);
        exposure_event uuid; exposure_time timestamptz; exposure_status text;
BEGIN
  SELECT arm_id,propensity,assigned_at,assignment_hash INTO actual_arm,actual_p,actual_time,actual_hash
    FROM astra.experiment_assignments WHERE tenant_id=NEW.tenant_id AND experiment_id=NEW.experiment_id AND account_id=NEW.account_id;
  SELECT source_event_id,occurred_at,verification_status INTO exposure_event,exposure_time,exposure_status
    FROM astra.experiment_exposures WHERE tenant_id=NEW.tenant_id AND id=NEW.exposure_id
      AND experiment_id=NEW.experiment_id AND account_id=NEW.account_id;
  IF NOT FOUND OR exposure_status<>'verified' OR exposure_event<>NEW.source_event_id OR exposure_time<>NEW.exposed_at
    OR actual_arm<>NEW.arm_id OR actual_p<>NEW.propensity OR actual_time<>NEW.assignment_at OR actual_hash<>NEW.assignment_hash
  THEN RAISE EXCEPTION 'Bandit observation must match immutable S24 assignment and verified exposure evidence.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bandit_arm_registry_guard BEFORE UPDATE OR DELETE ON astra.bandit_arm_registry FOR EACH ROW EXECUTE FUNCTION astra.guard_bandit_append_only();
CREATE TRIGGER bandit_lane_guard BEFORE UPDATE OR DELETE ON astra.bandit_evaluation_lanes FOR EACH ROW EXECUTE FUNCTION astra.guard_bandit_append_only();
CREATE TRIGGER bandit_proposal_guard BEFORE UPDATE OR DELETE ON astra.bandit_lane_proposals FOR EACH ROW EXECUTE FUNCTION astra.guard_bandit_append_only();
CREATE TRIGGER bandit_observation_guard BEFORE UPDATE OR DELETE ON astra.bandit_observations FOR EACH ROW EXECUTE FUNCTION astra.guard_bandit_append_only();
CREATE TRIGGER bandit_reward_review_guard BEFORE UPDATE OR DELETE ON astra.bandit_reward_reviews FOR EACH ROW EXECUTE FUNCTION astra.guard_bandit_append_only();
CREATE TRIGGER bandit_report_guard BEFORE UPDATE OR DELETE ON astra.bandit_evaluation_reports FOR EACH ROW EXECUTE FUNCTION astra.guard_bandit_append_only();
CREATE TRIGGER bandit_arm_evidence_guard BEFORE INSERT ON astra.bandit_arm_registry FOR EACH ROW EXECUTE FUNCTION astra.guard_bandit_arm_evidence();
CREATE TRIGGER bandit_proposal_evidence_guard BEFORE INSERT ON astra.bandit_lane_proposals FOR EACH ROW EXECUTE FUNCTION astra.guard_bandit_proposal();
CREATE TRIGGER bandit_observation_evidence_guard BEFORE INSERT ON astra.bandit_observations FOR EACH ROW EXECUTE FUNCTION astra.guard_bandit_observation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['bandit_arm_registry','bandit_evaluation_lanes','bandit_lane_proposals','bandit_observations','bandit_reward_reviews','bandit_evaluation_reports'] LOOP
    EXECUTE format('ALTER TABLE astra.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE astra.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON astra.%I FOR ALL TO astra_app,astra_worker USING (astra.context_allows(tenant_id)) WITH CHECK (astra.context_allows(tenant_id))',t||'_tenant_scope',t);
    EXECUTE format('GRANT SELECT,INSERT ON astra.%I TO astra_app,astra_worker',t);
    EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON astra.%I FROM PUBLIC,astra_app,astra_worker',t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION astra.guard_bandit_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_bandit_arm_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_bandit_proposal() FROM PUBLIC;
REVOKE ALL ON FUNCTION astra.guard_bandit_observation() FROM PUBLIC;
COMMIT;
