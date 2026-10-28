import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateAstraR20Fixture } from './support/astra-r20-fixture.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixturePath=process.env.ASTRA_QA_FIXTURE_PATH||path.join(root,'.runner','astra-qa','r20-source-rights','pg.json');

test('campaign review is an authoritative read, exposes current snapshot and blocks an empty audience',async()=>{
  const fixture=await validateAstraR20Fixture({root,fixturePath});
  const keep=new Set(['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS','NODE_OPTIONS','ASTRA_QA_FIXTURE_PATH']);
  for(const key of Object.keys(process.env))if(!keep.has(key))delete process.env[key];
  const sqliteDir=mkdtempSync(path.join(tmpdir(),'astra-review-'));
  process.env.ODD_DB_PATH=path.join(sqliteDir,'offers.db');
  let store,legacyDb,closeLegacy;
  try{
    const [{createAstraTenantStore},{createAstraCampaign,getAstraCampaignReview},{createOffer,approveOfferVersion},{registerOfferProof,linkOfferProof}]=await Promise.all([
      import('../pipeline/astra-tenant-store.js'),import('../pipeline/astra-campaigns.js'),import('../pipeline/offer-contracts.js'),import('../pipeline/offer-proof-store.js'),
    ]);
    const sqlite=await import('../pipeline/database.js');
    legacyDb=sqlite.initDb();closeLegacy=sqlite.closeDb;
    store=createAstraTenantStore({connectionString:fixture.connectionString,contextSecret:fixture.contextSecret});
    const userId=String(1_000_000_000+randomBytes(4).readUInt32BE(0));
    const {tenantId}=await store.createTenant({name:`Review fixture ${randomUUID().slice(0,8)}`,userId});
    const actorId=Number(userId);
    const proofBytes=Buffer.from(`synthetic review offer proof ${randomUUID()}`);
    const proofHash=createHash('sha256').update(proofBytes).digest('hex');
    const offerContent={service:'SEO audit',scope:'One audit with a written findings report.',price:{minMinor:10000,maxMinor:90000,currency:'USD'},
      proofAssets:[{proofId:'review-proof',reference:'fixture://review/proof',contentHash:proofHash,observedAt:'2026-10-01T00:00:00.000Z',expiresAt:'2035-01-01T00:00:00.000Z',rightsBasis:'Synthetic fixture'}],
      audienceExclusions:['Existing customer'],geography:{includedCountries:['US'],excludedCountries:[]},capacity:10,egress:{mode:'NO_MODEL_EGRESS',allowedDestinations:[]}};
    const sqliteActor={id:actorId,role:'owner',tenantId};
    const offer=createOffer(legacyDb,{name:'Review test offer',content:offerContent},sqliteActor);
    const proof=registerOfferProof(legacyDb,sqliteActor,{bytes:proofBytes,mimeType:'text/plain',expiresAt:'2035-01-01T00:00:00.000Z',contentHash:proofHash});
    linkOfferProof(legacyDb,sqliteActor,{offerVersionId:offer.version.id,proofId:'review-proof',objectId:proof.id});
    approveOfferVersion(legacyDb,offer.id,offer.version.id,sqliteActor);
    const identity={tenantId,userId};
    let campaign;
    await store.withTenant(identity,async(db,actor)=>{
      const mailboxId=randomUUID();
      await db.query(`INSERT INTO astra.mailboxes(tenant_id,id,display_name,provider,actor_id) VALUES($1,$2,'Review test','manual',$3)`,[tenantId,mailboxId,userId]);
      campaign=await createAstraCampaign(db,actor,legacyDb,{name:'Review fixture campaign',offerVersionId:offer.version.id,mailboxId,
        purpose:'research note',geography:['US'],spendLimitMinor:90000,currency:'USD'});
    });
    const before=await store.withTenant(identity,db=>db.query(`SELECT (SELECT count(*)::int FROM astra.campaign_approvals WHERE tenant_id=$1 AND campaign_id=$2::uuid) AS approvals,
      (SELECT version FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid) AS version`,[tenantId,campaign.id]));
    const review=await store.withTenant(identity,(db,actor)=>getAstraCampaignReview(db,actor,legacyDb,campaign.id));
    assert.equal(review.campaignId,campaign.id);
    assert.equal(review.version,Number(campaign.version));
    assert.equal(review.copy.validation.eligible,false);
    assert.ok(review.copy.validation.reasons.includes('campaign_draft_required'));
    assert.equal(review.offer.current,true);
    assert.equal(review.offer.snapshot.service,'SEO audit');
    assert.equal(review.limits.purpose,'research note');
    assert.deepEqual(review.limits.geography,['US']);
    assert.equal(review.limits.scheduleAt,null);
    assert.equal(review.mailbox.configurationStatus,'unknown');
    assert.equal(review.audience.count,0);
    assert.equal(review.approval.ready,false);
    assert.ok(review.approval.blockers.includes('eligible_audience_empty'));
    assert.equal(review.delivery.ready,false);
    assert.equal(review.delivery.recipientChecks,'not_evaluated_in_review');
    assert.ok(review.delivery.blockers.includes('live_dispatch_disabled'));
    assert.ok(review.delivery.blockers.includes('recipient_permission_and_verification_not_evaluated'));
    assert.equal(await store.withTenant(identity,(db,actor)=>getAstraCampaignReview(db,{...actor,tenantId:randomUUID()},legacyDb,campaign.id)),null,
      'campaign reads are tenant scoped');
    const after=await store.withTenant(identity,db=>db.query(`SELECT (SELECT count(*)::int FROM astra.campaign_approvals WHERE tenant_id=$1 AND campaign_id=$2::uuid) AS approvals,
      (SELECT version FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid) AS version`,[tenantId,campaign.id]));
    assert.deepEqual(after.rows[0],before.rows[0],'review does not create approvals or change the campaign version');

    const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return{promise,release};};
    const reviewContext=gate(),writerContext=gate(),monitorContext=gate(),startReview=gate(),startWriter=gate(),startMonitor=gate(),
      reviewReadReached=gate(),resumeReview=gate(),writerQueryStarted=gate();
    let reviewPid,writerPid,paused=false,lastWriterStatus=null;
    const writerMarker=`astra-review-update-${randomUUID()}`;
    const reviewTask=store.withTenant(identity,async(db,actor)=>{
      await db.query('SELECT pg_backend_pid() AS pid').then(result=>{reviewPid=Number(result.rows[0].pid);});
      reviewContext.release();
      await startReview.promise;
      const reviewClient={query:async(sql,params)=>{
        const result=await db.query(sql,params);
        if(!paused&&/FROM astra\.campaigns/i.test(sql)){
          paused=true;
          reviewReadReached.release();
          await resumeReview.promise;
        }
        return result;
      }};
      return getAstraCampaignReview(reviewClient,actor,legacyDb,campaign.id);
    });
    const writerTask=store.withTenant(identity,async db=>{
      await db.query('SELECT pg_backend_pid() AS pid').then(result=>{writerPid=Number(result.rows[0].pid);});
      await db.query("SELECT set_config('application_name',$1,true)",[writerMarker]);
      writerContext.release();
      await startWriter.promise;
      writerQueryStarted.release();
      return db.query(`UPDATE astra.campaigns SET audience_snapshot=$3::jsonb,version=version+1
        WHERE tenant_id=$1 AND id=$2::uuid RETURNING version`,[tenantId,campaign.id,JSON.stringify([
        {accountId:randomUUID(),candidateId:null,email:null,domain:'concurrent.synthetic.example.test',status:'blocked',reasons:['fixture_concurrency_write']},
      ])]);
    });
    const monitorTask=store.withTenant(identity,async db=>{
      monitorContext.release();
      await startMonitor.promise;
      for(let attempt=0;attempt<30;attempt+=1){
        const status=await db.query(`SELECT application_name AS "applicationName",
          $2::int=ANY(pg_blocking_pids($1::int)) AS "blockedByReview"
          FROM pg_stat_activity WHERE pid=$1::int`,[writerPid,reviewPid]);
        const row=status.rows[0];
        lastWriterStatus=row||null;
        if(row?.blockedByReview)return row;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      return lastWriterStatus;
    });
    await Promise.all([reviewContext.promise,writerContext.promise,monitorContext.promise]);
    startReview.release();
    await reviewReadReached.promise;
    startWriter.release();
    await writerQueryStarted.promise;
    startMonitor.release();
    const observedBlock=await monitorTask;
    resumeReview.release();
    const consistentReview=await reviewTask;
    const writerResult=await writerTask;
    assert.equal(observedBlock?.applicationName,writerMarker,`monitor observes the review test's campaign audience update: ${JSON.stringify({reviewPid,writerPid,lastWriterStatus})}`);
    assert.equal(observedBlock?.blockedByReview,true,'pg_blocking_pids identifies the review transaction as the writer blocker');
    assert.equal(consistentReview.version,Number(campaign.version));
    assert.equal(consistentReview.copyVersion,Number(campaign.copyVersion||0));
    assert.equal(consistentReview.audience.count,0,'review audience comes from the same locked campaign snapshot as its version');
    const afterWriter=await store.withTenant(identity,db=>db.query(`SELECT version,audience_snapshot FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid`,[tenantId,campaign.id]));
    assert.equal(Number(afterWriter.rows[0].version),Number(campaign.version)+1);
    assert.equal(Number(writerResult.rows[0].version),Number(campaign.version)+1);
    assert.equal(afterWriter.rows[0].audience_snapshot.length,1,'concurrent audience write commits after review completion');
  }finally{
    if(store)await store.close();
    closeLegacy?.();
    rmSync(sqliteDir,{recursive:true,force:true});
  }
});
