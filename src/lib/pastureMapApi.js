// ============================================================================
// src/lib/pastureMapApi.js  —  Pasture Map CP1
// ----------------------------------------------------------------------------
// Thin wrappers around the mig 116 SECDEF RPCs. All land geometry/history lives
// in Supabase PostGIS; these calls are the only client path to it (the tables
// are deny-all RLS). Each wrapper returns the RPC's jsonb payload and throws on
// error so callers can try/catch. Read = farm_team+; write = management/admin
// (enforced server-side; surfaced as PM_VALIDATION errors).
// ============================================================================
import {sb} from './supabase.js';

// Stable client batch id (RPC requires ^[A-Za-z0-9-]+$). crypto.randomUUID is
// available in every supported browser; fall back for older runtimes.
export function newImportBatchId() {
  const uuid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  return 'pmb-' + uuid;
}

// Stable client id for a newly drawn land area (RPC requires ^[A-Za-z0-9-]+$).
export function newLandAreaId() {
  const uuid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  return 'la-' + uuid;
}

export function newPastureTrackId() {
  const uuid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  return 'trk-' + uuid;
}

// Stable client id for a pasture move event. The RPC is replay-idempotent by id.
export function newPastureMoveId() {
  const uuid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  return 'pmv-' + uuid;
}

// Stable client id for a planned pasture move.
export function newPasturePlanId() {
  const uuid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  return 'pmp-' + uuid;
}

function unwrap({data, error}, label) {
  if (error) {
    const msg = (error.message || String(error)).replace(/^PM_VALIDATION:\s*/, '');
    const e = new Error(msg);
    e.cause = error;
    e.context = label;
    throw e;
  }
  return data;
}

// List every live land area (geometry served as GeoJSON). Returns { land_areas:[...] }.
export async function listLandAreas(includeDeleted = false) {
  return unwrap(await sb.rpc('list_land_areas', {p_include_deleted: includeDeleted}), 'list_land_areas');
}

// Import a parsed KML batch. placemarks: array of pastureKml featureToPlacemark
// objects (only the 6 server-read fields are forwarded). Replay-idempotent by
// batchId. Returns { batch_id, inserted, updated, placemark_count, replayed }.
export async function importLandAreaBatch({batchId, source = 'onx_kml', fileName = null, placemarks = []}) {
  const slim = (placemarks || []).map((p) => ({
    external_id: p.external_id ?? null,
    name: p.name ?? null,
    notes: p.notes ?? null,
    color: p.color ?? null,
    geometry_type: p.geometry_type ?? (p.geometry && p.geometry.type) ?? null,
    geometry: p.geometry ?? null,
  }));
  return unwrap(
    await sb.rpc('import_land_area_batch', {
      p_batch_id: batchId,
      p_source: source,
      p_file_name: fileName,
      p_placemarks: slim,
    }),
    'import_land_area_batch',
  );
}

// Classify / edit one land area. fields keys map to the RPC's p_* args; only
// provided keys are sent so unspecified attributes stay unchanged.
export async function updateLandArea(id, fields = {}) {
  const args = {p_id: id};
  const map = {
    name: 'p_name',
    kind: 'p_kind',
    parentId: 'p_parent_id',
    clearParent: 'p_clear_parent',
    permanence: 'p_permanence',
    designation: 'p_designation',
    status: 'p_status',
    reviewStatus: 'p_review_status',
    manualAcres: 'p_manual_acres',
    clearManual: 'p_clear_manual',
  };
  for (const [k, arg] of Object.entries(map)) {
    if (fields[k] !== undefined) args[arg] = fields[k];
  }
  return unwrap(await sb.rpc('update_land_area', args), 'update_land_area');
}

// Convenience: classify an imported item to a target kind (Accept as Pasture/
// Paddock, Infrastructure, etc.) and mark it reviewed in one call.
export async function classifyLandArea(id, kind) {
  return updateLandArea(id, {kind, reviewStatus: 'reviewed'});
}

export async function updateLandAreaStyle(
  id,
  {lineColor = null, lineWeight = null, linePattern = null, clear = false} = {},
) {
  return unwrap(
    await sb.rpc('update_land_area_line_style', {
      p_id: id,
      p_line_color: lineColor,
      p_line_weight: lineWeight,
      p_line_pattern: linePattern,
      p_clear: clear,
    }),
    'update_land_area_line_style',
  );
}

