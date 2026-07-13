// ============================================================================
// src/lib/processingNav.js — deep-link navigation into the Processing Calendar
// ----------------------------------------------------------------------------
// Shared by the Header notification rows, the My Tasks "Processing work"
// section, and the native batch pages' "View in Processing" links. Pure module
// (no React) — callers pass their react-router `navigate`.
//
// Deep-link contract (ProcessingCalendarView):
//   /processing?record=<processingRecordId>       opens that record's drawer.
//   /processing?source=<kind>:<sourceId>          opens the matching record's
//     drawer (kind in broiler|cattle|sheep|pig; the pig sourceId itself
//     contains a colon: groupId:tripId).
//   CustomEvent 'wcf-processing-open-record' {detail:{recordId}} opens a
//     drawer when the view is ALREADY mounted.
//
// Why react-router navigate (mechanism investigated in src/main.jsx):
//   The URL <-> view adapter keys its URL->view effect on location.pathname
//   only. Navigating to '/processing?record=<id>' via react-router:
//   - from another view: the pathname change resolves through
//     PATH_TO_VIEW['/processing'] and flips view to 'processing' (the
//     syncingFromUrl flag suppresses the echo back into the URL), the query
//     string survives in the address bar, and the freshly mounted view opens
//     the record's drawer from ?record= per the contract above.
//   - already on /processing: the pathname is unchanged, so neither adapter
//     effect runs and the mounted view never remounts — the
//     'wcf-processing-open-record' event dispatched here opens the drawer in
//     place. When the view is NOT mounted the event dispatches into nothing
//     (harmless) and the URL param does the work on load.
//   Raw history.pushState/replaceState is deliberately NOT used: main.jsx
//   documents that it desyncs react-router's location state and breaks
//   popstate (back button) handling.

export const PROCESSING_OPEN_RECORD_EVENT = 'wcf-processing-open-record';

// Route for one Processing record's drawer. A missing id degrades to the flat
// /processing page rather than emitting '?record=undefined'.
export function processingRecordRoute(recordId) {
  if (recordId === null || recordId === undefined || recordId === '') return '/processing';
  return `/processing?record=${encodeURIComponent(recordId)}`;
}

// Route that opens the Processing record matching a native source. Each id
// part is encoded individually so the ':' separators stay literal — the view
// reads the param back through URLSearchParams (which percent-decodes) and
// splits on the colons. Pig passes two parts: (groupId, tripId).
export function processingSourceRoute(kind, ...idParts) {
  const parts = idParts
    .filter((p) => p !== null && p !== undefined && p !== '')
    .map((p) => encodeURIComponent(String(p)));
  return `/processing?source=${kind}:${parts.join(':')}`;
}

// Extract the record id from a '/processing?record=<id>' route; null for any
// other shape (flat /processing, ?source= routes, non-processing routes).
export function parseProcessingRecordId(route) {
  if (typeof route !== 'string') return null;
  const qIndex = route.indexOf('?');
  if (qIndex < 0) return null;
  const path = route.slice(0, qIndex);
  if (path !== '/processing') return null;
  try {
    return new URLSearchParams(route.slice(qIndex + 1)).get('record') || null;
  } catch (_e) {
    return null;
  }
}

// Navigate to any /processing route (record deep link, source deep link, or
// the flat page) and — when the route targets a specific record — dispatch
// the open-record event for the already-mounted-view case described above.
export function navigateToProcessingRoute(navigate, route) {
  navigate(route);
  const recordId = parseProcessingRecordId(route);
  if (!recordId) return;
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(PROCESSING_OPEN_RECORD_EVENT, {detail: {recordId}}));
    }
  } catch (_e) {
    /* non-browser env / ancient CustomEvent — the URL param still works */
  }
}

// Navigate straight to one record's drawer by id.
export function navigateToProcessingRecord(navigate, recordId) {
  navigateToProcessingRoute(navigate, processingRecordRoute(recordId));
}
