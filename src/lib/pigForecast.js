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

import {calcAgeRange, cycleRecords, daysToMWD} from './pig.js';

// Re-export so callers have a single import surface for forecast work.
export {calcAgeRange};

// ── Display formatters (used by public weigh-in webform + admin view) ───────
// Pure presentational; never persisted. Keep formatting byte-identical
// across surfaces by importing these wherever a metric is rendered.

const NO_VALUE = '—';

// "5m 2w – 5m 5w" or "5m 2w – 5m 5w (est.)"; returns '—' when either bound
// is null. Per Codex: do not infer not-yet-born from null bounds — the RPC
// owns that decision and surfaces both as null when it does not have
// enough data; the formatter stays conservative.
export function formatAgeRange({minDays, maxDays, hasActual} = {}) {
  if (minDays == null || maxDays == null) return NO_VALUE;
  const min = parseFloat(minDays);
  const max = parseFloat(maxDays);
  if (!isFinite(min) || !isFinite(max)) return NO_VALUE;
  const minLabel = min <= 0 ? '0m 0w' : daysToMWD(min) || '0m 0w';
  const maxLabel = max <= 0 ? '0m 0w' : daysToMWD(max) || '0m 0w';
  return `${minLabel} – ${maxLabel}${hasActual ? '' : ' (est.)'}`;
}

// "416 lb" or '—'.
export function formatFeedPerPig(n) {
  if (n == null) return NO_VALUE;
  const v = parseFloat(n);
  if (!isFinite(v)) return NO_VALUE;
  return `${Math.round(v)} lb`;
}

// "+1.82 lb/day" / "-0.50 lb/day" / "0.00 lb/day" / "— no prior weigh-in".
// ASCII hyphen-minus per Codex's W6 correction.
export function formatGroupAdg(n) {
  if (n == null) return '— no prior weigh-in';
  const v = parseFloat(n);
  if (!isFinite(v)) return '— no prior weigh-in';
  const rounded = Math.round(v * 100) / 100;
  if (rounded === 0) return '0.00 lb/day';
  const sign = rounded > 0 ? '+' : '-';
  return `${sign}${Math.abs(rounded).toFixed(2)} lb/day`;
}

// "263 lb" or '—'.
export function formatAvgWeight(n) {
  if (n == null) return NO_VALUE;
  const v = parseFloat(n);
  if (!isFinite(v)) return NO_VALUE;
  return `${Math.round(v)} lb`;
}

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

// Prior pig session lookup for the same batch/sub-batch slug. Mirrors the
// pig_session_metrics RPC: prior means same slug, earlier session date, newest
// date first with started_at as the tie-break.
export function findPriorPigWeighInSession(currentSession, sessions) {
  if (!currentSession || !Array.isArray(sessions)) return null;
  const currentSlug = pigSessionSlug(currentSession.batch_id);
  if (!currentSlug || !currentSession.date) return null;
  return (
    sessions
      .filter((s) => {
        if (!s || s.id === currentSession.id) return false;
        if (s.species && s.species !== 'pig') return false;
        if (pigSessionSlug(s.batch_id) !== currentSlug) return false;
        return typeof s.date === 'string' && s.date < currentSession.date;
      })
      .sort(
        (a, b) =>
          (b.date || '').localeCompare(a.date || '') ||
          (b.started_at || '').localeCompare(a.started_at || '') ||
          String(b.id || '').localeCompare(String(a.id || '')),
      )[0] || null
  );
}

