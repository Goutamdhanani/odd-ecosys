import { createHash, randomUUID } from 'node:crypto';
import { findCurrentAstraCampaignAudienceMember } from './astra-campaign-audience.js';

const EVENT_TYPES = new Set(['delivered', 'open', 'click', 'bounce', 'reply', 'unsubscribe']);
const DIAGNOSTICS = new Set(['human', 'proxy', 'scanner', 'unknown']);
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,180}$/.test(value);

export class AstraEngagementError extends Error {
  constructor(message, statusCode = 400, code = 'engagement_invalid') { super(message); this.name = 'AstraEngagementError'; this.statusCode = statusCode; this.code = code; this.publicMessage = message; }
}

export async function setAstraTrackingPermission(client, actor, { campaignId, enabled = false, reasonCode = 'operator_consent' } = {}) {
  if (typeof enabled !== 'boolean' || typeof reasonCode !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(reasonCode)) throw new AstraEngagementError('Tracking permission is invalid.');
  const r = await client.query(`INSERT INTO astra.engagement_privacy_permissions(tenant_id,campaign_id,enabled,reason_code,updated_by,updated_at)
    VALUES($1,$2::uuid,$3,$4,$5,now()) ON CONFLICT(tenant_id,campaign_id) DO UPDATE SET enabled=EXCLUDED.enabled,reason_code=EXCLUDED.reason_code,updated_by=EXCLUDED.updated_by,updated_at=now()
    RETURNING campaign_id AS "campaignId",enabled,reason_code AS "reasonCode",updated_at AS "updatedAt"`,
  [actor.tenantId, campaignId, enabled, reasonCode, String(actor.userId)]);
  return r.rows[0];
}

/** Opaque tracking material can be prepared only after persisted explicit tenant privacy permission. */
export async function prepareAstraTrackingToken(client, actor, { campaignId, recipientId, kind } = {}) {
  if (!['pixel', 'redirect'].includes(kind)) throw new AstraEngagementError('Tracking kind is invalid.');
  const permission = await client.query(`SELECT 1 FROM astra.engagement_privacy_permissions WHERE tenant_id=$1 AND campaign_id=$2::uuid AND enabled=true`, [actor.tenantId, campaignId]);
  if (!permission.rowCount) throw new AstraEngagementError('Explicit privacy permission is required.', 403, 'privacy_permission_required');
  if (!await findCurrentAstraCampaignAudienceMember(client,actor.tenantId,campaignId,recipientId)) {
    throw new AstraEngagementError('Tracking recipient is not in the current qualified audience.', 409, 'campaign_recipient_not_current');
  }
  const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const result = await client.query(`INSERT INTO astra.engagement_tracking_tokens
    (tenant_id,id,campaign_id,recipient_id,token_sha256,kind,enabled,created_by)
    VALUES($1,$2,$3::uuid,$4::uuid,$5,$6,false,$7)
    RETURNING id,campaign_id AS "campaignId",recipient_id AS "recipientId",kind,enabled,created_at AS "createdAt"`,
  [actor.tenantId, randomUUID(), campaignId, recipientId, hash(token), kind, String(actor.userId)]);
  return { ...result.rows[0], token, trackingEnabled: false };
}

