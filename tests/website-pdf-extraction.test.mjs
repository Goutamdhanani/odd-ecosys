import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCompanyPdfEmails, extractPdfTextIsolated, MAX_PDF_BYTES } from '../pipeline/pdf-text.js';
import { makeTextPdf } from './support/minimal-pdf.mjs';

test('isolated PDF text parser preserves page numbers and filters unrelated catalog emails', async () => {
  const source = makeTextPdf([
    'Northstar Foundry sales@northstar.example.com',
    'Northstar Foundry office@gmail.com',
    'Other Exporter contact@other.example.org',
  ]);
  const parsed = await extractPdfTextIsolated(source);
  assert.equal(parsed.page_count, 1);
  assert.deepEqual(parsed.pages.map(page => page.page_number), [1]);
  assert.match(parsed.pages[0].text, /sales@northstar\.example\.com/);

  const matched = extractCompanyPdfEmails(parsed.pages, {
    websiteHost: 'www.northstar.example.com',
    businessName: 'Northstar Foundry Ltd',
  });
  assert.deepEqual(matched.map(item => item.email).sort(), [
    'office@gmail.com',
    'sales@northstar.example.com',
  ]);
  assert.ok(matched.every(item => item.evidence_type === 'website_pdf_text' && item.extractor_version === 'website-pdf-v1'));
  assert.ok(matched.every(item => item.raw_excerpt.startsWith('PDF page 1:')));
  assert.deepEqual(extractCompanyPdfEmails([{ page_number: 1, text: 'Directory contact@co.uk' }], {
    websiteHost: 'mail.company.co.uk',
    businessName: 'Northstar Foundry',
  }), [], 'a shared public suffix is not treated as the business email domain');
});

test('PDF parser rejects oversized and malformed documents before accepting evidence', async () => {
  await assert.rejects(extractPdfTextIsolated(Buffer.alloc(MAX_PDF_BYTES + 1)), /pdf_size_limit/);
  await assert.rejects(extractPdfTextIsolated(Buffer.from('<html>not a PDF</html>')), /pdf_signature_invalid/);
});
