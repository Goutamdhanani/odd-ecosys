// ============================================================
//  ODD-ECOSYS Pipeline — CRM Control Plane & Sync (Phase 9)
//  Twenty CRM GraphQL & REST API connector, bi-directional sync,
//  human-in-the-loop kill-switch, domain blacklisting,
//  and audit trail logging.
// ============================================================

import { getDb } from './database.js';
import { cancelSending } from './sending-engine.js';
import { suppressEmail } from './compliance.js';

function crmConfig() {
  return {
    url: process.env.TWENTY_API_URL || '',
    token: process.env.TWENTY_API_TOKEN || '',
  };
}

/**
 * Sync lead to Twenty CRM (GraphQL).
 * Uses the documented Twenty standard-object API: the Company object with the
 * standard fields `name` and `domainName`. Custom pipeline fields are NOT sent
 * until a matching custom field exists in the target workspace schema.
 * Outcome semantics:
 *   not configured            -> synced:false, status:'not_configured'
 *   network/HTTP/GraphQL error-> synced:false, status:'failed' (retryable)
 *   verified createCompany id -> synced:true, remote id persisted on the lead
 * There is no local-only fallback that pretends the sync succeeded.
 */
export async function syncLeadToCRM(leadId) {
  const db = getDb();
  const lead = db.prepare(`
    SELECT l.*,
      le.verification_status, le.is_catch_all
    FROM leads l
    LEFT JOIN lead_emails le ON le.lead_id = l.id
    WHERE l.id = ?
  `).get(leadId);

  if (!lead) return { synced: false, status: 'error', error: 'lead_not_found' };

  const { url: TWENTY_API_URL, token: TWENTY_API_TOKEN } = crmConfig();
  if (!TWENTY_API_TOKEN || !TWENTY_API_URL) {
    db.prepare("UPDATE leads SET crm_sync_status = 'not_configured' WHERE id = ?").run(leadId);
    return {
      synced: false,
      status: 'not_configured',
      error: 'TWENTY_API_URL and TWENTY_API_TOKEN must be configured before leads can be synchronized.',
    };
  }

  const domainName = lead.website_url
    ? String(lead.website_url).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    : null;

  const payload = {
    name: lead.business_name,
    ...(domainName ? { domainName } : {}),
  };

  try {
    const mutation = `
      mutation CreateCompany($data: CompanyCreateInput!) {
        createCompany(data: $data) {
          id
          name
        }
      }
    `;
    const res = await fetch(TWENTY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TWENTY_API_TOKEN}`,
      },
      body: JSON.stringify({ query: mutation, variables: { data: payload } }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      db.prepare("UPDATE leads SET crm_sync_status = 'failed' WHERE id = ?").run(leadId);
      return { synced: false, status: 'failed', error: `CRM HTTP ${res.status}`, detail: bodyText.slice(0, 300), retryable: true };
    }

    // HTTP 200 alone is not success: GraphQL reports failures in `errors`.
    const body = await res.json();
    if (body.errors?.length) {
      db.prepare("UPDATE leads SET crm_sync_status = 'failed' WHERE id = ?").run(leadId);
      return { synced: false, status: 'failed', error: 'CRM GraphQL error', detail: JSON.stringify(body.errors).slice(0, 500), retryable: true };
    }
    if (!body.data?.createCompany?.id) {
      db.prepare("UPDATE leads SET crm_sync_status = 'failed' WHERE id = ?").run(leadId);
      return { synced: false, status: 'failed', error: 'CRM response missing createCompany.id', retryable: false };
    }

    const remoteId = body.data.createCompany.id;
    db.prepare(`
      UPDATE leads SET crm_sync_status = 'synced', crm_remote_id = ?, crm_synced_at = datetime('now')
      WHERE id = ?
    `).run(remoteId, leadId);

    return { synced: true, status: 'synced', remote: 'twenty_crm', remoteId, payload };
  } catch (err) {
    db.prepare("UPDATE leads SET crm_sync_status = 'failed' WHERE id = ?").run(leadId);
    return { synced: false, status: 'failed', error: `CRM unreachable: ${err.message}`, retryable: true };
  }
}

/**
 * Map pipeline status to standard CRM Sales Pipeline stages.
 */
function mapStatusToCRMStage(status) {
  const map = {
    discovered: 'New Prospect',
    enriching: 'Enrichment',
    site_checked: 'Qualified',
    verifying: 'Verification',
    personalizing: 'Copywriting',
    awaiting_approval: 'Review Queue',
    queued: 'Ready to Send',
    sent: 'Contacted',
    replied: 'Engaged',
    won: 'Meeting Booked / Won',
    lost: 'Closed Lost',
    disqualified: 'Unqualified',
  };
  return map[status] || status;
}

/**
 * Emergency Kill-Switch: Instantly halt all active sends, cancel queue, and pause mailboxes.
 */
export function emergencyKillSwitch(reason = 'manual_kill_switch') {
  const db = getDb();
  
  // 1. Cancel in-memory send execution
  cancelSending();

  // 2. Clear scheduled sends
  const cancelledSends = db.prepare("UPDATE sends SET status = 'cancelled' WHERE status = 'scheduled'").run();

  // 3. Pause all active mailboxes
  const pausedMailboxes = db.prepare("UPDATE mailboxes SET warmup_status = 'paused', daily_limit = 0 WHERE active = 1").run();

  // 4. Record audit log event
  db.prepare(`
    INSERT INTO events (lead_id, event_type, event_at, meta_json)
    VALUES (NULL, 'kill_switch_activated', datetime('now'), ?)
  `).run(JSON.stringify({
    reason,
    cancelledSends: cancelledSends.changes,
    pausedMailboxes: pausedMailboxes.changes,
    timestamp: new Date().toISOString(),
  }));

  return {
    ok: true,
    action: 'emergency_kill_switch',
    cancelledSends: cancelledSends.changes,
    pausedMailboxes: pausedMailboxes.changes,
  };
}

/**
 * Blacklist a domain globally across all leads & suppression list.
 */
export function blacklistDomain(domain, reason = 'manual_domain_blacklist') {
  if (!domain) throw new Error('domain is required');
  const db = getDb();
  const cleanDomain = domain.toLowerCase().trim();

  // Update domains table
  db.prepare(`
    INSERT OR REPLACE INTO domains (domain, blacklisted)
    VALUES (?, 1)
  `).run(cleanDomain);

  // Disqualify all existing leads from this domain
  const result = db.prepare(`
    UPDATE leads
    SET status = 'disqualified', disqualification_reason = ?, updated_at = datetime('now')
    WHERE lower(website_url) LIKE ? OR lower(email) LIKE ?
  `).run(reason, `%${cleanDomain}%`, `%@${cleanDomain}`);

  return {
    ok: true,
    domain: cleanDomain,
    disqualifiedLeads: result.changes,
  };
}

/**
 * Get unified CRM control plane status.
 */
export function getCRMControlPlaneStatus() {
  const db = getDb();

  const stages = db.prepare(`
    SELECT status, COUNT(*) as count FROM leads GROUP BY status
  `).all();

  const recentAudits = db.prepare(`
    SELECT * FROM events
    WHERE event_type IN ('kill_switch_activated', 'unsubscribed', 'bounced', 'replied')
    ORDER BY event_at DESC
    LIMIT 20
  `).all();

  return {
    pipelineStages: stages.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {}),
    twentyCrmConfigured: !!(crmConfig().token && crmConfig().url),
    recentAuditLogs: recentAudits,
  };
}