/** Record an already received event; this module does not expose a public pixel or redirect endpoint. */
export async function recordAstraEngagementEvent(client, actor, { token, eventType, diagnostic = 'unknown', providerEventId = null, occurredAt = new Date() } = {}) {
  if (!opaque(token) || !EVENT_TYPES.has(eventType) || !DIAGNOSTICS.has(diagnostic)) throw new AstraEngagementError('Engagement event is invalid.');
  if (providerEventId !== null && (typeof providerEventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(providerEventId))) throw new AstraEngagementError('Provider event reference is invalid.');
  const time = occurredAt instanceof Date ? occurredAt.toISOString() : new Date(occurredAt).toISOString();
  if (!Number.isFinite(Date.parse(time))) throw new AstraEngagementError('Engagement timestamp is invalid.');
  const tokenHash = hash(token);
  const r = await client.query(`INSERT INTO astra.engagement_events
    (tenant_id,id,tracking_token_id,event_type,diagnostic,provider_event_id,occurred_at,created_by)
    SELECT $1,$2,t.id,$4,$5,$6,$7::timestamptz,$8 FROM astra.engagement_tracking_tokens t
    WHERE t.tenant_id=$1 AND t.token_sha256=$3 AND t.enabled=true
    ON CONFLICT DO NOTHING
    RETURNING id,event_type AS "eventType",diagnostic,occurred_at AS "occurredAt"`,
  [actor.tenantId, randomUUID(), tokenHash, eventType, diagnostic, providerEventId, time, String(actor.userId)]);
  if (!r.rowCount) {
    const present = await client.query(`SELECT 1 FROM astra.engagement_tracking_tokens WHERE tenant_id=$1 AND token_sha256=$2 AND enabled=true`, [actor.tenantId, tokenHash]);
    if (!present.rowCount) throw new AstraEngagementError('Tracking token is unavailable.', 404, 'tracking_token_not_found');
    return { duplicate: Boolean(providerEventId), accepted: false };
  }
  return { duplicate: false, accepted: true, ...r.rows[0] };
}

/** Delivery is deliberately unknown without canonical provider facts. Opens/clicks use unique filtered recipients. */
export async function getAstraEngagementMetrics(client, tenantId, campaignId) {
  const r = await client.query(`SELECT
      count(DISTINCT q.account_id) FILTER(WHERE e.event_type='open' AND e.diagnostic='human' AND q.account_id IS NOT NULL)::int AS "uniqueHumanOpens",
      count(DISTINCT q.account_id) FILTER(WHERE e.event_type='click' AND e.diagnostic='human' AND q.account_id IS NOT NULL)::int AS "uniqueHumanClicks",
      count(*) FILTER(WHERE e.event_type='open')::int AS "rawOpens",
      count(*) FILTER(WHERE e.event_type='click')::int AS "rawClicks",
      count(*) FILTER(WHERE e.event_type IN ('open','click') AND e.diagnostic IN ('proxy','scanner'))::int AS "filteredAutomationEvents"
    FROM astra.engagement_events e JOIN astra.engagement_tracking_tokens t ON(t.tenant_id,t.id)=(e.tenant_id,e.tracking_token_id)
    -- Historical attribution requires an append-only qualification snapshot
    -- for this candidate and confirms every recorded account matches the
    -- immutable candidate FK. Do not use mutable audience state or receipt rows.
    LEFT JOIN LATERAL (
      SELECT CASE WHEN historical.account_count=1
          AND historical.account_id=candidate.account_id::text THEN candidate.account_id::text END AS account_id
      FROM astra.research_identity_candidates candidate
      CROSS JOIN LATERAL (
        SELECT count(DISTINCT member.value->>'accountId')::int AS account_count,
          min(member.value->>'accountId') AS account_id
        FROM astra.events event
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(event.payload->'audienceSnapshot')='array'
          THEN event.payload->'audienceSnapshot' ELSE '[]'::jsonb END) member(value)
        WHERE event.tenant_id=t.tenant_id AND event.entity_type='astra_campaign' AND event.entity_id=t.campaign_id::text
          AND event.event_type='campaign.qualified'
          AND member.value->>'candidateId'=t.recipient_id::text
      ) historical
      WHERE candidate.tenant_id=t.tenant_id AND candidate.id=t.recipient_id
    ) q ON true
    WHERE e.tenant_id=$1 AND t.campaign_id=$2::uuid`, [tenantId, campaignId]);
  return { delivery: { numerator: null, denominator: null, status: 'unknown' }, ...r.rows[0] };
}
