// ============================================================================
// src/lib/broiler.js  —  broiler domain helpers + constants
// ----------------------------------------------------------------------------
// Lifted out of main.jsx as prep for Round 6 (inline-JSX view extraction).
// Pure module-scope functions + constants; no React, no App closure state.
// ============================================================================
import {toISO, addDays, todayISO, fmtS} from './dateUtils.js';
import {computeProjectedCount} from './layerHousing.js';
export const BROODER_DAYS = 14;
export const CC_SCHOONER = 35;
export const WR_SCHOONER = 42;

// Housing slot identifiers + cleanout windows. Used by detectConflicts in
// main.jsx, by the broiler BatchForm dropdowns, and by LayerBatchesView's
// brooder/schooner pickers. Single source of truth for both programs.
export const BROODERS = ['1', '2', '3'];
export const SCHOONERS = ['1', '2&3', '4&5', '6&6A', '7&7A'];
export const BROODER_CLEANOUT = 3;
export const SCHOONER_CLEANOUT = 4;

// Date-range overlap helper (both ends inclusive, ISO date strings).
// Broiler-vs-broiler and broiler-vs-layer conflict detection both use it.
export function overlaps(a1, a2, b1, b2) {
  return (
    new Date(a1 + 'T12:00:00') <= new Date(b2 + 'T12:00:00') && new Date(a2 + 'T12:00:00') >= new Date(b1 + 'T12:00:00')
  );
}

// Status enum + hatchery lists. Used by the broiler BatchForm dropdowns +
// App's openEdit() legacy-flag detection. calcPoultryStatus() in this file
// also owns the same status strings (the enum is implicit there).
export const STATUSES = ['planned', 'active', 'processed'];
export const ALL_HATCHERIES = [
  'So Big Farms',
  'Meyer Hatchery',
  'Welp Hatchery',
  'Myers Poultry',
  'Freedom Ranger Hatchery',
];
export const LEGACY_HATCHERIES = ['VALLEY FARMS', 'CREDO FARMS', 'CACKLE'];

// Target hatch date given a processing date + breed. Inverts calcTimeline().
// (1 day of schooner gap + BROODER_DAYS + per-breed schooner length.)
export function calcTargetHatch(processingDate, breed) {
  if (!processingDate) return null;
  const totalDays = 1 + BROODER_DAYS + (breed === 'WR' ? WR_SCHOONER : CC_SCHOONER);
  return toISO(addDays(processingDate, -totalDays));
}

// Suggest weekday hatch dates within +/-3d of a target — hatchery ships
// Mon-Fri only, so we offer the caller the five available weekdays.
export function suggestHatchDates(targetISO) {
  if (!targetISO) return [];
  const out = [];
  for (let i = -3; i <= 3; i++) {
    const d = addDays(targetISO, i);
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) {
      out.push({
        iso: toISO(d),
        offset: i,
        day: ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][dow],
        label: fmtS(toISO(d)),
      });
    }
  }
  return out;
}

const FEED_BIRDS = 700; // target processed count (order 750, expect ~700 to processor)
const STARTER_TOTAL_LBS = 1500; // fixed cap per batch for both breeds
const STARTER_PER_BIRD = STARTER_TOTAL_LBS / FEED_BIRDS; // 2.14 lbs/bird (1500/700)
// Split starter 30/70 across weeks 1-2 (matches chick growth pattern)
const STARTER_W1 = STARTER_PER_BIRD * 0.3;
const STARTER_W2 = STARTER_PER_BIRD * 0.7;

// CC grower weeks 3-7 (5 weeks): derived from WCF historical data (2026-04 analysis)
// CC avg 14.29 lbs/bird at 7 weeks processing (7 data points, combining actual 7w batches +
// 8w batches back-calculated using 26.4% week 7→8 growth rate from Aviagen chart)
const CC_TOTAL_TARGET = 14.29;
const CC_GROWER_TARGET = CC_TOTAL_TARGET - STARTER_PER_BIRD; // 12.15 lbs/bird
const CC_GROWER_CHART = [2.482, 4.535, 7.24, 10.485, 14.129]; // cumulative at wks 3-7 from chart (shape only — scaled to WCF target)
const CC_GROWER_WEEKLY_CHART = CC_GROWER_CHART.map((c, i) => c - (i === 0 ? 1.109 : CC_GROWER_CHART[i - 1]));
const CC_GROWER_CHART_TOTAL = CC_GROWER_WEEKLY_CHART.reduce((a, b) => a + b, 0);
const CC_GROWER_SCALE = CC_GROWER_TARGET / CC_GROWER_CHART_TOTAL;
const CC_GROWER_WEEKLY = CC_GROWER_WEEKLY_CHART.map((w) => w * CC_GROWER_SCALE);

