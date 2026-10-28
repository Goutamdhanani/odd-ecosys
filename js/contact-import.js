const FORMULA_PREFIX = /^[\u0000-\u0020]*[=+\-@]/;

function safeCsvCell(value) {
  let text = String(value ?? '');
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function rejectedContactsCsv(rejections = []) {
  if (!Array.isArray(rejections) || !rejections.length) return '';
  const sourceFields = [...new Set(rejections.flatMap(row => Object.keys(row?.fields || {})))];
  const reserved = new Set(['row', 'reason']);
  const columns = sourceFields.map(field => {
    let label = field;
    while (reserved.has(label.toLowerCase())) label = `source_${label}`;
    reserved.add(label.toLowerCase());
    return { field, label };
  });
  const header = ['row', 'reason', ...columns.map(column => column.label)];
  const rows = rejections.map(rejection => [
    rejection?.row,
    rejection?.reason,
    ...columns.map(({ field }) => rejection?.fields?.[field]),
  ]);
  return [header, ...rows].map(row => row.map(safeCsvCell).join(',')).join('\r\n') + '\r\n';
}

export function downloadRejectedContacts(rejections, sourceFilename, {
  documentRef = globalThis.document,
  urlApi = globalThis.URL,
  BlobCtor = globalThis.Blob,
  schedule = globalThis.setTimeout,
} = {}) {
  const csv = rejectedContactsCsv(rejections);
  if (!csv) return null;
  if (!documentRef?.createElement || !documentRef.body?.append || !urlApi?.createObjectURL || !BlobCtor) {
    throw new Error('This browser cannot create the rejected-rows download.');
  }

  const base = String(sourceFilename || 'contacts.csv')
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[_ .-]+|[_ .-]+$/g, '')
    .slice(0, 80) || 'contacts';
  const filename = `${base}-rejected.csv`;
  const url = urlApi.createObjectURL(new BlobCtor([csv], { type: 'text/csv;charset=utf-8' }));
  const link = documentRef.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  documentRef.body.append(link);
  link.click();
  link.remove();
  if (typeof schedule === 'function') schedule(() => urlApi.revokeObjectURL(url), 1000);
  return { filename, rows: rejections.length };
}

export function downloadImportRejections(importId, { documentRef = globalThis.document, apiBase = globalThis.window?.API_BASE || '' } = {}) {
  const id = Number(importId);
  if (!Number.isSafeInteger(id) || id < 1 || !documentRef?.body) return null;
  const filename = `contact-import-${id}-rejections.csv`;
  const anchor = documentRef.createElement('a');
  anchor.href = `${apiBase}/api/leads/import-jobs/${encodeURIComponent(id)}/rejections.csv`;
  anchor.download = filename;
  anchor.hidden = true;
  documentRef.body.append(anchor);
  anchor.click();
  anchor.remove();
  return { filename };
}
