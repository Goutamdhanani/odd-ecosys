import { createHash, randomUUID } from 'node:crypto';
import { AstraTenantContextError } from './astra-tenant-context.js';

const error = (message, status = 400, code = 'inbox_invalid') => { throw new AstraTenantContextError(message, status, code); };
const clean = (value, field, max = 500, optional = false) => {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) error(`${field} is invalid.`);
  return value.trim();
};
const email = value => {
  if (value == null) return null;
  const normalized = clean(value, 'email', 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) error('Email address is invalid.');
  return normalized;
};

export async function createAstraMailbox(client, actor, input) {
  const displayName = clean(input?.displayName, 'displayName', 160);
  const providerMailboxId = clean(input?.providerMailboxId, 'providerMailboxId', 500, true);
  if (input?.provider != null && input.provider !== 'manual') error('Only manual mailbox identity is supported.');
  const id = randomUUID();
  await client.query(`INSERT INTO astra.mailboxes(tenant_id,id,display_name,provider,provider_mailbox_id,configuration_status,capability_evidence,actor_id)
    VALUES ($1,$2,$3,'manual',$4,'unknown',$5::jsonb,$6)`,
  [actor.tenantId,id,displayName,providerMailboxId,JSON.stringify({ source: 'manual_configuration', receive: 'manual_ingest_only', send: 'disabled' }),String(actor.userId)]);
  return { id, displayName, provider: 'manual', configurationStatus: 'unknown', capabilities: { receive: 'manual_ingest_only', send: 'disabled' } };
}

export async function listAstraMailboxes(client) {
  const result = await client.query(`SELECT id,display_name,provider,provider_mailbox_id,configuration_status,capability_evidence,created_at,updated_at
    FROM astra.mailboxes ORDER BY created_at DESC LIMIT 200`);
  return result.rows.map(row => ({ id: row.id, displayName: row.display_name, provider: row.provider,
    providerMailboxId: row.provider_mailbox_id, configurationStatus: row.configuration_status,
    capabilities: { receive: row.provider === 'manual' ? 'manual_ingest_only' : 'unknown', send: 'disabled' },
    evidence: row.capability_evidence, createdAt: row.created_at }));
}

function normalizeMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) error('Message must be an object.');
  const mailboxId = clean(input.mailboxId, 'mailboxId', 36);
  if (!/^[0-9a-f-]{36}$/i.test(mailboxId)) error('mailboxId is invalid.');
  const externalThreadId = clean(input.externalThreadId, 'externalThreadId', 500);
  const externalMessageId = clean(input.externalMessageId, 'externalMessageId', 500);
  const inReplyTo = clean(input.inReplyTo, 'inReplyTo', 500, true);
  const sender = email(input.sender);
  const recipients = input.recipients ?? [];
  if (!Array.isArray(recipients) || recipients.length > 50) error('recipients must be an array of at most 50 addresses.');
  const normalizedRecipients = [...new Set(recipients.map(email))];
  if (normalizedRecipients.some(value => !value)) error('recipients cannot contain empty addresses.');
  const subject = clean(input.subject, 'subject', 998, true);
  const bodyText = typeof input.bodyText === 'string' ? input.bodyText : null;
  if (bodyText === null || bodyText.length > 100000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(bodyText)) error('bodyText must be text of at most 100,000 printable characters.');
  const receivedDate = input.receivedAt == null ? new Date() : new Date(input.receivedAt);
  if (Number.isNaN(receivedDate.valueOf())) error('receivedAt must be a valid date.');
  const receivedAt = receivedDate.toISOString();
  const canonical = JSON.stringify({ externalThreadId,externalMessageId,inReplyTo,sender,recipients:normalizedRecipients,subject,bodyText });
  return { mailboxId,externalThreadId,externalMessageId,inReplyTo,sender,recipients:normalizedRecipients,subject,bodyText,receivedAt,hash:createHash('sha256').update(canonical).digest('hex') };
}

