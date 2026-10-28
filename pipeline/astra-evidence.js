import { createHash, randomUUID } from 'node:crypto';
import { readAstraSourceRights } from './astra-source-rights.js';

export const ASTRA_RESEARCH_EXTRACTOR_VERSION = 'astra-html-text/1.0.0';
export const ASTRA_RESEARCH_MAX_SNAPSHOT_BYTES = 1024 * 1024;
const RIGHTS_POLICIES = new Set(['synthetic_fixture', 'user_provided', 'licensed', 'public_terms_permitted']);

export class AstraResearchError extends Error {
  constructor(message, statusCode = 400, code = 'research_invalid') {
    super(message); this.name = 'AstraResearchError'; this.statusCode = statusCode; this.code = code;
  }
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const text = (value, field, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new AstraResearchError(`${field} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
};

export function normalizeResearchDomain(input) {
  if (typeof input !== 'string') throw new AstraResearchError('sourceUrl must be a valid HTTP(S) URL.');
  let url;
  try { url = new URL(input.includes('://') ? input : `https://${input}`); } catch { throw new AstraResearchError('sourceUrl must be a valid HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AstraResearchError('sourceUrl must be a credential-free HTTP(S) URL.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new AstraResearchError('Private and local source hosts are not accepted.');
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) throw new AstraResearchError('A public DNS hostname is required for a source URL.');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/(token|key|auth|session|password|secret|signature|^sig$|^code$)/i.test(key)) url.searchParams.delete(key);
  return { url: url.toString(), domain: host };
}

