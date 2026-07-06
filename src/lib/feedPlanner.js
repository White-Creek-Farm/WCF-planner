// ============================================================================
// src/lib/feedPlanner.js
// ----------------------------------------------------------------------------
// Pure feed-order planning helpers. Snapshot-anchored, day-by-day forward
// projection. Used by /pig/feed and /broiler/feed view rebuilds. No React,
// no Supabase, no DOM — testable in isolation under vitest.
//
// Product goal (Codex's Final UX direction): the views answer one question,
// "How much feed do I need to order?" Everything else is detail.
//
// Source-of-truth contracts (documented per Codex, locked in commit 1):
//
//   1. Forward day-by-day runway. Days-of-feed-on-hand is computed by
//      walking dates forward and integrating daily burn until the snapshot
//      depletes — NEVER `onHandToday / todayBurn`. Burn changes with herd
//      age, especially pigs and broilers, so naive division materially
//      overstates runway.
//
//   2. Snapshot is an anchor. If the operator counted feed on date D at L
//      lbs, today's on-hand = L − consumption_between_D_and_today. The
//      snapshot's date IS the timing — the legacy
//      `includesCurrentMonthDelivery` operator-facing flag is gone.
//      Helper still tolerates legacy snapshot rows that carry the flag
//      (it's ignored), so old data doesn't break.
//
//   3. Per-feed-type independent targeting. No cycle picker. Each feed
//      type computes its own runway, its own order-by-date, its own
//      suggested amount.
//
//   4. Ledger-derived current count for pigs. The feed planner reads
//      remaining feeder count via the same ledger frame as PigBatchesView
//      (started − tripPigs − transfers − mortality), reusing the helpers
//      from src/lib/pig.js. Never reads `subBatches[].currentCount` as
//      persisted truth.
//
// Constants Codex pinned for v1 (named so per-type tweaks later are
// trivial — no storage migration, no UI churn):
//
//   LEAD_TIME_DAYS = 7   — supplier lead time (how far ahead to order).
//   RESERVE_DAYS   = {default: 30}  — days of post-delivery cover desired.
//   ORDER_ROUNDING_LBS = 50  — round suggestions UP to this increment.
//   STALE_SNAPSHOT_DAYS = 21  — recount-soon chip threshold.
// ============================================================================

import {
  pigTripPigsForSub,
  pigTransfersForSub,
  pigTransfersForBatch,
  pigMortalityForSub,
  pigMortalityForBatch,
  calcBreedingTimeline,
  cycleRecords,
  batchStartedCount,
} from './pig.js';
import {getFeedSchedule, LAYER_FEED_SCHEDULE, LAYER_FEED_PER_DAY} from './broiler.js';
import {computeProjectedCount} from './layerHousing.js';

export const LEAD_TIME_DAYS = 7;
export const RESERVE_DAYS = {default: 30};
export const ORDER_ROUNDING_LBS = 50;
export const STALE_SNAPSHOT_DAYS = 21;

// Supported feed types. Pig is one bucket; poultry splits into starter /
// grower (broiler stages) and layerfeed (laying hens). The order-history
// ledger keys at `ppp-feed-orders-v1` already use these strings, so
// downstream UI plumbing is byte-stable.
export const FEED_TYPES = ['pig', 'starter', 'grower', 'layerfeed'];

// ── Date utilities (kept tiny + pure; no Intl, no time-of-day math) ────────
//
// All dates flow as 'YYYY-MM-DD' strings. Parsing uses Date with a noon
// anchor so DST rolls don't shift the day.

