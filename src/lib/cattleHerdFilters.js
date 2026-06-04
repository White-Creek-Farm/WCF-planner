// Cattle Herd filters + ordered sorts + local smart-filter assistant.
// Pure module — no React, no supabase, no Date mutation, no side effects.
// Single source of truth for filter semantics + smart-assistant vocabulary.

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
  'unmatchedCalves',
  'textSearch',
]);

export const CATTLE_QUICK_FILTERS = Object.freeze([
  'herdSet',
  'sex',
  'ageMonthsRange',
  'calvedStatus',
  'breedingBlacklist',
  'weightTier',
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
  'breed',
  'origin',
]);

const HERD_ORDER = ['mommas', 'backgrounders', 'finishers', 'bulls', 'processed', 'deceased', 'sold'];
const SEX_ORDER = ['cow', 'heifer', 'bull', 'steer'];

// Vocabulary for the local smart-filter assistant. Aligns parser <-> chip controls
// in one source so UI changes can never drift the parser. Entries are matched
// longest-first within each dimension to avoid eating shorter tokens.
export const CATTLE_FILTER_VOCAB = Object.freeze({
  herd: {
    mommas: ['mommas', 'momma'],
    backgrounders: ['backgrounders', 'backgrounder', 'bg herd', 'bg group'],
    finishers: ['finishers', 'finisher', 'finishrs', 'fin herd'],
    bulls: ['bulls herd', 'bulls group'],
    processed: ['processed'],
    deceased: ['deceased', 'dead'],
    sold: ['sold'],
  },
  sex: {
    // bare 'cow'/'cows'/'bull'/'bulls' map to SEX (not herd) per Codex/CC plan;
    // herd terms use distinct vocabulary above.
    cow: ['cows', 'cow'],
    heifer: ['heifers', 'heffers', 'hefers', 'heifer', 'heffer', 'hefer'],
    bull: ['bulls', 'bull'],
    steer: ['steers', 'steer'],
  },
  ageOps: {
    gte: ['older than', 'older then', 'at least', '>='],
    lte: ['younger than', 'younger then', 'under', '<='],
  },
  calvedYes: ['has calved', 'have calved', 'calved'],
  calvedNo: ["haven't calved", 'havent calved', 'havnt calved', 'never calved', 'not calved', "hasn't calved"],
  calvingNoneSinceThisYear: [
    'havent calved this year',
    "haven't calved this year",
    "havn't calved this year",
    'havent calvd this year',
    "haven't calvd this year",
    'no calving this year',
    'not calved this year',
    'havnt calved this year',
  ],
  weight: {
    hasWeight: ['has weight', 'weighed'],
    noWeight: ['no weigh-in', 'no weigh in', 'no weight', 'never weighed'],
    staleWeight: ['stale weight', 'stale wait', 'old weight', 'outdated weight'],
    staleOrNoWeight: ['no recent weight', 'stale or no weight', 'no recent weigh-in', 'no recent weigh in'],
  },
  blacklist: ['blacklisted', 'blacklist', 'black list'],
  lineage: {
    bothKnown: ['known parents', 'full lineage', 'both parents known'],
    neitherKnown: ['unknown lineage', 'no parents', 'orphan'],
    hasDam: ['has dam', 'dam known', 'with dam'],
    missingDam: ['no dam', 'missing dam'],
    hasSire: ['has sire', 'sire known'],
    missingSire: ['no sire', 'missing sire'],
  },
  sortPhrases: {
    age: {
      asc: ['youngest first'],
      desc: ['oldest first'],
    },
    lastWeight: {
      desc: ['heaviest first'],
      asc: ['lightest first'],
    },
    tag: {
      asc: ['sort by tag', 'by tag'],
    },
    lastCalved: {
      desc: ['most recent calving first', 'newest calving first'],
      asc: ['oldest calving first'],
    },
    calfCount: {
      desc: ['most calves first'],
      asc: ['fewest calves first'],
    },
  },
});

