import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { loadAstraConnectorCredentials, connectorApprovalReady, connectorTransportEnabled } from './astra-connectors.js';
import { isPublicAddress } from './ssrf-guard.js';
import { AstraTenantContextError } from './astra-tenant-context.js';

const fail=(message,status=409,code='smtp_dispatch_blocked')=>{throw new AstraTenantContextError(message,status,code);};
const sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');
const truthy=value=>['1','true','yes'].includes(String(value||'').toLowerCase());
const localPreview=()=>truthy(process.env.LOCAL_PREVIEW)||truthy(process.env.ASTRA_LOCAL_PREVIEW)||truthy(process.env.ASTRA_PREVIEW);

function assertDispatchAuthority(environment='provider_observed') {
  // These are checked before DNS and again on every use. Local preview stays an
  // unconditional deny even if a resolver or transport factory is injected.
  if(localPreview()||!connectorTransportEnabled('smtp_imap',environment)
    ||process.env.ASTRA_GLOBAL_PROVIDER_DECISION!=='approved'
    ||process.env.ASTRA_LIVE_ACTIONS!=='enabled') fail('SMTP provider actions are disabled.',409,'external_actions_disabled');
  const expires=Date.parse(process.env.ASTRA_GLOBAL_PROVIDER_DECISION_EXPIRES_AT||'');
  if(!Number.isFinite(expires)||expires<=Date.now())fail('The global provider decision is absent or expired.',409,'global_provider_decision_expired');
}

