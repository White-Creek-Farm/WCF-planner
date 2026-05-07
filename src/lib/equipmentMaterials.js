// Rolling-stock checklist aggregator. Loads materials + clears from the
// auth-only sidecar tables (mig 048) and folds them into a per-equipment
// "what's coming due in the next maintenance window" view.
//
// Window per Codex:
//   - hours-tracked equipment: current_reading + 100h
//   - km-tracked equipment   : current_reading + 5000km
//   - 'use'-interval materials: always present (until manually cleared)
//
// Clear bucket math (Codex amendment 4):
//   For hours/km intervals, the bucket = computeIntervalStatus's next_due
//   milestone for that interval. With NO completion history (e.g. fresh
//   piece at current=80 with a 50h interval), next_due=50 and the interval
//   is overdue — bucket="50". After a completion at 80 snaps to milestone
//   100, the next firing is bucket=150. A clear keyed to bucket=50 no
//   longer matches once the snap shifts the next_due forward — material
//   reappears in the new cycle.
//
//   For 'use' intervals, due_bucket_value=NULL, due_bucket_unit='use';
//   clears persist until admin manually un-clears via the editor.
//
// Identity per Codex amendment 3: (source_kind, interval_unit,
// interval_value, attachment_name) is the structural key. service_label is
// for display only — never join on it.

import {computeIntervalStatus, latestSaneReading} from './equipment.js';

export const HOURS_WINDOW = 100;
export const KM_WINDOW = 5000;

// Build completions list shaped for computeIntervalStatus from the raw
// equipment_fuelings rows. Mirrors the inline build in
// EquipmentFuelingWebform.jsx (the historical convention) — each completion
// gets a reading_at_completion stamped from the parent fueling's hours/km.
//
// Returns the FULL combined completion list (main + attachment-tagged); the
// caller filters by `attachment_name` per-source so that a 50h AERO-Vator
// completion does NOT advance the main 50h service bucket and vice-versa.
function buildCompletions(eq, fuelings) {
  const unit = eq?.tracking_unit === 'km' ? 'km' : 'hours';
  const out = [];
  for (const f of fuelings || []) {
    const completed = Array.isArray(f?.service_intervals_completed) ? f.service_intervals_completed : [];
    if (completed.length === 0) continue;
    const reading =
      unit === 'km'
        ? f.km_reading != null
          ? Number(f.km_reading)
          : null
        : f.hours_reading != null
          ? Number(f.hours_reading)
          : null;
    for (const c of completed) {
      out.push({...c, reading_at_completion: Number.isFinite(reading) ? reading : null});
    }
  }
  return out;
}

// Build a map keyed by structural identity that the materials aggregator
// uses to look up the right interval status row for each material.
//
//   key = `${source_kind}|${interval_unit}|${interval_value ?? ''}|${attachment_name ?? ''}`
//
// Per-source completion split (Codex review): EquipmentFuelingWebform writes
// service_intervals_completed entries with `attachment_name: <name>` for
// attachment ticks and without that key for main-service ticks. The math
// must respect that split:
//   - Service-interval status uses ONLY completions with no attachment_name.
//     Otherwise an AERO-Vator 50h completion would also satisfy the main
//     50h bucket.
//   - Each attachment runs its own computeIntervalStatus pass over that
//     attachment's intervals + that attachment's completions only. Without
//     this, attachment materials would be hardcoded to never-completed
//     and stay forever in bucket=interval_value once current crossed it —
//     a stale clear in that bucket would suppress the material indefinitely
//     across rolling cycles.
//
// Materials with interval_unit='use' don't have a status row — they're
// always-due unless cleared (handled in inWindow()).
function buildIntervalStatusByKey(eq, fuelings, currentReading) {
  const intervals = Array.isArray(eq?.service_intervals) ? eq.service_intervals : [];
  const allCompletions = buildCompletions(eq, fuelings);
  const mainCompletions = allCompletions.filter((c) => !c.attachment_name);
  const byKey = new Map();

  const mainStatuses = computeIntervalStatus(intervals, mainCompletions, currentReading);
  for (const s of mainStatuses) {
    const key = `service_interval|${s.kind}|${s.hours_or_km}|`;
    byKey.set(key, s);
  }

  // Group attachments by name so each name-scoped intervals list runs its
  // own computeIntervalStatus pass with its own completion subset.
  const attachments = Array.isArray(eq?.attachment_checklists) ? eq.attachment_checklists : [];
  const intervalsByAttachment = new Map();
  for (const a of attachments) {
    const value = Number(a.hours_or_km);
    if (!Number.isFinite(value) || value <= 0) continue; // Every-Use sentinel handled separately in inWindow()
    const name = a.name || '';
    const kind = a.kind === 'km' ? 'km' : 'hours';
    const arr = intervalsByAttachment.get(name) || [];
    arr.push({kind, hours_or_km: value, label: a.label || ''});
    intervalsByAttachment.set(name, arr);
  }
  for (const [name, attachmentIntervals] of intervalsByAttachment) {
    const attachmentCompletions = allCompletions.filter((c) => c.attachment_name === name);
    const statuses = computeIntervalStatus(attachmentIntervals, attachmentCompletions, currentReading);
    for (const s of statuses) {
      const key = `attachment_checklist|${s.kind}|${s.hours_or_km}|${name}`;
      byKey.set(key, s);
    }
  }
  return byKey;
}

