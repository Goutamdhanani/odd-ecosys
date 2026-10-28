import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTemplateLines, composerCanApprove, composerEditorCanApprove, exactTemplateMappings, isCampaignLoadCurrent } from '../js/astra-campaign-draft.js';

const templates = [
  { templateId: 'body:claim-1', claimId: 'claim-1', placement: 'body', renderedText: 'Your page lists Dental Clinic.' },
  { templateId: 'subject:research-note-v1', claimId: null, placement: 'subject', renderedText: 'Research note' },
];

test('only exact server template lines are nominated for mapping', () => {
  assert.deepEqual(exactTemplateMappings('Research note', 'Your page lists Dental Clinic.', templates), [
    { sentence: 'Your page lists Dental Clinic.', claimIds: ['claim-1'], templateId: 'body:claim-1' },
  ]);
  assert.deepEqual(exactTemplateMappings('Not the fixed subject', 'Your page lists Dental Clinic.', templates), [
    { sentence: 'Your page lists Dental Clinic.', claimIds: ['claim-1'], templateId: 'body:claim-1' },
  ]);
});

test('template insertion uses one newline and preserves existing editor text', () => {
  const second = { templateId: 'body:claim-2', claimId: 'claim-2', placement: 'body', renderedText: 'Your page serves the North district.' };
  assert.equal(appendTemplateLines('', [templates[0].renderedText, second.renderedText]),
    'Your page lists Dental Clinic.\nYour page serves the North district.');
  assert.equal(appendTemplateLines('Existing customer edit.', [templates[0].renderedText]),
    'Existing customer edit.\nYour page lists Dental Clinic.');
});

test('a supported phrase inside an edited promise does not become template provenance', () => {
  const edited = 'Your page lists Dental Clinic, and we guarantee 50 new patients.';
  assert.deepEqual(exactTemplateMappings('Research note', edited, templates), []);
  assert.equal(composerCanApprove({ status: 'unverified', eligible: false, reasons: ['unmapped_copy'] }), false);
  assert.deepEqual(exactTemplateMappings('Research note', 'Your page lists Dental Clinic. ', templates), []);
});

test('approval requires the server verified and eligible result', () => {
  assert.equal(composerCanApprove({ status: 'verified', eligible: true }), true);
  assert.equal(composerCanApprove({ status: 'verified', eligible: false }), false);
  assert.equal(composerCanApprove({ status: 'unverified', eligible: true }), false);
  assert.equal(composerCanApprove(null), false);
});

test('a verified saved copy cannot approve while the editor has unsaved edits', () => {
  const composer = { campaignId: 'campaign-a', subject: 'Research note', body: 'Your page lists Dental Clinic.' };
  const validation = { status: 'verified', eligible: true };
  const savedEditor = { campaignId: 'campaign-a', subject: composer.subject, body: composer.body };
  assert.equal(composerEditorCanApprove(validation, savedEditor, composer, false), true);
  assert.equal(composerEditorCanApprove(validation, { ...savedEditor, body: `${composer.body}\nWe guarantee new patients.` }, composer, true), false);
  assert.equal(composerEditorCanApprove(validation, savedEditor, composer, true), false);
  assert.equal(composerEditorCanApprove(validation, { ...savedEditor, campaignId: 'campaign-b' }, composer, false), false);
});

test('campaign response generations fence an A-to-B-to-A selection', () => {
  const firstA = { tenantId: 'tenant-a', epoch: 3, generation: 11 };
  const currentA = { tenantId: 'tenant-a', epoch: 3, generation: 13 };
  assert.equal(isCampaignLoadCurrent(firstA, currentA, 'campaign-a', 'campaign-a'), false);
  assert.equal(isCampaignLoadCurrent(currentA, currentA, 'campaign-a', 'campaign-a'), true);
});
