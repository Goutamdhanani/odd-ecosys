// ============================================================
//  ODD-ECOSYS — HTTP Server + REST API
//  Serves the CRM dashboard + pipeline API endpoints
// ============================================================
import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL, fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js':   'text/javascript; charset=UTF-8',
  '.css':  'text/css; charset=UTF-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Lazy-load pipeline modules (ESM → dynamic import) ────────
let _pipeline = null;
async function getPipeline() {
  if (!_pipeline) {
    try {
      const [
        database, batchManager, dedup, csvImporter, leadDiscovery,
        qualifier, emailVerifier, sendingEngine, abTesting, personalizer,
        compliance, replyTracker, crmSync, archiver
      ] = await Promise.all([
        import('./pipeline/database.js'),
        import('./pipeline/batch-manager.js'),
        import('./pipeline/dedup.js'),
        import('./pipeline/csv-importer.js'),
        import('./pipeline/lead-discovery.js'),
        import('./pipeline/qualifier.js'),
        import('./pipeline/email-verifier.js'),
        import('./pipeline/sending-engine.js'),
        import('./pipeline/ab-testing.js'),
        import('./pipeline/personalizer.js'),
        import('./pipeline/compliance.js'),
        import('./pipeline/reply-tracker.js'),
        import('./pipeline/crm-sync.js'),
        import('./pipeline/archiver.js'),
      ]);

      database.initDb();
      qualifier.recoverStuckLeads();

      _pipeline = {
        database, batchManager, dedup, csvImporter, leadDiscovery,
        qualifier, emailVerifier, sendingEngine, abTesting, personalizer,
        compliance, replyTracker, crmSync, archiver
      };
    } catch (error) {
      console.error('⚠️  Pipeline modules not loaded:', error.message);
      _pipeline = null;
    }
  }
  return _pipeline;
}

// ── Parse request body ───────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// ── JSON response helpers ────────────────────────────────────
function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function errorResponse(res, message, status = 400) {
  jsonResponse(res, { error: message }, status);
}

// ── Rate limiting (per-IP, for qualify endpoints) ────────────
const _rateLimits = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60000;

