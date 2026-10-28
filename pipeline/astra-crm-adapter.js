import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { validateUrl } from './ssrf-guard.js';
import { loadAstraConnectorCredentials, connectorTransportEnabled, connectorApprovalReady } from './astra-connectors.js';
import { importAstraCrmOutcome } from './astra-crm.js';
import { AstraTenantContextError } from './astra-tenant-context.js';
import https from 'node:https';
import net from 'node:net';

const fail=(message,status=400,code='crm_adapter_invalid')=>{throw new AstraTenantContextError(message,status,code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
function postTwentyCompany(urlText,address,token,payload,idempotencyKey) {
  const url=new URL(urlText);const family=net.isIP(address);const body=JSON.stringify(payload);
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:url.hostname,servername:url.hostname,port:url.port||443,path:`${url.pathname}${url.search}`,method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':Buffer.byteLength(body),'idempotency-key':idempotencyKey},rejectUnauthorized:true,agent:false,lookup:(_host,options,cb)=>options?.all?cb(null,[{address,family}]):cb(null,address,family)},res=>{
      const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>65536)req.destroy(new Error('response too large'));else chunks.push(chunk);});
      res.on('end',()=>{let parsed=null;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}resolve({status:res.statusCode,body:parsed});});
    });req.setTimeout(10000,()=>req.destroy(new Error('timeout')));req.once('error',reject);req.end(body);
  });
}
const previewDenied=preview=>{if(preview||['1','true'].includes(process.env.LOCAL_PREVIEW||'')||['1','true'].includes(process.env.ASTRA_LOCAL_PREVIEW||''))fail('CRM provider actions are disabled in local preview.',409,'local_preview_external_action_denied');};
function eventSchema(body) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['eventType','externalEventId','occurredAt','entity','payload','correctsEventId','evidenceRef'].includes(k)))return false;
  if(typeof body.eventType!=='string'||!/^((meeting\.(booked|held|cancelled))|(opportunity\.(created|qualified|won|lost))|(revenue\.(paid|refunded))|(outcome\.(labelled|corrected|reversed)))$/.test(body.eventType))return false;
  if(typeof body.externalEventId!=='string'||!body.externalEventId.trim()||body.externalEventId.length>500)return false;
  if(!body.entity||typeof body.entity!=='object'||Array.isArray(body.entity)||!['account','contact','company','deal','opportunity'].includes(body.entity.type)||typeof body.entity.id!=='string'||body.entity.id.length>500)return false;
  if(!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload)||JSON.stringify(body.payload).length>20000)return false;
  const shape={meeting:new Set(['startAt','endAt','status','source']),opportunity:new Set(['stage','amountMinor','currency','source']),revenue:new Set(['amountMinor','currency','transactionRef','source']),outcome:new Set(['label','reason','source','confidence'])};
  const family=body.eventType.split('.')[0],p=body.payload;
  if(Object.keys(p).some(key=>!shape[family]?.has(key)))return false;
  if(family==='meeting'&&body.eventType==='meeting.booked'&&(typeof p.startAt!=='string'||!Number.isFinite(Date.parse(p.startAt))))return false;
  if(family==='opportunity'&&(typeof p.stage!=='string'||!p.stage.trim()||p.stage.length>80))return false;
  if(family==='revenue'&&(!Number.isSafeInteger(p.amountMinor)||p.amountMinor<0||typeof p.currency!=='string'||!/^[A-Z]{3}$/.test(p.currency)))return false;
  if(family==='outcome'&&body.eventType==='outcome.labelled'&&(typeof p.label!=='string'||!p.label.trim()||p.label.length>120))return false;
  if(body.eventType==='outcome.corrected'&&!body.correctsEventId)return false;
  const date=new Date(body.occurredAt);return Number.isFinite(date.valueOf())&&Math.abs(Date.now()-date.valueOf())<366*24*60*60*1000;
}

