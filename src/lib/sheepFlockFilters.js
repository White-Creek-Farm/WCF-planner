// Sheep Flocks filters + ordered sorts.
// Pure module: no React, no Supabase, no browser state. SheepFlocksView owns
// rendering; this file owns deterministic filter/sort behavior.

export const SHEEP_FLOCK_KEYS = Object.freeze(['rams', 'ewes', 'feeders']);
export const SHEEP_OUTCOME_KEYS = Object.freeze(['processed', 'deceased', 'sold']);
export const SHEEP_ALL_FLOCK_KEYS = Object.freeze([...SHEEP_FLOCK_KEYS, ...SHEEP_OUTCOME_KEYS]);

export const STALE_SHEEP_WEIGHT_DAYS_DEFAULT = 90;

export const SHEEP_FILTER_DIMENSIONS = Object.freeze([
  'flockSet',
  'sex',
  'ageMonthsRange',
  'birthDateRange',
  'lambedStatus',
  'lastLambedRange',
  'lambCountRange',
  'breedingBlacklist',
  'breedingStatus',
  'maternalIssue',
  'damPresence',
  'sirePresence',
  'weightTier',
  'weightRange',
  'breed',
  'origin',
  'accountingSnapshotMonth',
  'textSearch',
]);

export const SHEEP_SORT_KEYS = Object.freeze([
  'tag',
  'age',
  'lastWeight',
  'flock',
  'sex',
  'lastLambed',
  'lambCount',
  'breed',
  'origin',
  'breedingStatus',
]);

const FLOCK_ORDER = ['rams', 'ewes', 'feeders', 'processed', 'deceased', 'sold'];
const SEX_ORDER = ['ewe', 'ram', 'wether', 'lamb'];
const DAY_MS = 86400000;

export function ageDays(birthDate, todayMs) {
  if (!birthDate) return null;
  const ms = (todayMs ?? Date.now()) - new Date(birthDate + 'T12:00:00Z').getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.floor(ms / DAY_MS);
}

export function ageMonths(birthDate, todayMs) {
  const days = ageDays(birthDate, todayMs);
  if (days == null) return null;
  return Math.floor(days / 30);
}

function normalizeTag(value) {
  return value == null ? '' : String(value).trim();
}

export function sheepTagSet(sheep) {
  const set = new Set();
  if (sheep && sheep.tag) set.add(String(sheep.tag));
  if (sheep && Array.isArray(sheep.old_tags)) {
    for (const oldTag of sheep.old_tags) {
      if (!oldTag || !oldTag.tag) continue;
      if (oldTag.source === 'import') continue;
      set.add(String(oldTag.tag));
    }
  }
  return set;
}

export function lastWeightFor(sheep, weighInsDescByEnteredAt) {
  const tags = sheepTagSet(sheep);
  if (tags.size === 0) return null;
  const row = (weighInsDescByEnteredAt || []).find((x) => tags.has(String(x.tag)));
  if (!row) return null;
  const value = parseFloat(row.weight);
  return Number.isFinite(value) ? value : null;
}

export function lastWeightEntryFor(sheep, weighInsDescByEnteredAt) {
  const tags = sheepTagSet(sheep);
  if (tags.size === 0) return null;
  return (weighInsDescByEnteredAt || []).find((x) => tags.has(String(x.tag))) || null;
}

export function buildLambingEvidence(sheepRows, lambingRows) {
  const explicitRows = Array.isArray(lambingRows) ? lambingRows : [];
  const out = [...explicitRows];
  const recordedLambIds = new Set(explicitRows.map((r) => normalizeTag(r && r.lamb_id)).filter(Boolean));
  const recordedLambTags = new Set(explicitRows.map((r) => normalizeTag(r && r.lamb_tag)).filter(Boolean));

  for (const lamb of sheepRows || []) {
    const damTag = normalizeTag(lamb && lamb.dam_tag);
    const lambTag = normalizeTag(lamb && lamb.tag);
    if (!damTag || !lambTag) continue;
    if ((lamb.id && recordedLambIds.has(String(lamb.id))) || recordedLambTags.has(lambTag)) continue;
    recordedLambTags.add(lambTag);
    out.push({
      id: 'synthetic-lamb-' + (lamb.id || lambTag),
      synthetic: true,
      source: 'lamb_record',
      dam_tag: damTag,
      lamb_tag: lambTag,
      lamb_id: lamb.id || null,
      lambing_date: lamb.birth_date || null,
      total_born: 1,
      deaths: 0,
    });
  }

  return out;
}

