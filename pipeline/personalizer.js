// ============================================================
//  ODD-ECOSYS Pipeline — AI Personalization & Copywriting (Phase 5)
//
//  4-step pipeline per lead:
//    1. Ollama draft pass  — 2 variant openers + body
//    2. Guardrail pass     — rule-based, no AI, fast
//    3. Bedrock polish     — subject line sharpening (falls back to Ollama)
//    4. Fact-check pass    — Ollama hallucination guard
//
//  Output → personalizations table, lead.status = 'personalizing' → 'awaiting_approval' | 'queued'
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'personalization.json');
let _config = null;
function getConfig() {
  if (!_config) _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  return _config;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Run state ────────────────────────────────────────────────
let _state = {
  active: false,
  batchId: null,
  processed: 0,
  total: 0,
  currentLead: null,
  cancelling: false,
  errors: [],
  stats: { drafted: 0, guardrail_failed: 0, polished: 0, factcheck_failed: 0, approved: 0 },
};

export function getPersonalizationStatus() { return { ..._state }; }
export function cancelPersonalization() {
  if (_state.active) { _state.cancelling = true; return true; }
  return false;
}

// ══════════════════════════════════════════════════════════════
//  OLLAMA HELPER
// ══════════════════════════════════════════════════════════════

async function callOllama(prompt, model, config = getConfig()) {
  const url = `${config.ollama.base_url}/api/generate`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ollama.timeout_ms);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || config.ollama.draft_model, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return data.response?.trim() || '';
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Ollama timeout');
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════
//  STEP 1 — OLLAMA DRAFT PASS
// ══════════════════════════════════════════════════════════════

/**
 * Build a structured fact bundle for a lead — only real scraped facts.
 */
function buildFactBundle(lead) {
  const facts = {};
  if (lead.business_name)  facts.business_name = lead.business_name;
  if (lead.category)        facts.category = lead.category;
  if (lead.city)            facts.city = lead.city;
  if (lead.country)         facts.country = lead.country;
  if (lead.rating)          facts.rating = lead.rating;
  if (lead.reviews)         facts.reviews = lead.reviews;
  if (lead.website_url)     facts.website_url = lead.website_url;
  if (lead.site_status)     facts.site_status = lead.site_status;
  if (lead.site_score)      facts.site_score = lead.site_score;
  if (lead.fb_active !== null && lead.fb_active !== undefined) {
    facts.has_active_facebook = !!lead.fb_active;
  }

  // Parse site reasons
  try {
    const reasons = JSON.parse(lead.site_reasons_json || '[]');
    if (reasons.length) facts.site_reasons = reasons;
  } catch { /* */ }

  return facts;
}

async function draftVariant(lead, variant, factBundle) {
  const config = getConfig();
  const voice = config.variant_voice[variant] || 'casual and direct';
  const factsStr = JSON.stringify(factBundle, null, 2);

  const prompt = `You are writing a cold email opener for a small business outreach campaign.

Business facts (use ONLY these, do not invent anything not listed here):
${factsStr}

Voice for Variant ${variant}: ${voice}

Write a cold email with:
1. A subject line (under 55 characters, creates curiosity without spam words)
2. An opening line that references ONE specific fact above (NOT "I noticed your business" or generic openers)
3. A body (50-100 words total, one clear ask, conversational)

${lead.site_status === 'NO_SITE' ? 'The business has NO website — this is the core angle.' : ''}
${lead.site_status === 'DEAD_SITE' ? 'The business website is DOWN/dead — this is the core angle.' : ''}
${lead.site_status === 'OUTDATED' ? `The business website looks outdated (score ${lead.site_score || '?'}/10) — this is the core angle.` : ''}
${(lead.rating && lead.reviews) ? `They have ${lead.reviews} reviews at ${lead.rating}★ — strong social proof to contrast with their weak web presence.` : ''}

Output format (strictly follow this):
SUBJECT: [subject line]
BODY:
[email body — include {{business_name}} at least once, end with a soft call to action — one question or a 15-minute offer]`;

  const response = await callOllama(prompt, config.ollama.draft_model);
  return parseOllamaDraft(response, variant);
}

function parseOllamaDraft(text, variant) {
  const subjectMatch = text.match(/SUBJECT:\s*(.+)/i);
  const bodyMatch = text.match(/BODY:\s*([\s\S]+)/i);

  return {
    variant,
    subject_line: subjectMatch?.[1]?.trim() || '',
    body_text: bodyMatch?.[1]?.trim() || text.trim(),
  };
}

// ══════════════════════════════════════════════════════════════
//  STEP 2 — GUARDRAIL PASS (rule-based, no AI)
// ══════════════════════════════════════════════════════════════

export function runGuardrails(draft, factBundle) {
  const config = getConfig();
  const { guardrails } = config;
  const failures = [];

  const bodyWords = draft.body_text.trim().split(/\s+/).length;
  const subjectChars = draft.subject_line.length;

  // Length checks
  if (bodyWords > guardrails.max_body_words) {
    failures.push(`body_too_long:${bodyWords}_words`);
  }
  if (bodyWords < guardrails.min_body_words) {
    failures.push(`body_too_short:${bodyWords}_words`);
  }
  if (subjectChars > guardrails.max_subject_chars) {
    failures.push(`subject_too_long:${subjectChars}_chars`);
  }
  if (!draft.subject_line) {
    failures.push('missing_subject');
  }
  if (!draft.body_text) {
    failures.push('missing_body');
  }

  // Spam trigger words
  const bodyLower = draft.body_text.toLowerCase();
  const subjectLower = draft.subject_line.toLowerCase();
  for (const word of guardrails.spam_trigger_words) {
    if (bodyLower.includes(word) || subjectLower.includes(word)) {
      failures.push(`spam_word:${word}`);
    }
  }

  // Banned openers
  for (const opener of guardrails.banned_openers) {
    if (bodyLower.includes(opener.toLowerCase())) {
      failures.push(`banned_opener:${opener}`);
    }
  }

  // Excessive punctuation / caps
  const capsRatio = (draft.body_text.match(/[A-Z]/g) || []).length / draft.body_text.length;
  if (capsRatio > 0.25) failures.push('excessive_caps');

  const exclamations = (draft.body_text.match(/!/g) || []).length;
  if (exclamations > 2) failures.push(`excessive_exclamations:${exclamations}`);

  // Missing business name merge field (or actual name substituted)
  const hasBusinessRef = draft.body_text.includes('{{business_name}}')
    || (factBundle.business_name && draft.body_text.includes(factBundle.business_name));
  if (!hasBusinessRef) failures.push('missing_business_name_reference');

  return {
    passed: failures.length === 0,
    failures,
  };
}

// ══════════════════════════════════════════════════════════════
//  STEP 3 — POLISH PASS (Bedrock → Ollama fallback)
// ══════════════════════════════════════════════════════════════

async function polishSubjectLine(draft, factBundle, config = getConfig()) {
  const factsStr = JSON.stringify(factBundle);

  // Try Bedrock first if enabled
  if (config.bedrock.enabled) {
    try {
      const polished = await callBedrock(draft, factBundle, config);
      if (polished) return polished;
    } catch (err) {
      // Bedrock failure is recorded, then the configured Ollama fallback runs.
      // Nothing is labeled as "Bedrock polished" unless the SDK call succeeded.
      console.warn(`  Bedrock failed (${err.message}), falling back to Ollama`);
    }
  }

  // Ollama polish fallback
  const prompt = `Given this cold email opener and body:
Subject: "${draft.subject_line}"
Body: "${draft.body_text}"

And these business facts: ${factsStr}

Rewrite ONLY the subject line to be:
- Under 50 characters
- Create genuine curiosity about the email content
- Reference a specific fact (not generic)
- No spam trigger words, no exclamation marks, no "free", no "guarantee"
- Sound like it came from a real person, not marketing

Output ONLY the new subject line, nothing else.`;

  const response = await callOllama(prompt, config.ollama.draft_model, config);
  const newSubject = response.replace(/^["']|["']$/g, '').trim();

  if (newSubject && newSubject.length < 80) {
    return { ...draft, subject_line: newSubject, polished: true, polished_by: 'ollama' };
  }
  return { ...draft, polished: false, polished_by: 'none' };
}

export { polishSubjectLine };

// Real AWS Bedrock adapter using the official @aws-sdk/client-bedrock-runtime.
// Credentials come from the standard AWS SDK credential chain
// (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN / AWS_REGION
// or a configured profile). Without credentials the adapter fails truthfully;
// it never returns a fabricated result.
export async function callBedrock(draft, factBundle, config) {
  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');

  const region = process.env.AWS_REGION || config.bedrock.region || 'us-east-1';
  const modelId = config.bedrock.polish_model;

  const prompt = `Rewrite ONLY the subject line of this cold email. Under 50 characters.
Reference one specific business fact. No spam words, no exclamation marks.
Output ONLY the new subject line.

Subject: "${draft.subject_line}"
Body: "${draft.body_text}"
Business facts: ${JSON.stringify(factBundle)}`;

  const client = new BedrockRuntimeClient({ region });
  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const response = await client.send(command);
  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  const text = parsed.content?.[0]?.text?.replace(/^["']|["']$/g, '').trim() || '';

  if (!text || text.length >= 80) {
    throw new Error('Bedrock returned an unusable subject line');
  }

  return {
    ...draft,
    subject_line: text,
    polished: true,
    polished_by: `bedrock:${modelId}`,
    model_used: `bedrock:${modelId}`,
  };
}

// ══════════════════════════════════════════════════════════════
//  STEP 4 — FACT-CHECK PASS (Ollama hallucination guard)
// ══════════════════════════════════════════════════════════════

async function factCheckDraft(draft, factBundle) {
  const config = getConfig();
  if (!config.guardrails.hallucination_check) return { passed: true, issues: [] };

  const factsStr = JSON.stringify(factBundle);
  const fullEmail = `Subject: ${draft.subject_line}\n\n${draft.body_text}`;

  const prompt = `Compare this email against the fact bundle below.
List any claim in the email that is NOT directly supported by the fact bundle.
If the email is clean (all claims traceable), respond with exactly: CLEAN

Email:
${fullEmail}

Fact bundle:
${factsStr}

Response (CLEAN or list of unsupported claims, one per line):`;

  try {
    const response = await callOllama(prompt, config.ollama.factcheck_model);
    const clean = response.trim().toUpperCase() === 'CLEAN'
      || response.trim().toLowerCase().startsWith('clean');

    const issues = clean ? [] : response.trim().split('\n').filter(l => l.trim());
    return { status: clean ? 'passed' : 'failed', passed: clean, issues };
  } catch (err) {
    // A failed check is NOT a pass. It is recorded as 'unavailable' and blocks
    // automatic approval and sending until a real check has run.
    console.warn(`  Fact-check unavailable (Ollama failure): ${err.message}`);
    return { status: 'unavailable', passed: false, issues: [], unavailable: true, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
//  MAIN: PERSONALIZE BATCH
// ══════════════════════════════════════════════════════════════

export async function personalizeBatch(batchId, options = {}) {
  const { limit = 100, nicheKey = null } = options;
  const db = getDb();
  const config = getConfig();

  if (_state.active) throw new Error('Personalization already running');

  // Get leads ready for personalization
  const leads = db.prepare(`
    SELECT l.*, le.email, le.verification_status
    FROM leads l
    LEFT JOIN lead_emails le ON le.lead_id = l.id
      AND le.verification_status IN ('deliverable', 'risky')
    WHERE l.batch_id = ?
      AND l.status = 'verified'
      AND le.email IS NOT NULL
    GROUP BY l.id
    ORDER BY l.id
    LIMIT ?
  `).all(batchId, limit);

  if (leads.length === 0) {
    return { batchId, processed: 0, message: 'No verified leads ready for personalization' };
  }

  // Count how many have already been personalized in this niche (for approval gate)
  const nicheAlreadyPersonalized = nicheKey
    ? db.prepare(`
        SELECT COUNT(*) as c FROM personalizations p
        JOIN leads l ON p.lead_id = l.id
        WHERE l.category = ? AND l.batch_id = ?
      `).get(nicheKey, batchId).c
    : 0;

  _state = {
    active: true,
    batchId,
    processed: 0,
    total: leads.length,
    currentLead: null,
    cancelling: false,
    errors: [],
    stats: { drafted: 0, guardrail_failed: 0, polished: 0, factcheck_failed: 0, approved: 0 },
  };

  console.log('\n' + '═'.repeat(60));
  console.log('  🤖 AI Personalization — Phase 5');
  console.log('═'.repeat(60));
  console.log(`  Batch: ${batchId}  |  Leads: ${leads.length}`);
  console.log(`  Ollama: ${config.ollama.base_url}  |  Model: ${config.ollama.draft_model}`);
  console.log('═'.repeat(60) + '\n');

  const insertPersonalization = db.prepare(`
    INSERT OR REPLACE INTO personalizations
      (lead_id, subject_variant, subject_line, body_variant, body_text,
       model_used, guardrail_passed, fact_check_passed, fact_check_status, approved, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const updateLeadStatus = db.prepare(`
    UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?
  `);

  let personalizingCount = nicheAlreadyPersonalized;

  for (const lead of leads) {
    if (_state.cancelling) break;
    _state.currentLead = lead.business_name;

    try {
      const factBundle = buildFactBundle(lead);
      db.prepare("UPDATE leads SET status = 'personalizing', updated_at = datetime('now') WHERE id = ?").run(lead.id);

      // Personalize each variant
      for (const variant of config.variants) {
        let draft;

        // STEP 1: Draft
        try {
          draft = await draftVariant(lead, variant, factBundle);
          _state.stats.drafted++;
          console.log(`   ✍  [${variant}] ${lead.business_name} — draft generated`);
        } catch (err) {
          console.warn(`   ⚠  [${variant}] ${lead.business_name} — Ollama draft failed: ${err.message}`);
          // Use a template fallback if Ollama unavailable
          draft = buildTemplateFallback(lead, variant, factBundle);
          _state.stats.drafted++;
        }

        // STEP 2: Guardrails
        const guardrailResult = runGuardrails(draft, factBundle);
        if (!guardrailResult.passed) {
          _state.stats.guardrail_failed++;
          console.log(`   ✗  [${variant}] Guardrail failed: ${guardrailResult.failures.join(', ')}`);
          // Still save with guardrail_passed=0 for review
          insertPersonalization.run(
            lead.id, variant, draft.subject_line, variant, draft.body_text,
            `${draft.model_used || `ollama:${config.ollama.draft_model}`}:guardrail_failed`, 0, 0,
            'not_run', // fact-check not reached
            0 // not approved
          );
          continue;
        }

        // STEP 3: Polish subject line
        let polished = draft;
        try {
          polished = await polishSubjectLine(draft, factBundle);
          if (polished.polished) _state.stats.polished++;
        } catch { /* skip polish, use draft subject */ }

        // STEP 4: Fact-check
        const factCheck = await factCheckDraft(polished, factBundle);
        if (factCheck.status === 'failed') {
          _state.stats.factcheck_failed++;
          console.log(`   ⚠  [${variant}] Fact-check issues: ${factCheck.issues.slice(0,2).join('; ')}`);
        } else if (factCheck.status === 'unavailable') {
          _state.stats.factcheck_unavailable = (_state.stats.factcheck_unavailable || 0) + 1;
          console.log(`   ⚠  [${variant}] Fact-check UNAVAILABLE (${factCheck.error}) — auto-approval blocked`);
        }

        // Determine approval status. Automatic approval requires an observed
        // 'passed' fact-check; 'unavailable' or 'failed' blocks auto-approval.
        const requiresApproval = personalizingCount < config.approval.first_n_per_niche;
        const autoApprove = !requiresApproval && config.approval.auto_approve_after && factCheck.status === 'passed';

        insertPersonalization.run(
          lead.id,
          variant,
          polished.subject_line,
          variant,
          polished.body_text,
          polished.model_used || `ollama:${config.ollama.draft_model}`,
          guardrailResult.passed ? 1 : 0,
          factCheck.status === 'passed' ? 1 : 0,
          factCheck.status,
          autoApprove ? 1 : 0
        );

        if (autoApprove) _state.stats.approved++;
        console.log(`   ✅ [${variant}] ${lead.business_name} — ${autoApprove ? 'auto-approved' : 'awaiting human approval'}`);
      }

      // Update lead status
      const finalStatus = personalizingCount < config.approval.first_n_per_niche
        ? 'awaiting_approval' : 'queued';
      updateLeadStatus.run(finalStatus, lead.id);
      personalizingCount++;

    } catch (err) {
      console.error(`   ✗ ${lead.business_name}: ${err.message}`);
      _state.errors.push({ leadId: lead.id, error: err.message });
      updateLeadStatus.run('verified', lead.id); // reset so it can retry
    }

    _state.processed++;
    // Rate-limit Ollama calls
    await sleep(300);
  }

  _state.active = false;
  _state.currentLead = null;

  console.log('\n' + '═'.repeat(60));
  console.log('  ✅ Phase 5 Personalization Complete');
  console.log('═'.repeat(60));
  console.log(`  Drafted: ${_state.stats.drafted}  |  Polished: ${_state.stats.polished}`);
  console.log(`  Guardrail failed: ${_state.stats.guardrail_failed}  |  Fact-check failed: ${_state.stats.factcheck_failed}`);
  console.log(`  Auto-approved: ${_state.stats.approved}  |  Awaiting human: ${_state.processed - _state.stats.approved}`);
  console.log('═'.repeat(60) + '\n');

  return {
    batchId,
    processed: _state.processed,
    stats: { ..._state.stats },
    errors: _state.errors.length,
  };
}

// ══════════════════════════════════════════════════════════════
//  TEMPLATE FALLBACK (when Ollama is offline)
// ══════════════════════════════════════════════════════════════

function buildTemplateFallback(lead, variant, factBundle) {
  const name = factBundle.business_name || 'your business';
  const city = factBundle.city || '';
  const reviews = factBundle.reviews;
  const rating = factBundle.rating;
  const hasReviews = reviews && rating;

  const templates = {
    A: {
      subject_line: hasReviews
        ? `${name} — quick question about your ${reviews} reviews`
        : `${name} — 30-second question`,
      body_text: `Hi {{business_name}} team,

${hasReviews
  ? `${reviews} reviews at ${rating}★ is genuinely impressive for a ${city} business.`
  : `Noticed ${name} in ${city} — solid reputation.`}

${lead.site_status === 'NO_SITE'
  ? 'One thing catching my eye: there\'s no website — which means potential customers can\'t find you online.'
  : lead.site_status === 'DEAD_SITE'
    ? 'One thing: the website appears to be down right now.'
    : 'One thing: the website could use some freshening up.'}

Would it be worth a quick 15-minute call to explore what that might be costing in new customers?`,
    },
    B: {
      subject_line: hasReviews
        ? `${rating}★ reputation, missing one thing — ${name}`
        : `Quick note on ${name}'s online presence`,
      body_text: `Hi {{business_name}},

${hasReviews
  ? `Your ${reviews} reviews speak for themselves — strong social proof.`
  : `${name} has a solid local presence in ${city}.`}

${lead.site_status === 'NO_SITE'
  ? 'What I noticed: no website. Every day without one, some of those potential customers choose a competitor they could Google first.'
  : lead.site_status === 'DEAD_SITE'
    ? 'The site appears offline, which may be sending the wrong signal to new customers.'
    : 'The website could better reflect the quality of the business itself.'}

Happy to share what typically moves the needle for businesses like yours — 15 minutes?`,
    },
  };

  return { ...(templates[variant] || templates.A), model_used: 'template-fallback' };
}

// ══════════════════════════════════════════════════════════════
//  APPROVAL ACTIONS
// ══════════════════════════════════════════════════════════════

export function approvePersonalization(personalizationId, approver = 'operator') {
  const db = getDb();
  const p = db.prepare('SELECT * FROM personalizations WHERE id = ?').get(personalizationId);
  if (!p) throw new Error(`Personalization #${personalizationId} not found`);

  // Human approval is an explicit operator decision. It never rewrites the
  // observed fact-check outcome: an 'unavailable'/'failed' check stays what it is.
  db.prepare('UPDATE personalizations SET approved = 1 WHERE id = ?').run(personalizationId);
  db.prepare(`
    INSERT INTO events (lead_id, event_type, event_at, meta_json)
    VALUES (?, 'copy_approved', datetime('now'), ?)
  `).run(p.lead_id, JSON.stringify({
    personalization_id: personalizationId,
    approver,
    fact_check_status: p.fact_check_status || 'unknown',
    auto_approve: false,
  }));

  // Move lead to queued
  db.prepare("UPDATE leads SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(p.lead_id);
  return { id: personalizationId, approved: true, fact_check_status: p.fact_check_status || 'unknown' };
}

export function rejectPersonalization(personalizationId, reason) {
  const db = getDb();
  db.prepare('UPDATE personalizations SET approved = 0 WHERE id = ?').run(personalizationId);

  const p = db.prepare('SELECT lead_id FROM personalizations WHERE id = ?').get(personalizationId);
  if (p) {
    db.prepare("UPDATE leads SET status = 'verified', updated_at = datetime('now') WHERE id = ?").run(p.lead_id);
  }
  return { id: personalizationId, rejected: true, reason };
}

export function editPersonalization(personalizationId, updates) {
  const db = getDb();
  const fields = [];
  const values = [];

  if (updates.subject_line !== undefined) { fields.push('subject_line = ?'); values.push(updates.subject_line); }
  if (updates.body_text !== undefined)    { fields.push('body_text = ?');    values.push(updates.body_text); }

  if (fields.length === 0) return { id: personalizationId, updated: false };

  const p = db.prepare('SELECT * FROM personalizations WHERE id = ?').get(personalizationId);
  if (!p) throw new Error(`Personalization #${personalizationId} not found`);

  // Editing invalidates the previous fact-check and any approval: the copy no
  // longer matches what was checked/approved. It must be re-checked and
  // re-approved by a human before it can be sent.
  fields.push("fact_check_status = 'unavailable'");
  fields.push('fact_check_passed = 0');
  fields.push('approved = 0');
  values.push(personalizationId);

  db.prepare(`UPDATE personalizations SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // Return lead to the approval queue
  db.prepare("UPDATE leads SET status = 'awaiting_approval', updated_at = datetime('now') WHERE id = ?").run(p.lead_id);

  return { id: personalizationId, updated: true, approval_invalidated: true, fact_check_status: 'unavailable' };
}

// ══════════════════════════════════════════════════════════════
//  QUERY HELPERS
// ══════════════════════════════════════════════════════════════

export function getAwaitingApproval(batchId) {
  const db = getDb();
  const q = batchId
    ? `SELECT p.*, l.business_name, l.category, l.city, l.site_status,
              l.rating, l.reviews, l.email
       FROM personalizations p
       JOIN leads l ON p.lead_id = l.id
       LEFT JOIN lead_emails le ON le.lead_id = l.id
       WHERE l.batch_id = ? AND l.status = 'awaiting_approval' AND p.approved = 0
       ORDER BY p.generated_at DESC`
    : `SELECT p.*, l.business_name, l.category, l.city, l.site_status,
              l.rating, l.reviews
       FROM personalizations p
       JOIN leads l ON p.lead_id = l.id
       WHERE l.status = 'awaiting_approval' AND p.approved = 0
       ORDER BY p.generated_at DESC`;

  return batchId ? db.prepare(q).all(batchId) : db.prepare(q).all();
}

export function getPersonalizationStats(batchId) {
  const db = getDb();
  const q = batchId
    ? 'WHERE l.batch_id = ?'
    : '';
  const args = batchId ? [batchId] : [];

  return {
    total: db.prepare(`SELECT COUNT(*) as c FROM personalizations p JOIN leads l ON p.lead_id = l.id ${q}`).get(...args).c,
    approved: db.prepare(`SELECT COUNT(*) as c FROM personalizations p JOIN leads l ON p.lead_id = l.id ${q} ${q ? 'AND' : 'WHERE'} p.approved = 1`).get(...args).c,
    awaiting: db.prepare(`SELECT COUNT(*) as c FROM personalizations p JOIN leads l ON p.lead_id = l.id ${q} ${q ? 'AND' : 'WHERE'} p.approved = 0 AND l.status = 'awaiting_approval'`).get(...args).c,
    guardrail_failed: db.prepare(`SELECT COUNT(*) as c FROM personalizations p JOIN leads l ON p.lead_id = l.id ${q} ${q ? 'AND' : 'WHERE'} p.guardrail_passed = 0`).get(...args).c,
    factcheck_failed: db.prepare(`SELECT COUNT(*) as c FROM personalizations p JOIN leads l ON p.lead_id = l.id ${q} ${q ? 'AND' : 'WHERE'} p.fact_check_passed = 0`).get(...args).c,
  };
}

export function getPersonalizationList(batchId, options = {}) {
  const db = getDb();
  const { status, limit = 100, offset = 0 } = options;

  let where = batchId ? 'l.batch_id = ?' : '1=1';
  const args = batchId ? [batchId] : [];

  if (status === 'approved')  { where += ' AND p.approved = 1'; }
  if (status === 'awaiting')  { where += " AND p.approved = 0 AND l.status = 'awaiting_approval'"; }
  if (status === 'failed')    { where += ' AND p.guardrail_passed = 0'; }

  args.push(limit, offset);

  return db.prepare(`
    SELECT p.*, l.business_name, l.category, l.city, l.site_status,
           l.rating, l.reviews, l.status as lead_status,
           le.email as recipient_email
    FROM personalizations p
    JOIN leads l ON p.lead_id = l.id
    LEFT JOIN lead_emails le ON le.lead_id = l.id
    WHERE ${where}
    ORDER BY p.generated_at DESC
    LIMIT ? OFFSET ?
  `).all(...args);
}

export function testOllamaConnection() {
  const config = getConfig();
  return fetch(`${config.ollama.base_url}/api/tags`, { method: 'GET' })
    .then(r => r.json())
    .then(data => ({
      connected: true,
      models: data.models?.map(m => m.name) || [],
    }))
    .catch(err => ({ connected: false, error: err.message }));
}