function checkRateLimit(req) {
  const ip = req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = _rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    _rateLimits.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// ── API Routes ───────────────────────────────────────────────
async function handleApiRequest(req, res, parsedUrl) {
  const pipeline = await getPipeline();
  if (!pipeline) {
    return errorResponse(res, 'Pipeline not initialized. Run "node pipeline/cli.js seed" first.', 503);
  }

  const { database, batchManager, dedup } = pipeline;
  const db = database.getDb();
  const pathname = parsedUrl.pathname;
  const method = req.method;
  const params = parsedUrl.searchParams;

  // OPTIONS (CORS preflight)
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ── GET /api/batches ─────────────────────────────────────
  if (pathname === '/api/batches' && method === 'GET') {
    const status = params.get('status');
    const limit = parseInt(params.get('limit')) || 50;
    const batches = batchManager.listBatches({ status, limit });
    return jsonResponse(res, batches);
  }

  // ── POST /api/batches ────────────────────────────────────
  if (pathname === '/api/batches' && method === 'POST') {
    const body = await parseBody(req);
    if (!body.name) return errorResponse(res, 'Missing required field: name');

    const batch = batchManager.createBatch(body.name, body.phase || 'discovery');
    return jsonResponse(res, batch, 201);
  }

  // ── GET /api/batches/:id ─────────────────────────────────
  const batchMatch = pathname.match(/^\/api\/batches\/(\d+)$/);
  if (batchMatch && method === 'GET') {
    const stats = batchManager.getBatchStats(parseInt(batchMatch[1]));
    if (!stats) return errorResponse(res, 'Batch not found', 404);
    return jsonResponse(res, stats);
  }

  // ── POST /api/batches/:id/close ──────────────────────────
  const batchCloseMatch = pathname.match(/^\/api\/batches\/(\d+)\/close$/);
  if (batchCloseMatch && method === 'POST') {
    const batchId = parseInt(batchCloseMatch[1]);
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
    if (!batch) return errorResponse(res, 'Batch not found', 404);
    if (batch.status === 'closed') {
      return errorResponse(res, 'Batch is already closed', 409);
    }
    const result = batchManager.closeBatch(batchId);
    return jsonResponse(res, result);
  }

  // ── GET /api/leads ───────────────────────────────────────
  if (pathname === '/api/leads' && method === 'GET') {
    const batchId = params.get('batch_id');
    const status = params.get('status');
    const limit = parseInt(params.get('limit')) || 100;
    const offset = parseInt(params.get('offset')) || 0;
    const search = params.get('search');

    let query = 'SELECT * FROM leads WHERE 1=1';
    const queryParams = [];

    if (batchId) {
      query += ' AND batch_id = ?';
      queryParams.push(parseInt(batchId));
    }
    if (status) {
      query += ' AND status = ?';
      queryParams.push(status);
    }
    if (search) {
      query += ' AND (business_name LIKE ? OR city LIKE ? OR email LIKE ?)';
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm);
    }

    // Get total count
    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count');
    const total = db.prepare(countQuery).get(...queryParams).count;

    query += ' ORDER BY discovered_at DESC LIMIT ? OFFSET ?';
    queryParams.push(limit, offset);

    const leads = db.prepare(query).all(...queryParams);

    return jsonResponse(res, {
      leads,
      pagination: { total, limit, offset, pages: Math.ceil(total / limit) },
    });
  }

  // ── GET /api/leads/:id ───────────────────────────────────
  const leadMatch = pathname.match(/^\/api\/leads\/(\d+)$/);
  if (leadMatch && method === 'GET') {
    const leadId = parseInt(leadMatch[1]);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    if (!lead) return errorResponse(res, 'Lead not found', 404);

    // Include emails
    const emails = db.prepare('SELECT * FROM lead_emails WHERE lead_id = ?').all(leadId);
    // Include events
    const events = db.prepare(
      'SELECT * FROM events WHERE lead_id = ? ORDER BY event_at DESC LIMIT 20'
    ).all(leadId);

    return jsonResponse(res, { ...lead, emails, events });
  }

  // ── GET /api/stats/discovery ─────────────────────────────
  if (pathname === '/api/stats/discovery' && method === 'GET') {
    const stats = database.getDbStats();

    // Status distribution
    const statusDist = db.prepare(`
      SELECT status, COUNT(*) as count FROM leads GROUP BY status ORDER BY count DESC
    `).all();

    // Leads per batch
    const batchDist = db.prepare(`
      SELECT b.id, b.name, b.phase, b.status as batch_status, b.lead_count,
             COUNT(l.id) as actual_leads
      FROM batches b
      LEFT JOIN leads l ON l.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.opened_at DESC
    `).all();

    // Site status distribution
    const siteStatusDist = db.prepare(`
      SELECT site_status, COUNT(*) as count FROM leads
      WHERE site_status IS NOT NULL
      GROUP BY site_status
    `).all();

    // Recent activity
    const recentEvents = db.prepare(`
      SELECT e.*, l.business_name
      FROM events e
      LEFT JOIN leads l ON e.lead_id = l.id
      ORDER BY e.event_at DESC
      LIMIT 20
    `).all();

    return jsonResponse(res, {
      ...stats,
      status_distribution: statusDist,
      batch_distribution: batchDist,
      site_status_distribution: siteStatusDist,
      recent_events: recentEvents,
    });
  }

  // ── GET /api/stats/funnel ────────────────────────────────
  if (pathname === '/api/stats/funnel' && method === 'GET') {
    const funnel = {};
    const stages = [
      'discovered', 'enriching', 'site_checked', 'verifying',
      'personalizing', 'awaiting_approval', 'queued', 'sent',
      'replied', 'won', 'lost', 'disqualified',
    ];

    for (const stage of stages) {
      const row = db.prepare('SELECT COUNT(*) as count FROM leads WHERE status = ?').get(stage);
      funnel[stage] = row.count;
    }

    return jsonResponse(res, funnel);
  }

  // ── GET /api/stats/analytics ─────────────────────────────
  if (pathname === '/api/stats/analytics' && method === 'GET') {
    const { replyTracker } = pipeline;

    // 1. Daily timeline metrics for last 7 days
    const dailyRows = db.prepare(`
      SELECT
        date(event_at) as date,
        COUNT(CASE WHEN event_type = 'sent' THEN 1 END) as sent,
        COUNT(CASE WHEN event_type = 'opened' THEN 1 END) as opened,
        COUNT(CASE WHEN event_type = 'clicked' THEN 1 END) as clicked,
        COUNT(CASE WHEN event_type = 'replied' THEN 1 END) as replied
      FROM events
      WHERE event_at >= date('now', '-7 days')
      GROUP BY date(event_at)
      ORDER BY date ASC
    `).all();

    // Fill last 7 days even if no events
    const timeline = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      const found = dailyRows.find(r => r.date === ds);
      timeline.push(found || { date: ds, sent: 0, opened: 0, clicked: 0, replied: 0 });
    }

    // 2. Reply sentiment breakdown
    const sentiment = replyTracker ? replyTracker.getReplySentimentAnalytics() : {
      interested: 0, not_interested: 0, out_of_office: 0, wrong_person: 0, unsubscribe_request: 0, total: 0
    };

    // 3. Niche performance from leads
    const niches = db.prepare(`
      SELECT
        COALESCE(category, 'General') as niche,
        COALESCE(city, 'Nationwide') as geo,
        COUNT(id) as leads,
        COUNT(CASE WHEN status IN ('sent','replied','won','lost') THEN 1 END) as sent,
        COUNT(CASE WHEN status IN ('replied','won') THEN 1 END) as replies,
        COUNT(CASE WHEN status = 'won' THEN 1 END) as positive,
        ROUND(AVG(CASE WHEN site_score IS NOT NULL THEN site_score END), 1) as avg_site_score
      FROM leads
      GROUP BY category, city
      ORDER BY leads DESC
      LIMIT 15
    `    ).all().map(n => ({
      ...n,
      reply_rate: n.sent > 0 ? Math.round((n.replies / n.sent) * 100) : 0,
      positive_rate: n.sent > 0 ? Math.round((n.positive / n.sent) * 100) : 0,
      // Real spend accounting does not exist yet; reporting a fabricated
      // constant would pretend cost data is observed.
      cost_per_reply: null,
    }));

    // 4. AI usage tracking — observed call counts only.
    // Token and USD figures require stored per-request usage plus a dated
    // rate card; until that accounting exists they are reported as unknown,
    // never derived from copy counts.
    const persTotal = db.prepare('SELECT COUNT(*) as count FROM personalizations').get()?.count || 0;
    const bedrockCount = db.prepare("SELECT COUNT(*) as count FROM personalizations WHERE model_used LIKE 'bedrock:%'").get()?.count || 0;
    const ollamaCount = db.prepare("SELECT COUNT(*) as count FROM personalizations WHERE model_used LIKE 'ollama:%'").get()?.count || 0;
    const templateCount = db.prepare("SELECT COUNT(*) as count FROM personalizations WHERE model_used = 'template-fallback' OR model_used LIKE 'template-fallback:%'").get()?.count || 0;

    return jsonResponse(res, {
      timeline,
      sentiment,
      niches,
      aiCost: {
        usage_status: 'unknown',
        usage_note: 'Token and cost accounting is not implemented yet. Figures below are observed call counts only; unknown values are null, not zero.',
        ollama_calls: ollamaCount,
        template_fallback_calls: templateCount,
        bedrock_calls: bedrockCount,
        bedrock_usd: null,
        bedrock_tokens: null,
        cost_per_lead: null,
        tasks: [
          { name: 'Lead qualification (Wappalyzer + checks)', tier: 'ollama', calls: db.prepare('SELECT COUNT(*) as count FROM leads WHERE site_status IS NOT NULL').get()?.count || 0, cost_usd: null },
          { name: 'Cold email hook generation', tier: 'ollama', calls: ollamaCount, cost_usd: null },
          { name: 'Spam guardrails + fact check pass', tier: 'ollama', calls: persTotal, cost_usd: null },
          { name: 'Bedrock subject line polish', tier: 'bedrock', calls: bedrockCount, cost_usd: null },
        ],
      },
    });
  }

  // ── GET /api/suppression ─────────────────────────────────
  if (pathname === '/api/suppression' && method === 'GET') {
    const limit = parseInt(params.get('limit')) || 100;
    const list = db.prepare('SELECT * FROM suppression_list ORDER BY added_at DESC LIMIT ?').all(limit);
    return jsonResponse(res, list);
  }

  // ── POST /api/suppression ────────────────────────────────
  if (pathname === '/api/suppression' && method === 'POST') {
    const body = await parseBody(req);
    if (!body.email) return errorResponse(res, 'Missing required field: email');

    db.prepare(`
      INSERT OR REPLACE INTO suppression_list (email, reason, added_at)
      VALUES (?, ?, datetime('now'))
    `).run(body.email, body.reason || 'manual');

    return jsonResponse(res, { success: true, email: body.email }, 201);
  }

  // ── GET /api/events ─────────────────────────────────────────
  if (pathname === '/api/events' && method === 'GET') {
    const limit = parseInt(params.get('limit')) || 20;
    const events = db.prepare(`
      SELECT e.*, l.business_name, l.category, l.city
      FROM events e
      LEFT JOIN leads l ON e.lead_id = l.id
      ORDER BY e.event_at DESC
      LIMIT ?
    `).all(limit);
    return jsonResponse(res, events);
  }

  // ── POST /api/batches/:id/archive (Section 14 Archival) ─────
  const batchArchiveMatch = pathname.match(/^\/api\/batches\/(\d+)\/archive$/);
  if (batchArchiveMatch && method === 'POST') {
    const { archiver } = pipeline;
    const batchId = parseInt(batchArchiveMatch[1]);
    const result = archiver.archiveBatch(batchId);
    return jsonResponse(res, result);
  }

  // ── GET /api/stats/archive ──────────────────────────────────
  if (pathname === '/api/stats/archive' && method === 'GET') {
    const { archiver } = pipeline;
    return jsonResponse(res, archiver.getArchiveStats());
  }

  // ── Compliance / One-Click Unsubscribe (Phase 0) ───────────
  if (pathname === '/api/unsubscribe') {
    const { compliance } = pipeline;
    const token = params.get('token');
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end('<h3>Missing unsubscribe token</h3>');
    }
    const verified = compliance.verifyUnsubscribeToken(token);
    if (!verified.valid) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end('<h3>Invalid or expired unsubscribe token</h3>');
    }
    compliance.suppressEmail(verified.email, 'one_click_unsubscribe', verified.leadId);
    if (method === 'POST') {
      return jsonResponse(res, { ok: true, email: verified.email, status: 'unsubscribed' });
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    return res.end(`
      <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:32px;background:#11151f;color:#fff;border-radius:18px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.5)">
        <div style="font-size:36px;margin-bottom:12px">✓</div>
        <h2 style="font-size:1.25rem;margin-bottom:8px">Successfully Unsubscribed</h2>
        <p style="color:#8e8e93;font-size:0.88rem;line-height:1.5">You (${verified.email}) have been permanently removed from our outreach list and will not receive further emails.</p>
      </div>
    `);
  }

  // ── Ingest Inbound Reply & AI Sentiment (Phase 8) ───────────
  if (pathname === '/api/replies/ingest' && method === 'POST') {
    const { replyTracker } = pipeline;
    const body = await parseBody(req);
    if (!body.fromEmail) return errorResponse(res, 'fromEmail is required');
    const result = await replyTracker.ingestInboundReply(body);
    return jsonResponse(res, result);
  }

  // ── GET /api/replies/sentiment-breakdown ─────────────────────
  if (pathname === '/api/replies/sentiment-breakdown' && method === 'GET') {
    const { replyTracker } = pipeline;
    return jsonResponse(res, replyTracker.getReplySentimentAnalytics());
  }

  // ── Open Tracking Pixel (Phase 8) ───────────────────────────
  const openTrackMatch = pathname.match(/^\/api\/track\/open\/(\d+)$/);
  if (openTrackMatch && method === 'GET') {
    const { replyTracker } = pipeline;
    replyTracker.recordOpenEvent(parseInt(openTrackMatch[1]));
    // Return 1x1 transparent GIF
    const transparentGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': transparentGif.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    });
    return res.end(transparentGif);
  }

  // ── Click Tracking Redirect (Phase 8) ───────────────────────
  const clickTrackMatch = pathname.match(/^\/api\/track\/click\/(\d+)$/);
  if (clickTrackMatch && method === 'GET') {
    const { replyTracker } = pipeline;
    const targetUrl = params.get('url') || 'https://google.com';
    replyTracker.recordClickEvent(parseInt(clickTrackMatch[1]), targetUrl);
    res.writeHead(302, { 'Location': targetUrl });
    return res.end();
  }

  // ── CRM Control Plane (Phase 9) ─────────────────────────────
  const crmSyncMatch = pathname.match(/^\/api\/crm\/sync\/(\d+)$/);
  if (crmSyncMatch && method === 'POST') {
    const { crmSync } = pipeline;
    const result = await crmSync.syncLeadToCRM(parseInt(crmSyncMatch[1]));
    return jsonResponse(res, result);
  }

  if (pathname === '/api/crm/kill-switch' && method === 'POST') {
    const { crmSync } = pipeline;
    const body = await parseBody(req);
    const result = crmSync.emergencyKillSwitch(body.reason || 'dashboard_kill_switch');
    return jsonResponse(res, result);
  }

  if (pathname === '/api/crm/blacklist-domain' && method === 'POST') {
    const { crmSync } = pipeline;
    const body = await parseBody(req);
    if (!body.domain) return errorResponse(res, 'domain required');
    const result = crmSync.blacklistDomain(body.domain, body.reason);
    return jsonResponse(res, result);
  }

  if (pathname === '/api/crm/status' && method === 'GET') {
    const { crmSync } = pipeline;
    return jsonResponse(res, crmSync.getCRMControlPlaneStatus());
  }

  // ── 404 for unknown API routes ───────────────────────────
  return errorResponse(res, `Unknown API route: ${method} ${pathname}`, 404);
}