export async function runAstraCrmOutboxWorker({withWorkerTenant,tenantId,userId,providerCall=null,preview=false}={}) {
  previewDenied(preview);
  if(!connectorTransportEnabled('twenty'))return {state:'disabled',reason:'external_actions_disabled'};
  if(typeof withWorkerTenant!=='function')fail('A worker-scoped tenant store is required.',503,'crm_worker_dependencies_missing');
  const claimed=await withWorkerTenant({tenantId,userId},async(client,actor)=>{
    const ready=await client.query(`SELECT o.id,o.entity_type,o.entity_id,o.operation,o.idempotency_key,o.payload,o.field_authority,o.provenance,o.actor_id,
        s.commercial_approved,s.explicit_opt_in,s.transport_enabled
      FROM astra.crm_outbox o JOIN astra.crm_settings s ON s.tenant_id=o.tenant_id
      WHERE o.tenant_id=$1 AND o.state='queued' ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1`,[actor.tenantId]);
    if(!ready.rowCount)return null;
    const row=ready.rows[0];
    if(row.commercial_approved!==true||row.explicit_opt_in!==true||row.transport_enabled!==true)return {blocked:true,id:row.id};
    const connector=await client.query(`SELECT id FROM astra.connector_configs WHERE tenant_id=$1 AND provider='twenty' AND state='configured' ORDER BY updated_at DESC`,[actor.tenantId]);
    if(connector.rowCount!==1)return {blocked:true,id:row.id};
    const id=connector.rows[0].id;
    await client.query(`UPDATE astra.crm_outbox SET state='attempting',updated_at=now() WHERE tenant_id=$1 AND id=$2::uuid AND state='queued'`,[actor.tenantId,row.id]);
    await client.query(`INSERT INTO astra.crm_attempts(tenant_id,id,outbox_id,attempt_number,state,diagnostic_code,created_by)
      SELECT $1,$2::uuid,$3::uuid,COALESCE(MAX(attempt_number),0)+1,'started','twenty_create_company_started',$4
      FROM astra.crm_attempts WHERE tenant_id=$1 AND outbox_id=$3::uuid`,[actor.tenantId,randomUUID(),row.id,String(userId)]);
    return {...row,connectorId:id,tenantId:actor.tenantId};
  });
  if(!claimed)return {state:'idle'};
  if(claimed.blocked)return {state:'blocked',outboxId:claimed.id};
  let prepared;
  try { prepared=await withWorkerTenant({tenantId,userId},async(client,actor)=>{
    const cfg=await loadAstraConnectorCredentials(client,actor,claimed.connectorId,'twenty');
    if(!connectorApprovalReady(cfg,'twenty'))return {state:'failed',diagnosticCode:'connector_approval_missing'};
    const base=cfg.public_config?.baseUrl;
    if(typeof base!=='string')return {state:'failed',diagnosticCode:'twenty_endpoint_missing'};
    let target;try{target=new URL('/rest/companies',base);}catch{return {state:'failed',diagnosticCode:'twenty_endpoint_invalid'};}
    if(target.protocol!=='https:')return {state:'failed',diagnosticCode:'twenty_tls_required'};
    const safe=await validateUrl(target.href);
    if(!safe.safe)return {state:'failed',diagnosticCode:'twenty_destination_denied'};
    return {url:target.href,ip:safe.resolvedIp,token:cfg.credentials.apiToken,payload:claimed.payload,idempotencyKey:claimed.idempotency_key};
  }); } catch { prepared={state:'failed',diagnosticCode:'twenty_configuration_unavailable'}; }
  let outcome=prepared;
  if(prepared?.url) {
    try {
      const response=providerCall
        ?await providerCall({url:prepared.url,token:prepared.token,payload:prepared.payload,idempotencyKey:prepared.idempotencyKey,redirect:'error'})
        :await postTwentyCompany(prepared.url,prepared.ip,prepared.token,prepared.payload,prepared.idempotencyKey);
      if(!response||!Number.isInteger(response.status))outcome={state:'uncertain',diagnosticCode:'twenty_response_unknown'};
      else {
        let body=response.body;if(typeof body==='string'){try{body=JSON.parse(body);}catch{body=null;}}
        const externalId=body?.data?.createCompany?.id||body?.id;
        if(response.status>=200&&response.status<300&&typeof externalId==='string')outcome={state:'succeeded',externalId:String(externalId).slice(0,500)};
        else if(response.status>=400&&response.status<500)outcome={state:'failed',diagnosticCode:`twenty_http_${response.status}`};
        else outcome={state:'uncertain',diagnosticCode:'twenty_response_ambiguous'};
      }
    } catch { outcome={state:'uncertain',diagnosticCode:'twenty_transport_outcome_unknown'}; }
  }
  await withWorkerTenant({tenantId,userId},async(client,actor)=>{
    if(outcome.state==='succeeded') {
      const inserted=await client.query(`INSERT INTO astra.crm_mappings(tenant_id,entity_type,entity_id,provider,external_id,field_authority,provenance,created_by)
        VALUES ($1,'company',$2,'twenty',$3,$4::jsonb,$5::jsonb,$6) ON CONFLICT DO NOTHING RETURNING external_id`,
      [actor.tenantId,claimed.entity_id,outcome.externalId,JSON.stringify(claimed.field_authority),JSON.stringify({...claimed.provenance,source:'twenty_adapter',outboxId:claimed.id}),String(userId)]);
      if(!inserted.rowCount) {
        const prior=await client.query(`SELECT external_id FROM astra.crm_mappings WHERE tenant_id=$1 AND entity_type='company' AND entity_id=$2 AND provider='twenty'`,[actor.tenantId,claimed.entity_id]);
        if(prior.rows[0]?.external_id!==outcome.externalId)outcome={state:'uncertain',diagnosticCode:'twenty_mapping_conflict'};
      }
    }
    const state=outcome.state==='uncertain'?'uncertain':'failed';
    await client.query(`INSERT INTO astra.crm_attempts(tenant_id,id,outbox_id,attempt_number,state,diagnostic_code,external_id,created_by)
      SELECT $1,$2::uuid,$3::uuid,COALESCE(MAX(attempt_number),0)+1,$4,$5,$6,$7 FROM astra.crm_attempts WHERE tenant_id=$1 AND outbox_id=$3::uuid`,
    [actor.tenantId,randomUUID(),claimed.id,outcome.state,outcome.diagnosticCode||'twenty_company_created',outcome.externalId||null,String(userId)]);
    await client.query(`UPDATE astra.crm_outbox SET state=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2::uuid AND state='attempting'`,[actor.tenantId,claimed.id,outcome.state]);
  });
  return {outboxId:claimed.id,...outcome};
}

