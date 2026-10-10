export const MAX_CONTACT_SELECTION = 500;

function normalizeId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function toggleContactSelection(selection, value, selected, limit = MAX_CONTACT_SELECTION) {
  const id = normalizeId(value);
  if (!id) return false;
  if (selected && !selection.has(id) && selection.size >= limit) return false;
  if (selected) selection.add(id);
  else selection.delete(id);
  return true;
}

export function setContactPageSelection(selection, values, selected, limit = MAX_CONTACT_SELECTION) {
  if (!Array.isArray(values)) return false;
  const ids = [...new Set(values.map(normalizeId).filter(Boolean))];
  if (selected && selection.size + ids.filter(id => !selection.has(id)).length > limit) return false;
  for (const id of ids) {
    if (selected) selection.add(id);
    else selection.delete(id);
  }
  return true;
}

export function getContactPageSelection(selection, values) {
  const ids = [...new Set((Array.isArray(values) ? values : []).map(normalizeId).filter(Boolean))];
  const selected = ids.filter(id => selection.has(id)).length;
  return {
    selected,
    total: ids.length,
    allSelected: ids.length > 0 && selected === ids.length,
    indeterminate: selected > 0 && selected < ids.length,
  };
}
