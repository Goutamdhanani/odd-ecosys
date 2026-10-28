#!/usr/bin/env node
import { createAstraProspectingService } from '../../pipeline/astra-prospecting.js';

const tenantId = process.env.ASTRA_PROSPECTING_TENANT_ID?.trim();
const userId = process.env.ASTRA_PROSPECTING_USER_ID?.trim();
const service = createAstraProspectingService();

try {
  const status = await service.status();
  if (!status.ready) {
    console.error(`BLOCKED: ${status.reason}`);
    process.exitCode = 2;
  } else if (!tenantId || !userId) {
    console.error('BLOCKED: Set the verified ASTRA_PROSPECTING_TENANT_ID and ASTRA_PROSPECTING_USER_ID for this one-shot worker.');
    process.exitCode = 2;
  } else {
    const result = await service.runOnce({ tenantId, userId });
    if (result.status === 'uncertain') {
      console.error(`UNCERTAIN: ${result.reason || 'A database write may have committed.'} No later pipeline stage was started. Refresh the saved job and reconcile before continuing.`);
      process.exitCode = 3;
    } else if (['failed', 'blocked', 'stale'].includes(result.status)) {
      console.error(`${String(result.status).toUpperCase()}: ${result.reason || 'No later pipeline stage was started.'}`);
      process.exitCode = 2;
    } else {
      console.log(`${String(result.status || 'unknown').toUpperCase()}: ${result.qualifiedCount ?? 0} website-evidenced businesses qualified from ${result.candidateCount ?? 0} bounded candidates; collected ${result.collectedCount ?? 0} sites. Contact verification remains held and no campaign or message was sent.`);
    }
  }
} catch (error) {
  const code = /^[a-z0-9_]+$/i.test(error?.code || '') ? error.code : 'prospecting_worker_failed';
  console.error(`BLOCKED: ${code}. ${error?.message || 'The one-shot worker could not complete.'}`);
  process.exitCode = 2;
} finally {
  try { await service.close(); } catch { /* Do not expose connection diagnostics. */ }
}
