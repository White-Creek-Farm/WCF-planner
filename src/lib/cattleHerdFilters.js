// Cattle Herd filters + ordered sorts.
// Pure module — no React, no supabase, no Date mutation, no side effects.
// Single source of truth for filter + sort semantics.
//
// The plain-English "smart filter" assistant was removed (PROJECT.md
// Recommended Work Queue item 1 / item 2): it was not robust enough and a real
// AI-assisted filter/sort is queued separately. Organized filter groups in the
// UI replace it.

export const CATTLE_HERD_KEYS = Object.freeze(['mommas', 'backgrounders', 'finishers', 'bulls']);
export const CATTLE_OUTCOME_KEYS = Object.freeze(['processed', 'deceased', 'sold']);
export const CATTLE_ALL_HERD_KEYS = Object.freeze([...CATTLE_HERD_KEYS, ...CATTLE_OUTCOME_KEYS]);

export const STALE_WEIGHT_DAYS_DEFAULT = 90;

export const CATTLE_FILTER_DIMENSIONS = Object.freeze([
  'herdSet',
  'sex',
  'ageMonthsRange',
  'birthDateRange',
  'calvedStatus',
  'calvingWindow',
  'lastCalvedRange',
  'calfCountRange',
  'breedingBlacklist',
  'breedingStatus',
  'damPresence',
  'sirePresence',
  'weightTier',
  'weightRange',
  'breed',
  'origin',
  'wagyuPctRange',
  'nonCalvingCows',
  'nonCalvingCutoffDate',
  'unmatchedCalves',
  'accountingSnapshotMonth',
  'textSearch',
]);

export const CATTLE_SORT_KEYS = Object.freeze([
  'tag',
  'age',
  'lastWeight',
  'herd',
  'sex',
  'lastCalved',
  'calfCount',
  'nonCalving',
  'breed',
  'origin',
]);

const HERD_ORDER = ['mommas', 'backgrounders', 'finishers', 'bulls', 'processed', 'deceased', 'sold'];
const SEX_ORDER = ['cow', 'heifer', 'bull', 'steer'];

const DAY_MS = 86400000;

function isoDateFromMs(todayMs) {
  const d = new Date(todayMs ?? Date.now());
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function daysInUtcMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0, 12)).getUTCDate();
}

export function monthsAgoISO(todayMs, monthCount) {
  const d = new Date(todayMs ?? Date.now());
  if (Number.isNaN(d.getTime())) return null;
  const monthIndex = d.getUTCMonth() - monthCount;
  const firstOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), monthIndex, 1, 12));
  const day = Math.min(
    d.getUTCDate(),
    daysInUtcMonth(firstOfTargetMonth.getUTCFullYear(), firstOfTargetMonth.getUTCMonth()),
  );
  return new Date(Date.UTC(firstOfTargetMonth.getUTCFullYear(), firstOfTargetMonth.getUTCMonth(), day, 12))
    .toISOString()
    .slice(0, 10);
}

// ── helpers (hoisted from CattleHerdsView for testability) ────────────────────

export function ageDays(birthDate, todayMs) {
  if (!birthDate) return null;
  // Parse as UTC noon so test runs are timezone-independent and the result
  // is stable across hosts. The original CattleHerdsView age() used local
  // noon, which drifts by hours across host timezones.
  const ms = (todayMs ?? Date.now()) - new Date(birthDate + 'T12:00:00Z').getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.floor(ms / DAY_MS);
}

export function ageMonths(birthDate, todayMs) {
  const d = ageDays(birthDate, todayMs);
  if (d == null) return null;
  return Math.floor(d / 30);
}

export function cowTagSet(cow) {
  // Includes current WCF tag + prior weigh-in / manual tags. Excludes
  // 'import' (purchase tag from selling farm) which can collide with
  // unrelated WCF tag numbers.
  const set = new Set();
  if (cow && cow.tag) set.add(String(cow.tag));
  if (cow && Array.isArray(cow.old_tags)) {
    for (const ot of cow.old_tags) {
      if (!ot || !ot.tag) continue;
      if (ot.source === 'import') continue;
      set.add(String(ot.tag));
    }
  }
  return set;
}

