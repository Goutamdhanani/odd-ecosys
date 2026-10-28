export function campaignCopyForEditor(campaign) {
  return { subject: String(campaign?.subject || ''), body: String(campaign?.body || '') };
}

// Client mappings only nominate exact server-provided templates. They are hints
// to the validator, never proof that copy is supported.
export function exactTemplateMappings(_subject, body, templates) {
  const candidates = Array.isArray(templates) ? templates : [];
  // Subject is a fixed server-side rule, not part of the body claimsMap.
  return String(body || '').split(/\r?\n/).filter(line => line.trim()).map(line => {
    const template = candidates.find(item => item.placement === 'body' && item.renderedText === line
      && typeof item.templateId === 'string' && item.templateId);
    return template ? { sentence: line, claimIds: template.claimId ? [template.claimId] : [], templateId: template.templateId } : null;
  }).filter(Boolean);
}

export function appendTemplateLines(body, lines) {
  const additions = (Array.isArray(lines) ? lines : []).filter(line => typeof line === 'string' && line.length > 0);
  if (!additions.length) return String(body || '');
  const existing = String(body || '');
  return existing ? `${existing}\n${additions.join('\n')}` : additions.join('\n');
}

export function composerCanApprove(validation) {
  return validation?.status === 'verified' && validation?.eligible === true;
}

export function composerEditorCanApprove(validation, editor, composer, dirty) {
  return composerCanApprove(validation) && dirty !== true && Boolean(composer?.campaignId)
    && editor?.campaignId === composer.campaignId
    && editor?.subject === String(composer.subject || '')
    && editor?.body === String(composer.body || '');
}

export function isCampaignLoadCurrent(requestScope, currentScope, selectedCampaignId, requestedCampaignId) {
  return Boolean(requestScope && currentScope && requestScope.tenantId === currentScope.tenantId
    && requestScope.epoch === currentScope.epoch
    && (requestScope.generation === undefined || requestScope.generation === currentScope.generation)
    && selectedCampaignId === requestedCampaignId);
}
