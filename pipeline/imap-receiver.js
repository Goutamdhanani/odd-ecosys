import { ImapFlow } from 'imapflow';
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