// ── Lead Discovery & Scraping API Routes (1-Click Pipeline) ─
async function handleScrapeApi(req, res, parsedUrl, pipeline) {
  const { leadDiscovery } = pipeline;
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // POST /api/scrape/start — start 1-click lead scraping job
  if (pathname === '/api/scrape/start' && method === 'POST') {
    const body = await parseBody(req);
    if (!body.niche || !body.geography) {
      return errorResponse(res, 'Both niche and geography are required', 400);
    }
    try {
      const result = await leadDiscovery.startDiscoveryJob(body);
      return jsonResponse(res, result, 202);
    } catch (err) {
      return errorResponse(res, err.message, 409);
    }
  }

  // GET /api/scrape/status — poll scraping & enrichment progress
  if (pathname === '/api/scrape/status' && method === 'GET') {
    return jsonResponse(res, leadDiscovery.getDiscoveryStatus());
  }

  // POST /api/scrape/cancel — cancel running scraping job
  if (pathname === '/api/scrape/cancel' && method === 'POST') {
    const cancelled = leadDiscovery.cancelDiscovery();
    return jsonResponse(res, { cancelled });
  }

  return errorResponse(res, `Unknown scrape route: ${method} ${pathname}`, 404);
}

// ── Qualification API Routes ─────────────────────────────────
async function handleQualifyApi(req, res, parsedUrl, pipeline) {
  const { qualifier, database } = pipeline;
  const db = database.getDb();
  const pathname = parsedUrl.pathname;
  const method = req.method;
  const params = parsedUrl.searchParams;

  // Rate limit POST requests
  if (method === 'POST' && !checkRateLimit(req)) {
    return errorResponse(res, 'Rate limit exceeded (30 req/min)', 429);
  }

  // POST /api/qualify/batch/:id — start batch qualification
  const batchStartMatch = pathname.match(/^\/api\/qualify\/batch\/(\d+)$/);
  if (batchStartMatch && method === 'POST') {
    const batchId = parseInt(batchStartMatch[1]);
    const status = qualifier.getQualificationStatus();
    if (status.active) {
      return errorResponse(res, `Qualification already running on batch #${status.batchId}`, 409);
    }
    // Start qualification in background
    qualifier.qualifyBatch(batchId).catch(err => {
      console.error('Qualification error:', err);
    });
    return jsonResponse(res, { started: true, batchId }, 202);
  }

  // POST /api/qualify/cancel — global cancel (UI wrapper contract)
  if (method === 'POST' && pathname === '/api/qualify/cancel') {
    const cancelled = qualifier.cancelQualification();
    return jsonResponse(res, { ok: true, cancelled });
  }

  // POST /api/qualify/batch/:id/cancel — cancel running qualification
  const batchCancelMatch = pathname.match(/^\/api\/qualify\/batch\/(\d+)\/cancel$/);
  if (batchCancelMatch && method === 'POST') {
    const cancelled = qualifier.cancelQualification();
    return jsonResponse(res, { cancelled });
  }

  // GET /api/qualify/status — current progress
  if (pathname === '/api/qualify/status' && method === 'GET') {
    return jsonResponse(res, qualifier.getQualificationStatus());
  }

  // GET /api/qualify/results/:batchId — results for a batch
  const resultsMatch = pathname.match(/^\/api\/qualify\/results\/(\d+)$/);
  if (resultsMatch && method === 'GET') {
    const batchId = parseInt(resultsMatch[1]);
    const siteStatus = params.get('site_status');
    const limit = parseInt(params.get('limit')) || 100;
    const offset = parseInt(params.get('offset')) || 0;
    const results = qualifier.getQualificationResults(batchId, { siteStatus, limit, offset });
    return jsonResponse(res, results);
  }

  // POST /api/qualify/lead/:id — re-qualify single lead
  const leadMatch = pathname.match(/^\/api\/qualify\/lead\/(\d+)$/);
  if (leadMatch && method === 'POST') {
    const leadId = parseInt(leadMatch[1]);
    try {
      const result = await qualifier.requalifyLead(leadId);
      return jsonResponse(res, result);
    } catch (err) {
      return errorResponse(res, err.message, 404);
    }
  }

  // POST /api/qualify/recheck-stale — requeue stale leads
  if (pathname === '/api/qualify/recheck-stale' && method === 'POST') {
    const body = await parseBody(req);
    const days = body.days || 60;
    const result = qualifier.requeueStaleLeads(days);
    return jsonResponse(res, result);
  }

  // GET /api/qualify/stale-count — count of stale leads
  if (pathname === '/api/qualify/stale-count' && method === 'GET') {
    const days = parseInt(params.get('days')) || 60;
    const stale = qualifier.getStaleLeads(days);
    return jsonResponse(res, { count: stale.length, days });
  }

  // GET /api/qualify/spot-check/:batchId — lowest confidence leads
  const spotCheckMatch = pathname.match(/^\/api\/qualify\/spot-check\/(\d+)$/);
  if (spotCheckMatch && method === 'GET') {
    const batchId = parseInt(spotCheckMatch[1]);
    const limit = parseInt(params.get('limit')) || 20;
    const leads = qualifier.getSpotCheckLeads(batchId, limit);
    return jsonResponse(res, leads);
  }

  // GET /api/leads/site-status-distribution — aggregated counts
  if (pathname === '/api/leads/site-status-distribution' && method === 'GET') {
    const batchId = params.get('batch_id') ? parseInt(params.get('batch_id')) : null;
    const dist = qualifier.getSiteStatusDistribution(batchId);
    return jsonResponse(res, dist);
  }

  return errorResponse(res, `Unknown qualify route: ${method} ${pathname}`, 404);
}

