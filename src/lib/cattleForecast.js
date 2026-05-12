// Cattle Forecast — pure deterministic helper.
// No React, no supabase, no Date mutation, no side effects, no I/O.
// Single source of truth for inclusion rules, ADG ladder, projection math,
// month assignment with hide-state, virtual batch generation + naming, and
// the WeighIns Send-to-Processor gate.
//
// Shared by:
//   - src/cattle/CattleForecastView.jsx (the Forecast tab)
//   - src/cattle/CattleBatchesView.jsx  (planned/active/complete sections)
//   - WeighIns Send-to-Processor flow   (forecast gate on the modal submit)

import {cowTagSet} from './cattleHerdFilters.js';

const DAY_MS = 86400000;

// ── locked defaults (mirrored in mig 043) ─────────────────────────────────────
export const FORECAST_DISPLAY_WEIGHT_MIN_DEFAULT = 1200;
export const FORECAST_DISPLAY_WEIGHT_MAX_DEFAULT = 1500;
export const FORECAST_FALLBACK_ADG_DEFAULT = 1.18;
export const FORECAST_BIRTH_WEIGHT_LB_DEFAULT = 64;
export const FORECAST_HORIZON_YEARS_DEFAULT = 3;
export const FORECAST_INCLUDED_HERDS_DEFAULT = Object.freeze(['finishers', 'backgrounders']);
// ADG source labels emitted on every animal row. Codex 2026-05-04 ladder:
// cattle weigh-ins happen ~1x/month max, so a calendar-window rolling ADG
// over-rejects valid cattle. Switched to count-based "last N weigh-ins":
//   LAST_3:  ≥ 3 usable weigh-ins → ADG over the span of latest 3
//   LAST_2:  exactly 2 usable     → ADG over those two
//   ONE_PLUS_FALLBACK: 1 weigh-in + global ADG
//   DOB_PLUS_FALLBACK: no weigh-ins + DOB + birth weight + global ADG
//   GLOBAL_ONLY: momma steers + selected momma heifers (ladder bypassed)
//   NONE: watchlist
export const ADG_SOURCES = Object.freeze({
  LAST_3: 'last_3',
  LAST_2: 'last_2',
  ONE_PLUS_FALLBACK: 'one_plus_fallback',
  DOB_PLUS_FALLBACK: 'dob_plus_fallback',
  GLOBAL_ONLY: 'global_only',
  NONE: 'none',
});

// Watchlist reasons (one cow can carry multiple).
export const WATCHLIST_REASONS = Object.freeze({
  NO_WEIGHT_NO_DOB: 'no_weight_no_dob',
  NEGATIVE_ADG_NO_FINISH: 'negative_adg_no_finish',
  NEVER_REACHES_WINDOW: 'never_reaches_window',
  ALREADY_OVER_MAX: 'already_over_max',
  PROJECTS_PAST_MAX: 'projects_past_max', // assignment-horizon-start projection > displayMax
  ALL_ELIGIBLE_HIDDEN: 'all_eligible_hidden',
});

// ── month / date helpers (timezone-stable via UTC noon parsing) ───────────────

export function monthKey(year, month1to12) {
  const m = String(month1to12).padStart(2, '0');
  return `${year}-${m}`;
}

export function parseMonthKey(key) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key || '');
  if (!m) return null;
  return {year: parseInt(m[1], 10), month: parseInt(m[2], 10)};
}

// Display horizon — full calendar months for chart and bucket rendering.
// Starts at January of the current year so the chart can show past-actuals
// alongside projections.
export function monthsInHorizon(todayMs, horizonYears) {
  const t = new Date(todayMs);
  const startYear = t.getUTCFullYear();
  const endYear = startYear + Math.max(0, horizonYears);
  const out = [];
  for (let y = startYear; y <= endYear; y++) {
    for (let m = 1; m <= 12; m++) {
      out.push(monthKey(y, m));
    }
  }
  return out;
}

// Assignment horizon — current month + future months only. Past months are
// excluded so a cow already at target weight cannot be assigned to January
// of the current year via backward projection. Rollover-forward semantics:
// month rolls past, cow that wasn't sent or hidden re-evaluates against the
// new current month on the next forecast build.
export function monthsForAssignment(todayMs, horizonYears) {
  const t = new Date(todayMs);
  const curYear = t.getUTCFullYear();
  const curMonth = t.getUTCMonth() + 1; // 1-12
  const endYear = curYear + Math.max(0, horizonYears);
  const out = [];
  for (let y = curYear; y <= endYear; y++) {
    const startM = y === curYear ? curMonth : 1;
    for (let m = startM; m <= 12; m++) {
      out.push(monthKey(y, m));
    }
  }
  return out;
}

// 15th-of-month at UTC noon — every forecast month is anchored to its 15th
// (the project's processing/checkpoint date). UTC-noon avoids host-timezone
// drift so the same input produces the same projection on any machine.
export function monthStartMs(key) {
  const p = parseMonthKey(key);
  if (!p) return null;
  return Date.UTC(p.year, p.month - 1, 15, 12, 0, 0);
}

