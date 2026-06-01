import {fmtMDY} from './dateUtils.js';

// Record-page sequence navigation — route-state contract + neighbor math.
//
// A record page (cattle.animal, sheep.animal, …) shows Previous/Next controls
// ONLY when it was opened from a list whose visible order was handed through
// react-router location state. Direct URL opens, notification / deep-link
// opens, and related-record click-throughs (cow-to-cow, sheep-to-sheep) carry
// no sequence, so the controls stay hidden.
//
// The list passes its ordered, visible rows; we keep a minimal {id, tag, label?}
// projection (small enough to live in history state) under
// location.state.recordSeq. Prev/Next carry the SAME sequence forward.

// Project an array of record rows down to the minimal shape stored in route
// state: {id, tag, label?}. Rows without an id are dropped. `label` is an
// optional precomputed display string for records without a tag (daily
// reports, weigh-in sessions). Accepts rows already in this shape (used when
// carrying the sequence forward).
export function toRecordSeq(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || it.id == null) continue;
    const entry = {id: it.id, tag: it.tag == null ? null : it.tag};
    if (it.label != null) entry.label = it.label;
    out.push(entry);
  }
  return out;
}

// Build the navigate() options object that threads the visible-order sequence
// through route state. Use at the list row click and at Prev/Next.
export function recordSeqNavOptions(items) {
  return {state: {recordSeq: toRecordSeq(items)}};
}

// Build sequence items for a daily-report list: label is the record date
// (mm/dd/yyyy) plus an optional " · <suffix>" (batch_label / herd / flock).
// Pass suffixField=null for date-only (egg daily). Mirrors each daily record
// page's title format (fmtMDY) so the neighbor label matches the destination
// title.
export function dailySeqItems(rows, suffixField) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const dateStr = r && r.date != null && r.date !== '' ? fmtMDY(r.date) : '';
    const suffix = suffixField && r && r[suffixField] ? ' · ' + r[suffixField] : '';
    return {id: r.id, label: dateStr + suffix};
  });
}

// Build sequence items for a list whose label is a single record field
// (batch name, task title, equipment name, housing name, …). idField defaults
// to 'id' but can be overridden for routes keyed by another field (e.g.
// equipment routes by slug). Rows without the id field are dropped.
export function labeledSeqItems(rows, labelField, idField = 'id') {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r || r[idField] == null) continue;
    out.push({id: r[idField], label: r[labelField] != null ? String(r[labelField]) : null});
  }
  return out;
}

// Pure neighbor lookup. Returns index -1 (caller hides the controls) when
// there is no reliable sequence: not an array, fewer than 2 entries, or the
// current id is not present in the sequence.
export function findSequenceNeighbors(seq, currentId) {
  const empty = {index: -1, total: 0, prev: null, next: null};
  if (!Array.isArray(seq) || seq.length < 2 || currentId == null) return empty;
  const cur = String(currentId);
  const index = seq.findIndex((it) => it && String(it.id) === cur);
  if (index === -1) return {index: -1, total: seq.length, prev: null, next: null};
  return {
    index,
    total: seq.length,
    prev: index > 0 ? seq[index - 1] : null,
    next: index < seq.length - 1 ? seq[index + 1] : null,
  };
}