// WR grower weeks 3-8 (6 weeks): derived from WCF historical data (2026-04 analysis)
// WR avg 16.26 lbs/bird at 8 weeks processing (3 data points, combining actual 8w batches +
// 9w batches back-calculated using 23.5% week 8→9 growth rate from White Ranger Hatchery chart)
const WR_TOTAL_TARGET = 16.26;
const WR_GROWER_TARGET = WR_TOTAL_TARGET - STARTER_PER_BIRD; // 14.12 lbs/bird
const WR_GROWER_CHART = [2.3048, 3.975, 5.9292, 8.1483, 10.58, 13.365]; // cumulative wks 3-8
const WR_GROWER_WEEKLY_CHART = WR_GROWER_CHART.map((c, i) => c - (i === 0 ? 1.1193 : WR_GROWER_CHART[i - 1]));
const WR_GROWER_CHART_TOTAL = WR_GROWER_WEEKLY_CHART.reduce((a, b) => a + b, 0);
const WR_GROWER_SCALE = WR_GROWER_TARGET / WR_GROWER_CHART_TOTAL;
const WR_GROWER_WEEKLY = WR_GROWER_WEEKLY_CHART.map((w) => w * WR_GROWER_SCALE);

export function getFeedSchedule(breed) {
  const growerWeeks = breed === 'WR' ? WR_GROWER_WEEKLY : CC_GROWER_WEEKLY;
  const weeks = [
    {week: 1, phase: 'starter', lbsPerBird: STARTER_W1},
    {week: 2, phase: 'starter', lbsPerBird: STARTER_W2},
    ...growerWeeks.map((lpb, i) => ({week: i + 3, phase: 'grower', lbsPerBird: lpb})),
  ];
  return weeks.map((w) => ({
    ...w,
    lbsPerBird: Math.round(w.lbsPerBird * 100) / 100,
    totalLbs: Math.round(w.lbsPerBird * FEED_BIRDS * 10) / 10,
  }));
}

export function calcBatchFeed(batch) {
  const schedule = getFeedSchedule(batch.breed);
  let starter = 0,
    grower = 0;
  schedule.forEach((w) => {
    if (w.phase === 'starter') starter += w.totalLbs;
    else grower += w.totalLbs;
  });
  return {schedule, starter: Math.round(starter), grower: Math.round(grower), total: Math.round(starter + grower)};
}

export const BREED_STYLE = {
  CC: {bg: '#E6F1FB', tx: '#185FA5'},
  WR: {bg: '#FAEEDA', tx: '#854F0B'},
  FR: {bg: '#F3E8FF', tx: '#6b21a8'}, // Freedom Rangers (legacy)
  CY: {bg: '#FFE4E6', tx: '#9f1239'}, // Color Yields (legacy)
};

export function calcTimeline(hatchDate, breed, processingDate) {
  if (!hatchDate) return null;
  const brooderIn = hatchDate;
  const brooderOut = toISO(addDays(hatchDate, BROODER_DAYS));
  const schoonerIn = brooderOut;
  const schoonerOut = processingDate
    ? toISO(addDays(processingDate, -1))
    : toISO(addDays(brooderOut, breed === 'WR' ? WR_SCHOONER : CC_SCHOONER));
  return {brooderIn, brooderOut, schoonerIn, schoonerOut};
}

function isISODateLike(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10));
}

export function shouldAutoActivateBroilerBatch(batch, asOfDate = todayISO()) {
  if (!batch || batch.status !== 'planned') return false;
  const hatchDate = String(batch.hatchDate || '').slice(0, 10);
  const today = String(asOfDate || todayISO()).slice(0, 10);
  if (!isISODateLike(hatchDate) || !isISODateLike(today)) return false;
  return today >= hatchDate;
}

