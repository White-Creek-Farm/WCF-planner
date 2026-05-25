// Daily report soft-delete and restore API.
// Both operations use transactional SECDEF RPCs (mig 067) that mutate
// the record and insert an Activity event in one transaction.

const TABLE_TO_ENTITY = {
  poultry_dailys: 'poultry.daily',
  layer_dailys: 'layer.daily',
  egg_dailys: 'egg.daily',
  pig_dailys: 'pig.daily',
  cattle_dailys: 'cattle.daily',
  sheep_dailys: 'sheep.daily',
};

function resolveEntityType(tableOrEntityType) {
  return TABLE_TO_ENTITY[tableOrEntityType] || tableOrEntityType;
}

export async function softDeleteDailyReport(sb, tableOrEntityType, id, entityLabel) {
  if (!sb) throw new Error('softDeleteDailyReport: sb required');
  const entityType = resolveEntityType(tableOrEntityType);
  const {data, error} = await sb.rpc('soft_delete_daily_report', {
    p_entity_type: entityType,
    p_entity_id: id,
    p_entity_label: entityLabel || null,
  });
  if (error) throw new Error(`softDeleteDailyReport: ${error.message || String(error)}`);
  return data;
}

export function canDeleteDailyReport(authState) {
  const role = authState?.role;
  return !!role && role !== 'inactive';
}

export async function restoreDailyReport(sb, tableOrEntityType, id, entityLabel) {
  if (!sb) throw new Error('restoreDailyReport: sb required');
  const entityType = resolveEntityType(tableOrEntityType);
  const {data, error} = await sb.rpc('restore_daily_report', {
    p_entity_type: entityType,
    p_entity_id: id,
    p_entity_label: entityLabel || null,
  });
  if (error) throw new Error(`restoreDailyReport: ${error.message || String(error)}`);
  return data;
}
