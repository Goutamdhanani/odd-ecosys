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

test('campaign approval rejects a stale exact review version before writing any approval',async()=>{
  const fixture=await validateAstraR20Fixture({root,fixturePath});
  const keep=new Set(['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS','NODE_OPTIONS','ASTRA_QA_FIXTURE_PATH']);
  for(const key of Object.keys(process.env))if(!keep.has(key))delete process.env[key];
  const sqliteDir=mkdtempSync(path.join(tmpdir(),'astra-approval-version-'));
  process.env.ODD_DB_PATH=path.join(sqliteDir,'offers.db');
  let store,legacyDb,closeLegacy;
  try{
    const [{createAstraTenantStore},{createAstraCampaign,approveAstraCampaign},{createOffer,approveOfferVersion},{registerOfferProof,linkOfferProof}]=await Promise.all([
      import('../pipeline/astra-tenant-store.js'),import('../pipeline/astra-campaigns.js'),import('../pipeline/offer-contracts.js'),import('../pipeline/offer-proof-store.js'),
    ]);
    const sqlite=await import('../pipeline/database.js');
    legacyDb=sqlite.initDb();closeLegacy=sqlite.closeDb;
    store=createAstraTenantStore({connectionString:fixture.connectionString,contextSecret:fixture.contextSecret});
    const userId=String(1_000_000_000+randomBytes(4).readUInt32BE(0));
    const {tenantId}=await store.createTenant({name:`Approval version ${randomUUID().slice(0,8)}`,userId});
    const proofBytes=Buffer.from(`synthetic approval version proof ${randomUUID()}`);
    const proofHash=createHash('sha256').update(proofBytes).digest('hex');
    const offerContent={service:'SEO audit',scope:'One audit with a written findings report.',price:{minMinor:10000,maxMinor:90000,currency:'USD'},
      proofAssets:[{proofId:'approval-version-proof',reference:'fixture://approval-version/proof',contentHash:proofHash,observedAt:'2026-10-01T00:00:00.000Z',expiresAt:'2035-01-01T00:00:00.000Z',rightsBasis:'Synthetic fixture'}],
      audienceExclusions:['Existing customer'],geography:{includedCountries:['US'],excludedCountries:[]},capacity:10,egress:{mode:'NO_MODEL_EGRESS',allowedDestinations:[]}};
    const sqliteActor={id:Number(userId),role:'owner',tenantId};
    const offer=createOffer(legacyDb,{name:'Approval version offer',content:offerContent},sqliteActor);
    const proof=registerOfferProof(legacyDb,sqliteActor,{bytes:proofBytes,mimeType:'text/plain',expiresAt:'2035-01-01T00:00:00.000Z',contentHash:proofHash});
    linkOfferProof(legacyDb,sqliteActor,{offerVersionId:offer.version.id,proofId:'approval-version-proof',objectId:proof.id});
    approveOfferVersion(legacyDb,offer.id,offer.version.id,sqliteActor);
    const identity={tenantId,userId};
    let campaign;
    await store.withTenant(identity,async(db,actor)=>{
      const mailboxId=randomUUID();
      await db.query(`INSERT INTO astra.mailboxes(tenant_id,id,display_name,provider,actor_id) VALUES($1,$2,'Approval version test','manual',$3)`,[tenantId,mailboxId,userId]);
      campaign=await createAstraCampaign(db,actor,legacyDb,{name:'Approval version campaign',offerVersionId:offer.version.id,mailboxId,
        purpose:'research note',geography:['US'],spendLimitMinor:90000,currency:'USD'});
    });
    await store.withTenant(identity,db=>db.query(`UPDATE astra.campaigns SET version=version+1 WHERE tenant_id=$1 AND id=$2::uuid`,[tenantId,campaign.id]));
    const expectedVersion=Number(campaign.version);
    const before=await store.withTenant(identity,db=>db.query(`SELECT version,(SELECT count(*)::int FROM astra.campaign_approvals WHERE tenant_id=$1 AND campaign_id=$2::uuid) AS approvals
      FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid`,[tenantId,campaign.id]));
    await assert.rejects(store.withTenant(identity,(db,actor)=>approveAstraCampaign(db,actor,legacyDb,campaign.id,
      {expectedVersion,expiresAt:'2030-01-01T00:00:00.000Z'})),error=>error.statusCode===409&&error.code==='campaign_version_conflict');
    const after=await store.withTenant(identity,db=>db.query(`SELECT version,(SELECT count(*)::int FROM astra.campaign_approvals WHERE tenant_id=$1 AND campaign_id=$2::uuid) AS approvals
      FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid`,[tenantId,campaign.id]));
    assert.equal(after.rows[0].version,expectedVersion+1,'the newer persisted campaign version remains intact');
    assert.equal(after.rows[0].approvals,before.rows[0].approvals,'stale review creates no approval row');
  }finally{
    if(store)await store.close();
    closeLegacy?.();
    rmSync(sqliteDir,{recursive:true,force:true});
  }
});