export function lastWeightFor(cow, weighInsDescByEnteredAt) {
  // Caller passes weigh_ins already sorted entered_at desc (matches
  // loadCattleWeighInsCached's contract). First matching tag wins.
  const tags = cowTagSet(cow);
  if (tags.size === 0) return null;
  const list = weighInsDescByEnteredAt || [];
  const w = list.find((x) => tags.has(String(x.tag)));
  if (!w) return null;
  const v = parseFloat(w.weight);
  return Number.isFinite(v) ? v : null;
}

export function lastWeightEntryFor(cow, weighInsDescByEnteredAt) {
  // Returns the actual row (or null) so stale-weight detection has entered_at.
  const tags = cowTagSet(cow);
  if (tags.size === 0) return null;
  const list = weighInsDescByEnteredAt || [];
  return list.find((x) => tags.has(String(x.tag))) || null;
}

function normalizeTag(value) {
  return value == null ? '' : String(value).trim();
}

export function buildCalvingEvidence(cattle, calvingRecs) {
  const explicitRows = Array.isArray(calvingRecs) ? calvingRecs : [];
  const out = [...explicitRows];
  const recordedCalfTags = new Set(explicitRows.map((r) => normalizeTag(r && r.calf_tag)).filter(Boolean));

  for (const calf of cattle || []) {
    const damTag = normalizeTag(calf && calf.dam_tag);
    const calfTag = normalizeTag(calf && calf.tag);
    if (!damTag || !calfTag) continue;
    if (recordedCalfTags.has(calfTag)) continue;
    recordedCalfTags.add(calfTag);
    out.push({
      id: 'synthetic-calf-' + (calf.id || calfTag),
      synthetic: true,
      source: 'calf_record',
      dam_tag: damTag,
      calving_date: calf.birth_date || null,
      calf_tag: calfTag,
      total_born: 1,
      deaths: 0,
    });
  }

  return out;
}

export function calfCountFor(tag, calvingRecs) {
  // Codex 2026-04-29 contract: sum total_born; fall back to 1 per record when
  // total_born is null / 0 / non-numeric. Twins count as 2; never-tagged
  // stillbirths still count as 1.
  const damTag = normalizeTag(tag);
  if (!damTag) return 0;
  return (calvingRecs || [])
    .filter((r) => r && normalizeTag(r.dam_tag) === damTag)
    .reduce((sum, r) => {
      const tb = parseInt(r.total_born, 10);
      return sum + (Number.isFinite(tb) && tb > 0 ? tb : 1);
    }, 0);
}

export function lastCalvingRecordFor(tag, calvingRecs) {
  const damTag = normalizeTag(tag);
  if (!damTag) return null;
  let latest = null;
  for (const r of calvingRecs || []) {
    if (!r || normalizeTag(r.dam_tag) !== damTag) continue;
    if (!r.calving_date) continue;
    if (!latest || r.calving_date > latest.calving_date) latest = r;
  }
  return latest;
}

export function lastCalvedFor(tag, calvingRecs) {
  const rec = lastCalvingRecordFor(tag, calvingRecs);
  return rec ? rec.calving_date : null;
}

// Core non-calving predicate with a CONFIGURABLE last-calved cutoff. Matches a
// cow/heifer that is at least 30 months old AND whose last calving is missing
// OR strictly before `cutoffISO`. The maturity gate (cow/heifer, 30+ months)
// is the same across both the default and the configurable variant; only the
// "no calf since" date changes.
export function isNonCalvingCowSince(cow, calvingRecs, cutoffISO, todayMs) {
  if (!cow || (cow.sex !== 'cow' && cow.sex !== 'heifer')) return false;
  if (!cow.birth_date) return false;
  const matureCutoff = monthsAgoISO(todayMs, 30);
  if (!matureCutoff || cow.birth_date > matureCutoff) return false;
  if (!cutoffISO) return false;
  const lastCalved = lastCalvedFor(cow.tag, calvingRecs);
  return !lastCalved || lastCalved < cutoffISO;
}