export function lambCountFor(tag, lambingRows) {
  const damTag = normalizeTag(tag);
  if (!damTag) return 0;
  return (lambingRows || [])
    .filter((r) => r && normalizeTag(r.dam_tag) === damTag)
    .reduce((sum, r) => {
      const born = parseInt(r.total_born, 10);
      return sum + (Number.isFinite(born) && born > 0 ? born : 1);
    }, 0);
}

export function lastLambingRecordFor(tag, lambingRows) {
  const damTag = normalizeTag(tag);
  if (!damTag) return null;
  let latest = null;
  for (const row of lambingRows || []) {
    if (!row || normalizeTag(row.dam_tag) !== damTag) continue;
    if (!row.lambing_date) continue;
    if (!latest || row.lambing_date > latest.lambing_date) latest = row;
  }
  return latest;
}

export function lastLambedFor(tag, lambingRows) {
  const row = lastLambingRecordFor(tag, lambingRows);
  return row ? row.lambing_date : null;
}

export function buildSheepPredicate(filters, ctx = {}) {
  const f = filters || {};
  const todayMs = ctx.todayMs ?? Date.now();
  const lambingRows = ctx.lambingRows || [];
  const weighIns = ctx.weighIns || [];
  const staleDays = ctx.staleDaysThreshold ?? STALE_SHEEP_WEIGHT_DAYS_DEFAULT;

  return (row) => {
    if (!row) return false;

    if (Array.isArray(f.flockSet) && f.flockSet.length > 0 && !f.flockSet.includes(row.flock)) return false;
    if (Array.isArray(f.sex) && f.sex.length > 0 && !f.sex.includes(row.sex)) return false;

    if (f.ageMonthsRange && (f.ageMonthsRange.min != null || f.ageMonthsRange.max != null)) {
      const months = ageMonths(row.birth_date, todayMs);
      if (months == null) return false;
      if (f.ageMonthsRange.min != null && months < f.ageMonthsRange.min) return false;
      if (f.ageMonthsRange.max != null && months > f.ageMonthsRange.max) return false;
    }

    if (f.birthDateRange && (f.birthDateRange.after || f.birthDateRange.before)) {
      if (!row.birth_date) return false;
      if (f.birthDateRange.after && row.birth_date < f.birthDateRange.after) return false;
      if (f.birthDateRange.before && row.birth_date > f.birthDateRange.before) return false;
    }

    const hasLambingFamilyFilter =
      f.lambedStatus === 'yes' ||
      f.lambedStatus === 'no' ||
      (f.lastLambedRange && (f.lastLambedRange.after || f.lastLambedRange.before)) ||
      (f.lambCountRange && (f.lambCountRange.min != null || f.lambCountRange.max != null));
    if (hasLambingFamilyFilter && row.sex !== 'ewe') return false;

    if (f.lambedStatus === 'yes' || f.lambedStatus === 'no') {
      const last = lastLambedFor(row.tag, lambingRows);
      if (f.lambedStatus === 'yes' && !last) return false;
      if (f.lambedStatus === 'no' && last) return false;
    }

    if (f.lastLambedRange && (f.lastLambedRange.after || f.lastLambedRange.before)) {
      const last = lastLambedFor(row.tag, lambingRows);
      if (!last) return false;
      if (f.lastLambedRange.after && last < f.lastLambedRange.after) return false;
      if (f.lastLambedRange.before && last > f.lastLambedRange.before) return false;
    }

    if (f.lambCountRange && (f.lambCountRange.min != null || f.lambCountRange.max != null)) {
      const count = lambCountFor(row.tag, lambingRows);
      if (f.lambCountRange.min != null && count < f.lambCountRange.min) return false;
      if (f.lambCountRange.max != null && count > f.lambCountRange.max) return false;
    }

    if (f.breedingBlacklist === true && !row.breeding_blacklist) return false;
    if (f.breedingBlacklist === false && !!row.breeding_blacklist) return false;
    if (f.maternalIssue === true && !row.maternal_issue_flag) return false;
    if (f.maternalIssue === false && !!row.maternal_issue_flag) return false;

    if (Array.isArray(f.breedingStatus) && f.breedingStatus.length > 0) {
      const status = row.breeding_status || null;
      const matches = f.breedingStatus.includes(status) || (status == null && f.breedingStatus.includes('unset'));
      if (!matches) return false;
    }

    if (f.damPresence === 'present' && !row.dam_tag) return false;
    if (f.damPresence === 'missing' && !!row.dam_tag) return false;
    if (f.sirePresence === 'present' && !row.sire_tag) return false;
    if (f.sirePresence === 'missing' && !!row.sire_tag) return false;

    if (f.weightTier) {
      const entry = lastWeightEntryFor(row, weighIns);
      const value = entry ? parseFloat(entry.weight) : null;
      const has = !!(entry && Number.isFinite(value) && value > 0);
      const stale = has && entry.entered_at && todayMs - new Date(entry.entered_at).getTime() > staleDays * DAY_MS;
      if (f.weightTier === 'hasWeight' && !has) return false;
      if (f.weightTier === 'noWeight' && has) return false;
      if (f.weightTier === 'staleWeight' && !(has && stale)) return false;
      if (f.weightTier === 'staleOrNoWeight' && !(!has || stale)) return false;
    }

    if (f.weightRange && (f.weightRange.min != null || f.weightRange.max != null)) {
      const value = lastWeightFor(row, weighIns);
      if (value == null) return false;
      if (f.weightRange.min != null && value < f.weightRange.min) return false;
      if (f.weightRange.max != null && value > f.weightRange.max) return false;
    }

    if (Array.isArray(f.breed) && f.breed.length > 0) {
      const breed = (row.breed || '').toLowerCase();
      if (!f.breed.some((b) => (b || '').toLowerCase() === breed)) return false;
    }

    if (Array.isArray(f.origin) && f.origin.length > 0) {
      const origin = (row.origin || '').toLowerCase();
      if (!f.origin.some((o) => (o || '').toLowerCase() === origin)) return false;
    }

    if (typeof f.textSearch === 'string' && f.textSearch.trim()) {
      const q = f.textSearch.toLowerCase().trim();
      const tagFields = [...sheepTagSet(row)].map((t) => t.toLowerCase());
      const fields = [row.dam_tag, row.dam_reg_num, row.sire_tag, row.sire_reg_num, row.breed, row.origin].map((x) =>
        (x || '').toLowerCase(),
      );
      if (![...tagFields, ...fields].some((x) => x.includes(q))) return false;
    }

    return true;
  };
}

