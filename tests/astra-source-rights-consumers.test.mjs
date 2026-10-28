import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAstraTenantStore } from '../pipeline/astra-tenant-store.js';
import { saveResearchSnapshot, getResearchBlob, getResearchEvidence } from '../pipeline/astra-evidence.js';
import { createResearchClaim, correctResearchClaim } from '../pipeline/astra-claims.js';
import { resolveCurrentResearchClaims } from '../pipeline/astra-current-claims.js';
import { auditResearchAccount, getResearchAudit, getResearchIdentityCandidates } from '../pipeline/astra-research.js';
import { createAstraRadarManager } from '../pipeline/astra-radar.js';
import { isCurrentAstraQualification } from '../pipeline/astra-campaign-audience.js';
import { readCurrentAstraCampaignAudience } from '../pipeline/astra-campaign-audience.js';
import { createAstraMailbox } from '../pipeline/astra-inbox.js';
import { createAstraMemoryItem, listAstraMemory, recallAstraMemory } from '../pipeline/astra-memory.js';
import { prepareAstraBenchmarkCohort, createAstraBenchmarkReport, getAstraBenchmark } from '../pipeline/astra-benchmark.js';
import { readAstraSourceRights, revokeAstraSourceRights } from '../pipeline/astra-source-rights.js';
import { validateAstraR20Fixture } from './support/astra-r20-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qaRoot = path.join(root, '.runner', 'astra-qa');
const fixtureInput = process.env.ASTRA_QA_FIXTURE_PATH;
const fixturePath = fixtureInput ? path.resolve(fixtureInput) : null;
const html = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