/** Raw bytes must be passed by the ingress layer before JSON decoding. */
export async function ingestAstraTwentyWebhook(client,actor,{connectorId,rawBody,signature,timestamp,now=Date.now()}={}) {
  if(!Buffer.isBuffer(rawBody)||rawBody.length>128*1024)fail('Webhook body is invalid or too large.',413,'webhook_body_invalid');
  const seconds=Number(timestamp);if(!Number.isSafeInteger(seconds)||Math.abs(Math.floor(now/1000)-seconds)>300)fail('Webhook timestamp is outside the allowed window.',401,'webhook_timestamp_invalid');
  const cfg=await loadAstraConnectorCredentials(client,actor,connectorId,'twenty');
  if(!connectorTransportEnabled('twenty')||!connectorApprovalReady(cfg,'twenty'))fail('Signed Twenty ingestion is blocked pending provider, source-rights, and privacy approval.',403,'connector_approval_required');
  const secret=cfg.credentials.webhookSecret;
  if(typeof secret!=='string'||secret.length<32)fail('Webhook signing secret is not configured.',503,'webhook_secret_unavailable');
  const expected=createHmac('sha256',secret).update(`${seconds}.`).update(rawBody).digest();
  let supplied;try{supplied=Buffer.from(String(signature||'').replace(/^sha256=/,''),'hex');}catch{supplied=Buffer.alloc(0);}
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))fail('Webhook signature is invalid.',401,'webhook_signature_invalid');
  let body;try{body=JSON.parse(rawBody.toString('utf8'));}catch{fail('Webhook body is not valid JSON.');}
  if(!eventSchema(body))fail('Webhook outcome does not match the accepted Twenty event schema.',422,'webhook_schema_invalid');
  const digest=hash(rawBody);
  const old=await client.query(`SELECT payload_sha256,imported_event_id FROM astra.crm_webhook_receipts WHERE tenant_id=$1 AND connector_id=$2::uuid AND external_event_id=$3`,[actor.tenantId,connectorId,body.externalEventId]);
  if(old.rowCount){if(old.rows[0].payload_sha256!==digest)fail('Webhook event id was reused with different content.',409,'webhook_dedupe_conflict');return {duplicate:true,eventId:old.rows[0].imported_event_id};}
  const event=await importAstraCrmOutcome(client,actor,body);
  await client.query(`INSERT INTO astra.crm_webhook_receipts(tenant_id,connector_id,external_event_id,payload_sha256,imported_event_id) VALUES ($1,$2::uuid,$3,$4,$5::uuid) ON CONFLICT DO NOTHING`,[actor.tenantId,connectorId,body.externalEventId,digest,event.id]);
  return {duplicate:false,eventId:event.id,payloadSha256:digest};
}