const STOPWORDS = new Set(['a', 'an', 'the', 'in', 'and', 'or', 'with', 'are', 'is', 'that', 'on', 'of']);

// Sort triggers — adjective phrases plus an optional anchor word that must
// appear within 40 characters AFTER the adjective. Most specific entries come
// first so e.g. "oldest calving first" matches lastCalved before age.
const SORT_TRIGGERS = Object.freeze([
  {key: 'lastCalved', dir: 'desc', adjs: ['most recent', 'newest'], anchor: 'calving'},
  {key: 'lastCalved', dir: 'asc', adjs: ['oldest'], anchor: 'calving'},
  {key: 'calfCount', dir: 'desc', adjs: ['most calves'], anchor: 'first'},
  {key: 'calfCount', dir: 'asc', adjs: ['fewest calves'], anchor: 'first'},
  {key: 'lastWeight', dir: 'desc', adjs: ['heaviest'], anchor: 'first'},
  {key: 'lastWeight', dir: 'asc', adjs: ['lightest'], anchor: 'first'},
  {key: 'age', dir: 'desc', adjs: ['oldest'], anchor: 'first'},
  {key: 'age', dir: 'asc', adjs: ['youngest'], anchor: 'first'},
  {key: 'tag', dir: 'asc', adjs: ['sort by tag', 'by tag'], anchor: null},
]);

function findPhraseUnconsumed(text, phrase, consumed) {
  let cursor = 0;
  while (cursor < text.length) {
    const re = new RegExp('(^|[^a-z0-9])' + escapeRegex(phrase) + '($|[^a-z0-9])', 'i');
    const slice = text.slice(cursor);
    const m = re.exec(slice);
    if (!m) return -1;
    const idx = cursor + m.index + m[1].length;
    if (!isOverlap(consumed, idx, idx + phrase.length)) return idx;
    cursor = idx + phrase.length;
  }
  return -1;
}

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

export function calfCountFor(tag, calvingRecs) {
  // Codex 2026-04-29 contract: sum total_born; fall back to 1 per record when
  // total_born is null / 0 / non-numeric. Twins count as 2; never-tagged
  // stillbirths still count as 1.
  if (!tag) return 0;
  return (calvingRecs || [])
    .filter((r) => r && r.dam_tag === tag)
    .reduce((sum, r) => {
      const tb = parseInt(r.total_born, 10);
      return sum + (Number.isFinite(tb) && tb > 0 ? tb : 1);
    }, 0);
}

export function lastCalvedFor(tag, calvingRecs) {
  if (!tag) return null;
  let max = null;
  for (const r of calvingRecs || []) {
    if (!r || r.dam_tag !== tag) continue;
    if (!r.calving_date) continue;
    if (!max || r.calving_date > max) max = r.calving_date;
  }
  return max;
}

export function isNonCalvingCow(cow, calvingRecs, todayMs) {
  if (!cow || (cow.sex !== 'cow' && cow.sex !== 'heifer')) return false;
  if (!cow.birth_date) return false;
  const matureCutoff = monthsAgoISO(todayMs, 30);
  if (!matureCutoff || cow.birth_date > matureCutoff) return false;
  const recentCalvingCutoff = monthsAgoISO(todayMs, 9);
  const lastCalved = lastCalvedFor(cow.tag, calvingRecs);
  return !lastCalved || lastCalved < recentCalvingCutoff;
}

