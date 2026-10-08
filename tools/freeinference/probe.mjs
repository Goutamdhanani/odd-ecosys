// Runs inside the gateway container. Prints model IDs or a generic error, never credentials.
const response = await fetch('http://127.0.0.1:8080/v1/models', {
  headers: { Authorization: `Bearer ${process.env.GATEWAY_TOKEN}` },
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) {
  const data = await response.json().catch(() => ({}));
  console.log(JSON.stringify({ ok: false, status: response.status, kind: data.kind || 'request' }));
  process.exitCode = 1;
} else {
  const data = await response.json();
  const ids = (data.data || []).map(model => model.id);
  console.log(JSON.stringify({ ok: ids.includes(process.env.CODING_MODEL), models: ids }));
  if (!ids.includes(process.env.CODING_MODEL)) process.exitCode = 2;
}
