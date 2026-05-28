// ============================================================================
// src/lib/pig.js  —  pig breeding domain constants + helpers
// ----------------------------------------------------------------------------
// Lifted out of main.jsx as prep for Round 6 pig view extractions (pigsHome,
// breeding, pigbatches, farrowing, sows). Pure module-scope; no React, no
// App closure state.
// ============================================================================
import {toISO, addDays, todayISO} from './dateUtils.js';

// ── PIG BREEDING CONSTANTS ─────────────────────────────────────────────────
export const BOAR_EXPOSURE_DAYS = 45;
export const GESTATION_DAYS = 116; // days from first exposure to first possible farrowing
export const WEANING_DAYS = 42; // 6 weeks
export const GROW_OUT_DAYS = 183; // 6 months

export const PIG_GROUPS = ['1', '2', '3'];
export const BREEDING_STATUSES = ['planned', 'active', 'completed'];

// Colors per group: one base shade for the whole cycle, with a lighter
// shade for Gilts grow-out and a darker shade for Boars grow-out. All
// three groups stay inside the pig program's blue family (no purple per
// project rules) — Group 1 is sky, Group 2 is the core pig blue, and
// Group 3 is slate. Mirrors the broiler per-batch single-color treatment.
export const PIG_GROUP_COLORS = {
  1: {
    boar: '#0EA5E9',
    paddock: '#0EA5E9',
    farrowing: '#0EA5E9',
    weaning: '#0EA5E9',
    gilt: '#7DD3FC',
    boarGrow: '#075985',
  },
  2: {
    boar: '#2563EB',
    paddock: '#2563EB',
    farrowing: '#2563EB',
    weaning: '#2563EB',
    gilt: '#93C5FD',
    boarGrow: '#1E3A8A',
  },
  3: {
    boar: '#475569',
    paddock: '#475569',
    farrowing: '#475569',
    weaning: '#475569',
    gilt: '#94A3B8',
    boarGrow: '#1E293B',
  },
};
export const PIG_GROUP_TEXT = {1: '#E0F2FE', 2: '#DBEAFE', 3: '#F1F5F9'};

// getReadableText now lives in lib/styles.js so every program can use it.
// Re-export here for back-compat with existing pig view imports.
export {getReadableText} from './styles.js';

export const PHASE_LABELS = ['Boar Exposure', 'Exp. Paddock', 'Farrowing', 'Weaning', 'Gilt Grow-out', 'Male Grow-out'];

export function calcBreedingTimeline(exposureStart) {
  if (!exposureStart) return null;
  const d0 = new Date(exposureStart + 'T12:00:00');
  const boarEnd = toISO(addDays(d0, BOAR_EXPOSURE_DAYS - 1));
  // Paddock starts day AFTER last boar exposure day, ends day before first possible farrowing
  const paddockStart = toISO(addDays(d0, BOAR_EXPOSURE_DAYS));
  const paddockEnd = toISO(addDays(d0, GESTATION_DAYS - 1));
  const farrowingStart = toISO(addDays(d0, GESTATION_DAYS));
  const farrowingEnd = toISO(addDays(d0, BOAR_EXPOSURE_DAYS - 1 + GESTATION_DAYS));
  const weaningStart = toISO(addDays(d0, BOAR_EXPOSURE_DAYS + GESTATION_DAYS));
  const weaningEnd = toISO(addDays(d0, BOAR_EXPOSURE_DAYS + GESTATION_DAYS + WEANING_DAYS - 1));
  const growStart = toISO(addDays(d0, BOAR_EXPOSURE_DAYS + GESTATION_DAYS + WEANING_DAYS));
  const growEnd = toISO(addDays(d0, BOAR_EXPOSURE_DAYS + GESTATION_DAYS + WEANING_DAYS + GROW_OUT_DAYS - 1));
  return {
    boarStart: exposureStart,
    boarEnd,
    paddockStart,
    paddockEnd,
    farrowingStart,
    farrowingEnd,
    weaningStart,
    weaningEnd,
    growStart,
    growEnd,
  };
}

