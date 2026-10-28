import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateAstraPlatformFixture } from './support/astra-platform-fixture.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixtureInput=process.env.ASTRA_QA_FIXTURE_PATH;
const fixturePath=fixtureInput?path.resolve(fixtureInput):null;
const qaRoot=path.resolve(root,'.runner/astra-qa');

test('workflow retries are read-only, fenced, and idempotent on synthetic PostgreSQL',{
  skip:fixturePath?false:'Set ASTRA_QA_FIXTURE_PATH to a prepared disposable synthetic fixture at .runner/astra-qa/<label>/pg.json.',
},async()=>{
  const canonicalQaRoot=await realpath(qaRoot), canonicalFixture=await realpath(fixturePath);
  const relative=path.relative(canonicalQaRoot,canonicalFixture), parts=relative.split(path.sep);
  assert.equal(path.isAbsolute(relative),false,'fixture must be below the repository QA fixture root');
  assert.equal(parts.length,2,'fixture must be .runner/astra-qa/<label>/pg.json');
  assert.ok(parts[0]&&parts[0]!=='..'); assert.equal(parts[1],'pg.json');
  const fixture=await validateAstraPlatformFixture({root,fixturePath:canonicalFixture,allowR20:true,labels:'legacy31-or-r18',migrations:'legacy31-or-r18'});
  assert.equal(fixture.mode,'disposable-synthetic-qa'); assert.equal(fixture.label,parts[0]);
  assert.equal(fixture.realData,false);
  for(const connectionString of [fixture.connectionString,fixture.workerConnectionString]) {
    const url=new URL(connectionString);
    assert.ok(['postgres:','postgresql:'].includes(url.protocol));
    assert.ok(['localhost','127.0.0.1','::1'].includes(url.hostname),'PostgreSQL must be loopback-only');
  }
  assert.equal(typeof fixture.contextSecret,'string');

  const safeEnv=new Set(['PATH','SystemRoot','WINDIR','TEMP','TMP','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS']);
  for(const key of Object.keys(process.env)) if(!safeEnv.has(key)) delete process.env[key];
  const scratch=mkdtempSync(path.join(os.tmpdir(),'astra-workflow-recovery-'));
  process.env.ODD_DB_PATH=path.join(scratch,'auth.sqlite');
  process.env.NODE_ENV='test'; process.env.ODD_AUTH_ENFORCE_TESTS='true';
  process.env.ODD_AUTH_BOOTSTRAP_TOKEN=randomBytes(24).toString('hex'); process.env.ODD_AUTH_COOKIE_SECURE='false';
  process.env.ODD_CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex'); process.env.PORT='0'; process.env.HOST='127.0.0.1';
  process.env.ASTRA_DATABASE_URL=fixture.connectionString; process.env.ASTRA_WORKER_DATABASE_URL=fixture.workerConnectionString;
  process.env.ASTRA_CONTEXT_SECRET=fixture.contextSecret; process.env.ASTRA_TENANT_MODE='1'; process.env.ASTRA_LEGACY_OFFER_BRIDGE='1';
  process.env.LOCAL_PREVIEW='1'; process.env.ASTRA_LIVE_ACTIONS='disabled'; process.env.ASTRA_GLOBAL_PROVIDER_DECISION='unapproved';
  await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);

  let server, closeDb, store;
  const checks=[];
  try {
    ({server}=await import('../server.js'));
    ({closeDb}=await import('../pipeline/database.js'));
    const {createAstraTenantStore}=await import('../pipeline/astra-tenant-store.js');
    const {claimWorkflow,checkpointWorkflow,heartbeatWorkflow,getWorkflow}=await import('../pipeline/astra-workflow.js');
    store=createAstraTenantStore({connectionString:fixture.workerConnectionString,contextSecret:fixture.contextSecret});
    if(!server.listening) await new Promise((resolve,reject)=>{server.once('error',reject);server.once('listening',resolve);});
    const base=`http://127.0.0.1:${server.address().port}`;
    async function req(route,{method='GET',body,cookie='',csrf=''}={}) {
      const headers={}; if(body!==undefined)headers['content-type']='application/json'; if(cookie)headers.cookie=cookie; if(csrf)headers['x-csrf-token']=csrf;
      const response=await fetch(base+route,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,setCookie:response.headers.get('set-cookie')||'',body:await response.json()};
    }
    const authDb=(await import('../pipeline/database.js')).initDb();
    authDb.prepare("DELETE FROM sqlite_sequence WHERE name='auth_users'").run();
    authDb.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('auth_users',?)").run(1_000_000_000+randomBytes(4).readUInt32BE(0));
    const boot=await req('/api/auth/bootstrap',{method:'POST',body:{email:`workflow-${randomBytes(5).toString('hex')}@example.test`,password:'Synthetic-workflow-pass-9!',bootstrapToken:process.env.ODD_AUTH_BOOTSTRAP_TOKEN}});
    assert.equal(boot.status,201,boot.body?.error);
    const sessionId=boot.setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1], csrfCookie=boot.setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
    assert.ok(sessionId&&csrfCookie); const session={cookie:`odd_session=${sessionId}; odd_csrf=${csrfCookie}`,csrf:decodeURIComponent(csrfCookie)};
    const tenant=await req('/api/astra/tenants',{method:'POST',...session,body:{name:'Synthetic workflow recovery'}});
    assert.equal(tenant.status,201,tenant.body?.error); const tenantId=tenant.body.tenant.id, userId=String(boot.body.user.id);
    const snapshot=await req(`/api/astra/tenants/${tenantId}/research/snapshots`,{method:'POST',...session,body:{sourceUrl:'https://workflow.synthetic.example.test/about',html:'<html><body>Synthetic workflow recovery evidence.</body></html>',mediaType:'text/html',rightsPolicy:'synthetic_fixture',rightsAttested:true,robotsAllowed:true}});
    assert.equal(snapshot.status,201,snapshot.body?.error); const evidenceId=snapshot.body.data.evidence.id;
    const actor={tenantId,userId};
    async function queue(key) {
      const result=await req(`/api/astra/tenants/${tenantId}/automation/research`,{method:'POST',...session,body:{evidenceIds:[evidenceId],idempotencyKey:key}});
      assert.equal(result.status,201,result.body?.error); assert.ok(result.body?.data?.id); return result.body.data.id;
    }
    async function withWorker(work) { return store.withWorkerTenant(actor,(db,member)=>work(db,{...member,...actor,role:member.tenantRole})); }
    async function claim(id,workerId) {
      const result=await withWorker((db,worker)=>claimWorkflow(db,worker,{workerId,leaseSeconds:30,taskClasses:['interactive']}));
      assert.equal(result?.id,id); assert.ok(result.leaseToken); return result;
    }
    async function countEvents(id,eventType) {
      return withWorker(async db=>(await db.query(`SELECT count(*)::int AS count FROM astra.events WHERE tenant_id=$1::uuid AND entity_type='astra_workflow' AND entity_id=$2::text AND event_type=$3`,[tenantId,id,eventType])).rows[0].count);
    }
    async function buildCheckpoint(id,lease,novelty='b'.repeat(64)) {
      const workflow=await req(`/api/astra/tenants/${tenantId}/workflows/${id}`,{cookie:session.cookie});
      assert.equal(workflow.status,200);
      const evidence=workflow.body.data.task.contextManifest.entries.find(entry=>entry.recordType==='evidence');
      return {checkpointVersion:'astra-runtime-checkpoint/1.0.0',attemptRef:{attempt:lease.attempt,leaseTokenSha256:createHash('sha256').update(lease.leaseToken).digest('hex')},
        policyRefs:workflow.body.data.task.policyRefs,evidenceRefs:[{tenantId,recordId:evidenceId,contentSha256:evidence.sha256}],usageRefs:[],progress:{canonicalHash:'a'.repeat(64),noveltyHash:novelty}};
    }

    const queuedId=await queue('recovery-cancel-queued');
    const concurrentCancels=await Promise.all([1,2].map(()=>req(`/api/astra/tenants/${tenantId}/workflows/${queuedId}/cancel`,{method:'POST',...session,body:{}})));
    assert.deepEqual(concurrentCancels.map(x=>x.status).sort(),[200,200]);
    assert.equal(concurrentCancels.filter(x=>x.body?.data?.duplicate===true).length,1);
    assert.equal(await countEvents(queuedId,'workflow.cancelled'),1); checks.push('concurrent queued cancellation returns one receipt and one ledger event');

    const runningId=await queue('recovery-cancel-running'), runningLease=await claim(runningId,'recovery-running-worker');
    const runningCancels=await Promise.all([1,2].map(()=>req(`/api/astra/tenants/${tenantId}/workflows/${runningId}/cancel`,{method:'POST',...session,body:{}})));
    assert.deepEqual(runningCancels.map(x=>x.status).sort(),[200,200]);
    assert.equal(runningCancels.filter(x=>x.body?.data?.duplicate===true).length,1);
    assert.equal(await countEvents(runningId,'workflow.cancelled'),1);
    await assert.rejects(withWorker((db,worker)=>heartbeatWorkflow(db,worker,{id:runningId,leaseToken:runningLease.leaseToken})),error=>error?.code==='lease_fenced');
    checks.push('concurrent running cancellation is idempotent and fences the worker lease');

    const releasedId=await queue('recovery-release-checkpoint'), releasedLease=await claim(releasedId,'recovery-release-worker');
    const releasedCheckpoint=await buildCheckpoint(releasedId,releasedLease);
    const releasedFirst=await withWorker((db,worker)=>checkpointWorkflow(db,worker,{id:releasedId,leaseToken:releasedLease.leaseToken,checkpoint:releasedCheckpoint,releaseLease:true}));
    const releasedReplay=await withWorker((db,worker)=>checkpointWorkflow(db,worker,{id:releasedId,leaseToken:releasedLease.leaseToken,checkpoint:releasedCheckpoint,releaseLease:true}));
    assert.equal(releasedFirst.state,'checkpointed'); assert.equal(releasedReplay.duplicate,true); assert.equal(releasedReplay.updated,false);
    assert.equal(await countEvents(releasedId,'workflow.checkpointed'),1);
    const reclaimed=await claim(releasedId,'recovery-reclaimed-worker');
    assert.equal(reclaimed.attempt,releasedLease.attempt+1); assert.notEqual(reclaimed.leaseToken,releasedLease.leaseToken);
    const staleWrite={...releasedCheckpoint,progress:{...releasedCheckpoint.progress,noveltyHash:'f'.repeat(64)}};
    await assert.rejects(withWorker((db,worker)=>checkpointWorkflow(db,worker,{id:releasedId,leaseToken:releasedLease.leaseToken,checkpoint:staleWrite,releaseLease:true})),error=>error?.code==='lease_fenced');
    checks.push('released checkpoint exact retry is read-only; reclaimed attempt rejects stale fresh writes');

    const retainedId=await queue('recovery-retained-checkpoints'), retainedLease=await claim(retainedId,'recovery-retained-worker');
    const checkpointOne=await buildCheckpoint(retainedId,retainedLease,'c'.repeat(64));
    const firstRetained=await withWorker((db,worker)=>checkpointWorkflow(db,worker,{id:retainedId,leaseToken:retainedLease.leaseToken,checkpoint:checkpointOne,releaseLease:false}));
    const replayRetained=await withWorker((db,worker)=>checkpointWorkflow(db,worker,{id:retainedId,leaseToken:retainedLease.leaseToken,checkpoint:checkpointOne,releaseLease:false}));
    const checkpointTwo={...checkpointOne,progress:{...checkpointOne.progress,noveltyHash:'d'.repeat(64)}};
    const secondRetained=await withWorker((db,worker)=>checkpointWorkflow(db,worker,{id:retainedId,leaseToken:retainedLease.leaseToken,checkpoint:checkpointTwo,releaseLease:false}));
    const replaySecond=await withWorker((db,worker)=>checkpointWorkflow(db,worker,{id:retainedId,leaseToken:retainedLease.leaseToken,checkpoint:checkpointTwo,releaseLease:false}));
    assert.equal(firstRetained.updated,true); assert.equal(replayRetained.duplicate,true); assert.equal(secondRetained.updated,true); assert.equal(replaySecond.duplicate,true);
    assert.equal(await countEvents(retainedId,'workflow.checkpointed'),2);
    const retainedState=await withWorker(async db=>(await db.query(`SELECT w.state,w.checkpoint->'progress'->>'noveltyHash' AS novelty,a.state AS attempt_state,a.novelty_hash AS attempt_novelty
      FROM astra.workflows w JOIN astra.workflow_attempts a ON (a.tenant_id,a.workflow_id,a.attempt)=(w.tenant_id,w.id,w.attempt)
      WHERE w.tenant_id=$1::uuid AND w.id=$2::uuid`,[tenantId,retainedId])).rows[0]);
    assert.equal(retainedState.state,'running'); assert.equal(retainedState.attempt_state,'running');
    assert.equal(retainedState.novelty,'d'.repeat(64)); assert.equal(retainedState.attempt_novelty,'d'.repeat(64));
    checks.push('retained lease accepts distinct checkpoints and exact retries with stable event identities');

    const invalidId=await queue('recovery-invalid-pins'), invalidLease=await claim(invalidId,'recovery-invalid-worker');
    const validPins=await buildCheckpoint(invalidId,invalidLease);
    const invalidPins={...validPins,policyRefs:[...validPins.policyRefs,{...validPins.policyRefs[0],sha256:'0'.repeat(64)}]};
    await assert.rejects(withWorker((db,worker)=>checkpointWorkflow(db,worker,{id:invalidId,leaseToken:invalidLease.leaseToken,checkpoint:invalidPins,releaseLease:false})));
    const afterInvalid=await withWorker(async db=>(await db.query(`SELECT w.checkpoint,a.checkpoint AS attempt_checkpoint FROM astra.workflows w JOIN astra.workflow_attempts a
      ON (a.tenant_id,a.workflow_id,a.attempt)=(w.tenant_id,w.id,w.attempt) WHERE w.tenant_id=$1::uuid AND w.id=$2::uuid`,[tenantId,invalidId])).rows[0]);
    assert.equal(afterInvalid.checkpoint,null); assert.equal(afterInvalid.attempt_checkpoint,null);
    checks.push('invalid pinned checkpoint refs roll back without durable workflow or attempt writes');

    const otherTenant=await req('/api/astra/tenants',{method:'POST',...session,body:{name:'Synthetic other workflow tenant'}});
    assert.equal(otherTenant.status,201); const otherTenantId=otherTenant.body.tenant.id;
    const hidden=await store.withWorkerTenant({tenantId:otherTenantId,userId},db=>getWorkflow(db,otherTenantId,queuedId));
    assert.equal(hidden,null); checks.push('worker tenant scope hides another tenant workflow');
    const {initDb}=await import('../pipeline/database.js');
    const {createAuthManager}=await import('../pipeline/auth-manager.js');
    const auth=createAuthManager(initDb());
    const reviewerEmail=`workflow-reviewer-${randomBytes(4).toString('hex')}@example.test`;
    const workspaceInvite=auth.createInvitation({actor:{id:Number(userId),role:'owner'},email:reviewerEmail,role:'reviewer',remoteAddress:'127.0.0.1'}).invitation;
    const reviewerAuth=await auth.acceptInvitation({email:reviewerEmail,password:'Synthetic-reviewer-pass-9!',invitationToken:workspaceInvite.token,remoteAddress:'127.0.0.1'});
    assert.ok(reviewerAuth.sessionToken&&reviewerAuth.csrfToken);
    const reviewer={cookie:`odd_session=${reviewerAuth.sessionToken}; odd_csrf=${reviewerAuth.csrfToken}`,csrf:reviewerAuth.csrfToken};
    const astraInvite=await req(`/api/astra/tenants/${tenantId}/memberships/invitations`,{method:'POST',...session,body:{email:reviewerEmail,role:'reviewer'}});
    assert.equal(astraInvite.status,201,astraInvite.body?.error);
    const acceptedAstra=await req('/api/astra/invitations/accept',{method:'POST',...reviewer,body:{token:astraInvite.body.token}});
    assert.equal(acceptedAstra.status,200,acceptedAstra.body?.error);
    const deniedCancel=await req(`/api/astra/tenants/${tenantId}/workflows/${invalidId}/cancel`,{method:'POST',...reviewer,body:{}});
    assert.equal(deniedCancel.status,403); assert.match(deniedCancel.body.error,/Tenant role does not allow this action/);
    const reviewerHidden=await req(`/api/astra/tenants/${otherTenantId}/workflows/${queuedId}`,{cookie:reviewer.cookie});
    assert.equal(reviewerHidden.status,404);
    checks.push('actual reviewer session is denied workflow cancellation; app tenant membership and worker RLS hide cross-tenant workflows');
    process.stdout.write(`${JSON.stringify({fixtureMode:fixture.mode,migrations:fixture.migrations.length,realData:false,checks},null,2)}\n`);
  } finally {
    await store?.close().catch(()=>{});
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    if(closeDb)await closeDb();
    rmSync(scratch,{recursive:true,force:true});
  }
});
