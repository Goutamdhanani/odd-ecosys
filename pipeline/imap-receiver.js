import { ImapFlow } from 'imapflow';
import { createHash } from 'node:crypto';
import PostalMime from 'postal-mime';
import { decryptCredential, hasActiveCredentialKey, isEncryptedCredential } from './credential-vault.js';
import { getDb } from './database.js';
import { ingestInboundReply } from './reply-tracker.js';

const MAX_SYNC_MESSAGES = 100;
const busyMailboxes = new Set();

export class ImapMailboxError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ImapMailboxError';
    this.statusCode = statusCode;
  }
}

function loadMailbox(db, mailboxValue) {
  const id = Number(mailboxValue);
  if (!Number.isSafeInteger(id) || id < 1) throw new ImapMailboxError('Mailbox id must be a positive integer.');
  const mailbox = db.prepare(`SELECT id,email,imap_host,imap_port,imap_user,imap_pass,imap_secure,
      imap_aliases_json,imap_uid_validity,imap_last_uid,imap_backfill_before_uid
    FROM mailboxes WHERE id=? AND active=1`).get(id);
  if (!mailbox) throw new ImapMailboxError('Mailbox was not found or is inactive.', 404);
  if (!mailbox.imap_host || !mailbox.imap_user || !mailbox.imap_pass) {
    throw new ImapMailboxError('Configure an IMAP host, username, and password before connecting.', 409);
  }
  const requireEncryption = process.env.NODE_ENV === 'production' || process.env.ODD_CREDENTIAL_ENFORCE_ENCRYPTION === 'true';
  if (requireEncryption && !isEncryptedCredential(mailbox.imap_pass) && !hasActiveCredentialKey()) {
    throw new ImapMailboxError('IMAP credentials require ODD_CREDENTIAL_ENCRYPTION_KEY in this environment.', 503);
  }
  const pass = decryptCredential(mailbox.imap_pass);
  if (!pass) throw new ImapMailboxError('IMAP password is empty.', 409);
  return { ...mailbox, imap_port: Number(mailbox.imap_port) || (mailbox.imap_secure ? 993 : 143), pass };
}

function createClientOptions(mailbox) {
  const implicitTls = Boolean(mailbox.imap_secure);
  return {
    host: mailbox.imap_host,
    port: mailbox.imap_port,
    secure: implicitTls,
    doSTARTTLS: !implicitTls,
    servername: mailbox.imap_host,
    tls: { rejectUnauthorized: true },
    auth: { user: mailbox.imap_user, pass: mailbox.pass },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableAutoIdle: true,
    maxResponseSize: 8 * 1024 * 1024,
  };
}

function safeConnectionFailure(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(error.code) ? ` (${error.code})` : '';
  return new ImapMailboxError(`IMAP connection failed${code}. Check the host, port, required TLS mode, certificate, and credentials.`, 502);
}

function parseLimit(value) {
  if (value === undefined || value === null || value === '') return 25;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYNC_MESSAGES) {
    throw new ImapMailboxError(`Message limit must be an integer from 1 to ${MAX_SYNC_MESSAGES}.`);
  }
  return limit;
}

function addressOf(addresses) {
  const address = Array.isArray(addresses) ? addresses.find(item => typeof item?.address === 'string')?.address : null;
  return typeof address === 'string' && address.length <= 320 && !/[\r\n\0]/.test(address) ? address.trim() : null;
}

function addressesOf(addresses) {
  if (!Array.isArray(addresses)) return [];
  return [...new Set(addresses.map(item => typeof item?.address === 'string' ? item.address.trim().toLowerCase() : '')
    .filter(address => address.length <= 320 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)))].slice(0, 20);
}

function exactRecipientKey(value) {
  const address = typeof value === 'string' ? value.trim() : '';
  const separator = address.lastIndexOf('@');
  if (separator < 1 || separator === address.length - 1) return null;
  return `${address.slice(0, separator)}@${address.slice(separator + 1).toLowerCase()}`;
}

function plainBody(parsed) {
  if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text;
  if (typeof parsed.html !== 'string') return '';
  return parsed.html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
}

