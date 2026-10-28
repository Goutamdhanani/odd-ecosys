import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { validateAstraR20Fixture } from './support/astra-r20-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixtureInput = process.env.ASTRA_QA_FIXTURE_PATH;
const fixturePath = fixtureInput ? path.resolve(fixtureInput) : null;

const H64 = /^[a-f0-9]{64}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const COMPONENTS = Object.freeze({
  harness: 'astra-offline-deterministic/1.0.0',
  decision: 'astra-decision/2',
  metric: 'astra-eval-report/1.0.0',
});

function launchManifest({ campaignId, skill, priorStableReleaseId = null }) {
  return {
    schemaVersion: 'astra-launch-release/1.0.0', campaignId,
    components: { ...COMPONENTS, skill },
    blockingEvidence: [],
    priorStablePointer: priorStableReleaseId ? { id: priorStableReleaseId } : null,
    rollout: { mode: 'shadow_or_canary_preparation_only', livePilotAllowed: false, automaticPromotion: false },
    releaseReady: false,
  };
}

/**
 * Seed the minimal synthetic launch chain for one campaign in the disposable
 * fixture: campaigns -> campaign_authorizations -> execution_tickets and
 * eval_runs -> skills -> release_artifacts -> launch_releases -> pointer.
 * All rows are run-owned synthetic fixtures; nothing leaves the cluster.
 */