// ── BREEDING CYCLE LABELS ────────────────────────────────────────────────
// Auto-generate per-year global sequence number for breeding cycles.
// Format: "Group N - YY-NN" (e.g. "Group 1 - 25-01").
// NN resets each year; first cycle to start in any year gets 01, then 02, etc.
// regardless of which group it's in.
export function buildCycleSeqMap(cycles) {
  const seqMap = {};
  const dated = (cycles || []).filter((c) => c && c.id && c.exposureStart);
  const sorted = [...dated].sort((a, b) => {
    if (a.exposureStart !== b.exposureStart) return a.exposureStart.localeCompare(b.exposureStart);
    return String(a.id).localeCompare(String(b.id));
  });
  const yearCounts = {};
  sorted.forEach((c) => {
    const yr = c.exposureStart.slice(2, 4); // '2025' -> '25'
    yearCounts[yr] = (yearCounts[yr] || 0) + 1;
    seqMap[c.id] = yr + '-' + String(yearCounts[yr]).padStart(2, '0');
  });
  return seqMap;
}
export function cycleLabel(cycle, seqMap) {
  if (!cycle) return '';
  // customSuffix (when set by admin) overrides the auto year-sequence code.
  const autoSuffix = seqMap && seqMap[cycle.id];
  const suffix = (cycle.customSuffix && String(cycle.customSuffix).trim()) || autoSuffix;
  return 'Group ' + cycle.group + (suffix ? ' - ' + suffix : '');
}

export function calcCycleStatus(cycle) {
  if (!cycle.exposureStart) return cycle.status || 'planned';
  const today = todayISO();
  const tl = calcBreedingTimeline(cycle.exposureStart);
  if (!tl) return 'planned';
  if (today < cycle.exposureStart) return 'planned';
  if (today > tl.growEnd) return 'completed';
  return 'active';
}

// ── PIG BATCH LEDGER HELPERS ────────────────────────────────────────────────
// Sub-batches are partitions of their parent feeder group. "Started counts"
// (giltCount/boarCount/originalPigCount on both parent and sub) are
// authoritative — they record what entered the batch. Transfers, processing
// trips, and mortality are events recorded in audit logs (breeders[],
// processingTrips, pigMortalities). "Current" is derived ledger-style from
// started − Σ events.

export function pigSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Resolve a session.batch_id (slug or exact name) to a sub-batch id on the
// parent feeder group. Returns null if no match.
export function resolveSubByBatchId(parentGroup, batchId) {
  if (!batchId || !parentGroup || !Array.isArray(parentGroup.subBatches)) return null;
  const s = pigSlug(batchId);
  for (const sb of parentGroup.subBatches) {
    if (pigSlug(sb.name) === s) return sb.id;
  }
  return null;
}

// Active pig feeder daily-report targets. Each ACTIVE feeder group contributes
// its ACTIVE sub-batches only — there is no parent-batch fallback. A parent
// feeder group with zero sub-batches (or whose sub-batches are all
// processed/inactive) contributes no feeder daily target: feeder daily reports
// exist only once an active sub-batch splits the group. SOWS/BOARS breeding
// stock are separate non-feeder daily targets handled by the caller.
//
// Returns [{id, name, parentBatchName}] in feeder-group order, then sub order,
// so callers (webform active_groups in main.jsx, Home missed-report loop) share
// one derivation and cannot drift.
export function activePigFeederDailyTargets(feederGroups) {
  const out = [];
  for (const g of feederGroups || []) {
    if (!g || g.status !== 'active') continue;
    for (const s of g.subBatches || []) {
      if (s && s.status === 'active') out.push({id: s.id, name: s.name, parentBatchName: g.batchName});
    }
  }
  return out;
}

