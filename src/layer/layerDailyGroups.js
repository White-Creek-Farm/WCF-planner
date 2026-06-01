function normalizeLabel(value) {
  return String(value || '')
    .toLowerCase()
    .trim();
}

export function sameLayerDailyGroupLabel(a, b) {
  return normalizeLabel(a) === normalizeLabel(b);
}

export function buildLayerDailyGroupOptions({
  layerGroups = [],
  layerBatches = [],
  layerHousings = [],
  currentLabel = '',
} = {}) {
  const activeBatches = (layerBatches || []).filter((b) => b && b.status === 'active');
  const activeHousings = (layerHousings || []).filter((h) => h && h.status === 'active');
  const names =
    activeBatches.length > 0 || activeHousings.length > 0
      ? [
          ...activeBatches
            .filter((b) => !activeHousings.some((h) => h.batch_id === b.id))
            .map((b) => b.name)
            .filter(Boolean),
          ...activeHousings.map((h) => h.housing_name).filter(Boolean),
        ]
      : (layerGroups || [])
          .filter((g) => typeof g === 'string' || (g && g.status === 'active'))
          .map((g) => g.name || g)
          .filter(Boolean);

  const values = [...new Set(names)];
  if (currentLabel && !values.includes(currentLabel)) values.push(currentLabel);
  return values;
}

export function resolveLayerDailyBatchId(label, {layerGroups = [], layerBatches = [], layerHousings = []} = {}) {
  if (!label) return null;
  const byBatch = (layerBatches || []).find((b) => sameLayerDailyGroupLabel(b.name, label));
  if (byBatch) return byBatch.id || null;
  const byHousing = (layerHousings || []).find((h) => sameLayerDailyGroupLabel(h.housing_name, label));
  if (byHousing) return byHousing.batch_id || null;
  const byLegacyGroup = (layerGroups || []).find((g) => sameLayerDailyGroupLabel(g.name || g, label));
  return byLegacyGroup && typeof byLegacyGroup === 'object' ? byLegacyGroup.id || null : null;
}