/** Strip active markup and expose a plain text representation. Snapshot text remains untrusted evidence. */
export function extractResearchText(html) {
  const source = Buffer.isBuffer(html) ? html.toString('utf8') : String(html);
  const withoutActive = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript|svg|canvas|iframe|object|embed|form|input|button|select|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<(script|style|template|noscript|svg|canvas|iframe|object|embed|form|input|button|select|textarea)\b[^>]*\/?\s*>/gi, ' ');
  const title = (withoutActive.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '').replace(/<[^>]*>/g, ' ').trim();
  const headings = [...withoutActive.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)].map(m => m[1].replace(/<[^>]*>/g, ' ').trim()).filter(Boolean).slice(0, 20);
  const metaDescription = withoutActive.match(/<meta\b(?=[^>]*\bname\s*=\s*["']description["'])(?=[^>]*\bcontent\s*=\s*["']([^"']*)["'])[^>]*>/i)?.[1] || '';
  const plain = withoutActive.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[\t\f\v ]+/g, ' ').replace(/\r/g, '').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const emails = [...new Set((plain.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(x => x.toLowerCase()))].slice(0, 100);
  return { text: plain.slice(0, 250000), title: title.slice(0, 500), headings, metaDescription: metaDescription.slice(0, 2000), emails };
}

function normalizeSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AstraResearchError('Snapshot must be an object.');
  const { url: sourceUrl, domain } = normalizeResearchDomain(text(input.sourceUrl, 'sourceUrl', 2048));
  if (typeof input.rightsPolicy !== 'string' || !RIGHTS_POLICIES.has(input.rightsPolicy) || input.rightsAttested !== true || input.robotsAllowed !== true) {
    throw new AstraResearchError('Snapshot requires an explicit permitted rightsPolicy, rightsAttested=true, and robotsAllowed=true.', 403, 'source_rights_required');
  }
  const html = typeof input.html === 'string' ? Buffer.from(input.html, 'utf8') : Buffer.isBuffer(input.html) ? input.html : null;
  if (!html?.length) throw new AstraResearchError('html must contain a supplied snapshot.');
  if (html.length > ASTRA_RESEARCH_MAX_SNAPSHOT_BYTES) throw new AstraResearchError('Snapshot exceeds the 1 MiB limit.', 413, 'snapshot_too_large');
  const mediaType = input.mediaType === undefined ? 'text/html; charset=utf-8' : text(input.mediaType, 'mediaType', 120).toLowerCase();
  if (!mediaType.startsWith('text/html')) throw new AstraResearchError('Only supplied text/html snapshots are accepted.');
  let rightsExpiresAt = null;
  if (input.rightsExpiresAt != null) {
    const d = new Date(input.rightsExpiresAt);
    if (!Number.isFinite(d.valueOf()) || d.valueOf() <= Date.now()) throw new AstraResearchError('rightsExpiresAt must be a future ISO-compatible date.');
    rightsExpiresAt = d.toISOString();
  }
  return { sourceUrl, domain, rightsPolicy: input.rightsPolicy, rightsExpiresAt, html, mediaType };
}

export async function saveResearchSnapshot(db, actor, input) {
  const s = normalizeSnapshot(input), extracted = extractResearchText(s.html);
  const contentHash = sha256(s.html), evidenceId = randomUUID(), sourceId = randomUUID(), capturedAt = new Date().toISOString();
  const source = await db.query(`INSERT INTO astra.research_sources(tenant_id,id,source_url,normalized_domain,rights_policy,rights_expires_at,robots_allowed,rights_attested,created_by)
    VALUES($1,$2,$3,$4,$5,$6,true,true,$7) RETURNING id,rights_expires_at`,
  [actor.tenantId, sourceId, s.sourceUrl, s.domain, s.rightsPolicy, s.rightsExpiresAt, String(actor.userId)]);
  const actualSourceId = source.rows[0].id;
  await db.query(`INSERT INTO astra.research_blobs(tenant_id,sha256,content,byte_length,media_type) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,sha256) DO NOTHING`,
    [actor.tenantId, contentHash, s.html, s.html.length, s.mediaType]);
  const inserted = await db.query(`INSERT INTO astra.research_evidence(tenant_id,id,source_id,normalized_domain,content_sha256,captured_at,extractor_version,extracted_text,document_title,headings,meta_description,extracted_emails,coverage_status,source_content_untrusted)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,'single_page_snapshot',true)
    RETURNING id,captured_at,content_sha256,extractor_version,coverage_status`,
  [actor.tenantId, evidenceId, actualSourceId, s.domain, contentHash, capturedAt, ASTRA_RESEARCH_EXTRACTOR_VERSION, extracted.text, extracted.title, JSON.stringify(extracted.headings), extracted.metaDescription, JSON.stringify(extracted.emails)]);
  await db.query(`INSERT INTO astra.research_accounts(tenant_id,id,normalized_domain,display_domain)
    VALUES($1,gen_random_uuid(),$2,$2) ON CONFLICT(tenant_id,normalized_domain) DO NOTHING`, [actor.tenantId, s.domain]);
  const account = await db.query(`SELECT id,normalized_domain AS "normalizedDomain",display_domain AS "displayDomain" FROM astra.research_accounts WHERE tenant_id=$1 AND normalized_domain=$2`, [actor.tenantId, s.domain]);
  const accountId = account.rows[0].id;
  const candidateRows = [];
  for (const email of extracted.emails) {
    const r = await db.query(`INSERT INTO astra.research_identity_candidates(tenant_id,id,account_id,evidence_id,normalized_domain,candidate_type,normalized_value,display_value,exact_excerpt,verification_state)
      VALUES($1,gen_random_uuid(),$2,$3,$4,'email',$5,$5,$5,'unverified') ON CONFLICT(tenant_id,account_id,evidence_id,candidate_type,normalized_value) DO NOTHING
      RETURNING id,candidate_type AS "candidateType",display_value AS "displayValue",exact_excerpt AS "exactExcerpt",verification_state AS "verificationState"`, [actor.tenantId, accountId, evidenceId, s.domain, email]);
    candidateRows.push(...r.rows);
  }
  return { evidence: { ...inserted.rows[0], contentSha256: inserted.rows[0].content_sha256,
    sourceId: actualSourceId, sourceUrl: s.sourceUrl, normalizedDomain: s.domain, rightsPolicy: s.rightsPolicy,
    rightsExpiresAt: source.rows[0].rights_expires_at, byteLength: s.html.length, textLength: extracted.text.length, sourceContentUntrusted: true },
    account: account.rows[0], candidates: candidateRows };
}

export async function getResearchEvidence(db, tenantId, evidenceId) {
  const r = await db.query(`SELECT e.id,e.source_id AS "sourceId",s.source_url AS "sourceUrl",s.normalized_domain AS "normalizedDomain",s.rights_policy AS "rightsPolicy",s.rights_expires_at AS "rightsExpiresAt",s.robots_allowed AS "robotsAllowed",s.rights_attested AS "rightsAttested",e.content_sha256 AS "contentSha256",e.captured_at AS "capturedAt",e.extractor_version AS "extractorVersion",e.extracted_text AS "extractedText",e.document_title AS "documentTitle",e.headings,e.meta_description AS "metaDescription",e.extracted_emails AS "extractedEmails",e.coverage_status AS "coverageStatus",e.source_content_untrusted AS "sourceContentUntrusted",b.byte_length AS "byteLength",b.media_type AS "mediaType"
    FROM astra.research_evidence e JOIN astra.research_sources s ON (s.tenant_id,s.id)=(e.tenant_id,e.source_id)
    JOIN astra.research_blobs b ON (b.tenant_id,b.sha256)=(e.tenant_id,e.content_sha256)
    WHERE e.tenant_id=$1 AND e.id=$2`, [tenantId, evidenceId]);
  const evidence = r.rows[0];
  if (!evidence) return null;
  const sourceRights = (await readAstraSourceRights(db, tenantId, [evidence.sourceId])).get(String(evidence.sourceId).toLowerCase());
  return { ...evidence, sourceRightsStatus: sourceRights?.status || 'unavailable', sourceRightsUsable: sourceRights?.usable === true,
    rightsRevokedAt: sourceRights?.revokedAt || null, rightsRevocationEventId: sourceRights?.revocationEventId || null,
    rightsRevocationReason: sourceRights?.reason || null };
}

export async function getResearchBlob(db, tenantId, evidenceId) {
  const r = await db.query(`SELECT b.content,b.sha256,b.media_type,b.byte_length FROM astra.research_evidence e JOIN astra.research_blobs b ON (b.tenant_id,b.sha256)=(e.tenant_id,e.content_sha256) WHERE e.tenant_id=$1 AND e.id=$2`, [tenantId, evidenceId]);
  return r.rows[0] || null;
}

export const researchSha256 = sha256;