// ── Verify API routes ────────────────────────────────────────
async function handleVerifyApi(req, res, parsedUrl, pipeline) {
  const { emailVerifier } = pipeline;
  const method = req.method;
  const pathname = parsedUrl.pathname;

  // POST /api/verify/batch/:id — start batch verification
  const batchMatch = pathname.match(/^\/api\/verify\/batch\/(\d+)$/);
  if (method === 'POST' && batchMatch) {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const batchId = parseInt(batchMatch[1]);
    // Run in background
    emailVerifier.verifyBatch(batchId).catch(e => console.error('Verify error:', e.message));
    return jsonResponse(res, { ok: true, batchId, message: 'Verification started' });
  }

  // POST /api/verify/cancel — global cancel (UI wrapper contract)
  if (method === 'POST' && pathname === '/api/verify/cancel') {
    const cancelled = emailVerifier.cancelVerification();
    return jsonResponse(res, { ok: true, cancelled });
  }

  // POST /api/verify/batch/:id/cancel — cancel running verification
  const cancelMatch = pathname.match(/^\/api\/verify\/batch\/(\d+)\/cancel$/);
  if (method === 'POST' && cancelMatch) {
    const cancelled = emailVerifier.cancelVerification();
    return jsonResponse(res, { ok: true, cancelled });
  }

  // GET /api/verify/status — current verification progress
  if (method === 'GET' && pathname === '/api/verify/status') {
    return jsonResponse(res, emailVerifier.getVerificationStatus());
  }

  // GET /api/verify/results/:batchId — paginated results
  const resultsMatch = pathname.match(/^\/api\/verify\/results\/(\d+)$/);
  if (method === 'GET' && resultsMatch) {
    const batchId = parseInt(resultsMatch[1]);
    const status = parsedUrl.searchParams.get('status') || undefined;
    const limit = parseInt(parsedUrl.searchParams.get('limit')) || 100;
    const offset = parseInt(parsedUrl.searchParams.get('offset')) || 0;
    return jsonResponse(res, emailVerifier.getVerificationResults(batchId, { status, limit, offset }));
  }

  // POST /api/verify/email/:id — re-verify single email
  const emailMatch = pathname.match(/^\/api\/verify\/email\/(\d+)$/);
  if (method === 'POST' && emailMatch) {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const id = parseInt(emailMatch[1]);
    try {
      const result = await emailVerifier.reverifyEmailById(id);
      return jsonResponse(res, { ok: true, result });
    } catch (e) {
      return errorResponse(res, e.message, 404);
    }
  }

  // POST /api/verify/single — verify arbitrary email
  if (method === 'POST' && pathname === '/api/verify/single') {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const body = await parseBody(req);
    if (!body.email) return errorResponse(res, 'email required');
    const result = await emailVerifier.verifyEmail(body.email);
    return jsonResponse(res, { ok: true, result });
  }

  // GET /api/verify/distribution — status counts
  if (method === 'GET' && pathname === '/api/verify/distribution') {
    const batchId = parsedUrl.searchParams.get('batch_id');
    return jsonResponse(res, emailVerifier.getVerificationDistribution(batchId ? parseInt(batchId) : null));
  }

  // GET /api/verify/reacher-status — check if Reacher Docker backend is running
  if (method === 'GET' && pathname === '/api/verify/reacher-status') {
    const status = await emailVerifier.getReacherStatus();
    return jsonResponse(res, status);
  }

  return errorResponse(res, `Unknown verify route: ${method} ${pathname}`, 404);
}

