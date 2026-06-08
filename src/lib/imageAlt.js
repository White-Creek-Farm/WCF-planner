export function imageAltText(name, {fallback = 'Photo', index = null, total = null} = {}) {
  const label = typeof name === 'string' && name.trim() ? name.trim() : fallback;
  const hasPosition = Number.isInteger(index) && Number.isInteger(total) && total > 1;
  return hasPosition ? `${label} ${index + 1} of ${total}` : label;
}