// Sum breeders[] transferred from a specific sub of a specific parent batch.
// Returns {count, feedAllocLbs, gilts, boars}.
export function pigTransfersForSub(breeders, parentBatchName, subBatchName) {
  const out = {count: 0, feedAllocLbs: 0, gilts: 0, boars: 0};
  if (!Array.isArray(breeders)) return out;
  for (const b of breeders) {
    if (!b || !b.transferredFromBatch) continue;
    if (b.transferredFromBatch.batchName !== parentBatchName) continue;
    if (b.transferredFromBatch.subBatchName !== subBatchName) continue;
    out.count++;
    out.feedAllocLbs += parseFloat(b.transferredFromBatch.feedAllocationLbs) || 0;
    if (b.sex === 'Boar') out.boars++;
    else out.gilts++;
  }
  return out;
}

// Aggregated to the parent (any sub).
export function pigTransfersForBatch(breeders, parentBatchName) {
  const out = {count: 0, feedAllocLbs: 0, gilts: 0, boars: 0};
  if (!Array.isArray(breeders)) return out;
  for (const b of breeders) {
    if (!b || !b.transferredFromBatch) continue;
    if (b.transferredFromBatch.batchName !== parentBatchName) continue;
    out.count++;
    out.feedAllocLbs += parseFloat(b.transferredFromBatch.feedAllocationLbs) || 0;
    if (b.sex === 'Boar') out.boars++;
    else out.gilts++;
  }
  return out;
}

// Sum trip pigs attributed to a specific sub via trip.subAttributions.
export function pigTripPigsForSub(trips, subId) {
  if (!Array.isArray(trips)) return 0;
  let n = 0;
  for (const t of trips) {
    const atts = t && Array.isArray(t.subAttributions) ? t.subAttributions : [];
    for (const a of atts) if (a && a.subId === subId) n += parseInt(a.count) || 0;
  }
  return n;
}

// Total trip pigs across all subAttributions (sum may be < trip.pigCount
// when legacy trips have no attribution; the unattributed remainder is the
// difference).
export function pigTripPigsAttributed(trips) {
  if (!Array.isArray(trips)) return 0;
  let n = 0;
  for (const t of trips) {
    const atts = t && Array.isArray(t.subAttributions) ? t.subAttributions : [];
    for (const a of atts) n += parseInt(a.count) || 0;
  }
  return n;
}

// FCR (feed conversion ratio) for a pig feeder group: adjusted feed
// (raw − transfer credits) ÷ total live weight produced by completed trips.
// Returns null when no trips have happened yet — caller falls back to the
// industry default (3.5).
//
// Same accounting frame as the post-overhaul lbs-per-pig math: numerator
// excludes feed credited to transferred-to-breeding pigs (their feed left
// with them), denominator excludes those pigs (they didn't go to processor).
//
// `dailysForName` is a closure-captured helper from PigBatchesView that
// matches a sub-batch / parent name against pig_dailys rows. Lifted as an
// arg so this helper stays React-free.
export function computePigBatchFCR(group, dailysForName, breeders) {
  if (!group) return null;
  const trips = group.processingTrips || [];
  let totalLive = 0;
  for (const t of trips) {
    const wts = (t.liveWeights || '')
      .split(/[\s,]+/)
      .map(parseFloat)
      .filter((v) => !isNaN(v) && v > 0);
    totalLive += wts.reduce((a, b) => a + b, 0);
  }
  if (!(totalLive > 0)) return null;
  const subs = group.subBatches || [];
  let rawFeed = parseFloat(group.legacyFeedLbs) || 0;
  if (subs.length > 0) {
    for (const sb of subs) {
      rawFeed += parseFloat(sb.legacyFeedLbs) || 0;
      const rows = typeof dailysForName === 'function' ? dailysForName(sb.name) || [] : [];
      for (const d of rows) rawFeed += parseFloat(d.feed_lbs) || 0;
    }
  } else {
    const rows = typeof dailysForName === 'function' ? dailysForName(group.batchName) || [] : [];
    for (const d of rows) rawFeed += parseFloat(d.feed_lbs) || 0;
  }
  // Transfer credit: prefer sum-of-subs from the breeders[] audit log
  // (canonical, per-sub split). Fall back to parent.feedAllocatedToTransfers
  // for parent-only batches that never had subs.
  const agg = pigTransfersForBatch(breeders, group.batchName);
  const credit = agg.feedAllocLbs > 0 ? agg.feedAllocLbs : parseFloat(group.feedAllocatedToTransfers) || 0;
  const adjFeed = Math.max(0, rawFeed - credit);
  if (!(adjFeed > 0)) return null;
  return Math.round((adjFeed / totalLive) * 1000) / 1000;
}

