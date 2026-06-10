import {
  batchStartedCount,
  computeBatchCurrentCount,
  computeSubCurrentCount,
  pigTransfersForBatch,
  pigTransfersForSub,
} from './pig.js';

function count(value) {
  return parseInt(value, 10) || 0;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowsForName(dailysForName, name) {
  return typeof dailysForName === 'function' ? dailysForName(name) || [] : [];
}

function feedFromRows(rows) {
  return rows.reduce((sum, row) => sum + (parseFloat(row && row.feed_lbs) || 0), 0);
}

function feedPerPig(feedLbs, started) {
  return started > 0 && feedLbs > 0 ? feedLbs / started : null;
}

function latestDailyPigCountForBatch(group, dailysForName) {
  if (!group || (group.subBatches || []).length > 0) return null;
  const sorted = rowsForName(dailysForName, group.batchName)
    .slice()
    .sort(
      (a, b) =>
        (b.date || '').localeCompare(a.date || '') || (b.submitted_at || '').localeCompare(a.submitted_at || '') || 0,
    );
  return sorted[0]?.pig_count ?? null;
}

function blankSexMetrics() {
  // currentEstimated / feedEstimated mark values that include a proportional
  // started-head allocation (source records carried no sex attribution), so
  // the grid can render them as estimates instead of measured values.
  return {started: 0, current: null, totalFeedLbs: 0, feedPerPig: null, currentEstimated: false, feedEstimated: false};
}

function addNullableCount(value, addition) {
  if (addition == null) return value;
  return (value == null ? 0 : value) + addition;
}

// `estimated` is true only on the proportional both-sexes branch — a
// single-sex batch/sub assigns the whole source value exactly, and zero/null
// totals carry no allocation at all.
function splitCountByStarted(totalCount, giltStarted, boarStarted) {
  const total = numberOrNull(totalCount);
  const started = giltStarted + boarStarted;
  if (total == null || started <= 0) return {gilts: null, boars: null, estimated: false};
  if (total <= 0) {
    return {gilts: giltStarted > 0 ? 0 : null, boars: boarStarted > 0 ? 0 : null, estimated: false};
  }
  if (giltStarted <= 0) return {gilts: null, boars: Math.max(0, Math.round(total)), estimated: false};
  if (boarStarted <= 0) return {gilts: Math.max(0, Math.round(total)), boars: null, estimated: false};
  const gilts = Math.max(0, Math.round((total * giltStarted) / started));
  return {gilts, boars: Math.max(0, Math.round(total) - gilts), estimated: true};
}

function splitFeedByStarted(totalFeedLbs, giltStarted, boarStarted) {
  const total = Number(totalFeedLbs);
  const started = giltStarted + boarStarted;
  if (!Number.isFinite(total) || total <= 0 || started <= 0) return {gilts: 0, boars: 0, estimated: false};
  if (giltStarted <= 0) return {gilts: 0, boars: total, estimated: false};
  if (boarStarted <= 0) return {gilts: total, boars: 0, estimated: false};
  const gilts = (total * giltStarted) / started;
  return {gilts, boars: Math.max(0, total - gilts), estimated: true};
}

function addSexSlice(target, key, {started, current, totalFeedLbs, currentEstimated = false, feedEstimated = false}) {
  target[key].started += started;
  target[key].current = addNullableCount(target[key].current, current);
  target[key].totalFeedLbs += totalFeedLbs;
  // One estimated contribution makes the accumulated value an estimate.
  if (currentEstimated && current != null) target[key].currentEstimated = true;
  if (feedEstimated && totalFeedLbs > 0) target[key].feedEstimated = true;
}

function finalizeSexMetrics(metrics) {
  const gilts = {
    ...metrics.gilts,
    feedPerPig: feedPerPig(metrics.gilts.totalFeedLbs, metrics.gilts.started),
  };
  const boars = {
    ...metrics.boars,
    feedPerPig: feedPerPig(metrics.boars.totalFeedLbs, metrics.boars.started),
  };
  return {
    ...metrics,
    gilts,
    boars,
    feedPerPig: feedPerPig(metrics.totalFeedLbs, metrics.started),
    hasEstimates: gilts.currentEstimated || gilts.feedEstimated || boars.currentEstimated || boars.feedEstimated,
  };
}

export function buildPigBatchGridMetrics(group, {breeders = [], dailysForName, tripSourceSummary = null} = {}) {
  const started = batchStartedCount(group);
  const current =
    group && group.status === 'processed'
      ? 0
      : computeBatchCurrentCount(group, breeders, {
          latestDailyPigCount: latestDailyPigCountForBatch(group, dailysForName),
          tripSourceSummary,
        });
  const metrics = {
    started,
    current,
    totalFeedLbs: 0,
    feedPerPig: null,
    gilts: blankSexMetrics(),
    boars: blankSexMetrics(),
  };

  if (!group) return finalizeSexMetrics(metrics);

  const subBatches = group.subBatches || [];
  const parentLegacyFeed = parseFloat(group.legacyFeedLbs) || parseFloat(group.totalFeedLbs) || 0;

  if (subBatches.length > 0) {
    for (const sub of subBatches) {
      const giltStarted = count(sub && sub.giltCount);
      const boarStarted = count(sub && sub.boarCount);
      const rawFeedLbs =
        feedFromRows(rowsForName(dailysForName, sub && sub.name)) + (parseFloat(sub && sub.legacyFeedLbs) || 0);
      const transfers = pigTransfersForSub(breeders, group.batchName, sub && sub.name);
      const adjustedFeedLbs = Math.max(0, rawFeedLbs - transfers.feedAllocLbs);
      const subCurrent =
        group.status === 'processed'
          ? 0
          : computeSubCurrentCount(group, sub, breeders, {
              tripSourceSummary,
            });
      const currentSplit = splitCountByStarted(subCurrent, giltStarted, boarStarted);
      const feedSplit = splitFeedByStarted(adjustedFeedLbs, giltStarted, boarStarted);
      metrics.totalFeedLbs += adjustedFeedLbs;
      addSexSlice(metrics, 'gilts', {
        started: giltStarted,
        current: currentSplit.gilts,
        totalFeedLbs: feedSplit.gilts,
        currentEstimated: currentSplit.estimated,
        feedEstimated: feedSplit.estimated,
      });
      addSexSlice(metrics, 'boars', {
        started: boarStarted,
        current: currentSplit.boars,
        totalFeedLbs: feedSplit.boars,
        currentEstimated: currentSplit.estimated,
        feedEstimated: feedSplit.estimated,
      });
    }

    const parentFeedSplit = splitFeedByStarted(parentLegacyFeed, metrics.gilts.started, metrics.boars.started);
    metrics.totalFeedLbs += parentLegacyFeed;
    metrics.gilts.totalFeedLbs += parentFeedSplit.gilts;
    metrics.boars.totalFeedLbs += parentFeedSplit.boars;
    if (parentFeedSplit.estimated) {
      if (parentFeedSplit.gilts > 0) metrics.gilts.feedEstimated = true;
      if (parentFeedSplit.boars > 0) metrics.boars.feedEstimated = true;
    }
    return finalizeSexMetrics(metrics);
  }

  const rawFeedLbs = feedFromRows(rowsForName(dailysForName, group.batchName)) + parentLegacyFeed;
  const transfers = pigTransfersForBatch(breeders, group.batchName);
  const transferCredit =
    transfers.feedAllocLbs > 0 ? transfers.feedAllocLbs : parseFloat(group.feedAllocatedToTransfers) || 0;
  const adjustedFeedLbs = Math.max(0, rawFeedLbs - transferCredit);
  const giltStarted = count(group.giltCount);
  const boarStarted = count(group.boarCount);
  const currentSplit = splitCountByStarted(current, giltStarted, boarStarted);
  const feedSplit = splitFeedByStarted(adjustedFeedLbs, giltStarted, boarStarted);

  metrics.totalFeedLbs = adjustedFeedLbs;
  addSexSlice(metrics, 'gilts', {
    started: giltStarted,
    current: currentSplit.gilts,
    totalFeedLbs: feedSplit.gilts,
    currentEstimated: currentSplit.estimated,
    feedEstimated: feedSplit.estimated,
  });
  addSexSlice(metrics, 'boars', {
    started: boarStarted,
    current: currentSplit.boars,
    totalFeedLbs: feedSplit.boars,
    currentEstimated: currentSplit.estimated,
    feedEstimated: feedSplit.estimated,
  });
  return finalizeSexMetrics(metrics);
}
