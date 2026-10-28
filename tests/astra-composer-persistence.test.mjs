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

test('PostgreSQL persists unverified copy and CAS rejects stale/concurrent draft writes', async t=>{
  const fixture=await validateAstraR20Fixture({root,fixturePath});
  const keep=new Set(['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS','NODE_OPTIONS','ASTRA_QA_FIXTURE_PATH']);
  for(const key of Object.keys(process.env))if(!keep.has(key))delete process.env[key];
  const sqliteDir=mkdtempSync(path.join(tmpdir(),'astra-composer-'));
  process.env.ODD_DB_PATH=path.join(sqliteDir,'offers.db');
  let store,legacyDb,closeLegacy;
  try{
    const [{createAstraTenantStore},{createAstraCampaign,saveAstraCampaignDraft,getAstraCampaignComposer,approveAstraCampaign},{createOffer,approveOfferVersion},{registerOfferProof,linkOfferProof},{hasCurrentAstraCopyProof}]=await Promise.all([
      import('../pipeline/astra-tenant-store.js'),import('../pipeline/astra-campaigns.js'),import('../pipeline/offer-contracts.js'),import('../pipeline/offer-proof-store.js'),
      import('../pipeline/astra-autonomy.js'),
    ]);
    const sqlite=await import('../pipeline/database.js');
    legacyDb=sqlite.initDb();closeLegacy=sqlite.closeDb;
    store=createAstraTenantStore({connectionString:fixture.connectionString,contextSecret:fixture.contextSecret});
    const userId=String(1_000_000_000+randomBytes(4).readUInt32BE(0));
    const {tenantId}=await store.createTenant({name:`Composer CAS ${randomUUID().slice(0,8)}`,userId});
    const actorId=Number(userId);
    const proofBytes=Buffer.from(`synthetic composer offer proof ${randomUUID()}`);
    const proofHash=createHash('sha256').update(proofBytes).digest('hex');
    const offerContent={service:'SEO audit',scope:'One audit with a written findings report.',price:{minMinor:10000,maxMinor:90000,currency:'USD'},
      proofAssets:[{proofId:'composer-proof',reference:'fixture://composer/proof',contentHash:proofHash,observedAt:'2026-10-01T00:00:00.000Z',expiresAt:'2035-01-01T00:00:00.000Z',rightsBasis:'Synthetic fixture'}],
      audienceExclusions:['Existing customer'],geography:{includedCountries:['US'],excludedCountries:[]},capacity:10,egress:{mode:'NO_MODEL_EGRESS',allowedDestinations:[]}};
    const sqliteActor={id:actorId,role:'owner',tenantId};
    const offer=createOffer(legacyDb,{name:'Composer test offer',content:offerContent},sqliteActor);
    const proof=registerOfferProof(legacyDb,sqliteActor,{bytes:proofBytes,mimeType:'text/plain',expiresAt:'2035-01-01T00:00:00.000Z',contentHash:proofHash});
    linkOfferProof(legacyDb,sqliteActor,{offerVersionId:offer.version.id,proofId:'composer-proof',objectId:proof.id});
    approveOfferVersion(legacyDb,offer.id,offer.version.id,sqliteActor);
    const identity={tenantId,userId};
    let campaign;
    await store.withTenant(identity,async(db,actor)=>{
      const mailboxId=randomUUID();
      await db.query(`INSERT INTO astra.mailboxes(tenant_id,id,display_name,provider,actor_id) VALUES($1,$2,'Composer test','manual',$3)`,[tenantId,mailboxId,userId]);
      campaign=await createAstraCampaign(db,actor,legacyDb,{name:'Composer CAS fixture',offerVersionId:offer.version.id,mailboxId,
        purpose:'research note',geography:['US'],spendLimitMinor:90000,currency:'USD'});
    });
    const unsupported={expectedVersion:campaign.version,subject:'Research note',body:'Dental Clinic will double revenue.',claimsMap:[]};
    await assert.rejects(store.withTenant(identity,(db,actor)=>saveAstraCampaignDraft(db,actor,legacyDb,campaign.id,
      {...unsupported,validation:{status:'verified',eligible:true},status:'approved',templateId:'forged'})),error=>error.statusCode===400,
    'client proof/status/template fields are not accepted');
    let saved;
    await store.withTenant(identity,(db,actor)=>saveAstraCampaignDraft(db,actor,legacyDb,campaign.id,unsupported)).then(value=>{saved=value;});
    assert.equal(saved.version,Number(campaign.version)+1);
    assert.equal(saved.validation.status,'unverified');
    assert.equal(saved.validation.eligible,false);
    assert.ok(saved.validation.reasons.includes('copy_contains_unmapped_or_unsupported_text'));
    const loaded=await store.withTenant(identity,db=>getAstraCampaignComposer(db,tenantId,campaign.id));
    assert.equal(loaded.body,unsupported.body);
    assert.equal(loaded.validation.status,'unverified');
    assert.equal(await store.withTenant(identity,db=>hasCurrentAstraCopyProof(db,{tenantId,campaign:{...loaded,id:campaign.id,tenant_id:tenantId,
      offer_version_id:offer.version.id,offer_content_hash:offer.version.contentHash,claims_map:[{sentence:'Dental Clinic will double revenue.',claimIds:[randomUUID()]}]}})),false,
      'legacy literal substring mappings never authorize a campaign without persisted template provenance');
    const approvalsBefore=await store.withTenant(identity,db=>db.query('SELECT count(*)::int AS count FROM astra.campaign_approvals WHERE tenant_id=$1 AND campaign_id=$2::uuid',[tenantId,campaign.id]));
    await assert.rejects(store.withTenant(identity,(db,actor)=>approveAstraCampaign(db,actor,legacyDb,campaign.id,{expectedVersion:saved.version,expiresAt:'2030-01-01T00:00:00.000Z'})),
      error=>error.statusCode===409&&error.code==='campaign_proof_stale');
    const approvalsAfter=await store.withTenant(identity,db=>db.query('SELECT count(*)::int AS count FROM astra.campaign_approvals WHERE tenant_id=$1 AND campaign_id=$2::uuid',[tenantId,campaign.id]));
    assert.equal(approvalsAfter.rows[0].count,approvalsBefore.rows[0].count,'unsupported copy fails at copy validation before any approval is written');

    const before=await store.withTenant(identity,db=>db.query('SELECT version,subject,body,claims_map,copy_hash,state FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid',[tenantId,campaign.id]));
    await assert.rejects(store.withTenant(identity,(db,actor)=>saveAstraCampaignDraft(db,actor,legacyDb,campaign.id,{...unsupported,expectedVersion:campaign.version})),error=>error.statusCode===409&&error.code==='draft_version_conflict');
    const after=await store.withTenant(identity,db=>db.query('SELECT version,subject,body,claims_map,copy_hash,state FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid',[tenantId,campaign.id]));
    assert.deepEqual(after.rows[0],before.rows[0]);

    const expectedVersion=Number(saved.version);
    const attempts=await Promise.allSettled(['Editor A changes copy.','Editor B changes copy.'].map(body=>store.withTenant(identity,(db,actor)=>saveAstraCampaignDraft(db,actor,legacyDb,campaign.id,{...unsupported,expectedVersion,body}))));
    assert.equal(attempts.filter(item=>item.status==='fulfilled').length,1);
    const conflict=attempts.find(item=>item.status==='rejected');
    assert.equal(conflict.reason.statusCode,409);
    assert.equal(conflict.reason.code,'draft_version_conflict');
    const winner=await store.withTenant(identity,db=>getAstraCampaignComposer(db,tenantId,campaign.id));
    assert.ok(['Editor A changes copy.','Editor B changes copy.'].includes(winner.body));
    assert.equal(winner.validation.eligible,false);
  }finally{
    if(store)await store.close();
    closeLegacy?.();
    rmSync(sqliteDir,{recursive:true,force:true});
  }
});