async function seedLaunchChain(db, { tenantId, userId, reviewerId, campaignId, skillRefs, brand, skipSkill = false }) {
  const owner = String(userId);
  const reviewer = String(reviewerId);
  const authId = randomUUID();
  const mailboxId = randomUUID();
  await db.query(`INSERT INTO astra.mailboxes(tenant_id,id,display_name,provider,configuration_status,capability_evidence,actor_id)
    VALUES($1::uuid,$2::uuid,'synthetic mailbox','manual','unknown','{}'::jsonb,$3)`,
  [tenantId, mailboxId, owner]);
  await db.query(`INSERT INTO astra.campaigns(tenant_id,id,name,offer_version_id,offer_content,offer_content_hash,mailbox_id,purpose,geography,spend_limit_minor,currency,created_by)
    VALUES($1::uuid,$2::uuid,$3,1,'{}'::jsonb,$4,$5::uuid,'synthetic_outreach','[]'::jsonb,0,'USD',$6)`,
  [tenantId, campaignId, `${brand} campaign`, sha256('offer'), mailboxId, owner]);
  await db.query(`INSERT INTO astra.campaign_authorizations(tenant_id,id,campaign_id,version,envelope,envelope_hash,mode,expires_at,created_by)
    VALUES($1::uuid,$2::uuid,$3::uuid,1,'{}'::jsonb,$4,'routine_auto',now()+interval '1 day',$5)`,
  [tenantId, authId, campaignId, sha256('envelope'), owner]);

  const evalRunId = randomUUID();
  const datasetId = randomUUID();
  const scorerId = randomUUID();
  const candidateId = randomUUID();
  const decisionId = randomUUID();
  await db.query(`INSERT INTO astra.decisions(tenant_id,id,idempotency_key,action,policy_status,target,horizon,conditioning,source_refs,support,uncertainty,prediction,utility,risk,reversibility,basis,legacy_action,decision_hash,record,created_by)
    VALUES($1::uuid,$2::uuid,$3,'ACT','allowed',NULL,NULL,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,NULL,NULL,NULL,NULL,'unknown','synthetic',NULL,$4,'{"synthetic":true}'::jsonb,$5)`,
  [tenantId, decisionId, `decision-${randomUUID()}`, sha256('decision'), owner]);
  await db.query(`INSERT INTO astra.eval_datasets(tenant_id,id,name,source_manifest,source_manifest_sha256,label_rights,label_schema,split_policy,manifest,manifest_sha256,created_by)
    VALUES($1::uuid,$2::uuid,$3,'[]'::jsonb,$4,'{"attested":true,"basis":"synthetic_fixture"}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$6)`,
  [tenantId, datasetId, `synthetic dataset ${brand}`, sha256(`ds-source-${brand}`), sha256(`ds-manifest-${brand}`), owner]);
  await db.query(`INSERT INTO astra.eval_scorers(tenant_id,id,name,version,class_labels,critical_harm_labels,manifest,manifest_sha256,created_by)
    VALUES($1::uuid,$2::uuid,$3,'1.0.0','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,$4,$5)`,
  [tenantId, scorerId, `synthetic scorer ${brand}`, sha256(`scorer-${brand}`), owner]);
  await db.query(`INSERT INTO astra.eval_candidates(tenant_id,id,name,version,variant_id,strategy,config,allowed_labels,manifest,manifest_sha256,created_by)
    VALUES($1::uuid,$2::uuid,$3,'1.0.0','H0','keyword_rules','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$4,$5)`,
  [tenantId, candidateId, `synthetic candidate ${brand}`, sha256(`candidate-${brand}`), owner]);
  await db.query(`INSERT INTO astra.eval_runs(tenant_id,id,dataset_id,scorer_id,candidate_refs,budget,snapshot,snapshot_sha256,state,requested_by,report,report_sha256,completed_at)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,'completed',$6,'{}'::jsonb,$7,now())`,
  [tenantId, evalRunId, datasetId, scorerId, sha256('snapshot'), owner, sha256('report')]);
  const skill = skillRefs;
  if (!skipSkill) {
    await db.query(`INSERT INTO astra.skills(tenant_id,id,name,version,body,scope,license,provenance,provenance_sha256,test_manifest,evaluation_run_id,manifest_sha256,status,created_by)
      VALUES($1::uuid,$2::uuid,$3,'1.0.0','synthetic body','{}'::jsonb,'synthetic','{}'::jsonb,$4,'{"tests":[]}'::jsonb,$5::uuid,$6,'approved',$7)`,
    [tenantId, skill.id, `synthetic skill ${brand}`, sha256('provenance'), evalRunId, skill.manifestSha256, owner]);
  }

  async function artifact(id, version) {
    await db.query(`INSERT INTO astra.release_artifacts(tenant_id,id,name,version,candidate_id,evaluation_run_id,manifest,manifest_sha256,created_by,status)
      VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,'{}'::jsonb,$7,$8,'approved_not_deployed')`,
    [tenantId, id, `${brand} artifact ${version}`, version, candidateId, evalRunId, sha256(`artifact-${version}`), owner]);
    return id;
  }

  async function release(id, version, manifest, priorStableId = null, existingArtifactId = null) {
    const manifestSha256 = sha256(JSON.stringify(manifest));
    const sourceId = existingArtifactId || await artifact(randomUUID(), version);
    await db.query(`INSERT INTO astra.launch_releases(tenant_id,id,name,version,source_release_id,manifest,manifest_sha256,prior_stable_release_id,status,created_by)
      VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::jsonb,$7,$8::uuid,$9,$10)`,
    [tenantId, id, `${brand} release ${version}`, version, sourceId, JSON.stringify(manifest), manifestSha256,
      priorStableId || null, 'approved_not_deployed', owner]);
    if (priorStableId === null) {
      // The release gets independent launch and source signoffs.
      for (const [role, approver] of [['owner', owner], ['reviewer', reviewer]]) {
        await db.query(`INSERT INTO astra.launch_release_signoffs(tenant_id,release_id,approval_role,decision,reason_code,manifest_sha256,approved_by)
          VALUES($1::uuid,$2::uuid,$3,'approve','synthetic_signoff',$4,$5)`,
        [tenantId, id, role, manifestSha256, approver]);
        await db.query(`INSERT INTO astra.release_approvals(tenant_id,release_id,approval_role,decision,reason_code,manifest_sha256,approved_by)
          VALUES($1::uuid,$2::uuid,$3,'approve','synthetic_signoff',$4,$5)`,
        [tenantId, sourceId, role, sha256(`artifact-${version}`), approver]);
      }
    }
    return { releaseId: id, manifestSha256 };
  }

  const firstManifest = launchManifest({ campaignId, skill, priorStableReleaseId: null });
  const first = await release(randomUUID(), '1.0.0', firstManifest);

  async function extraCampaign(campaign) {
    await db.query(`INSERT INTO astra.campaigns(tenant_id,id,name,offer_version_id,offer_content,offer_content_hash,mailbox_id,purpose,geography,spend_limit_minor,currency,created_by)
      VALUES($1::uuid,$2::uuid,$3,1,'{}'::jsonb,$4,$5::uuid,'synthetic_outreach','[]'::jsonb,0,'USD',$6)`,
    [tenantId, campaign, `${brand} extra campaign`, sha256(`offer-${campaign}`), mailboxId, owner]);
    return campaign;
  }

  async function ticket(campaign, state) {
    const id = randomUUID();
    const recipientId = randomUUID();
    const domain = `recipient-${id}.synthetic.example.test`;
    const sourceId = randomUUID();
    const evidenceId = randomUUID();
    const accountId = randomUUID();
    const evidenceBytes = Buffer.from(`synthetic evidence ${id}`);
    const evidenceHash = createHash('sha256').update(evidenceBytes).digest('hex');
    await db.query(`INSERT INTO astra.research_sources(tenant_id,id,source_url,normalized_domain,rights_policy,rights_expires_at,robots_allowed,rights_attested,created_by)
      VALUES($1::uuid,$2::uuid,$3,$4,'synthetic_fixture',NULL,true,true,$5)`,
    [tenantId, sourceId, `https://${domain}/`, domain, owner]);
    await db.query(`INSERT INTO astra.research_blobs(tenant_id,sha256,content,byte_length,media_type) VALUES($1::uuid,$2,$3,$4,'text/html; charset=utf-8')`,
    [tenantId, evidenceHash, evidenceBytes, evidenceBytes.length]);
    await db.query(`INSERT INTO astra.research_evidence(tenant_id,id,source_id,normalized_domain,content_sha256,captured_at,extractor_version,extracted_text,coverage_status,source_content_untrusted)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,now(),'launch-revocation-test/1.0.0','synthetic evidence','single_page_snapshot',true)`,
    [tenantId, evidenceId, sourceId, domain, evidenceHash]);
    await db.query(`INSERT INTO astra.research_accounts(tenant_id,id,normalized_domain,display_domain)
      VALUES($1::uuid,$2::uuid,$3,$3)`,
    [tenantId, accountId, domain]);
    await db.query(`INSERT INTO astra.research_identity_candidates(tenant_id,id,account_id,evidence_id,normalized_domain,candidate_type,normalized_value,display_value,exact_excerpt,verification_state)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'email',$6,$6,$7,'unverified')`,
    [tenantId, recipientId, accountId, evidenceId, domain, `recipient-${id}@synthetic.example.test`, 'synthetic recipient']);
    await db.query(`INSERT INTO astra.execution_tickets(tenant_id,id,campaign_id,recipient_id,action,intent_hash,intent,recipient_hash,campaign_version,authorization_id,authorization_version,envelope_hash,decision_id,reason,expires_at,ticket_hash,signature,state,completed_at,created_by)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'email.send',$5,'{}'::jsonb,$6,1,$7::uuid,1,$8,$9::uuid,'synthetic ticket',now()+interval '5 minutes',$10,$11,$12,${['succeeded','uncertain','failed'].includes(state) ? 'now()' : 'NULL'},$13)`,
    [tenantId, id, campaign, recipientId, sha256(`intent-${id}`), sha256(`recipient-${id}`), authId, sha256('envelope'),
      decisionId, sha256(`ticket-${id}`), sha256(`signature-${id}`), state, owner]);
    return id;
  }

  return { authId, evalRunId, skill, first, release, ticket, extraCampaign };
}

