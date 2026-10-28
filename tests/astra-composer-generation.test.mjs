import assert from 'node:assert/strict';
import test from 'node:test';
import { expandCampaignDraft } from '../pipeline/astra-generation.js';

test('generated campaign drafts carry their request version but never forge composer proof', () => {
  const campaignVersion=12;
  const draft=expandCampaignDraft({subject:'Dental Clinic will double revenue',body:'Dental Clinic will double revenue.',
    claimsMap:[{sentence:'Dental Clinic will double revenue.',claimIds:['11111111-1111-4111-8111-111111111111']} ]},
  {__campaignVersion:campaignVersion,'{{FACT_1}}':{value:'Dental Clinic'} });
  assert.equal(draft.expectedVersion,campaignVersion);
  assert.equal(draft.subject,'Dental Clinic will double revenue');
  assert.equal(draft.body,'Dental Clinic will double revenue.');
  assert.equal(draft.claimsMap[0].templateId,undefined);
  assert.equal(draft.validation,undefined,'only the server save path can validate generated copy');
});

test('generated drafts without a signed campaign snapshot cannot silently choose a save version', () => {
  const draft=expandCampaignDraft({subject:'Research note',body:'Unsupported promise.',claimsMap:[]},{});
  assert.equal(Object.hasOwn(draft,'expectedVersion'),false);
});