// Auto-process an ACTIVE batch once its processing date arrives. "On the
// processing date" is inclusive (today >= processingDate). Mirrors the
// hatch-day auto-activation date style. Only active batches are eligible, so
// this never fights auto-activation (which acts on planned batches) and never
// overrides a manual/already-processed terminal status.
export function shouldAutoProcessBroilerBatch(batch, asOfDate = todayISO()) {
  if (!batch || batch.status !== 'active') return false;
  const processingDate = String(batch.processingDate || '').slice(0, 10);
  const today = String(asOfDate || todayISO()).slice(0, 10);
  if (!isISODateLike(processingDate) || !isISODateLike(today)) return false;
  return today >= processingDate;
}

export function calcPoultryStatus(batch, asOfDate = todayISO()) {
  // Manual terminal state wins. Planned is the one status that can age
  // forward automatically once hatch day arrives.
  if (batch && batch.status === 'processed') return 'processed';
  if (batch && batch.status === 'active') return 'active';
  if (!batch || !batch.hatchDate) return 'planned';
  const today = String(asOfDate || todayISO()).slice(0, 10);
  const tl = calcTimeline(batch.hatchDate, batch.breed, batch.processingDate);
  if (!tl) return 'planned';
  if (today < tl.brooderIn) return 'planned';
  if (!batch.status && batch.processingDate && today > batch.processingDate) return 'processed';
  return 'active';
}

// Live broiler stats computed from daily reports.
// For modern (non-B-24) batches this is the source of truth for feed/grit/mortality.
// For legacy B-24-* batches the stored fields on the batch are used (no daily reports exist).
// Returns: {starterFeed, growerFeed, gritLbs, mortality, projectedBirds, mortPct, dailyCount}
export function calcBroilerStatsFromDailys(batch, broilerDailys) {
  const isLegacy = /^b-24-/i.test(batch.name || '');
  const dayOneCount = parseInt(batch.birdCountActual) || 0;
  if (isLegacy) {
    const mort = parseInt(batch.mortalityCumulative) || 0;
    return {
      starterFeed: parseFloat(batch.brooderFeedLbs) || 0,
      growerFeed: parseFloat(batch.schoonerFeedLbs) || 0,
      gritLbs: parseFloat(batch.gritLbs) || 0,
      mortality: mort,
      projectedBirds: Math.max(0, dayOneCount - mort),
      mortPct: dayOneCount > 0 ? (mort / dayOneCount) * 100 : 0,
      dailyCount: 0,
      legacy: true,
    };
  }
  const target = String(batch.name || '')
    .toLowerCase()
    .trim();
  const bd = (broilerDailys || []).filter((d) => {
    const lbl = String(d.batch_label || '')
      .toLowerCase()
      .trim()
      .replace(/^\(processed\)\s*/, '')
      .trim();
    return lbl === target;
  });
  let starterFeed = 0,
    growerFeed = 0,
    gritLbs = 0,
    mortality = 0;
  for (const d of bd) {
    const f = parseFloat(d.feed_lbs) || 0;
    if (d.feed_type === 'STARTER') starterFeed += f;
    else if (d.feed_type === 'GROWER') growerFeed += f;
    gritLbs += parseFloat(d.grit_lbs) || 0;
    mortality += parseInt(d.mortality_count) || 0;
  }
  return {
    starterFeed: Math.round(starterFeed),
    growerFeed: Math.round(growerFeed),
    gritLbs: Math.round(gritLbs),
    mortality,
    projectedBirds: Math.max(0, dayOneCount - mortality),
    mortPct: dayOneCount > 0 ? (mortality / dayOneCount) * 100 : 0,
    dailyCount: bd.length,
    legacy: false,
  };
}

export function computeBroilerOnFarmCounts(batches, broilerDailys, asOfDate = todayISO()) {
  const activeBatches = (batches || []).filter((b) => calcPoultryStatus(b, asOfDate) === 'active');
  return activeBatches.reduce(
    (acc, batch) => {
      const started = parseInt(batch.birdCountActual, 10) || 0;
      const stats = calcBroilerStatsFromDailys(batch, broilerDailys);
      acc.startedBirds += started;
      acc.onFarmBirds += stats.projectedBirds;
      acc.mortality += stats.mortality;
      return acc;
    },
    {activeBatches, activeBatchCount: activeBatches.length, startedBirds: 0, onFarmBirds: 0, mortality: 0},
  );
}

