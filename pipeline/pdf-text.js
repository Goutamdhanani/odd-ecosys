import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_PDF_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_PAGES = 16;
const MAX_WORKER_OUTPUT_BYTES = 512 * 1024;
const PDF_WORKER_TIMEOUT_MS = 10_000;
const PDF_WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pdf-text-worker.js');

let workerActive = false;
const workerQueue = [];

function acquireWorkerSlot() {
  if (!workerActive) {
    workerActive = true;
    return Promise.resolve(releaseWorkerSlot);
  }
  if (workerQueue.length >= 2) return Promise.reject(new Error('pdf_parser_busy'));
  return new Promise((resolve, reject) => workerQueue.push({ resolve, reject }));
}

function releaseWorkerSlot() {
  const next = workerQueue.shift();
  if (next) next.resolve(releaseWorkerSlot);
  else workerActive = false;
}

export async function extractPdfTextIsolated(input, { timeoutMs = PDF_WORKER_TIMEOUT_MS } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buffer.length || buffer.length > MAX_PDF_BYTES) throw new Error('pdf_size_limit');
  const release = await acquireWorkerSlot();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=128', PDF_WORKER_PATH], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const output = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error('pdf_parse_timeout'));
      }, Math.max(500, Math.min(15_000, Number(timeoutMs) || PDF_WORKER_TIMEOUT_MS)));
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_WORKER_OUTPUT_BYTES) {
          child.kill();
          finish(new Error('pdf_text_output_limit'));
          return;
        }
        output.push(chunk);
      });
      child.once('error', () => finish(new Error('pdf_parser_unavailable')));
      child.once('close', code => {
        if (settled) return;
        let result;
        try { result = JSON.parse(Buffer.concat(output).toString('utf8')); }
        catch { return finish(new Error('pdf_parse_failed')); }
        if (code !== 0 || result.error) return finish(new Error(result.error || 'pdf_parse_failed'));
        if (!Array.isArray(result.pages) || result.pages.length > MAX_PDF_PAGES
          || result.pages.some(page => !Number.isInteger(page.page_number) || typeof page.text !== 'string')) {
          return finish(new Error('pdf_parser_result_invalid'));
        }
        finish(null, result);
      });
      child.stdin.once('error', () => {});
      child.stdin.end(buffer);
    });
  } finally {
    release();
  }
}

function normalizedBusinessName(value) {
  const ignored = new Set(['company', 'corporation', 'corporate', 'limited', 'ltd', 'inc', 'incorporated', 'group', 'private', 'pvt', 'llp', 'the']);
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .trim().split(/\s+/).filter(token => token.length >= 4 && !ignored.has(token));
}

function domainMatchesWebsite(emailDomain, websiteHost) {
  const host = String(websiteHost || '').toLowerCase().replace(/^www\./, '');
  const domain = String(emailDomain || '').toLowerCase().replace(/^www\./, '');
  return domain === host || domain.endsWith(`.${host}`);
}

function nameMatchesContext(tokens, context) {
  if (!tokens.length) return false;
  const words = new Set(String(context || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean));
  const matches = tokens.filter(token => words.has(token));
  return tokens.length === 1 ? tokens[0].length >= 6 && matches.length === 1 : matches.length >= 2;
}

export function extractCompanyPdfEmails(pages, { websiteHost, businessName } = {}) {
  const accepted = new Map();
  const nameTokens = normalizedBusinessName(businessName);
  const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi;
  for (const page of pages || []) {
    const text = String(page?.text || '');
    for (const match of text.matchAll(emailPattern)) {
      const email = match[0].replace(/[.,;:!?)\]}]+$/g, '').toLowerCase();
      if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) continue;
      const at = match.index;
      const lineStart = text.lastIndexOf('\n', at) + 1;
      const lineEndAt = text.indexOf('\n', at);
      const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
      const line = text.slice(lineStart, lineEnd).trim();
      const hostMatch = domainMatchesWebsite(email.slice(email.lastIndexOf('@') + 1), websiteHost);
      if (!hostMatch && !nameMatchesContext(nameTokens, line)) continue;
      const excerpt = `PDF page ${Number(page.page_number) || 1}: ${line || email}`.slice(0, 300);
      accepted.set(email, {
        email,
        source_url: null,
        evidence_type: 'website_pdf_text',
        extractor_version: 'website-pdf-v1',
        raw_excerpt: excerpt,
        page_number: Number(page.page_number) || 1,
      });
    }
  }
  return [...accepted.values()];
}