// ── Sending & Campaign API routes ───────────────────────────
async function handleSendingApi(req, res, parsedUrl, pipeline) {
  const { sendingEngine, abTesting } = pipeline;
  const method = req.method;
  const pathname = parsedUrl.pathname;

  // --- Mailbox Fleet ---

  // GET /api/sending/mailboxes — full fleet
  if (method === 'GET' && pathname === '/api/sending/mailboxes') {
    return jsonResponse(res, sendingEngine.getMailboxFleet());
  }

  // POST /api/sending/mailboxes — add mailbox
  if (method === 'POST' && pathname === '/api/sending/mailboxes') {
    const body = await parseBody(req);
    if (!body.email) return errorResponse(res, 'email required');
    const result = await sendingEngine.addMailbox(body);
    return jsonResponse(res, { ok: true, ...result });
  }

  // PATCH /api/sending/mailboxes/:id — update mailbox
  const updateMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)$/);
  if (method === 'PATCH' && updateMatch) {
    const body = await parseBody(req);
    const result = sendingEngine.updateMailbox(parseInt(updateMatch[1]), body);
    return jsonResponse(res, { ok: true, ...result });
  }

  // DELETE /api/sending/mailboxes/:id — delete mailbox
  if (method === 'DELETE' && updateMatch) {
    const result = sendingEngine.deleteMailbox(parseInt(updateMatch[1]));
    return jsonResponse(res, { ok: true, ...result });
  }

  // POST /api/sending/mailboxes/:id/verify-dns — perform live DNS lookups (SPF, DMARC, MX, DNSBL)
  const verifyDnsMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/verify-dns$/);
  if (method === 'POST' && verifyDnsMatch) {
    const result = await sendingEngine.verifyMailboxDns(parseInt(verifyDnsMatch[1]));
    return jsonResponse(res, { ok: true, ...result });
  }

  // POST /api/sending/mailboxes/:id/test-smtp — verify live SMTP handshake
  const testSmtpMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/test-smtp$/);
  if (method === 'POST' && testSmtpMatch) {
    const result = await sendingEngine.testMailboxSmtp(parseInt(testSmtpMatch[1]));
    return jsonResponse(res, result);
  }

  // POST /api/sending/mailboxes/:id/send-test — transmit real test email
  const sendTestMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/send-test$/);
  if (method === 'POST' && sendTestMatch) {
    const body = await parseBody(req);
    if (!body.toEmail) return errorResponse(res, 'toEmail is required');
    const result = await sendingEngine.sendTestEmail(
      parseInt(sendTestMatch[1]),
      body.toEmail,
      body.subject,
      body.body
    );
    return jsonResponse(res, result);
  }

  // POST /api/sending/mailboxes/:id/pause
  const pauseMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/pause$/);
  if (method === 'POST' && pauseMatch) {
    return jsonResponse(res, sendingEngine.pauseMailbox(parseInt(pauseMatch[1])));
  }

  // POST /api/sending/mailboxes/:id/activate
  const activateMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/activate$/);
  if (method === 'POST' && activateMatch) {
    return jsonResponse(res, sendingEngine.activateMailbox(parseInt(activateMatch[1])));
  }

  // POST /api/sending/mailboxes/:id/retire
  const retireMatch = pathname.match(/^\/api\/sending\/mailboxes\/(\d+)\/retire$/);
  if (method === 'POST' && retireMatch) {
    return jsonResponse(res, sendingEngine.retireMailbox(parseInt(retireMatch[1])));
  }

  // POST /api/sending/health-recompute — recompute all health scores
  if (method === 'POST' && pathname === '/api/sending/health-recompute') {
    const results = sendingEngine.recomputeHealthScores();
    return jsonResponse(res, { ok: true, results });
  }

  // POST /api/sending/warmup-check — process warmup transitions
  if (method === 'POST' && pathname === '/api/sending/warmup-check') {
    const transitioned = sendingEngine.processWarmupTransitions();
    return jsonResponse(res, { ok: true, transitioned });
  }

  // --- Campaigns ---

  // GET /api/sending/campaigns — list all campaigns with stats
  if (method === 'GET' && pathname === '/api/sending/campaigns') {
    return jsonResponse(res, abTesting.getAllCampaignStats());
  }

  // POST /api/sending/campaigns — create campaign
  if (method === 'POST' && pathname === '/api/sending/campaigns') {
    const body = await parseBody(req);
    if (!body.name) return errorResponse(res, 'name required');
    const result = sendingEngine.createCampaign(body);
    return jsonResponse(res, { ok: true, ...result });
  }

  // GET /api/sending/campaigns/:id/variants — variant stats
  const variantsMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/variants$/);
  if (method === 'GET' && variantsMatch) {
    return jsonResponse(res, abTesting.getVariantStats(parseInt(variantsMatch[1])));
  }

  // GET /api/sending/campaigns/:id/timeline — 14-day timeline
  const timelineMatch = pathname.match(/^\/api\/sending\/campaigns\/(\d+)\/timeline$/);
  if (method === 'GET' && timelineMatch) {
    const days = parseInt(parsedUrl.searchParams.get('days')) || 14;
    return jsonResponse(res, abTesting.getCampaignTimeline(parseInt(timelineMatch[1]), days));
  }

  // --- Send Queue ---

  // POST /api/sending/queue/:campaignId — queue sends
  const queueMatch = pathname.match(/^\/api\/sending\/queue\/(\d+)$/);
  if (method === 'POST' && queueMatch) {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const body = await parseBody(req);
    const result = await sendingEngine.queueSends(parseInt(queueMatch[1]), body);
    return jsonResponse(res, { ok: true, ...result });
  }

  // POST /api/sending/process — process the send queue
  if (method === 'POST' && pathname === '/api/sending/process') {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const body = await parseBody(req);
    sendingEngine.processSendQueue(body).catch(e => console.error('Send error:', e.message));
    return jsonResponse(res, { ok: true, message: 'Send queue processing started' });
  }

  // POST /api/sending/cancel — cancel processing
  if (method === 'POST' && pathname === '/api/sending/cancel') {
    return jsonResponse(res, { ok: true, cancelled: sendingEngine.cancelSending() });
  }

  // GET /api/sending/status — sending progress
  if (method === 'GET' && pathname === '/api/sending/status') {
    return jsonResponse(res, sendingEngine.getSendingStatus());
  }

  // GET /api/sending/queue/:campaignId — view send queue
  const viewQueueMatch = pathname.match(/^\/api\/sending\/queue\/(\d+)$/);
  if (method === 'GET' && viewQueueMatch) {
    return jsonResponse(res, sendingEngine.getSendQueue(parseInt(viewQueueMatch[1])));
  }

  // GET /api/sending/stats — overall send stats
  if (method === 'GET' && pathname === '/api/sending/stats') {
    return jsonResponse(res, sendingEngine.getSendStats());
  }

  // --- A/B Testing ---

  // POST /api/sending/ab/auto-promote — check and auto-promote winners
  if (method === 'POST' && pathname === '/api/sending/ab/auto-promote') {
    const promoted = abTesting.autoPromoteWinners();
    return jsonResponse(res, { ok: true, promoted });
  }

  // GET /api/sending/ab/assign/:campaignId — get next variant assignment
  const assignMatch = pathname.match(/^\/api\/sending\/ab\/assign\/(\d+)$/);
  if (method === 'GET' && assignMatch) {
    return jsonResponse(res, { variant: abTesting.assignVariant(parseInt(assignMatch[1])) });
  }

  // POST /api/sending/threshold-check — auto-pause breaching mailboxes
  if (method === 'POST' && pathname === '/api/sending/threshold-check') {
    const paused = sendingEngine.checkAutoThresholds();
    return jsonResponse(res, { ok: true, paused });
  }

  return errorResponse(res, `Unknown sending route: ${method} ${pathname}`, 404);
}

