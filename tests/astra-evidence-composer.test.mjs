import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAstraCopyAgainstTemplates } from '../pipeline/astra-copy-validation.js';
import { hasCurrentAstraCopyProof } from '../pipeline/astra-autonomy.js';

const source = { evidenceId:'evidence-1',sourceId:'source-1',url:'https://clinic.example.test/about',hash:'a'.repeat(64),
  expiresAt:'2035-01-01T00:00:00.000Z',exactExcerpt:'Northstar Dental opened in 2018.',rightsPolicy:'synthetic_fixture',rightsExpiresAt:null,correctionId:null };
const template = { templateId:'source-quote-v1:claim-one',claimId:'claim-one',businessDomain:'clinic.example.test',
  placement:'body',renderedText:'According to https://clinic.example.test/about, the source states: “Northstar Dental opened in 2018.”',source };
const subject = { templateId:'subject:research-note-v1',claimId:null,renderedText:'Research note',placement:'subject',businessDomain:null,source:null };
const mapped = [{ sentence:template.renderedText,claimIds:['claim-one'],templateId:template.templateId }];

test('copy validation supports only exact source-attributed full-copy templates', () => {
  const result=validateAstraCopyAgainstTemplates({subject:'Research note',body:template.renderedText,claimsMap:mapped,templates:[subject,template]});
  assert.equal(result.status,'verified');
  assert.equal(result.eligible,true);
  assert.equal(result.proofs[0].source.hash,'a'.repeat(64));

  const unsupported=validateAstraCopyAgainstTemplates({subject:'Research note',
    body:`${template.renderedText}\nDental Clinic will double revenue.`,
    claimsMap:[...mapped,{sentence:'Dental Clinic will double revenue.',claimIds:['claim-one'],templateId:template.templateId}],templates:[subject,template]});
  assert.equal(unsupported.status,'unverified');
  assert.equal(unsupported.eligible,false);
  assert.ok(unsupported.reasons.includes('copy_contains_unmapped_or_unsupported_text'));

  const forged=validateAstraCopyAgainstTemplates({subject:'Research note',body:template.renderedText,
    claimsMap:[{...mapped[0],templateId:'source-quote-v1:forged'}],templates:[subject,template]});
  assert.equal(forged.eligible,false);
});

test('copy validation rejects unbound subject, duplicate mapping and mixed businesses', () => {
  assert.equal(validateAstraCopyAgainstTemplates({subject:'Dental Clinic will double revenue',body:template.renderedText,
    claimsMap:mapped,templates:[subject,template]}).eligible,false);
  assert.equal(validateAstraCopyAgainstTemplates({subject:' Research note ',body:template.renderedText,
    claimsMap:mapped,templates:[subject,template]}).eligible,false);
  assert.equal(validateAstraCopyAgainstTemplates({subject:'Research note',body:`${template.renderedText}\n${template.renderedText}`,
    claimsMap:[...mapped,...mapped],templates:[subject,template]}).eligible,false);
  const other={...template,templateId:'source-quote-v1:claim-two',claimId:'claim-two',businessDomain:'other.example.test',
    renderedText:'According to https://other.example.test/about, the source states: “Another business was founded in 2001.”'};
  const result=validateAstraCopyAgainstTemplates({subject:'Research note',body:`${template.renderedText}\n${other.renderedText}`,
    claimsMap:[mapped[0],{sentence:other.renderedText,claimIds:['claim-two'],templateId:other.templateId}],templates:[subject,template,other]});
  assert.equal(result.eligible,false);
  assert.ok(result.reasons.includes('mixed_business_copy_requires_separate_drafts'));
});

test('copy validation rejects whitespace edits, blank lines and noncanonical separators', () => {
  const other={...template,templateId:'source-quote-v1:claim-two',claimId:'claim-two',
    renderedText:'According to https://clinic.example.test/about, the source states: “Northstar Dental serves Lakeside.”'};
  const otherMap={sentence:other.renderedText,claimIds:['claim-two'],templateId:other.templateId};
  for(const body of [ `${template.renderedText}\n\n${other.renderedText}`,
    ` ${template.renderedText}`, `${template.renderedText} `, `${template.renderedText}\r\n${other.renderedText}` ]) {
    const mappings=body.includes(other.renderedText)?[mapped[0],otherMap]:mapped;
    assert.equal(validateAstraCopyAgainstTemplates({subject:'Research note',body,claimsMap:mappings,templates:[subject,template,other]}).eligible,false,body);
  }
});

test('execution proof fails closed for legacy substring mappings and forged client envelopes', async () => {
  const claimId='11111111-1111-4111-8111-111111111111';
  const client={query(){throw new Error('legacy/malformed proof must fail before any database lookup');}};
  const legacy={id:'campaign-one',subject:'Research note',body:'Dental Clinic will double revenue.',
    claims_map:[{sentence:'Dental Clinic will double revenue.',claimIds:[claimId]}],copy_hash:'a'.repeat(64),offer_version_id:1,offer_content_hash:'b'.repeat(64)};
  assert.equal(await hasCurrentAstraCopyProof(client,{tenantId:'tenant-one',campaign:legacy}),false);
  const forged={...legacy,claims_map:[{kind:'copy_validation',schemaVersion:1,status:'verified',eligible:true,
    subjectHash:'c'.repeat(64),bodyHash:'d'.repeat(64),proofs:[]},{sentence:legacy.body,claimIds:[claimId],templateId:'arbitrary'}]};
  assert.equal(await hasCurrentAstraCopyProof(client,{tenantId:'tenant-one',campaign:forged}),false);
});
