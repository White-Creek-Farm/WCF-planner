// ============================================================================
// src/lib/pigForecast.js — pig weigh-in metrics + planned-trip helpers
// ----------------------------------------------------------------------------
// Pure module-scope helpers. No React, no Supabase, no app_store reads. All
// inputs flow in as arguments so every function is unit-testable. Used by the
// public weigh-in webform display, the admin LivestockWeighInsView, and the
// PigBatchesView planned-trip forecaster.
//
// Persisted planned-trip shape (per Codex's Q1 lock):
//   {id, date, sex, subBatchId, plannedCount, order}
// Projection fields (projectedMin/Max/Avg, ready, warnings) are recomputed
// LIVE in recalculateProjections — never persisted — so global ADG and date
// edits stay honest.
// ============================================================================

import {calcAgeRange} from './pig.js';

// Re-export so callers have a single import surface for forecast work.
export {calcAgeRange};

// ── Constants ───────────────────────────────────────────────────────────────
export const PLANNED_TRIP_MIN_SIZE = 5;
export const PLANNED_TRIP_MAX_SIZE = 12;
export const PLANNED_TRIP_TARGET_WEIGHT_LBS = 275;
export const PLANNED_TRIP_OVER_WEIGHT_WARN_LBS = 325;

// ── Feed math ───────────────────────────────────────────────────────────────

// Sum feed_lbs across pig_dailys rows on or before cutoffDate (ISO string,
// 'YYYY-MM-DD'). Rows without a date or feed_lbs contribute 0.
export function sumFeedLbs(pigDailys, cutoffDate) {
  if (!Array.isArray(pigDailys)) return 0;
  let total = 0;
  for (const r of pigDailys) {
    if (!r || !r.date) continue;
    if (typeof cutoffDate === 'string' && cutoffDate && r.date > cutoffDate) continue;
    const v = parseFloat(r.feed_lbs);
    if (!isNaN(v)) total += v;
  }
  return total;
}

// Feed per pig over the relevant interval. legacyFeedLbs covers any pre-
// dailys feed total stamped on the batch/sub. pigCount is the head count
// the feed was distributed across — caller decides whether that's the
// current ledger count or the original count.
//
// Returns lbs/pig as a number, or null when pigCount <= 0.
export function computeFeedPerPig({pigDailys, legacyFeedLbs, cutoffDate, pigCount}) {
  const head = parseInt(pigCount);
  if (!Number.isFinite(head) || head <= 0) return null;
  const fed = sumFeedLbs(pigDailys, cutoffDate) + (parseFloat(legacyFeedLbs) || 0);
  if (fed < 0) return 0;
  return fed / head;
}

// ── Weigh-in math ───────────────────────────────────────────────────────────

// Average weight from a list of weigh-in entries. Entries without a positive
// weight are skipped. Returns lbs (number) or null when no usable entries.
export function computeAvgWeight(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const e of entries) {
    if (!e) continue;
    const w = parseFloat(e.weight);
    if (!isNaN(w) && w > 0) {
      sum += w;
      n++;
    }
  }
  if (n === 0) return null;
  return sum / n;
}

// Group ADG between a current and prior session. Both sessions must carry an
// avgWeightLbs and a date (ISO 'YYYY-MM-DD'). Returns lb/day (number) or null
// when either side is missing or the dates are equal.
export function computeGroupADG(currentSession, priorSession) {
  if (!currentSession || !priorSession) return null;
  const cur = parseFloat(currentSession.avgWeightLbs);
  const prior = parseFloat(priorSession.avgWeightLbs);
  if (!isFinite(cur) || !isFinite(prior)) return null;
  if (!currentSession.date || !priorSession.date) return null;
  const days = isoDaysBetween(priorSession.date, currentSession.date);
  if (!days || days <= 0) return null;
  return (cur - prior) / days;
}

// ── Global ADG seed ─────────────────────────────────────────────────────────