// Promote/close an outline candidate from a human-confirmed closed polygon
// (GeoJSON geometry object). Server re-validates (ST_IsValid + polygon type).
export async function closeLandAreaOutline(id, polygonGeojson, kind = 'unclassified') {
  return unwrap(
    await sb.rpc('close_land_area_outline', {p_id: id, p_polygon_geojson: polygonGeojson, p_kind: kind}),
    'close_land_area_outline',
  );
}

// Soft-delete a land area (also used for the Scratch/Delete quick action).
export async function deleteLandArea(id) {
  return unwrap(await sb.rpc('delete_land_area', {p_id: id}), 'delete_land_area');
}

// CP2 — create a NEW land area from a drawn polygon (mig 127). Writes v1 geometry
// version; replay-idempotent by id. polygon is a GeoJSON geometry object.
export async function createLandArea({id, name, polygon, kind = 'unclassified', source = 'drawn'}) {
  return unwrap(
    await sb.rpc('create_land_area', {
      p_id: id,
      p_name: name,
      p_polygon_geojson: polygon,
      p_kind: kind,
      p_source: source,
    }),
    'create_land_area',
  );
}

// CP2 — append a new boundary version to an existing area (edit, mig 127).
// Append-only: prior versions are preserved server-side. polygon is GeoJSON.
export async function createLandAreaTrack({id, name, line, source = 'drawn'}) {
  return unwrap(
    await sb.rpc('create_land_area_track', {
      p_id: id,
      p_name: name,
      p_line_geojson: line,
      p_source: source,
    }),
    'create_land_area_track',
  );
}

export async function updateLandAreaGeometry(id, polygon) {
  return unwrap(
    await sb.rpc('update_land_area_geometry', {p_id: id, p_polygon_geojson: polygon}),
    'update_land_area_geometry',
  );
}

// P0 (mig 135) — temp-paddock lifecycle. Temp paddock = kind='paddock' +
// permanence='temporary'. create is farm_team+; rename/redraw/archive/restore
// are temp-owner OR management/admin (server-gated); hard delete is admin-only.
// Archive/hard-delete on an occupied area throw the bare sentinel
// PM_AREA_OCCUPIED (PM_VALIDATION prefix is stripped by unwrap); callers map it
// to PM_AREA_OCCUPIED_COPY for the exact UI sentence.
export const PM_AREA_OCCUPIED = 'PM_AREA_OCCUPIED';
export const PM_AREA_OCCUPIED_COPY = 'Move animals out of this temp paddock before archiving it.';

// Create a NEW temp paddock from a drawn/GPS-walked closed polygon (GeoJSON
// geometry object). Replay-idempotent by id. Field "Record a track" calls this.
export async function createTempLandArea({id, name, polygon, source = 'drawn'}) {
  return unwrap(
    await sb.rpc('create_temp_land_area', {
      p_id: id,
      p_name: name,
      p_polygon_geojson: polygon,
      p_source: source,
    }),
    'create_temp_land_area',
  );
}

// Redraw a temp paddock boundary (append-only new version). polygon is GeoJSON.
export async function updateTempLandAreaGeometry(id, polygon) {
  return unwrap(
    await sb.rpc('update_temp_land_area_geometry', {p_id: id, p_polygon_geojson: polygon}),
    'update_temp_land_area_geometry',
  );
}

// Rename a temp paddock.
export async function renameTempLandArea(id, name) {
  return unwrap(await sb.rpc('rename_temp_land_area', {p_id: id, p_name: name}), 'rename_temp_land_area');
}

// Archive (status='retired', restorable). Blocked when occupied.
export async function archiveLandArea(id) {
  return unwrap(await sb.rpc('archive_land_area', {p_id: id}), 'archive_land_area');
}

// Restore an archived area (status -> 'active').
export async function restoreLandArea(id) {
  return unwrap(await sb.rpc('restore_land_area', {p_id: id}), 'restore_land_area');
}

// Admin-only hard delete (soft-delete/snapshot path; geometry retained for v1).
// Blocked when occupied.
export async function hardDeleteLandArea(id) {
  return unwrap(await sb.rpc('hard_delete_land_area', {p_id: id}), 'hard_delete_land_area');
}

// CP3 - recent append-only animal-group move ledger.
export async function listPastureMoves(limit = 100) {
  return unwrap(await sb.rpc('list_pasture_moves', {p_limit: limit}), 'list_pasture_moves');
}

