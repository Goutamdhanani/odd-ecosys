import { randomUUID } from 'node:crypto';

const SCOPES = new Set(['tenant', 'campaign', 'mailbox']);
const safeCode = value => typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(value);
export class AstraOperationsError extends Error {
  constructor(message, statusCode = 400, code = 'operations_invalid') { super(message); this.name = 'AstraOperationsError'; this.statusCode = statusCode; this.code = code; this.publicMessage = message; }
}

export async function setAstraKillSwitch(client, actor, { scope = 'tenant', campaignId = null, mailboxId = null, enabled = true, reasonCode = 'operator_stop' } = {}) {
  if (!SCOPES.has(scope) || typeof enabled !== 'boolean' || !safeCode(reasonCode)
    || (scope === 'campaign' && !campaignId) || (scope === 'mailbox' && !mailboxId)
    || (scope !== 'campaign' && campaignId) || (scope !== 'mailbox' && mailboxId)) throw new AstraOperationsError('Kill switch scope or value is invalid.');
  const id = scope === 'campaign' ? campaignId : scope === 'mailbox' ? mailboxId : '00000000-0000-0000-0000-000000000000';
  const r = await client.query(`INSERT INTO astra.operational_kill_switches
    (tenant_id,scope,scope_id,enabled,reason_code,updated_by,updated_at)
    VALUES($1,$2,$3::uuid,$4,$5,$6,now())
    ON CONFLICT(tenant_id,scope,scope_id) DO UPDATE SET enabled=EXCLUDED.enabled,reason_code=EXCLUDED.reason_code,updated_by=EXCLUDED.updated_by,updated_at=now()
    RETURNING scope,scope_id AS "scopeId",enabled,reason_code AS "reasonCode",updated_at AS "updatedAt"`,
  [actor.tenantId, scope, id, enabled, reasonCode, String(actor.userId)]);
  return r.rows[0];
}

export async function assertAstraDispatchEnabled(client, tenantId, campaignId) {
  const campaign = await client.query(`SELECT mailbox_id FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid`, [tenantId, campaignId]);
  if (!campaign.rowCount) throw new AstraOperationsError('Campaign not found.', 404, 'campaign_not_found');
  const checks = await client.query(`SELECT scope,enabled,reason_code FROM astra.operational_kill_switches
    WHERE tenant_id=$1 AND enabled=true AND ((scope='tenant' AND scope_id='00000000-0000-0000-0000-000000000000'::uuid) OR (scope='campaign' AND scope_id=$2::uuid) OR (scope='mailbox' AND scope_id=$3::uuid))`,
  [tenantId, campaignId, campaign.rows[0].mailbox_id]);
  if (checks.rowCount) throw new AstraOperationsError('Dispatch is stopped by an operational kill switch.', 409, 'operational_kill_switch', { scope: checks.rows[0].scope, reasonCode: checks.rows[0].reason_code });
  return { enabled: true };
}

export async function observeAstraOperations(client, tenantId) {
  const [queues, usage, generation, switches, incidents] = await Promise.all([
    client.query(`SELECT source,state,count(*)::int AS count FROM (
        SELECT 'workflow'::text AS source,state FROM astra.workflows WHERE tenant_id=$1
        UNION ALL SELECT 'generation'::text AS source,state FROM astra.generation_jobs WHERE tenant_id=$1
        UNION ALL SELECT 'ai_usage'::text AS source,state FROM astra.ai_usage_requests WHERE tenant_id=$1
      ) q GROUP BY source,state`, [tenantId]),
    client.query(`SELECT COALESCE(sum(cost_microusd),0)::bigint AS spent,COALESCE(max(p.daily_budget_microusd),0)::bigint AS budget
      FROM astra.ai_usage_requests u LEFT JOIN astra.ai_tenant_policies p ON p.tenant_id=u.tenant_id
      WHERE u.tenant_id=$1 AND u.created_at>=date_trunc('day',now())`, [tenantId]),
    client.query(`SELECT COALESCE(sum(actual_cost_microusd),0)::bigint AS spent,COALESCE(max(p.daily_budget_microusd),0)::bigint AS budget
      FROM astra.generation_jobs j LEFT JOIN astra.generation_tenant_policies p ON p.tenant_id=j.tenant_id
      WHERE j.tenant_id=$1 AND j.created_at>=date_trunc('day',now())`, [tenantId]),
    client.query(`SELECT scope,scope_id AS "scopeId",enabled,reason_code AS "reasonCode",updated_at AS "updatedAt" FROM astra.operational_kill_switches WHERE tenant_id=$1 ORDER BY scope,scope_id`, [tenantId]),
    client.query(`SELECT id,incident_code AS "incidentCode",state,opened_at AS "openedAt",resolved_at AS "resolvedAt" FROM astra.operational_incidents WHERE tenant_id=$1 ORDER BY opened_at DESC LIMIT 50`, [tenantId]),
  ]);
  const queueByService = {};
  for (const row of queues.rows) (queueByService[row.source] ||= {})[row.state] = row.count;
  const aiSpent = Number(usage.rows[0]?.spent || 0), generationSpent = Number(generation.rows[0]?.spent || 0);
  const aiBudget = Number(usage.rows[0]?.budget || 0), generationBudget = Number(generation.rows[0]?.budget || 0);
  const usagePct = Math.max(aiBudget ? aiSpent / aiBudget : 0, generationBudget ? generationSpent / generationBudget : 0);
  const queued = Object.values(queueByService).reduce((sum, states) => sum + Number(states.queued || 0), 0);
  return { queue: { byService: queueByService, queued, alertLimit: 1000, alert: queued > 1000 }, usage: { aiSpentMicrousd: aiSpent, aiBudgetMicrousd: aiBudget, generationSpentMicrousd: generationSpent, generationBudgetMicrousd: generationBudget, alertAtPercent: 80, alert: usagePct >= 0.8 }, killSwitches: switches.rows.map(row => ({ ...row, enabled: Boolean(row.enabled), scopeId: row.scope === 'tenant' ? null : row.scopeId })), incidents: incidents.rows, recoveryObjectives: { rto: 'unknown', rpo: 'unknown', drillStatus: 'pending' } };
}

