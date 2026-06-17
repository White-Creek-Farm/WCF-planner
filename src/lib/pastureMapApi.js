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
export async function updateLandAreaGeometry(id, polygon) {
  return unwrap(
    await sb.rpc('update_land_area_geometry', {p_id: id, p_polygon_geojson: polygon}),
    'update_land_area_geometry',
  );
}
