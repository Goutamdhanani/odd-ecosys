import { createHash, randomBytes } from 'node:crypto';
import { getDb } from './database.js';

const MAX_TRACKED_LINKS_PER_MESSAGE = 50;
const MAX_LINK_LENGTH = 2048;

function configuredPublicOrigin() {
  const configured = process.env.APP_URL || process.env.ODD_PUBLIC_BASE_URL
    || (process.env.NODE_ENV === 'test' ? 'https://mail.test.invalid' : '');
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeDestination(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_LINK_LENGTH) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function tokenDigest(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** Replace only explicit HTTP(S) URLs in a send whose campaign opted in. */
export function rewriteTrackedMessageBody(sendId, messageBody) {
  const db = getDb();
  const id = Number(sendId);
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('A valid send is required for tracked links.');
  if (typeof messageBody !== 'string' || messageBody.length > 1_000_000) throw new TypeError('Message body is invalid or too large.');
  const send = db.prepare(`SELECT s.id,s.status,c.track_clicks
    FROM sends s JOIN campaigns c ON c.id=s.campaign_id WHERE s.id=?`).get(id);
  if (!send || send.status !== 'processing') throw new Error('Tracked links can only be prepared for the claimed send.');
  if (send.track_clicks !== 1) return { text: messageBody, trackedLinkCount: 0 };
  if (/<\/?[a-z][^>]*>/i.test(messageBody)) return { text: messageBody, trackedLinkCount: 0 };

  const origin = configuredPublicOrigin();
  if (!origin) {
    const error = new Error('Campaign click tracking needs a configured public HTTPS application URL.');
    error.code = 'CLICK_TRACKING_PUBLIC_URL_REQUIRED';
    error.smtpNotAccepted = true;
    throw error;
  }

  let trackedLinkCount = 0;
  const dbInsert = db.prepare(`INSERT INTO campaign_click_links(token_hash,send_id,target_url)
    VALUES(?,?,?)`);
  const replace = raw => {
    if (trackedLinkCount >= MAX_TRACKED_LINKS_PER_MESSAGE) return raw;
    const suffix = raw.match(/[),.!?;:\]]+$/)?.[0] || '';
    const candidate = suffix ? raw.slice(0, -suffix.length) : raw;
    const targetUrl = normalizeDestination(candidate);
    if (!targetUrl) return raw;
    let token;
    let digest;
    do {
      token = randomBytes(32).toString('base64url');
      digest = tokenDigest(token);
    } while (db.prepare('SELECT 1 FROM campaign_click_links WHERE token_hash=?').get(digest));
    dbInsert.run(digest, id, targetUrl);
    trackedLinkCount++;
    return `${origin}/t/${token}${suffix}`;
  };

  const text = db.transaction(() => messageBody.replace(/https?:\/\/[^\s<>"']+/gi, replace))();
  return { text, trackedLinkCount };
}

/**
 * Resolve a bearer capability through the stored target. Only the first link
 * request creates an analytics event; repeated scanner/browser requests remain
 * counted on the token row and can never claim a human click or delivery.
 */
export function resolveTrackedClickToken(token) {
  if (typeof token !== 'string' || token.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const db = getDb();
  const digest = tokenDigest(token);
  return db.transaction(() => {
    const link = db.prepare(`SELECT l.send_id,l.target_url,l.request_count,s.lead_id
      FROM campaign_click_links l JOIN sends s ON s.id=l.send_id WHERE l.token_hash=?`).get(digest);
    if (!link) return null;
    const targetUrl = normalizeDestination(link.target_url);
    if (!targetUrl || targetUrl !== link.target_url) return null;
    const firstRequest = Number(link.request_count) === 0;
    db.prepare(`UPDATE campaign_click_links SET request_count=request_count+1,
      first_requested_at=COALESCE(first_requested_at,datetime('now')) WHERE token_hash=?`).run(digest);
    if (firstRequest) {
      const targetHost = new URL(targetUrl).host;
      db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
        VALUES(?,?, 'tracked_link_requested',datetime('now'),?)`)
        .run(link.send_id, link.lead_id, JSON.stringify({ source: 'opaque_tracking_link', meaning: 'link_request_not_human_click', targetHost }));
    }
    return { targetUrl, sendId: Number(link.send_id), firstRequest, requestCount: Number(link.request_count) + 1 };
  }).immediate();
}

export function discardTrackedClickLinksForSend(sendId) {
  const id = Number(sendId);
  if (!Number.isSafeInteger(id) || id < 1) return 0;
  return getDb().prepare(`DELETE FROM campaign_click_links WHERE send_id=?
    AND request_count=0`).run(id).changes;
}