// ============================================================================
// Timeline + batch-color deps (added in Round 6 timeline-view extraction)
// ----------------------------------------------------------------------------
// These started life as plain module-scope names in main.jsx. Moved here so
// the extracted timeline/list/feed views can import them without a circular
// dep on the entry module. breedLabel reads LEGACY_BREEDS (also lifted).
// ============================================================================
export const WEEKS_SHOWN = 52;

export const LEGACY_BREEDS = [
  {code: 'FR', label: 'Freedom Rangers'},
  {code: 'CY', label: 'Color Yields'},
];

export const RESOURCES = [
  {type: 'brooder', id: '1', label: 'Brooder 1'},
  {type: 'brooder', id: '2', label: 'Brooder 2'},
  {type: 'brooder', id: '3', label: 'Brooder 3'},
  {type: 'schooner', id: '1', label: 'Schooner 1'},
  {type: 'schooner', id: '2&3', label: 'Schooner 2 & 3'},
  {type: 'schooner', id: '4&5', label: 'Schooner 4 & 5'},
  {type: 'schooner', id: '6&6A', label: 'Schooner 6 & 6A'},
  {type: 'schooner', id: '7&7A', label: 'Schooner 7 & 7A'},
];

// ── Per-batch color system (hash of batch name) ────────────────────────────
// Each batch gets a unique color from this palette. Brooder and schooner phases
// of the same batch share the literally identical color. Used in timeline,
// list view, and feed calculator.
// Palette curated so adjacent indices are maximally distinct in hue.
// Used with sequential batch number index (B-26-09 → 9), so consecutive
// batches always land on adjacent palette positions.
const BATCH_COLOR_PALETTE = [
  {bg: '#dc2626', tx: 'white', bd: '#7f1d1d'}, // 0  red
  {bg: '#1e40af', tx: 'white', bd: '#0f2247'}, // 1  navy
  {bg: '#ea580c', tx: 'white', bd: '#7c2d12'}, // 2  orange
  {bg: '#7c3aed', tx: 'white', bd: '#4c1d95'}, // 3  purple
  {bg: '#16a34a', tx: 'white', bd: '#14532d'}, // 4  green
  {bg: '#db2777', tx: 'white', bd: '#831843'}, // 5  pink
  {bg: '#0891b2', tx: 'white', bd: '#164e63'}, // 6  cyan
  {bg: '#ca8a04', tx: 'white', bd: '#713f12'}, // 7  amber
  {bg: '#525b6e', tx: 'white', bd: '#1e293b'}, // 8  slate
  {bg: '#84cc16', tx: '#1a2e05', bd: '#365314'}, // 9  lime (light, dark text)
  {bg: '#9f1239', tx: 'white', bd: '#4c0519'}, // 10 wine
  {bg: '#0284c7', tx: 'white', bd: '#0c4a6e'}, // 11 sky
  {bg: '#a16207', tx: 'white', bd: '#451a03'}, // 12 brown
  {bg: '#c026d3', tx: 'white', bd: '#701a75'}, // 13 magenta
  {bg: '#0d9488', tx: 'white', bd: '#134e4a'}, // 14 teal
  {bg: '#f97316', tx: '#451a03', bd: '#7c2d12'}, // 15 bright orange (light, dark text)
  {bg: '#5b21b6', tx: 'white', bd: '#2e1065'}, // 16 indigo
  {bg: '#e11d48', tx: 'white', bd: '#881337'}, // 17 crimson
  {bg: '#365314', tx: 'white', bd: '#1a2e0a'}, // 18 forest
  {bg: '#67e8f9', tx: '#083344', bd: '#0e7490'}, // 19 light cyan (light, dark text)
  {bg: '#7e22ce', tx: 'white', bd: '#581c87'}, // 20 violet
  {bg: '#facc15', tx: '#451a03', bd: '#854d0e'}, // 21 yellow (light, dark text)
  {bg: '#1e3a8a', tx: 'white', bd: '#0a1429'}, // 22 deep blue
  {bg: '#be185d', tx: 'white', bd: '#500724'}, // 23 deep pink
];
export function getBatchColor(name) {
  if (!name) return BATCH_COLOR_PALETTE[0];
  // Try to extract a trailing number from the name (e.g. "B-26-09" → 9, "L-26-01" → 1).
  // This guarantees consecutive batches get adjacent (and visually distinct) palette colors.
  const m = String(name).match(/(\d+)\s*$/);
  if (m) {
    const n = parseInt(m[1]);
    if (!isNaN(n)) return BATCH_COLOR_PALETTE[n % BATCH_COLOR_PALETTE.length];
  }
  // Fallback for batches without a trailing number: hash
  let hash = 5381;
  const s = String(name).toLowerCase().trim();
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  return BATCH_COLOR_PALETTE[Math.abs(hash) % BATCH_COLOR_PALETTE.length];
}