// Seed a system-estimate global ADG from any usable session datapoints.
// usableSessions: [{ageDays, avgWeightLbs}] — caller derives ageDays from
// the cycle's birth window (oldestDays / youngestDays mid-point or similar).
// Returns {valueLbsPerDay, sampleCount} or null when no usable rows.
//
// Math: simple weighted-by-age slope through origin (sum(weight * age) /
// sum(age * age)). Per Codex's Q4: degrade cleanly when no usable estimate
// exists — return null and let the caller render "Projection unavailable."
export function seedGlobalADG(usableSessions) {
  if (!Array.isArray(usableSessions) || usableSessions.length === 0) return null;
  let sumWA = 0;
  let sumAA = 0;
  let n = 0;
  for (const s of usableSessions) {
    if (!s) continue;
    const a = parseFloat(s.ageDays);
    const w = parseFloat(s.avgWeightLbs);
    if (!isFinite(a) || a <= 0 || !isFinite(w) || w <= 0) continue;
    sumWA += w * a;
    sumAA += a * a;
    n++;
  }
  if (n === 0 || sumAA <= 0) return null;
  return {valueLbsPerDay: sumWA / sumAA, sampleCount: n};
}

// ── Planned-trip allocation ────────────────────────────────────────────────

// Build dated planned trips covering remainingCount pigs. Spaces trips evenly
// using PLANNED_TRIP_MAX_SIZE as the upper bound and PLANNED_TRIP_MIN_SIZE as
// the soft lower bound (under 5 is allowed but warned by recalculate).
//
// Args:
//   remainingCount         — pigs still in the subgroup, ledger-style (caller
//                            subtracts already-sent real trips, mortality, and
//                            transfers via the canonical helpers — do NOT
//                            double-subtract here).
//   sex                    — 'gilt' | 'boar'
//   subBatchId             — links back to feederGroup.subBatches[].id
//   startDate              — first trip's ISO date 'YYYY-MM-DD'
//   tripSpacingDays        — days between successive trips (default 14)
//   maxSize / minSize      — overrides; defaults to constants above
//
// Returns the persistable shape:
//   [{id, date, sex, subBatchId, plannedCount, order}]
// where order is a stable integer for tiebreaking when dates collide.
//
// Edge cases:
//   - remainingCount <= 0  -> []
//   - missing startDate    -> [] (caller should render "set a start date")
//   - leftover < minSize   -> kept as a smaller final trip (warned in
//                              recalculate, not blocked here)
export function allocatePlannedTrips({
  remainingCount,
  sex,
  subBatchId,
  startDate,
  tripSpacingDays = 14,
  maxSize = PLANNED_TRIP_MAX_SIZE,
  minSize = PLANNED_TRIP_MIN_SIZE,
  idFactory = defaultIdFactory,
}) {
  const head = parseInt(remainingCount);
  if (!Number.isFinite(head) || head <= 0) return [];
  if (typeof startDate !== 'string' || !startDate) return [];
  const max = Math.max(1, parseInt(maxSize) || PLANNED_TRIP_MAX_SIZE);
  const _minSize = Math.max(1, parseInt(minSize) || PLANNED_TRIP_MIN_SIZE);
  void _minSize; // referenced via constants above; not consumed here, kept
  // for future tuning of allocation strategy.

  const tripCount = Math.ceil(head / max);
  const baseSize = Math.floor(head / tripCount);
  const remainder = head - baseSize * tripCount;
  const trips = [];
  for (let i = 0; i < tripCount; i++) {
    const date = addDaysISO(startDate, i * (parseInt(tripSpacingDays) || 14));
    trips.push({
      id: idFactory(),
      date,
      sex,
      subBatchId,
      // Distribute the remainder across the EARLIEST trips so the latest trip
      // is the one most likely to fall under minSize, never the earliest.
      plannedCount: baseSize + (i < remainder ? 1 : 0),
      order: i,
    });
  }
  return trips;
}

// ── Move pigs between trips ────────────────────────────────────────────────

