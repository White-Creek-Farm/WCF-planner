// ============================================================================
// src/lib/processingSourceLink.js — Processing <-> native planner link helpers
// ----------------------------------------------------------------------------
// Planner-integration lane: source facts arrive on each Processing record as
// the server-side LIVE projection (`record.source`, mig 176) — this module no
// longer resolves facts from client planner collections or stale snapshots.
// What remains client-side is presentation: exact two-way navigation routes and
// the program-specific age/date/count formatting used by the fixed Processing
// tables and drawer.
//
// Route contracts (two-way navigation):
//   broiler -> /broiler/batches/<encoded batch NAME> (the record page resolves
//              by name then pins batch.id; the projection carries the live
//              name — source_id itself is the immutable ppp-v4 batch id).
//   cattle  -> /cattle/batches/<source_id>
//   sheep   -> /sheep/batches/<source_id>
//   pig     -> /pig/batches/<groupId>?trip=<tripId> (focuses the EXACT trip).
// ============================================================================

export const NOT_RECORDED = 'Not recorded';

// Native planner route for a Processing record, or null when the record has no
// live source (unmatched historical rows, milestones).
export function sourceRouteForRecord(record) {
  if (!record || !record.source_kind || !record.source_id) return null;
  const src = record.source || null;
  if (record.source_kind === 'broiler') {
    const name = src && src.batch_name ? String(src.batch_name) : null;
    return name ? `/broiler/batches/${encodeURIComponent(name)}` : null;
  }
  if (record.source_kind === 'cattle') return `/cattle/batches/${record.source_id}`;
  if (record.source_kind === 'sheep') return `/sheep/batches/${record.source_id}`;
  if (record.source_kind === 'pig') {
    const sep = String(record.source_id).indexOf(':');
    if (sep <= 0) return null;
    const groupId = String(record.source_id).slice(0, sep);
    const tripId = String(record.source_id).slice(sep + 1);
    return `/pig/batches/${groupId}?trip=${encodeURIComponent(tripId)}`;
  }
  return null;
}

// Label for the back-link ("View <program> batch" / "View pig trip").
export function sourceLinkLabel(record) {
  if (!record || !record.source_kind) return null;
  if (record.source_kind === 'pig') return 'View pig trip';
  const names = {broiler: 'broiler', cattle: 'cattle', sheep: 'sheep'};
  return `View ${names[record.source_kind] || 'source'} batch`;
}

// ── Age / duration formatting ────────────────────────────────────────────────

// Whole days -> "Nw Nd" (broiler age from hatch to processing).
export function weeksDaysText(days) {
  const d = parseInt(days);
  if (!Number.isFinite(d) || d < 0) return null;
  return `${Math.floor(d / 7)}w ${d % 7}d`;
}

// Whole days -> "Ny Mm" (cattle/sheep age at processing; mirrors the batch
// record pages' ageAtProcessing formatting).
export function yearsMonthsText(days) {
  const d = parseInt(days);
  if (!Number.isFinite(d) || d < 0) return null;
  const years = Math.floor(d / 365);
  const months = Math.floor((d % 365) / 30);
  return `${years}y ${months}m`;
}

// Whole days -> "Nm Nw" (pig age; mirrors the pig planner's month/week style).
export function monthsWeeksText(days) {
  const d = parseInt(days);
  if (!Number.isFinite(d) || d < 0) return null;
  const months = Math.floor(d / 30);
  const weeks = Math.floor((d % 30) / 7);
  return `${months}m ${weeks}w`;
}

// {min_days, max_days, estimated?} -> range text with a single formatter, or
// null when the range is unusable. min==max collapses to one value.
export function ageRangeText(age, formatDays) {
  if (!age) return null;
  const min = parseInt(age.min_days);
  const max = parseInt(age.max_days);
  const fmt = typeof formatDays === 'function' ? formatDays : yearsMonthsText;
  const minText = Number.isFinite(min) ? fmt(min) : null;
  const maxText = Number.isFinite(max) ? fmt(max) : null;
  if (!minText && !maxText) return null;
  const core = minText && maxText && minText !== maxText ? `${minText} – ${maxText}` : maxText || minText;
  return age.estimated ? `${core} (est.)` : core;
}