test('X14 emergency stop: revoked active release stops new intents and invalidates issued tickets', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to the approved .runner/astra-qa/r20-source-rights/pg.json fixture.',
}, async () => {
  const canonical = await realpath(fixturePath);
  const fixture = await validateAstraR20Fixture({ root, fixturePath: canonical });
  assert.equal(fixture.realData, false);

  const keep = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  let store;
  try {
    await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
    const [{ createAstraTenantStore }, { assertCampaignLaunchNotStopped }, launchControls] = await Promise.all([
      import('../pipeline/astra-tenant-store.js'),
      import('../pipeline/astra-autonomy.js'),
      import('../pipeline/astra-launch-controls.js'),
    ]);
    store = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
    const cis = 1_000_000_000 + randomBytes(4).readUInt32BE(0);
    const userId = String(cis);
    const reviewerId = String(cis + 1);
    const { tenantId } = await store.createTenant({ name: `Launch revocation ${randomUUID().slice(0, 8)}`, userId });
    await store.withTenant({ tenantId, userId }, async (db, actor) => {
      assert.equal(actor.tenantRole, 'owner');
      const skill = { id: randomUUID(), version: '1.0.0', manifestSha256: sha256('skill') };
      const campaignId = randomUUID();
      const chain = await seedLaunchChain(db, { tenantId, userId, reviewerId, campaignId, skillRefs: skill, brand: 'revoke' });

      // No pointer yet: the stop gate is inert.
      await assertCampaignLaunchNotStopped(db, tenantId, campaignId);

      // Approved pointer: intents still allowed.
      await db.query(`INSERT INTO astra.launch_active_pointers(tenant_id,release_id,campaign_id,manifest_sha256,changed_by)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5)`,
      [tenantId, chain.first.releaseId, campaignId, chain.first.manifestSha256, String(userId)]);
      await assertCampaignLaunchNotStopped(db, tenantId, campaignId);

      // Issued tickets under the pointer campaign plus one completed and one foreign-campaign ticket.
      const issuedA = await chain.ticket(campaignId, 'issued');
      const issuedB = await chain.ticket(campaignId, 'issued');
      const held = await chain.ticket(campaignId, 'succeeded');
      const foreignCampaignId = randomUUID();
      await chain.extraCampaign(foreignCampaignId);
      const foreign = await chain.ticket(foreignCampaignId, 'issued');

      const revoked = await launchControls.revokeAstraLaunchRelease(db, actor, chain.first.releaseId, { reasonCode: 'synthetic_revoke' });
      assert.equal(revoked.invalidatedTicketCount, 2, 'revocation invalidates exactly the two issued pointer-campaign tickets');
      assert.equal(revoked.live, false);

      // The stop gate now rejects new intents for this campaign.
      await assert.rejects(() => assertCampaignLaunchNotStopped(db, tenantId, campaignId), error => error.code === 'launch_release_revoked',
        'mint-time stop gate blocks a revoked active release');

      const states = await db.query(`SELECT id,state,revoked_at,revoke_reason FROM astra.execution_tickets
        WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`, [tenantId, [issuedA, issuedB, held, foreign]]);
      const byId = new Map(states.rows.map(row => [row.id, row]));
      assert.ok(byId.get(issuedA).revoked_at && byId.get(issuedA).revoke_reason.includes('launch_release_revoked'), 'issued ticket A is revoked');
      assert.ok(byId.get(issuedB).revoked_at, 'issued ticket B is revoked');
      assert.equal(byId.get(held).revoked_at, null, 'succeeded tickets are never revoked');
      assert.equal(byId.get(foreign).revoked_at, null, 'foreign-campaign tickets are untouched');
      });

  } finally {
    if (store) await store.close();
  }
});

