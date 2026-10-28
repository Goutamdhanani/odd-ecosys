import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateAstraPlatformFixture } from './support/astra-platform-fixture.mjs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qaRoot = path.resolve(root, '.runner/astra-qa');
const fixtureInput = process.env.ASTRA_QA_FIXTURE_PATH;
const fixturePath = fixtureInput ? path.resolve(fixtureInput) : null;

test('campaign qualification binds each current claim to its own proof and fails closed on stale proof', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to the prepared disposable synthetic fixture at .runner/astra-qa/<label>/pg.json.',
}, async () => {
  const [canonicalQaRoot, canonicalFixturePath] = await Promise.all([realpath(qaRoot), realpath(fixturePath)]);
  const relativeFixture = path.relative(canonicalQaRoot, canonicalFixturePath);
  const fixtureParts = relativeFixture.split(path.sep);
  assert.equal(path.isAbsolute(relativeFixture), false, 'fixture must remain below this repository QA root');
  assert.equal(fixtureParts.length, 2, 'fixture path must be .runner/astra-qa/<label>/pg.json');
  assert.ok(fixtureParts[0] && fixtureParts[0] !== '..', 'fixture label is required');
  assert.equal(fixtureParts[1], 'pg.json');
  const fixture = await validateAstraPlatformFixture({ root, fixturePath: canonicalFixturePath, allowR20: true, labels: 'legacy31-or-r18', migrations: 'legacy31-or-r18' });
  assert.equal(fixture.mode, 'disposable-synthetic-qa');
  assert.equal(fixture.label, fixtureParts[0]);
  assert.equal(fixture.realData, false);
  for (const connectionString of [fixture.connectionString, fixture.workerConnectionString]) {
    const connection = new URL(connectionString);
    assert.ok(['postgres:', 'postgresql:'].includes(connection.protocol), 'fixture must use PostgreSQL');
    assert.ok(['localhost', '127.0.0.1', '::1'].includes(connection.hostname), 'fixture database must be loopback-only');
  }

  const safeEnv = new Set(['PATH','SystemRoot','WINDIR','TEMP','TMP','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!safeEnv.has(key)) delete process.env[key];
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'astra-qualification-lineage-'));
  process.env.ODD_DB_PATH = path.join(scratch, 'auth.sqlite');
  process.env.NODE_ENV = 'test';
  process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
  process.env.ODD_AUTH_BOOTSTRAP_TOKEN = randomBytes(24).toString('hex');
  process.env.ODD_AUTH_COOKIE_SECURE = 'false';
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.ASTRA_DATABASE_URL = fixture.connectionString;
  process.env.ASTRA_WORKER_DATABASE_URL = fixture.workerConnectionString;
  process.env.ASTRA_CONTEXT_SECRET = fixture.contextSecret;
  process.env.ASTRA_TENANT_MODE = '1';
  process.env.ASTRA_LEGACY_OFFER_BRIDGE = '1';
  process.env.LOCAL_PREVIEW = '1';
  process.env.ASTRA_LIVE_ACTIONS = 'disabled';
  process.env.ASTRA_GLOBAL_PROVIDER_DECISION = 'unapproved';

  let server;
  let closeDb;
  let qaStore;
  try {
    await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
    ({ server } = await import('../server.js'));
    ({ closeDb } = await import('../pipeline/database.js'));
    const { initDb } = await import('../pipeline/database.js');
    const { createAuthManager } = await import('../pipeline/auth-manager.js');
    const authDb=initDb();
    createAuthManager(authDb);
    const isolatedAuthSequence=1_000_000_000+randomBytes(4).readUInt32BE(0);
    authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
    authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(isolatedAuthSequence);
    if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: await response.json() };
    }
    async function qualificationEvents(campaignId) {
      const events = await request(`${prefix}/events?entityType=astra_campaign&entityId=${campaignId}&limit=100`, { cookie: owner.cookie });
      assert.equal(events.status, 200, events.body?.error);
      return events.body.data.filter(event => event.eventType === 'campaign.qualified');
    }
    function sessionFrom(setCookie) {
      const sessionId = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
      const csrfCookie = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
      assert.ok(sessionId && csrfCookie, 'synthetic owner receives a session');
      return { cookie: `odd_session=${sessionId}; odd_csrf=${csrfCookie}`, csrf: decodeURIComponent(csrfCookie) };
    }
    const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: {
      email: `lineage-${randomBytes(5).toString('hex')}@example.test`, password: 'Synthetic-lineage-pass-9!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    } });
    assert.equal(bootstrap.status, 201, bootstrap.body?.error);
    const owner = sessionFrom(bootstrap.setCookie);
    const tenant = await request('/api/astra/tenants', { method: 'POST', ...owner, body: { name: 'Synthetic qualification lineage' } });
    assert.equal(tenant.status, 201, tenant.body?.error);
    const tenantId = tenant.body.tenant.id;
    const prefix = `/api/astra/tenants/${tenantId}`;
    const [{ createAstraTenantStore },{ readCurrentAstraCampaignAudience },engagement,verifier,generation,autonomy] = await Promise.all([
      import('../pipeline/astra-tenant-store.js'),import('../pipeline/astra-campaign-audience.js'),import('../pipeline/astra-engagement.js'),
      import('../pipeline/astra-verifier-adapter.js'),import('../pipeline/astra-generation.js'),import('../pipeline/astra-autonomy.js'),
    ]);
    qaStore=createAstraTenantStore({connectionString:fixture.connectionString,contextSecret:fixture.contextSecret});
    const qaIdentity={tenantId,userId:String(bootstrap.body.user.id)};
    async function withAstra(work) {
      return qaStore.withTenant(qaIdentity,async(db,membership)=>work(db,{tenantId,userId:membership.userId,tenantRole:membership.tenantRole}));
    }

    const offerBytes = Buffer.from('Synthetic approved offer proof.');
    const proofHash = createHash('sha256').update(offerBytes).digest('hex');
    const offerContent = {
      service: 'SEO audit', scope: 'A synthetic audit with a written findings report.',
      price: { minMinor: 10000, maxMinor: 90000, currency: 'USD' },
      proofAssets: [{ proofId: 'synthetic-proof', reference: 'fixture://qualification-proof',
        contentHash: proofHash, observedAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: '2035-01-01T00:00:00.000Z', rightsBasis: 'Synthetic fixture grant only' }],
      audienceExclusions: [], geography: { includedCountries: ['US'] }, capacity: 10,
      egress: { mode: 'NO_MODEL_EGRESS', allowedDestinations: [] },
    };
    const offer = await request(`${prefix}/offers`, { method: 'POST', ...owner, body: { name: 'Synthetic owned offer', content: offerContent } });
    assert.equal(offer.status, 201, offer.body?.error);
    const { id: offerId, version } = offer.body.offer;
    const upload = await request(`${prefix}/offers/${offerId}/versions/${version.id}/proofs`, { method: 'POST', ...owner, body: {
      proofId: 'synthetic-proof', bytesBase64: offerBytes.toString('base64'), mimeType: 'text/plain', expiresAt: '2035-01-01T00:00:00.000Z', contentHash: proofHash,
    } });
    assert.equal(upload.status, 201, upload.body?.error);
    const approved = await request(`${prefix}/offers/${offerId}/versions/${version.id}/approve`, { method: 'POST', ...owner, body: {} });
    assert.equal(approved.status, 200, approved.body?.error);
    const mailbox = await request(`${prefix}/mailboxes`, { method: 'POST', ...owner, body: {
      displayName: 'Synthetic unverified mailbox', providerMailboxId: 'lineage@example.test', provider: 'manual',
    } });
    assert.equal(mailbox.status, 201, mailbox.body?.error);
    const campaign = await request(`${prefix}/campaigns`, { method: 'POST', ...owner, body: {
      name: 'Synthetic qualification', offerVersionId: version.id, mailboxId: mailbox.body.mailbox.id,
      purpose: 'synthetic_fixture', geography: ['US'], spendLimitMinor: 0, currency: 'USD',
    } });
    assert.equal(campaign.status, 201, campaign.body?.error);
    async function createCampaign(name) {
      const result = await request(`${prefix}/campaigns`, { method: 'POST', ...owner, body: {
        name, offerVersionId: version.id, mailboxId: mailbox.body.mailbox.id,
        purpose: 'synthetic_fixture', geography: ['US'], spendLimitMinor: 0, currency: 'USD',
      } });
      assert.equal(result.status, 201, result.body?.error);
      return result.body.campaign;
    }

    async function snapshot(pathname, html, rightsExpiresAt = '2035-01-01T00:00:00.000Z', domain = 'split-proof.synthetic.example.test') {
      const result = await request(`${prefix}/research/snapshots`, { method: 'POST', ...owner, body: {
        sourceUrl: `https://${domain}${pathname}`, rightsPolicy: 'synthetic_fixture', rightsAttested: true,
        robotsAllowed: true, rightsExpiresAt, html,
      } });
      assert.equal(result.status, 201, result.body?.error);
      return result.body.data;
    }
    async function claim(evidence, predicate, value, excerpt, expiresAt = '2035-01-01T00:00:00.000Z') {
      const result = await request(`${prefix}/research/claims`, { method: 'POST', ...owner, body: {
        evidenceId: evidence.evidence.id, contentSha256: evidence.evidence.contentSha256, subjectKey: evidence.account.normalizedDomain,
        predicate, value, exactExcerpt: excerpt, expiresAt,
      } });
      assert.equal(result.status, 201, result.body?.error);
      return result.body.data;
    }
    async function geographyFixture(label,{domain=`${label}.synthetic.example.test`,html,excerpt,value='US',expiresAt='2035-01-01T00:00:00.000Z'}={}) {
      const evidence=await snapshot('/geography',html,'2035-01-01T00:00:00.000Z',domain);
      const geographyClaim=await claim(evidence,'geography.country',value,excerpt,expiresAt);
      return {domain,evidence,claim:geographyClaim};
    }
    async function currentGeography({claimId,domain,country,allowedCountries=['US','CA']}) {
      return withAstra(db=>autonomy.resolveCurrentAstraGeographyProof(db,{tenantId,claimId,domain,country,allowedCountries}));
    }
    async function insertSyntheticCorrection({claimId,evidence,excerpt,claimValue='CA',createdAt=null,contentSha256=evidence.evidence.contentSha256}) {
      const correctionId=randomUUID();
      await withAstra((db,actor)=>db.query(`INSERT INTO astra.research_claim_corrections
        (tenant_id,id,claim_id,correction_type,replacement_value,evidence_id,content_sha256,exact_excerpt,reason,created_by,created_at)
        VALUES($1,$2,$3,'corrected',$4,$5,$6,$7,'synthetic geography-proof validator fixture',$8,COALESCE($9::timestamptz,clock_timestamp()))`,
      [tenantId,correctionId,claimId,claimValue,evidence.evidence.id,contentSha256,excerpt,String(actor.userId),createdAt]));
      return correctionId;
    }

    const geoBaseline=await geographyFixture('geo-baseline',{html:'<p>North Example country is US.</p>',excerpt:'North Example country is US.'});
    assert.ok(await currentGeography({claimId:geoBaseline.claim.id,domain:geoBaseline.domain,country:'US'}),
      'geography proof validator accepts exact current source-backed proof');
    const geoCorrected=await geographyFixture('geo-corrected',{html:'<p>South Example country was US.</p>',excerpt:'South Example country was US.'});
    const geoReplacement=await snapshot('/replacement','<p>South Example country is CA.</p>','2035-01-01T00:00:00.000Z',geoCorrected.domain);
    const geoCorrection=await request(`${prefix}/research/claims/${geoCorrected.claim.id}/corrections`,{method:'POST',...owner,body:{
      correctionType:'corrected',replacementValue:'CA',evidenceId:geoReplacement.evidence.id,
      contentSha256:geoReplacement.evidence.contentSha256,exactExcerpt:'South Example country is CA.',reason:'Synthetic valid geography correction',
    }});
    assert.equal(geoCorrection.status,201,geoCorrection.body?.error);
    assert.ok(await currentGeography({claimId:geoCorrected.claim.id,domain:geoCorrected.domain,country:'CA'}),
      'geography validator uses the valid corrected replacement proof and value');
    assert.equal(await currentGeography({claimId:geoCorrected.claim.id,domain:geoCorrected.domain,country:'US'}),null,
      'geography validator rejects the superseded original value');

    const geoWrongValue=await geographyFixture('geo-wrong-value',{html:'<p>Value Example country was US.</p>',excerpt:'Value Example country was US.'});
    const wrongValueReplacement=await snapshot('/replacement','<p>Value Example country is MX.</p>','2035-01-01T00:00:00.000Z',geoWrongValue.domain);
    await insertSyntheticCorrection({claimId:geoWrongValue.claim.id,evidence:wrongValueReplacement,excerpt:'Value Example country is MX.',claimValue:'MX'});
    assert.equal(await currentGeography({claimId:geoWrongValue.claim.id,domain:geoWrongValue.domain,country:'CA'}),null,
      'a valid effective proof for a country outside the authorized expected value cannot satisfy geography intent');

    const geoHash=await geographyFixture('geo-bad-hash',{html:'<p>Hash Example country is US.</p>',excerpt:'Hash Example country is US.'});
    const hashReplacement=await snapshot('/replacement','<p>Hash Example country is CA.</p>','2035-01-01T00:00:00.000Z',geoHash.domain);
    await assert.rejects(()=>insertSyntheticCorrection({claimId:geoHash.claim.id,evidence:hashReplacement,
      excerpt:'Hash Example country is CA.',contentSha256:'0'.repeat(64)}),error=>error.code==='23503',
    'PostgreSQL composite evidence/hash foreign key refuses a mismatched correction hash');
    assert.ok(await currentGeography({claimId:geoHash.claim.id,domain:geoHash.domain,country:'US'}),
      'a rejected malformed hash cannot replace the valid current geography proof');

    const geoExcerpt=await geographyFixture('geo-bad-excerpt',{html:'<p>Excerpt Example country is US.</p>',excerpt:'Excerpt Example country is US.'});
    const excerptReplacement=await snapshot('/replacement','<p>Excerpt Example country is CA.</p>','2035-01-01T00:00:00.000Z',geoExcerpt.domain);
    await insertSyntheticCorrection({claimId:geoExcerpt.claim.id,evidence:excerptReplacement,excerpt:'Excerpt Example country is MX.',claimValue:'CA'});
    assert.equal(await currentGeography({claimId:geoExcerpt.claim.id,domain:geoExcerpt.domain,country:'CA'}),null,
      'a current correction with a non-literal exact excerpt is rejected');

    const geoDomain=await geographyFixture('geo-bad-domain',{html:'<p>Domain Example country is US.</p>',excerpt:'Domain Example country is US.'});
    const foreignGeoReplacement=await snapshot('/replacement','<p>Domain Example country is CA.</p>','2035-01-01T00:00:00.000Z','foreign-geography.synthetic.example.test');
    await insertSyntheticCorrection({claimId:geoDomain.claim.id,evidence:foreignGeoReplacement,excerpt:'Domain Example country is CA.',claimValue:'CA'});
    assert.equal(await currentGeography({claimId:geoDomain.claim.id,domain:geoDomain.domain,country:'CA'}),null,
      'a correction backed by another source domain is rejected');

    const geoRights=await geographyFixture('geo-short-rights',{html:'<p>Rights Example country is US.</p>',excerpt:'Rights Example country is US.'});
    const shortRightsExpiry=new Date(Date.now()+5000).toISOString();
    const shortRightsReplacement=await snapshot('/replacement','<p>Rights Example country is CA.</p>',shortRightsExpiry,geoRights.domain);
    await insertSyntheticCorrection({claimId:geoRights.claim.id,evidence:shortRightsReplacement,excerpt:'Rights Example country is CA.',claimValue:'CA'});
    assert.equal(await currentGeography({claimId:geoRights.claim.id,domain:geoRights.domain,country:'CA'}),null,
      'corrected source rights that expire before the claim are rejected');

    const geoExpiry=await geographyFixture('geo-expiring-claim',{html:'<p>Expiry Example country is US.</p>',excerpt:'Expiry Example country is US.',expiresAt:new Date(Date.now()+1500).toISOString()});
    assert.ok(await currentGeography({claimId:geoExpiry.claim.id,domain:geoExpiry.domain,country:'US'}));
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,new Date(geoExpiry.claim.expiresAt).valueOf()-Date.now()+100)));
    assert.equal(await currentGeography({claimId:geoExpiry.claim.id,domain:geoExpiry.domain,country:'US'}),null,
      'an expired geography claim cannot authorize a country');

    const geoRetraction=await geographyFixture('geo-retracted',{html:'<p>Retraction Example country is US.</p>',excerpt:'Retraction Example country is US.'});
    const geoRetractionResult=await request(`${prefix}/research/claims/${geoRetraction.claim.id}/corrections`,{method:'POST',...owner,body:{
      correctionType:'retracted',reason:'Synthetic geography retraction',
    }});
    assert.equal(geoRetractionResult.status,201,geoRetractionResult.body?.error);
    assert.equal(await currentGeography({claimId:geoRetraction.claim.id,domain:geoRetraction.domain,country:'US'}),null,
      'retracted geography proof cannot authorize a country');

    const geoTied=await geographyFixture('geo-tied',{html:'<p>Tied Example country was US.</p>',excerpt:'Tied Example country was US.'});
    const tiedReplacement=await snapshot('/replacement','<p>Tied Example country is CA.</p>','2035-01-01T00:00:00.000Z',geoTied.domain);
    const tiedAt='2030-01-01T00:00:00.123456Z';
    await insertSyntheticCorrection({claimId:geoTied.claim.id,evidence:tiedReplacement,excerpt:'Tied Example country is CA.',claimValue:'CA',createdAt:tiedAt});
    await insertSyntheticCorrection({claimId:geoTied.claim.id,evidence:tiedReplacement,excerpt:'Tied Example country is CA.',claimValue:'CA',createdAt:tiedAt});
    assert.equal(await currentGeography({claimId:geoTied.claim.id,domain:geoTied.domain,country:'CA'}),null,
      'equal newest correction timestamps are ambiguous and fail closed');

    const industryPage = await snapshot('/industry', '<p>Example Works industry: manufacturing.</p>');
    const countryPage = await snapshot('/country', '<p>Example Works country: US.</p>');
    const contactPage = await snapshot('/contact', '<p>Contact synthetic.owner@example.test for Example Works.</p>');
    const industryClaim = await claim(industryPage, 'industry', 'manufacturing', 'Example Works industry: manufacturing.');
    const countryClaim = await claim(countryPage, 'country', 'US', 'Example Works country: US.');
    assert.equal(industryClaim.status, 'supported');
    assert.equal(countryClaim.status, 'supported');

    const qualification = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/qualification`, { method: 'POST', ...owner, body: { accountIds: [industryPage.account.id] } });
    assert.equal(qualification.status, 200, qualification.body?.error);
    const result = qualification.body.qualification.results[0];
    assert.equal(qualification.body.qualification.fitCount, 1, `synthetic baseline should fit: ${JSON.stringify(result)}`);
    assert.equal(result.email, 'synthetic.owner@example.test');
    assert.equal(result.permission, 'not_evaluated');
    assert.equal(result.mailboxVerified, false);
    assert.equal(result.emailEvidenceId, contactPage.evidence.id);
    const originalCandidateId=result.candidateId;
    assert.equal(result.claimRefs.length, 2);
    const firstAudience=await withAstra(db=>readCurrentAstraCampaignAudience(db,tenantId,campaign.body.campaign.id));
    const firstMember=firstAudience.rows.find(item=>item.account_id===industryPage.account.id);
    assert.equal(firstMember?.candidate_id,originalCandidateId);
    assert.equal(firstMember?.current,true,'the current proof and exact contact evidence validate the approval-bound snapshot');
    const initialGenerationClaims=await withAstra(db=>generation.currentAstraCampaignClaims(db,tenantId,campaign.body.campaign.id));
    assert.deepEqual(new Set(initialGenerationClaims.map(row=>row.id)),new Set([industryClaim.id,countryClaim.id]),
      'generation context contains only claims from the current qualified audience');
    const emailDigest=createHash('sha256').update(String(firstMember.normalized_value).toLowerCase()).digest('hex');
    const initialVerificationMemberships=await withAstra(db=>verifier.currentAstraVerificationCampaignMemberships(db,tenantId,originalCandidateId,emailDigest));
    assert.ok(initialVerificationMemberships.includes(campaign.body.campaign.id),'a verifier result fans out to the exact currently qualified candidate');
    const campaignReadback = await request(`${prefix}/campaigns/${campaign.body.campaign.id}`, { cookie: owner.cookie });
    assert.equal(campaignReadback.status, 200, campaignReadback.body?.error);
    const audience = campaignReadback.body.campaign.audience;
    assert.equal(audience.length, 1);
    const persistedRefs = audience[0].claimRefs;
    assert.deepEqual(new Set(persistedRefs.map(ref => ref.predicate)), new Set(['industry', 'country']));
    const byPredicate = new Map(persistedRefs.map(ref => [ref.predicate, ref]));
    assert.equal(byPredicate.get('industry').evidenceId, industryPage.evidence.id);
    assert.equal(byPredicate.get('country').evidenceId, countryPage.evidence.id);
    assert.equal(byPredicate.get('industry').sourceId, industryPage.evidence.sourceId);
    assert.equal(byPredicate.get('industry').exactExcerpt, 'Example Works industry: manufacturing.');
    assert.equal(byPredicate.get('country').sourceId, countryPage.evidence.sourceId);
    assert.equal(byPredicate.get('country').exactExcerpt, 'Example Works country: US.');
    assert.notEqual(byPredicate.get('industry').evidenceId, contactPage.evidence.id);
    assert.notEqual(byPredicate.get('country').evidenceId, contactPage.evidence.id);
    assert.equal(audience[0].email, 'synthetic.owner@example.test');
    assert.equal((await qualificationEvents(campaign.body.campaign.id)).length, 1);
    const originalVersion = campaignReadback.body.campaign.version;
    const otherTenant = await request('/api/astra/tenants', { method: 'POST', ...owner, body: { name: 'Synthetic isolated proof tenant' } });
    assert.equal(otherTenant.status, 201, otherTenant.body?.error);
    const otherSnapshot = await request(`/api/astra/tenants/${otherTenant.body.tenant.id}/research/snapshots`, { method: 'POST', ...owner, body: {
      sourceUrl: 'https://foreign-account.synthetic.example.test/industry', rightsPolicy: 'synthetic_fixture', rightsAttested: true,
      robotsAllowed: true, rightsExpiresAt: '2035-01-01T00:00:00.000Z', html: '<p>Foreign Account is in manufacturing.</p>',
    } });
    assert.equal(otherSnapshot.status, 201, otherSnapshot.body?.error);
    const crossTenantQualification = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/qualification`, { method: 'POST', ...owner, body: { accountIds: [otherSnapshot.body.data.account.id] } });
    assert.equal(crossTenantQualification.status, 200, crossTenantQualification.body?.error);
    assert.deepEqual(crossTenantQualification.body.qualification.results[0].reasons, ['account_not_found']);
    const crossTenantCorrection = await request(`${prefix}/research/claims/${industryClaim.id}/corrections`, { method: 'POST', ...owner, body: {
      correctionType: 'corrected', replacementValue: 'manufacturing', evidenceId: otherSnapshot.body.data.evidence.id,
      contentSha256: otherSnapshot.body.data.evidence.contentSha256, exactExcerpt: 'Foreign Account is in manufacturing.', reason: 'Synthetic cross-tenant correction rejection',
    } });
    assert.equal(crossTenantCorrection.status, 409, 'correction evidence cannot cross the tenant boundary');
    const unchangedAfterForeign = await request(`${prefix}/campaigns/${campaign.body.campaign.id}`, { cookie: owner.cookie });
    assert.equal(unchangedAfterForeign.body.campaign.version, originalVersion);
    const replay = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/qualification`, { method: 'POST', ...owner, body: { accountIds: [industryPage.account.id] } });
    assert.equal(replay.status, 200, replay.body?.error);
    assert.equal(replay.body.qualification.fitCount, 1);
    const replayReadback = await request(`${prefix}/campaigns/${campaign.body.campaign.id}`, { cookie: owner.cookie });
    assert.deepEqual(replayReadback.body.campaign.audience,campaignReadback.body.campaign.audience,'unchanged account proof and audience values are stable');
    assert.equal(replayReadback.body.campaign.version, originalVersion, 'unchanged same-campaign requalification is idempotent');
    assert.equal((await qualificationEvents(campaign.body.campaign.id)).length, 1, 'unchanged replay appends no duplicate qualification audit event');

    const mergeDomain = 'incremental-merge.synthetic.example.test';
    const mergeIndustryPage = await snapshot('/industry', '<p>Merge Works industry is manufacturing.</p>', '2035-01-01T00:00:00.000Z', mergeDomain);
    const mergeCountryPage = await snapshot('/country', '<p>Merge Works country is US.</p>', '2035-01-01T00:00:00.000Z', mergeDomain);
    await snapshot('/contact', '<p>Contact merge.owner@example.test for Merge Works.</p>', '2035-01-01T00:00:00.000Z', mergeDomain);
    const mergeIndustryClaim=await claim(mergeIndustryPage, 'industry', 'manufacturing', 'Merge Works industry is manufacturing.');
    const mergeCountryClaim=await claim(mergeCountryPage, 'country', 'US', 'Merge Works country is US.');
    const mergeQualification = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/qualification`, { method: 'POST', ...owner, body: { accountIds: [mergeIndustryPage.account.id] } });
    assert.equal(mergeQualification.status, 200, mergeQualification.body?.error);
    assert.equal(mergeQualification.body.qualification.fitCount, 1);
    const mergedReadback = await request(`${prefix}/campaigns/${campaign.body.campaign.id}`, { cookie: owner.cookie });
    assert.equal(mergedReadback.body.campaign.audience.length, 2, 'qualifying one new account preserves the prior current audience');
    assert.ok(mergedReadback.body.campaign.audience.some(item => item.accountId === industryPage.account.id && item.status === 'fit'));
    assert.equal(mergedReadback.body.campaign.version, originalVersion + 1);
    assert.equal((await qualificationEvents(campaign.body.campaign.id)).length, 2);

    await withAstra(async(db,actor)=>{
      await engagement.setAstraTrackingPermission(db,actor,{campaignId:campaign.body.campaign.id,enabled:true,reasonCode:'synthetic_history_fixture'});
    });
    async function recordHistoricalOpen(candidateId) {
      return withAstra(async(db,actor)=>{
        const token=await engagement.prepareAstraTrackingToken(db,actor,{campaignId:campaign.body.campaign.id,recipientId:candidateId,kind:'pixel'});
        assert.equal(token.trackingEnabled,false,'explicit tracking permission still leaves token disabled pending a separate enablement path');
        await assert.rejects(()=>engagement.recordAstraEngagementEvent(db,actor,{token:token.token,eventType:'open',diagnostic:'human'}),
          error=>error.code==='tracking_token_not_found','disabled tracking tokens cannot record accepted events');
        // The R18 app role permits INSERT into this tenant-scoped event table.
        // This fixture-only historical observation tests attribution without
        // enabling/updating the token or claiming the ingestion gate passed.
        await db.query(`INSERT INTO astra.engagement_events(tenant_id,id,tracking_token_id,event_type,diagnostic,provider_event_id,occurred_at,created_by)
          VALUES($1,$2,$3,'open','human',$4,clock_timestamp(),$5)`,
        [tenantId,randomUUID(),token.id,`synthetic-history-${randomBytes(5).toString('hex')}`,String(actor.userId)]);
        return token;
      });
    }
    await recordHistoricalOpen(originalCandidateId);
    const replacementContact=await snapshot('/replacement-contact','<p>Contact synthetic.owner@example.test for Example Works.</p>');
    assert.equal(replacementContact.account.id,industryPage.account.id,'the later candidate belongs to the same synthetic account');
    const rightsRoute=id=>`${prefix}/research/sources/${id}/rights`;
    const revocationRoute=id=>`${prefix}/research/sources/${id}/rights-revocations`;
    const oldContactRightsBefore=await request(rightsRoute(contactPage.evidence.sourceId),{cookie:owner.cookie});
    assert.equal(oldContactRightsBefore.status,200,oldContactRightsBefore.body?.error);
    assert.equal(oldContactRightsBefore.body.data.usable,true,'the original contact source remains usable before explicit revocation');
    const oldContactRevocation=await request(revocationRoute(contactPage.evidence.sourceId),{method:'POST',...owner,body:{
      reason:'Synthetic lineage replacement withdraws the former contact source.',
      idempotencyKey:`lineage-replacement-${randomUUID()}`,
    }});
    assert.equal(oldContactRevocation.status,201,oldContactRevocation.body?.error);
    const [oldContactRightsAfter,replacementContactRights,industryRights,countryRights]=await Promise.all([
      request(rightsRoute(contactPage.evidence.sourceId),{cookie:owner.cookie}),
      request(rightsRoute(replacementContact.evidence.sourceId),{cookie:owner.cookie}),
      request(rightsRoute(industryPage.evidence.sourceId),{cookie:owner.cookie}),
      request(rightsRoute(countryPage.evidence.sourceId),{cookie:owner.cookie}),
    ]);
    for(const [name,result] of [['old contact',oldContactRightsAfter],['replacement contact',replacementContactRights],['industry proof',industryRights],['country proof',countryRights]]) {
      assert.equal(result.status,200,`${name} rights read succeeds: ${result.body?.error || ''}`);
    }
    assert.equal(oldContactRightsAfter.body.data.effectiveRightsStatus,'revoked','the former captured contact source is revoked explicitly');
    assert.equal(oldContactRightsAfter.body.data.usable,false,'the former captured contact source cannot qualify a current candidate');
    assert.equal(replacementContactRights.body.data.effectiveRightsStatus,'permitted');
    assert.equal(replacementContactRights.body.data.usable,true,'the separate same-email capture is explicitly current and usable');
    assert.equal(industryRights.body.data.usable,true,'the independent industry proof remains permitted');
    assert.equal(countryRights.body.data.usable,true,'the independent country proof remains permitted');
    const replacementQualification=await request(`${prefix}/campaigns/${campaign.body.campaign.id}/qualification`,{method:'POST',...owner,body:{accountIds:[industryPage.account.id]}});
    assert.equal(replacementQualification.status,200,replacementQualification.body?.error);
    assert.equal(replacementQualification.body.qualification.fitCount,1);
    const replacementCandidateId=replacementQualification.body.qualification.results[0].candidateId;
    assert.notEqual(replacementCandidateId,originalCandidateId,'later qualification introduces a distinct candidate identity');
    assert.equal(replacementQualification.body.qualification.results[0].email,'synthetic.owner@example.test',
      'the replacement candidate intentionally has the same normalized email as its former identity');
    const replacementAudience=await withAstra(db=>readCurrentAstraCampaignAudience(db,tenantId,campaign.body.campaign.id));
    assert.equal(replacementAudience.rows.find(item=>item.account_id===industryPage.account.id)?.candidate_id,replacementCandidateId);
    assert.equal(replacementAudience.rows.some(item=>item.candidate_id===originalCandidateId&&item.current),false,
      'an earlier candidate cannot borrow current membership after replacement');
    const [replacementVerificationMemberships,formerVerificationMemberships]=await Promise.all([
      withAstra(db=>verifier.currentAstraVerificationCampaignMemberships(db,tenantId,replacementCandidateId,emailDigest)),
      withAstra(db=>verifier.currentAstraVerificationCampaignMemberships(db,tenantId,originalCandidateId,emailDigest)),
    ]);
    assert.ok(replacementVerificationMemberships.includes(campaign.body.campaign.id),
      'same-email verifier fan-out attaches only the replacement candidate to its current campaign');
    assert.equal(formerVerificationMemberships.includes(campaign.body.campaign.id),false,
      'a same-email provider result bound to the former candidate cannot be reused for the replacement candidate');
    await withAstra(async(db,actor)=>{
      await assert.rejects(()=>engagement.prepareAstraTrackingToken(db,actor,{campaignId:campaign.body.campaign.id,recipientId:originalCandidateId,kind:'pixel'}),
        error=>error.code==='campaign_recipient_not_current','a former candidate cannot mint a new current-context token');
    });
    const replacementToken=await recordHistoricalOpen(replacementCandidateId);
    assert.equal(replacementToken.trackingEnabled,false,'replacement candidate tracking also remains disabled by default');

    const correctedPage = await snapshot('/corrected-industry', '<p>Example Works current industry: software.</p>');
    const correction = await request(`${prefix}/research/claims/${industryClaim.id}/corrections`, { method: 'POST', ...owner, body: {
      correctionType: 'corrected', replacementValue: 'software', evidenceId: correctedPage.evidence.id,
      contentSha256: correctedPage.evidence.contentSha256, exactExcerpt: 'Example Works current industry: software.', reason: 'Synthetic correction proof fixture',
    } });
    assert.equal(correction.status, 201, correction.body?.error);
    const foreignPage = await snapshot('/foreign', '<p>Example Works current industry: retail.</p>', '2035-01-01T00:00:00.000Z', 'foreign-proof.synthetic.example.test');
    const foreignCorrection = await request(`${prefix}/research/claims/${industryClaim.id}/corrections`, { method: 'POST', ...owner, body: {
      correctionType: 'corrected', replacementValue: 'retail', evidenceId: foreignPage.evidence.id,
      contentSha256: foreignPage.evidence.contentSha256, exactExcerpt: 'Example Works current industry: retail.', reason: 'Synthetic foreign-domain proof rejection',
    } });
    assert.equal(foreignCorrection.status, 409, 'same-tenant proof from a different account domain cannot correct the claim');
    const correctedQualification = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/qualification`, { method: 'POST', ...owner, body: { accountIds: [industryPage.account.id] } });
    assert.equal(correctedQualification.status, 200, correctedQualification.body?.error);
    assert.equal(correctedQualification.body.qualification.fitCount, 1);
    const correctedRefs = correctedQualification.body.qualification.results[0].claimRefs;
    const correctedIndustry = correctedRefs.find(ref => ref.predicate === 'industry');
    assert.equal(correctedIndustry.value, 'software');
    assert.equal(correctedIndustry.evidenceId, correctedPage.evidence.id, 'corrected claim references replacement proof');
    assert.equal(correctedIndustry.contentSha256, correctedPage.evidence.contentSha256);
    assert.equal(correctedIndustry.sourceId, correctedPage.evidence.sourceId);
    assert.equal(correctedIndustry.exactExcerpt, 'Example Works current industry: software.');
    assert.equal(correctedIndustry.correctionId, correction.body.data.id);
    const changedReadback = await request(`${prefix}/campaigns/${campaign.body.campaign.id}`, { cookie: owner.cookie });
    assert.equal(changedReadback.body.campaign.version, originalVersion + 3, 'changed proof increments the approval-bound campaign snapshot version after the replacement candidate version');
    assert.equal((await qualificationEvents(campaign.body.campaign.id)).length, 4);

    const composer = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/composer`, { cookie: owner.cookie });
    assert.equal(composer.status, 200, composer.body?.error);
    const currentTemplates = composer.body.composer.templates;
    const industryTemplate = currentTemplates.find(item => item.claimId === correctedIndustry.claimId
      && item.businessDomain === industryPage.account.normalizedDomain);
    const countryTemplate = currentTemplates.find(item => item.claimId === countryClaim.id
      && item.businessDomain === industryPage.account.normalizedDomain);
    assert.ok(industryTemplate, 'current composer supplies a source template for corrected industry proof');
    assert.ok(countryTemplate, 'current composer supplies a source template for current country proof');
    const supportedMappings = [industryTemplate,countryTemplate].map(item => ({
      sentence:item.renderedText,claimIds:[item.claimId],templateId:item.templateId,
    }));
    const savedDraft = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/draft`, { method: 'PUT', ...owner, body: {
      expectedVersion: changedReadback.body.campaign.version,
      subject: composer.body.composer.templates.find(item => item.placement === 'subject').renderedText,
      body: supportedMappings.map(item => item.sentence).join('\n'),claimsMap:supportedMappings,
    } });
    assert.equal(savedDraft.status, 200, savedDraft.body?.error);
    const approval = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/approvals`, { method: 'POST', ...owner, body: {
      expectedVersion: savedDraft.body.draft.version, expiresAt: new Date(Date.now() + 86400000).toISOString(),
    } });
    assert.equal(approval.status, 201, approval.body?.error);
    const offlinePlan = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/dispatch-plans`, { method: 'POST', ...owner, body: { idempotencyKey: `lineage-before-retract-${randomBytes(5).toString('hex')}` } });
    assert.equal(offlinePlan.status, 201, offlinePlan.body?.error);
    assert.ok(offlinePlan.body.plan.blockers.includes('live_dispatch_disabled'));
    const recheckPlan = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/dispatch-plans`, { method: 'POST', ...owner, body: { idempotencyKey: `lineage-lease-after-retract-${randomBytes(5).toString('hex')}` } });
    assert.equal(recheckPlan.status, 201, recheckPlan.body?.error);
    const quarantined = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/dispatch-plans/${offlinePlan.body.plan.id}/claim`, { method: 'POST', ...owner, body: { idempotencyKey: `lineage-lease-${randomBytes(5).toString('hex')}` } });
    assert.equal(quarantined.status, 201, quarantined.body?.error);
    assert.equal(quarantined.body.claim.state, 'quarantined');
    assert.ok(quarantined.body.claim.blockers.includes('live_dispatch_disabled'));

    const retraction = await request(`${prefix}/research/claims/${countryClaim.id}/corrections`, { method: 'POST', ...owner, body: {
      correctionType: 'retracted', reason: 'Synthetic source correction fixture',
    } });
    assert.equal(retraction.status, 201, retraction.body?.error);
    const retractedQualification = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/qualification`, { method: 'POST', ...owner, body: { accountIds: [industryPage.account.id] } });
    assert.equal(retractedQualification.status, 200, retractedQualification.body?.error);
    assert.equal(retractedQualification.body.qualification.fitCount, 0, 'same campaign can append a blocked current qualification after retraction');
    const currentAfterRetraction = await request(`${prefix}/campaigns/${campaign.body.campaign.id}`, { cookie: owner.cookie });
    assert.ok(currentAfterRetraction.body.campaign.audience.some(item => item.accountId === industryPage.account.id && item.status === 'blocked'),
      'append-only qualification receipt is not treated as the current result');
    assert.ok(currentAfterRetraction.body.campaign.audience.some(item => item.accountId === mergeIndustryPage.account.id && item.status === 'fit'),
      'rechecking one account preserves unrelated current audience entries');
    const staleAudience=await withAstra(db=>readCurrentAstraCampaignAudience(db,tenantId,campaign.body.campaign.id));
    assert.equal(staleAudience.rows.find(item=>item.account_id===industryPage.account.id)?.current,false,
      'stale saved fit is blocked after its source claim is retracted');
    const currentGenerationClaims=await withAstra(db=>generation.currentAstraCampaignClaims(db,tenantId,campaign.body.campaign.id));
    assert.equal(currentGenerationClaims.some(row=>[industryClaim.id,countryClaim.id].includes(row.id)),false,
      'generation context drops claims available only through the retracted former account');
    assert.deepEqual(new Set(currentGenerationClaims.map(row=>row.id)),new Set([mergeIndustryClaim.id,mergeCountryClaim.id]),
      'generation retains supported claims from the unrelated current account');
    const historicalMetrics=await withAstra(db=>engagement.getAstraEngagementMetrics(db,tenantId,campaign.body.campaign.id));
    assert.equal(historicalMetrics.uniqueHumanOpens,1,'old and replacement candidate observations retain one immutable account attribution after the later audience change');
    assert.equal(historicalMetrics.rawOpens,2,'both fixture-only historical observations remain recorded');
    const approvalsBeforeStaleAttempt = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/approvals`, { cookie: owner.cookie });
    assert.equal(approvalsBeforeStaleAttempt.status, 200, approvalsBeforeStaleAttempt.body?.error);
    const staleApproval = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/approvals`, { method: 'POST', ...owner, body: {
      expectedVersion: currentAfterRetraction.body.campaign.version, expiresAt: new Date(Date.now() + 86400000).toISOString(),
    } });
    assert.equal(staleApproval.status, 409, 'approval refuses a stale corrected/retracted claim mapping');
    assert.match(staleApproval.body.error, /Current research proof or copy support is stale/);
    const approvalReadback = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/approvals`, { cookie: owner.cookie });
    assert.equal(approvalReadback.status, 200, approvalReadback.body?.error);
    assert.equal(approvalReadback.body.items.length, approvalsBeforeStaleAttempt.body.items.length,
      'stale proof rejection creates no approval row');
    assert.ok(approvalReadback.body.items.every(item => item.current === false), 'stored approval is no longer current after proof retraction');
    const staleDraft = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/draft`, { method: 'PUT', ...owner, body: {
      expectedVersion: currentAfterRetraction.body.campaign.version,
      subject: 'The software sector', body: 'Example Works is in US.',
      claimsMap: [
        { sentence: 'The software sector', claimIds: [industryClaim.id] },
        { sentence: 'Example Works is in US.', claimIds: [countryClaim.id] },
      ],
    } });
    assert.equal(staleDraft.status, 200, staleDraft.body?.error);
    assert.equal(staleDraft.body.validation.status, 'unverified', 'stale unsupported copy can be saved only as unverified');
    assert.equal(staleDraft.body.validation.eligible, false);
    assert.ok(staleDraft.body.validation.reasons.includes('subject_not_supported_template'));
    assert.ok(staleDraft.body.validation.reasons.includes('copy_contains_unmapped_or_unsupported_text'));
    const staleDraftReadback = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/composer`, { cookie: owner.cookie });
    assert.equal(staleDraftReadback.status, 200, staleDraftReadback.body?.error);
    assert.equal(staleDraftReadback.body.composer.validation.status, 'unverified');
    assert.equal(staleDraftReadback.body.composer.validation.eligible, false,
      'reload preserves the saved stale draft as explicitly unverified');
    const approvalsBeforeUnverifiedAttempt = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/approvals`, { cookie: owner.cookie });
    const unverifiedApproval = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/approvals`, { method: 'POST', ...owner, body: {
      expectedVersion: staleDraft.body.draft.version, expiresAt: new Date(Date.now() + 86400000).toISOString(),
    } });
    assert.equal(unverifiedApproval.status, 409, 'an unverified stale draft cannot be approved');
    assert.match(unverifiedApproval.body.error, /Current research proof or copy support is stale/);
    const approvalsAfterUnverifiedAttempt = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/approvals`, { cookie: owner.cookie });
    assert.equal(approvalsAfterUnverifiedAttempt.body.items.length, approvalsBeforeUnverifiedAttempt.body.items.length,
      'unverified draft approval rejection adds no approval row');
    assert.ok(approvalsAfterUnverifiedAttempt.body.items.every(item => item.current === false),
      'the prior approval remains non-current after an unverified draft save');
    const stalePlan = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/dispatch-plans`, { method: 'POST', ...owner, body: { idempotencyKey: `lineage-after-retract-${randomBytes(5).toString('hex')}` } });
    assert.equal(stalePlan.status, 201, stalePlan.body?.error);
    assert.ok(stalePlan.body.plan.blockers.includes('copy_claim_or_source_rights_stale'));
    const staleLease = await request(`${prefix}/campaigns/${campaign.body.campaign.id}/dispatch-plans/${recheckPlan.body.plan.id}/claim`, { method: 'POST', ...owner, body: { idempotencyKey: `lineage-stale-lease-${randomBytes(5).toString('hex')}` } });
    assert.equal(staleLease.status, 201, staleLease.body?.error);
    assert.ok(staleLease.body.claim.blockers.includes('copy_claim_or_source_rights_stale'));
    assert.ok(staleLease.body.claim.blockers.includes('qualification_proof_stale'));

    const shortExpiry = new Date(Date.now() + 6000).toISOString();
    const shortDomain = 'short-rights.synthetic.example.test';
    const shortIndustry = await snapshot('/industry', '<p>Short Rights works in manufacturing.</p>', shortExpiry, shortDomain);
    const shortCountry = await snapshot('/country', '<p>Short Rights country is US.</p>', shortExpiry, shortDomain);
    const shortContact = await snapshot('/contact', '<p>Contact short.owner@example.test for Short Rights.</p>', shortExpiry, shortDomain);
    const shortIndustryClaim = await claim(shortIndustry, 'industry', 'manufacturing', 'Short Rights works in manufacturing.', shortExpiry);
    await claim(shortCountry, 'country', 'US', 'Short Rights country is US.', shortExpiry);
    const shortCampaign = await createCampaign('Synthetic short rights qualification');
    const shortQualification = await request(`${prefix}/campaigns/${shortCampaign.id}/qualification`, { method: 'POST', ...owner, body: { accountIds: [shortIndustry.account.id] } });
    assert.equal(shortQualification.status, 200, shortQualification.body?.error);
    assert.equal(shortQualification.body.qualification.fitCount, 1, 'current proof with future but short rights can qualify');
    assert.ok(shortContact.evidence.id);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, new Date(shortExpiry).valueOf() - Date.now() + 150)));
    const expiredPlan = await request(`${prefix}/campaigns/${shortCampaign.id}/dispatch-plans`, { method: 'POST', ...owner, body: { idempotencyKey: `lineage-expired-plan-${randomBytes(5).toString('hex')}` } });
    assert.equal(expiredPlan.status, 201, expiredPlan.body?.error);
    assert.ok(expiredPlan.body.plan.items[0].blockers.includes('qualification_proof_stale'), 'expired evidence cannot be reused from a saved fit snapshot');
    assert.ok(shortIndustryClaim.id);

    const ambiguousDomain = 'ambiguous-proof.synthetic.example.test';
    const ambiguousIndustryPage = await snapshot('/industry', '<p>Ambiguous Holdings industry is manufacturing.</p>', '2035-01-01T00:00:00.000Z', ambiguousDomain);
    const ambiguousCountryPage = await snapshot('/country', '<p>Ambiguous Holdings country is US.</p>', '2035-01-01T00:00:00.000Z', ambiguousDomain);
    await snapshot('/contact', '<p>Contact ambiguous.owner@example.test for Ambiguous Holdings.</p>', '2035-01-01T00:00:00.000Z', ambiguousDomain);
    const ambiguousIndustry = await claim(ambiguousIndustryPage, 'industry', 'manufacturing', 'Ambiguous Holdings industry is manufacturing.');
    await claim(ambiguousCountryPage, 'country', 'US', 'Ambiguous Holdings country is US.');
    const shortCorrectionExpiry = new Date(Date.now() + 30000).toISOString();
    const shortCorrectionProof = await snapshot('/short-correction', '<p>Ambiguous Holdings current industry is software.</p>', shortCorrectionExpiry, ambiguousDomain);
    const shortCorrection = await request(`${prefix}/research/claims/${ambiguousIndustry.id}/corrections`, { method: 'POST', ...owner, body: {
      correctionType: 'corrected', replacementValue: 'software', evidenceId: shortCorrectionProof.evidence.id,
      contentSha256: shortCorrectionProof.evidence.contentSha256, exactExcerpt: 'Ambiguous Holdings current industry is software.', reason: 'Synthetic short-rights correction rejection',
    } });
    assert.equal(shortCorrection.status, 409, 'corrected proof rights must cover the remaining claim lifetime');
    const tiedCorrectionProof = await snapshot('/valid-correction', '<p>Ambiguous Holdings current industry is software.</p>', '2035-01-01T00:00:00.000Z', ambiguousDomain);
    await qaStore.withTenant({ tenantId, userId: String(bootstrap.body.user.id) }, db => db.query(`
        INSERT INTO astra.research_claim_corrections(tenant_id,id,claim_id,correction_type,replacement_value,evidence_id,content_sha256,exact_excerpt,reason,created_by,created_at)
        VALUES($1,$2,$3,'corrected','software',$4,$5,$6,'synthetic tied correction A',$7,'2030-01-01T00:00:00.123456Z'),
              ($1,$8,$3,'corrected','software',$4,$5,$6,'synthetic tied correction B',$7,'2030-01-01T00:00:00.123456Z')`,
      [tenantId,randomUUID(),ambiguousIndustry.id,tiedCorrectionProof.evidence.id,tiedCorrectionProof.evidence.contentSha256,
        'Ambiguous Holdings current industry is software.',String(bootstrap.body.user.id),randomUUID()]));
    const ambiguousCampaign = await createCampaign('Synthetic tied correction qualification');
    const ambiguousQualification = await request(`${prefix}/campaigns/${ambiguousCampaign.id}/qualification`, { method: 'POST', ...owner, body: { accountIds: [ambiguousIndustryPage.account.id] } });
    assert.equal(ambiguousQualification.status, 200, ambiguousQualification.body?.error);
    assert.equal(ambiguousQualification.body.qualification.fitCount, 0, 'equal latest correction timestamps cannot select an arbitrary proof');
    assert.ok(ambiguousQualification.body.qualification.results[0].reasons.includes('current_industry_evidence_missing'));
    const listedClaims = await request(`${prefix}/research/claims`, { cookie: owner.cookie });
    const ambiguousRow = listedClaims.body.data.find(item => item.id === ambiguousIndustry.id);
    assert.ok(ambiguousRow.currentClaimBlockers.includes('latest_correction_timestamp_ambiguous'));

    process.stdout.write(`${JSON.stringify({ fixtureMode: fixture.mode, fixtureLabel: fixture.label, realData: false, fitCount: qualification.body.qualification.fitCount, proofRefs: persistedRefs.length, correctedProof: true, retractionAndExpiryBlocked: true, transport: 'disabled' }, null, 2)}\n`);

    process.stdout.write(`${JSON.stringify({ fixtureMode: fixture.mode, fixtureLabel: fixture.label, realData: false, fitCount: qualification.body.qualification.fitCount, proofRefs: persistedRefs.length, contactEvidenceSeparate: true }, null, 2)}\n`);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (qaStore) await qaStore.close();
    if (closeDb) await closeDb();
    rmSync(scratch, { recursive: true, force: true });
  }
});
