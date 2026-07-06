// ============================================================================
// src/lib/processingCompletion.js  —  client mirror of the completion gate
// ----------------------------------------------------------------------------
// Pure client-side mirror of the server completion gate
// (_processing_completion_blockers in supabase-migrations/155_processing_calendar.sql)
// so the UI can show "why can't I complete this yet" instantly — enable/disable
// the Complete button, list the outstanding requirements — WITHOUT a round-trip.
//
// The SERVER remains the source of truth: mark_processing_complete re-runs the
// same gate and RAISES 'PROCESSING_VALIDATION: cannot complete — <blockers>' if
// anything is unmet. This module only needs to agree with it for good UX; the
// strings + ordering below are kept in lockstep with the migration wording.
//
// Gate rules (must match the migration exactly):
//   • milestone       → only a Processing Date is required.
//   • everything else → Processor + Processing Date + (Number Processed when the
//     row is source-linked, i.e. source_id is set) + all subtasks done.
//   Note number_processed of 0 counts as PRESENT (only NULL blocks), matching
//   the server's `IS NULL` check.
// ============================================================================

function isBlankDate(value) {
  return value === null || value === undefined || value === '';
}

function isBlankText(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

// computeCompletionBlockers(record, subtasks) -> string[]
// Empty array => the record MAY be completed. `subtasks` defaults to the
// record's own subtasks[] (as returned by get_processing_record); pass an
// explicit list when you hold subtasks separately.
export function computeCompletionBlockers(record, subtasks) {
  if (!record) return ['record not found'];

  const blockers = [];

  // Milestones are planning placeholders: only a date gates completion.
  if (record.record_type === 'milestone') {
    if (isBlankDate(record.processing_date)) blockers.push('Processing Date is required');
    return blockers;
  }

  if (isBlankText(record.processor)) blockers.push('Processor is required');
  if (isBlankDate(record.processing_date)) blockers.push('Processing Date is required');

  // Source-owned Number Processed must exist where the row is source-linked.
  // Only NULL/undefined blocks — a real 0 is a present value (server uses IS NULL).
  const sourceLinked = record.source_id !== null && record.source_id !== undefined;
  if ((record.number_processed === null || record.number_processed === undefined) && sourceLinked) {
    blockers.push('Number Processed (from the source batch) is required');
  }

  const list = Array.isArray(subtasks) ? subtasks : Array.isArray(record.subtasks) ? record.subtasks : [];
  const openSubs = list.filter((s) => s && !s.done).length;
  if (openSubs > 0) blockers.push(`${openSubs} subtask(s) still open`);

  return blockers;
}

// canComplete(record, subtasks) -> boolean. True when the gate is fully met.
export function canComplete(record, subtasks) {
  return computeCompletionBlockers(record, subtasks).length === 0;
}