test('X14 rollback safety: pointer activation invalidates issued tickets of the previous campaign', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to the approved .runner/astra-qa/r20-source-rights/pg.json fixture.',
}, async () => {
  const canonical = await realpath(fixturePath);
  const fixture = await validateAstraR20Fixture({ root, fixturePath: canonical });
  assert.equal(fixture.realData, false);

  const keep = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  let store;
  try {
    await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
    const [{ createAstraTenantStore }, launchControls] = await Promise.all([
      import('../pipeline/astra-tenant-store.js'),
      import('../pipeline/astra-launch-controls.js'),
    ]);
    store = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
    const cis = 2_000_000_000 + randomBytes(4).readUInt32BE(0);
    const userId = String(cis);
    const reviewerId = String(cis + 1);
    const { tenantId } = await store.createTenant({ name: `Launch rollback ${randomUUID().slice(0, 8)}`, userId });

    await store.withTenant({ tenantId, userId }, async (db, actor) => {
      const skill = { id: randomUUID(), version: '1.0.0', manifestSha256: sha256('skill-rollback') };
      const campaignId = randomUUID();
      const chain = await seedLaunchChain(db, { tenantId, userId, reviewerId, campaignId, skillRefs: skill, brand: 'rollback' });
      const currentCampaign = campaignId;
      const futureCampaignId = randomUUID();
      await seedLaunchChain(db, { tenantId, userId, reviewerId, campaignId: futureCampaignId, skillRefs: skill, brand: 'rollback-future', skipSkill: true });

      // Current pointer binds release R1 to the current campaign; second release R2 targets the future campaign.
      const r1Manifest = launchManifest({ campaignId: currentCampaign, skill, priorStableReleaseId: null });
      const r2Manifest = launchManifest({ campaignId: futureCampaignId, skill, priorStableReleaseId: null });
      const r1 = await chain.release(randomUUID(), '1.1.0', r1Manifest);
      const r2 = await chain.release(randomUUID(), '1.2.0', r2Manifest);
      await db.query(`INSERT INTO astra.launch_active_pointers(tenant_id,release_id,campaign_id,manifest_sha256,changed_by)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5)`,
      [tenantId, r1.releaseId, currentCampaign, r1.manifestSha256, String(userId)]);

      const staleA = await chain.ticket(currentCampaign, 'issued');
      const staleB = await chain.ticket(currentCampaign, 'issued');
      const kept = await chain.ticket(futureCampaignId, 'issued');

      // Pointer activation is a server-side X14/S01 authority; the test
      // explicitly enables it for this disposable synthetic run (single run,
      // no live dispatch follows).
      process.env.ASTRA_LAUNCH_ACTIVATION_AUTHORIZED = 'enabled';
      process.env.ASTRA_S01_COMMERCIAL_PRIVACY_AUTHORIZED = 'enabled';
      const moved = await launchControls.activateAstraLaunchPointerInternally(db, actor, { releaseId: r2.releaseId, campaignId: futureCampaignId });
      assert.equal(moved.invalidatedTicketCount, 2, 'pointing the tenant release at a new campaign invalidates the previous campaign issued tickets');
      assert.equal(moved.liveActions, false);

      const states = await db.query(`SELECT id,revoked_at FROM astra.execution_tickets WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
      [tenantId, [staleA, staleB, kept]]);
      const byId = new Map(states.rows.map(row => [row.id, row]));
      assert.ok(byId.get(staleA).revoked_at && byId.get(staleB).revoked_at, 'previous campaign tickets are invalidated');
      assert.equal(byId.get(kept).revoked_at, null, 'new campaign tickets survive the pointer move');
    });
  } finally {
    if (store) await store.close();
  }
});