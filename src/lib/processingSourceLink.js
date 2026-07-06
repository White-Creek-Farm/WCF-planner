// ============================================================================
// src/lib/processingSourceLink.js  —  Processing → source resolution (mig 155)
// ----------------------------------------------------------------------------
// Pure, read-only resolution of a processing record's SOURCE-owned display data
// from already-loaded planner source collections. The Processing domain stores
// a read-only (source_kind, source_id) link on planner_batch rows; the source
// facts (live status, number processed, on-farm age) are NEVER copied into the
// processing tables — they are resolved app-side from the live source so the
// drawer never drifts from the batch record. See src/lib/production.js for the
// canonical field names / key spellings this mirrors:
//   • broiler  — app_store 'ppp-v4' batches, keyed by batch.name
//                (Time On Farm = round((processingDate - hatchDate)/86400000))
//   • cattle   — cattle_processing_batches, keyed by batch.id
//                (number processed = length of cows_detail)
//   • sheep    — sheep_processing_batches, keyed by batch.id
//                (number processed = length of sheep_detail)
//   • pig      — app_store 'ppp-feeders-v1' feeder groups, keyed by the
//                composite 'groupId:tripId' (number processed = trip.pigCount)
//
// When the source row can't be found (imported historical rows, a deleted
// batch, a stale link) we fall back to the snapshot the record already carries
// (record columns + historical_snapshot) and NEVER throw. Route links point at
// the same record pages production.js's eventRecordPath uses.
// ============================================================================

import {
  processingStatusLabel,
  pigBatchProcessingStatusLabel,
  PROCESSING_STATUS_DISPLAY,
} from './processingStatusDisplay.js';