function headerValues(parsed, name) {
  return Array.isArray(parsed?.headers)
    ? parsed.headers.filter(header => String(header?.key || '').toLowerCase() === name).map(header => String(header.value || ''))
    : [];
}

function reportMimeKind(parsed) {
  const contentTypes = headerValues(parsed, 'content-type');
  if (!contentTypes.some(value => /^\s*multipart\/report\s*(?:;|$)/i.test(value))) return 'not_report';
  if (contentTypes.length !== 1) return 'malformed';
  const parts = contentTypes[0].split(';').map(value => value.trim());
  if (parts.shift()?.toLowerCase() !== 'multipart/report') return 'malformed';
  const types = parts.filter(value => /^report-type\s*=/i.test(value));
  if (types.length !== 1) return 'malformed';
  const type = types[0].slice(types[0].indexOf('=') + 1).trim().replace(/^"|"$/g, '').toLowerCase();
  return type === 'delivery-status' ? 'delivery_status' : 'unsupported';
}

function parseDeliveryStatus(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content || '');
  if (!bytes.length || bytes.length > 256 * 1024) return null;
  const unfolded = bytes.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  if (/\0/.test(unfolded)) return null;
  const blocks = unfolded.trim().split(/\r?\n[ \t]*\r?\n/).map(block => {
    const fields = new Map();
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator < 1) return null;
      const name = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !value || /[\r\n\0]/.test(value)) return null;
      const values = fields.get(name) || [];
      values.push(value);
      fields.set(name, values);
    }
    return fields;
  });
  if (!blocks.length || blocks.some(block => block === null)) return null;
  const recipientBlocks = blocks.filter(block => block.has('final-recipient'));
  if (recipientBlocks.length !== 1) return null;
  const recipientBlock = recipientBlocks[0];
  const one = name => {
    const values = recipientBlock.get(name) || [];
    return values.length === 1 ? values[0] : null;
  };
  const recipientField = one('final-recipient');
  const recipientMatch = recipientField?.match(/^rfc822\s*;\s*(?:<([^<>\s]+)>|([^\s<>]+))$/i);
  const recipient = (recipientMatch?.[1] || recipientMatch?.[2] || '').trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient)) return null;
  const action = one('action')?.toLowerCase();
  const statusCode = one('status');
  const diagnosticValues = recipientBlock.get('diagnostic-code') || [];
  if (diagnosticValues.length > 1) return null;
  const actionClass = { delivered: '2', failed: '5', delayed: '4', relayed: '2', expanded: '2' }[action];
  if (!actionClass || !new RegExp(`^${actionClass}\\.\\d{1,3}\\.\\d{1,3}$`).test(statusCode || '')) return null;
  const diagnostic = (diagnosticValues[0] || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, 500);
  return { recipient, action, statusCode, diagnostic };
}

async function parseAttributedDeliveryReport(parsed) {
  const kind = reportMimeKind(parsed);
  if (kind === 'not_report') return { kind };
  if (kind !== 'delivery_status') return { kind: 'invalid' };
  const statusParts = (parsed.attachments || []).filter(part => part.mimeType === 'message/delivery-status');
  const originalParts = (parsed.attachments || []).filter(part => part.mimeType === 'message/rfc822');
  if (statusParts.length !== 1 || originalParts.length !== 1) return { kind: 'invalid' };
  const status = parseDeliveryStatus(statusParts[0].content);
  if (!status) return { kind: 'invalid' };
  try {
    const original = await PostalMime.parse(originalParts[0].content, {
      maxNestingDepth: 5,
      maxHeadersSize: 64 * 1024,
      maxPartCount: 50,
      maxRfc822NestingDepth: 1,
    });
    const ids = headerValues(original, 'message-id');
    if (ids.length !== 1 || !/^<[^<>\s\r\n]+>$/.test(ids[0].trim())) return { kind: 'invalid' };
    const senders = addressesOf(parsed.to).concat(addressesOf(parsed.cc));
    const reportSender = typeof parsed.from?.address === 'string' && parsed.from.address.length <= 320
      ? parsed.from.address.trim().toLowerCase() : null;
    return {
      kind: 'valid',
      ...status,
      smtpMessageId: ids[0].trim(),
      reportMessageId: (headerValues(parsed, 'message-id')[0] || '').trim() || null,
      reportSender,
      reportRecipients: [...new Set(senders)],
    };
  } catch {
    return { kind: 'invalid' };
  }
}