// ── Personalization API routes ───────────────────────────
async function handlePersonalizeApi(req, res, parsedUrl, pipeline) {
  const { personalizer } = pipeline;
  const method = req.method;
  const pathname = parsedUrl.pathname;

  // POST /api/personalize/batch/:id — start personalization for a batch
  const batchMatch = pathname.match(/^\/api\/personalize\/batch\/(\d+)$/);
  if (method === 'POST' && batchMatch) {
    if (!checkRateLimit(req)) return errorResponse(res, 'Rate limit exceeded', 429);
    const body = await parseBody(req);
    const batchId = parseInt(batchMatch[1]);
    personalizer.personalizeBatch(batchId, body).catch(e => console.error('Personalize error:', e.message));
    return jsonResponse(res, { ok: true, batchId, message: 'Personalization started' });
  }

  // POST /api/personalize/cancel — cancel running personalization
  if (method === 'POST' && pathname === '/api/personalize/cancel') {
    return jsonResponse(res, { ok: true, cancelled: personalizer.cancelPersonalization() });
  }

  // GET /api/personalize/status — current progress
  if (method === 'GET' && pathname === '/api/personalize/status') {
    return jsonResponse(res, personalizer.getPersonalizationStatus());
  }

  // GET /api/personalize/list — list personalizations (filter: batch_id, status)
  if (method === 'GET' && pathname === '/api/personalize/list') {
    const batchId = parsedUrl.searchParams.get('batch_id');
    const status = parsedUrl.searchParams.get('status') || undefined;
    const limit = parseInt(parsedUrl.searchParams.get('limit')) || 100;
    const offset = parseInt(parsedUrl.searchParams.get('offset')) || 0;
    return jsonResponse(res, personalizer.getPersonalizationList(
      batchId ? parseInt(batchId) : null, { status, limit, offset }
    ));
  }

  // GET /api/personalize/awaiting — leads awaiting human approval
  if (method === 'GET' && pathname === '/api/personalize/awaiting') {
    const batchId = parsedUrl.searchParams.get('batch_id');
    return jsonResponse(res, personalizer.getAwaitingApproval(batchId ? parseInt(batchId) : null));
  }

  // GET /api/personalize/stats — personalization statistics
  if (method === 'GET' && pathname === '/api/personalize/stats') {
    const batchId = parsedUrl.searchParams.get('batch_id');
    return jsonResponse(res, personalizer.getPersonalizationStats(batchId ? parseInt(batchId) : null));
  }

  // POST /api/personalize/approve/:id — approve a personalization
  const approveMatch = pathname.match(/^\/api\/personalize\/approve\/(\d+)$/);
  if (method === 'POST' && approveMatch) {
    return jsonResponse(res, personalizer.approvePersonalization(parseInt(approveMatch[1])));
  }

  // POST /api/personalize/reject/:id — reject a personalization
  const rejectMatch = pathname.match(/^\/api\/personalize\/reject\/(\d+)$/);
  if (method === 'POST' && rejectMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, personalizer.rejectPersonalization(parseInt(rejectMatch[1]), body.reason));
  }

  // PATCH /api/personalize/:id — edit a personalization (human edits copy)
  const editMatch = pathname.match(/^\/api\/personalize\/(\d+)$/);
  if (method === 'PATCH' && editMatch) {
    const body = await parseBody(req);
    return jsonResponse(res, personalizer.editPersonalization(parseInt(editMatch[1]), body));
  }

  // GET /api/personalize/ollama-test — check Ollama connection
  if (method === 'GET' && pathname === '/api/personalize/ollama-test') {
    const result = await personalizer.testOllamaConnection();
    return jsonResponse(res, result);
  }

  return errorResponse(res, `Unknown personalize route: ${method} ${pathname}`, 404);
}