// CP3 - record one move to a land area. Animal groups stay decoupled from land:
// animalType + groupKey/Label identify the herd/flock/pig group, not a FK.
export async function recordPastureMove({
  moveId,
  animalType,
  groupKey,
  groupLabel,
  toLandAreaId,
  movedAt,
  animalCount = null,
  notes = null,
}) {
  return unwrap(
    await sb.rpc('record_pasture_move', {
      p_move_id: moveId,
      p_animal_type: animalType,
      p_group_key: groupKey,
      p_group_label: groupLabel,
      p_to_land_area_id: toLandAreaId,
      p_moved_at: movedAt,
      p_animal_count: animalCount,
      p_notes: notes,
    }),
    'record_pasture_move',
  );
}

// CP4 - planned move worklist.
export async function listPasturePlannedMoves({status = 'planned', limit = 100} = {}) {
  return unwrap(
    await sb.rpc('list_pasture_planned_moves', {p_status: status, p_limit: limit}),
    'list_pasture_planned_moves',
  );
}

export async function createPasturePlannedMove({
  planId,
  animalType,
  groupKey,
  groupLabel,
  toLandAreaId,
  plannedFor,
  animalCount = null,
  notes = null,
}) {
  return unwrap(
    await sb.rpc('create_pasture_planned_move', {
      p_plan_id: planId,
      p_animal_type: animalType,
      p_group_key: groupKey,
      p_group_label: groupLabel,
      p_to_land_area_id: toLandAreaId,
      p_planned_for: plannedFor,
      p_animal_count: animalCount,
      p_notes: notes,
    }),
    'create_pasture_planned_move',
  );
}

export async function updatePasturePlannedMoveStatus({planId, status, completedMoveId = null}) {
  return unwrap(
    await sb.rpc('update_pasture_planned_move_status', {
      p_plan_id: planId,
      p_status: status,
      p_completed_move_id: completedMoveId,
    }),
    'update_pasture_planned_move_status',
  );
}

export async function listPastureHistoryReport({
  landAreaId = null,
  animalType = null,
  groupKey = null,
  limit = 200,
} = {}) {
  return unwrap(
    await sb.rpc('list_pasture_history_report', {
      p_land_area_id: landAreaId,
      p_animal_type: animalType,
      p_group_key: groupKey,
      p_limit: limit,
    }),
    'list_pasture_history_report',
  );
}

export async function listPastureRestReport() {
  return unwrap(await sb.rpc('list_pasture_rest_report'), 'list_pasture_rest_report');
}

export async function listPastureStockingReport({since = null, until = null} = {}) {
  return unwrap(
    await sb.rpc('list_pasture_stocking_report', {p_since: since, p_until: until}),
    'list_pasture_stocking_report',
  );
}

// CP-C (V1 reset) — shared, persisted MANUAL rotations (mig 140). Read + edit are
// farm_team-level incl. light. area_ids is the user's ordered path; archived /
// deleted destination ids are filtered out client-side on render.
export async function listPastureRotations() {
  return unwrap(await sb.rpc('list_pasture_rotations'), 'list_pasture_rotations');
}

export async function upsertPastureRotation({animalType, groupKey, areaIds}) {
  return unwrap(
    await sb.rpc('upsert_pasture_rotation', {
      p_animal_type: animalType,
      p_group_key: groupKey,
      p_area_ids: areaIds || [],
    }),
    'upsert_pasture_rotation',
  );
}

export async function clearPastureRotation({animalType, groupKey}) {
  return unwrap(
    await sb.rpc('clear_pasture_rotation', {p_animal_type: animalType, p_group_key: groupKey}),
    'clear_pasture_rotation',
  );
}

// CP-E (V1 reset) — saved distance measurements (mig 141). A measurement is a
// distance LineString layer only: nameable, deletable, optional color, never a
// land area (no acreage / destination / rest / report). Read + create are
// farm_team-level incl. light; delete is creator-or-management.
export function newPastureMeasurementId() {
  const uuid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  return 'meas-' + uuid;
}

export async function listPastureMeasurements() {
  return unwrap(await sb.rpc('list_pasture_measurements'), 'list_pasture_measurements');
}

export async function createPastureMeasurement({id, name, geometry, distanceFt = null, lineColor = null}) {
  return unwrap(
    await sb.rpc('create_pasture_measurement', {
      p_id: id,
      p_name: name,
      p_geometry: geometry,
      p_distance_ft: distanceFt,
      p_line_color: lineColor,
    }),
    'create_pasture_measurement',
  );
}

export async function deletePastureMeasurement(id) {
  return unwrap(await sb.rpc('delete_pasture_measurement', {p_id: id}), 'delete_pasture_measurement');
}