test('R20 source revocation blocks current claims, X-Ray, and Radar while retaining immutable history', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to .runner/astra-qa/r20-source-rights/pg.json for the guarded synthetic 33-migration fixture.',
}, async () => {
  const [canonicalQaRoot, canonicalFixture] = await Promise.all([realpath(qaRoot), realpath(fixturePath)]);
  const relative = path.relative(canonicalQaRoot, canonicalFixture);
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(relative.split(path.sep).join('/'), 'r20-source-rights/pg.json');
  const fixture = await validateAstraR20Fixture({ root, fixturePath: canonicalFixture });
  const store = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
  const userId = String(Math.floor(Math.random() * 8_000_000_000_000) + 1);
  const tenant = await store.createTenant({ name: `R20 consumer ${randomUUID().slice(0, 8)}`, userId });
  const actor = { tenantId: tenant.tenantId, userId, tenantRole: 'owner' };
  const expiry = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const now = () => new Date();
  const radar = await store.withTenant({ tenantId: actor.tenantId, userId }, async db => {
    const claimSource = await saveResearchSnapshot(db, actor, { sourceUrl: 'https://r20-claim.example.test/about', rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true,
      html: html('Claim source', 'Manufacturing industry. United States country.') });
    const correctionSource = await saveResearchSnapshot(db, actor, { sourceUrl: 'https://r20-claim.example.test/correction', rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true,
      html: html('Corrected claim source', 'Aerospace industry.') });
    const qualificationSource = await saveResearchSnapshot(db, actor, { sourceUrl: 'https://r20-claim.example.test/qualification', rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true,
      html: html('Qualification source', 'Aerospace industry. United States country.') });
    const emailSource = await saveResearchSnapshot(db, actor, { sourceUrl: 'https://r20-claim.example.test/contact-proof', rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true,
      html: html('Contact proof', 'Email contact@r20-claim.example.test for more information.') });
    const claim = await createResearchClaim(db, actor, { evidenceId: claimSource.evidence.id, contentSha256: claimSource.evidence.contentSha256,
      subjectKey: 'r20-claim.example.test', predicate: 'industry', value: 'Manufacturing', exactExcerpt: 'Manufacturing industry', expiresAt: expiry });
    const correction = await correctResearchClaim(db, actor, claim.id, { correctionType: 'corrected', evidenceId: correctionSource.evidence.id,
      contentSha256: correctionSource.evidence.contentSha256, replacementValue: 'Aerospace', exactExcerpt: 'Aerospace industry', reason: 'Corrected by current evidence.' });
    const qualificationIndustry = await createResearchClaim(db, actor, { evidenceId: qualificationSource.evidence.id, contentSha256: qualificationSource.evidence.contentSha256,
      subjectKey: 'r20-claim.example.test', predicate: 'industry', value: 'Aerospace', exactExcerpt: 'Aerospace industry', expiresAt: expiry });
    const qualificationCountry = await createResearchClaim(db, actor, { evidenceId: qualificationSource.evidence.id, contentSha256: qualificationSource.evidence.contentSha256,
      subjectKey: 'r20-claim.example.test', predicate: 'country', value: 'United States', exactExcerpt: 'United States country', expiresAt: expiry });
    const qualificationClaims = await resolveCurrentResearchClaims(db, { tenantId: actor.tenantId,
      claimIds: [qualificationIndustry.id, qualificationCountry.id] });
    const candidate = (await getResearchIdentityCandidates(db, actor.tenantId, claimSource.account.id))[0];
    assert.ok(qualificationClaims.every(item=>item.valid), JSON.stringify(qualificationClaims.map(item=>({predicate:item.predicate,valid:item.valid,blockers:item.blockers}))));
    assert.ok(candidate, 'saved page created an exact contact candidate');
    assert.ok(candidate.exactExcerpt?.includes(candidate.displayValue), 'contact candidate excerpt retains the literal address');
    const qualification = { accountId: claimSource.account.id, candidateId: candidate.id, domain: 'r20-claim.example.test',
      email: candidate.displayValue, emailEvidenceId: candidate.evidenceId, emailSourceId: candidate.sourceId,
      claimRefs: qualificationClaims.map(item => ({claimId:item.claimId,subjectKey:item.subjectKey,predicate:item.predicate,value:item.value,evidenceId:item.proof.evidenceId,
        contentSha256:item.proof.contentSha256,sourceId:item.proof.sourceId,exactExcerpt:item.proof.exactExcerpt})) };
    assert.equal(await isCurrentAstraQualification(db,actor.tenantId,qualification), true, 'qualification uses current claim and exact contact-source proofs');
    const mailbox=await createAstraMailbox(db,actor,{displayName:'Synthetic R20 qualification mailbox'});
    const campaignId=randomUUID();
    const campaignAudienceRow={...qualification,status:'fit',reasons:[],candidateId:qualification.candidateId,accountId:qualification.accountId,
      claimRefs:qualification.claimRefs};
    await db.query(`INSERT INTO astra.campaigns(tenant_id,id,name,offer_version_id,offer_content,offer_content_hash,mailbox_id,purpose,geography,spend_limit_minor,currency,audience_snapshot,created_by)
      VALUES($1::uuid,$2::uuid,'Synthetic consumer test',1,'{}'::jsonb,$3,$4::uuid,'research','[]'::jsonb,0,'USD',$5::jsonb,$6)`,
    [actor.tenantId,campaignId,'a'.repeat(64),mailbox.id,JSON.stringify([campaignAudienceRow]),String(actor.userId)]);
    let currentAudience=await readCurrentAstraCampaignAudience(db,actor.tenantId,campaignId);
    assert.equal(currentAudience.rows[0].current,true,'saved campaign audience is current before contact-source revocation');
    const permissionId=randomUUID();
    await db.query(`INSERT INTO astra.permission_decisions(tenant_id,id,subject_type,subject_value,purpose,lawful_basis,geography,decision,source_proof,actor_id)
      VALUES($1::uuid,$2::uuid,'account',$3,'research','legitimate_interests','US','granted','{"evidence":"synthetic"}'::jsonb,$4)`,
    [actor.tenantId,permissionId,claimSource.account.id,String(actor.userId)]);
    const memoryInput={kind:'fact',subject:{type:'account',id:claimSource.account.id},purpose:'research',key:'contact-route',value:{summary:'contact route from captured source'},
      validFrom:new Date().toISOString(),confidence:'high',authority:'source',sensitivity:'internal',permissionSubjectType:'account',permissionSubjectValue:claimSource.account.id,
      sourceEvidenceId:emailSource.evidence.id,rightsPolicy:'synthetic_fixture',permissionDecisionId:permissionId,
      provenance:{source:'synthetic capture',confidence:'high',fieldAuthority:'source'}};
    await createAstraMemoryItem(db,actor,memoryInput);
    assert.equal((await recallAstraMemory(db,actor.tenantId,{subject:{type:'account',id:claimSource.account.id},purpose:'research',query:'contact route'})).status,'found');
    let current = await resolveCurrentResearchClaims(db, { tenantId: actor.tenantId, claimIds: [claim.id] });
    assert.equal(current[0].valid, true, 'corrected source is current before revocation');
    assert.equal(current[0].proof.sourceId, correctionSource.evidence.sourceId);

    const xraySource = await saveResearchSnapshot(db, actor, { sourceUrl: 'https://r20-claim.example.test/contact', rightsPolicy: 'synthetic_fixture', rightsAttested: true, robotsAllowed: true,
      html: html('Contact page', 'Contact xray@r20-claim.example.test.') });
    const benchmarkSource = await saveResearchSnapshot(db, actor, { sourceUrl: 'https://r20-benchmark.example.test/about', rightsPolicy: 'user_provided', rightsAttested: true, robotsAllowed: true,
      html: html('Benchmark source', 'Benchmark evidence for a synthetic account.') });
    const benchmarkCohort=await prepareAstraBenchmarkCohort(db,actor,{targetAccounts:500,evidenceAgeDays:90});
    assert.equal(benchmarkCohort.manifest.members.length,1,'benchmark cohort includes the current permitted source');
    const firstAudit = await auditResearchAccount(db, actor, claimSource.account.id);
    assert.ok(firstAudit.pageCoverage.some(page => page.sourceId === xraySource.evidence.sourceId && page.status === 'usable'));
    const originalBlob = await getResearchBlob(db, actor.tenantId, xraySource.evidence.id);
    const watch = await createAstraRadarManager(db, { now }).createWatch(actor, { sourceId: xraySource.evidence.sourceId, cadenceMinutes: 60,
      minCadenceMinutes: 60, maxCadenceMinutes: 120, maxObservationsPerDay: 2 });
    const radarSource=await saveResearchSnapshot(db,actor,{sourceUrl:'https://r20-radar.example.test/about',rightsPolicy:'synthetic_fixture',rightsAttested:true,robotsAllowed:true,
      html:html('Watched page','Original watched snapshot.')});
    const radarRecapture=await saveResearchSnapshot(db,actor,{sourceUrl:'https://r20-radar.example.test/about',rightsPolicy:'synthetic_fixture',rightsAttested:true,robotsAllowed:true,
      html:html('Recaptured page','A separately captured exact URL.')});
    const recaptureWatch=await createAstraRadarManager(db,{now}).createWatch(actor,{sourceId:radarSource.evidence.sourceId,cadenceMinutes:60,
      minCadenceMinutes:60,maxCadenceMinutes:120,maxObservationsPerDay:2});
    assert.notEqual(radarSource.evidence.sourceId,radarRecapture.evidence.sourceId);
    await db.query(`INSERT INTO astra.radar_signals(tenant_id,id,watch_id,source_id,evidence_id,content_sha256,semantic_sha256,event_id,signal_type,title,exact_excerpt,provenance,observed_at,expires_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,NULL,'semantic_change','Synthetic recapture signal','Recaptured exact URL',
        $8::jsonb,now(),now()+interval '1 day')`,[actor.tenantId,randomUUID(),recaptureWatch.id,radarSource.evidence.sourceId,radarRecapture.evidence.id,
      radarRecapture.evidence.contentSha256,'b'.repeat(64),JSON.stringify({sourceId:radarSource.evidence.sourceId,evidenceSourceId:radarRecapture.evidence.sourceId})]);
    await db.query(`INSERT INTO astra.radar_signals(tenant_id,id,watch_id,source_id,evidence_id,content_sha256,semantic_sha256,event_id,signal_type,title,exact_excerpt,provenance,observed_at,expires_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,NULL,'semantic_change','Legacy same-source signal','Original watched evidence',
        $8::jsonb,now(),now()+interval '1 day')`,[actor.tenantId,randomUUID(),recaptureWatch.id,radarSource.evidence.sourceId,radarSource.evidence.id,
      radarSource.evidence.contentSha256,'c'.repeat(64),JSON.stringify({sourceId:radarSource.evidence.sourceId})]);
    let recaptureSignals=await createAstraRadarManager(db,{now}).listSignals(actor);
    assert.ok(recaptureSignals.length>=2,'distinct recapture and legacy signals exist before source revocation');
    const currentRecaptureSignal=recaptureSignals.find(signal=>signal.watchId===recaptureWatch.id&&signal.evidenceId===radarRecapture.evidence.id);
    assert.ok(currentRecaptureSignal);
    assert.equal(currentRecaptureSignal.usable,true);
    const legacySameSourceSignal=recaptureSignals.find(signal=>signal.watchId===recaptureWatch.id&&signal.evidenceId===radarSource.evidence.id);
    assert.ok(legacySameSourceSignal);
    assert.equal(legacySameSourceSignal.evidenceSourceId,radarSource.evidence.sourceId,'legacy signal evidence source resolves through its tenant-bound FK');
    assert.equal(legacySameSourceSignal.evidenceSourceLineageMatches,true);
    assert.equal(legacySameSourceSignal.usable,true);

    await revokeAstraSourceRights(db, actor, claimSource.evidence.sourceId, { reason: 'Terms changed for original capture.', idempotencyKey: 'original-capture' });
    current = await resolveCurrentResearchClaims(db, { tenantId: actor.tenantId, claimIds: [claim.id] });
    assert.equal(current[0].valid, true, 'revoking superseded claim proof does not change its current corrected proof');
    assert.equal(current[0].proof.sourceRightsStatus, 'permitted');

    await revokeAstraSourceRights(db, actor, correctionSource.evidence.sourceId, { reason: 'Correction source rights withdrawn.', idempotencyKey: 'corrected-capture' });
    current = await resolveCurrentResearchClaims(db, { tenantId: actor.tenantId, claimIds: [claim.id] });
    assert.equal(current[0].valid, false);
    assert.ok(current[0].blockers.includes('effective_proof_rights_revoked'));
    assert.equal(current[0].proof.sourceRightsStatus, 'revoked');
    await assert.rejects(()=>createResearchClaim(db,actor,{evidenceId:claimSource.evidence.id,contentSha256:claimSource.evidence.contentSha256,
      subjectKey:'r20-claim.example.test',predicate:'industry_alt',value:'Manufacturing',exactExcerpt:'Manufacturing industry',expiresAt:expiry}),
    error=>error.code==='source_rights_revoked');
    await assert.rejects(()=>correctResearchClaim(db,actor,claim.id,{correctionType:'corrected',evidenceId:correctionSource.evidence.id,
      contentSha256:correctionSource.evidence.contentSha256,replacementValue:'Aerospace',exactExcerpt:'Aerospace industry',reason:'Attempt using revoked proof.'}),
    error=>error.code==='correction_proof_invalid');

    await revokeAstraSourceRights(db, actor, xraySource.evidence.sourceId, { reason: 'Contact source rights withdrawn.', idempotencyKey: 'contact-capture' });
    assert.equal(await isCurrentAstraQualification(db,actor.tenantId,qualification), true, 'unrelated X-Ray page revocation does not invalidate the qualified email proof');
    await revokeAstraSourceRights(db, actor, emailSource.evidence.sourceId, { reason: 'Contact source rights withdrawn.', idempotencyKey: 'email-capture' });
    assert.equal(await isCurrentAstraQualification(db,actor.tenantId,qualification), false, 'current audience qualification rejects revoked exact contact evidence');
    currentAudience=await readCurrentAstraCampaignAudience(db,actor.tenantId,campaignId);
    assert.equal(currentAudience.rows[0].current,false);
    assert.ok(currentAudience.rows[0].reasons.includes('contact_source_rights_revoked'));
    const recall=await recallAstraMemory(db,actor.tenantId,{subject:{type:'account',id:claimSource.account.id},purpose:'research',query:'contact route'});
    assert.equal(recall.status,'unknown');
    assert.equal(recall.reason,'source_rights_revoked');
    const memoryHistory=await listAstraMemory(db,actor.tenantId,{subject:{type:'account',id:claimSource.account.id},purpose:'research'});
    assert.equal(memoryHistory[0].sourceRightsStatus,'revoked','historical memory remains readable with current rights status');
    await assert.rejects(()=>createAstraMemoryItem(db,actor,{...memoryInput,key:'blocked-contact-route'}),/research source rights were revoked/i);
    await revokeAstraSourceRights(db,actor,benchmarkSource.evidence.sourceId,{reason:'Benchmark source rights withdrawn.',idempotencyKey:'benchmark-capture'});
    const benchmarkReport=await createAstraBenchmarkReport(db,actor,benchmarkCohort.id);
    assert.equal(benchmarkReport.samples.currentPermittedAccounts,0,'revoked benchmark member is excluded from current report eligibility');
    assert.equal(benchmarkReport.exclusions.historicalObservationsExcludedForRevokedOrStaleSources,0);
    const benchmarkHistory=await getAstraBenchmark(db,actor,benchmarkCohort.id);
    assert.equal(benchmarkHistory.cohort.currentlyPermittedAccounts,0);
    assert.equal(benchmarkHistory.cohort.revokedAccounts,1,'historical cohort remains readable with effective revocation status');
    await revokeAstraSourceRights(db,actor,radarRecapture.evidence.sourceId,{reason:'Recaptured Radar evidence rights withdrawn.',idempotencyKey:'radar-recapture'});
    recaptureSignals=await createAstraRadarManager(db,{now}).listSignals(actor);
    const historicalSignal=recaptureSignals.find(signal=>signal.id===currentRecaptureSignal.id);
    assert.ok(historicalSignal,'historical Radar signal remains readable after recapture rights revocation');
    assert.equal(historicalSignal.usable,false);
    assert.equal(historicalSignal.watchedSourceRightsStatus,'permitted','watched-source grant remains independent');
    assert.equal(historicalSignal.evidenceSourceRightsStatus,'revoked','signal rechecks its distinct evidence source');
    const stillPermittedLegacy=recaptureSignals.find(signal=>signal.id===legacySameSourceSignal.id);
    assert.ok(stillPermittedLegacy,'old signal for the still-permitted same source remains readable');
    assert.equal(stillPermittedLegacy.usable,true);
    const evidenceHistory = await getResearchEvidence(db, actor.tenantId, xraySource.evidence.id);
    const blobHistory = await getResearchBlob(db, actor.tenantId, xraySource.evidence.id);
    assert.equal(evidenceHistory.sourceRightsStatus, 'revoked');
    assert.equal(blobHistory.content.toString(), originalBlob.content.toString(), 'revocation leaves captured source bytes unchanged');
    assert.equal(blobHistory.sha256, originalBlob.sha256);
    const currentAudit = await auditResearchAccount(db, actor, claimSource.account.id);
    const revokedPage = currentAudit.pageCoverage.find(page => page.sourceId === xraySource.evidence.sourceId);
    assert.equal(revokedPage.status, 'rights_revoked');
    assert.equal(currentAudit.summary.revokedPages, 4, 'original, corrected, X-Ray, and contact proof captures are revoked for this account');
    const historicalAudit = await getResearchAudit(db, actor.tenantId, firstAudit.id);
    assert.ok(historicalAudit.sourceCoverage.pages.some(page => page.sourceId === xraySource.evidence.sourceId && page.sourceRightsStatus === 'revoked'));
    const run = await createAstraRadarManager(db, { now }).runOnce(actor, { watchId: watch.id });
    assert.equal(run.results[0].state, 'rights_revoked');
    const radarHistory = await createAstraRadarManager(db, { now }).listWatches(actor);
    const savedWatch=radarHistory.find(item => item.id === watch.id);
    assert.equal(savedWatch.sourceRightsStatus, 'revoked');
    assert.equal(savedWatch.status,'paused');
    assert.equal(savedWatch.lastObservationState,'never_observed','revocation does not write the expired observation alias');
    assert.equal(savedWatch.lastObservedAt,null,'revocation does not claim source content was observed');
    const watchEvents=await db.query('SELECT event_type,observation_state,provenance FROM astra.radar_watch_events WHERE tenant_id=$1 AND watch_id=$2 ORDER BY created_at,id',[actor.tenantId,watch.id]);
    assert.equal(watchEvents.rows.length,2);
    const blockedEvent=watchEvents.rows.find(row=>row.event_type==='policy_blocked');
    assert.ok(blockedEvent);
    assert.equal(blockedEvent.observation_state,null);
    assert.equal(blockedEvent.provenance.reason,'rights_revoked');
    assert.equal(blockedEvent.provenance.sourceId,xraySource.evidence.sourceId);
    assert.ok(blockedEvent.provenance.revocationEventId);
    const recapture=await saveResearchSnapshot(db,actor,{sourceUrl:'https://r20-claim.example.test/contact-proof',rightsPolicy:'synthetic_fixture',rightsAttested:true,robotsAllowed:true,
      html:html('Fresh contact proof','Email contact@r20-claim.example.test for current information.')});
    assert.notEqual(recapture.evidence.sourceId,emailSource.evidence.sourceId,'a new capture gets a distinct source identity');
    const effectiveRights=await readAstraSourceRights(db,actor.tenantId,[emailSource.evidence.sourceId,recapture.evidence.sourceId]);
    assert.equal(effectiveRights.get(emailSource.evidence.sourceId).status,'revoked','new capture does not restore old source rights');
    assert.equal(effectiveRights.get(recapture.evidence.sourceId).status,'permitted','new capture carries its own explicit attestation');
    return true;
  });
  assert.equal(radar, true);
  await store.close();
});