export function pigMortalityForSub(group, subName) {
  let n = 0;
  for (const m of (group && group.pigMortalities) || []) {
    if (m && m.sub_batch_name === subName) n += parseInt(m.count) || 0;
  }
  return n;
}
export function pigMortalityForBatch(group) {
  let n = 0;
  for (const m of (group && group.pigMortalities) || []) n += parseInt(m.count) || 0;
  return n;
}

// Reconcile sub-batches against parent. Auto-load repair is intentionally
// NARROW: it only enforces the deterministic invariant
//   sub.originalPigCount === sub.giltCount + sub.boarCount
// for subs whose sum-of-gilts and sum-of-boars already match the parent.
//
// When sub totals don't match the parent (sex-specific: sum giltCount === parent
// giltCount AND sum boarCount === parent boarCount), the function does NOT
// redistribute counts automatically — that's a structural decision an admin
// must make via the parent partition UI. We log a console warning per
// mismatched batch so the inconsistency is visible in dev tools without a
// silent prod rewrite.
//
// Returns {changed, groups, warnings} so callers can surface unresolved
// mismatches to the user.
// ── AGE / TIMELINE HELPERS (extracted from PigBatchesView for reuse) ───────
// Pure helpers — pass breedingCycles / farrowingRecs in rather than reading
// React context. Used by PigBatchesView and the pig-forecast helpers.

// Convert a positive day count into a "Xm Yw" label (months + weeks, days
// dropped per Ronnie's preference on batch tiles). Returns null for ≤ 0 days.
export function daysToMWD(days) {
  if (days <= 0) return null;
  const m = Math.floor(days / 30);
  const w = Math.floor((days % 30) / 7);
  return `${m}m ${w}w`;
}

// Farrowing records that belong to a given breeding cycle: must match the
// cycle's group AND fall within the theoretical farrowing window (with a
// 14-day buffer for edge cases).
export function cycleRecords(cycle, farrowingRecs) {
  if (!cycle || !Array.isArray(farrowingRecs)) return [];
  const tl = calcBreedingTimeline(cycle.exposureStart);
  if (!tl) return [];
  return farrowingRecs.filter((r) => {
    if (r.group !== cycle.group) return false;
    if (!r.farrowingDate) return false;
    const rd = new Date(r.farrowingDate + 'T12:00:00');
    const wStart = new Date(tl.farrowingStart + 'T12:00:00');
    const wEnd = addDays(tl.farrowingEnd, 14);
    return rd >= wStart && rd <= wEnd;
  });
}

