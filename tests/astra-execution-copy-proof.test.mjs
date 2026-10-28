import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateAstraR20Fixture } from './support/astra-r20-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = process.env.ASTRA_QA_FIXTURE_PATH ? path.resolve(process.env.ASTRA_QA_FIXTURE_PATH) : null;

test('approval, ticket and dispatcher paths use one current full-copy validator', async () => {
  const [autonomy, dispatcher, campaigns, validation] = await Promise.all([
    readFile(path.join(root, 'pipeline/astra-autonomy.js'), 'utf8'),
    readFile(path.join(root, 'pipeline/astra-dispatcher.js'), 'utf8'),
    readFile(path.join(root, 'pipeline/astra-campaigns.js'), 'utf8'),
    readFile(path.join(root, 'pipeline/astra-copy-validation.js'), 'utf8'),
  ]);
  assert.match(autonomy, /export async function hasCurrentAstraCopyProof\(/);
  assert.match(autonomy, /validatePersistedAstraCopy\(client,\{tenantId,campaign:candidate\}\)/);
  assert.match(autonomy, /hasCurrentAstraCopyProof\(client,\{tenantId:actor\.tenantId,campaign\}\)/,
    'ticket issuance must validate persisted proof and full campaign text');
  assert.match(dispatcher, /hasCurrentAstraCopyProof, recordAstraExecutionAttempt/,
    'dispatcher imports the shared validator');
  assert.match(dispatcher, /hasCurrentAstraCopyProof\(client,\{tenantId:actor\.tenantId,campaign\}\)/,
    'dispatcher preflight must validate persisted proof and full campaign text');
  assert.match(campaigns, /validatePersistedAstraCopy\(client,\{tenantId:actor\.tenantId,campaign\}\)/,
    'approval and offline planning use the same validator');
  assert.match(campaigns, /historyOnly:true,currentPlanEligible:false,currentValidation:/,
    'idempotent offline-plan replay reports current validation without rewriting its immutable historical plan');
  assert.match(validation, /bodyLines\(body\)/);
  assert.match(validation, /canonicalJson\(current\.mappings\) !== canonicalJson\(mappings\)/);
  assert.doesNotMatch(autonomy, /FROM astra\.research_claims c[\s\S]{0,700}ORDER BY x\.created_at DESC,x\.id DESC LIMIT 1/,
    'ticket issuance has no UUID-ordered original-proof copy lookup');
  assert.doesNotMatch(dispatcher, /FROM astra\.research_claims c[\s\S]{0,700}ORDER BY x\.created_at DESC,x\.id DESC LIMIT 1/,
    'dispatcher preflight has no UUID-ordered original-proof copy lookup');
});

test('current copy proof validator accepts only exact literal sentences backed by current tenant proof', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to the approved .runner/astra-qa/r20-source-rights/pg.json fixture.',
}, async () => {
  const canonical = await realpath(fixturePath);
  const fixture = await validateAstraR20Fixture({ root, fixturePath: canonical });
  assert.equal(fixture.realData, false);

  const keep = new Set(['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  let store;
  try {
    await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
    const [{ createAstraTenantStore }, { saveResearchSnapshot }, { resolveCurrentResearchClaims }, { revokeAstraSourceRights }] = await Promise.all([
      import('../pipeline/astra-tenant-store.js'), import('../pipeline/astra-evidence.js'), import('../pipeline/astra-current-claims.js'), import('../pipeline/astra-source-rights.js'),
    ]);
    store = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
    const userId = String(1_000_000_000 + randomBytes(4).readUInt32BE(0));
    const { tenantId } = await store.createTenant({ name: `Copy proof ${randomUUID().slice(0, 8)}`, userId });
    const identity = { tenantId, userId };
    const claims = {};
    await store.withTenant(identity, async (db, actor) => {
      async function addClaim({ value, excerpt, predicate = 'commercial.metric', expiresAt = '2035-01-01T00:00:00.000Z' }) {
        const domain = `copy-${randomUUID().slice(0, 8)}.synthetic.example.test`;
        const page = await saveResearchSnapshot(db, actor, { sourceUrl: `https://${domain}/proof`, rightsPolicy: 'synthetic_fixture', rightsAttested: true,
          robotsAllowed: true, html: `<p>${excerpt}</p>`, mediaType: 'text/html; charset=utf-8' });
        const id = randomUUID();
        await db.query(`INSERT INTO astra.research_claims(tenant_id,id,evidence_id,content_sha256,subject_key,predicate,claim_value,exact_excerpt,expires_at,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'supported')`,
        [tenantId,id,page.evidence.id,page.evidence.contentSha256,domain,predicate,value,excerpt,expiresAt]);
        return { id, page, domain };
      }
      claims.valid = await addClaim({ value: '47 employees', excerpt: 'Synthetic Example has 47 employees.' });
      claims.tied = await addClaim({ value: 'manufacturing', excerpt: 'Synthetic Example is in manufacturing.' });
      claims.retracted = await addClaim({ value: 'enterprise', excerpt: 'Synthetic Example sells enterprise software.' });
      claims.expired = await addClaim({ value: '12 offices', excerpt: 'Synthetic Example has 12 offices.', expiresAt: '2000-01-01T00:00:00.000Z' });
      claims.revoked = await addClaim({ value: '6 regions', excerpt: 'Synthetic Example serves 6 regions.' });

      const rightsDomain = `rights-${randomUUID().slice(0, 8)}.synthetic.example.test`;
      const rightsSourceId = randomUUID(), rightsEvidenceId = randomUUID(), rightsClaimId = randomUUID();
      const rightsHtml = Buffer.from('<p>Synthetic Example has 3 branches.</p>');
      const rightsHash = createHash('sha256').update(rightsHtml).digest('hex');
      await db.query(`INSERT INTO astra.research_sources(tenant_id,id,source_url,normalized_domain,rights_policy,rights_expires_at,robots_allowed,rights_attested,created_by)
        VALUES($1,$2,$3,$4,'synthetic_fixture','2000-01-01T00:00:00.000Z',true,true,$5)`,
      [tenantId,rightsSourceId,`https://${rightsDomain}/proof`,rightsDomain,userId]);
      await db.query(`INSERT INTO astra.research_blobs(tenant_id,sha256,content,byte_length,media_type) VALUES($1,$2,$3,$4,'text/html; charset=utf-8')`,
      [tenantId,rightsHash,rightsHtml,rightsHtml.length]);
      await db.query(`INSERT INTO astra.research_evidence(tenant_id,id,source_id,normalized_domain,content_sha256,captured_at,extractor_version,extracted_text,coverage_status,source_content_untrusted)
        VALUES($1,$2,$3,$4,$5,now(),'execution-copy-proof-test/1.0.0','Synthetic Example has 3 branches.','single_page_snapshot',true)`,
      [tenantId,rightsEvidenceId,rightsSourceId,rightsDomain,rightsHash]);
      await db.query(`INSERT INTO astra.research_claims(tenant_id,id,evidence_id,content_sha256,subject_key,predicate,claim_value,exact_excerpt,expires_at,status)
        VALUES($1,$2,$3,$4,$5,'commercial.metric','3 branches','Synthetic Example has 3 branches.','2035-01-01T00:00:00.000Z','supported')`,
      [tenantId,rightsClaimId,rightsEvidenceId,rightsHash,rightsDomain]);
      claims.rightsExpired = { id: rightsClaimId };

      const validClaim=(await resolveCurrentResearchClaims(db,{tenantId,claimIds:[claims.valid.id]}))[0];
      assert.equal(validClaim.valid,true,'current source claim resolves with exact excerpt and hash');
      assert.equal(validClaim.proof.exactExcerpt,'Synthetic Example has 47 employees.');

      const tiedProof = await saveResearchSnapshot(db, actor, { sourceUrl: `https://${claims.tied.domain}/correction`, rightsPolicy: 'synthetic_fixture',
        rightsAttested: true, robotsAllowed: true, html: '<p>Synthetic Example now uses software.</p>', mediaType: 'text/html; charset=utf-8' });
      await db.query(`INSERT INTO astra.research_claim_corrections(tenant_id,id,claim_id,correction_type,replacement_value,evidence_id,content_sha256,exact_excerpt,reason,created_by,created_at)
        VALUES($1,$2,$3,'corrected','software',$4,$5,'Synthetic Example now uses software.','copy proof tie A',$6,'2030-01-01T00:00:00.123456Z'),
              ($1,$7,$3,'corrected','software',$4,$5,'Synthetic Example now uses software.','copy proof tie B',$6,'2030-01-01T00:00:00.123456Z')`,
      [tenantId,randomUUID(),claims.tied.id,tiedProof.evidence.id,tiedProof.evidence.contentSha256,userId,randomUUID()]);
      assert.equal((await resolveCurrentResearchClaims(db,{tenantId,claimIds:[claims.tied.id]}))[0].valid,false,
        'equal newest correction timestamps are ambiguous even when sentence text matches');

      await db.query(`INSERT INTO astra.research_claim_corrections(tenant_id,id,claim_id,correction_type,reason,created_by)
        VALUES($1,$2,$3,'retracted','copy proof retraction',$4)`, [tenantId,randomUUID(),claims.retracted.id,userId]);
      assert.equal((await resolveCurrentResearchClaims(db,{tenantId,claimIds:[claims.retracted.id]}))[0].valid,false,
        'retracted claims are rejected');
      assert.equal((await resolveCurrentResearchClaims(db,{tenantId,claimIds:[claims.expired.id]}))[0].valid,false,
        'expired claims are rejected');
      assert.equal((await resolveCurrentResearchClaims(db,{tenantId,claimIds:[claims.rightsExpired.id]}))[0].valid,false,
        'expired source rights are rejected');
      await revokeAstraSourceRights(db, actor, claims.revoked.page.evidence.sourceId, {
        reason: 'Synthetic source-rights revocation for copy-proof regression', idempotencyKey: `copy-proof-${randomUUID()}`,
      });
      assert.equal((await resolveCurrentResearchClaims(db,{tenantId,claimIds:[claims.revoked.id]}))[0].valid,false,
        'persisted source-rights revocation blocks current copy proof');

      const invalidProof = await addClaim({ value: 'software', excerpt: 'Synthetic Example now builds software.' });
      const foreignDomain = `proof-${randomUUID().slice(0, 8)}.synthetic.example.test`;
      const invalidCorrection = await saveResearchSnapshot(db, actor, { sourceUrl: `https://${foreignDomain}/correction`, rightsPolicy: 'synthetic_fixture',
        rightsAttested: true, robotsAllowed: true, html: '<p>Synthetic Example now builds software.</p>', mediaType: 'text/html; charset=utf-8' });
      await db.query(`INSERT INTO astra.research_claim_corrections(tenant_id,id,claim_id,correction_type,replacement_value,evidence_id,content_sha256,exact_excerpt,reason,created_by)
        VALUES($1,$2,$3,'corrected','software',$4,$5,'Synthetic Example now builds software.','invalid effective proof domain',$6)`,
      [tenantId,randomUUID(),invalidProof.id,invalidCorrection.evidence.id,invalidCorrection.evidence.contentSha256,userId]);
      assert.equal((await resolveCurrentResearchClaims(db,{tenantId,claimIds:[invalidProof.id]}))[0].valid,false,
        'effective proof from a different source domain is rejected');
    });
  } finally {
    if (store) await store.close();
  }
});