export function breedLabel(code) {
  if (code === 'CC') return 'Cornish Cross';
  if (code === 'WR') return 'White Ranger';
  const lb = LEGACY_BREEDS.find((x) => x.code === code);
  if (lb) return lb.label;
  return code || '\u2014';
}

// ============================================================================
// Status badge colors + US-holiday-adjacent date warnings (list view deps)
// ----------------------------------------------------------------------------
// STATUS_STYLE is used by the broiler list view for the planned/active/
// processed pills. isNearHoliday flags hatch/processing dates that fall
// within 1 day of a US holiday (processors close, so scheduling gets sticky).
// ============================================================================
export const STATUS_STYLE = {
  planned: {bg: '#374151', tx: 'white'},
  active: {bg: '#085041', tx: 'white'},
  processed: {bg: '#4b5563', tx: 'white'},
};

function getEaster(y) {
  const a = y % 19,
    b = Math.floor(y / 100),
    c = y % 100,
    d = Math.floor(b / 4),
    e = b % 4;
  const f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451);
  return toISO(new Date(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1));
}
function getThanksgiving(y) {
  const d = new Date(y, 10, 1);
  return toISO(new Date(y, 10, ((4 - d.getDay() + 7) % 7) + 22));
}
function holidaysForYear(y) {
  return [`${y}-01-01`, getEaster(y), `${y}-07-04`, getThanksgiving(y), `${y}-12-25`];
}
export function isNearHoliday(iso) {
  if (!iso) return false;
  const d = new Date(iso + 'T12:00:00'),
    y = d.getFullYear();
  const all = [...holidaysForYear(y - 1), ...holidaysForYear(y), ...holidaysForYear(y + 1)];
  return all.some((h) => Math.abs(d - new Date(h + 'T12:00:00')) / 86400000 <= 1);
}

// ============================================================================
// Monthly feed projections (feed-view deps, lifted in Round 6)
// ----------------------------------------------------------------------------
// calcBatchFeedForMonth projects broiler feed for a calendar month using
// the same schedule as calcBatchFeed. calcLayerFeedForMonth does the same
// for layer batches — starter/grower phases drive off original_count, layer
// phase uses computeProjectedCount against the active housings.
// ============================================================================
// For monthly summary: given a batch and a calendar month (YYYY-MM),
// return {starter, grower} lbs consumed in that month
export function calcBatchFeedForMonth(batch, yearMonth) {
  if (!batch.hatchDate) return {starter: 0, grower: 0};
  const schedule = getFeedSchedule(batch.breed);
  const [y, m] = yearMonth.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0, 23, 59, 59);
  let starter = 0,
    grower = 0;
  schedule.forEach((w, i) => {
    const weekStart = addDays(batch.hatchDate, i * 7);
    const weekEnd = addDays(batch.hatchDate, (i + 1) * 7 - 1);
    // Check overlap with month
    if (weekStart <= monthEnd && weekEnd >= monthStart) {
      // Proportion of week that falls in this month
      const overlapStart = weekStart < monthStart ? monthStart : weekStart;
      const overlapEnd = weekEnd > monthEnd ? monthEnd : weekEnd;
      const overlapDays = (overlapEnd - overlapStart) / 86400000 + 1;
      const prop = overlapDays / 7;
      if (w.phase === 'starter') starter += w.totalLbs * prop;
      else grower += w.totalLbs * prop;
    }
  });
  return {starter: Math.round(starter), grower: Math.round(grower)};
}

