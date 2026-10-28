import { randomUUID } from 'node:crypto';
import { AstraTenantContextError } from './astra-tenant-context.js';

const fail = (message, status = 400, code = 'reply_task_invalid') => { throw new AstraTenantContextError(message,status,code); };

/** Deterministic only. The body stays inert data; there is deliberately no model call. */
export function classifyAstraReply(bodyText) {
  const text = String(bodyText || '').normalize('NFKC').toLowerCase();
  if (/\b(unsubscribe|stop (?:emailing|contacting)|remove me|do not (?:email|contact)|don't (?:email|contact)|opt\s*out)\b/.test(text)) {
    return { classification: 'opt_out', method: 'deterministic_rule', stop: true,
      proposal: { nextAction: 'record_suppression_and_operator_review', modelUsed: false } };
  }
  if (/\b(not interested|no thanks|no thank you|please do not pursue|already have a vendor|we are not looking)\b/.test(text)) {
    return { classification: 'hard_negative', method: 'deterministic_rule', stop: true,
      proposal: { nextAction: 'stop_outreach_and_operator_review', modelUsed: false } };
  }
  if (/\b(yes|interested|let'?s talk|book a meeting|sounds good|send (?:me )?more)\b/.test(text)) {
    return { classification: 'positive', method: 'deterministic_rule', stop: false,
      proposal: { nextAction: 'operator_review_before_any_crm_or_status_change', modelUsed: false } };
  }
  if (/\?/.test(text) || /\b(question|how much|when can|what is|could you explain)\b/.test(text)) {
    return { classification: 'question', method: 'deterministic_rule', stop: false,
      proposal: { nextAction: 'operator_review_before_any_response_or_status_change', modelUsed: false } };
  }
  return { classification: 'unknown', method: 'abstain', stop: false,
    proposal: { nextAction: 'operator_review', modelUsed: false, abstained: true } };
}

export async function createAstraReplyTask(client, actor, messageId) {
  if (typeof messageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(messageId)) fail('messageId is invalid.');
  const result = await client.query(`SELECT id,sender,body_text FROM astra.inbox_messages WHERE tenant_id=$1 AND id=$2::uuid`, [actor.tenantId,messageId]);
  const message = result.rows[0];
  if (!message) fail('Message was not found.',404,'message_not_found');
  const classification = classifyAstraReply(message.body_text);
  const taskId = randomUUID();
  const inserted = await client.query(`INSERT INTO astra.reply_tasks(tenant_id,id,message_id,classification,classification_method,proposal,actor_id)
    VALUES ($1,$2,$3::uuid,$4,$5,$6::jsonb,$7) ON CONFLICT (tenant_id,message_id) DO NOTHING RETURNING id,classification,status`,
  [actor.tenantId,taskId,message.id,classification.classification,classification.method,JSON.stringify(classification.proposal),String(actor.userId)]);
  if (!inserted.rowCount) {
    const existing = await client.query(`SELECT id,classification,status FROM astra.reply_tasks WHERE tenant_id=$1 AND message_id=$2::uuid`, [actor.tenantId,message.id]);
    return { ...existing.rows[0], duplicate: true, stop: classification.stop };
  }
  if (classification.stop && message.sender) {
    await client.query(`INSERT INTO astra.suppression_decisions(tenant_id,id,scope,scope_value,reason,evidence,actor_id)
      VALUES ($1,$2,'recipient',$3,$4,$5::jsonb,$6)`, [actor.tenantId,randomUUID(),message.sender,
      classification.classification === 'opt_out' ? 'reply_opt_out' : 'reply_hard_negative',
      JSON.stringify({ messageId: message.id, rule: classification.classification, source: 'deterministic_reply_classifier' }),String(actor.userId)]);
  }
  return { ...inserted.rows[0], duplicate: false, stop: classification.stop, classificationMethod: classification.method };
}

export async function listAstraReplyTasks(client, tenantId, { status = null, limit = 100 } = {}) {
  if (status != null && !['needs_review','approved','rejected'].includes(status)) fail('status is invalid.');
  const bounded = Number.isInteger(limit) ? Math.max(1,Math.min(limit,200)) : 100;
  const rows = await client.query(`SELECT t.id,t.message_id,t.classification,t.classification_method,t.proposal,t.status,t.actor_id,t.reviewed_by,t.review_note,t.created_at,t.reviewed_at,
      m.sender,m.subject,m.body_text,m.received_at
    FROM astra.reply_tasks t JOIN astra.inbox_messages m ON m.tenant_id=t.tenant_id AND m.id=t.message_id
    WHERE t.tenant_id=$1 AND ($2::text IS NULL OR t.status=$2)
    ORDER BY t.created_at DESC LIMIT $3`, [tenantId,status,bounded]);
  return rows.rows.map(row => ({ id:row.id,messageId:row.message_id,classification:row.classification,
    classificationMethod:row.classification_method,proposal:row.proposal,status:row.status,createdBy:row.actor_id,
    reviewedBy:row.reviewed_by,reviewNote:row.review_note,createdAt:row.created_at,reviewedAt:row.reviewed_at,
    message:{ sender:row.sender,subject:row.subject,bodyText:row.body_text,receivedAt:row.received_at } }));
}

export async function reviewAstraReplyTask(client, actor, taskId, input) {
  if (typeof taskId !== 'string' || !/^[0-9a-f-]{36}$/i.test(taskId)) fail('taskId is invalid.');
  if (!input || !['approved','rejected'].includes(input.decision)) fail('decision must be approved or rejected.');
  const note = input.note == null ? null : String(input.note).trim();
  if (note?.length > 2000) fail('note is too long.');
  const result = await client.query(`UPDATE astra.reply_tasks SET status=$3,reviewed_by=$4,review_note=$5,reviewed_at=now()
    WHERE tenant_id=$1 AND id=$2::uuid AND status='needs_review' RETURNING id,status,classification,reviewed_at`,
  [actor.tenantId,taskId,input.decision,String(actor.userId),note]);
  if (!result.rowCount) {
    const exists = await client.query(`SELECT id,status FROM astra.reply_tasks WHERE tenant_id=$1 AND id=$2::uuid`, [actor.tenantId,taskId]);
    if (!exists.rowCount) fail('Reply task was not found.',404,'reply_task_not_found');
    fail('Reply task has already been reviewed.',409,'reply_task_already_reviewed');
  }
  return result.rows[0];
}