export function monthLabel(key) {
  const p = parseMonthKey(key);
  if (!p) return key;
  const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${labels[p.month - 1]} ${p.year}`;
}

export function dateToMonthKey(isoDate) {
  if (!isoDate) return null;
  const m = /^(\d{4})-(\d{2})/.exec(isoDate);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

export function isoDateAtUtcNoon(isoDate) {
  if (!isoDate) return null;
  const ms = new Date(isoDate + 'T12:00:00Z').getTime();
  return Number.isNaN(ms) ? null : ms;
}

// ── per-cow weigh-in history (retag-aware via cowTagSet) ──────────────────────

export function cowWeighInHistory(cow, weighIns) {
  // Returns list of {weight, date, ms} sorted desc by entered_at.
  // Drops rows with non-positive parsed weight. Excludes 'import'-source
  // tags (cowTagSet contract — selling-farm tag collisions).
  const tags = cowTagSet(cow);
  if (tags.size === 0) return [];
  const out = [];
  for (const w of weighIns || []) {
    if (!w || !w.tag || !tags.has(String(w.tag))) continue;
    const v = parseFloat(w.weight);
    if (!Number.isFinite(v) || v <= 0) continue;
    const ms = w.entered_at != null ? new Date(w.entered_at).getTime() : isoDateAtUtcNoon(w.date || w.entered_at_date);
    if (!Number.isFinite(ms)) continue;
    out.push({weight: v, date: w.entered_at, ms});
  }
  out.sort((a, b) => b.ms - a.ms);
  return out;
}

// ── ADG ladder ────────────────────────────────────────────────────────────────

// Count-based ADG over the latest 3 weigh-ins. Cattle weigh-ins happen
// ~1x/month max, so a calendar-window approach (e.g., 21 days) would
// reject most valid finishers. Returns {adg, weightsUsed:3, gapDays} or
// null if fewer than 3 points.
export function computeLast3ADG(history) {
  if (!Array.isArray(history) || history.length < 3) return null;
  const newest = history[0];
  const oldest = history[2];
  const days = (newest.ms - oldest.ms) / DAY_MS;
  if (days <= 0) return null;
  const adg = (newest.weight - oldest.weight) / days;
  return {adg, weightsUsed: 3, gapDays: days};
}

// ADG from the two most-recent weigh-ins regardless of age.
export function computeLast2ADG(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const a = history[0];
  const b = history[1];
  const days = (a.ms - b.ms) / DAY_MS;
  if (days <= 0) return null;
  const adg = (a.weight - b.weight) / days;
  return {adg, weightsUsed: 2, gapDays: days};
}

// Resolve ADG via the locked 5-step ladder. Returns:
//   {adg, source, latest, prior, gapDays?, negative}
//   - source ∈ ADG_SOURCES
//   - latest = most recent weigh-in or null
//   - prior  = second-most-recent weigh-in or null
//   - negative = true if computed adg < 0 for backgrounders/finishers
//   - For momma-steers and selected momma-heifers, source is always
//     GLOBAL_ONLY and adg is settings.fallback_adg_lb_per_day.
export function resolveADGForCow({cow, history, settings, todayMs, eligibility}) {
  const fallback = parseFloat(settings.fallbackAdg);
  const safeFallback = Number.isFinite(fallback) && fallback > 0 ? fallback : FORECAST_FALLBACK_ADG_DEFAULT;
  const latest = history[0] || null;
  const prior = history[1] || null;

  // Momma steers + selected momma heifers (ladder bypass): global ADG only.
  if (eligibility && eligibility.useGlobalAdgOnly) {
    return {
      adg: safeFallback,
      source: ADG_SOURCES.GLOBAL_ONLY,
      latest,
      prior,
      negative: false,
    };
  }

  // 1. last 3 weigh-ins (count-based)
  const last3 = computeLast3ADG(history);
  if (last3 && Number.isFinite(last3.adg)) {
    return {
      adg: last3.adg,
      source: ADG_SOURCES.LAST_3,
      latest,
      prior,
      gapDays: last3.gapDays,
      negative: last3.adg < 0,
    };
  }
  // 2. last 2 weigh-ins
  const last2 = computeLast2ADG(history);
  if (last2 && Number.isFinite(last2.adg)) {
    return {
      adg: last2.adg,
      source: ADG_SOURCES.LAST_2,
      latest,
      prior,
      gapDays: last2.gapDays,
      negative: last2.adg < 0,
    };
  }
  // 3. one weigh-in + global ADG
  if (latest) {
    return {
      adg: safeFallback,
      source: ADG_SOURCES.ONE_PLUS_FALLBACK,
      latest,
      prior: null,
      negative: false,
    };
  }
  // 4. DOB + birth-weight + global ADG
  const dobMs = isoDateAtUtcNoon(cow.birth_date);
  if (dobMs != null) {
    return {
      adg: safeFallback,
      source: ADG_SOURCES.DOB_PLUS_FALLBACK,
      latest: null,
      prior: null,
      negative: false,
    };
  }
  // 5. watchlist
  return {adg: null, source: ADG_SOURCES.NONE, latest: null, prior: null, negative: false};
}

// ── heifer-include eligibility (Forecast modal + helper-level guard) ──────────

// A momma heifer is eligible for the Include Momma Herd Heifers list ONLY when:
//   - sex === 'heifer'
//   - herd === 'mommas'
//   - breeding_status !== 'PREGNANT' (pregnant heifers are out of scope)
//   - age <= 15 months as of todayMs (calendar months; no-DOB heifers stay
//     visible per Ronnie's instruction so they don't silently disappear when
//     birth_date is missing)
//
// This same predicate gates buildForecast's includesSet so a stale
// cattle_forecast_heifer_includes row can't make a now-ineligible heifer
// (newly pregnant, aged out, or auto-promoted to cow) leak back into the
// forecast.
export function isHeiferEligibleForInclude(cow, todayMs = Date.now()) {
  if (!cow) return false;
  if (cow.sex !== 'heifer') return false;
  if (cow.herd !== 'mommas') return false;
  if (String(cow.breeding_status || '').toUpperCase() === 'PREGNANT') return false;
  if (cow.birth_date) {
    const birth = new Date(String(cow.birth_date) + 'T12:00:00Z');
    const today = new Date(todayMs);
    if (Number.isFinite(birth.getTime()) && Number.isFinite(today.getTime())) {
      let months = (today.getUTCFullYear() - birth.getUTCFullYear()) * 12 + (today.getUTCMonth() - birth.getUTCMonth());
      if (today.getUTCDate() < birth.getUTCDate()) months -= 1;
      if (months > 15) return false;
    }
  }
  return true;
}

// ── eligibility ───────────────────────────────────────────────────────────────

// Returns:
//   {eligible, source, useGlobalAdgOnly, reason?}
//   - source ∈ 'auto-finishers' | 'auto-backgrounders' | 'auto-momma-steer'
//             | 'momma-heifer-include' | 'excluded-by-default' | 'excluded-outcome'
//             | 'excluded-momma-cow'
//   - useGlobalAdgOnly true for momma steers + selected momma heifers
//   - eligible=false carries a `reason` for UI surfacing
export function eligibilityFor(cow, includesSet) {
  if (!cow) return {eligible: false, source: 'excluded-no-cow', reason: 'No cow', useGlobalAdgOnly: false};
  const herd = cow.herd;
  const sex = cow.sex;
  // outcome herds → never forecast
  if (herd === 'processed' || herd === 'deceased' || herd === 'sold') {
    return {eligible: false, source: 'excluded-outcome', reason: herd, useGlobalAdgOnly: false};
  }
  // bulls herd → never forecast (sires aren't going to processing)
  if (herd === 'bulls') {
    return {eligible: false, source: 'excluded-bulls', reason: 'Bulls herd', useGlobalAdgOnly: false};
  }
  // backgrounders/finishers regardless of sex → auto include
  if (herd === 'backgrounders') {
    return {eligible: true, source: 'auto-backgrounders', useGlobalAdgOnly: false};
  }
  if (herd === 'finishers') {
    return {eligible: true, source: 'auto-finishers', useGlobalAdgOnly: false};
  }
  // mommas herd:
  if (herd === 'mommas') {
    if (sex === 'steer') {
      return {eligible: true, source: 'auto-momma-steer', useGlobalAdgOnly: true};
    }
    if (sex === 'heifer') {
      const included = !!(includesSet && includesSet.has(cow.id));
      if (included) {
        return {eligible: true, source: 'momma-heifer-include', useGlobalAdgOnly: true};
      }
      return {
        eligible: false,
        source: 'excluded-by-default',
        reason: 'Heifer in mommas (use Include modal)',
        useGlobalAdgOnly: false,
      };
    }
    if (sex === 'cow') {
      return {
        eligible: false,
        source: 'excluded-momma-cow',
        reason: 'Adult cow in mommas — never forecasted',
        useGlobalAdgOnly: false,
      };
    }
    if (sex === 'bull') {
      return {eligible: false, source: 'excluded-bulls', reason: 'Bull', useGlobalAdgOnly: false};
    }
  }
  return {eligible: false, source: 'excluded-unknown', reason: 'Unrecognized herd/sex', useGlobalAdgOnly: false};
}

// ── projection / month assignment ─────────────────────────────────────────────

// Project the cow's weight on the 1st of `targetMonthKey` from a known
// anchor weight + anchor ms + adg. (We use the 1st of the month as the
// projection checkpoint — the spec doesn't mandate a day-of-month, and
// the 1st keeps every monthly bucket starting cleanly. The display label
// shows the month, not the exact day.)
export function projectedWeightAtMonth({anchorWeight, anchorMs, targetMonthKey, adg}) {
  if (!Number.isFinite(anchorWeight) || !Number.isFinite(anchorMs) || !Number.isFinite(adg)) return null;
  const targetMs = monthStartMs(targetMonthKey);
  if (!Number.isFinite(targetMs)) return null;
  const days = (targetMs - anchorMs) / DAY_MS;
  return anchorWeight + adg * days;
}

// Returns the FIRST month (in horizon order) where projected weight is
// inside [min, max], skipping any (cattle_id, monthKey) in hiddenSet.
// Returns {monthKey, projectedWeight} or null.
export function findFirstEligibleUnhiddenMonth({
  cow,
  anchorWeight,
  anchorMs,
  adg,
  horizon,
  weightMin,
  weightMax,
  hiddenSet,
}) {
  if (!Number.isFinite(anchorWeight) || !Number.isFinite(anchorMs) || !Number.isFinite(adg)) return null;
  for (const key of horizon) {
    if (hiddenSet && hiddenSet.has(`${cow.id}|${key}`)) continue;
    const proj = projectedWeightAtMonth({anchorWeight, anchorMs, targetMonthKey: key, adg});
    if (proj == null) continue;
    if (proj >= weightMin && proj <= weightMax) {
      return {monthKey: key, projectedWeight: proj};
    }
  }
  return null;
}

// ── exception flagging ────────────────────────────────────────────────────────
export function flagsForCow({cow, history, adgResult, weightMax}) {
  const flags = [];
  if (!history || history.length === 0) {
    if (cow.birth_date) flags.push('no_weight_dob_projection');
    else flags.push('no_weight_no_dob');
  }
  if (adgResult && adgResult.negative) flags.push('negative_adg');
  if (history && history.length >= 2) {
    const days = (history[0].ms - history[1].ms) / DAY_MS;
    if (days >= 0 && days < 7) flags.push('tiny_gap');
  }
  if (!cow.origin) flags.push('missing_origin');
  if (!cow.birth_date) flags.push('missing_birth_date');
  // already-over-max: latest weight already exceeds the display max and
  // the cow has not been processed (eligibility-checked elsewhere).
  if (history && history[0] && history[0].weight > weightMax) {
    flags.push('over_max_unprocessed');
  }
  return flags;
}

// ── orchestrator ──────────────────────────────────────────────────────────────

// buildForecast returns:
//   {
//     summary: {
//       totalEligible,
//       readyByYear: {YYYY: count},
//       readyThisYear, readyNextYear, readyTwoYears, readyThreeYears,
//       overMaxUnprocessed,
//       missingDataCount,
//       watchlistCount,
//       totalCount,
//     },
//     monthBuckets: [{monthKey, label, year, count, animalIds, projectedTotalLbs, overCapacity}],
//     animalRows:   [{cow, eligibility, history, latest, prior, adg, adgSource, negativeAdg,
//                     readyMonth, projectedWeightAtReady, flags, watchlistReasons,
//                     hiddenInMonths: [...], projectionAnchor: 'weighin'|'dob'|null}],
//     watchlist:    [animalRowSubset] — cows with any watchlistReasons
//     virtualBatches: [{name, monthKey, label, animalIds, projectedTotalLbs}]
//                    — virtual batches are derived from monthBuckets in
//                      horizon order; naming continues after stored real
//                      active/complete batches per the rules in
//                      buildVirtualBatchNames().
//     nextProcessorBatch: {name, monthKey, label, animalIds, allowedTagSet,
//                          projectedTotalLbs, currentYearTotalForecast}
//                    | null when no virtual batch exists
//   }
//
// Inputs:
//   cattle              — full cattle row array (all herds incl. outcomes)
//   weighIns            — full weigh_ins desc-by-entered_at (cattleCache contract)
//   settings            — {displayMin, displayMax, fallbackAdg, birthWeight,
//                           horizonYears, monthlyCapacity, includedHerds (unused
//                           in v1 — inclusion is herd-level not settings-level)}
//   includes            — Set of cattle.id of momma-heifer inclusions
//   hidden              — array of {cattle_id, month_key} hide rows
//   realBatches         — cattle_processing_batches rows that have moved
//                          past the planning stage (status='active' or
//                          'complete'). These remove their cows_detail
//                          animals from the forecast eligibility pool
//                          because cattle.herd flips to 'processed' on
//                          Send-to-Processor.
//   scheduledBatches    — cattle_processing_batches rows with
//                          status='scheduled'. These reserve a batch
//                          name + planned_process_date on the forecast
//                          but DO NOT remove cattle from the eligibility
//                          pool. Eligibility is decided strictly by
//                          herd === 'finishers'/'backgrounders' (or the
//                          momma-steer/heifer rules) — scheduled status
//                          never touches cattle.herd, so cattle stay
//                          forecast-eligible and dynamic until Send-to-
//                          Processor actually promotes the row to
//                          'active'.
//   todayMs             — anchor for projections
export function buildForecast({
  cattle = [],
  weighIns = [],
  settings = {},
  includes = new Set(),
  hidden = [],
  realBatches = [],
  scheduledBatches = [],
  todayMs = Date.now(),
}) {
  const displayMin = Number.isFinite(settings.displayMin) ? settings.displayMin : FORECAST_DISPLAY_WEIGHT_MIN_DEFAULT;
  const displayMax = Number.isFinite(settings.displayMax) ? settings.displayMax : FORECAST_DISPLAY_WEIGHT_MAX_DEFAULT;
  const fallbackAdg =
    Number.isFinite(settings.fallbackAdg) && settings.fallbackAdg > 0
      ? settings.fallbackAdg
      : FORECAST_FALLBACK_ADG_DEFAULT;
  const birthWeight =
    Number.isFinite(settings.birthWeight) && settings.birthWeight > 0
      ? settings.birthWeight
      : FORECAST_BIRTH_WEIGHT_LB_DEFAULT;
  const horizonYears = Number.isFinite(settings.horizonYears) ? settings.horizonYears : FORECAST_HORIZON_YEARS_DEFAULT;
  const monthlyCapacity =
    Number.isFinite(settings.monthlyCapacity) && settings.monthlyCapacity > 0 ? settings.monthlyCapacity : null;
  // Two horizons:
  //   - displayHorizon: full calendar months (Jan of current year forward).
  //     Used for the chart, month buckets, and watchlist "never reaches"
  //     check.
  //   - assignmentHorizon: current month forward only. Used for assigning
  //     cattle to their first-eligible-unhidden month so a cow already at
  //     target weight cannot land in a month that has already passed.
  //     Rollover-forward semantics: month rolls past, the helper re-evaluates
  //     against the new current month on next forecast build.
  const displayHorizon = monthsInHorizon(todayMs, horizonYears);
  const assignmentHorizon = monthsForAssignment(todayMs, horizonYears);

  // Raw includes from cattle_forecast_heifer_includes are filtered against
  // the current isHeiferEligibleForInclude predicate so stale rows (heifer
  // since auto-promoted to cow on calving, newly pregnant, or aged past 15
  // months) cannot leak a now-ineligible heifer back into the forecast. This
  // is the single helper-level guard — UI surfaces share the same predicate.
  const rawIncludesSet = includes instanceof Set ? includes : new Set(includes || []);
  const cattleById = new Map();
  for (const c of cattle) if (c && c.id) cattleById.set(c.id, c);
  const includesSet = new Set();
  for (const cid of rawIncludesSet) {
    const cow = cattleById.get(cid);
    if (cow && isHeiferEligibleForInclude(cow, todayMs)) includesSet.add(cid);
  }
  const hiddenSet = new Set();
  const hiddenByCow = new Map();
  for (const row of hidden || []) {
    const cid = row && row.cattle_id;
    const mk = row && row.month_key;
    if (!cid || !mk) continue;
    hiddenSet.add(`${cid}|${mk}`);
    if (!hiddenByCow.has(cid)) hiddenByCow.set(cid, new Set());
    hiddenByCow.get(cid).add(mk);
  }

  const animalRows = [];
  const watchlist = [];

  for (const cow of cattle) {
    const eligibility = eligibilityFor(cow, includesSet);
    if (!eligibility.eligible) continue;

    const history = cowWeighInHistory(cow, weighIns);
    const adgResult = resolveADGForCow({
      cow,
      history,
      settings: {fallbackAdg},
      todayMs,
      eligibility,
    });

    // Pick projection anchor: latest weigh-in if any, else DOB+birth_weight.
    let anchorWeight = null;
    let anchorMs = null;
    let projectionAnchor = null;
    if (history.length > 0) {
      anchorWeight = history[0].weight;
      anchorMs = history[0].ms;
      projectionAnchor = 'weighin';
    } else if (cow.birth_date) {
      const dobMs = isoDateAtUtcNoon(cow.birth_date);
      if (dobMs != null) {
        anchorWeight = birthWeight;
        anchorMs = dobMs;
        projectionAnchor = 'dob';
      }
    }

    let readyMonth = null;
    let projectedWeightAtReady = null;
    if (anchorWeight != null && anchorMs != null && Number.isFinite(adgResult.adg)) {
      const ready = findFirstEligibleUnhiddenMonth({
        cow,
        anchorWeight,
        anchorMs,
        adg: adgResult.adg,
        horizon: assignmentHorizon,
        weightMin: displayMin,
        weightMax: displayMax,
        hiddenSet,
      });
      if (ready) {
        readyMonth = ready.monthKey;
        projectedWeightAtReady = ready.projectedWeight;
      }
    }

    const flags = flagsForCow({cow, history, adgResult, weightMax: displayMax});

    const watchlistReasons = [];
    if (history.length === 0 && !cow.birth_date) {
      watchlistReasons.push(WATCHLIST_REASONS.NO_WEIGHT_NO_DOB);
    }
    if (adgResult.negative && readyMonth == null) {
      watchlistReasons.push(WATCHLIST_REASONS.NEGATIVE_ADG_NO_FINISH);
    }
    if (history.length > 0 && history[0].weight > displayMax) {
      // already past max and not yet processed — eligibility lock above
      // already excluded processed/sold/deceased; reaching here means active
      // herd member already over weight.
      watchlistReasons.push(WATCHLIST_REASONS.ALREADY_OVER_MAX);
    } else if (anchorWeight != null && Number.isFinite(adgResult.adg) && readyMonth == null) {
      // Projected but never lands in window across the assignment horizon.
      // Disambiguate: under-min at horizon end → NEVER_REACHES_WINDOW;
      // over-max already at horizon start → PROJECTS_PAST_MAX (the cow
      // would have landed in a past month or already exceeded display max).
      const firstKey = assignmentHorizon[0];
      const lastKey = assignmentHorizon[assignmentHorizon.length - 1];
      const projFirst = projectedWeightAtMonth({
        anchorWeight,
        anchorMs,
        targetMonthKey: firstKey,
        adg: adgResult.adg,
      });
      const projLast = projectedWeightAtMonth({anchorWeight, anchorMs, targetMonthKey: lastKey, adg: adgResult.adg});
      if (projFirst != null && projFirst > displayMax) {
        watchlistReasons.push(WATCHLIST_REASONS.PROJECTS_PAST_MAX);
      } else if (projLast != null && projLast < displayMin) {
        watchlistReasons.push(WATCHLIST_REASONS.NEVER_REACHES_WINDOW);
      } else {
        // Eligible months exist mathematically but every one is hidden.
        const hiddenAll = assignmentHorizon.every(
          (k) =>
            hiddenSet.has(`${cow.id}|${k}`) ||
            (() => {
              const p = projectedWeightAtMonth({anchorWeight, anchorMs, targetMonthKey: k, adg: adgResult.adg});
              return !(p != null && p >= displayMin && p <= displayMax);
            })(),
        );
        if (hiddenAll) watchlistReasons.push(WATCHLIST_REASONS.ALL_ELIGIBLE_HIDDEN);
      }
    } else if (anchorWeight == null && history.length === 0 && cow.birth_date == null) {
      // Already added above.
    } else if (adgResult.source === ADG_SOURCES.NONE) {
      watchlistReasons.push(WATCHLIST_REASONS.NO_WEIGHT_NO_DOB);
    }

    const row = {
      cow,
      eligibility,
      history,
      latest: history[0] || null,
      prior: history[1] || null,
      adg: adgResult.adg,
      adgSource: adgResult.source,
      negativeAdg: adgResult.negative,
      // Anchor for any-month projection. The view uses these to compute a
      // hidden-month's projected weight (not just the assigned month) so
      // operators can see how heavy the cow would have been if she'd been
      // sent in that hidden month.
      anchorWeight,
      anchorMs,
      readyMonth,
      projectedWeightAtReady,
      flags,
      watchlistReasons,
      hiddenInMonths: hiddenByCow.has(cow.id) ? [...hiddenByCow.get(cow.id)] : [],
      projectionAnchor,
    };
    animalRows.push(row);
    if (watchlistReasons.length > 0 || readyMonth == null) {
      watchlist.push(row);
    }
  }

  // ── month buckets ──────────────────────────────────────────────────────────
  // Each bucket carries:
  //   animalIds       — cattle assigned to THIS month (after hide-aware
  //                     first-eligible-unhidden assignment)
  //   hiddenAnimalIds — cattle whose hide row points at THIS specific month,
  //                     regardless of where their current assignment rolled
  //                     to. Surfaced by the UI only when "Show hidden" is on
  //                     so admin can unhide them — required by the locked
  //                     "hidden is locked for that cow for that month" rule.
  const monthBuckets = displayHorizon.map((key) => ({
    monthKey: key,
    label: monthLabel(key),
    year: parseMonthKey(key).year,
    count: 0,
    animalIds: [],
    hiddenAnimalIds: [],
    projectedTotalLbs: 0,
    overCapacity: false,
    // Real active/complete batches whose actual_process_date (or planned
    // when actual is null) falls in this month. Surfaced on the tile so
    // operators see projected + actual side-by-side per Codex 2026-05-04.
    actualBatches: [],
    // Scheduled batches (status='scheduled') whose planned_process_date
    // falls in this month. Distinct from actualBatches so the UI can
    // render a separate Scheduled affordance and so the virtual-batch
    // generation can suppress its own virtual row for this month — the
    // scheduled row already reserves the slot.
    scheduledBatches: [],
  }));
  const bucketByKey = new Map(monthBuckets.map((b) => [b.monthKey, b]));
  for (const r of animalRows) {
    if (r.readyMonth) {
      const bucket = bucketByKey.get(r.readyMonth);
      if (bucket) {
        bucket.animalIds.push(r.cow.id);
        bucket.count += 1;
        bucket.projectedTotalLbs += r.projectedWeightAtReady || 0;
      }
    }
    // Surface this cow's hide rows on every month where she's hidden so the
    // UI can render an Unhide button under "Show hidden", even if her
    // current assignment lives elsewhere (assignment rolled forward / past).
    for (const mk of r.hiddenInMonths) {
      const bucket = bucketByKey.get(mk);
      if (bucket && !bucket.hiddenAnimalIds.includes(r.cow.id)) {
        bucket.hiddenAnimalIds.push(r.cow.id);
      }
    }
  }
  if (monthlyCapacity != null) {
    for (const b of monthBuckets) {
      if (b.count > monthlyCapacity) b.overCapacity = true;
    }
  }

  // Attach real (active|complete) batches to their month bucket. Defensive
  // status filter: callers SHOULD partition scheduled rows into
  // scheduledBatches, but if a scheduled row leaks into realBatches we
  // still skip it here so it never lands as an actualBatch.
  for (const rb of realBatches || []) {
    if (!rb) continue;
    if (rb.status === 'scheduled') continue;
    const dt = rb.actual_process_date || rb.planned_process_date;
    if (!dt) continue;
    const mk = String(dt).slice(0, 7);
    const bucket = bucketByKey.get(mk);
    if (bucket) bucket.actualBatches.push(rb);
  }

  // Attach scheduled batches to their month bucket. Scheduled rows do NOT
  // remove cattle from the forecast — they only reserve the batch
  // name/date for the upcoming cohort. eligibilityFor / monthBucket
  // assignment above already handled cattle inclusion strictly by
  // herd === 'finishers'/'backgrounders' (or momma-steer/heifer-include
  // rules), so animalIds for this month are unchanged.
  for (const sb of scheduledBatches || []) {
    if (!sb) continue;
    if (sb.status && sb.status !== 'scheduled') continue;
    const dt = sb.planned_process_date;
    if (!dt) continue;
    const mk = String(dt).slice(0, 7);
    const bucket = bucketByKey.get(mk);
    if (bucket) bucket.scheduledBatches.push(sb);
  }

  // ── summary ────────────────────────────────────────────────────────────────
  const todayYear = new Date(todayMs).getUTCFullYear();
  const readyByYear = {};
  for (const b of monthBuckets) {
    readyByYear[b.year] = (readyByYear[b.year] || 0) + b.count;
  }
  // "Finish candidates on farm" = the herd-shape that could ever finish:
  // every backgrounder + every finisher + momma steers + eligible momma heifers.
  // Excludes momma cows, bulls, outcome herds (processed/sold/deceased), plus
  // momma heifers filtered out of the Include modal (pregnant or over 15 months).
  // Codex 2026-05-04 correction: Summary's "Eligible cattle" subtext shows
  // this number, not raw cattle.length, so operators don't see historical
  // outcome cattle counted as on-farm.
  const finishCandidates = (cattle || []).filter((c) => {
    if (!c) return false;
    if (c.herd === 'backgrounders' || c.herd === 'finishers') return true;
    if (c.herd === 'mommas' && c.sex === 'steer') return true;
    if (isHeiferEligibleForInclude(c, todayMs)) return true;
    return false;
  }).length;

  const summary = {
    totalEligible: animalRows.length,
    totalCount: cattle.length,
    finishCandidates,
    readyByYear,
    readyThisYear: readyByYear[todayYear] || 0,
    readyNextYear: readyByYear[todayYear + 1] || 0,
    readyTwoYears: readyByYear[todayYear + 2] || 0,
    readyThreeYears: readyByYear[todayYear + 3] || 0,
    overMaxUnprocessed: animalRows.filter((r) => r.watchlistReasons.includes(WATCHLIST_REASONS.ALREADY_OVER_MAX))
      .length,
    missingDataCount: animalRows.filter(
      (r) =>
        r.flags.includes('missing_birth_date') ||
        r.flags.includes('missing_origin') ||
        r.flags.includes('no_weight_no_dob'),
    ).length,
    watchlistCount: watchlist.length,
  };

  // ── virtual batches (one per non-empty month WITHOUT a scheduled row) ───
  // A scheduled batch already reserves the slot for its month, so virtual
  // batch generation skips those buckets. Sequence numbering still counts
  // scheduled names so the next virtual batch picks the right next-up
  // number for the year.
  const virtualMonths = monthBuckets.filter((b) => b.count > 0 && (b.scheduledBatches || []).length === 0);
  const virtualBatches = buildVirtualBatchNames({
    realBatches,
    scheduledBatches,
    virtualMonths,
    todayMs,
    cattle,
    animalRowsById: new Map(animalRows.map((r) => [r.cow.id, r])),
  });

  // Enrich scheduled batches with the matching month bucket's cohort so
  // the Scheduled section can render a live count of forecast-eligible
  // cattle for each scheduled row. animalIds are recomputed every build
  // so cattle that herd-moved or got hidden naturally drop out.
  const scheduledBatchesEnriched = (scheduledBatches || [])
    .filter((sb) => sb && (sb.status === 'scheduled' || sb.status == null))
    .map((sb) => {
      const dt = sb.planned_process_date;
      const mk = dt ? String(dt).slice(0, 7) : null;
      const bucket = mk ? bucketByKey.get(mk) : null;
      const animalIds = bucket ? bucket.animalIds.slice() : [];
      let projectedTotalLbs = 0;
      const rowsById = new Map(animalRows.map((r) => [r.cow.id, r]));
      for (const cid of animalIds) {
        const r = rowsById.get(cid);
        if (r && r.projectedWeightAtReady != null) projectedTotalLbs += r.projectedWeightAtReady;
      }
      return {
        id: sb.id,
        name: sb.name,
        planned_process_date: sb.planned_process_date,
        status: sb.status || 'scheduled',
        monthKey: mk,
        label: mk ? monthLabel(mk) : null,
        animalIds,
        projectedTotalLbs,
      };
    });

  // ── next processor batch (gate for Send-to-Processor) ─────────────────────
  // Scheduled rows count as next-up cohorts — if a scheduled batch is
  // earlier than the first remaining virtual, the gate prefers it. The
  // scheduledBatch flag tells the caller whether to promote-or-create.
  let nextProcessorBatch = null;
  const candidatePool = [
    ...scheduledBatchesEnriched.map((sb) => ({
      source: 'scheduled',
      scheduledId: sb.id,
      name: sb.name,
      monthKey: sb.monthKey,
      label: sb.label,
      animalIds: sb.animalIds,
      projectedTotalLbs: sb.projectedTotalLbs,
    })),
    ...virtualBatches.map((vb) => ({
      source: 'virtual',
      scheduledId: null,
      name: vb.name,
      monthKey: vb.monthKey,
      label: vb.label,
      animalIds: vb.animalIds,
      projectedTotalLbs: vb.projectedTotalLbs,
    })),
  ];
  candidatePool.sort((a, b) => (a.monthKey || '').localeCompare(b.monthKey || ''));
  if (candidatePool.length > 0) {
    const first = candidatePool[0];
    const allowedTagSet = new Set();
    for (const cid of first.animalIds) {
      const cow = cattle.find((c) => c.id === cid);
      if (cow && cow.tag) allowedTagSet.add(String(cow.tag));
    }
    nextProcessorBatch = {
      name: first.name,
      monthKey: first.monthKey,
      label: first.label,
      animalIds: first.animalIds.slice(),
      allowedTagSet,
      projectedTotalLbs: first.projectedTotalLbs,
      currentYearTotalForecast: readyByYear[todayYear] || 0,
      source: first.source,
      scheduledId: first.scheduledId,
    };
  }

  return {
    summary,
    monthBuckets,
    animalRows,
    watchlist,
    virtualBatches,
    scheduledBatches: scheduledBatchesEnriched,
    nextProcessorBatch,
  };
}

// ── virtual-batch naming ──────────────────────────────────────────────────────
//
// Rules (locked in the build packet):
//   - Real active/complete DB batches anchor the sequence by their stored name.
//   - Virtual planned-batch names continue contiguously after real names.
//   - No gap filling. Sequence is a strict +1 within a year.
//   - New year resets to C-YY-01.
//   - Auto-created active batch (real attach) uses the year of the
//     processing date (= weigh_in_sessions.date) — the call site reads that
//     year from the session before calling nextRealBatchName().
//
// Real-batch naming format: 'C-YY-NN' where YY is two-digit year, NN is
// zero-padded sequence within that year.

const NAME_RE = /^C-(\d{2})-(\d{2,})$/;

export function parseBatchName(name) {
  if (!name) return null;
  const m = NAME_RE.exec(String(name).trim());
  if (!m) return null;
  return {yy: parseInt(m[1], 10), n: parseInt(m[2], 10)};
}

export function formatBatchName(yy, n) {
  return `C-${String(yy).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
}

// Greatest stored real-batch sequence number within a year.
export function highestStoredNumberForYear(realBatches, yy) {
  let best = 0;
  for (const b of realBatches || []) {
    const p = parseBatchName(b && b.name);
    if (!p) continue;
    if (p.yy !== yy) continue;
    if (p.n > best) best = p.n;
  }
  return best;
}

// Compute the next real (active) batch name to assign at WeighIns
// Send-to-Processor time. Uses the calendar year of `processingDateISO`
// (= weigh_in_sessions.date). New year starts at 01. Scheduled rows
// reserve their own names, so callers should pass them via
// scheduledBatches so the chosen next-name skips past any reservations.
export function nextRealBatchName(realBatches, processingDateISO, scheduledBatches = []) {
  const dt = isoDateAtUtcNoon(processingDateISO);
  if (dt == null) return null;
  const yy = new Date(dt).getUTCFullYear() % 100;
  const realMax = highestStoredNumberForYear(realBatches, yy);
  const schedMax = highestStoredNumberForYear(scheduledBatches, yy);
  const next = Math.max(realMax, schedMax) + 1;
  return formatBatchName(yy, next);
}

// Build virtual batch names + cohorts from the month buckets. Each
// non-empty month becomes one virtual batch.
//
// Chronological-within-year naming (Codex 2026-05-12 correction):
//   - Real (active/complete) batches anchor the cursor FLOOR for the
//     year — they're already in the past, so any new virtual batch in
//     that year must come AFTER the highest stored real sequence.
//   - Scheduled batches reserve their slot only — they don't push
//     earlier virtual months to higher numbers. A scheduled C-26-03 in
//     July leaves C-26-01 / C-26-02 available for May / June virtuals
//     that come online later. The virtual sequence walks chronologically
//     from (realMax + 1) and skips over any scheduled reservation.
//
// The two rules diverge because real batches represent past reality
// (you can't squeeze a new batch in before C-26-02 once C-26-02 has
// happened) while scheduled batches are a future booking that hasn't
// processed yet.
export function buildVirtualBatchNames({realBatches, scheduledBatches = [], virtualMonths, animalRowsById}) {
  const out = [];
  // Reservations per year from scheduled rows ONLY — these are the
  // slots virtual numbering must skip (without bumping the cursor floor).
  const scheduledReservedByYear = new Map();
  for (const sb of scheduledBatches || []) {
    const p = parseBatchName(sb && sb.name);
    if (!p) continue;
    if (!scheduledReservedByYear.has(p.yy)) scheduledReservedByYear.set(p.yy, new Set());
    scheduledReservedByYear.get(p.yy).add(p.n);
  }
  // Cursor floor per year from real rows: new virtual numbers must
  // come after the highest stored real sequence. realMax is computed
  // lazily per encountered year.
  const cursorByYear = new Map();
  function nextSeqFor(yy) {
    const reserved = scheduledReservedByYear.get(yy) || new Set();
    let next = cursorByYear.get(yy);
    if (next == null) {
      const realMax = highestStoredNumberForYear(realBatches, yy);
      next = realMax + 1;
    }
    while (reserved.has(next)) next += 1;
    cursorByYear.set(yy, next + 1);
    return next;
  }
  // virtualMonths is already sorted by monthKey ascending (buildForecast
  // builds it from displayHorizon, which iterates Jan → Dec per year),
  // so walking it directly yields chronological assignment within each
  // year and a fresh seq=01 start at year boundaries when there are no
  // real or scheduled rows in the new year.
  for (const bucket of virtualMonths || []) {
    const p = parseMonthKey(bucket.monthKey);
    if (!p) continue;
    const yy = p.year % 100;
    const seq = nextSeqFor(yy);
    const name = formatBatchName(yy, seq);
    let projectedTotalLbs = 0;
    if (animalRowsById) {
      for (const cid of bucket.animalIds) {
        const r = animalRowsById.get(cid);
        if (r && r.projectedWeightAtReady != null) projectedTotalLbs += r.projectedWeightAtReady;
      }
    } else {
      projectedTotalLbs = bucket.projectedTotalLbs || 0;
    }
    out.push({
      name,
      monthKey: bucket.monthKey,
      label: bucket.label,
      animalIds: bucket.animalIds.slice(),
      projectedTotalLbs,
    });
  }
  return out;
}

// ── manual-rename validation (UI gate, no DB trigger) ─────────────────────────
//
// Validates a proposed real-batch rename against:
//   - format C-YY-NN
//   - no duplicate (other than the row being renamed itself)
//   - no skipped sequence (must be exactly highestExisting+1 OR replace
//     an existing slot)
//   - new year starts at 01
//
// Returns {ok:true} or {ok:false, reason}.
export function validateRealBatchRename({proposedName, currentName, realBatches}) {
  const p = parseBatchName(proposedName);
  if (!p) return {ok: false, reason: 'format'};
  // Dup check: any OTHER batch already uses this name?
  for (const b of realBatches || []) {
    if (!b || !b.name) continue;
    if (b.name === currentName) continue;
    if (b.name === proposedName) return {ok: false, reason: 'duplicate'};
  }
  // Sequence gap check. After the rename lands, the same-year sequence
  // numbers must be a contiguous 1..max with no gaps. This enforces:
  //   - new year must start at 01
  //   - gap-fill renames are allowed (e.g., rename C-26-04 to C-26-03 when
  //     C-26-03 slot is empty fills the gap cleanly)
  //   - moving the highest batch up to a non-existent slot is blocked
  //     (e.g., rename C-26-03 to C-26-04 leaves slot 3 empty)
  //   - December/January cross-year rename (e.g., C-26-12 → C-27-01) works
  //     because the new year's same-year set is empty and 01 satisfies the
  //     start-at-01 rule
  const sameYearOthers = (realBatches || []).filter((b) => {
    const q = parseBatchName(b && b.name);
    return q && q.yy === p.yy && b.name !== currentName;
  });
  const otherNs = sameYearOthers.map((b) => parseBatchName(b.name).n);
  const finalSet = new Set(otherNs);
  finalSet.add(p.n);
  if (p.n < 1) return {ok: false, reason: 'sequence_gap'};
  // New year must start at 01: when we land in a year with no other
  // entries, n must be 1.
  if (otherNs.length === 0 && p.n !== 1) {
    return {ok: false, reason: 'new_year_must_start_at_01'};
  }
  const max = Math.max(...finalSet);
  for (let i = 1; i <= max; i++) {
    if (!finalSet.has(i)) return {ok: false, reason: 'sequence_gap'};
  }
  return {ok: true};
}

// ── Send-to-Processor gate ────────────────────────────────────────────────────
//
// The forecast gate enforced on the modal submit. The selected weigh-in
// entries' tags must all be in nextProcessorBatch.allowedTagSet, otherwise
// the whole send is blocked and the blocked tags are listed.
//
// Returns:
//   {ok:true, blockedTags: []}      — go ahead
//   {ok:false, reason, blockedTags} — abort with copy guidance
export function checkProcessorGate({selectedTags, nextProcessorBatch}) {
  if (!nextProcessorBatch) return {ok: false, reason: 'no_next_batch', blockedTags: []};
  const allowed = nextProcessorBatch.allowedTagSet;
  if (!allowed || allowed.size === 0) return {ok: false, reason: 'empty_next_batch', blockedTags: []};
  const blocked = [];
  for (const t of selectedTags || []) {
    if (!t) continue;
    if (!allowed.has(String(t))) blocked.push(String(t));
  }
  if (blocked.length === 0) return {ok: true, blockedTags: []};
  return {ok: false, reason: 'tags_outside_next_batch', blockedTags: blocked};
}

// ── small utility shared with batch view ──────────────────────────────────────

// All hanging weights present (>0) for every row in cows_detail → batch
// auto-flips to 'complete'. Returns true if batch should flip to complete.
export function batchHasAllHangingWeights(batch) {
  const rows = batch && Array.isArray(batch.cows_detail) ? batch.cows_detail : [];
  if (rows.length === 0) return false;
  return rows.every((r) => {
    const v = parseFloat(r && r.hanging_weight);
    return Number.isFinite(v) && v > 0;
  });
}

// Human-readable ADG-calc string for the Forecast UI. Surfaces the actual
// number plus enough context that admins don't have to guess at the calc.
// Examples:
//   "1.42 lb/day · last 3 weigh-ins (62-day gap)"
//   "1.10 lb/day · last 2 weigh-ins (28-day gap)"
//   "1.18 lb/day · 1 weigh-in + global"
//   "1.18 lb/day · DOB + global (2024-08-01)"
//   "1.18 lb/day · global only"
//   "—"   (NONE)
export function formatAdgCalc(row) {
  if (!row) return '—';
  const adg = row.adg;
  const v = Number.isFinite(adg) ? adg.toFixed(2) + ' lb/day' : null;
  switch (row.adgSource) {
    case ADG_SOURCES.LAST_3: {
      const h = row.history;
      const gap = h && h.length >= 3 ? Math.round((h[0].ms - h[2].ms) / DAY_MS) : null;
      return (v || '—') + ' · last 3 weigh-ins' + (gap != null ? ` (${gap}-day gap)` : '');
    }
    case ADG_SOURCES.LAST_2: {
      const h = row.history;
      const gap = h && h.length >= 2 ? Math.round((h[0].ms - h[1].ms) / DAY_MS) : null;
      return (v || '—') + ' · last 2 weigh-ins' + (gap != null ? ` (${gap}-day gap)` : '');
    }
    case ADG_SOURCES.ONE_PLUS_FALLBACK:
      return (v || '—') + ' · 1 weigh-in + global';
    case ADG_SOURCES.DOB_PLUS_FALLBACK: {
      const dob = row.cow && row.cow.birth_date ? ` (${row.cow.birth_date})` : '';
      return (v || '—') + ' · DOB + global' + dob;
    }
    case ADG_SOURCES.GLOBAL_ONLY:
      return (v || '—') + ' · global only';
    case ADG_SOURCES.NONE:
    default:
      return '—';
  }
}

// List of cattle.id values in `batch` whose hanging_weight is missing/<=0.
export function batchMissingHangingTags(batch) {
  const rows = batch && Array.isArray(batch.cows_detail) ? batch.cows_detail : [];
  return rows
    .filter((r) => {
      const v = parseFloat(r && r.hanging_weight);
      return !(Number.isFinite(v) && v > 0);
    })
    .map((r) => r.tag || r.cattle_id);
}