// ── Small local pure helpers (kept in-module so this stays dependency-light) ─

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonArrayLength(value) {
  if (Array.isArray(value)) return value.length;
  if (!value) return 0;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const match = String(value)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

// Whole-day gap between two ISO dates (later minus earlier), or null when either
// side is unparseable. Matches production.js's round((a - b)/86400000).
function wholeDaysBetween(laterISO, earlierISO) {
  const a = isoDate(laterISO);
  const b = isoDate(earlierISO);
  if (!a || !b) return null;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((ta - tb) / 86400000);
}

// Format a whole-day count as 'Nw Nd' (weeks + remainder days). Negative /
// null day counts return null (nothing sensible to display).
function weeksDaysText(days) {
  if (days === null || days === undefined || !Number.isFinite(days) || days < 0) return null;
  const weeks = Math.floor(days / 7);
  const rem = days % 7;
  return `${weeks}w ${rem}d`;
}

// Read a fallback value from the record's carried snapshot. Imported historical
// rows keep a historical_snapshot jsonb; we accept a small set of key spellings
// (camelCase + snake_case) since the snapshot is authored by the importer, not a
// frozen client contract. Returns the first defined, non-empty value or null.
function snapshotValue(record, keys) {
  const snap = record && record.historical_snapshot;
  if (!snap || typeof snap !== 'object') return null;
  for (const k of keys) {
    const v = snap[k];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function firstBatchName(batch) {
  return batch && (batch.name || batch.batchName || batch.batch_name);
}

// ── Per-program resolvers ────────────────────────────────────────────────────
// Each returns the shared shape {status, numberProcessed, ageText,
// timeOnFarmText, sourceRoute, matched} or null when no live source row is found
// (caller then falls back to the snapshot).

function resolveBroiler(record, broilerBatches) {
  const sourceId = record.source_id;
  if (!sourceId) return null;
  const batch = (broilerBatches || []).find((b) => firstBatchName(b) === sourceId);
  if (!batch) return null;
  const processingDate = batch.processingDate || batch.processing_date;
  const hatchDate = batch.hatchDate || batch.hatch_date;
  // Birds arrive as day-old chicks at hatch, so Time On Farm IS their age.
  const tof = weeksDaysText(wholeDaysBetween(processingDate, hatchDate));
  const name = firstBatchName(batch);
  return {
    status: batch.status ?? record.status ?? null,
    numberProcessed: numeric(batch.totalToProcessor ?? batch.total_to_processor),
    ageText: tof ?? snapshotValue(record, ['ageText', 'age_text', 'age']) ?? null,
    timeOnFarmText:
      tof ?? snapshotValue(record, ['timeOnFarmText', 'time_on_farm_text', 'timeOnFarm', 'time_on_farm']) ?? null,
    sourceRoute: name ? `/broiler/batches/${encodeURIComponent(name)}` : null,
    matched: true,
  };
}

function resolveCattleOrSheep(record, batches, {detailKey, route}) {
  const sourceId = record.source_id;
  if (!sourceId) return null;
  const batch = (batches || []).find((b) => String(b.id) === String(sourceId));
  if (!batch) return null;
  return {
    status: batch.status ?? record.status ?? null,
    numberProcessed: jsonArrayLength(batch[detailKey]),
    // Cattle/sheep aren't hatched on-farm, so there's no computable Time On Farm
    // here; age/time-on-farm come from the imported snapshot when present.
    ageText: snapshotValue(record, ['ageText', 'age_text', 'age']) ?? null,
    timeOnFarmText:
      snapshotValue(record, ['timeOnFarmText', 'time_on_farm_text', 'timeOnFarm', 'time_on_farm']) ?? null,
    sourceRoute: `${route}/${encodeURIComponent(batch.id)}`,
    matched: true,
  };
}

function resolvePig(record, feederGroups) {
  const sourceId = record.source_id;
  if (!sourceId) return null;
  const sep = String(sourceId).indexOf(':');
  if (sep < 0) return null;
  const groupId = String(sourceId).slice(0, sep);
  const tripId = String(sourceId).slice(sep + 1);
  const group = (feederGroups || []).find((g) => String(g.id) === groupId);
  if (!group) return null;
  const trip = (group.processingTrips || []).find((t) => String(t.id) === tripId);
  if (!trip) return null;
  return {
    // Pig feeder trips carry no per-trip status field; the record's own status
    // is the authority (deriveDisplayStatus applies the zero-head exception).
    status: record.status ?? null,
    numberProcessed: numeric(trip.pigCount),
    ageText: snapshotValue(record, ['ageText', 'age_text', 'age']) ?? null,
    timeOnFarmText:
      snapshotValue(record, ['timeOnFarmText', 'time_on_farm_text', 'timeOnFarm', 'time_on_farm']) ?? null,
    sourceRoute: `/pig/batches/${encodeURIComponent(group.id)}`,
    matched: true,
  };
}

// Snapshot-only fallback: no live source row was found (or none linked). Read
// everything from the record columns + carried snapshot; never throws.
function snapshotFallback(record) {
  return {
    status: record.status ?? null,
    numberProcessed:
      record.number_processed != null
        ? record.number_processed
        : numeric(snapshotValue(record, ['numberProcessed', 'number_processed', 'count'])),
    ageText: snapshotValue(record, ['ageText', 'age_text', 'age']) ?? null,
    timeOnFarmText:
      snapshotValue(record, ['timeOnFarmText', 'time_on_farm_text', 'timeOnFarm', 'time_on_farm']) ?? null,
    sourceRoute: null,
    matched: false,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

// Resolve a processing record's source-owned display data from the loaded
// planner collections. Returns
//   {status, numberProcessed, ageText, timeOnFarmText, sourceRoute, matched}
// where `status` is the RAW source/record status (feed it through
// deriveDisplayStatus for the Planned/In Process/Complete label). `matched`
// tells the caller whether a live source row backed the values (true) or they
// came from the record snapshot (false). Never throws.
export function resolveSourceForRecord(record, {broilerBatches, cattleBatches, sheepBatches, feederGroups} = {}) {
  if (!record) return snapshotFallback({});
  const program = record.source_kind || record.program;
  let resolved = null;
  try {
    if (program === 'broiler') {
      resolved = resolveBroiler(record, broilerBatches);
    } else if (program === 'cattle') {
      resolved = resolveCattleOrSheep(record, cattleBatches, {
        detailKey: 'cows_detail',
        route: '/cattle/batches',
      });
    } else if (program === 'sheep') {
      resolved = resolveCattleOrSheep(record, sheepBatches, {
        detailKey: 'sheep_detail',
        route: '/sheep/batches',
      });
    } else if (program === 'pig') {
      resolved = resolvePig(record, feederGroups);
    }
  } catch (_e) {
    // Any unexpected shape in the source collections must not break the drawer;
    // fall through to the snapshot.
    resolved = null;
  }
  return resolved || snapshotFallback(record);
}

// Derive the display status label (Planned / In Process / Complete) for a
// record given its resolved source info. Rules:
//   • completed_at set (or the record is complete) => Complete, always.
//   • planner_batch => derive from the SOURCE status; pig applies the zero-head
//     exception (an "active" pig batch with 0 head still reads Planned).
//   • milestone / asana_historical / import_exception => use the record status.
export function deriveDisplayStatus(record, sourceInfo = null) {
  if (!record) return PROCESSING_STATUS_DISPLAY.planned;
  if (record.completed_at) return PROCESSING_STATUS_DISPLAY.complete;
  if (String(record.status || '').toLowerCase() === 'complete') return PROCESSING_STATUS_DISPLAY.complete;

  if (record.record_type === 'planner_batch') {
    const program = record.source_kind || record.program;
    const rawStatus = (sourceInfo && sourceInfo.status != null ? sourceInfo.status : record.status) ?? null;
    if (program === 'pig') {
      const started =
        sourceInfo && sourceInfo.numberProcessed != null ? sourceInfo.numberProcessed : record.number_processed;
      return pigBatchProcessingStatusLabel(rawStatus, {started});
    }
    return processingStatusLabel(rawStatus);
  }
  return processingStatusLabel(record.status);
}