// Decide whether a material is in the rolling window for the given interval
// status. 'use' materials are always in-window. Returns the due_bucket
// {value, unit} for clear-key lookup.
function inWindow(material, status, eq) {
  if (material.interval_unit === 'use') {
    return {inWindow: true, dueBucketValue: null, dueBucketUnit: 'use'};
  }
  if (!status) {
    return {inWindow: false, dueBucketValue: null, dueBucketUnit: material.interval_unit};
  }
  const window = material.interval_unit === 'km' ? KM_WINDOW : HOURS_WINDOW;
  const within = status.overdue || (status.until_due != null && status.until_due <= window);
  return {
    inWindow: within,
    dueBucketValue: status.next_due,
    dueBucketUnit: material.interval_unit,
  };
}

// Bucket equality with NULL handling (NULLS NOT DISTINCT semantics).
function bucketEquals(clear, value, unit) {
  if (clear.due_bucket_unit !== unit) return false;
  if (value == null && clear.due_bucket_value == null) return true;
  if (value == null || clear.due_bucket_value == null) return false;
  return Number(clear.due_bucket_value) === Number(value);
}

// Aggregate materials by equipment → service group → rows. Cleared rows are
// omitted entirely (Codex amendment 2 — "vanish from the active list").
//
// Inputs:
//   equipment    Array<equipment row>            — active only; fed in by caller.
//   fuelingsBy   Map<equipment_id, Array>        — per-piece equipment_fuelings.
//   materials    Array<material row>             — equipment_service_materials.
//   clears       Array<clear row>                — equipment_material_clears.
//
// Output: array of { equipment, groups: [ { groupKey, label, status, materials:[...] } ] }.
// Empty equipment (no in-window non-cleared materials) is omitted.
export function buildMaterialChecklist({equipment, fuelingsBy, materials, clears}) {
  const fuelingsMap = fuelingsBy instanceof Map ? fuelingsBy : new Map(Object.entries(fuelingsBy || {}));
  const matsByEq = new Map();
  for (const m of materials || []) {
    if (!m.active) continue;
    const arr = matsByEq.get(m.equipment_id) || [];
    arr.push(m);
    matsByEq.set(m.equipment_id, arr);
  }
  const clearsByMat = new Map();
  for (const c of clears || []) {
    const arr = clearsByMat.get(c.material_id) || [];
    arr.push(c);
    clearsByMat.set(c.material_id, arr);
  }

  const out = [];
  for (const eq of equipment || []) {
    if (eq.status !== 'active') continue;
    const eqMaterials = matsByEq.get(eq.id) || [];
    if (eqMaterials.length === 0) continue;
    const fuelings = fuelingsMap.get(eq.id) || [];
    const currentReading = latestSaneReading(eq, fuelings);
    const byKey = buildIntervalStatusByKey(eq, fuelings, currentReading);

    // Group by structural service identity. Same identity used by the
    // materials table's UNIQUE INDEX (Codex amendment 3) so the grouping
    // stays stable across label edits.
    const groups = new Map();
    for (const m of eqMaterials) {
      const groupKey = `${m.source_kind}|${m.interval_unit}|${m.interval_value ?? ''}|${m.attachment_name ?? ''}`;
      const status = byKey.get(groupKey) || null;
      const {inWindow: ok, dueBucketValue, dueBucketUnit} = inWindow(m, status, eq);
      if (!ok) continue;
      // Skip if cleared in this bucket.
      const matClears = clearsByMat.get(m.id) || [];
      const cleared = matClears.some((c) => bucketEquals(c, dueBucketValue, dueBucketUnit));
      if (cleared) continue;
      const g = groups.get(groupKey) || {
        groupKey,
        source_kind: m.source_kind,
        interval_unit: m.interval_unit,
        interval_value: m.interval_value,
        attachment_name: m.attachment_name,
        service_label: m.service_label,
        status,
        due_bucket_value: dueBucketValue,
        due_bucket_unit: dueBucketUnit,
        materials: [],
      };
      g.materials.push(m);
      groups.set(groupKey, g);
    }
    if (groups.size === 0) continue;
    // Sort materials within each group by sort_order then name.
    for (const g of groups.values()) {
      g.materials.sort((a, b) => {
        const oa = Number.isFinite(a.sort_order) ? a.sort_order : 0;
        const ob = Number.isFinite(b.sort_order) ? b.sort_order : 0;
        if (oa !== ob) return oa - ob;
        return (a.material_name || '').localeCompare(b.material_name || '');
      });
    }
    // Sort groups by overdue first, then nearest-due, attachments after main intervals.
    const sortedGroups = Array.from(groups.values()).sort((a, b) => {
      const ao = a.status?.overdue ? 0 : 1;
      const bo = b.status?.overdue ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ad = a.status?.until_due ?? 1e9;
      const bd = b.status?.until_due ?? 1e9;
      if (ad !== bd) return ad - bd;
      const ak = a.source_kind === 'service_interval' ? 0 : 1;
      const bk = b.source_kind === 'service_interval' ? 0 : 1;
      return ak - bk;
    });
    out.push({equipment: eq, current_reading: currentReading, groups: sortedGroups});
  }
  // Sort equipment alphabetically by name for stable display.
  out.sort((a, b) => (a.equipment.name || '').localeCompare(b.equipment.name || ''));
  return out;
}
