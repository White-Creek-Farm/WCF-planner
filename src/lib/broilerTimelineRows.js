// ============================================================================
// src/lib/broilerTimelineRows.js
// ----------------------------------------------------------------------------
// Presentational row-separation model for the Broiler timeline Gantt. Pure and
// data-free: given a RESOURCES index it reports whether that row carries the
// strong brooder -> schooner divider and which alternating fill band it belongs
// to. Schooner rows alternate a very light neutral fill so the eye can follow
// one row left to right; brooder rows are unstriped. The view applies the fill
// to BOTH the sticky resource-label cell and the timeline-grid body. No dates,
// sizes, batch colors, ordering, or calculations live here.
// ============================================================================
import {RESOURCES} from './broiler.js';

// The brooder -> schooner boundary: index of the first schooner row. Derived
// from resource order so it stays correct if the resource list ever changes,
// instead of the old hard-coded `ri === 2` placement.
export const FIRST_SCHOONER_INDEX = RESOURCES.findIndex((r) => r.type === 'schooner');

// Return the row's visual separation intent.
//   boundaryTop: render the one strong divider above this row (first schooner).
//   fill: 'none'   -> brooder row, unstriped (view keeps the existing sidebar).
//         'plain'  -> schooner row with no fill band.
//         'shaded' -> schooner row with the light neutral fill band.
// Schooner rows alternate plain / shaded in resource order, starting plain, so
// with the shipped resource list the bands are:
//   Schooner 1 = plain, Schooner 2 & 3 = shaded, Schooner 4 & 5 = plain,
//   Schooner 6 & 6A = shaded, Schooner 7 & 7A = plain.
export function timelineRowSeparation(index) {
  const res = RESOURCES[index];
  if (!res || res.type !== 'schooner') return {boundaryTop: false, fill: 'none'};
  const pos = index - FIRST_SCHOONER_INDEX; // 0-based order among schooner rows
  return {
    boundaryTop: index === FIRST_SCHOONER_INDEX,
    fill: pos % 2 === 1 ? 'shaded' : 'plain',
  };
}
