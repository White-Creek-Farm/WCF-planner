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

export const LIGHT_DAILY_REPORT_EDIT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function resolveEntityType(tableOrEntityType) {
  return TABLE_TO_ENTITY[tableOrEntityType] || tableOrEntityType;
}

export function isWithinLightDailyReportEditWindow(record, nowMs = Date.now()) {
  const submittedAt = record?.submitted_at;
  if (!submittedAt) return false;
  const submittedMs = new Date(submittedAt).getTime();
  if (!Number.isFinite(submittedMs)) return false;
  return nowMs - submittedMs <= LIGHT_DAILY_REPORT_EDIT_WINDOW_MS;
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

// Roles that may edit/delete ANY record (not just their own). Light is the
// only authenticated role scoped to its own records; inactive can do neither.
const PRIVILEGED_EDIT_ROLES = ['admin', 'management', 'farm_team', 'equipment_tech'];

// Server-mirrored ownership gate for showing edit/delete affordances. The DB
// RPCs are the real enforcement (mig 091 + later window migrations); this only
// decides whether to render controls the server would accept. For Light users,
// `owner_profile_id` and `submitted_at` must be present in the loaded row.
export function canEditOwnRecord(authState, record) {
  const role = authState?.role;
  if (!role || role === 'inactive') return false;
  if (PRIVILEGED_EDIT_ROLES.includes(role)) return true;
  if (role === 'light') {
    const uid = authState?.user?.id;
    return !!uid && !!record && record.owner_profile_id === uid && isWithinLightDailyReportEditWindow(record);
  }
  return false;
}

export function canDeleteDailyReport(authState, record) {
  const role = authState?.role;
  if (!role || role === 'inactive') return false;
  // Light may delete only its own records; other active roles, any record.
  if (role === 'light') return canEditOwnRecord(authState, record);
  return true;
}

// Edit a daily report through the ownership-enforced SECDEF RPC (mig 091).
// The RPC applies a server-side column allowlist + computes the field.updated
// Activity diff in one transaction; `patch` is the same record object the
// pages already build. Throws on RPC error (incl. the Light ownership reject
// and the daily duplicate constraint, so callers can surface friendly copy).
export async function updateDailyReport(sb, tableOrEntityType, id, patch, {entityLabel} = {}) {
  if (!sb) throw new Error('updateDailyReport: sb required');
  const entityType = resolveEntityType(tableOrEntityType);
  const {data, error} = await sb.rpc('update_daily_report', {
    p_entity_type: entityType,
    p_entity_id: id,
    p_patch: patch,
    p_entity_label: entityLabel || null,
  });
  if (error) throw new Error(error.message || String(error));
  return data;
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