export function buildSheepComparator(sortRules, ctx = {}) {
  const rules = (sortRules || []).filter((r) => r && r.key && SHEEP_SORT_KEYS.includes(r.key));
  const lambingRows = ctx.lambingRows || [];
  const weighIns = ctx.weighIns || [];

  return (a, b) => {
    for (const rule of rules) {
      const dir = rule.dir === 'desc' ? 'desc' : 'asc';
      const cmp = compareByKey(rule.key, a, b, dir, {lambingRows, weighIns});
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
      if (!aTag && !bTag) return 0;
      if (!aTag) return 1;
      if (!bTag) return -1;
      const an = parseFloat(aTag);
      const bn = parseFloat(bTag);
      const cmp = Number.isFinite(an) && Number.isFinite(bn) && an !== bn ? an - bn : aTag.localeCompare(bTag);
      return applyDir(cmp, dir);
    }
    case 'age': {
      const ab = a.birth_date || null;
      const bb = b.birth_date || null;
      if (!ab && !bb) return 0;
      if (!ab) return 1;
      if (!bb) return -1;
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
    case 'flock': {
      const ai = FLOCK_ORDER.indexOf(a.flock);
      const bi = FLOCK_ORDER.indexOf(b.flock);
      return applyDir((ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi), dir);
    }
    case 'sex': {
      const ai = SEX_ORDER.indexOf(a.sex);
      const bi = SEX_ORDER.indexOf(b.sex);
      return applyDir((ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi), dir);
    }
    case 'lastLambed': {
      const al = lastLambedFor(a.tag, ctx.lambingRows);
      const bl = lastLambedFor(b.tag, ctx.lambingRows);
      if (!al && !bl) return 0;
      if (!al) return 1;
      if (!bl) return -1;
      return applyDir(al.localeCompare(bl), dir);
    }
    case 'lambCount':
      return applyDir(lambCountFor(a.tag, ctx.lambingRows) - lambCountFor(b.tag, ctx.lambingRows), dir);
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
    case 'breedingStatus': {
      const av = (a.breeding_status || '').toLowerCase();
      const bv = (b.breeding_status || '').toLowerCase();
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return applyDir(av.localeCompare(bv), dir);
    }
    default:
      return 0;
  }
}

export function mergeObservedSheepValues(activeOptions, observedFromSheep) {
  const seen = new Set();
  const out = [];
  for (const opt of activeOptions || []) {
    if (!opt || !opt.label) continue;
    if (opt.active === false) continue;
    const key = opt.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({label: opt.label, source: 'active'});
  }
  for (const value of observedFromSheep || []) {
    if (!value) continue;
    const key = String(value).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({label: value, source: 'historical'});
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
