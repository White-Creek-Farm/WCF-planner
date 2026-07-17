// ============================================================================
// src/lib/processingDashboardMetrics.js — Processing dashboard metric math
// ----------------------------------------------------------------------------
// Pure derivations for the Processing schedule dashboard:
//   • computeProgramChipCounts — program filter chip counts. BATCH records
//     only: milestone rows are planning placeholders and never count toward
//     'All' or a program chip. Callers pass rows AFTER the year/search
//     filters so the chip numbers stay honest against the visible schedule.
//   • computeCompletedProgramTotals — the selected year's completed
//     processing totals, summed independently per program (broiler / cattle /
//     sheep / pig; sheep displays as 'Lamb'). Only COMPLETED batch rows
//     contribute; the animal count is the canonical decorated count
//     (live_count ?? number_processed). A completed row with no recorded
//     count is NEVER treated as a recorded zero — it increments the program's
//     missingCount so the UI can disclose the incomplete subtotal.
// There is intentionally NO all-species combined total anywhere in this
// module: broilers, cattle, lambs, and pigs are not comparable head-to-head.
// ============================================================================
import {processingStatusLabel, PROCESSING_STATUS_DISPLAY} from './processingStatusDisplay.js';

// Program keys in the locked Processing schedule order (Lamb == sheep).
export const PROCESSING_DASHBOARD_PROGRAM_KEYS = Object.freeze(['broiler', 'cattle', 'sheep', 'pig']);

function programKeyOf(rec) {
  return (rec && (rec.program || rec.source_kind)) || null;
}

export function isBatchRecord(rec) {
  return !!rec && rec.record_type !== 'milestone';
}

function isCompletedBatch(rec) {
  return isBatchRecord(rec) && processingStatusLabel(rec.effective_status) === PROCESSING_STATUS_DISPLAY.complete;
}

// Canonical animal count: live_count ?? number_processed, or null when the
// resolved value is not a finite NON-NEGATIVE recorded number. Missing ≠
// recorded zero, and a negative value is invalid/missing — it must never
// subtract animals from a processed total.
export function recordAnimalCount(rec) {
  const value = rec == null ? null : (rec.live_count ?? rec.number_processed);
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function computeProgramChipCounts(rows) {
  const counts = {all: 0};
  for (const key of PROCESSING_DASHBOARD_PROGRAM_KEYS) counts[key] = 0;
  for (const rec of Array.isArray(rows) ? rows : []) {
    if (!isBatchRecord(rec)) continue;
    const key = programKeyOf(rec);
    // Fail closed: only the four canonical program keys count anywhere, so
    // 'All' can never drift from broiler + cattle + sheep + pig.
    if (!PROCESSING_DASHBOARD_PROGRAM_KEYS.includes(key)) continue;
    counts[key] += 1;
    counts.all += 1;
  }
  return counts;
}

export function computeCompletedProgramTotals(rows) {
  const totals = {};
  for (const key of PROCESSING_DASHBOARD_PROGRAM_KEYS) totals[key] = {total: 0, missingCount: 0};
  for (const rec of Array.isArray(rows) ? rows : []) {
    if (!isCompletedBatch(rec)) continue;
    const bucket = totals[programKeyOf(rec)];
    if (!bucket) continue;
    const count = recordAnimalCount(rec);
    if (count == null) bucket.missingCount += 1;
    else bucket.total += count;
  }
  return totals;
}