function persistDeliveryReport(db, mailbox, uidValidity, messageUid, report) {
  const mailboxAddresses = new Set([mailbox.email, ...(() => {
    try { const aliases = JSON.parse(mailbox.imap_aliases_json || '[]'); return Array.isArray(aliases) ? aliases : []; }
    catch { return []; }
  })()].map(address => String(address).trim().toLowerCase()));
  if (!report.reportRecipients.some(address => mailboxAddresses.has(address))) return 'unmatched';

  // Restrict the lookup to actual SMTP-accepted campaign sends recorded by the
  // assigned mailbox. Message-ID and recipient are exact persisted values.
  const events = db.prepare(`SELECT s.id AS send_id,e.meta_json FROM sends s
    JOIN events e ON e.send_id=s.id
    WHERE s.mailbox_id=? AND s.status='sent' AND e.event_type='sent'
      AND CASE WHEN json_valid(e.meta_json) THEN json_extract(e.meta_json,'$.messageId') ELSE NULL END=?`)
    .all(mailbox.id, report.smtpMessageId);
  const matches = new Map();
  for (const event of events) {
    let meta;
    try { meta = JSON.parse(event.meta_json || '{}'); } catch { continue; }
    if (meta.messageId !== report.smtpMessageId || meta.test_send === true
      || exactRecipientKey(meta.to) !== exactRecipientKey(report.recipient)) continue;
    matches.set(Number(event.send_id), true);
  }
  if (matches.size > 1) return 'ambiguous';
  if (matches.size !== 1) return 'unmatched';
  const sendId = matches.keys().next().value;
  const fingerprint = createHash('sha256').update(JSON.stringify([
    mailbox.id, report.smtpMessageId, report.recipient, report.action, report.statusCode, report.diagnostic,
  ])).digest('hex');
  const saved = db.prepare(`INSERT OR IGNORE INTO delivery_reports(
      send_id,mailbox_id,source_uid_validity,source_uid,smtp_message_id,report_message_id,
      report_sender,recipient,action,status_code,diagnostic,authentication_status,fingerprint
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'unverified',?)`)
    .run(sendId, mailbox.id, String(uidValidity), messageUid, report.smtpMessageId,
      report.reportMessageId, report.reportSender, report.recipient, report.action,
      report.statusCode, report.diagnostic, fingerprint);
  return saved.changes === 1 ? 'saved' : 'duplicate';
}

/**
 * Create an explicit IMAP connection and inbox intake service. Tests can inject
 * a real ImapFlow client with a private fixture CA; application routes use the
 * default client, which always verifies the server certificate.
 */