// Backward-compatible default: cow/heifer, 30+ months old, no calving record in
// the last 9 months. `filters.nonCalvingCows === true` MUST keep meaning exactly
// this (PROJECT.md Cattle contract). Expressed via the configurable helper with
// the 9-months-ago cutoff so the two cannot drift.
export function isNonCalvingCow(cow, calvingRecs, todayMs) {
  return isNonCalvingCowSince(cow, calvingRecs, monthsAgoISO(todayMs, 9), todayMs);
}

// Resolve the effective "no calf since" cutoff from a filters object: the
// explicit nonCalvingCutoffDate wins; otherwise fall back to 9 months ago (the
// default contract). Used by both the predicate and the nonCalving sort key so
// filter and sort agree on what "non-calving" means.
export function nonCalvingCutoffFromFilters(filters, todayMs) {
  const explicit = filters && filters.nonCalvingCutoffDate;
  return explicit || monthsAgoISO(todayMs, 9);
}

export function isUnmatchedCalf(cow, todayMs) {
  if (!cow) return false;
  if (String(cow.dam_tag || '').trim()) return false;
  if (!cow.birth_date) return true;
  const youngCutoff = monthsAgoISO(todayMs, 9);
  const todayISO = isoDateFromMs(todayMs);
  return !!youngCutoff && !!todayISO && cow.birth_date >= youngCutoff && cow.birth_date <= todayISO;
}

// ── predicate factory ─────────────────────────────────────────────────────────