// ── LAYER FEED SCHEDULE ──────────────────────────────────────────────────
// Weeks 1-6: starter, Weeks 7-20: grower, Week 21+: layer feed (0.25 lbs/bird/day)
// Starter capped at 1,500 lbs per batch (same as broilers).
export const LAYER_FEED_SCHEDULE = [
  {week: 1, phase: 'starter', lbsPerBird: 0.5},
  {week: 2, phase: 'starter', lbsPerBird: 1.0},
  {week: 3, phase: 'starter', lbsPerBird: 1.1},
  {week: 4, phase: 'starter', lbsPerBird: 1.2},
  {week: 5, phase: 'starter', lbsPerBird: 1.2},
  {week: 6, phase: 'starter', lbsPerBird: 1.0},
  {week: 7, phase: 'grower', lbsPerBird: 0.6},
  {week: 8, phase: 'grower', lbsPerBird: 0.65},
  {week: 9, phase: 'grower', lbsPerBird: 0.7},
  {week: 10, phase: 'grower', lbsPerBird: 0.75},
  {week: 11, phase: 'grower', lbsPerBird: 0.8},
  {week: 12, phase: 'grower', lbsPerBird: 0.8},
  {week: 13, phase: 'grower', lbsPerBird: 0.85},
  {week: 14, phase: 'grower', lbsPerBird: 0.85},
  {week: 15, phase: 'grower', lbsPerBird: 0.9},
  {week: 16, phase: 'grower', lbsPerBird: 0.9},
  {week: 17, phase: 'grower', lbsPerBird: 0.95},
  {week: 18, phase: 'grower', lbsPerBird: 0.95},
  {week: 19, phase: 'grower', lbsPerBird: 1.0},
  {week: 20, phase: 'grower', lbsPerBird: 1.0},
];
export const LAYER_FEED_PER_DAY = 0.25; // lbs/bird/day on layer feed (week 21+)

// For a layer batch + month, return {starter, grower, layer} lbs projected.
// Uses brooder_entry_date as day 0, original_count for starter/grower phases,
// computeProjectedCount for layer phase hen count.
export function calcLayerFeedForMonth(batch, housings, layerDailys, yearMonth) {
  const startDate = batch.brooder_entry_date || batch.arrival_date;
  if (!startDate) return {starter: 0, grower: 0, layer: 0};
  const birdCount = parseInt(batch.original_count) || 0;
  if (birdCount <= 0) return {starter: 0, grower: 0, layer: 0};
  const [y, m] = yearMonth.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0, 23, 59, 59);
  let starter = 0,
    grower = 0,
    layer = 0;
  // Weeks 1-20: starter/grower from schedule
  LAYER_FEED_SCHEDULE.forEach(function (w, i) {
    const weekStart = addDays(startDate, i * 7);
    const weekEnd = addDays(startDate, (i + 1) * 7 - 1);
    if (weekStart <= monthEnd && weekEnd >= monthStart) {
      const overlapStart = weekStart < monthStart ? monthStart : weekStart;
      const overlapEnd = weekEnd > monthEnd ? monthEnd : weekEnd;
      const overlapDays = (overlapEnd - overlapStart) / 86400000 + 1;
      const prop = overlapDays / 7;
      const lbs = w.lbsPerBird * birdCount * prop;
      if (w.phase === 'starter') starter += lbs;
      else grower += lbs;
    }
  });
  // Week 21+: layer feed at 0.25 lbs/bird/day using projected hen count
  var layerStart = addDays(startDate, 20 * 7); // day 140
  if (layerStart <= monthEnd) {
    var lStart = layerStart < monthStart ? monthStart : layerStart;
    var lEnd = monthEnd;
    var lDays = Math.max(0, (lEnd - lStart) / 86400000 + 1);
    if (lDays > 0) {
      // Use projected hen count from active housings for this batch
      var batchHousings = (housings || []).filter(function (h) {
        return h.batch_id === batch.id && h.status === 'active';
      });
      var hens = 0;
      if (batchHousings.length > 0) {
        batchHousings.forEach(function (h) {
          var proj = computeProjectedCount(h, layerDailys, housings);
          hens += proj ? proj.projected : parseInt(h.current_count) || 0;
        });
      } else {
        hens = birdCount; // fallback if no housings yet
      }
      layer += hens * LAYER_FEED_PER_DAY * lDays;
    }
  }
  return {starter: Math.round(starter), grower: Math.round(grower), layer: Math.round(layer)};
}