/** Manually ingest a synthetic or operator-supplied message; no mailbox polling occurs. */
export async function ingestAstraMessage(client, actor, input) {
  const message = normalizeMessage(input);
  const mailbox = await client.query(`SELECT id,provider FROM astra.mailboxes WHERE tenant_id=$1 AND id=$2::uuid`, [actor.tenantId,message.mailboxId]);
  if (!mailbox.rowCount) error('Mailbox was not found.',404,'mailbox_not_found');
  const existing = await client.query(`SELECT id,thread_id,content_hash FROM astra.inbox_messages WHERE tenant_id=$1 AND mailbox_id=$2::uuid AND external_message_id=$3`, [actor.tenantId,message.mailboxId,message.externalMessageId]);
  if (existing.rowCount) {
    if (existing.rows[0].content_hash !== message.hash) error('Message identity already exists with different content.',409,'message_dedupe_conflict');
    return { id: existing.rows[0].id, threadId: existing.rows[0].thread_id, duplicate: true };
  }
  const threadResult = await client.query(`INSERT INTO astra.inbox_threads(tenant_id,mailbox_id,external_thread_id,recipient,subject)
    VALUES ($1,$2::uuid,$3,$4,$5) ON CONFLICT (tenant_id,mailbox_id,external_thread_id) DO NOTHING
    RETURNING id,recipient,subject`, [actor.tenantId,message.mailboxId,message.externalThreadId,message.sender,message.subject]);
  const thread = threadResult.rows[0] || (await client.query(`SELECT id,recipient,subject FROM astra.inbox_threads
    WHERE tenant_id=$1 AND mailbox_id=$2::uuid AND external_thread_id=$3`,[actor.tenantId,message.mailboxId,message.externalThreadId])).rows[0];
  let inReplyToMessageId = null;
  if (message.inReplyTo) {
    const replyTarget = await client.query(`SELECT id FROM astra.inbox_messages WHERE tenant_id=$1 AND mailbox_id=$2::uuid
      AND thread_id=$3::uuid AND external_message_id=$4`, [actor.tenantId,message.mailboxId,thread.id,message.inReplyTo]);
    if (!replyTarget.rowCount) error('inReplyTo must reference an earlier message in this mailbox thread.',409,'message_reply_reference_missing');
    inReplyToMessageId = replyTarget.rows[0].id;
  }
  const id = randomUUID();
  const saved = await client.query(`INSERT INTO astra.inbox_messages(tenant_id,id,mailbox_id,thread_id,in_reply_to_message_id,external_message_id,in_reply_to,sender,recipients,subject,body_text,received_at,content_hash,created_by)
    VALUES ($1,$2,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9::jsonb,$10,$11,$12::timestamptz,$13,$14)
    ON CONFLICT (tenant_id,mailbox_id,external_message_id) DO NOTHING RETURNING id`,
  [actor.tenantId,id,message.mailboxId,thread.id,inReplyToMessageId,message.externalMessageId,message.inReplyTo,message.sender,JSON.stringify(message.recipients),message.subject,message.bodyText,message.receivedAt,message.hash,String(actor.userId)]);
  if (!saved.rowCount) {
    const concurrent = await client.query(`SELECT id,thread_id,content_hash FROM astra.inbox_messages WHERE tenant_id=$1 AND mailbox_id=$2::uuid AND external_message_id=$3`, [actor.tenantId,message.mailboxId,message.externalMessageId]);
    if (!concurrent.rowCount || concurrent.rows[0].content_hash !== message.hash) error('Message identity already exists with different content.',409,'message_dedupe_conflict');
    return { id:concurrent.rows[0].id,threadId:concurrent.rows[0].thread_id,duplicate:true };
  }
  return { id, threadId: thread.id, duplicate: false };
}

export async function listAstraInbox(client, { tenantId, threadId = null, limit = 100 } = {}) {
  const boundedLimit = Number.isInteger(limit) ? Math.max(1,Math.min(limit,200)) : 100;
  if (threadId != null && !/^[0-9a-f-]{36}$/i.test(String(threadId))) error('threadId is invalid.');
  const result = await client.query(`SELECT m.id,m.mailbox_id,m.thread_id,m.external_message_id,m.in_reply_to,m.in_reply_to_message_id,m.sender,m.recipients,m.subject,m.body_text,m.received_at,m.created_at
    FROM astra.inbox_messages m WHERE m.tenant_id=$1 AND ($2::uuid IS NULL OR m.thread_id=$2::uuid)
    ORDER BY m.received_at DESC,m.id DESC LIMIT $3`, [tenantId,threadId,boundedLimit]);
  return result.rows.map(row => ({ id: row.id, mailboxId: row.mailbox_id, threadId: row.thread_id,
    externalMessageId: row.external_message_id, inReplyTo: row.in_reply_to, inReplyToMessageId:row.in_reply_to_message_id, sender: row.sender,
    recipients: row.recipients, subject: row.subject, bodyText: row.body_text,
    receivedAt: row.received_at, createdAt: row.created_at }));
}