export function createImapReceiver({ db = getDb(), ingestReply = ingestInboundReply, createClient = options => new ImapFlow(options) } = {}) {
  async function connect(mailboxId) {
    const mailbox = loadMailbox(db, mailboxId);
    const client = createClient(createClientOptions(mailbox));
    try {
      await client.connect();
      return { mailbox, client };
    } catch (error) {
      try { client.close(); } catch { /* connection never completed */ }
      throw safeConnectionFailure(error);
    }
  }

  async function close(client) {
    try {
      if (client?.usable) await client.logout();
      else client?.close();
    } catch {
      try { client?.close(); } catch { /* already closed */ }
    }
  }

  async function withInbox(mailboxId, work) {
    let connection;
    try {
      connection = await connect(mailboxId);
      const lock = await connection.client.getMailboxLock('INBOX', { readOnly: true });
      try {
        return await work(connection.mailbox, connection.client);
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof ImapMailboxError) throw error;
      throw safeConnectionFailure(error);
    } finally {
      if (connection) await close(connection.client);
    }
  }

  async function testMailbox(mailboxId) {
    return withInbox(mailboxId, async (mailbox, client) => ({
      ok: true,
      mailboxId: mailbox.id,
      email: mailbox.email,
      folder: 'INBOX',
      messageCount: Number(client.mailbox?.exists) || 0,
      tlsVerified: true,
      tlsMode: mailbox.imap_secure ? 'implicit_tls' : 'starttls',
    }));
  }

  async function syncMailbox(mailboxId, { limit: limitValue, backfill: backfillValue = false } = {}) {
    const id = Number(mailboxId);
    if (busyMailboxes.has(id)) throw new ImapMailboxError('A sync for this mailbox is already running.', 409);
    const limit = parseLimit(limitValue);
    const backfill = backfillValue === true;
    busyMailboxes.add(id);
    try {
      return await withInbox(id, async (mailbox, client) => {
        const uidValidity = client.mailbox?.uidValidity;
        const currentValidity = uidValidity === undefined || uidValidity === null ? '' : String(uidValidity);
        const uidNext = Number(client.mailbox?.uidNext);
        if (!/^\d{1,20}$/.test(currentValidity) || !Number.isSafeInteger(uidNext) || uidNext < 1) {
          throw new ImapMailboxError('The IMAP server did not provide a usable UID cursor.', 502);
        }
        const highestUid = uidNext - 1;
        const matchingCursor = mailbox.imap_uid_validity === currentValidity;
        if (backfill && !matchingCursor) {
          throw new ImapMailboxError('Sync the Inbox once after connecting or a provider reindex before importing older messages.', 409);
        }
        let cursorUid = matchingCursor ? Number(mailbox.imap_last_uid) || 0 : 0;
        let backfillBeforeUid = matchingCursor ? Number(mailbox.imap_backfill_before_uid) || 0 : 0;
        let firstUid;
        let lastUid;
        if (backfill) {
          lastUid = backfillBeforeUid;
          firstUid = Math.max(1, lastUid - limit + 1);
        } else {
          firstUid = matchingCursor ? Math.max(1, cursorUid + 1) : Math.max(1, highestUid - limit + 1);
          lastUid = matchingCursor ? Math.min(highestUid, cursorUid + limit) : highestUid;
          if (!matchingCursor) {
            backfillBeforeUid = firstUid > 1 ? firstUid - 1 : 0;
            const initialCursor = db.prepare(`UPDATE mailboxes SET imap_uid_validity=?,imap_last_uid=?,
              imap_backfill_before_uid=? WHERE id=?`).run(currentValidity, firstUid - 1, backfillBeforeUid, mailbox.id);
            if (initialCursor.changes !== 1) throw new ImapMailboxError('The mailbox cursor could not be saved.', 503);
            cursorUid = firstUid - 1;
          }
        }
        const messages = lastUid >= firstUid ? await client.fetchAll(`${firstUid}:${lastUid}`, {
          uid: true,
          envelope: true,
          flags: true,
          source: true,
        }, { uid: true }) : [];
        messages.sort((a, b) => backfill ? Number(b.uid) - Number(a.uid) : Number(a.uid) - Number(b.uid));
        let imported = 0;
        let duplicates = 0;
        let skipped = 0;
        let deliveryReports = 0;
        let unverifiedDeliveryReports = 0;
        let deliveryReportDuplicates = 0;
        let ambiguousDeliveryReports = 0;
        for (const message of messages) {
          const messageUid = Number(message.uid);
          if (!Number.isSafeInteger(messageUid) || (backfill ? messageUid > backfillBeforeUid : messageUid <= cursorUid)) continue;
          let parsed = null;
          if (message.source) {
            try {
              parsed = await PostalMime.parse(message.source, {
                maxNestingDepth: 20,
                maxHeadersSize: 128 * 1024,
                maxPartCount: 300,
                maxRfc822NestingDepth: 2,
              });
            } catch {
              skipped++;
            }
          } else {
            skipped++;
          }
          if (parsed) {
            const report = await parseAttributedDeliveryReport(parsed);
            if (report.kind !== 'not_report') {
              if (report.kind === 'valid') {
                let outcome;
                try {
                  outcome = persistDeliveryReport(db, mailbox, currentValidity, messageUid, report);
                } catch {
                  throw new ImapMailboxError('A delivery report could not be saved. Sync again to safely resume from the previous message.', 503);
                }
                if (outcome === 'saved') {
                  deliveryReports++;
                  unverifiedDeliveryReports++;
                } else if (outcome === 'duplicate') {
                  duplicates++;
                  deliveryReportDuplicates++;
                } else {
                  if (outcome === 'ambiguous') ambiguousDeliveryReports++;
                  skipped++;
                }
              } else {
                skipped++;
              }
            } else {
              const fromEmail = parsed.from?.address || addressOf(message.envelope?.from);
              if (!fromEmail || !fromEmail.includes('@')) {
                skipped++;
              } else {
                let configuredAliases = [];
                try { configuredAliases = JSON.parse(mailbox.imap_aliases_json || '[]'); } catch { /* Ignore malformed legacy metadata. */ }
                const mailboxAddresses = new Set([mailbox.email, ...(Array.isArray(configuredAliases) ? configuredAliases : [])]
                  .map(address => String(address).trim().toLowerCase()));
                const recipientAddresses = [...new Set([...addressesOf(parsed.to), ...addressesOf(parsed.cc)])].slice(0, 20);
                const receivedTo = recipientAddresses.find(address => mailboxAddresses.has(address)) || mailbox.email;
              const messageId = parsed.messageId || message.envelope?.messageId
                || `imap-${mailbox.id}-${currentValidity}-${messageUid}@local.invalid`;
              let result;
              try {
                result = await ingestReply({
                  fromEmail,
                  toMailboxEmail: mailbox.email,
                  receivedTo,
                  recipientAddresses,
                  subject: parsed.subject || message.envelope?.subject || '',
                  body: plainBody(parsed),
                  messageId,
                  inReplyTo: parsed.inReplyTo || message.envelope?.inReplyTo || null,
                  references: parsed.references || null,
                  receivedAt: parsed.date || message.envelope?.date?.toISOString?.() || null,
                });
              } catch {
                throw new ImapMailboxError('A reply could not be saved. Sync again to safely resume from the previous message.', 503);
              }
              if (result?.duplicate) duplicates++;
              else imported++;
              }
            }
          }
          const cursorUpdate = backfill
            ? db.prepare('UPDATE mailboxes SET imap_backfill_before_uid=? WHERE id=?').run(messageUid - 1, mailbox.id)
            : db.prepare('UPDATE mailboxes SET imap_uid_validity=?,imap_last_uid=? WHERE id=?').run(currentValidity, messageUid, mailbox.id);
          if (cursorUpdate.changes !== 1) throw new ImapMailboxError('The mailbox cursor could not be saved.', 503);
          if (backfill) backfillBeforeUid = messageUid - 1;
          else cursorUid = messageUid;
        }
        if (backfill && !messages.length && backfillBeforeUid > 0) {
          backfillBeforeUid = Math.max(0, firstUid - 1);
          const cursorUpdate = db.prepare('UPDATE mailboxes SET imap_backfill_before_uid=? WHERE id=?').run(backfillBeforeUid, mailbox.id);
          if (cursorUpdate.changes !== 1) throw new ImapMailboxError('The mailbox cursor could not be saved.', 503);
        } else if (!backfill && !messages.length && highestUid > cursorUid) {
          const cursorUpdate = db.prepare('UPDATE mailboxes SET imap_uid_validity=?, imap_last_uid=? WHERE id=?')
            .run(currentValidity, highestUid, mailbox.id);
          if (cursorUpdate.changes !== 1) throw new ImapMailboxError('The mailbox cursor could not be saved.', 503);
          cursorUid = highestUid;
        }
        return {
          ok: true,
          mailboxId: mailbox.id,
          email: mailbox.email,
          folder: 'INBOX',
          fetched: messages.length,
          imported,
          duplicates,
          skipped,
          deliveryReports,
          unverifiedDeliveryReports,
          deliveryReportDuplicates,
          ambiguousDeliveryReports,
          limit,
          cursorUid,
          moreNewMessages: !backfill && cursorUid < highestUid,
          backfill,
          hasOlderMessages: backfillBeforeUid > 0,
          olderMessagesBeforeUid: backfillBeforeUid || null,
          uidValidityChanged: !matchingCursor && Boolean(mailbox.imap_uid_validity),
          initialBackfillTruncated: !matchingCursor && firstUid > 1,
          remoteReadStateChanged: false,
          tlsVerified: true,
        };
      });
    } finally {
      busyMailboxes.delete(id);
    }
  }

  return { testMailbox, syncMailbox };
}
