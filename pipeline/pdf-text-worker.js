import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 16;
const MAX_PAGE_TEXT_CHARS = 16_000;
const MAX_TOTAL_TEXT_CHARS = 160_000;

function writeResult(value) {
  process.stdout.write(JSON.stringify(value));
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('pdf_input_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function main() {
  let document;
  try {
    const input = await readInput();
    if (input.length < 8 || !input.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      throw new Error('pdf_signature_invalid');
    }
    const loading = pdfjs.getDocument({
      data: new Uint8Array(input),
      disableFontFace: true,
      enableXfa: false,
      isEvalSupported: false,
      maxImageSize: 0,
      stopAtErrors: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    document = await loading.promise;
    const pages = [];
    let totalChars = 0;
    const pageLimit = Math.min(document.numPages, MAX_PAGES);
    for (let pageNumber = 1; pageNumber <= pageLimit && totalChars < MAX_TOTAL_TEXT_CHARS; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const text = content.items.map(item => {
        if (!item || typeof item.str !== 'string') return '';
        return `${item.str}${item.hasEOL ? '\n' : ' '}`;
      }).join('').replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').trim();
      const bounded = text.slice(0, Math.min(MAX_PAGE_TEXT_CHARS, MAX_TOTAL_TEXT_CHARS - totalChars));
      totalChars += bounded.length;
      pages.push({ page_number: pageNumber, text: bounded });
      page.cleanup();
    }
    writeResult({
      pages,
      page_count: document.numPages,
      truncated_pages: document.numPages > MAX_PAGES,
      truncated_text: totalChars >= MAX_TOTAL_TEXT_CHARS || pages.some(page => page.text.length >= MAX_PAGE_TEXT_CHARS),
    });
  } catch (error) {
    writeResult({ error: String(error?.message || 'pdf_parse_failed').slice(0, 120) });
    process.exitCode = 1;
  } finally {
    try { await document?.destroy(); } catch { /* The child exits immediately after its bounded parse. */ }
  }
}

void main();
