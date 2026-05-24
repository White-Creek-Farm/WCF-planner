export function buildChanges(oldRec, newFields, {exclude = [], labels = {}, formatters = {}} = {}) {
  if (!newFields || typeof newFields !== 'object') return [];
  const changes = [];
  for (const [field, newVal] of Object.entries(newFields)) {
    if (exclude.includes(field)) continue;
    const oldVal = oldRec ? oldRec[field] : undefined;
    if (valuesEqual(oldVal, newVal)) continue;
    const label = labels[field] || field;
    const formatter = formatters[field];
    changes.push({
      field,
      label,
      from: formatter ? formatter(oldVal) : primitiveOrNull(oldVal),
      to: formatter ? formatter(newVal) : primitiveOrNull(newVal),
      old_present: isPresent(oldVal),
      new_present: isPresent(newVal),
    });
  }
  return changes;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a === '' && b == null) return true;
  if (a == null && b === '') return true;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function isPresent(v) {
  if (v == null) return false;
  if (v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function primitiveOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

export function makeFieldChange(field, label, from, to) {
  return {field, label, from: from ?? null, to: to ?? null, old_present: isPresent(from), new_present: isPresent(to)};
}

export function countSummary(arr, singular, plural) {
  if (!Array.isArray(arr) || arr.length === 0) return 'none';
  return arr.length === 1 ? '1 ' + singular : arr.length + ' ' + (plural || singular + 's');
}
