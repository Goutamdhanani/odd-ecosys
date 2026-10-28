import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadBlobFile } from '../js/download.js';
import { Verify } from '../js/api.js';

test('CSV download helper clicks once and always removes the temporary link and object URL', () => {
  const calls = [];
  const link = {
    click() { calls.push('click'); },
    remove() { calls.push('remove'); },
  };
  const documentRef = {
    createElement(tag) { calls.push(`create:${tag}`); return link; },
    body: { appendChild(item) { assert.equal(item, link); calls.push('append'); } },
  };
  const urlApi = {
    createObjectURL(blob) { assert.equal(blob, 'csv-blob'); calls.push('create-url'); return 'blob:fixture'; },
    revokeObjectURL(url) { assert.equal(url, 'blob:fixture'); calls.push('revoke-url'); },
  };
  downloadBlobFile('csv-blob', 'verification-batch-12.csv', { documentRef, urlApi });
  assert.equal(link.href, 'blob:fixture');
  assert.equal(link.download, 'verification-batch-12.csv');
  assert.deepEqual(calls, ['create-url', 'create:a', 'append', 'click', 'remove', 'revoke-url']);
});

test('CSV download helper rejects unsafe filenames before creating a blob URL', () => {
  let created = false;
  assert.throws(() => downloadBlobFile('blob', '../secret.csv', {
    documentRef: { createElement: () => ({}), body: { appendChild() {} } },
    urlApi: { createObjectURL() { created = true; return 'blob:x'; }, revokeObjectURL() {} },
  }), /filename is invalid/i);
  assert.equal(created, false);
});
test('verification export API client requests the selected status and returns the server filename', async () => {
  const priorFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async url => {
    requestedUrl = String(url);
    return {
      ok: true,
      headers: { get: name => name.toLowerCase() === 'content-disposition' ? 'attachment; filename="verification-batch-42.csv"' : null },
      blob: async () => 'csv-blob',
    };
  };
  try {
    const downloaded = await Verify.exportCsv(42, 'unknown');
    assert.equal(requestedUrl, '/api/verify/results/42/export?status=unknown');
    assert.equal(downloaded.filename, 'verification-batch-42.csv');
    assert.equal(downloaded.blob, 'csv-blob');
  } finally { globalThis.fetch = priorFetch; }
});
