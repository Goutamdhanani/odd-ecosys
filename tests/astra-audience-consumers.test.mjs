import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('campaign current consumers do not reauthorize from immutable qualification receipts',async()=>{
  const currentReaders=['astra-autonomy.js','astra-dispatcher.js','astra-generation.js','astra-verifier-adapter.js'];
  for (const name of currentReaders) {
    const source=await readFile(path.join(root,'pipeline',name),'utf8');
    assert.doesNotMatch(source,/campaign_qualifications/,`${name} must read the current approval-bound audience`);
    assert.match(source,/astra-campaign-audience\.js/,`${name} must use the shared current audience contract`);
  }
  const audience=await readFile(path.join(root,'pipeline','astra-campaign-audience.js'),'utf8');
  assert.match(audience,/audience_snapshot/);
  assert.match(audience,/resolveCurrentResearchClaims/);
  assert.match(audience,/candidate_evidence_id===emailEvidenceId/);
  assert.match(audience,/candidate_source_id===emailSourceId/);

  const engagement=await readFile(path.join(root,'pipeline','astra-engagement.js'),'utf8');
  assert.match(engagement,/findCurrentAstraCampaignAudienceMember/,'new tracking context requires current membership');
  assert.match(engagement,/astra\.events/,'historical attribution uses append-only qualification events');
  assert.match(engagement,/candidate\.account_id::text/,'historical audience snapshots must agree with the immutable candidate account');
  assert.match(engagement,/historical\.account_count=1/,'conflicting candidate-to-account snapshot history is excluded');
  assert.match(engagement,/count\(DISTINCT q\.account_id\)/,'unresolved history is excluded instead of guessed from recipient ID');
  assert.doesNotMatch(engagement,/astra\.campaign_qualifications/,'one-per-account first receipts are not used as recipient attribution');

  const autonomy=await readFile(path.join(root,'pipeline','astra-autonomy.js'),'utf8');
  const dispatcher=await readFile(path.join(root,'pipeline','astra-dispatcher.js'),'utf8');
  assert.match(autonomy,/export async function resolveCurrentAstraGeographyProof/);
  assert.match(autonomy,/resolveCurrentResearchClaims\(client,\{tenantId,claimIds:\[uuid\(claimId,'geographyClaimId'\)\]\}\)/,
    'the separate geography claim resolves through exact current effective proof');
  assert.match(autonomy,/claim\.predicate==='geography\.country'/);
  assert.match(autonomy,/claim\.subjectKey===domain\.trim\(\)\.toLowerCase\(\)/);
  assert.match(autonomy,/claim\?\.valid/);
  assert.match(dispatcher,/resolveCurrentAstraGeographyProof\(client/,
    'dispatcher geography preflight shares the current-proof validator');
});