// Per-entry pig ADG where pigs do not have stable individual IDs/tags. This is
// intentionally rank-matched, not identity-matched: sort current and prior
// session weights ASC, pair by rank, and compute gain/day for each current
// entry. That mirrors the RPC group ADG algorithm while keeping the UI honest
// about anonymous pigs.
export function computeRankMatchedPigEntryADG(currentEntries, priorEntries, currentDate, priorDate) {
  const days = isoDaysBetween(priorDate, currentDate);
  if (days == null || days <= 0) return [];
  const current = rankPigWeightsAsc(currentEntries);
  const prior = rankPigWeightsAsc(priorEntries);
  const n = Math.min(current.length, prior.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const cur = current[i];
    const prev = prior[i];
    out.push({
      entryId: cur.entryId,
      rank: i + 1,
      currentDate,
      priorDate,
      daysBetween: days,
      currentWeightLbs: cur.weight,
      priorWeightLbs: prev.weight,
      weightDeltaLbs: cur.weight - prev.weight,
      adgLbsPerDay: (cur.weight - prev.weight) / days,
    });
  }
  return out;
}

export function computeRankMatchedPigGroupADG(currentEntries, priorEntries, currentDate, priorDate) {
  const matched = computeRankMatchedPigEntryADG(currentEntries, priorEntries, currentDate, priorDate);
  if (matched.length === 0) return null;
  return matched.reduce((sum, m) => sum + m.adgLbsPerDay, 0) / matched.length;
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

// Farrowing-weighted age distribution for planned/actual trip forecasts.
// Actual farrowing records are weighted by alive count (or totalBorn - deaths
// for legacy rows). When actual counts are unavailable, callers can pass the
// cycle age band as a conservative fallback; fallback bands do not narrow by
// trip rank because there is no real distribution to slice.
export function buildFarrowingAgeDistribution({
  cycleId,
  asOfDate,
  breedingCycles,
  farrowingRecs,
  cycleAgeDaysAtRef,
} = {}) {
  const refISO = normalizeISODate(asOfDate);
  const cycles = Array.isArray(breedingCycles) ? breedingCycles : [];
  const cycle = cycles.find((c) => c && c.id === cycleId);
  const recs = cycle ? cycleRecords(cycle, farrowingRecs || []) : [];
  const byAge = new Map();
  let totalWeight = 0;

  if (refISO) {
    for (const r of recs) {
      const count = farrowingForecastCount(r);
      if (count <= 0 || !r || !r.farrowingDate) continue;
      const days = isoDaysBetween(String(r.farrowingDate).slice(0, 10), refISO);
      if (days == null) continue;
      const ageDays = Math.max(0, days);
      byAge.set(ageDays, (byAge.get(ageDays) || 0) + count);
      totalWeight += count;
    }
  }

  if (totalWeight > 0) {
    const buckets = [...byAge.entries()]
      .map(([ageDays, weight]) => ({ageDays, weight}))
      .sort((a, b) => b.ageDays - a.ageDays);
    return {
      source: 'farrowing-weighted',
      hasActual: true,
      buckets,
      totalWeight,
      minDays: buckets[buckets.length - 1].ageDays,
      maxDays: buckets[0].ageDays,
    };
  }

  const fallback = normalizeCycleAge(cycleAgeDaysAtRef);
  if (!fallback) return null;
  return {
    source: 'estimated-cycle-band',
    hasActual: false,
    minDays: fallback.minDays,
    maxDays: fallback.maxDays,
    avgDays: (fallback.minDays + fallback.maxDays) / 2,
  };
}

export function projectFarrowingAgeWindow(distribution, {populationCount, rankOffset = 0, windowCount} = {}) {
  const dist = normalizeAgeDistribution(distribution);
  const count = parseInt(windowCount);
  if (!dist || !Number.isFinite(count) || count <= 0) return null;

  if (dist.source !== 'farrowing-weighted') {
    return {
      source: dist.source,
      hasActual: false,
      minDays: dist.minDays,
      maxDays: dist.maxDays,
      avgDays: dist.avgDays != null ? dist.avgDays : (dist.minDays + dist.maxDays) / 2,
    };
  }

  const pop = parseFloat(populationCount);
  if (!isFinite(pop) || pop <= 0 || !dist.totalWeight || dist.totalWeight <= 0) return null;
  const offset = Math.max(0, parseFloat(rankOffset) || 0);
  if (offset >= pop) return null;
  const endRank = Math.min(pop, offset + count);
  if (endRank <= offset) return null;

  const scale = dist.totalWeight / pop;
  const sourceStart = offset * scale;
  const sourceEnd = endRank * scale;
  let cursor = 0;
  let minDays = null;
  let maxDays = null;
  let sumAge = 0;
  let sumWeight = 0;

  for (const bucket of dist.buckets) {
    const bucketStart = cursor;
    const bucketEnd = cursor + bucket.weight;
    const overlap = Math.min(bucketEnd, sourceEnd) - Math.max(bucketStart, sourceStart);
    if (overlap > 1e-9) {
      minDays = minDays == null ? bucket.ageDays : Math.min(minDays, bucket.ageDays);
      maxDays = maxDays == null ? bucket.ageDays : Math.max(maxDays, bucket.ageDays);
      sumAge += bucket.ageDays * overlap;
      sumWeight += overlap;
    }
    cursor = bucketEnd;
    if (cursor >= sourceEnd) break;
  }

  if (sumWeight <= 0 || minDays == null || maxDays == null) return null;
  return {
    source: dist.source,
    hasActual: true,
    minDays,
    maxDays,
    avgDays: sumAge / sumWeight,
  };
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

// ── Manual planned-trip mutations (admin/management surfaces) ──────────────
//
// All three helpers below preserve the persisted 6-key shape exactly:
//   {id, date, sex, subBatchId, plannedCount, order}
// Projection / warning / ready / ADG fields are NEVER persisted; callers
// pipe results through recalculateProjections on render.
//
// Inputs are treated as immutable — every helper returns a fresh array.

/**
 * Append a manual planned trip to the (subBatchId, sex) chain. CRITICAL:
 * preserves the chain's total plannedCount when adding to an existing
 * chain. A positive-count add draws those pigs from a single existing
 * trip in the chain (per Codex pig planned trips lane spec):
 *   - new date AFTER all existing trips → draw from the nearest PRIOR
 *     existing trip (last in chain by date asc).
 *   - new date BEFORE the first existing trip → draw from the NEXT
 *     trip (first in chain by date asc).
 *   - new date BETWEEN existing trips → prefer the previous trip unless
 *     it lacks enough plannedCount, then fall back to the next trip.
 * If the requested count cannot be fully drawn from a single source
 * trip, the helper refuses with an error.
 *
 * 0-count add is always allowed (creates a placeholder for future
 * count-moves via ← / →). A positive-count first trip on an empty
 * chain is allowed (no draw needed — establishes the chain).
 *
 * order = max(existing order in chain) + 1.
 *
 * Returns {trips} on success or {error}.
 */
export function addPlannedTrip(trips, {subBatchId, sex, date, plannedCount, idFactory = defaultIdFactory} = {}) {
  if (!Array.isArray(trips)) return {error: 'trips array required'};
  if (typeof subBatchId !== 'string' || !subBatchId) return {error: 'subBatchId required'};
  if (sex !== 'gilt' && sex !== 'boar') return {error: 'sex must be "gilt" or "boar"'};
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return {error: 'date must be YYYY-MM-DD'};
  const count = parseInt(plannedCount);
  if (!Number.isFinite(count) || count < 0) return {error: 'plannedCount must be a non-negative integer'};

  const chain = trips
    .filter((t) => t && t.subBatchId === subBatchId && t.sex === sex)
    .slice()
    .sort(planedTripSortFn);

  let maxOrder = -1;
  for (const t of chain) {
    const o = parseInt(t.order);
    if (Number.isFinite(o) && o > maxOrder) maxOrder = o;
  }

  // Build the new trip first; we'll append it AND (when count > 0 and
  // the chain is non-empty) reduce one source trip's plannedCount to
  // preserve chain total.
  const newTrip = {
    id: idFactory(),
    date,
    sex,
    subBatchId,
    plannedCount: count,
    order: maxOrder + 1,
  };

  // Empty chain or 0-count add: no source draw needed.
  if (count === 0 || chain.length === 0) {
    return {trips: [...trips, newTrip]};
  }

  // Find prev (last trip with date <= newDate) and next (first trip with
  // date > newDate). Equal-date inserts are treated as "between" with
  // previous as the source.
  let prevTrip = null;
  let nextTrip = null;
  for (const t of chain) {
    if (t.date <= date) prevTrip = t;
    else if (!nextTrip) nextTrip = t;
  }

  // Prefer prev when it has enough; otherwise fall back to next.
  let source = null;
  if (prevTrip && (parseInt(prevTrip.plannedCount) || 0) >= count) {
    source = prevTrip;
  } else if (nextTrip && (parseInt(nextTrip.plannedCount) || 0) >= count) {
    source = nextTrip;
  }
  if (!source) {
    return {
      error:
        'Cannot draw the requested count from the existing chain. Reduce the new trip count or move pigs in the chain first.',
    };
  }

  const sourceId = source.id;
  return {
    trips: [
      ...trips.map((t) => (t.id === sourceId ? {...t, plannedCount: (parseInt(t.plannedCount) || 0) - count} : t)),
      newTrip,
    ],
  };
}

/**
 * Delete a planned trip and reconcile its plannedCount onto another trip
 * in the same (subBatchId, sex) chain. Per Codex's lane spec:
 *   - Move pigs to the NEXT planned trip in the chain (sorted by date asc,
 *     order asc).
 *   - If no next exists, move to the PREVIOUS trip.
 *   - If the chain has only this trip (no next AND no previous), refuse:
 *     deletion would lose the planned-count signal, and the UI gate already
 *     disables the button in that case as a defensive double-check.
 *
 * Returns {trips} on success or {error}.
 */
export function deletePlannedTripWithReconciliation(trips, tripId) {
  if (!Array.isArray(trips)) return {error: 'trips array required'};
  if (typeof tripId !== 'string' || !tripId) return {error: 'tripId required'};
  const target = trips.find((t) => t && t.id === tripId);
  if (!target) return {error: `tripId "${tripId}" not found`};
  const chain = trips
    .filter((t) => t && t.subBatchId === target.subBatchId && t.sex === target.sex)
    .slice()
    .sort(planedTripSortFn);
  if (chain.length <= 1) {
    return {error: 'cannot delete the only planned trip in this chain'};
  }
  const idx = chain.findIndex((t) => t.id === tripId);
  const nextTrip = idx >= 0 && idx + 1 < chain.length ? chain[idx + 1] : null;
  const prevTrip = idx > 0 ? chain[idx - 1] : null;
  const recipient = nextTrip || prevTrip;
  if (!recipient) {
    // Defensive — chain.length > 1 should always yield a recipient, but
    // bail rather than silently drop the count.
    return {error: 'no recipient trip available for reconciliation'};
  }
  const movedCount = parseInt(target.plannedCount) || 0;
  return {
    trips: trips
      .filter((t) => t.id !== tripId)
      .map((t) => (t.id === recipient.id ? {...t, plannedCount: (parseInt(t.plannedCount) || 0) + movedCount} : t)),
  };
}

/**
 * Reconciliation recipient PREVIEW for a planned-trip delete — the trip that
 * deletePlannedTripWithReconciliation would fold the deleted trip's
 * plannedCount onto: NEXT in the (subBatchId, sex) chain, falling back to
 * PREVIOUS when the deleted trip is last. Returns the recipient trip object,
 * or null (target missing, or chain has only the target).
 *
 * The UI uses this to label the delete confirmation before committing. Sort is
 * kept inline (date asc, then order asc; missing-date sorts first) verbatim
 * from PigBatchesView rather than reusing planedTripSortFn — the two agree for
 * the locked planned-trip shape (date always present) but differ on
 * missing-date trips, so this preserves the prior behavior exactly.
 */
export function deleteReconciliationRecipient(plannedTrips, tripId) {
  if (!Array.isArray(plannedTrips)) return null;
  const target = plannedTrips.find((t) => t.id === tripId);
  if (!target) return null;
  const chain = plannedTrips
    .filter((t) => t.subBatchId === target.subBatchId && t.sex === target.sex)
    .slice()
    .sort((a, b) => {
      const dA = a.date || '';
      const dB = b.date || '';
      if (dA === dB) return (a.order || 0) - (b.order || 0);
      return dA.localeCompare(dB);
    });
  const idx = chain.findIndex((t) => t.id === tripId);
  if (idx < 0) return null;
  return chain[idx + 1] || chain[idx - 1] || null;
}

/**
 * Reconcile planned trips for a weigh-in send. Resolves the target planned
 * trip (next future date in the (subBatchId, sex) chain; falls back to
 * earliest if all dates are in the past) and folds sendCount onto the
 * chain per Codex's three-branch rule:
 *
 *   sendCount === target.plannedCount → consume target (remove).
 *   sendCount  <  target.plannedCount → consume target, push remainder
 *                                        (planned - send) onto NEXT trip.
 *                                        If no next trip exists, keep the
 *                                        target alive with the remainder
 *                                        and surface remainderStayedOnTarget
 *                                        =true so the caller can render
 *                                        residual-aware copy.
 *   sendCount  >  target.plannedCount → consume target, then pull extra
 *                                        from later trips in chain order
 *                                        until satisfied. If chain
 *                                        exhausts, error.
 *
 * The over-pull error matches Codex's option (a): refuse rather than
 * silently leaving an imbalanced chain. Under-pull with no next trip
 * does NOT block — the helper preserves the remainder by reducing the
 * target's plannedCount and surfaces remainderStayedOnTarget=true so
 * the caller can render branch-aware copy.
 *
 * Returns {updatedPlannedTrips, targetTripId, targetTripDate,
 * pushedRemainder, remainderStayedOnTarget} on success, or {error}
 * when:
 *   - chain has no planned trip for this (subBatchId, sex) pair
 *   - over-pull beyond chain
 */
export function reconcilePlannedTripsForSend(plannedTrips, {subBatchId, sex, sendCount, today = todayISOSafe()} = {}) {
  if (!Array.isArray(plannedTrips)) return {error: 'plannedTrips array required'};
  if (typeof subBatchId !== 'string' || !subBatchId) return {error: 'subBatchId required'};
  if (sex !== 'gilt' && sex !== 'boar') return {error: 'sex must be "gilt" or "boar"'};
  const send = parseInt(sendCount);
  if (!Number.isFinite(send) || send <= 0) return {error: 'sendCount must be a positive integer'};

  const chain = plannedTrips
    .filter((t) => t && t.subBatchId === subBatchId && t.sex === sex)
    .slice()
    .sort(planedTripSortFn);
  if (chain.length === 0) {
    return {error: 'No planned trip exists for this sub-batch — create one in /pig/batches first.'};
  }

  // Target = first chain trip whose date >= today; fall back to the
  // earliest chain trip if every trip is in the past (e.g., overdue
  // shipments). The chain is already sorted by date+order.
  let targetIdx = chain.findIndex((t) => typeof t.date === 'string' && t.date >= today);
  if (targetIdx === -1) targetIdx = 0;
  const target = chain[targetIdx];
  const targetCount = parseInt(target.plannedCount) || 0;

  // Total available across target + later trips. Used for the over-pull
  // chain-exhausted check.
  let availableForward = 0;
  for (let i = targetIdx; i < chain.length; i++) {
    availableForward += parseInt(chain[i].plannedCount) || 0;
  }
  if (send > availableForward) {
    return {
      error:
        'Selected pigs exceed the total planned count for this sub-batch. Add another planned trip on /pig/batches or reduce the selection.',
    };
  }

  // Build the consumed map: trip.id → plannedCount delta to apply.
  // Negative deltas reduce the trip; full consumption removes the trip.
  const removed = new Set();
  const adjusted = new Map(); // tripId → new plannedCount (when not removed)
  let needed = send;
  let pushedRemainder = 0;
  let remainderStayedOnTarget = false;

  if (send === targetCount) {
    removed.add(target.id);
    needed = 0;
  } else if (send < targetCount) {
    // Under-pull. Codex amendment: if a next trip exists, push the
    // remainder forward (target consumed). If no next trip exists, keep
    // target alive with reduced plannedCount = target - send, so the
    // residual count can be sent later. Either way the actual processing
    // trip is created with sendCount.
    const remainder = targetCount - send;
    const nextTrip = chain[targetIdx + 1];
    if (nextTrip) {
      removed.add(target.id);
      adjusted.set(nextTrip.id, (parseInt(nextTrip.plannedCount) || 0) + remainder);
    } else {
      adjusted.set(target.id, remainder);
      remainderStayedOnTarget = true;
    }
    pushedRemainder = remainder;
    needed = 0;
  } else {
    // Over-pull: consume target fully, then pull from later trips in order.
    removed.add(target.id);
    needed = send - targetCount;
    for (let i = targetIdx + 1; i < chain.length && needed > 0; i++) {
      const t = chain[i];
      const have = parseInt(t.plannedCount) || 0;
      if (needed >= have) {
        removed.add(t.id);
        needed -= have;
      } else {
        adjusted.set(t.id, have - needed);
        needed = 0;
      }
    }
    if (needed > 0) {
      // availableForward check above should prevent this — defensive.
      return {error: 'Selected pigs exceed the total planned count (chain exhausted).'};
    }
  }

  const updatedPlannedTrips = plannedTrips
    .filter((t) => !removed.has(t.id))
    .map((t) => (adjusted.has(t.id) ? {...t, plannedCount: adjusted.get(t.id)} : t));

  return {
    updatedPlannedTrips,
    targetTripId: target.id,
    targetTripDate: target.date,
    pushedRemainder,
    remainderStayedOnTarget,
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
// Forecast mode:
//   Farrowing age at trip date × Global ADG. Actual farrowing records are
//   sliced oldest-first by farrowing-count weighted rank windows. Weigh-in
//   entries are intentionally ignored here; they belong in actual-vs-forecast
//   comparison, not in planned-trip projections.
//
// Projection unavailable (null fields, no warnings beyond size) when:
//   - count <= 0
//   - no usable global/manual ADG
//   - no usable farrowing distribution or fallback cycle age range
//   - the rank window has no remaining forecast population
//
// Args:
//   plannedTrips           — persistable shape (sort order arbitrary; this
//                            function sorts internally for the rank window)
//   referenceDate          — ISO 'YYYY-MM-DD' anchoring "days until"; default
//                            todayISO() — passed in for testability
//   globalAdgLbsPerDay     — number; null when no system or manual ADG exists
//   cycleAgeDaysAtRef      — {minDays, maxDays} integers, the youngest and
//                            oldest pig age at referenceDate, used only as a
//                            conservative fallback band.
//   ageDistributionAtRef   — buildFarrowingAgeDistribution() result
//   populationCount        — total forecast population for this sub-batch
//   alreadyShippedCount    — processed pigs to drop from the oldest side
//   targetWeightLbs        — ready threshold; default PLANNED_TRIP_TARGET
//   minSize                — undersized-warning threshold; default 5
//   overWeightWarnLbs      — overweight-warning threshold; default 325
export function recalculateProjections(
  plannedTrips,
  {
    referenceDate,
    globalAdgLbsPerDay,
    cycleAgeDaysAtRef,
    ageDistributionAtRef,
    populationCount,
    alreadyShippedCount = 0,
    targetWeightLbs = PLANNED_TRIP_TARGET_WEIGHT_LBS,
    minSize = PLANNED_TRIP_MIN_SIZE,
    overWeightWarnLbs = PLANNED_TRIP_OVER_WEIGHT_WARN_LBS,
  } = {},
) {
  const trips = Array.isArray(plannedTrips) ? plannedTrips : [];
  const sorted = [...trips].sort(planedTripSortFn);
  const adg = parseFloat(globalAdgLbsPerDay);
  const adgValid = isFinite(adg);
  const ref = typeof referenceDate === 'string' && referenceDate ? referenceDate : todayISOSafe();
  const distribution =
    normalizeAgeDistribution(ageDistributionAtRef) || buildFarrowingAgeDistribution({asOfDate: ref, cycleAgeDaysAtRef});
  const shipped = Math.max(0, parseFloat(alreadyShippedCount) || 0);
  const totalPlanned = sorted.reduce((sum, t) => sum + (parseInt(t && t.plannedCount) || 0), 0);
  const pop = parseFloat(populationCount);
  const projectedPopulation = isFinite(pop) && pop > 0 ? pop : shipped + totalPlanned;

  let cursor = shipped;
  return sorted.map((t) => {
    const count = parseInt(t.plannedCount) || 0;
    const days = isoDaysBetween(ref, t.date);
    const warnings = [];
    if (count > 0 && count < minSize) warnings.push('undersized');

    let projectedMinLbs = null;
    let projectedMaxLbs = null;
    let projectedAvgLbs = null;
    let projectionSource = null;
    let projectionHasActualFarrowing = false;

    if (count > 0 && adgValid && days != null && distribution) {
      const ageWindow = projectFarrowingAgeWindow(distribution, {
        populationCount: projectedPopulation,
        rankOffset: cursor,
        windowCount: count,
      });
      cursor += count;
      if (ageWindow) {
        const minAgeAtTrip = Math.max(0, ageWindow.minDays + days);
        const maxAgeAtTrip = Math.max(0, ageWindow.maxDays + days);
        const avgAgeAtTrip = Math.max(0, ageWindow.avgDays + days);
        projectedMinLbs = Math.min(minAgeAtTrip, maxAgeAtTrip) * adg;
        projectedMaxLbs = Math.max(minAgeAtTrip, maxAgeAtTrip) * adg;
        projectedAvgLbs = avgAgeAtTrip * adg;
        projectionSource = ageWindow.source;
        projectionHasActualFarrowing = !!ageWindow.hasActual;
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
      projectionSource,
      projectionHasActualFarrowing,
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

function normalizeAgeDistribution(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.source === 'farrowing-weighted') {
    const buckets = (Array.isArray(input.buckets) ? input.buckets : [])
      .map((b) => ({ageDays: parseFloat(b && b.ageDays), weight: parseFloat(b && b.weight)}))
      .filter((b) => isFinite(b.ageDays) && b.ageDays >= 0 && isFinite(b.weight) && b.weight > 0)
      .sort((a, b) => b.ageDays - a.ageDays);
    const totalWeight = buckets.reduce((sum, b) => sum + b.weight, 0);
    if (buckets.length === 0 || totalWeight <= 0) return null;
    return {
      source: 'farrowing-weighted',
      hasActual: true,
      buckets,
      totalWeight,
      minDays: buckets[buckets.length - 1].ageDays,
      maxDays: buckets[0].ageDays,
    };
  }

  const band = normalizeCycleAge(input);
  if (!band) return null;
  return {
    source: input.source || 'estimated-cycle-band',
    hasActual: false,
    minDays: band.minDays,
    maxDays: band.maxDays,
    avgDays:
      input.avgDays != null && isFinite(parseFloat(input.avgDays))
        ? parseFloat(input.avgDays)
        : (band.minDays + band.maxDays) / 2,
  };
}

function farrowingForecastCount(r) {
  if (!r) return 0;
  if (r.alive != null && r.alive !== '' && !Number.isNaN(Number(r.alive))) {
    return Math.max(0, parseInt(r.alive) || 0);
  }
  return Math.max(0, (parseInt(r.totalBorn) || 0) - (parseInt(r.deaths) || 0));
}

function normalizeISODate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (value instanceof Date && !isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return null;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function pigSessionSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function rankPigWeightsAsc(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((e) => ({
      entryId: e && e.id != null ? String(e.id) : null,
      weight: parseFloat(e && e.weight),
    }))
    .filter((e) => isFinite(e.weight) && e.weight > 0)
    .sort((a, b) => a.weight - b.weight || String(a.entryId || '').localeCompare(String(b.entryId || '')));
}

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