export function buildCattlePredicate(filters, ctx = {}) {
  const f = filters || {};
  const todayMs = ctx.todayMs ?? Date.now();
  const calvingRecs = ctx.calvingRecs || [];
  const weighIns = ctx.weighIns || [];
  const staleDays = ctx.staleDaysThreshold ?? STALE_WEIGHT_DAYS_DEFAULT;

  return (cow) => {
    if (!cow) return false;

    if (Array.isArray(f.herdSet) && f.herdSet.length > 0) {
      if (!f.herdSet.includes(cow.herd)) return false;
    }

    if (Array.isArray(f.sex) && f.sex.length > 0) {
      if (!f.sex.includes(cow.sex)) return false;
    }

    if (f.ageMonthsRange && (f.ageMonthsRange.min != null || f.ageMonthsRange.max != null)) {
      const m = ageMonths(cow.birth_date, todayMs);
      if (m == null) return false;
      if (f.ageMonthsRange.min != null && m < f.ageMonthsRange.min) return false;
      if (f.ageMonthsRange.max != null && m > f.ageMonthsRange.max) return false;
    }

    if (f.birthDateRange && (f.birthDateRange.after || f.birthDateRange.before)) {
      const b = cow.birth_date;
      if (!b) return false;
      if (f.birthDateRange.after && b < f.birthDateRange.after) return false;
      if (f.birthDateRange.before && b > f.birthDateRange.before) return false;
    }

    // Calving-family auto-restrict (Codex 2026-05-02 pre-commit review): when
    // any calving-family filter is active, the predicate REQUIRES cow.sex ∈
    // {cow, heifer}. Without this, a bull or steer with no calving rows
    // would match calvedStatus='no', calvingWindow.noneSince, and
    // calfCountRange max=0 — leaking non-females into "Never calved" /
    // "Not calved this year" results. The UI's "Applies to females only"
    // hint is now backed by the predicate.
    const hasCalvingFamilyFilter =
      f.calvedStatus === 'yes' ||
      f.calvedStatus === 'no' ||
      (f.calvingWindow && f.calvingWindow.mode === 'noneSince' && f.calvingWindow.since) ||
      (f.lastCalvedRange && (f.lastCalvedRange.after || f.lastCalvedRange.before)) ||
      (f.calfCountRange && (f.calfCountRange.min != null || f.calfCountRange.max != null));
    if (hasCalvingFamilyFilter && cow.sex !== 'cow' && cow.sex !== 'heifer') {
      return false;
    }

    if (f.calvedStatus === 'yes' || f.calvedStatus === 'no') {
      const lc = lastCalvedFor(cow.tag, calvingRecs);
      if (f.calvedStatus === 'yes' && !lc) return false;
      if (f.calvedStatus === 'no' && lc) return false;
    }

    // calvingWindow.noneSince(date): matches never-calved OR last_calved < since.
    // First-class predicate (Codex 2026-05-02 amendment) — do NOT collapse to
    // calvedStatus='no' AND lastCalvedRange.before, which would drop cows that
    // calved in prior years but not since `since`.
    if (f.calvingWindow && f.calvingWindow.mode === 'noneSince' && f.calvingWindow.since) {
      const lc = lastCalvedFor(cow.tag, calvingRecs);
      if (lc && lc >= f.calvingWindow.since) return false;
    }

    if (f.lastCalvedRange && (f.lastCalvedRange.after || f.lastCalvedRange.before)) {
      const lc = lastCalvedFor(cow.tag, calvingRecs);
      if (!lc) return false;
      if (f.lastCalvedRange.after && lc < f.lastCalvedRange.after) return false;
      if (f.lastCalvedRange.before && lc > f.lastCalvedRange.before) return false;
    }

    if (f.calfCountRange && (f.calfCountRange.min != null || f.calfCountRange.max != null)) {
      const cc = calfCountFor(cow.tag, calvingRecs);
      if (f.calfCountRange.min != null && cc < f.calfCountRange.min) return false;
      if (f.calfCountRange.max != null && cc > f.calfCountRange.max) return false;
    }

    if (f.breedingBlacklist === true && !cow.breeding_blacklist) return false;
    if (f.breedingBlacklist === false && !!cow.breeding_blacklist) return false;

    if (Array.isArray(f.breedingStatus) && f.breedingStatus.length > 0) {
      const bs = cow.breeding_status || null;
      const matches = f.breedingStatus.includes(bs) || (bs == null && f.breedingStatus.includes('unset'));
      if (!matches) return false;
    }

    // damPresence / sirePresence: 'any' | 'present' | 'missing' (any = no filter)
    if (f.damPresence === 'present' && !cow.dam_tag) return false;
    if (f.damPresence === 'missing' && !!cow.dam_tag) return false;
    if (f.sirePresence === 'present' && !cow.sire_tag) return false;
    if (f.sirePresence === 'missing' && !!cow.sire_tag) return false;

    // 4-state weight tier (Codex 2026-05-02 amendment):
    // hasWeight | noWeight | staleWeight | staleOrNoWeight
    if (f.weightTier) {
      const wEntry = lastWeightEntryFor(cow, weighIns);
      const v = wEntry ? parseFloat(wEntry.weight) : null;
      const has = !!(wEntry && Number.isFinite(v) && v > 0);
      const stale = has && wEntry.entered_at && todayMs - new Date(wEntry.entered_at).getTime() > staleDays * DAY_MS;
      if (f.weightTier === 'hasWeight' && !has) return false;
      if (f.weightTier === 'noWeight' && has) return false;
      if (f.weightTier === 'staleWeight' && !(has && stale)) return false;
      if (f.weightTier === 'staleOrNoWeight' && !(!has || stale)) return false;
    }

    if (f.weightRange && (f.weightRange.min != null || f.weightRange.max != null)) {
      const w = lastWeightFor(cow, weighIns);
      if (w == null) return false;
      if (f.weightRange.min != null && w < f.weightRange.min) return false;
      if (f.weightRange.max != null && w > f.weightRange.max) return false;
    }

    if (Array.isArray(f.breed) && f.breed.length > 0) {
      const cb = (cow.breed || '').toLowerCase();
      if (!f.breed.some((b) => (b || '').toLowerCase() === cb)) return false;
    }

    if (Array.isArray(f.origin) && f.origin.length > 0) {
      const co = (cow.origin || '').toLowerCase();
      if (!f.origin.some((o) => (o || '').toLowerCase() === co)) return false;
    }

    if (f.wagyuPctRange && (f.wagyuPctRange.min != null || f.wagyuPctRange.max != null)) {
      const w = cow.pct_wagyu;
      if (w == null) return false;
      if (f.wagyuPctRange.min != null && w < f.wagyuPctRange.min) return false;
      if (f.wagyuPctRange.max != null && w > f.wagyuPctRange.max) return false;
    }

    // Exception filters compose as OR with each other (and still AND with herd
    // / normal filters / search above). Non-calving is active when the boolean
    // toggle is on OR a "no calf since" cutoff date is set. When a cutoff date
    // is present it drives the semantics (last calved missing OR before the
    // cutoff); otherwise the boolean keeps its 9-month default contract.
    const nonCalvingActive = f.nonCalvingCows === true || !!f.nonCalvingCutoffDate;
    const hasExceptionFilter = nonCalvingActive || f.unmatchedCalves === true;
    if (hasExceptionFilter) {
      const matchesNonCalving =
        nonCalvingActive &&
        (f.nonCalvingCutoffDate
          ? isNonCalvingCowSince(cow, calvingRecs, f.nonCalvingCutoffDate, todayMs)
          : isNonCalvingCow(cow, calvingRecs, todayMs));
      const matchesUnmatchedCalf = f.unmatchedCalves === true && isUnmatchedCalf(cow, todayMs);
      if (!matchesNonCalving && !matchesUnmatchedCalf) return false;
    }

    if (typeof f.textSearch === 'string' && f.textSearch.trim()) {
      const s = f.textSearch.toLowerCase().trim();
      const tagFields = [...cowTagSet(cow)].map((t) => t.toLowerCase());
      const fields = [cow.dam_tag, cow.sire_tag, cow.breed, cow.origin].map((x) => (x || '').toLowerCase());
      const all = [...fields, ...tagFields];
      if (!all.some((x) => x.includes(s))) return false;
    }

    return true;
  };
}

