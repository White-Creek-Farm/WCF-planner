// Pig Batches filters + ordered sort (right-sized).
// Pure module: no React, no DB client (no `sb`), no browser globals. PigBatchesView owns
// rendering + the ledger/feed math (those need breeders + dailys); this file
// owns deterministic filter/sort behavior over the feeder-group rows and the
// per-batch metrics the view threads in through `ctx`.
//
// The pig hub is small (a handful to a few dozen batches) so this is a single
// active sort rule {key, dir} — NOT the multi-rule chip toolbar cattle/sheep
// use. The status pipeline is just active | processed, so the default sort
// keeps processed batches below active ones (parity with the legacy
// active-first/processed-bottom order).

export const PIG_BATCH_STATUSES = Object.freeze(['active', 'processed']);

export const PIG_BATCH_FILTER_DIMENSIONS = Object.freeze([
  'textSearch',
  'status',
  'hasSubBatches',
  'startedRange',
  'startDateRange',
]);

export const PIG_BATCH_SORT_KEYS = Object.freeze([
  'batchName',
  'status',
  'started',
  'current',
  'feedPerStarted',
  'startDate',
]);

const STATUS_ORDER = ['active', 'processed'];

// Per-batch metrics the view computes (started/current/feedPerStarted) keyed by
// group.id. The view already derives these in renderPigBatchTile via breeders +
// dailys; threading them through ctx keeps this module pure while letting the
// numeric sorts agree with what the row renders. metricsById[id] shape:
//   {started: number|null, current: number|null, feedPerStarted: number|null}
function metricFor(ctx, group, key) {
  const byId = (ctx && ctx.metricsById) || {};
  const m = group && byId[group.id];
  if (!m) return null;
  const value = m[key];
  return value == null || Number.isNaN(value) ? null : value;
}

function subBatchCount(group) {
  return group && Array.isArray(group.subBatches) ? group.subBatches.length : 0;
}

function startedCountOf(ctx, group) {
  const metric = metricFor(ctx, group, 'started');
  if (metric != null) return metric;
  // Fallback when no metrics map is supplied: gilts + boars on the parent row.
  const gilt = parseInt(group && group.giltCount, 10) || 0;
  const boar = parseInt(group && group.boarCount, 10) || 0;
  return gilt + boar;
}

export function buildPigBatchPredicate(filters, ctx = {}) {
  const f = filters || {};

  return (group) => {
    if (!group) return false;

    if (typeof f.status === 'string' && f.status && f.status !== 'all') {
      if ((group.status || 'active') !== f.status) return false;
    }

    if (f.hasSubBatches === true && subBatchCount(group) === 0) return false;
    if (f.hasSubBatches === false && subBatchCount(group) > 0) return false;

    if (f.startedRange && (f.startedRange.min != null || f.startedRange.max != null)) {
      const started = startedCountOf(ctx, group);
      if (f.startedRange.min != null && started < f.startedRange.min) return false;
      if (f.startedRange.max != null && started > f.startedRange.max) return false;
    }

    if (f.startDateRange && (f.startDateRange.after || f.startDateRange.before)) {
      const start = group.startDate || '';
      if (!start) return false;
      if (f.startDateRange.after && start < f.startDateRange.after) return false;
      if (f.startDateRange.before && start > f.startDateRange.before) return false;
    }

    if (typeof f.textSearch === 'string' && f.textSearch.trim()) {
      const q = f.textSearch.toLowerCase().trim();
      const fields = [group.batchName, group.id, group.notes, group.cycleId].map((x) =>
        (x == null ? '' : String(x)).toLowerCase(),
      );
      const subNames = (group.subBatches || []).map((s) => (s && s.name ? String(s.name).toLowerCase() : ''));
      if (![...fields, ...subNames].some((x) => x.includes(q))) return false;
    }

    return true;
  };
}

export function buildPigBatchComparator(sortRule, ctx = {}) {
  // Single active rule (right-sized). Accept either a {key, dir} object or a
  // one-element array so callers can stay close to the cattle/sheep shape.
  const rule = Array.isArray(sortRule) ? sortRule[0] : sortRule;
  const key = rule && rule.key && PIG_BATCH_SORT_KEYS.includes(rule.key) ? rule.key : 'status';
  const dir = rule && rule.dir === 'desc' ? 'desc' : 'asc';

  return (a, b) => {
    // Processed batches always sort below active ones first, regardless of the
    // active key/dir — this preserves the legacy active-first/processed-bottom
    // hub order as a stable tie-break and primary grouping.
    const aProcessed = (a && a.status) === 'processed' ? 1 : 0;
    const bProcessed = (b && b.status) === 'processed' ? 1 : 0;
    if (aProcessed !== bProcessed) return aProcessed - bProcessed;
    return compareByKey(key, a, b, dir, ctx);
  };
}

function applyDir(cmp, dir) {
  return dir === 'desc' ? -cmp : cmp;
}

function compareNumeric(av, bv, dir) {
  // Missing values sort to the end regardless of direction.
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return applyDir(av - bv, dir);
}

function compareByKey(key, a, b, dir, ctx) {
  switch (key) {
    case 'batchName':
      return compareBatchName(a, b, dir);
    case 'status': {
      const ai = STATUS_ORDER.indexOf(a.status || 'active');
      const bi = STATUS_ORDER.indexOf(b.status || 'active');
      const statusCompare = applyDir((ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi), dir);
      return statusCompare || compareBatchName(a, b, 'desc');
    }
    case 'started':
      return compareNumeric(startedCountOf(ctx, a), startedCountOf(ctx, b), dir);
    case 'current':
      return compareNumeric(metricFor(ctx, a, 'current'), metricFor(ctx, b, 'current'), dir);
    case 'feedPerStarted':
      return compareNumeric(metricFor(ctx, a, 'feedPerStarted'), metricFor(ctx, b, 'feedPerStarted'), dir);
    case 'startDate': {
      const av = a.startDate || null;
      const bv = b.startDate || null;
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return applyDir(av.localeCompare(bv), dir);
    }
    default:
      return 0;
  }
}

function compareBatchName(a, b, dir) {
  const av = (a.batchName || '').trim();
  const bv = (b.batchName || '').trim();
  if (!av && !bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return applyDir(av.localeCompare(bv, undefined, {numeric: true}), dir);
}