export async function resolveAstraIncident(client, actor, incidentId) {
  const r = await client.query(`UPDATE astra.operational_incidents SET state='resolved',resolved_by=$3,resolved_at=now()
    WHERE tenant_id=$1 AND id=$2::uuid AND state='open' RETURNING id,incident_code AS "incidentCode",state,resolved_at AS "resolvedAt"`,
  [actor.tenantId, incidentId, String(actor.userId)]);
  if (!r.rowCount) throw new AstraOperationsError('Open incident not found.', 404, 'incident_not_found');
  return r.rows[0];
}

export async function openAstraIncident(client, actor, { incidentCode, severity = 'medium', summaryCode } = {}) {
  if (!safeCode(incidentCode) || !['low', 'medium', 'high', 'critical'].includes(severity) || !safeCode(summaryCode)) throw new AstraOperationsError('Incident details are invalid.');
  const r = await client.query(`INSERT INTO astra.operational_incidents(tenant_id,id,incident_code,severity,summary_code,state,opened_by)
    VALUES($1,$2,$3,$4,$5,'open',$6) RETURNING id,incident_code AS "incidentCode",severity,summary_code AS "summaryCode",state,opened_at AS "openedAt"`,
  [actor.tenantId, randomUUID(), incidentCode, severity, summaryCode, String(actor.userId)]);
  return r.rows[0];
}

export async function requestAstraRecovery(client, actor, { incidentId = null, operation = 'backup_restore', requestCode } = {}) {
  if (!['backup_restore', 'restore_drill', 'backup_verify'].includes(operation) || !safeCode(requestCode)) throw new AstraOperationsError('Recovery request is invalid.');
  const r = await client.query(`INSERT INTO astra.recovery_requests(tenant_id,id,incident_id,operation,request_code,state,requested_by)
    VALUES($1,$2,$3::uuid,$4,$5,'prepared',$6) RETURNING id,incident_id AS "incidentId",operation,request_code AS "requestCode",state,requested_at AS "requestedAt"`,
  [actor.tenantId, randomUUID(), incidentId, operation, requestCode, String(actor.userId)]);
  return { ...r.rows[0], rto: 'unknown', rpo: 'unknown' };
}

export async function recordAstraRecoveryReceipt(client, actor, { requestId, receiptCode, outcome = 'recorded' } = {}) {
  if (!safeCode(receiptCode) || !['recorded', 'succeeded', 'failed'].includes(outcome)) throw new AstraOperationsError('Recovery receipt is invalid.');
  const r = await client.query(`UPDATE astra.recovery_requests SET state=$3,receipt_code=$4,receipt_by=$5,receipt_at=now()
    WHERE tenant_id=$1 AND id=$2::uuid AND state='prepared' RETURNING id,state,receipt_code AS "receiptCode",receipt_at AS "receiptAt"`,
  [actor.tenantId, requestId, outcome, receiptCode, String(actor.userId)]);
  if (!r.rowCount) throw new AstraOperationsError('Prepared recovery request not found.', 404, 'recovery_request_not_found');
  return { ...r.rows[0], rto: 'unknown', rpo: 'unknown', drillValidated: false };
}