// Count-only move that respects Codex's rank rule implicitly:
//   sort by (date, order) — earliest trip owns the highest-ranked pigs.
//   moving OUT of an earlier trip removes its lowest-ranked pig
//   (rank window contracts at the bottom).
//   moving INTO an earlier trip takes the highest-ranked pig from the
//   source trip (rank window of source contracts at the top).
// Because rank is derived (not stored) and projections are recomputed
// from the rank window after the move, count-only mutation is sufficient.
//
// Throws (returns {error}) when:
//   - trip ids missing in trips
//   - count <= 0 or > source.plannedCount
//   - fromTripId === toTripId
//
// Returns updated trips array (immutable — caller's array unchanged).
export function movePigsBetweenTrips(trips, fromTripId, toTripId, count) {
  if (!Array.isArray(trips)) return {error: 'trips array required'};
  const c = parseInt(count);
  if (!Number.isFinite(c) || c <= 0) return {error: 'count must be a positive integer'};
  if (fromTripId === toTripId) return {error: 'fromTripId and toTripId must differ'};
  const from = trips.find((t) => t.id === fromTripId);
  const to = trips.find((t) => t.id === toTripId);
  if (!from) return {error: `fromTripId "${fromTripId}" not found`};
  if (!to) return {error: `toTripId "${toTripId}" not found`};
  const fromCount = parseInt(from.plannedCount) || 0;
  if (c > fromCount) return {error: `count ${c} exceeds source plannedCount ${fromCount}`};
  if (from.sex !== to.sex || from.subBatchId !== to.subBatchId) {
    return {error: 'planned trips must share sex and subBatchId to move pigs between them'};
  }
  return {
    trips: trips.map((t) => {
      if (t.id === fromTripId) return {...t, plannedCount: fromCount - c};
      if (t.id === toTripId) return {...t, plannedCount: (parseInt(t.plannedCount) || 0) + c};
      return t;
    }),
  };
}

// ── Live projection recompute ──────────────────────────────────────────────

// Recompute display-only projection fields for a list of planned trips.
// Returns the same trip shape plus derived live fields:
//   daysUntil              — date − referenceDate, integer
//   projectedMinLbs/MaxLbs — projected weight range at trip date
//   projectedAvgLbs        — projected average weight at trip date
//   ready                  — projectedAvgLbs >= targetWeightLbs
//   warnings               — array of 'undersized' | 'overweight'
//
// Per Codex's Q1: NEVER persist these fields. They are recomputed on every
// render so date/ADG edits stay honest.
//
// Two projection modes (selected per call, never mixed within a call):
//
//   1. WEIGH-IN MODE — latestEntries from this subgroup is non-empty.
//      Sort weights descending, slice the top of the stack to the earliest
//      trip's plannedCount (rank window), step the cursor down for each
//      subsequent trip. Each trip projects its slice forward by ADG × days.
//      Trips whose rank window falls beyond the available stack get null
//      projections (no fabricated data — caller surfaces "projection
//      unavailable" for those rows).
//
//   2. PRE-WEIGH-IN MODE — latestEntries empty/missing. Anonymous slots
//      based on the linked breeding cycle's age window plus ADG. Per
//      Ronnie: planned trips must exist as soon as a batch is created and
//      linked to a cycle, even before any weigh-in. Each trip projects
//      weight = (cycleAgeDays + daysUntil) × ADG, using the cycle's
//      youngest-and-oldest age range to produce the min/max band.
//
// Projection unavailable (null fields, no warnings beyond size) when:
//   - count <= 0
//   - no usable global/manual ADG
//   - in pre-weigh-in mode, no usable cycle age range
//   - in weigh-in mode, the rank window has no remaining weights
//
// Args:
//   plannedTrips           — persistable shape (sort order arbitrary; this
//                            function sorts internally for the rank window)
//   latestEntries          — [{weight}] from the latest weigh-in session;
//                            empty/null triggers pre-weigh-in mode
//   referenceDate          — ISO 'YYYY-MM-DD' anchoring "days until"; default
//                            todayISO() — passed in for testability
//   globalAdgLbsPerDay     — number; null when no system or manual ADG exists
//   cycleAgeDaysAtRef      — {minDays, maxDays} integers, the youngest and
//                            oldest pig age in the linked cycle as of
//                            referenceDate. Drive the pre-weigh-in band.
//                            Pass null when no cycle is linked or the cycle
//                            has no usable timeline.
//   targetWeightLbs        — ready threshold; default PLANNED_TRIP_TARGET
//   minSize                — undersized-warning threshold; default 5
//   overWeightWarnLbs      — overweight-warning threshold; default 325
export function recalculateProjections(
  plannedTrips,
  {
    latestEntries,
    referenceDate,
    globalAdgLbsPerDay,
    cycleAgeDaysAtRef,
    targetWeightLbs = PLANNED_TRIP_TARGET_WEIGHT_LBS,
    minSize = PLANNED_TRIP_MIN_SIZE,
    overWeightWarnLbs = PLANNED_TRIP_OVER_WEIGHT_WARN_LBS,
  } = {},
) {
  const trips = Array.isArray(plannedTrips) ? plannedTrips : [];
  const sorted = [...trips].sort(planedTripSortFn);
  const sortedWeights = (Array.isArray(latestEntries) ? latestEntries : [])
    .map((e) => parseFloat(e && e.weight))
    .filter((v) => isFinite(v) && v > 0)
    .sort((a, b) => b - a);
  const adg = parseFloat(globalAdgLbsPerDay);
  const adgValid = isFinite(adg);
  const ref = typeof referenceDate === 'string' && referenceDate ? referenceDate : todayISOSafe();
  const hasEntries = sortedWeights.length > 0;
  const cycleAge = normalizeCycleAge(cycleAgeDaysAtRef);

  let cursor = 0;
  return sorted.map((t) => {
    const count = parseInt(t.plannedCount) || 0;
    const days = isoDaysBetween(ref, t.date);
    const warnings = [];
    if (count > 0 && count < minSize) warnings.push('undersized');

    let projectedMinLbs = null;
    let projectedMaxLbs = null;
    let projectedAvgLbs = null;

    if (count > 0 && adgValid && days != null) {
      if (hasEntries) {
        const slice = sortedWeights.slice(cursor, cursor + count);
        cursor += count;
        if (slice.length > 0) {
          const lift = adg * days;
          const sliceMin = slice[slice.length - 1];
          const sliceMax = slice[0];
          const sliceAvg = slice.reduce((a, b) => a + b, 0) / slice.length;
          projectedMinLbs = sliceMin + lift;
          projectedMaxLbs = sliceMax + lift;
          projectedAvgLbs = sliceAvg + lift;
        }
      } else if (cycleAge) {
        // Pre-weigh-in mode: anonymous projection band from cycle age.
        const projAtTripYoungest = (cycleAge.minDays + days) * adg;
        const projAtTripOldest = (cycleAge.maxDays + days) * adg;
        projectedMinLbs = Math.min(projAtTripYoungest, projAtTripOldest);
        projectedMaxLbs = Math.max(projAtTripYoungest, projAtTripOldest);
        projectedAvgLbs = (projAtTripYoungest + projAtTripOldest) / 2;
      }

      if (projectedMaxLbs != null && projectedMaxLbs > overWeightWarnLbs) {
        warnings.push('overweight');
      }
    }

    const ready = projectedAvgLbs != null && projectedAvgLbs >= targetWeightLbs;
    return {
      ...t,
      plannedCount: count,
      daysUntil: days,
      projectedMinLbs,
      projectedMaxLbs,
      projectedAvgLbs,
      ready,
      warnings,
    };
  });
}