// ── comparator factory ────────────────────────────────────────────────────────

export function buildCattleComparator(sortRules, ctx = {}) {
  const rules = (sortRules || []).filter((r) => r && r.key && CATTLE_SORT_KEYS.includes(r.key));
  const calvingRecs = ctx.calvingRecs || [];
  const weighIns = ctx.weighIns || [];
  const todayMs = ctx.todayMs ?? Date.now();
  // The nonCalving sort key ranks by the SAME cutoff the filter uses, so the
  // sort agrees with the active "no calf since" filter (or the 9-month default
  // when no cutoff is set).
  const nonCalvingCutoff = ctx.nonCalvingCutoffDate || monthsAgoISO(todayMs, 9);

  return (a, b) => {
    for (const r of rules) {
      const dir = r.dir === 'desc' ? 'desc' : 'asc';
      const cmp = compareByKey(r.key, a, b, dir, {calvingRecs, weighIns, todayMs, nonCalvingCutoff});
      if (cmp !== 0) return cmp;
    }
    return 0;
  };
}

function applyDir(cmp, dir) {
  return dir === 'desc' ? -cmp : cmp;
}

function compareByKey(key, a, b, dir, ctx) {
  switch (key) {
    case 'tag': {
      const aTag = (a.tag || '').trim();
      const bTag = (b.tag || '').trim();
      // Missing tags always sort to the end, regardless of dir.
      if (!aTag && !bTag) return 0;
      if (!aTag) return 1;
      if (!bTag) return -1;
      const an = parseFloat(aTag);
      const bn = parseFloat(bTag);
      let cmp;
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) cmp = an - bn;
      else cmp = aTag.localeCompare(bTag);
      return applyDir(cmp, dir);
    }
    case 'age': {
      // 'asc'  = youngest first  = newest birth_date first.
      // 'desc' = oldest first    = oldest birth_date first.
      // Missing birth_date sorts to the end regardless of direction.
      const ab = a.birth_date || null;
      const bb = b.birth_date || null;
      if (!ab && !bb) return 0;
      if (!ab) return 1;
      if (!bb) return -1;
      // Default cmp returns oldest-first (ab.localeCompare(bb)) for 'desc'.
      // For 'asc' (youngest first), invert.
      const cmp = ab.localeCompare(bb);
      return dir === 'asc' ? -cmp : cmp;
    }
    case 'lastWeight': {
      const aw = lastWeightFor(a, ctx.weighIns);
      const bw = lastWeightFor(b, ctx.weighIns);
      if (aw == null && bw == null) return 0;
      if (aw == null) return 1;
      if (bw == null) return -1;
      return applyDir(aw - bw, dir);
    }
    case 'herd': {
      const ai = HERD_ORDER.indexOf(a.herd);
      const bi = HERD_ORDER.indexOf(b.herd);
      const av = ai < 0 ? 999 : ai;
      const bv = bi < 0 ? 999 : bi;
      return applyDir(av - bv, dir);
    }
    case 'sex': {
      const ai = SEX_ORDER.indexOf(a.sex);
      const bi = SEX_ORDER.indexOf(b.sex);
      const av = ai < 0 ? 999 : ai;
      const bv = bi < 0 ? 999 : bi;
      return applyDir(av - bv, dir);
    }
    case 'lastCalved': {
      const al = lastCalvedFor(a.tag, ctx.calvingRecs);
      const bl = lastCalvedFor(b.tag, ctx.calvingRecs);
      if (!al && !bl) return 0;
      if (!al) return 1;
      if (!bl) return -1;
      return applyDir(al.localeCompare(bl), dir);
    }
    case 'calfCount': {
      const ac = calfCountFor(a.tag, ctx.calvingRecs);
      const bc = calfCountFor(b.tag, ctx.calvingRecs);
      return applyDir(ac - bc, dir);
    }
    case 'nonCalving': {
      // Rank non-calving candidates (1) vs the rest (0). asc = candidates last,
      // desc = candidates first. Uses the same cutoff the filter uses.
      const av = isNonCalvingCowSince(a, ctx.calvingRecs, ctx.nonCalvingCutoff, ctx.todayMs) ? 1 : 0;
      const bv = isNonCalvingCowSince(b, ctx.calvingRecs, ctx.nonCalvingCutoff, ctx.todayMs) ? 1 : 0;
      return applyDir(av - bv, dir);
    }
    case 'breed': {
      const av = (a.breed || '').toLowerCase();
      const bv = (b.breed || '').toLowerCase();
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return applyDir(av.localeCompare(bv), dir);
    }
    case 'origin': {
      const av = (a.origin || '').toLowerCase();
      const bv = (b.origin || '').toLowerCase();
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return applyDir(av.localeCompare(bv), dir);
    }
    default:
      return 0;
  }
}

// ── breed/origin option helpers ───────────────────────────────────────────────

export function mergeObservedValues(activeOptions, observedFromCattle) {
  // Filter dropdown for breed/origin = active option rows ∪ distinct non-empty
  // values present on cattle records (Codex 2026-05-02 amendment + pre-commit
  // review). Skip option rows with active === false in the first pass so
  // inactive-and-unobserved labels do NOT appear; an inactive label STILL
  // surfaces if it shows up in observedFromCattle (historical cow data).
  const seen = new Set();
  const out = [];
  for (const opt of activeOptions || []) {
    if (!opt || !opt.label) continue;
    if (opt.active === false) continue;
    const k = opt.label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({label: opt.label, source: 'active'});
  }
  for (const v of observedFromCattle || []) {
    if (!v) continue;
    const k = String(v).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({label: v, source: 'historical'});
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