// Recompute the broiler session's average and write it to the matching
// batch's week4Lbs / week6Lbs in app_store.ppp-v4. ONLY runs for sessions
// already marked complete -- draft saves never bleed into the batch tile.
//
// Called from admin-only call sites (LivestockWeighInsView's
// completeFromAdmin, saveAdminGrid, and the metadata-edit week-change
// recompute). The public WeighInsWebform finalizeSession routes through
// the SECURITY DEFINER stamp_broiler_batch_avg RPC instead (mig 055),
// because anon RLS blocks direct app_store reads/writes.
//
// broiler_week is coerced via Number() so callers that pass a string
// (e.g. test fixtures, JSON-roundtripped sessions) still gate correctly.
export async function writeBroilerBatchAvg(sb, sessionRow, sessionEntries) {
  if (!sb || !sessionRow || sessionRow.species !== 'broiler') return {ok: true};
  if (sessionRow.status !== 'complete') return {ok: true};
  var weekNum = Number(sessionRow.broiler_week);
  if (!sessionRow.batch_id || (weekNum !== 4 && weekNum !== 6)) return {ok: true};
  if (!sessionEntries || sessionEntries.length === 0) return {ok: true};
  var avg = calcBroilerSessionAverageLbs(sessionEntries);
  if (avg == null) return {ok: true};
  var fieldKey = weekNum === 4 ? 'week4Lbs' : 'week6Lbs';
  var resp = await sb.from('app_store').select('data').eq('key', 'ppp-v4').maybeSingle();
  if (resp && resp.error) return {ok: false, message: 'ppp-v4 read failed: ' + resp.error.message};
  if (!resp || !resp.data || !Array.isArray(resp.data.data)) return {ok: true};
  var touched = false;
  var updated = resp.data.data.map(function (b) {
    if (b && b.name === sessionRow.batch_id) {
      touched = true;
      return Object.assign({}, b, {[fieldKey]: avg});
    }
    return b;
  });
  if (!touched) return {ok: true};
  var up = await sb
    .from('app_store')
    .upsert({key: 'ppp-v4', data: updated, updated_at: new Date().toISOString()}, {onConflict: 'key'});
  if (up && up.error) return {ok: false, message: 'ppp-v4 upsert failed: ' + up.error.message};
  return {ok: true};
}

export function calcBroilerSessionAverageLbs(sessionEntries) {
  if (!Array.isArray(sessionEntries) || sessionEntries.length === 0) return null;
  var sum = 0,
    n = 0;
  for (var i = 0; i < sessionEntries.length; i++) {
    var w = parseFloat(sessionEntries[i].weight);
    if (!isNaN(w) && w > 0) {
      sum += w;
      n++;
    }
  }
  if (n === 0) return null;
  return Math.round((sum / n) * 100) / 100;
}

async function loadLatestBroilerWeekAverage(sb, batchId, week, opts) {
  if (!sb || !batchId || (week !== 4 && week !== 6)) return {ok: true, averageLbs: null};
  const excludeSessionId = opts && opts.excludeSessionId ? opts.excludeSessionId : null;
  let q = sb
    .from('weigh_in_sessions')
    .select('id, completed_at')
    .eq('species', 'broiler')
    .eq('batch_id', batchId)
    .eq('broiler_week', week)
    .eq('status', 'complete');
  if (excludeSessionId) q = q.neq('id', excludeSessionId);
  const sR = await q.order('completed_at', {ascending: false}).limit(1);
  if (sR && sR.error) return {ok: false, message: 'sessions read failed: ' + sR.error.message};
  const list = (sR && sR.data) || [];
  if (list.length === 0) return {ok: true, averageLbs: null, sessionId: null};

  const latestId = list[0].id;
  const eR = await sb.from('weigh_ins').select('weight').eq('session_id', latestId);
  if (eR && eR.error) return {ok: false, message: 'entries read failed: ' + eR.error.message};
  return {
    ok: true,
    averageLbs: calcBroilerSessionAverageLbs((eR && eR.data) || []),
    sessionId: latestId,
  };
}

