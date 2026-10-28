import { createHash, randomUUID } from 'node:crypto';
import { readAstraSourceRights } from './astra-source-rights.js';

const hash = value => createHash('sha256').update(String(value), 'utf8').digest('hex');
const MAX_EXCERPT = 1000;
const SIGNAL_TTL_DAYS = 14;

function canonicalSourceKey(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return `${url.origin.toLowerCase()}${url.pathname}${url.search}`;
  } catch { return null; }
}

export class AstraRadarError extends Error {
  constructor(message, statusCode = 400, code = 'radar_invalid') {
    super(message); this.name = 'AstraRadarError'; this.statusCode = statusCode; this.code = code;
  }
}

/** Add account X-Ray metric deltas to Radar's existing, expiring signal stream.
 * It emits nothing without an earlier X-Ray baseline and an active watch for
 * the exact evidence source. Snapshot capture and scheduling remain unchanged.
 */
export async function recordAstraXrayRadarDiffs(db, actor, report) {
  if (!actor?.tenantId || !report?.auditId || !report?.summary?.accountId) return { created: 0, reason: 'report_incomplete' };
  const accountId = String(report.summary.accountId);
  const baselineRows = await db.query(`WITH current_audit AS (
      SELECT id,created_at FROM astra.research_audits
      WHERE tenant_id=$1 AND id=$2 AND findings @> $3::jsonb
    ), prior_audits AS (
      SELECT a.id,a.findings,a.created_at FROM astra.research_audits a
      JOIN current_audit current ON a.created_at < current.created_at
      WHERE a.tenant_id=$1 AND a.findings @> $3::jsonb
    ), latest_time AS (
      SELECT max(created_at) AS created_at FROM prior_audits
    ), latest_prior AS (
      SELECT prior.id,prior.findings,prior.created_at FROM prior_audits prior
      JOIN latest_time latest ON prior.created_at=latest.created_at
    )
    SELECT current.id AS "currentAuditId",prior.id,prior.findings,prior.created_at AS "createdAt",
      (SELECT count(*)::int FROM latest_prior) AS "candidateCount"
    FROM current_audit current LEFT JOIN latest_prior prior ON true`,
  [actor.tenantId, report.auditId, JSON.stringify([{ signal: '__account_report_metadata__', accountId }])]);
  if (!baselineRows.rows.length) return { created: 0, reason: 'baseline_unavailable' };
  const candidateCount = Number(baselineRows.rows[0].candidateCount);
  if (!candidateCount) return { created: 0, reason: 'baseline_required' };
  if (candidateCount !== 1) return { created: 0, reason: 'baseline_ambiguous' };
  const metadata = (baselineRows.rows[0].findings || []).find(item => item?.signal === '__account_report_metadata__' && item.accountId === accountId);
  if (!metadata?.metrics) return { created: 0, reason: 'baseline_unavailable' };

  const metricSignals = [
    ['uniqueContentPages', 'captured_page_count'], ['emailCandidates', 'email_candidate_count'],
    ['telephoneLinks', 'telephone_link_count'], ['callToActionLabels', 'call_to_action_count'],
    ['priceMentions', 'visible_price_mention_count'], ['contactPageCaptures', 'contact_page_coverage'],
    ['pricingPageCaptures', 'pricing_page_coverage'],
  ];
  const changed = metricSignals.filter(([key]) => Number.isFinite(Number(metadata.metrics[key]))
    && Number.isFinite(Number(report.metrics?.[key])) && Number(metadata.metrics[key]) !== Number(report.metrics[key]));
  if (!changed.length) return { created: 0, reason: 'no_metric_delta' };
  const now = new Date();
  const expiresAt = new Date(now.valueOf() + SIGNAL_TTL_DAYS * 86400_000).toISOString();
  let created = 0;
  for (const [metric, findingSignal] of changed) {
    const finding = report.findings.find(item => item.signal === findingSignal);
    const refs = finding?.evidence || [];
    for (const ref of refs) {
      if (!ref?.evidenceId || !ref.sourceId || !ref.contentSha256 || !ref.exactExcerpt) continue;
      // Captures keep immutable source rows, so a recapture of one exact URL
      // receives a new source UUID. Resolve it to a watch only by the full
      // canonical URL (including path and query), and recheck rights on both
      // immutable source records. Never carry an expired watch permission to
      // a newly attested capture or widen a watch to another route/domain.
      const source = await db.query(`SELECT w.id AS "watchId",w.source_id AS "watchSourceId",
          ws.source_url AS "watchSourceUrl",ws.normalized_domain AS "normalizedDomain",
          ws.rights_policy AS "rightsPolicy",ws.rights_expires_at AS "rightsExpiresAt",
          ws.robots_allowed AS "robotsAllowed",ws.rights_attested AS "rightsAttested",
          es.id AS "evidenceSourceId",es.source_url AS "evidenceSourceUrl",
          es.rights_policy AS "evidenceRightsPolicy",es.rights_expires_at AS "evidenceRightsExpiresAt",
          es.robots_allowed AS "evidenceRobotsAllowed",es.rights_attested AS "evidenceRightsAttested",
          e.captured_at AS "capturedAt"
        FROM astra.radar_watches w
        JOIN astra.research_sources ws ON (ws.tenant_id,ws.id)=(w.tenant_id,w.source_id)
        JOIN astra.research_evidence e ON (e.tenant_id,e.id)=(w.tenant_id,$2::uuid)
        JOIN astra.research_sources es ON (es.tenant_id,es.id)=(e.tenant_id,e.source_id)
        WHERE w.tenant_id=$1 AND es.id=$3 AND e.content_sha256=$4
          AND ws.normalized_domain=$5 AND es.normalized_domain=$5 AND w.status='active'`,
      [actor.tenantId, ref.evidenceId, ref.sourceId, ref.contentSha256, report.summary.normalizedDomain]);
      for (const watch of source.rows) {
        const currentKey = canonicalSourceKey(ref.sourceUrl);
        if (!currentKey || currentKey !== canonicalSourceKey(watch.watchSourceUrl)
          || currentKey !== canonicalSourceKey(watch.evidenceSourceUrl)) continue;
        // Prove a content change on this exact watched URL against the prior
        // audit's usable capture. Account-level metric deltas alone are not
        // enough: that would let a newly captured /contact page borrow an
        // unchanged /home evidence reference. The audit report timestamp is
        // not used because DB transaction timestamps can predate captures in
        // a long-lived request transaction.
        const baselinePage = (metadata.sourceCoverage?.pages || []).find(page => page?.status === 'usable'
          && canonicalSourceKey(page.sourceUrl) === currentKey);
        if (!baselinePage || !baselinePage.contentSha256 || baselinePage.contentSha256 === ref.contentSha256) continue;
        const rights=await readAstraSourceRights(db,actor.tenantId,[watch.watchSourceId,ref.sourceId]);
        if (!sourceAvailable({ rights_policy: watch.rightsPolicy, rights_expires_at: watch.rightsExpiresAt,
          robots_allowed: watch.robotsAllowed, rights_attested: watch.rightsAttested }, now)
          || !sourceAvailable({ rights_policy: watch.evidenceRightsPolicy, rights_expires_at: watch.evidenceRightsExpiresAt,
            robots_allowed: watch.evidenceRobotsAllowed, rights_attested: watch.evidenceRightsAttested }, now)
          || !rights.get(String(watch.watchSourceId).toLowerCase())?.usable
          || !rights.get(String(ref.sourceId).toLowerCase())?.usable) continue;
        const before = Number(metadata.metrics[metric]), after = Number(report.metrics[metric]);
        const title = `Business X-Ray changed: ${metric}`.slice(0, 500);
        const excerpt = String(ref.exactExcerpt).slice(0, MAX_EXCERPT) || ref.sourceUrl;
        const summaryText = `${metric} changed from ${before} to ${after} in successive account audits.`;
        const eventFingerprint = hash(`xray\n${report.summary.normalizedDomain}\n${metric}\n${before}\n${after}`);
        const semanticSha256 = hash(`${metric}:${after}`);
        const event = await db.query(`INSERT INTO astra.radar_events(tenant_id,id,event_fingerprint,semantic_sha256,normalized_summary,expires_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,event_fingerprint) DO NOTHING RETURNING id`,
        [actor.tenantId, randomUUID(), eventFingerprint, semanticSha256, summaryText, expiresAt]);
        const eventId = event.rows[0]?.id || (await db.query('SELECT id FROM astra.radar_events WHERE tenant_id=$1 AND event_fingerprint=$2', [actor.tenantId, eventFingerprint])).rows[0]?.id;
        if (!eventId) continue;
        await db.query(`INSERT INTO astra.radar_event_sources(tenant_id,event_id,watch_id,source_id,evidence_id,content_sha256,exact_excerpt,independence_key,captured_at,rights_checked_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [actor.tenantId, eventId, watch.watchId, watch.watchSourceId, ref.evidenceId, ref.contentSha256, excerpt,
          watch.normalizedDomain, ref.capturedAt, now.toISOString()]);
        const provenance = { observationKind: 'account_xray_metric_delta', accountId, auditId: report.auditId,
          priorAuditId: baselineRows.rows[0].id, metric, priorValue: before, currentValue: after,
          // The schema's source_id columns identify the immutable watched
          // source because their composite FK binds them to radar_watches.
          // Evidence remains attached by its own evidence/hash FK and is
          // separately identified here; this does not transfer the watch's
          // rights grant to the recaptured evidence.
          sourceId: watch.watchSourceId, watchedSourceId: watch.watchSourceId, watchedSourceUrl: watch.watchSourceUrl,
          evidenceSourceId: watch.evidenceSourceId, sourceUrl: ref.sourceUrl, normalizedDomain: watch.normalizedDomain,
          evidenceId: ref.evidenceId, contentSha256: ref.contentSha256, capturedAt: ref.capturedAt,
          watchedBaselineEvidenceId: baselinePage.evidenceId, watchedBaselineContentSha256: baselinePage.contentSha256,
          watchedSourceRightsCheckedAt: now.toISOString(), evidenceSourceRightsCheckedAt: now.toISOString(),
          exactExcerpt: excerpt, eventFingerprint,
          sourceContentUntrusted: true, instructionAuthority: 'none' };
        const inserted = await db.query(`INSERT INTO astra.radar_signals(tenant_id,id,watch_id,source_id,evidence_id,content_sha256,semantic_sha256,event_id,signal_type,title,exact_excerpt,provenance,observed_at,expires_at)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,'semantic_change',$9,$10,$11::jsonb,$12,$13
          WHERE NOT EXISTS (SELECT 1 FROM astra.radar_signals old WHERE old.tenant_id=$1 AND old.event_id=$8
            AND old.watch_id=$3 AND old.evidence_id=$5 AND old.provenance->>'auditId'=$14 AND old.provenance->>'metric'=$15)
          RETURNING id`, [actor.tenantId, randomUUID(), watch.watchId, watch.watchSourceId, ref.evidenceId, ref.contentSha256,
          semanticSha256, eventId, title, excerpt, JSON.stringify(provenance), now.toISOString(), expiresAt, report.auditId, metric]);
        created += inserted.rowCount || 0;
      }
    }
  }
  return { created, expiresAt, source: 'existing_radar_signal_stream' };
}

function requiredText(value, field, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new AstraRadarError(`${field} must be 1–${max} characters.`);
  return value.trim();
}
function iso(value) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function semanticText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/[\p{Z}\s]+/gu, ' ').trim();
}
function sentences(value) {
  return String(value || '').split(/(?<=[.!?\n])\s+|\n+/).map(x => x.trim()).filter(x => x.length >= 24);
}
function userId(actor) {
  const id = String(actor?.userId ?? '');
  if (!/^[1-9][0-9]{0,39}$/.test(id)) throw new AstraRadarError('A verified tenant actor is required.', 403, 'actor_required');
  return id;
}
function assertTenant(actor) {
  if (!actor?.tenantId) throw new AstraRadarError('A verified tenant context is required.', 403, 'tenant_context_required');
  return userId(actor);
}
function sourceAvailable(source, now = new Date()) {
  return Boolean(source && source.robots_allowed && source.rights_attested
    && ['synthetic_fixture','user_provided','licensed','public_terms_permitted'].includes(source.rights_policy)
    && (!source.rights_expires_at || new Date(source.rights_expires_at).valueOf() > now.valueOf()));
}
function validCadence(value, fallback) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 60 || n > 10080) throw new AstraRadarError('Cadence must be 60–10080 minutes.');
  return n;
}
function boundedLimit(value, fallback = 50) { const n = Number(value); return Number.isInteger(n) ? Math.max(1, Math.min(100, n)) : fallback; }

export function createAstraRadarManager(db, { now = () => new Date() } = {}) {
  if (!db || typeof db.query !== 'function') throw new TypeError('A tenant-scoped database client is required.');

  async function sourceById(tenantId, sourceId) {
    const r = await db.query(`SELECT id,source_url,normalized_domain,rights_policy,rights_expires_at,robots_allowed,rights_attested
      FROM astra.research_sources WHERE tenant_id=$1 AND id=$2`, [tenantId, sourceId]);
    return r.rows[0] || null;
  }
  async function latestEvidence(tenantId, sourceId) {
    const r = await db.query(`SELECT e.id,e.content_sha256 AS "contentSha256",e.captured_at AS "capturedAt",
      e.extracted_text AS "extractedText",e.document_title AS "documentTitle",e.source_content_untrusted AS "sourceContentUntrusted",
      s.source_url AS "sourceUrl",s.normalized_domain AS "normalizedDomain",s.rights_policy AS "rightsPolicy",
      s.rights_expires_at AS "rightsExpiresAt",s.robots_allowed AS "robotsAllowed",s.rights_attested AS "rightsAttested"
      FROM astra.research_evidence e JOIN astra.research_sources s ON (s.tenant_id,s.id)=(e.tenant_id,e.source_id)
      WHERE e.tenant_id=$1 AND e.source_id=$2 ORDER BY e.captured_at DESC,e.id DESC LIMIT 1`, [tenantId, sourceId]);
    return r.rows[0] || null;
  }
  async function currentRights(tenantId, sourceId, source, at = now()) {
    const persisted=(await readAstraSourceRights(db,tenantId,[sourceId])).get(String(sourceId).toLowerCase());
    return { ...(persisted || {status:'unavailable',usable:false}), usable:Boolean(persisted?.usable&&sourceAvailable(source,at)) };
  }
  async function logWatchEvent(tenantId, watchId, eventType, actor, { state = null, evidence = null, provenance = {} } = {}) {
    await db.query(`INSERT INTO astra.radar_watch_events
      (tenant_id,id,watch_id,event_type,observation_state,evidence_id,content_sha256,semantic_sha256,provenance,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`, [tenantId, randomUUID(), watchId, eventType, state,
      evidence?.id ?? null, evidence?.contentSha256 ?? null, evidence?.semanticSha256 ?? null, JSON.stringify(provenance), userId(actor)]);
  }

  async function createWatch(actor, input) {
    const createdBy = assertTenant(actor), sourceId = requiredText(input?.sourceId, 'sourceId', 36);
    const source = await sourceById(actor.tenantId, sourceId);
    if (!source) throw new AstraRadarError('Permitted research source was not found.', 404, 'source_not_found');
    const rights=await currentRights(actor.tenantId,sourceId,source);
    if (!rights.usable) throw new AstraRadarError('Source rights and robots permission must remain valid to create a watch.', 403, 'source_rights_required');
    const evidence = await latestEvidence(actor.tenantId, sourceId);
    const semanticSha256 = evidence ? hash(semanticText(evidence.extractedText)) : null;
    const min = validCadence(input.minCadenceMinutes, 360), max = validCadence(input.maxCadenceMinutes, 10080);
    const cadence = validCadence(input.cadenceMinutes, 1440);
    if (min > cadence || cadence > max) throw new AstraRadarError('Cadence must be between the configured minimum and maximum.');
    const budget = input.maxObservationsPerDay == null ? 24 : Number(input.maxObservationsPerDay);
    if (!Number.isInteger(budget) || budget < 1 || budget > 48) throw new AstraRadarError('maxObservationsPerDay must be 1–48.');
    const id = randomUUID();
    const saved = await db.query(`INSERT INTO astra.radar_watches
      (tenant_id,id,source_id,baseline_evidence_id,baseline_sha256,baseline_semantic_sha256,cadence_minutes,min_cadence_minutes,max_cadence_minutes,max_observations_per_day,next_due_at,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id,source_id AS "sourceId",baseline_evidence_id AS "baselineEvidenceId",baseline_sha256 AS "baselineSha256",
      baseline_semantic_sha256 AS "baselineSemanticSha256",cadence_minutes AS "cadenceMinutes",min_cadence_minutes AS "minCadenceMinutes",
      max_cadence_minutes AS "maxCadenceMinutes",max_observations_per_day AS "maxObservationsPerDay",status,next_due_at AS "nextDueAt",created_at AS "createdAt"`,
    [actor.tenantId, id, sourceId, evidence?.id ?? null, evidence?.contentSha256 ?? null, semanticSha256,
      cadence, min, max, budget, now().toISOString(), createdBy]);
    await logWatchEvent(actor.tenantId, id, 'created', actor, { evidence: evidence && { id: evidence.id, contentSha256: evidence.contentSha256, semanticSha256 },
      provenance: { sourceId, sourceUrl: source.source_url, rightsPolicy: source.rights_policy, sourceContentUntrusted: true, workerMode: 'stored_snapshot_only' } });
    return { ...saved.rows[0], sourceUrl: source.source_url, sourceContentUntrusted: true };
  }

  async function listWatches(actor, { limit = 50 } = {}) {
    assertTenant(actor);
    const r = await db.query(`SELECT w.id,w.source_id AS "sourceId",s.source_url AS "sourceUrl",s.normalized_domain AS "normalizedDomain",
      s.rights_policy AS "rightsPolicy",s.rights_expires_at AS "rightsExpiresAt",s.robots_allowed AS "robotsAllowed",s.rights_attested AS "rightsAttested",
      w.baseline_evidence_id AS "baselineEvidenceId",w.baseline_sha256 AS "baselineSha256",w.baseline_semantic_sha256 AS "baselineSemanticSha256",
      w.cadence_minutes AS "cadenceMinutes",w.min_cadence_minutes AS "minCadenceMinutes",w.max_cadence_minutes AS "maxCadenceMinutes",
      w.max_observations_per_day AS "maxObservationsPerDay",w.status,w.next_due_at AS "nextDueAt",w.last_observed_at AS "lastObservedAt",
      w.last_observation_state AS "lastObservationState",w.created_at AS "createdAt"
      FROM astra.radar_watches w JOIN astra.research_sources s ON (s.tenant_id,s.id)=(w.tenant_id,w.source_id)
      WHERE w.tenant_id=$1 ORDER BY w.created_at DESC LIMIT $2`, [actor.tenantId, boundedLimit(limit)]);
    const at = now();
    const rights=await readAstraSourceRights(db,actor.tenantId,r.rows.map(row=>row.sourceId));
    return r.rows.map(row => { const current=rights.get(String(row.sourceId).toLowerCase()); return ({ ...row,
      rightsValid: Boolean(current?.usable&&sourceAvailable({ rights_policy: row.rightsPolicy, rights_expires_at: row.rightsExpiresAt,
        robots_allowed: row.robotsAllowed, rights_attested: row.rightsAttested }, at)),sourceRightsStatus:current?.status||'unavailable',
      rightsRevokedAt:current?.revokedAt||null,rightsRevocationEventId:current?.revocationEventId||null,
      rightsRevocationReason:current?.reason||null,sourceContentUntrusted: true }); });
  }

  async function setWatchState(actor, watchId, action) {
    const changedBy = assertTenant(actor);
    if (!['pause','resume'].includes(action)) throw new AstraRadarError('Watch action must be pause or resume.');
    const current = await db.query(`SELECT w.id,w.status,w.source_id AS "sourceId",s.source_url AS "sourceUrl",s.rights_policy AS "rightsPolicy",
      s.rights_expires_at AS "rightsExpiresAt",s.robots_allowed AS "robotsAllowed",s.rights_attested AS "rightsAttested"
      FROM astra.radar_watches w JOIN astra.research_sources s ON (s.tenant_id,s.id)=(w.tenant_id,w.source_id)
      WHERE w.tenant_id=$1 AND w.id=$2 FOR UPDATE OF w`, [actor.tenantId, watchId]);
    const watch = current.rows[0]; if (!watch) throw new AstraRadarError('Radar watch was not found.', 404, 'watch_not_found');
    const rights=await currentRights(actor.tenantId,watch.sourceId,{ rights_policy: watch.rightsPolicy, rights_expires_at: watch.rightsExpiresAt,
      robots_allowed: watch.robotsAllowed, rights_attested: watch.rightsAttested });
    if (action === 'resume' && !rights.usable) throw new AstraRadarError('Source rights and robots permission are no longer valid.', 403, 'source_rights_required');
    const status = action === 'pause' ? 'paused' : 'active';
    await db.query(`UPDATE astra.radar_watches SET status=$3,updated_at=$4,next_due_at=CASE WHEN $3='active' THEN $4 ELSE next_due_at END
      WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, watchId, status, now().toISOString()]);
    await logWatchEvent(actor.tenantId, watchId, action === 'pause' ? 'paused' : 'resumed', actor,
      { provenance: { sourceId: watch.sourceId, sourceUrl: watch.sourceUrl, changedBy, sourceContentUntrusted: true } });
    return { id: watchId, status };
  }

  async function requestRefresh(actor, watchId) {
    assertTenant(actor);
    const r = await db.query(`SELECT w.id,w.status,w.source_id AS "sourceId",s.source_url AS "sourceUrl",s.rights_policy AS "rightsPolicy",
      s.rights_expires_at AS "rightsExpiresAt",s.robots_allowed AS "robotsAllowed",s.rights_attested AS "rightsAttested"
      FROM astra.radar_watches w JOIN astra.research_sources s ON (s.tenant_id,s.id)=(w.tenant_id,w.source_id)
      WHERE w.tenant_id=$1 AND w.id=$2 FOR UPDATE OF w`, [actor.tenantId, watchId]);
    const watch = r.rows[0]; if (!watch) throw new AstraRadarError('Radar watch was not found.', 404, 'watch_not_found');
    if (watch.status !== 'active') throw new AstraRadarError('Paused watches cannot be refreshed.', 409, 'watch_paused');
    if (!(await currentRights(actor.tenantId,watch.sourceId,{ rights_policy: watch.rightsPolicy, rights_expires_at: watch.rightsExpiresAt,
      robots_allowed: watch.robotsAllowed, rights_attested: watch.rightsAttested })).usable) throw new AstraRadarError('Source rights and robots permission are no longer valid.', 403, 'source_rights_required');
    await db.query('UPDATE astra.radar_watches SET next_due_at=$3,updated_at=$3 WHERE tenant_id=$1 AND id=$2', [actor.tenantId, watchId, now().toISOString()]);
    await logWatchEvent(actor.tenantId, watchId, 'refresh_requested', actor, { provenance: { sourceId: watch.sourceId, sourceUrl: watch.sourceUrl,
      executionMode: 'explicit_one_shot_worker', networkFetch: false, sourceContentUntrusted: true } });
    return { watchId, queued: true, execution: 'explicit_one_shot_worker', networkFetch: false };
  }

  async function runOnce(actor, { watchId = null } = {}) {
    const by = assertTenant(actor), at = now(), tenantId = actor.tenantId;
    const found = await db.query(`SELECT w.id,w.source_id AS "sourceId",w.baseline_evidence_id AS "baselineEvidenceId",
      w.baseline_sha256 AS "baselineSha256",w.baseline_semantic_sha256 AS "baselineSemanticSha256",w.cadence_minutes AS "cadenceMinutes",
      w.min_cadence_minutes AS "minCadenceMinutes",w.max_cadence_minutes AS "maxCadenceMinutes",w.max_observations_per_day AS "maxObservationsPerDay",
      w.status,s.source_url AS "sourceUrl",s.normalized_domain AS "normalizedDomain",s.rights_policy AS "rightsPolicy",s.rights_expires_at AS "rightsExpiresAt",
      s.robots_allowed AS "robotsAllowed",s.rights_attested AS "rightsAttested"
      FROM astra.radar_watches w JOIN astra.research_sources s ON (s.tenant_id,s.id)=(w.tenant_id,w.source_id)
      WHERE w.tenant_id=$1 AND w.status='active' AND w.next_due_at<=$2 AND ($3::uuid IS NULL OR w.id=$3)
      ORDER BY w.next_due_at,w.id FOR UPDATE OF w SKIP LOCKED`, [tenantId, at.toISOString(), watchId]);
    const results = [];
    for (const watch of found.rows) {
      const rights = { rights_policy: watch.rightsPolicy, rights_expires_at: watch.rightsExpiresAt,
        robots_allowed: watch.robotsAllowed, rights_attested: watch.rightsAttested };
      const persistedWatchRights=await currentRights(tenantId,watch.sourceId,rights,at);
      if (!persistedWatchRights.usable) {
        if (persistedWatchRights.status === 'revoked') {
          // R16's persisted observation enums predate revocation. Pause the
          // watch without fabricating an expiry observation. The generic
          // policy_blocked event has a nullable observation_state and retains
          // the durable source-rights reason and revocation identity.
          await db.query(`UPDATE astra.radar_watches SET status='paused',updated_at=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, watch.id, at.toISOString()]);
          await logWatchEvent(tenantId, watch.id, 'policy_blocked', actor, { provenance: { sourceId: watch.sourceId,
            reason: 'rights_revoked', revocationEventId: persistedWatchRights.revocationEventId,
            revokedAt: persistedWatchRights.revokedAt, policyCheckedAt: at.toISOString(), sourceContentUntrusted: true } });
          results.push({ watchId: watch.id, state: 'rights_revoked', paused: true,
            revokedAt: persistedWatchRights.revokedAt, revocationEventId: persistedWatchRights.revocationEventId });
        } else {
          await db.query(`UPDATE astra.radar_watches SET last_observed_at=$3,last_observation_state='rights_expired',status='paused',updated_at=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, watch.id, at.toISOString()]);
          await logWatchEvent(tenantId, watch.id, 'policy_blocked', actor, { state: 'rights_expired', provenance: { sourceId: watch.sourceId,
            sourceUrl: watch.sourceUrl, policyCheckedAt: at.toISOString(), sourceContentUntrusted: true } });
          results.push({ watchId: watch.id, state: 'rights_expired', paused: true });
        }
        continue;
      }
      const daily = await db.query(`SELECT count(*)::int AS count FROM astra.radar_watch_events WHERE tenant_id=$1 AND watch_id=$2
        AND event_type='observed' AND created_at >= date_trunc('day',$3::timestamptz)`, [tenantId, watch.id, at.toISOString()]);
      if (daily.rows[0].count >= watch.maxObservationsPerDay) {
        await db.query(`UPDATE astra.radar_watches SET next_due_at=date_trunc('day',$3::timestamptz)+interval '1 day',updated_at=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, watch.id, at.toISOString()]);
        results.push({ watchId: watch.id, state: 'budget_exhausted' }); continue;
      }
      const latest = await latestEvidence(tenantId, watch.sourceId);
      if (!latest) {
        await db.query(`UPDATE astra.radar_watches SET next_due_at=$3 + (cadence_minutes || ' minutes')::interval,updated_at=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, watch.id, at.toISOString()]);
        results.push({ watchId: watch.id, state: 'no_snapshot' }); continue;
      }
      // Recheck source rights immediately before consuming the snapshot.
      const evidenceRights=await currentRights(tenantId,watch.sourceId,{ rights_policy: latest.rightsPolicy, rights_expires_at: latest.rightsExpiresAt,
        robots_allowed: latest.robotsAllowed, rights_attested: latest.rightsAttested },at);
      if (!evidenceRights.usable) {
        if (evidenceRights.status === 'revoked') {
          await db.query(`UPDATE astra.radar_watches SET status='paused',updated_at=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, watch.id, at.toISOString()]);
          await logWatchEvent(tenantId, watch.id, 'policy_blocked', actor, { provenance: { sourceId: watch.sourceId,
            reason: 'rights_revoked', revocationEventId: evidenceRights.revocationEventId,
            revokedAt: evidenceRights.revokedAt, policyCheckedAt: at.toISOString(), sourceContentUntrusted: true } });
          results.push({ watchId: watch.id, state: 'rights_revoked', paused: true,
            revokedAt: evidenceRights.revokedAt, revocationEventId: evidenceRights.revocationEventId });
        } else {
          await db.query(`UPDATE astra.radar_watches SET last_observed_at=$3,last_observation_state='rights_expired',status='paused',updated_at=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, watch.id, at.toISOString()]);
          results.push({ watchId: watch.id, state: 'rights_expired', paused: true });
        }
        continue;
      }
      if (latest.id === watch.baselineEvidenceId || latest.contentSha256 === watch.baselineSha256) {
        await db.query(`UPDATE astra.radar_watches SET cadence_minutes=LEAST(max_cadence_minutes,cadence_minutes*2),
          last_observed_at=$3,last_observation_state='no_change',next_due_at=$3 + (LEAST(max_cadence_minutes,cadence_minutes*2) || ' minutes')::interval,updated_at=$3
          WHERE tenant_id=$1 AND id=$2`, [tenantId, watch.id, at.toISOString()]);
        await logWatchEvent(tenantId, watch.id, 'observed', actor, { state: 'no_change', evidence: { id: latest.id, contentSha256: latest.contentSha256 },
          provenance: { sourceId: watch.sourceId, sourceUrl: watch.sourceUrl, evidenceId: latest.id, contentSha256: latest.contentSha256,
            evidenceSourceId: watch.sourceId, capturedAt: iso(latest.capturedAt), rightsCheckedAt: at.toISOString(), semanticDiff: 'none', workerMode: 'stored_snapshot_only', sourceContentUntrusted: true } });
        results.push({ watchId: watch.id, state: 'no_change' }); continue;
      }
      const semantic = semanticText(latest.extractedText), semanticSha256 = hash(semantic);
      const rawChanged = latest.contentSha256 !== watch.baselineSha256;
      const state = semanticSha256 === watch.baselineSemanticSha256 ? 'cosmetic_change' : 'semantic_change';
      let priorText = '';
      if (watch.baselineEvidenceId) {
        const prior = await db.query('SELECT extracted_text FROM astra.research_evidence WHERE tenant_id=$1 AND id=$2', [tenantId, watch.baselineEvidenceId]);
        priorText = prior.rows[0]?.extracted_text || '';
      }
      const nextCadence = state === 'semantic_change' ? watch.minCadenceMinutes : Math.min(watch.maxCadenceMinutes, watch.cadenceMinutes * 2);
      await db.query(`UPDATE astra.radar_watches SET baseline_evidence_id=$3,baseline_sha256=$4,baseline_semantic_sha256=$5,
        cadence_minutes=$6,last_observed_at=$7,last_observation_state=$8,next_due_at=$7 + ($6 || ' minutes')::interval,updated_at=$7
        WHERE tenant_id=$1 AND id=$2`, [tenantId, watch.id, latest.id, latest.contentSha256, semanticSha256, nextCadence, at.toISOString(), state]);
      await logWatchEvent(tenantId, watch.id, 'observed', actor, { state, evidence: { id: latest.id, contentSha256: latest.contentSha256, semanticSha256 },
        provenance: { sourceId: watch.sourceId, sourceUrl: watch.sourceUrl, priorEvidenceId: watch.baselineEvidenceId,
          priorContentSha256: watch.baselineSha256, priorSemanticSha256: watch.baselineSemanticSha256, evidenceId: latest.id,evidenceSourceId:watch.sourceId,
          contentSha256: latest.contentSha256, semanticSha256, capturedAt: iso(latest.capturedAt), rightsPolicy: latest.rightsPolicy,
          rightsCheckedAt: at.toISOString(), rawContentChanged: rawChanged, semanticDiff: state, workerMode: 'stored_snapshot_only',
          sourceContentUntrusted: true } });
      if (state === 'semantic_change') {
        const oldSentences = new Set(sentences(priorText).map(semanticText));
        const newSentences = sentences(latest.extractedText);
        const excerpt = (newSentences.find(s => !oldSentences.has(semanticText(s))) || newSentences.at(-1) || latest.extractedText).slice(0, MAX_EXCERPT);
        const normalizedExcerpt = semanticText(excerpt);
        const eventFingerprint = hash(normalizedExcerpt);
        const eventSemanticHash = hash(normalizedExcerpt);
        const eventUpsert = await db.query(`INSERT INTO astra.radar_events(tenant_id,id,event_fingerprint,semantic_sha256,normalized_summary,expires_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,event_fingerprint) DO NOTHING RETURNING id,event_fingerprint`,
        [tenantId, randomUUID(), eventFingerprint, eventSemanticHash, excerpt, new Date(at.valueOf() + SIGNAL_TTL_DAYS * 86400000).toISOString()]);
        let eventId = eventUpsert.rows[0]?.id;
        if (!eventId) eventId = (await db.query('SELECT id FROM astra.radar_events WHERE tenant_id=$1 AND event_fingerprint=$2', [tenantId, eventFingerprint])).rows[0].id;
        await db.query(`INSERT INTO astra.radar_event_sources(tenant_id,event_id,watch_id,source_id,evidence_id,content_sha256,exact_excerpt,independence_key,captured_at,rights_checked_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`, [tenantId, eventId, watch.id, watch.sourceId, latest.id,
          latest.contentSha256, excerpt, watch.normalizedDomain, iso(latest.capturedAt), at.toISOString()]);
        const provenance = { sourceId: watch.sourceId, sourceUrl: watch.sourceUrl, normalizedDomain: watch.normalizedDomain,
          evidenceId: latest.id, contentSha256: latest.contentSha256, semanticSha256, eventFingerprint, eventId,
          capturedAt: iso(latest.capturedAt), rightsCheckedAt: at.toISOString(), exactExcerpt: excerpt,
          sourceContentUntrusted: true, sourceTextMayContainInstructions: true, instructionAuthority: 'none' };
        await db.query(`INSERT INTO astra.radar_signals(tenant_id,id,watch_id,source_id,evidence_id,content_sha256,semantic_sha256,event_id,signal_type,title,exact_excerpt,provenance,observed_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'semantic_change',$9,$10,$11::jsonb,$12,$13)`, [tenantId, randomUUID(), watch.id,
          watch.sourceId, latest.id, latest.contentSha256, semanticSha256, eventId, latest.documentTitle || '', excerpt,
          JSON.stringify(provenance), at.toISOString(), new Date(at.valueOf() + SIGNAL_TTL_DAYS * 86400000).toISOString()]);
      }
      results.push({ watchId: watch.id, state, signalCreated: state === 'semantic_change' });
    }
    return { tenantId, runAt: at.toISOString(), checked: results.length, results, worker: 'explicit_one_shot', externalFetches: 0 };
  }

  async function recordSourceObservation(actor, watchId, input) {
    assertTenant(actor);
    const state = input?.state;
    if (!['source_outage','deleted'].includes(state)) throw new AstraRadarError('Observation state must be source_outage or deleted.');
    const explanation = requiredText(input?.note, 'note', 500);
    const watchResult = await db.query(`SELECT w.id,w.source_id AS "sourceId",w.baseline_evidence_id AS "evidenceId",w.baseline_sha256 AS "contentSha256",
      s.source_url AS "sourceUrl",s.normalized_domain AS "normalizedDomain",s.rights_policy AS "rightsPolicy",s.rights_expires_at AS "rightsExpiresAt",
      s.robots_allowed AS "robotsAllowed",s.rights_attested AS "rightsAttested" FROM astra.radar_watches w JOIN astra.research_sources s
      ON (s.tenant_id,s.id)=(w.tenant_id,w.source_id) WHERE w.tenant_id=$1 AND w.id=$2 FOR UPDATE OF w`, [actor.tenantId, watchId]);
    const w = watchResult.rows[0]; if (!w) throw new AstraRadarError('Radar watch was not found.', 404, 'watch_not_found');
    if (!(await currentRights(actor.tenantId,w.sourceId,{ rights_policy: w.rightsPolicy, rights_expires_at: w.rightsExpiresAt, robots_allowed: w.robotsAllowed, rights_attested: w.rightsAttested })).usable) {
      throw new AstraRadarError('Source rights and robots permission are no longer valid.', 403, 'source_rights_required');
    }
    const evidence = w.evidenceId ? await db.query(`SELECT e.id,e.content_sha256 AS "contentSha256",e.document_title AS "documentTitle",
      e.extracted_text AS "extractedText",e.captured_at AS "capturedAt" FROM astra.research_evidence e
      WHERE e.tenant_id=$1 AND e.id=$2`, [actor.tenantId, w.evidenceId]) : { rows: [] };
    const e = evidence.rows[0]; if (!e) throw new AstraRadarError('An existing stored evidence snapshot is required to retain observation provenance.', 409, 'evidence_required');
    const at = now(), excerpt = e.extractedText.slice(0, MAX_EXCERPT) || w.sourceUrl;
    await db.query(`UPDATE astra.radar_watches SET last_observed_at=$3,last_observation_state=$4,next_due_at=$3 + (cadence_minutes || ' minutes')::interval,
      updated_at=$3 WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, watchId, at.toISOString(), state]);
    await logWatchEvent(actor.tenantId, watchId, state, actor, { state, evidence: { id: e.id, contentSha256: e.contentSha256 },
      provenance: { observationKind: 'operator_supplied', note: explanation, sourceUrl: w.sourceUrl, sourceId: w.sourceId,
        evidenceId: e.id,evidenceSourceId:w.sourceId, contentSha256: e.contentSha256, capturedAt: iso(e.capturedAt), observedAt: at.toISOString(),
        rightsCheckedAt: at.toISOString(), sourceContentUntrusted: true, notIndependentlyVerified: true } });
    const provenance = { observationKind: 'operator_supplied', note: explanation, sourceUrl: w.sourceUrl, sourceId: w.sourceId,
      normalizedDomain: w.normalizedDomain, evidenceId: e.id, contentSha256: e.contentSha256, capturedAt: iso(e.capturedAt),
      observedAt: at.toISOString(), rightsCheckedAt: at.toISOString(), exactExcerpt: excerpt, sourceContentUntrusted: true,
      notIndependentlyVerified: true, instructionAuthority: 'none' };
    await db.query(`INSERT INTO astra.radar_signals(tenant_id,id,watch_id,source_id,evidence_id,content_sha256,semantic_sha256,event_id,signal_type,title,exact_excerpt,provenance,observed_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11::jsonb,$12,$13)`, [actor.tenantId, randomUUID(), watchId, w.sourceId,
      e.id, e.contentSha256, hash(semanticText(e.extractedText)), state, e.documentTitle || '', excerpt, JSON.stringify(provenance), at.toISOString(),
      new Date(at.valueOf() + SIGNAL_TTL_DAYS * 86400000).toISOString()]);
    return { watchId, state, signalExpiresAt: new Date(at.valueOf() + SIGNAL_TTL_DAYS * 86400000).toISOString(), notIndependentlyVerified: true };
  }

  async function listSignals(actor, { limit = 50, includeExpired = false } = {}) {
    assertTenant(actor);
    const at = now();
    const rows = await db.query(`SELECT DISTINCT ON (COALESCE(sg.event_id,sg.id)) sg.id,sg.watch_id AS "watchId",sg.source_id AS "sourceId",s.source_url AS "sourceUrl",
      s.normalized_domain AS "normalizedDomain",s.rights_policy AS "rightsPolicy",s.rights_expires_at AS "rightsExpiresAt",
      s.robots_allowed AS "robotsAllowed",s.rights_attested AS "rightsAttested",sg.evidence_id AS "evidenceId",lineage.source_id AS "evidenceSourceId",sg.content_sha256 AS "contentSha256",
      sg.semantic_sha256 AS "semanticSha256",sg.event_id AS "eventId",ev.event_fingerprint AS "eventFingerprint",
      (SELECT count(DISTINCT es.independence_key)::int FROM astra.radar_event_sources es WHERE es.tenant_id=sg.tenant_id AND es.event_id=sg.event_id) AS "independentSourceCount",
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('sourceId',es.source_id,'watchId',es.watch_id,'evidenceId',es.evidence_id,
        'contentSha256',es.content_sha256,'exactExcerpt',es.exact_excerpt,'independenceKey',es.independence_key,
        'capturedAt',es.captured_at,'rightsCheckedAt',es.rights_checked_at) ORDER BY es.captured_at),'[]'::jsonb)
        FROM astra.radar_event_sources es WHERE es.tenant_id=sg.tenant_id AND es.event_id=sg.event_id) AS "sourceLineage",
      sg.signal_type AS "signalType",sg.title,sg.exact_excerpt AS "exactExcerpt",sg.provenance,sg.observed_at AS "observedAt",sg.expires_at AS "expiresAt",
      sg.source_content_untrusted AS "sourceContentUntrusted"
      FROM astra.radar_signals sg JOIN astra.research_sources s ON (s.tenant_id,s.id)=(sg.tenant_id,sg.source_id)
      LEFT JOIN astra.research_evidence lineage ON (lineage.tenant_id,lineage.id)=(sg.tenant_id,sg.evidence_id)
      LEFT JOIN astra.radar_events ev ON (ev.tenant_id,ev.id)=(sg.tenant_id,sg.event_id)
      WHERE sg.tenant_id=$1 AND ($2::boolean OR sg.expires_at>$3) ORDER BY COALESCE(sg.event_id,sg.id),sg.observed_at DESC,sg.id LIMIT $4`,
    [actor.tenantId, includeExpired === true, at.toISOString(), boundedLimit(limit)]);
    const rights=await readAstraSourceRights(db,actor.tenantId,rows.rows.flatMap(row=>[row.sourceId,row.evidenceSourceId,row.provenance?.evidenceSourceId].filter(Boolean)));
    return rows.rows.map(row => {
      const watched=rights.get(String(row.sourceId).toLowerCase());
      const evidenceSourceId=row.evidenceSourceId||null;
      const provenanceEvidenceSourceId=row.provenance?.evidenceSourceId||null;
      const evidenceSourceLineageMatches=Boolean(evidenceSourceId)
        &&(!provenanceEvidenceSourceId||String(provenanceEvidenceSourceId).toLowerCase()===String(evidenceSourceId).toLowerCase());
      const evidenceRights=evidenceSourceId?rights.get(String(evidenceSourceId).toLowerCase()):null;
      const sourceRightsStatus=watched?.status==='revoked'||evidenceRights?.status==='revoked'?'revoked'
        : !evidenceSourceLineageMatches||!watched||!evidenceRights?'unavailable'
          : watched.usable&&evidenceRights.usable?'permitted':watched.status==='expired'||evidenceRights.status==='expired'?'expired':'unavailable';
      return ({ ...row, evidenceSourceId,evidenceSourceLineageMatches,provenanceEvidenceSourceId,
      evidenceSourceRightsStatus:evidenceRights?.status||'unavailable',
      evidenceRightsRevokedAt:evidenceRights?.revokedAt||null,evidenceRightsRevocationEventId:evidenceRights?.revocationEventId||null,
      evidenceRightsRevocationReason:evidenceRights?.reason||null,watchedSourceRightsStatus:watched?.status||'unavailable',
      rightsRevokedAt:sourceRightsStatus==='revoked'?(evidenceRights?.status==='revoked'?evidenceRights.revokedAt:watched?.revokedAt)||null:null,
      rightsRevocationEventId:sourceRightsStatus==='revoked'?(evidenceRights?.status==='revoked'?evidenceRights.revocationEventId:watched?.revocationEventId)||null:null,
      rightsRevocationReason:sourceRightsStatus==='revoked'?(evidenceRights?.status==='revoked'?evidenceRights.reason:watched?.reason)||null:null,
      fresh: new Date(row.expiresAt).valueOf() > at.valueOf(),sourceRightsStatus,
      usable: new Date(row.expiresAt).valueOf() > at.valueOf() && evidenceSourceLineageMatches && sourceRightsStatus==='permitted' && sourceAvailable({ rights_policy: row.rightsPolicy,
        rights_expires_at: row.rightsExpiresAt, robots_allowed: row.robotsAllowed, rights_attested: row.rightsAttested }, at),
      sourceContentUntrusted: true, instructionAuthority: 'none' }); });
  }

  return Object.freeze({ createWatch, listWatches, setWatchState, requestRefresh, runOnce, recordSourceObservation, listSignals });
}

/** Explicit single-tenant execution. There is no scheduler or network fetch. */
export async function runAstraRadarOnce({ store, tenantId, userId, watchId = null }) {
  if (!store || typeof store.withWorkerTenant !== 'function') throw new AstraRadarError('Dedicated worker tenant store is unavailable.', 503, 'astra_worker_unavailable');
  return store.withWorkerTenant({ tenantId, userId }, async (db, context) => createAstraRadarManager(db).runOnce(context, { watchId }));
}