export function isUnmatchedCalf(cow, todayMs) {
  if (!cow) return false;
  if (String(cow.dam_tag || '').trim()) return false;
  if (!cow.birth_date) return true;
  const youngCutoff = monthsAgoISO(todayMs, 4);
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

    const hasExceptionFilter = f.nonCalvingCows === true || f.unmatchedCalves === true;
    if (hasExceptionFilter) {
      const matchesNonCalving = f.nonCalvingCows === true && isNonCalvingCow(cow, calvingRecs, todayMs);
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

  return (a, b) => {
    for (const r of rules) {
      const dir = r.dir === 'desc' ? 'desc' : 'asc';
      const cmp = compareByKey(r.key, a, b, dir, {calvingRecs, weighIns});
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

// ── smart-filter assistant (deterministic, local — no LLM, no network) ─────────

// Returns a proposal: { chips, sortRules, unmapped, confidence, notes }.
// chips    — partial filter object the UI can merge into state on Apply.
// sortRules — array of {key, dir} to merge (replace) into the sort list.
// unmapped — array of substrings the parser couldn't place; surfaced in preview.
// confidence — 'high' | 'medium' | 'low'.
// notes    — optional human-readable annotations for the preview banner.
export function parseSmartFilter(rawText, ctx = {}) {
  const empty = {chips: {}, sortRules: [], unmapped: [], confidence: 'low', notes: []};
  if (!rawText || typeof rawText !== 'string') return empty;
  const text = rawText.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return empty;

  const consumed = []; // [start, end) ranges (exclusive end), in `text` index space
  const chips = {};
  const sortRules = [];
  const notes = [];

  function markConsumed(start, end) {
    consumed.push([start, end]);
  }
  function findPhrase(phrase) {
    // Word-boundary-aware scan. Returns first match index or -1.
    const re = new RegExp('(^|[^a-z0-9])' + escapeRegex(phrase) + '($|[^a-z0-9])', 'i');
    const m = re.exec(text);
    if (!m) return -1;
    return m.index + m[1].length;
  }
  function takePhrase(phrase) {
    const idx = findPhrase(phrase);
    if (idx < 0) return false;
    if (isOverlap(consumed, idx, idx + phrase.length)) return false;
    markConsumed(idx, idx + phrase.length);
    return true;
  }

  // 1) calving "noneSince" multi-word phrases — match BEFORE plain calved/no.
  for (const phrase of sortByLengthDesc(CATTLE_FILTER_VOCAB.calvingNoneSinceThisYear)) {
    if (takePhrase(phrase)) {
      const yr = thisYearFromCtx(ctx);
      chips.calvingWindow = {mode: 'noneSince', since: `${yr}-01-01`};
      notes.push(`"this year" → no calving since ${yr}-01-01`);
      break;
    }
  }

  // 2) sort phrases — explicit only (Codex amendment 5).
  // Adjective + anchor pattern lets "oldest heifers first" parse the same as
  // "oldest first" — only "oldest" and "first" are consumed; the middle word
  // (e.g. "heifers") falls through to the sex parser. Most-specific triggers
  // first so "oldest calving first" doesn't get grabbed by the bare-age
  // "oldest first" trigger.
  for (const trigger of SORT_TRIGGERS) {
    let matched = false;
    for (const adjPhrase of trigger.adjs) {
      if (matched) break;
      const adjIdx = findPhraseUnconsumed(text, adjPhrase, consumed);
      if (adjIdx < 0) continue;
      if (trigger.anchor === null) {
        // Standalone phrase like "sort by tag" — no anchor required.
        if (!sortRules.find((r) => r.key === trigger.key)) {
          sortRules.push({key: trigger.key, dir: trigger.dir});
        }
        markConsumed(adjIdx, adjIdx + adjPhrase.length);
        matched = true;
        break;
      }
      // Anchor must appear AFTER the adjective, within 40 chars.
      const afterIdx = adjIdx + adjPhrase.length;
      const tail = text.slice(afterIdx, afterIdx + 50);
      const anchorRe = new RegExp('(^|[^a-z0-9])' + escapeRegex(trigger.anchor) + '($|[^a-z0-9])', 'i');
      const am = anchorRe.exec(tail);
      if (!am) continue;
      const anchorOffsetInTail = am.index + am[1].length;
      const anchorAbs = afterIdx + anchorOffsetInTail;
      if (isOverlap(consumed, anchorAbs, anchorAbs + trigger.anchor.length)) continue;
      if (!sortRules.find((r) => r.key === trigger.key)) {
        sortRules.push({key: trigger.key, dir: trigger.dir});
      }
      markConsumed(adjIdx, adjIdx + adjPhrase.length);
      markConsumed(anchorAbs, anchorAbs + trigger.anchor.length);
      matched = true;
    }
  }

  // 3) age comparator + numeric. Look for `<op> N (months|years|mo|yr|y)`.
  // Iterate through input scanning for ageOps phrases; for each match, find the
  // nearest numeric+unit AFTER the op and within ~20 chars.
  for (const [opKind, phrases] of Object.entries(CATTLE_FILTER_VOCAB.ageOps)) {
    for (const phrase of sortByLengthDesc(phrases)) {
      const idx = findPhrase(phrase);
      if (idx < 0) continue;
      if (isOverlap(consumed, idx, idx + phrase.length)) continue;
      // Search after the op for a numeric+unit.
      const tail = text.slice(idx + phrase.length, idx + phrase.length + 30);
      const numRe = /\b(\d+)\s*(months?|mos?|years?|yrs?|y\b)/i;
      const m = numRe.exec(tail);
      if (!m) continue;
      let n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      if (unit.startsWith('y')) n = n * 12; // years → months
      const consumeStart = idx;
      const consumeEnd = idx + phrase.length + (m.index + m[0].length);
      markConsumed(consumeStart, consumeEnd);
      chips.ageMonthsRange = chips.ageMonthsRange || {};
      if (opKind === 'gte') chips.ageMonthsRange.min = n;
      else if (opKind === 'lte') chips.ageMonthsRange.max = n;
    }
  }

  // 4) sex.
  for (const [sex, phrases] of Object.entries(CATTLE_FILTER_VOCAB.sex)) {
    for (const phrase of sortByLengthDesc(phrases)) {
      if (takePhrase(phrase)) {
        chips.sex = chips.sex || [];
        if (!chips.sex.includes(sex)) chips.sex.push(sex);
        break;
      }
    }
  }

  // 5) herd (explicit herd terms only — bare 'cow'/'bull' belong to sex).
  for (const [herd, phrases] of Object.entries(CATTLE_FILTER_VOCAB.herd)) {
    for (const phrase of sortByLengthDesc(phrases)) {
      if (takePhrase(phrase)) {
        chips.herdSet = chips.herdSet || [];
        if (!chips.herdSet.includes(herd)) chips.herdSet.push(herd);
        break;
      }
    }
  }

  // 6) calved yes/no — match calvedNo phrases first to avoid 'calved' eating
  //    'never calved'.
  for (const phrase of sortByLengthDesc(CATTLE_FILTER_VOCAB.calvedNo)) {
    if (takePhrase(phrase)) {
      // Don't override calvingWindow.noneSince if already set.
      if (!chips.calvingWindow) chips.calvedStatus = 'no';
      break;
    }
  }
  if (!chips.calvedStatus && !chips.calvingWindow) {
    for (const phrase of sortByLengthDesc(CATTLE_FILTER_VOCAB.calvedYes)) {
      if (takePhrase(phrase)) {
        chips.calvedStatus = 'yes';
        break;
      }
    }
  }

  // 7) weight tier — most specific phrases first.
  const weightOrder = ['staleOrNoWeight', 'staleWeight', 'noWeight', 'hasWeight'];
  for (const tier of weightOrder) {
    for (const phrase of sortByLengthDesc(CATTLE_FILTER_VOCAB.weight[tier])) {
      if (takePhrase(phrase)) {
        chips.weightTier = tier;
        break;
      }
    }
    if (chips.weightTier) break;
  }

  // 8) lineage — multi-word first.
  const lineageOrder = ['bothKnown', 'neitherKnown', 'hasDam', 'missingDam', 'hasSire', 'missingSire'];
  for (const code of lineageOrder) {
    for (const phrase of sortByLengthDesc(CATTLE_FILTER_VOCAB.lineage[code])) {
      if (takePhrase(phrase)) {
        applyLineage(chips, code);
        break;
      }
    }
  }

  // 9) blacklist.
  for (const phrase of sortByLengthDesc(CATTLE_FILTER_VOCAB.blacklist)) {
    if (takePhrase(phrase)) {
      chips.breedingBlacklist = true;
      break;
    }
  }

  // 10) breed (active + observed + fuzzy edit-1 on standalone tokens).
  if (Array.isArray(ctx.breedOptions) && ctx.breedOptions.length > 0) {
    const matched = matchOptionWithFuzzy(text, consumed, ctx.breedOptions);
    if (matched.label) {
      chips.breed = chips.breed || [];
      if (!chips.breed.includes(matched.label)) chips.breed.push(matched.label);
      if (matched.fuzzy) notes.push(`"${matched.token}" mapped to "${matched.label}"`);
      markConsumed(matched.start, matched.end);
    }
  }
  // 11) origin — same fuzzy machinery.
  if (Array.isArray(ctx.originOptions) && ctx.originOptions.length > 0) {
    const matched = matchOptionWithFuzzy(text, consumed, ctx.originOptions);
    if (matched.label) {
      chips.origin = chips.origin || [];
      if (!chips.origin.includes(matched.label)) chips.origin.push(matched.label);
      if (matched.fuzzy) notes.push(`"${matched.token}" mapped to "${matched.label}"`);
      markConsumed(matched.start, matched.end);
    }
  }

  // ── unmapped tokens ─────────────────────────────────────────────────────────
  const unmapped = collectUnmapped(text, consumed);

  // ── contradiction detection ─────────────────────────────────────────────────
  let contradictory = false;
  if (
    chips.ageMonthsRange &&
    chips.ageMonthsRange.min != null &&
    chips.ageMonthsRange.max != null &&
    chips.ageMonthsRange.min > chips.ageMonthsRange.max
  ) {
    contradictory = true;
  }

  // ── confidence ──────────────────────────────────────────────────────────────
  const chipCount = countChips(chips) + sortRules.length;
  let confidence;
  if (contradictory || chipCount === 0) {
    confidence = 'low';
  } else if (unmapped.length === 0 && notes.length === 0) {
    confidence = 'high';
  } else {
    confidence = 'medium';
  }

  if (contradictory) {
    return {chips: {}, sortRules: [], unmapped, confidence: 'low', notes: ['contradictory range']};
  }

  return {chips, sortRules, unmapped, confidence, notes};
}

function applyLineage(chips, code) {
  const map = {
    bothKnown: {damPresence: 'present', sirePresence: 'present'},
    neitherKnown: {damPresence: 'missing', sirePresence: 'missing'},
    hasDam: {damPresence: 'present'},
    missingDam: {damPresence: 'missing'},
    hasSire: {sirePresence: 'present'},
    missingSire: {sirePresence: 'missing'},
  };
  const apply = map[code] || {};
  for (const [k, v] of Object.entries(apply)) {
    // Don't clobber an already-set sub-chip (e.g. bothKnown then missingSire
    // shouldn't downgrade — though parsing order makes that unlikely).
    if (!(k in chips)) chips[k] = v;
  }
}

function thisYearFromCtx(ctx) {
  const ms = ctx.todayMs ?? Date.now();
  return new Date(ms).getUTCFullYear();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sortByLengthDesc(list) {
  return [...list].sort((a, b) => b.length - a.length);
}

function isOverlap(consumed, start, end) {
  for (const [s, e] of consumed) {
    if (start < e && end > s) return true;
  }
  return false;
}

function collectUnmapped(text, consumed) {
  // Sort consumed ranges and walk gaps.
  const ranges = [...consumed].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of ranges) {
    if (merged.length === 0 || s > merged[merged.length - 1][1]) merged.push([s, e]);
    else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
  }
  const gaps = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push(text.slice(cursor, s));
    cursor = e;
  }
  if (cursor < text.length) gaps.push(text.slice(cursor));
  const tokens = [];
  for (const gap of gaps) {
    for (const t of gap.split(/[^a-z0-9]+/i)) {
      const tok = t.trim().toLowerCase();
      if (!tok) continue;
      if (STOPWORDS.has(tok)) continue;
      if (/^\d+$/.test(tok)) continue; // bare numbers without an op are noise
      tokens.push(tok);
    }
  }
  return tokens;
}

function countChips(chips) {
  let n = 0;
  for (const k of Object.keys(chips)) {
    const v = chips[k];
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    n += 1;
  }
  return n;
}

function matchOptionWithFuzzy(text, consumed, options) {
  // First pass: exact label match (whole-word). Second pass: edit-1 against
  // standalone unconsumed tokens of length >= 4 — emits 'fuzzy:true' note.
  const labels = (options || []).map((o) => o && o.label).filter(Boolean);
  for (const label of sortByLengthDesc(labels)) {
    const idx = findWord(text, label.toLowerCase());
    if (idx < 0) continue;
    if (isOverlap(consumed, idx, idx + label.length)) continue;
    return {label, token: label, start: idx, end: idx + label.length, fuzzy: false};
  }
  // Fuzzy: only single-token unconsumed chunks of len >= 4 with a UNIQUE edit-1 neighbor.
  const unmappedTokens = collectUnmappedWithSpans(text, consumed);
  for (const {token, start} of unmappedTokens) {
    if (token.length < 4) continue;
    const neighbors = labels.filter((l) => editDistanceLeqOne(token, l.toLowerCase()));
    if (neighbors.length === 1) {
      return {label: neighbors[0], token, start, end: start + token.length, fuzzy: true};
    }
  }
  return {label: null};
}

function findWord(text, phrase) {
  const re = new RegExp('(^|[^a-z0-9])' + escapeRegex(phrase) + '($|[^a-z0-9])', 'i');
  const m = re.exec(text);
  if (!m) return -1;
  return m.index + m[1].length;
}

function collectUnmappedWithSpans(text, consumed) {
  const ranges = [...consumed].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of ranges) {
    if (merged.length === 0 || s > merged[merged.length - 1][1]) merged.push([s, e]);
    else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
  }
  const result = [];
  let cursor = 0;
  const handleGap = (start, end) => {
    const gap = text.slice(start, end);
    let i = 0;
    while (i < gap.length) {
      // skip non-word
      while (i < gap.length && !/[a-z0-9]/i.test(gap[i])) i += 1;
      const tokStart = start + i;
      let j = i;
      while (j < gap.length && /[a-z0-9]/i.test(gap[j])) j += 1;
      if (j > i) {
        const tok = gap.slice(i, j).toLowerCase();
        if (!STOPWORDS.has(tok) && !/^\d+$/.test(tok)) result.push({token: tok, start: tokStart});
      }
      i = j;
    }
  };
  for (const [s, e] of merged) {
    if (s > cursor) handleGap(cursor, s);
    cursor = e;
  }
  if (cursor < text.length) handleGap(cursor, text.length);
  return result;
}

function editDistanceLeqOne(a, b) {
  if (a === b) return false; // we want fuzzy-only (exact handled separately)
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 1) return false;
  // Two-pointer single-edit check.
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (m === n) {
      i += 1;
      j += 1;
    } else if (m < n) {
      j += 1;
    } else {
      i += 1;
    }
  }
  if (i < m || j < n) edits += m - i + (n - j);
  return edits <= 1;
}
