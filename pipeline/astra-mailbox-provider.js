import dns from 'node:dns/promises';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import { isPublicAddress } from './ssrf-guard.js';
import { loadAstraConnectorCredentials, recordAstraConnectorEvidence, connectorTransportEnabled, connectorApprovalReady } from './astra-connectors.js';
import { ingestAstraMessage } from './astra-inbox.js';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { evaluateAstraPermission } from './astra-permissions.js';

const fail=(message,status=400,code='mailbox_provider_invalid')=>{throw new AstraTenantContextError(message,status,code);};
const previewDenied=preview=>{if(preview||['1','true'].includes(process.env.LOCAL_PREVIEW||'')||['1','true'].includes(process.env.ASTRA_LOCAL_PREVIEW||''))fail('Mailbox providers are disabled in local preview.',409,'local_preview_external_action_denied');};
const host=v=>{if(typeof v!=='string'||!v.trim()||v.length>253||/[/:@\s\u0000-\u001f]/.test(v))fail('Mailbox host is invalid.');return v.trim().toLowerCase();};
const port=(v,fallback)=>{const n=Number(v??fallback);if(!Number.isInteger(n)||n<1||n>65535)fail('Mailbox port is invalid.');return n;};

async function assertPublicDestination(hostname,resolver=dns.lookup) {
  const normalized=host(hostname);
  if(normalized==='localhost'||normalized.endsWith('.localhost')||normalized.endsWith('.local')||normalized.endsWith('.internal')) fail('Mailbox host is not a public destination.',403,'mailbox_destination_denied');
  let addresses;
  try { addresses=net.isIP(normalized)?[{address:normalized}]:await resolver(normalized,{all:true,verbatim:true}); } catch { fail('Mailbox host could not be resolved.',502,'mailbox_dns_failed'); }
  if(!addresses?.length||addresses.some(x=>!isPublicAddress(x.address))) fail('Mailbox host resolves outside the public address space.',403,'mailbox_destination_denied');
  const pinned=addresses[0];
  return {hostname:normalized,address:pinned.address,family:net.isIP(pinned.address),lookup:(name,options,callback)=>options?.all?callback(null,[pinned]):callback(null,pinned.address,pinned.family)};
}

function safeMessage(parsed,mailboxId,uid) {
  const from=parsed.from?.address?.trim().toLowerCase()||null;
  const to=[...(parsed.to||[]),...(parsed.cc||[])].map(x=>x.address?.trim().toLowerCase()).filter(Boolean).slice(0,50);
  const messageId=Array.isArray(parsed.headers)?parsed.headers.find(h=>String(h.key).toLowerCase()==='message-id')?.value?.trim():null;
  const externalMessageId=messageId&&messageId.length<=500?messageId:`imap:${uid}`;
  const externalThreadId=(parsed.inReplyTo||parsed.references?.[0]||externalMessageId).slice(0,500);
  let body=parsed.text||'';
  if(!body&&parsed.html)body=parsed.html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').trim();
  return {mailboxId,externalThreadId,externalMessageId,inReplyTo:parsed.inReplyTo||null,sender:from,recipients:to,subject:parsed.subject||null,bodyText:String(body).slice(0,100000),receivedAt:parsed.date||new Date().toISOString()};
}