// ── Main request handler ─────────────────────────────────────
export const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const reqPath = parsedUrl.pathname;

  // API routes
  if (reqPath.startsWith('/api/scrape/')) {
    try {
      const pipeline = await getPipeline();
      if (!pipeline) return errorResponse(res, 'Pipeline not initialized', 503);
      await handleScrapeApi(req, res, parsedUrl, pipeline);
    } catch (error) {
      console.error('Scrape API Error:', error);
      errorResponse(res, 'Internal server error', 500);
    }
    return;
  }

  if (reqPath.startsWith('/api/qualify/') || reqPath === '/api/leads/site-status-distribution') {
    try {
      const pipeline = await getPipeline();
      if (!pipeline) return errorResponse(res, 'Pipeline not initialized', 503);
      await handleQualifyApi(req, res, parsedUrl, pipeline);
    } catch (error) {
      console.error('Qualify API Error:', error);
      errorResponse(res, 'Internal server error', 500);
    }
    return;
  }

  if (reqPath.startsWith('/api/verify/')) {
    try {
      const pipeline = await getPipeline();
      if (!pipeline) return errorResponse(res, 'Pipeline not initialized', 503);
      await handleVerifyApi(req, res, parsedUrl, pipeline);
    } catch (error) {
      console.error('Verify API Error:', error);
      errorResponse(res, 'Internal server error', 500);
    }
    return;
  }

  if (reqPath.startsWith('/api/sending/')) {
    try {
      const pipeline = await getPipeline();
      if (!pipeline) return errorResponse(res, 'Pipeline not initialized', 503);
      await handleSendingApi(req, res, parsedUrl, pipeline);
    } catch (error) {
      console.error('Sending API Error:', error);
      errorResponse(res, 'Internal server error', 500);
    }
    return;
  }

  if (reqPath.startsWith('/api/personalize/')) {
    try {
      const pipeline = await getPipeline();
      if (!pipeline) return errorResponse(res, 'Pipeline not initialized', 503);
      await handlePersonalizeApi(req, res, parsedUrl, pipeline);
    } catch (error) {
      console.error('Personalize API Error:', error);
      errorResponse(res, 'Internal server error', 500);
    }
    return;
  }

  if (reqPath.startsWith('/api/')) {
    try {
      await handleApiRequest(req, res, parsedUrl);
    } catch (error) {
      console.error('API Error:', error);
      errorResponse(res, 'Internal server error', 500);
    }
    return;
  }

  // Static file serving
  let filePath = path.join(__dirname, reqPath === '/' ? '/index.html' : reqPath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n🚀 oddecosys CRM Control Plane running at: http://localhost:${server.address().port}`);
  console.log(`📡 API endpoints available at: http://localhost:${PORT}/api/`);
  console.log(`\nAPI Routes:`);
  console.log(`  GET  /api/batches                     - List all batches`);
  console.log(`  POST /api/batches                     - Create new batch`);
  console.log(`  GET  /api/batches/:id                 - Batch details`);
  console.log(`  GET  /api/leads                       - List leads (filter: batch_id, status, search)`);
  console.log(`  GET  /api/leads/:id                   - Lead details with emails & events`);
  console.log(`  GET  /api/stats/discovery             - Discovery pipeline stats`);
  console.log(`  GET  /api/stats/funnel                - Pipeline funnel stats`);
  console.log(`  POST /api/qualify/batch/:id            - Start batch qualification`);
  console.log(`  POST /api/qualify/batch/:id/cancel     - Cancel running qualification`);
  console.log(`  GET  /api/qualify/status               - Qualification progress`);
  console.log(`  GET  /api/qualify/results/:batchId     - Qualification results`);
  console.log(`  POST /api/qualify/lead/:id             - Re-qualify single lead`);
  console.log(`  POST /api/qualify/recheck-stale        - Requeue stale leads`);
  console.log(`  GET  /api/qualify/stale-count          - Count stale leads`);
  console.log(`  GET  /api/qualify/spot-check/:batchId  - Lowest confidence leads`);
  console.log(`  GET  /api/leads/site-status-distribution - Site status counts`);
  console.log(`  POST /api/verify/batch/:id              - Start batch verification`);
  console.log(`  POST /api/verify/batch/:id/cancel       - Cancel running verification`);
  console.log(`  GET  /api/verify/status                 - Verification progress`);
  console.log(`  GET  /api/verify/results/:batchId       - Verification results`);
  console.log(`  POST /api/verify/email/:id              - Re-verify single email`);
  console.log(`  POST /api/verify/single                 - Verify arbitrary email`);
  console.log(`  GET  /api/verify/distribution           - Verification status counts`);
  console.log(`  --- Sending Engine (Phase 6) ---`);
  console.log(`  GET  /api/sending/mailboxes              - Mailbox fleet`);
  console.log(`  POST /api/sending/mailboxes              - Add mailbox`);
  console.log(`  POST /api/sending/mailboxes/:id/pause    - Pause mailbox`);
  console.log(`  POST /api/sending/mailboxes/:id/activate - Re-activate mailbox`);
  console.log(`  POST /api/sending/mailboxes/:id/retire   - Retire mailbox`);
  console.log(`  POST /api/sending/health-recompute       - Recompute health scores`);
  console.log(`  POST /api/sending/warmup-check           - Process warmup transitions`);
  console.log(`  GET  /api/sending/campaigns              - List campaigns + stats`);
  console.log(`  POST /api/sending/campaigns              - Create campaign`);
  console.log(`  GET  /api/sending/campaigns/:id/variants - A/B variant stats`);
  console.log(`  GET  /api/sending/campaigns/:id/timeline - Campaign timeline`);
  console.log(`  POST /api/sending/queue/:campaignId      - Queue sends`);
  console.log(`  POST /api/sending/process                - Process send queue`);
  console.log(`  POST /api/sending/cancel                 - Cancel processing`);
  console.log(`  GET  /api/sending/status                 - Sending progress`);
  console.log(`  GET  /api/sending/stats                  - Overall send stats`);
  console.log(`  --- A/B Testing (Phase 7) ---`);
  console.log(`  POST /api/sending/ab/auto-promote        - Auto-promote winners`);
  console.log(`  GET  /api/sending/ab/assign/:campaignId  - Get variant assignment`);
  console.log(`  POST /api/sending/threshold-check        - Auto-pause check`);
  console.log(`  --- AI Personalization (Phase 5) ---`);
  console.log(`  POST /api/personalize/batch/:id          - Start personalization`);
  console.log(`  POST /api/personalize/cancel             - Cancel personalization`);
  console.log(`  GET  /api/personalize/status             - Personalization progress`);
  console.log(`  GET  /api/personalize/list               - List personalizations`);
  console.log(`  GET  /api/personalize/awaiting           - Leads awaiting approval`);
  console.log(`  GET  /api/personalize/stats              - Personalization stats`);
  console.log(`  POST /api/personalize/approve/:id        - Approve personalization`);
  console.log(`  POST /api/personalize/reject/:id         - Reject personalization`);
  console.log(`  PATCH /api/personalize/:id               - Edit personalization`);
  console.log(`  GET  /api/personalize/ollama-test        - Check Ollama connection`);
  console.log(`\nPress Ctrl+C to stop.\n`);
});