function normalizeCycleAge(input) {
  if (!input || typeof input !== 'object') return null;
  const minDays = parseFloat(input.minDays);
  const maxDays = parseFloat(input.maxDays);
  if (!isFinite(minDays) || !isFinite(maxDays)) return null;
  if (minDays < 0 || maxDays < 0) return null;
  return {minDays, maxDays};
}

// ── Internal helpers ───────────────────────────────────────────────────────

function planedTripSortFn(a, b) {
  if ((a && a.date) !== (b && b.date)) {
    if (!a || !a.date) return 1;
    if (!b || !b.date) return -1;
    return a.date.localeCompare(b.date);
  }
  return (parseInt((a && a.order) || 0) || 0) - (parseInt((b && b.order) || 0) || 0);
}

// Days between two ISO 'YYYY-MM-DD' dates (b - a). Negative when b < a.
// Returns null when either input is malformed.
function isoDaysBetween(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const da = new Date(a + 'T12:00:00');
  const db = new Date(b + 'T12:00:00');
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return null;
  return Math.round((db - da) / 86400000);
}

// Add N days to an ISO 'YYYY-MM-DD' and return ISO. Local-noon anchoring
// matches the rest of the codebase's date helpers.
function addDaysISO(iso, days) {
  if (typeof iso !== 'string') return iso;
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + (parseInt(days) || 0));
  return d.toISOString().slice(0, 10);
}

function todayISOSafe() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

let _idCounter = 0;
function defaultIdFactory() {
  _idCounter += 1;
  return `pt-${Date.now().toString(36)}-${_idCounter.toString(36)}`;
}