function normalizedHost(value) {
  if(typeof value!=='string'||!value.trim()||value.length>253||/[/:@\s\u0000-\u001f\u007f]/.test(value))fail('SMTP host is invalid.',400,'smtp_host_invalid');
  const result=value.trim().toLowerCase();
  if(result==='localhost'||result.endsWith('.localhost')||result.endsWith('.local')||result.endsWith('.internal'))fail('SMTP host is not public.',403,'smtp_destination_denied');
  return result;
}
function validPort(value) {
  const port=Number(value??465);
  if(!Number.isInteger(port)||port<1||port>65535)fail('SMTP port is invalid.',400,'smtp_port_invalid');
  return port;
}
async function pinPublicDestination(hostname,resolver) {
  const hostnameNormalized=normalizedHost(hostname);
  let addresses;
  try { addresses=net.isIP(hostnameNormalized)?[{address:hostnameNormalized}]:await resolver(hostnameNormalized,{all:true,verbatim:true}); }
  catch { fail('SMTP host could not be resolved.',502,'smtp_dns_failed'); }
  if(!Array.isArray(addresses)||!addresses.length||addresses.length>32||addresses.some(item=>!item||!isPublicAddress(item.address)))
    fail('SMTP host resolves outside the public address space.',403,'smtp_destination_denied');
  const address=addresses[0].address,family=net.isIP(address);
  if(!family)fail('SMTP host returned an invalid address.',403,'smtp_destination_denied');
  // Nodemailer receives a pinned, previously validated address so a second DNS
  // answer cannot rebind the socket to loopback or a private network.
  const lookup=(name,options,callback)=>{
    if(name.toLowerCase()!==hostnameNormalized)return callback(new Error('SMTP lookup host changed.'));
    if(options?.all)return callback(null,[{address,family}]);
    return callback(null,address,family);
  };
  return {hostname:hostnameNormalized,address,family,lookup};
}
function cleanHeader(value,name,max) {
  if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value,'utf8')>max||/[\r\n\u0000-\u001f\u007f]/.test(value))
    fail(`${name} is invalid.`,400,'smtp_message_invalid');
  return value.trim();
}
function cleanAddress(value,name) {
  const address=cleanHeader(value,name,320);
  if(!/^[^\s<>(),;:\\"\[\]]+@[^\s<>(),;:\\"\[\]]+\.[^\s<>(),;:\\"\[\]]+$/.test(address))fail(`${name} is invalid.`,400,'smtp_message_invalid');
  return address;
}
function cleanText(value) {
  if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>100000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    fail('SMTP message text is invalid or exceeds its bound.',400,'smtp_message_invalid');
  if(/\r(?!\n)/.test(value))fail('SMTP message text contains a bare carriage return.',400,'smtp_message_invalid');
  return value.replace(/\r?\n/g,'\r\n');
}
function exactMessage(message,ticketId) {
  if(!message||typeof message!=='object'||Array.isArray(message)||message.ticketId!==ticketId
    ||Object.keys(message).some(key=>!['mailboxId','to','subject','text','ticketId'].includes(key)))
    fail('SMTP message does not match its immutable ticket copy.',409,'smtp_message_scope_invalid');
  if('attachments' in message||'headers' in message||'cc' in message||'bcc' in message)fail('SMTP attachments and caller headers are not permitted.',400,'smtp_message_invalid');
  return Object.freeze({mailboxId:message.mailboxId,to:cleanAddress(message.to,'Recipient',320),
    subject:cleanHeader(message.subject,'Subject',998),text:cleanText(message.text),ticketId});
}
function exactTicketMessage(message,ticket) {
  if(!ticket?.intent||typeof message?.subject!=='string'||typeof message?.text!=='string'
    ||String(ticket.intent.email||'').trim().toLowerCase()!==String(message?.to||'').trim().toLowerCase()
    ||sha256(message?.subject)!==ticket.intent.subjectHash||sha256(message?.text)!==ticket.intent.bodyHash)
    fail('SMTP content or recipient does not match the immutable ticket intent.',409,'smtp_ticket_copy_mismatch');
  return exactMessage(message,ticket.id);
}

/**
 * Prepare the exact server-owned SMTP request while inside the signed worker
 * transaction. The returned opaque object contains only the immutable copy,
 * resolved tenant config and decrypted connector credential; it has no DB
 * client or active transaction. submitPrepared is called after commit.
 */
export function createAstraSmtpDispatchAdapter({smtpTransportFactory=null,resolver=dns.lookup,now=Date.now}={}) {
  const factory=smtpTransportFactory||((options)=>nodemailer.createTransport(options));
  const prepareSubmit=async({client,actor,ticket,connectorId,capabilityEvidenceId,configurationHash,message})=>{
    assertDispatchAuthority();
    if(!client||!actor?.tenantId||!actor?.userId||!ticket?.id||!connectorId||!capabilityEvidenceId
      ||typeof configurationHash!=='string'||!/^[a-f0-9]{64}$/i.test(configurationHash))
      fail('Signed SMTP dispatch preparation is incomplete.',403,'smtp_dispatch_forbidden');
    const exact=exactTicketMessage(message,ticket);
    const cfg=await loadAstraConnectorCredentials(client,actor,connectorId,'smtp_imap');
    if(!connectorApprovalReady(cfg,'smtp_imap'))fail('Provider commercial, source-rights, and privacy approvals are not established.',403,'connector_approval_required');
    const proof=await client.query(`SELECT e.configuration_hash,
        astra.connector_configuration_hash(c.provider,c.endpoint_host,c.public_config,c.credential_fingerprint) AS current_configuration_hash
      FROM astra.connector_evidence e JOIN astra.connector_configs c ON(c.tenant_id,c.id)=(e.tenant_id,e.connector_id)
      JOIN astra.mailbox_connectors b ON(b.tenant_id,b.connector_id)=(e.tenant_id,e.connector_id) AND b.mailbox_id=e.mailbox_id
      WHERE e.tenant_id=$1 AND e.id=$2::uuid AND e.connector_id=$3::uuid AND e.mailbox_id=$4::uuid
        AND e.capability='smtp.submit' AND e.outcome='supported' AND e.source='provider_probe'
        AND e.environment='provider_observed' AND e.expires_at>now() AND c.provider='smtp_imap' AND c.state='configured'`,
      [actor.tenantId,capabilityEvidenceId,connectorId,exact.mailboxId]);
    const current=proof.rows[0];
    if(!current||current.configuration_hash!==configurationHash||current.current_configuration_hash!==configurationHash)
      fail('Current SMTP capability evidence does not match the exact connector configuration.',409,'smtp_capability_configuration_stale');
    const smtp=cfg.public_config?.smtp||{},credentials=cfg.credentials||{};
    if(smtp.enabled!==true)fail('SMTP is not explicitly enabled for this connector.',409,'smtp_disabled');
    const from=cleanAddress(credentials.from||credentials.smtpUser,'Configured sender',320);
    if(typeof credentials.smtpUser!=='string'||!credentials.smtpUser||typeof credentials.smtpPassword!=='string'||!credentials.smtpPassword)
      fail('SMTP credentials are unavailable.',503,'smtp_credentials_unavailable');
    return Object.freeze({tenantId:String(actor.tenantId),connectorId:String(connectorId),mailboxId:String(exact.mailboxId),ticketId:String(ticket.id),
      configurationHash,capabilityEvidenceId:String(capabilityEvidenceId),smtp:Object.freeze({...smtp}),
      credentials:Object.freeze({smtpUser:credentials.smtpUser,smtpPassword:credentials.smtpPassword,from}),message:exact,preparedAt:now()});
  };
  const submitPrepared=async({prepared,ticket,message})=>{
    assertDispatchAuthority();
    if(!prepared||prepared.ticketId!==ticket?.id||prepared.message.ticketId!==ticket?.id
      ||prepared.message.mailboxId!==prepared.mailboxId)fail('Prepared SMTP request is not bound to this ticket.',409,'smtp_preparation_stale');
    const exact=exactTicketMessage(message,ticket);
    if(JSON.stringify(exact)!==JSON.stringify(prepared.message))fail('SMTP ticket copy changed after preparation.',409,'smtp_message_scope_invalid');
    if(!Number.isFinite(prepared.preparedAt)||now()-prepared.preparedAt>30000)fail('Prepared SMTP credentials or proof are stale.',409,'smtp_preparation_expired');
    // All feature and global kill switches are checked before DNS resolution.
    assertDispatchAuthority();
    const destination=await pinPublicDestination(prepared.smtp.host,resolver);
    assertDispatchAuthority();
    const transport=factory({host:destination.hostname,lookup:destination.lookup,port:validPort(prepared.smtp.port),
      secure:prepared.smtp.secure===true,requireTLS:true,tls:{rejectUnauthorized:true,servername:destination.hostname},
      auth:{user:prepared.credentials.smtpUser,pass:prepared.credentials.smtpPassword},logger:false,debug:false,
      connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});
    try {
      const info=await transport.sendMail({from:prepared.credentials.from,to:prepared.message.to,subject:prepared.message.subject,
        text:prepared.message.text,attachments:[],headers:{}});
      const smtpResponse=typeof info?.response==='string'?info.response.slice(0,1000):'';
      const match=/^(\d{3})(?:[ -])/.exec(smtpResponse);
      const responseCode=match?Number(match[1]):null;
      const accepted=Array.isArray(info?.accepted)?info.accepted.map(value=>typeof value==='string'?value:value?.address).filter(Boolean):[];
      const rejected=Array.isArray(info?.rejected)?info.rejected:[];
      const exactAccepted=accepted.length===1&&String(accepted[0]).trim().toLowerCase()===prepared.message.to.toLowerCase()&&rejected.length===0;
      const providerReceipt=responseCode&&responseCode>=200&&responseCode<300&&exactAccepted?Object.freeze({
        schemaVersion:1,kind:'smtp_final_response',connectorId:prepared.connectorId,mailboxId:prepared.mailboxId,ticketId:prepared.ticketId,
        configurationHash:prepared.configurationHash,capabilityEvidenceId:prepared.capabilityEvidenceId,
        responseCode,smtpResponse,recipientSha256:sha256(prepared.message.to.trim().toLowerCase()),
        subjectSha256:sha256(prepared.message.subject),textSha256:sha256(prepared.message.text),acceptedCount:1,rejectedCount:0,
        providerMessageId:typeof info.messageId==='string'?info.messageId.slice(0,500):null,
      }):null;
      if(providerReceipt)return {state:'accepted',providerReceipt};
      return {state:'uncertain',diagnosticCode:'smtp_final_response_unproven'};
    } catch(error) {
      // Once DATA may have crossed the socket, a dropped reply is ambiguous.
      // Quarantine every network submission exception; never retry automatically.
      return {state:'uncertain',diagnosticCode:typeof error?.code==='string'&&/^[A-Z0-9_]{2,40}$/.test(error.code)?error.code.toLowerCase():'smtp_submission_uncertain'};
    } finally {try{transport.close?.();}catch{}}
  };
  return Object.freeze({prepareSubmit,submitPrepared});
}