export function createAstraMailboxProvider({ smtpTransportFactory = null, imapClientFactory = null, resolver = dns.lookup, now = Date.now, transportEnvironment = null } = {}) {
  const environment=transportEnvironment || (smtpTransportFactory||imapClientFactory?'synthetic':'provider_observed');
  if(!['provider_observed','synthetic'].includes(environment))throw new TypeError('Invalid mailbox transport environment.');
  async function load(client,actor,connectorId) {
    const cfg=await loadAstraConnectorCredentials(client,actor,connectorId,'smtp_imap');
    const smtp=cfg.public_config?.smtp||{}, imap=cfg.public_config?.imap||{};
    return {cfg,smtp,imap,creds:cfg.credentials};
  }
  const check = async ({client,actor,connectorId,mailboxId,preview=false}) => {
    previewDenied(preview);
    if(!connectorTransportEnabled('smtp_imap',environment))fail('External provider actions are disabled.',409,'external_actions_disabled');
    const {cfg,smtp,imap,creds}=await load(client,actor,connectorId);
    if(!connectorApprovalReady(cfg,'smtp_imap'))fail('Provider commercial, source-rights, and privacy approvals are not established.',403,'connector_approval_required');
    if(!mailboxId)fail('Capability probes must bind to a tenant mailbox.');
    const linked=await client.query(`SELECT provider_mailbox_id FROM astra.mailbox_connectors WHERE tenant_id=$1 AND connector_id=$2::uuid AND mailbox_id=$3::uuid`,[actor.tenantId,cfg.id,mailboxId]);
    if(!linked.rowCount)fail('Mailbox is not linked to this connector.',409,'mailbox_connector_missing');
    const evidence=[];
    if(smtp.enabled===true) {
      const destination=await assertPublicDestination(smtp.host||cfg.endpoint_host,resolver);
      const factory=smtpTransportFactory|| (options=>nodemailer.createTransport(options));
      const transport=factory({host:destination.hostname,lookup:destination.lookup,port:port(smtp.port,465),secure:smtp.secure===true,requireTLS:true,tls:{rejectUnauthorized:true,servername:destination.hostname},auth:{user:creds.smtpUser,pass:creds.smtpPassword},logger:false,debug:false,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});
      try { await transport.verify(); evidence.push({capability:'smtp.submit',outcome:'supported',source:'provider_probe',environment,provenance:{source:'smtp_probe',evidenceRef:`connector:${cfg.id}:${now()}`,adapterVersion:'astra-mailbox/1'}}); }
      catch { evidence.push({capability:'smtp.submit',outcome:'unknown',source:'provider_probe',environment,provenance:{source:'smtp_probe',evidenceRef:`connector:${cfg.id}:${now()}`,adapterVersion:'astra-mailbox/1'}}); }
      finally { transport.close?.(); }
    }
    if(imap.enabled===true) {
      const destination=await assertPublicDestination(imap.host||cfg.endpoint_host,resolver);
      const factory=imapClientFactory|| (options=>new ImapFlow(options));
      const mailbox=factory({host:destination.hostname,port:port(imap.port,993),secure:imap.secure!==false,servername:destination.hostname,tls:{rejectUnauthorized:true,servername:destination.hostname,lookup:destination.lookup},auth:{user:creds.imapUser,pass:creds.imapPassword},logger:false,connectionTimeout:10000,greetingTimeout:10000, socketTimeout:15000});
      try { await mailbox.connect(); evidence.push({capability:'imap.read',outcome:'supported',source:'provider_probe',environment,provenance:{source:'imap_probe',evidenceRef:`connector:${cfg.id}:${now()}`,adapterVersion:'astra-mailbox/1'}}); }
      catch { evidence.push({capability:'imap.read',outcome:'unknown',source:'provider_probe',environment,provenance:{source:'imap_probe',evidenceRef:`connector:${cfg.id}:${now()}`,adapterVersion:'astra-mailbox/1'}}); }
      finally { try{await mailbox.logout();}catch{} }
    }
    if(!evidence.length)fail('Enable SMTP and/or IMAP explicitly in the connector configuration.');
    const saved=[];
    for(const item of evidence) saved.push(await recordAstraConnectorEvidence(client,actor,cfg.id,{...item,mailboxId,expiresAt:new Date(now()+15*60*1000).toISOString()}));
    if(mailboxId) await client.query(`UPDATE astra.mailboxes SET provider='smtp_imap',configuration_status='configured',capability_evidence=$3::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,mailboxId,JSON.stringify({connectorId:cfg.id,evidence:saved})]);
    return {connectorId:cfg.id,evidence:saved};
  };

  const sync = async ({client,actor,connectorId,mailboxId,limit=25,preview=false}) => {
    previewDenied(preview);
    if(!connectorTransportEnabled('smtp_imap'))fail('External provider actions are disabled.',409,'external_actions_disabled');
    if(!Number.isInteger(limit)||limit<1||limit>100)fail('limit must be 1–100.');
    const {cfg,imap,creds}=await load(client,actor,connectorId);
    if(!connectorApprovalReady(cfg,'smtp_imap'))fail('Provider commercial, source-rights, and privacy approvals are not established.',403,'connector_approval_required');
    const linked=await client.query(`SELECT 1 FROM astra.mailbox_connectors WHERE tenant_id=$1 AND connector_id=$2::uuid AND mailbox_id=$3::uuid`,[actor.tenantId,cfg.id,mailboxId]);
    if(!linked.rowCount)fail('Mailbox is not linked to this connector.',409,'mailbox_connector_missing');
    const proof=await client.query(`SELECT id FROM astra.connector_evidence WHERE tenant_id=$1 AND connector_id=$2::uuid AND mailbox_id=$3::uuid AND capability='imap.read' AND outcome='supported' AND environment='provider_observed' AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,[actor.tenantId,cfg.id,mailboxId]);
    if(!proof.rowCount)fail('A current positive IMAP capability probe is required.',409,'imap_capability_unproven');
    const mailboxRow=await client.query(`SELECT id FROM astra.mailboxes WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,mailboxId]);
    if(!mailboxRow.rowCount)fail('Mailbox was not found.',404,'mailbox_not_found');
    const destination=await assertPublicDestination(imap.host||cfg.endpoint_host,resolver);
    const factory=imapClientFactory|| (options=>new ImapFlow(options));
    const mailbox=factory({host:destination.hostname,port:port(imap.port,993),secure:imap.secure!==false,servername:destination.hostname,tls:{rejectUnauthorized:true,servername:destination.hostname,lookup:destination.lookup},auth:{user:creds.imapUser,pass:creds.imapPassword},logger:false,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,maxResponseSize:8*1024*1024});
    let imported=0,duplicates=0,skipped=0;
    try {
      await mailbox.connect();
      const lock=await mailbox.getMailboxLock('INBOX');
      try {
        const uids=await mailbox.search({all:true},{uid:true});
        const selected=uids.slice(-limit);
        for(const uid of selected) {
          const message=await mailbox.fetchOne(uid,{uid:true,source:true,internalDate:true},{uid:true});
          if(!message?.source){skipped++;continue;}
          let parsed;try{parsed=await PostalMime.parse(message.source,{maxNestingDepth:10,maxHeadersSize:64*1024,maxPartCount:100,maxRfc822NestingDepth:2});}catch{skipped++;continue;}
          const validity=String(mailbox.mailbox?.uidValidity||'unknown');
          const result=await ingestAstraMessage(client,actor,safeMessage(parsed,mailboxId,`${validity}:${uid}`));
          if(result.duplicate)duplicates++;else imported++;
        }
      } finally {lock.release();}
    } catch { fail('IMAP sync failed. Check the configured endpoint, TLS and credentials.',502,'imap_sync_failed'); }
    finally { try{await mailbox.logout();}catch{} }
    return {imported,duplicates,skipped,limit};
  };

  const submit = async ({client,actor,connectorId,message,capabilityEvidenceId,purpose,preview=false}) => {
    previewDenied(preview);
    if(!connectorTransportEnabled('smtp_imap'))fail('External provider actions are disabled.',409,'external_actions_disabled');
    if(!message||typeof message!=='object'||Array.isArray(message)||typeof message.to!=='string'||!/^\S+@\S+\.\S+$/.test(message.to))fail('A single valid message recipient is required.');
    if(typeof purpose!=='string'||!purpose.trim())fail('A dispatch purpose is required.');
    const {cfg,smtp,creds}=await load(client,actor,connectorId);
    if(!connectorApprovalReady(cfg,'smtp_imap'))fail('Provider commercial, source-rights, and privacy approvals are not established.',403,'connector_approval_required');
    const capability=await client.query(`SELECT id FROM astra.connector_evidence WHERE tenant_id=$1 AND connector_id=$2::uuid AND mailbox_id=$3::uuid AND id=$4::uuid AND capability='smtp.submit' AND outcome='supported' AND environment='provider_observed' AND expires_at>now()`,[actor.tenantId,cfg.id,message.mailboxId,capabilityEvidenceId]);
    if(!capability.rowCount)fail('A current positive SMTP capability proof is required.',409,'smtp_capability_unproven');
    const permission=await evaluateAstraPermission(client,actor,{recipient:message.to,purpose});
    if(!permission.allowed)fail('Recipient permission or suppression policy blocks this send.',403,'recipient_policy_blocked');
    const linked=await client.query(`SELECT 1 FROM astra.mailbox_connectors WHERE tenant_id=$1 AND connector_id=$2::uuid AND mailbox_id=$3::uuid`,[actor.tenantId,cfg.id,message.mailboxId]);
    if(!linked.rowCount)fail('Mailbox is not linked to this connector.',409,'mailbox_connector_missing');
    const destination=await assertPublicDestination(smtp.host||cfg.endpoint_host,resolver);
    const factory=smtpTransportFactory|| (options=>nodemailer.createTransport(options));
    const transport=factory({host:destination.hostname,lookup:destination.lookup,port:port(smtp.port,465),secure:smtp.secure===true,requireTLS:true,tls:{rejectUnauthorized:true,servername:destination.hostname},auth:{user:creds.smtpUser,pass:creds.smtpPassword},logger:false,debug:false,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});
    try {
      const result=await transport.sendMail({from:creds.from||creds.smtpUser,to:message.to,subject:message.subject,text:message.text,html:message.html,headers:message.headers});
      return {state:'accepted',providerMessageId:typeof result.messageId==='string'?result.messageId.slice(0,500):null,accepted:Array.isArray(result.accepted)?result.accepted.length:0,rejected:Array.isArray(result.rejected)?result.rejected.length:0};
    } catch(error) {
      const uncertain=error?.command==='DATA'||error?.responseCode>=400&&error?.responseCode<500;
      return {state:uncertain?'uncertain':'failed',diagnosticCode:typeof error?.code==='string'&&/^[A-Z0-9_]{2,40}$/.test(error.code)?error.code:'smtp_submission_failed'};
    } finally {transport.close?.();}
  };
  return Object.freeze({probeMailbox:check,syncMailbox:sync,submitMessage:submit});
}

/** Prepared connector_jobs adapter: DB reads happen in prepare, network work in
 * execute, and message/evidence writes in commit after the network has ended. */
export function createAstraMailboxJobAdapter({smtpTransportFactory=null,imapClientFactory=null,resolver=dns.lookup,now=Date.now,transportEnvironment=null}={}) {
  const environment=transportEnvironment||(smtpTransportFactory||imapClientFactory?'synthetic':'provider_observed');
  const prepare=async({client,actor,job,connector})=>{
    if(!['probe_mailbox','sync_mailbox'].includes(job?.jobType)||!job.mailboxId)fail('Mailbox connector job is invalid.');
    const linked=await client.query(`SELECT provider_mailbox_id FROM astra.mailbox_connectors WHERE tenant_id=$1 AND connector_id=$2::uuid AND mailbox_id=$3::uuid`,[actor.tenantId,job.connectorId,job.mailboxId]);
    if(!linked.rowCount)fail('Mailbox is not linked to this connector.',409,'mailbox_connector_missing');
    if(job.jobType==='sync_mailbox'){
      const proof=await client.query(`SELECT id FROM astra.connector_evidence WHERE tenant_id=$1 AND connector_id=$2::uuid AND mailbox_id=$3::uuid AND capability='imap.read' AND outcome='supported' AND environment='provider_observed' AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,[actor.tenantId,job.connectorId,job.mailboxId]);
      if(!proof.rowCount)fail('A current positive IMAP capability probe is required.',409,'imap_capability_unproven');
    }
    return {mailboxId:job.mailboxId,providerMailboxId:linked.rows[0].provider_mailbox_id,limit:job.payload?.limit||25,publicConfig:connector.publicConfig,credentials:connector.credentials,approval:connector.approval,connectorId:job.connectorId,smtp:connector.publicConfig?.smtp||{},imap:connector.publicConfig?.imap||{}};
  };
  const execute=async({job,prepared})=>{
    previewDenied(false);
    if(!connectorTransportEnabled('smtp_imap',environment))return {state:'blocked',diagnosticCode:'external_actions_disabled'};
    if(!connectorApprovalReady({approval:prepared.approval},'smtp_imap'))return {state:'blocked',diagnosticCode:'connector_approval_required'};
    const {smtp={},imap={},credentials:creds}=prepared;
    const evidence=[];
    if(job.jobType==='probe_mailbox'){
      if(smtp.enabled===true){const dest=await assertPublicDestination(smtp.host,resolver);const transport=(smtpTransportFactory||((o)=>nodemailer.createTransport(o)))({host:dest.hostname,lookup:dest.lookup,port:port(smtp.port,465),secure:smtp.secure===true,requireTLS:true,tls:{rejectUnauthorized:true,servername:dest.hostname},auth:{user:creds.smtpUser,pass:creds.smtpPassword},logger:false,debug:false,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});try{await transport.verify();evidence.push({capability:'smtp.submit',outcome:'supported'});}catch{evidence.push({capability:'smtp.submit',outcome:'unknown'});}finally{transport.close?.();}}
      if(imap.enabled===true){const dest=await assertPublicDestination(imap.host,resolver);const mailbox=(imapClientFactory||((o)=>new ImapFlow(o)))({host:dest.hostname,port:port(imap.port,993),secure:imap.secure!==false,servername:dest.hostname,tls:{rejectUnauthorized:true,servername:dest.hostname,lookup:dest.lookup},auth:{user:creds.imapUser,pass:creds.imapPassword},logger:false,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});try{await mailbox.connect();evidence.push({capability:'imap.read',outcome:'supported'});}catch{evidence.push({capability:'imap.read',outcome:'unknown'});}finally{try{await mailbox.logout();}catch{}}}
      return {state:'succeeded',result:{evidence},publicResult:{capabilities:evidence.map(x=>({capability:x.capability,outcome:x.outcome}))}};
    }
    const limit=Number(prepared.limit);if(!Number.isInteger(limit)||limit<1||limit>100)return {state:'failed',diagnosticCode:'mailbox_sync_limit_invalid'};
    const dest=await assertPublicDestination(imap.host,resolver);const mailbox=(imapClientFactory||((o)=>new ImapFlow(o)))({host:dest.hostname,port:port(imap.port,993),secure:imap.secure!==false,servername:dest.hostname,tls:{rejectUnauthorized:true,servername:dest.hostname,lookup:dest.lookup},auth:{user:creds.imapUser,pass:creds.imapPassword},logger:false,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,maxResponseSize:8*1024*1024});
    const messages=[];try{await mailbox.connect();const lock=await mailbox.getMailboxLock('INBOX');try{const uids=await mailbox.search({all:true},{uid:true});for(const uid of uids.slice(-limit)){const item=await mailbox.fetchOne(uid,{uid:true,source:true,internalDate:true},{uid:true});if(!item?.source)continue;try{const parsed=await PostalMime.parse(item.source,{maxNestingDepth:10,maxHeadersSize:64*1024,maxPartCount:100,maxRfc822NestingDepth:2});messages.push(safeMessage(parsed,prepared.mailboxId,`${String(mailbox.mailbox?.uidValidity||'unknown')}:${uid}`));}catch{}}}finally{lock.release();}}catch{return {state:'failed',diagnosticCode:'imap_sync_failed'};}finally{try{await mailbox.logout();}catch{}}
    return {state:'succeeded',result:{messages},publicResult:{fetched:messages.length,limit}};
  };
  const commit=async({client,actor,job,prepared,result})=>{
    if(job.jobType==='probe_mailbox'){
      const saved=[];for(const item of result.evidence||[])saved.push(await recordAstraConnectorEvidence(client,actor,job.connectorId,{capability:item.capability,outcome:item.outcome,source:'provider_probe',environment,provenance:{source:'mailbox_probe',evidenceRef:`job:${job.id}:${item.capability}`,adapterVersion:'astra-mailbox/1'},mailboxId:job.mailboxId,expiresAt:new Date(now()+900000).toISOString()}));
      await client.query(`UPDATE astra.mailboxes SET provider='smtp_imap',configuration_status='configured',capability_evidence=$3::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,job.mailboxId,JSON.stringify({connectorId:job.connectorId,evidence:saved})]);return {evidence:saved.map(e=>({id:e.id,capability:e.capability,outcome:e.outcome,environment:e.environment}))};
    }
    let imported=0,duplicates=0;for(const message of result.messages||[]){const saved=await ingestAstraMessage(client,actor,message);if(saved.duplicate)duplicates++;else imported++;}return {imported,duplicates,fetched:(result.messages||[]).length};
  };
  return Object.freeze({prepare,execute,commit});
}