export async function loadBroilerBatchWeekAverages(sb, batchId) {
  if (!sb || !batchId) return {ok: true, week4Lbs: null, week6Lbs: null};
  const week4 = await loadLatestBroilerWeekAverage(sb, batchId, 4);
  if (!week4.ok) return {ok: false, message: week4.message, week4Lbs: null, week6Lbs: null};
  const week6 = await loadLatestBroilerWeekAverage(sb, batchId, 6);
  if (!week6.ok) return {ok: false, message: week6.message, week4Lbs: week4.averageLbs, week6Lbs: null};
  return {ok: true, week4Lbs: week4.averageLbs, week6Lbs: week6.averageLbs};
}

// Recompute the wk*Lbs field on app_store.ppp-v4[batch] for a given
// (batchId, week) pair, optionally excluding one session id from
// consideration. Used by the admin metadata-edit flow when a completed
// broiler session's broiler_week changes — the OLD week's stored avg
// must be re-derived from the latest OTHER complete session, or cleared
// if no other session backs that week.
//
// Result contract:
//   {ok: true}                — successful recompute, successful delete,
//                               OR intentional no-op (no usable entries
//                               on the picked session, batch row not
//                               found in ppp-v4, ppp-v4 row missing).
//   {ok: false, message: string}
//                              — Supabase read or upsert returned an
//                               error. Caller surfaces this to the
//                               admin via metaErr.
//
// Last-write-wins semantics preserved: when multiple complete sessions
// exist for (batchId, week), the latest by completed_at wins (matches
// today's writeBroilerBatchAvg behaviour where the most recent caller
// stamps its avg). No cross-session aggregation here.
export async function recomputeBroilerBatchWeekAvg(sb, batchId, week, opts) {
  if (!sb || !batchId || (week !== 4 && week !== 6)) return {ok: true};
  const excludeSessionId = opts && opts.excludeSessionId ? opts.excludeSessionId : null;
  const fieldKey = week === 4 ? 'week4Lbs' : 'week6Lbs';
  const latest = await loadLatestBroilerWeekAverage(sb, batchId, week, {excludeSessionId});
  if (!latest.ok) return {ok: false, message: latest.message};

  if (!latest.sessionId) {
    // No backing session — drop the wk*Lbs key from the batch entirely.
    return await applyPppV4Update(sb, batchId, (next) => {
      delete next[fieldKey];
      return next;
    });
  }

  if (latest.averageLbs == null) return {ok: true}; // intentional no-op — no usable entries
  return await applyPppV4Update(sb, batchId, (next) => Object.assign(next, {[fieldKey]: latest.averageLbs}));
}

// Internal: read ppp-v4, run `mutate` on the matching batch row, upsert.
// Returns the same {ok, message?} shape as recomputeBroilerBatchWeekAvg.
async function applyPppV4Update(sb, batchId, mutate) {
  const resp = await sb.from('app_store').select('data').eq('key', 'ppp-v4').maybeSingle();
  if (resp && resp.error) return {ok: false, message: 'ppp-v4 read failed: ' + resp.error.message};
  if (!resp || !resp.data || !Array.isArray(resp.data.data)) return {ok: true}; // ppp-v4 row absent — no-op
  let touched = false;
  const updated = resp.data.data.map((b) => {
    if (b && b.name === batchId) {
      touched = true;
      return mutate({...b});
    }
    return b;
  });
  if (!touched) return {ok: true}; // batch row not present — no-op
  const up = await sb
    .from('app_store')
    .upsert({key: 'ppp-v4', data: updated, updated_at: new Date().toISOString()}, {onConflict: 'key'});
  if (up && up.error) return {ok: false, message: 'ppp-v4 upsert failed: ' + up.error.message};
  return {ok: true};
}