function parseISO(iso) {
  if (typeof iso !== 'string' || iso.length < 10) return null;
  const d = new Date(iso.slice(0, 10) + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function toISO(d) {
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function addDaysISO(iso, n) {
  const d = parseISO(iso);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  return toISO(d);
}

function diffDays(fromISO, toISO_) {
  const a = parseISO(fromISO);
  const b = parseISO(toISO_);
  if (!a || !b) return 0;
  return Math.round((b - a) / 86400000);
}

// ── Pig feeder ledger ──────────────────────────────────────────────────────
//
// Mirrors PigBatchesView's `remaining` formula at line 407:
//   started = sub.giltCount + sub.boarCount  (== sub.originalPigCount when
//                                              gilt/boar split is consistent)
//   remaining = max(0, started − tripPigs − transfers.count − mortality)
//
// Codex's locked fixture: 50 started, 8 trip, 5 transferred, 2 mortality →
// 35 remaining at any future date.

export function pigFeederSubCurrentCount(group, sub, breeders) {
  if (!group || !sub) return 0;
  const giltCount = parseInt(sub.giltCount) || 0;
  const boarCount = parseInt(sub.boarCount) || 0;
  const started = giltCount + boarCount;
  const tripPigs = pigTripPigsForSub(group.processingTrips || [], sub.id);
  const transfers = pigTransfersForSub(breeders, group.batchName, sub.name);
  const mortality = pigMortalityForSub(group, sub.name);
  return Math.max(0, started - tripPigs - transfers.count - mortality);
}

// ── Per-pig daily burn rate by age ─────────────────────────────────────────
//
// Preserves the existing PigFeedView formula byte-for-byte to keep this
// commit a count-fix, not a rate-model change. A per-age-bucket curve
// (industry-standard nursery/starter/grower/finisher rates) is a future
// refinement and will land as its own lane with Ronnie's input on which
// rates to use.
//
// Current shape: lbs/day/pig = max(1, ageDays / 30.44)
//   day  30: 1.0 lbs/day/pig (clamped floor)
//   day  60: 1.97 lbs/day/pig
//   day  90: 2.96 lbs/day/pig
//   day 180: 5.91 lbs/day/pig

export function pigFeederLbsPerDayAtAge(ageDays) {
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0;
  const ageMonths = ageDays / 30.44;
  return Math.max(1, ageMonths);
}

// Pig sub-batch birth date. Prefer the cycle's farrowing-start projection
// (canonical), fall back to the group's own startDate for legacy batches
// that aren't tied to a cycle.

function pigSubBirthDate(group, breedingCycles) {
  if (!group) return null;
  const cycle = (breedingCycles || []).find((c) => c.id === group.cycleId);
  const tl = cycle ? calcBreedingTimeline(cycle.exposureStart) : null;
  if (tl && tl.farrowingStart) return tl.farrowingStart;
  return group.startDate || null;
}

// Total pig feed lbs/day at a given date. Sums:
//   • non-nursing sows × 5
//   • nursing sows     × 15
//   • boars            × 5
//   • born piglets not yet represented in a linked feeder batch × age-rate
//   • feeder pigs (per sub-batch, ledger-derived current count) × age-rate
//
// Sow-rate constants are the same numbers PigFeedView used; lifted here
// so they're inspectable + overrideable later without touching consumers.

export const PIG_FEED_RATES = {
  sowDryLbsPerDay: 5,
  sowNursingLbsPerDay: 15,
  boarLbsPerDay: 5,
};

function nursingSowsOnDate(dateISO, breedingCycles, farrowingRecs) {
  let count = 0;
  if (!Array.isArray(breedingCycles) || !Array.isArray(farrowingRecs)) return 0;
  for (const c of breedingCycles) {
    const tl = calcBreedingTimeline(c.exposureStart);
    if (!tl) continue;
    for (const r of farrowingRecs) {
      if (r.group !== c.group || !r.farrowingDate) continue;
      const rdISO = String(r.farrowingDate).slice(0, 10);
      if (rdISO < tl.farrowingStart) continue;
      // farrowingEnd + 14 days lockout: nursing window
      const endISO = addDaysISO(tl.farrowingEnd, 14);
      if (rdISO > endISO) continue;
      // The record belongs to this cycle. Is the date within the nursing
      // span (farrowingDate .. weaningEnd)?
      if (r.farrowingDate <= dateISO && tl.weaningEnd >= dateISO) count++;
    }
  }
  return count;
}

function farrowingAliveCount(record) {
  if (!record) return 0;
  if (record.alive != null && record.alive !== '' && !Number.isNaN(Number(record.alive))) {
    return Math.max(0, parseInt(record.alive) || 0);
  }
  return Math.max(0, (parseInt(record.totalBorn) || 0) - (parseInt(record.deaths) || 0));
}

function linkedCycleBatch(cycle, feederGroups) {
  if (!cycle || !cycle.id) return null;
  const generatedId = 'farrowing-cycle-' + cycle.id;
  return (
    (feederGroups || []).find((g) => g && g.cycleId === cycle.id) ||
    (feederGroups || []).find((g) => g && g.id === generatedId) ||
    null
  );
}

function batchRepresentedStartedCount(group) {
  if (!group) return 0;
  const subs = Array.isArray(group.subBatches) ? group.subBatches : [];
  if (subs.length > 0) {
    return subs.reduce(
      (sum, sub) => sum + (parseInt(sub && sub.giltCount) || 0) + (parseInt(sub && sub.boarCount) || 0),
      0,
    );
  }
  return batchStartedCount(group);
}

function unrepresentedFarrowingPigletFeed(dateISO, {breedingCycles = [], farrowingRecs = [], feederGroups = []} = {}) {
  let piglets = 0;
  let lbs = 0;
  for (const cycle of breedingCycles || []) {
    const tl = cycle ? calcBreedingTimeline(cycle.exposureStart) : null;
    if (!tl || !cycle.id || !tl.growEnd || dateISO > tl.growEnd) continue;
    let represented = batchRepresentedStartedCount(linkedCycleBatch(cycle, feederGroups));
    const records = cycleRecords(cycle, farrowingRecs || [])
      .filter((r) => r && r.farrowingDate && r.farrowingDate <= dateISO)
      .sort((a, b) => String(a.farrowingDate).localeCompare(String(b.farrowingDate)));
    for (const record of records) {
      let residual = farrowingAliveCount(record);
      if (represented > 0) {
        const covered = Math.min(represented, residual);
        residual -= covered;
        represented -= covered;
      }
      if (residual <= 0) continue;
      const ageDays = diffDays(record.farrowingDate, dateISO);
      const ratePerPig = pigFeederLbsPerDayAtAge(ageDays);
      piglets += residual;
      lbs += residual * ratePerPig;
    }
  }
  return {piglets, lbs};
}

export function pigDailyBurnLbs(dateISO, ctx) {
  const {feederGroups = [], breedingCycles = [], breeders = [], farrowingRecs = []} = ctx || {};
  const totalActiveSows = breeders.filter((b) => !b.archived && (b.sex === 'Sow' || b.sex === 'Gilt')).length;
  const totalBoars = breeders.filter((b) => !b.archived && b.sex === 'Boar').length;
  const nursing = nursingSowsOnDate(dateISO, breedingCycles, farrowingRecs);
  const nonNursing = Math.max(0, totalActiveSows - nursing);

  const sowFeed = nonNursing * PIG_FEED_RATES.sowDryLbsPerDay + nursing * PIG_FEED_RATES.sowNursingLbsPerDay;
  const boarFeed = totalBoars * PIG_FEED_RATES.boarLbsPerDay;

  let feederFeed = 0;
  for (const g of feederGroups) {
    if (g.status !== 'active') continue;
    const birthDate = pigSubBirthDate(g, breedingCycles);
    if (!birthDate) continue;
    const ageDays = diffDays(birthDate, dateISO);
    if (ageDays < 0) continue;
    const ratePerPig = pigFeederLbsPerDayAtAge(ageDays);
    const subs = Array.isArray(g.subBatches) ? g.subBatches : [];
    if (subs.length === 0) {
      // Parent-only batch (legacy, no subs). Mirror the same ledger frame
      // as the sub-batch path so processing trips, breeding transfers, and
      // mortality all reduce the count — Codex's commit-1 review point #1.
      // Helper sources from src/lib/pig.js: pigTransfersForBatch +
      // pigMortalityForBatch.
      const giltCount = parseInt(g.giltCount) || parseInt(g.originalPigCount) || 0;
      const boarCount = parseInt(g.boarCount) || 0;
      const started = giltCount + boarCount;
      const tripPigs = (g.processingTrips || []).reduce((s, t) => s + (parseInt(t.pigCount) || 0), 0);
      const transfers = pigTransfersForBatch(breeders, g.batchName);
      const mortality = pigMortalityForBatch(g);
      const remaining = Math.max(0, started - tripPigs - transfers.count - mortality);
      feederFeed += remaining * ratePerPig;
    } else {
      for (const sub of subs) {
        if (sub.status === 'processed') continue;
        const remaining = pigFeederSubCurrentCount(g, sub, breeders);
        feederFeed += remaining * ratePerPig;
      }
    }
  }
  const farrowingPigletFeed = unrepresentedFarrowingPigletFeed(dateISO, {breedingCycles, farrowingRecs, feederGroups});

  return {
    sowLbs: sowFeed,
    boarLbs: boarFeed,
    feederLbs: feederFeed,
    farrowingPigletLbs: farrowingPigletFeed.lbs,
    farrowingPiglets: farrowingPigletFeed.piglets,
    totalLbs: sowFeed + boarFeed + feederFeed + farrowingPigletFeed.lbs,
    nursing,
    nonNursing,
  };
}

// ── Poultry daily burn ─────────────────────────────────────────────────────
//
// Three independent feed types — per-feed-type targeting, no cycle picker:
//
//   starter:   weeks 1-2 broilers, weeks 1-6 layer chicks (per
//              LAYER_FEED_SCHEDULE).
//   grower:    weeks 3+ broilers (CC through wk 7, WR through wk 8;
//              schedule from getFeedSchedule), weeks 7-20 layers.
//   layerfeed: weeks 21+ layers, daily lbs/bird = LAYER_FEED_PER_DAY.
//
// Math is anchored on the same source helpers BroilerFeedView's monthly
// projection uses (getFeedSchedule, LAYER_FEED_SCHEDULE,
// LAYER_FEED_PER_DAY, computeProjectedCount). The new order board will
// give the same numbers as the existing feed tab — Codex's commit-1
// review point #2 ("cannot use new simplified constants as the
// foundation"). Per-day daily lbs = (week's totalLbs ÷ 7) for broilers,
// (week's lbsPerBird × birdCount ÷ 7) for layers in starter/grower
// phases. Layer phase uses computeProjectedCount against active
// housings, falling back to original_count when no housings exist yet
// (matches calcLayerFeedForMonth at line 455).
//
// `ctx` shape mirrors BroilerFeedView's data plumbing:
//   batches:        active broiler batches with {hatchDate, breed,
//                   status, optionally birdCountActual} — broiler
//                   headcount is locked at FEED_BIRDS=700 inside
//                   getFeedSchedule's totalLbs (matches the existing
//                   monthly projection; not driven by birdCountActual).
//   layerBatches:   layer batches with {brooder_entry_date|arrival_date,
//                   original_count, id, status}.
//   layerHousings:  housings rows with {batch_id, status, current_count}.
//   layerDailys:    layer daily reports for computeProjectedCount
//                   mortality math.

// Per-day lbs for one active broiler batch on a given date.

function broilerBatchDailyLbs(batch, dateISO) {
  if (!batch || !batch.hatchDate) return {starterLbs: 0, growerLbs: 0};
  const ageDays = diffDays(batch.hatchDate, dateISO);
  if (ageDays < 0) return {starterLbs: 0, growerLbs: 0};
  const weekIdx = Math.floor(ageDays / 7);
  const schedule = getFeedSchedule(batch.breed);
  if (weekIdx < 0 || weekIdx >= schedule.length) return {starterLbs: 0, growerLbs: 0};
  const w = schedule[weekIdx];
  const dailyLbs = (w.totalLbs || 0) / 7;
  return w.phase === 'starter' ? {starterLbs: dailyLbs, growerLbs: 0} : {starterLbs: 0, growerLbs: dailyLbs};
}

// Per-day lbs for one active layer batch on a given date. Mirrors
// calcLayerFeedForMonth's three-phase model exactly.

function layerBatchDailyLbs(batch, housings, layerDailys, dateISO) {
  if (!batch) return {starterLbs: 0, growerLbs: 0, layerLbs: 0};
  const startDate = batch.brooder_entry_date || batch.arrival_date;
  if (!startDate) return {starterLbs: 0, growerLbs: 0, layerLbs: 0};
  const ageDays = diffDays(startDate, dateISO);
  if (ageDays < 0) return {starterLbs: 0, growerLbs: 0, layerLbs: 0};
  const birdCount = parseInt(batch.original_count) || 0;
  if (birdCount <= 0) return {starterLbs: 0, growerLbs: 0, layerLbs: 0};
  const weekIdx = Math.floor(ageDays / 7);
  if (weekIdx < LAYER_FEED_SCHEDULE.length) {
    const w = LAYER_FEED_SCHEDULE[weekIdx];
    const dailyLbs = (w.lbsPerBird * birdCount) / 7;
    return w.phase === 'starter'
      ? {starterLbs: dailyLbs, growerLbs: 0, layerLbs: 0}
      : {starterLbs: 0, growerLbs: dailyLbs, layerLbs: 0};
  }
  // Week 21+: layer phase. Use projected hen count from active housings;
  // fall back to original_count when no housings exist yet.
  const batchHousings = (housings || []).filter((h) => h.batch_id === batch.id && h.status === 'active');
  let hens = 0;
  if (batchHousings.length > 0) {
    for (const h of batchHousings) {
      const proj = computeProjectedCount(h, layerDailys || []);
      hens += proj ? proj.projected : parseInt(h.current_count) || 0;
    }
  } else {
    hens = birdCount;
  }
  return {starterLbs: 0, growerLbs: 0, layerLbs: hens * LAYER_FEED_PER_DAY};
}

export function poultryDailyBurnLbs(dateISO, ctx) {
  const {batches = [], layerBatches = [], layerHousings = [], layerDailys = []} = ctx || {};
  let starterLbs = 0;
  let growerLbs = 0;
  let layerLbs = 0;

  for (const b of batches) {
    if (b && b.status === 'active') {
      const out = broilerBatchDailyLbs(b, dateISO);
      starterLbs += out.starterLbs;
      growerLbs += out.growerLbs;
    }
  }

  for (const lb of layerBatches) {
    if (lb && lb.status === 'active') {
      const out = layerBatchDailyLbs(lb, layerHousings, layerDailys, dateISO);
      starterLbs += out.starterLbs;
      growerLbs += out.growerLbs;
      layerLbs += out.layerLbs;
    }
  }

  return {starterLbs, growerLbs, layerLbs};
}

// ── Forward day-by-day runway ──────────────────────────────────────────────
//
// Walks dates from `fromDateISO` forward, subtracting each day's burn
// from `onHandLbs` until it reaches zero. Returns the integer number of
// full days the on-hand survives (with a remainder fraction-of-day
// resolved as floor for conservatism — surfacing fewer days is safer
// than overstating).
//
// `burnRateFn(dateISO) → lbs/day` is supplied by the caller. For pig:
// `(d) => pigDailyBurnLbs(d, ctx).totalLbs`. For poultry, one fn per type.
//
// Capped at `maxDays` (default 365) so a near-infinite-runway scenario
// (e.g., empty batches) doesn't loop forever.

export function runwayDays({onHandLbs, fromDateISO, burnRateFn, maxDays = 365}) {
  if (!Number.isFinite(onHandLbs) || onHandLbs <= 0) return 0;
  if (typeof burnRateFn !== 'function') return 0;
  let remaining = onHandLbs;
  let day = 0;
  while (day < maxDays && remaining > 0) {
    const date = addDaysISO(fromDateISO, day);
    const burn = burnRateFn(date) || 0;
    if (burn <= 0) {
      // Zero burn → "infinite" runway; cap at maxDays.
      day = maxDays;
      break;
    }
    if (remaining < burn) break;
    remaining -= burn;
    day += 1;
  }
  return day;
}

// Sum of daily burn over a forward window starting at `fromDateISO` and
// running for `throughDays` days (inclusive of day 0, exclusive of day N).

export function totalBurnOverDays({fromDateISO, throughDays, burnRateFn}) {
  if (!Number.isFinite(throughDays) || throughDays <= 0) return 0;
  if (typeof burnRateFn !== 'function') return 0;
  let total = 0;
  for (let i = 0; i < throughDays; i++) {
    const date = addDaysISO(fromDateISO, i);
    total += burnRateFn(date) || 0;
  }
  return total;
}

// ── Snapshot anchor → today's on-hand ──────────────────────────────────────
//
// Operator counted `snapshotLbs` on `snapshotDateISO`. Today's on-hand =
// snapshot − consumption between snapshot date and today.
//
// `consumedLbsFn(fromISO, toISO) → lbs` is the caller-supplied actual
// consumption integrator (typically reads pig_dailys / broiler_dailys
// summed in the date window). When omitted, falls back to projected burn
// over the window (less accurate, but useful when actuals haven't logged
// yet).
//
// Returns null when snapshotDate is in the future (impossible) or
// missing — caller should treat as "no snapshot."

export function onHandFromSnapshot({snapshotLbs, snapshotDateISO, todayISO, consumedLbsFn, burnRateFn}) {
  if (!Number.isFinite(snapshotLbs) || snapshotLbs < 0) return null;
  if (!snapshotDateISO || !todayISO) return null;
  const days = diffDays(snapshotDateISO, todayISO);
  if (days < 0) return null; // Snapshot in the future — caller error.
  if (days === 0) return snapshotLbs;
  let consumed = 0;
  if (typeof consumedLbsFn === 'function') {
    consumed = consumedLbsFn(snapshotDateISO, todayISO) || 0;
  } else if (typeof burnRateFn === 'function') {
    consumed = totalBurnOverDays({fromDateISO: snapshotDateISO, throughDays: days, burnRateFn});
  }
  return Math.max(0, snapshotLbs - consumed);
}

// Stale-snapshot freshness check. Returns true when a snapshot exists and
// is older than STALE_SNAPSHOT_DAYS — UI surfaces a "Recount soon" chip.
// No snapshot at all returns false (the no-snapshot empty-state CTA owns
// that prompt).

export function isSnapshotStale({snapshotDateISO, todayISO}) {
  if (!snapshotDateISO || !todayISO) return false;
  return diffDays(snapshotDateISO, todayISO) > STALE_SNAPSHOT_DAYS;
}

// ── Suggested order ────────────────────────────────────────────────────────
//
// Goal: at delivery time, on-hand should cover RESERVE_DAYS of forward
// burn. Solving:
//
//   onHandAtDelivery = currentOnHand − burn(today, delivery)
//   afterDelivery    = onHandAtDelivery + orderLbs
//   require: afterDelivery >= burn(delivery, delivery + reserveDays)
//   ⇒ orderLbs >= burn(today, today + leadTime + reserveDays) − currentOnHand
//
// The horizon is therefore today + leadTime + reserveDays. If currentOnHand
// already exceeds that horizon's total burn, suggestion is 0.
//
// `orderByDate` is the latest date the operator can place the order such
// that delivery still lands before runway hits zero:
//   orderByDate = today + max(0, runwayDays − leadTimeDays)
// When runway < leadTime, the operator is already late — orderByDate is
// today. UI surfaces an amber chip in that case.

export function suggestOrder({
  onHandLbs,
  todayISO,
  burnRateFn,
  leadTimeDays = LEAD_TIME_DAYS,
  reserveDays = RESERVE_DAYS.default,
  roundingLbs = ORDER_ROUNDING_LBS,
}) {
  if (!Number.isFinite(onHandLbs) || onHandLbs < 0) onHandLbs = 0;
  if (typeof burnRateFn !== 'function') return null;
  const horizonDays = leadTimeDays + reserveDays;
  const horizonBurn = totalBurnOverDays({fromDateISO: todayISO, throughDays: horizonDays, burnRateFn});
  const rawOrderLbs = Math.max(0, horizonBurn - onHandLbs);
  const roundedOrderLbs =
    rawOrderLbs > 0 && roundingLbs > 0 ? Math.ceil(rawOrderLbs / roundingLbs) * roundingLbs : Math.round(rawOrderLbs);
  const days = runwayDays({onHandLbs, fromDateISO: todayISO, burnRateFn});
  const orderByOffset = Math.max(0, days - leadTimeDays);
  const orderByDateISO = addDaysISO(todayISO, orderByOffset);
  const burnDuringLead = totalBurnOverDays({
    fromDateISO: todayISO,
    throughDays: leadTimeDays,
    burnRateFn,
  });
  const balanceAfterDelivery = Math.max(0, Math.round(onHandLbs - burnDuringLead + roundedOrderLbs));
  return {
    daysOfRunway: days,
    rawOrderLbs: Math.round(rawOrderLbs),
    suggestedOrderLbs: roundedOrderLbs,
    orderByDateISO,
    orderIsLate: days < leadTimeDays,
    balanceAfterDelivery,
    horizonDays,
    horizonBurnLbs: Math.round(horizonBurn),
  };
}