// Age range for the pigs in a breeding cycle as of a reference date.
// Uses actual farrowing dates when present, falls back to the theoretical
// farrowing window (marked "(est.)" in the rendered text). asOfDate may be
// pinned by the caller (e.g. the latest processor-trip date once a batch's
// current count hits 0) so the displayed age stops advancing.
//
// Returns {text, hasActual, count, total, minDays, maxDays}:
//   text       — display string (e.g. "5m 2w – 5m 5w" or "Up to 6m 0w (est.)")
//   hasActual  — true when actual farrowing records were used
//   count      — number of farrowing records found for this cycle
//   total      — cycle.sowCount as integer (0 if missing)
//   minDays    — youngest age in days at ref, clamped to 0 (never negative)
//                or null when the cycle has no usable timeline
//   maxDays    — oldest age in days at ref, or null when same
//
// minDays/maxDays power the planned-trip projector's pre-weigh-in mode
// (recalculateProjections cycleAgeDaysAtRef arg). Both are null when the
// cycle is missing, exposureStart is missing, or the session/ref is before
// any farrowing date (the not-yet-born clamp).
export function calcAgeRange(cycleId, asOfDate, breedingCycles, farrowingRecs) {
  const cycles = Array.isArray(breedingCycles) ? breedingCycles : [];
  const cycle = cycles.find((c) => c.id === cycleId);
  if (!cycle) return {text: '—', hasActual: false, count: 0, total: 0, minDays: null, maxDays: null};
  const tl = calcBreedingTimeline(cycle.exposureStart);
  if (!tl) return {text: '—', hasActual: false, count: 0, total: 0, minDays: null, maxDays: null};

  const recs = cycleRecords(cycle, farrowingRecs);
  const ref = asOfDate instanceof Date && !isNaN(asOfDate.getTime()) ? asOfDate : new Date();

  let firstDate, lastDate;
  let hasActual = false;
  if (recs.length > 0) {
    const dates = recs.map((r) => new Date(r.farrowingDate + 'T12:00:00')).sort((a, b) => a - b);
    firstDate = dates[0];
    lastDate = dates[dates.length - 1];
    hasActual = true;
  } else {
    firstDate = new Date(tl.farrowingStart + 'T12:00:00');
    lastDate = new Date(tl.farrowingEnd + 'T12:00:00');
  }

  const oldestDays = Math.round((ref - firstDate) / 86400000);
  const youngestDays = Math.round((ref - lastDate) / 86400000);
  const total = parseInt(cycle.sowCount) || 0;

  if (oldestDays <= 0) {
    return {text: 'Not yet born', hasActual, count: recs.length, total, minDays: null, maxDays: null};
  }
  const oldest = daysToMWD(oldestDays);
  const text =
    youngestDays <= 0
      ? `Up to ${oldest}${!hasActual ? ' (est.)' : ''}`
      : `${daysToMWD(youngestDays)} – ${oldest}${!hasActual ? ' (est.)' : ''}`;
  // Numeric bounds for the projector. Clamp youngest to 0 so the band
  // doesn't go negative when the youngest pigs haven't quite been born yet.
  return {
    text,
    hasActual,
    count: recs.length,
    total,
    minDays: Math.max(0, youngestDays),
    maxDays: oldestDays,
  };
}

export function reconcileFeederGroupsFromBreeders(feederGroups) {
  let changed = false;
  const warnings = [];
  const groups = (feederGroups || []).map((g) => {
    const subs = g.subBatches || [];
    if (subs.length === 0) return g;
    const sumGilts = subs.reduce((s, sb) => s + (parseInt(sb.giltCount) || 0), 0);
    const sumBoars = subs.reduce((s, sb) => s + (parseInt(sb.boarCount) || 0), 0);
    const parentGilts = parseInt(g.giltCount) || 0;
    const parentBoars = parseInt(g.boarCount) || 0;
    if (sumGilts !== parentGilts || sumBoars !== parentBoars) {
      const msg =
        '[reconcile] ' +
        (g.batchName || g.id) +
        " sub totals don't match parent: gilts " +
        sumGilts +
        '/' +
        parentGilts +
        ', boars ' +
        sumBoars +
        '/' +
        parentBoars +
        ' (skipped — admin to resolve via partition UI)';
      warnings.push(msg);
      if (typeof console !== 'undefined' && console.warn) console.warn(msg);
      return g;
    }
    // Sex sums match — only enforce the OPC = gilt+boar invariant. This
    // is a deterministic, lossless rewrite (every sub has a single right
    // answer and we're rewriting only that field).
    let needsOPC = false;
    const newSubs = subs.map((sb) => {
      const opc = (parseInt(sb.giltCount) || 0) + (parseInt(sb.boarCount) || 0);
      if ((parseInt(sb.originalPigCount) || 0) !== opc) {
        needsOPC = true;
        return {...sb, originalPigCount: opc};
      }
      return sb;
    });
    if (needsOPC) {
      changed = true;
      return {...g, subBatches: newSubs};
    }
    return g;
  });
  return {changed, groups, warnings};
}
