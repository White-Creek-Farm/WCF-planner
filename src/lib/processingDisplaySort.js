// ============================================================================
// src/lib/processingDisplaySort.js — default Processing section ordering
// ----------------------------------------------------------------------------
// Pure display sort for the rows inside one Processing program section
// (planner-integration lane). Three buckets by the server-derived
// `effective_status` ('planned' | 'in_process' | 'complete'):
//   1. In Process — oldest processing_date first (longest-running work on top)
//   2. Planned    — nearest processing_date first (what's coming next)
//   3. Complete   — newest completed_at first (most recent history on top)
// Undated rows (and Complete rows missing completed_at) sink to the end of
// their bucket. An unknown/missing effective_status is treated as 'planned',
// mirroring the server's conservative default. Input is never mutated; ties
// keep their incoming relative order (Array.prototype.sort is stable).
// ============================================================================

const BUCKET_RANK = {in_process: 0, planned: 1, complete: 2};

function bucketRank(record) {
  const rank = BUCKET_RANK[record && record.effective_status];
  return rank === undefined ? BUCKET_RANK.planned : rank;
}

// ISO 'YYYY-MM-DD' prefix (dates and timestamps both), or null when unusable.
function isoPrefix(value) {
  const m = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return m ? String(value) : null;
}

// Ascending ISO compare with nulls LAST.
function compareAscNullsLast(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortProcessingRecordsForDisplay(records) {
  const list = Array.isArray(records) ? records.slice() : [];
  return list.sort((a, b) => {
    const ra = bucketRank(a);
    const rb = bucketRank(b);
    if (ra !== rb) return ra - rb;
    if (ra === BUCKET_RANK.complete) {
      // Newest completed_at first; rows without one go last.
      const ca = isoPrefix(a && a.completed_at);
      const cb = isoPrefix(b && b.completed_at);
      if (ca === cb) return 0;
      if (ca === null) return 1;
      if (cb === null) return -1;
      return ca < cb ? 1 : -1;
    }
    // In Process + Planned: processing_date ascending, undated last.
    return compareAscNullsLast(isoPrefix(a && a.processing_date), isoPrefix(b && b.processing_date));
  });
}
