export function downloadBlobFile(blob, filename, { documentRef = globalThis.document, urlApi = globalThis.URL } = {}) {
  if (!blob || !documentRef?.body || typeof documentRef.createElement !== 'function') throw new Error('A file and document body are required to download.');
  if (typeof filename !== 'string' || !/^[A-Za-z0-9._-]+\.csv$/i.test(filename)) throw new Error('The download filename is invalid.');
  if (typeof urlApi?.createObjectURL !== 'function' || typeof urlApi?.revokeObjectURL !== 'function') throw new Error('Browser file downloads are unavailable.');

  const objectUrl = urlApi.createObjectURL(blob);
  const link = documentRef.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.hidden = true;
  documentRef.body.appendChild(link);
  try { link.click(); }
  finally {
    link.remove();
    urlApi.revokeObjectURL(objectUrl);
  }
}