// Program-aware Age cell for the fixed tables. Broiler ages render from the
// projection's single age_days; cattle/sheep/pig render their age range.
export function recordAgeText(record) {
  if (!record || !record.source) return null;
  const src = record.source;
  if (record.source_kind === 'broiler') return weeksDaysText(src.age_days);
  if (record.source_kind === 'pig') return ageRangeText(src.age, monthsWeeksText);
  return ageRangeText(src.age, yearsMonthsText);
}

// Display helper: any nullish/blank value renders the canonical placeholder.
// Never estimate missing values.
export function displayOrNotRecorded(value) {
  if (value === null || value === undefined) return NOT_RECORDED;
  const text = String(value).trim();
  return text === '' ? NOT_RECORDED : text;
}

// ── Drawer display title (presentation-only) ─────────────────────────────────
// Pig planner records render '<batch> · Trip <ordinal>' in the drawer — the
// stored/canonical 'Pig Trip · ' prefix is display noise there (the drawer
// already says Pig, and the schedule keeps its separate Batch/Trip columns).
// Built from the LIVE source batch name plus the immutable trip_ordinal;
// nothing is rewritten server-side and identity is untouched. Fail closed:
// any record without a usable batch name AND ordinal — and every non-pig,
// milestone, historical, or unmatched record — returns the stored title
// byte-identical, never invented text.
export function displayRecordTitle(record) {
  if (!record) return '';
  if (record.source_kind !== 'pig' || record.record_type !== 'planner_batch') return record.title || '';
  const src = record.source && record.source.matched !== false ? record.source : null;
  const name = src && src.batch_name != null ? String(src.batch_name).trim() : '';
  const ordinal = record.trip_ordinal;
  if (!name || ordinal == null || !Number.isFinite(Number(ordinal))) return record.title || '';
  return `${name} · Trip ${ordinal}`;
}

// ── Pig trip sex (canonical, read-only) ──────────────────────────────────────
// Planned pig trips are single-sex by the (subBatchId, sex) trip-chain
// contract, and the planner reconcile stamps each pig Processing record's
// sub_batch_attribution from the EXACT linked trip (its immutable
// groupId:tripId identity). This helper only normalizes that stored canonical
// vocabulary ('Boars'/'Gilts', mirroring the server's boar%/gilt% matching)
// to the singular display label. It never guesses: an empty, unknown, or
// conflicting attribution resolves to null so the UI renders 'Not recorded'.
export function pigTripSexLabel(record) {
  if (!record || record.source_kind !== 'pig') return null;
  const attribution = Array.isArray(record.sub_batch_attribution) ? record.sub_batch_attribution : [];
  const labels = new Set();
  for (const entry of attribution) {
    const raw = String((entry && entry.sex) || '')
      .trim()
      .toLowerCase();
    if (!raw) continue;
    if (raw.startsWith('boar')) labels.add('Boar');
    else if (raw.startsWith('gilt')) labels.add('Gilt');
    else return null; // unknown vocabulary — never guess
  }
  return labels.size === 1 ? [...labels][0] : null;
}

// ── Soft signals (pig planned trips) ─────────────────────────────────────────
// 'Auto-planned' until the native trip is locked/scheduled with the processor,
// then 'Processor scheduled'. Secondary text, NOT lifecycle status.
export function pigPlanSignal(record) {
  if (!record || record.source_kind !== 'pig') return null;
  const src = record.source || {};
  const phase = src.phase || record.source_phase;
  if (phase !== 'planned') return null;
  return src.scheduled_with_processor ? 'Processor scheduled' : 'Auto-planned';
}
