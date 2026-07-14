import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the Processing checklist-toggle lane:
//   • toggling a subtask checkbox is a DEDICATED optimistic path — it must not
//     route through the generic runMutation helper (which sets the drawer's
//     visible loading state) and must not call onChanged (which is the
//     schedule's full load). The drawer stays mounted and stable; the schedule
//     row is patched narrowly through onSubtaskCountsChanged.
//   • the silent reconcile refetches get_processing_record WITHOUT the visible
//     loading state and discards stale/out-of-order responses.
//   • rapid duplicate clicks on one subtask cannot overlap writes (per-id
//     pending lock); an RPC failure rolls the optimistic patch back and shows
//     the existing inline error treatment.
//   • Source details never repeats the Processing-owned Processor/Customer
//     values as read-only rows (they are editable directly above), for ANY
//     program.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const drawer = read('src/processing/ProcessingDrawer.jsx');
const view = read('src/processing/ProcessingCalendarView.jsx');

function slice(src, startMarker, endMarker, label) {
  const start = src.indexOf(startMarker);
  expect(start, `${label}: start marker "${startMarker}" present`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start + startMarker.length);
  expect(end, `${label}: end marker "${endMarker}" present`).toBeGreaterThan(start);
  return src.slice(start, end);
}

const toggleBody = slice(drawer, 'async function toggleSubtask(st)', 'function addSubtask()', 'toggleSubtask');
const silentBody = slice(drawer, 'const silentRefreshRecord', '// Esc closes the drawer.', 'silentRefreshRecord');
const sourceDetails = slice(
  drawer,
  'function renderSourceDetails()',
  'function renderTemplatePreview()',
  'renderSourceDetails',
);

describe('drawer — checklist toggle is a dedicated no-reload path', () => {
  it('toggleSubtask never routes through runMutation and never calls onChanged (no drawer reload, no schedule reload)', () => {
    expect(toggleBody).not.toContain('runMutation');
    expect(toggleBody).not.toContain('notifyRef');
    expect(toggleBody).not.toContain('load()');
    // Still the same RPC wrapper — the transport did not change.
    expect(toggleBody).toContain('setProcessingSubtaskDone(sb, st.id, nextDone)');
  });

  it('optimistically patches the clicked subtask in place, then silently reconciles the server record', () => {
    // In-place patch of ONLY the matching item.
    expect(toggleBody).toMatch(
      /subtasks: d\.subtasks\.map\(\(s\) => \(s\.id === st\.id \? \{\.\.\.s, done: nextDone\}/,
    );
    expect(toggleBody).toContain('await silentRefreshRecord()');
    // A reconcile failure never rolls back a landed write.
    expect(toggleBody).toContain('tolerated');
  });

  it('patches the parent schedule row through the narrow counts callback, not a full reload', () => {
    expect(toggleBody).toContain('countsChangedRef.current(recordId, {done:');
    expect(drawer).toContain('onSubtaskCountsChanged');
  });

  it('publishes CONFIRMED counts only — pending optimism from OTHER toggles never reaches the schedule row', () => {
    // Authoritative path: the RAW refresh payload, with no pending overrides
    // applied (unlike the drawer display, which keeps optimism locally).
    expect(toggleBody).toContain('list = fresh.subtasks;');
    expect(toggleBody).not.toContain('withPendingSubtaskOverrides(fresh');
    // Fallback path: every other still-pending toggle reverts to its
    // confirmed prior value (boolean negation); only THIS landed write adds.
    expect(toggleBody).toMatch(/if \(s\.id === st\.id\) return \{\.\.\.s, done: nextDone\};/);
    expect(toggleBody).toMatch(/return pend === undefined \? s : \{\.\.\.s, done: !pend\};/);
    // The failure path publishes nothing — the parent never saw the optimism,
    // so a failed neighbour toggle can never strand an inflated row count.
    const catchIdx = toggleBody.indexOf('} catch (e) {');
    expect(catchIdx).toBeGreaterThan(-1);
    expect(toggleBody.slice(catchIdx)).not.toContain('countsChangedRef');
  });

  it('locks only the clicked checkbox while its write is pending (rapid duplicate clicks cannot overlap)', () => {
    // Early return while THIS subtask has an in-flight write.
    expect(toggleBody).toMatch(/if \(pendingSubtasksRef\.current\.has\(st\.id\)\) return;/);
    // The render disables per subtask id — not a blanket busy freeze.
    expect(drawer).toContain('disabled={!canOperate || busy || pendingSubtaskIds.has(st.id)}');
    // The pending id is always released.
    expect(toggleBody).toMatch(/finally \{[\s\S]*pendingSubtasksRef\.current\.delete\(st\.id\);/);
  });

  it('an RPC failure restores the prior checkbox state and reuses the existing inline error treatment', () => {
    expect(toggleBody).toMatch(/s\.id === st\.id \? \{\.\.\.s, done: st\.done, completed_at: st\.completed_at\}/);
    expect(toggleBody).toContain('isProcessingValidationError(e)');
    expect(toggleBody).toContain('friendlyProcessingError(e)');
    expect(toggleBody).toContain('Something went wrong. Please retry.');
  });

  it('the silent reconcile never sets the visible loading state and discards stale responses', () => {
    expect(silentBody).not.toContain('setLoading(true)');
    expect(silentBody).toContain('getProcessingRecord(sb, recordId)');
    // Out-of-order guard: only the newest fetch may apply; a refetch for a
    // record the drawer left is skipped.
    expect(silentBody).toMatch(/if \(recordId !== recordIdRef\.current\) return null;/);
    expect(silentBody).toMatch(
      /if \(seq !== fetchSeqRef\.current \|\| recordId !== recordIdRef\.current\) return null;/,
    );
    // Server-authoritative completion_blockers arrive with the same payload —
    // the drawer reads them straight from data (no client mirror).
    expect(drawer).toContain('Array.isArray(data?.completion_blockers)');
  });

  it('completing the last subtask cannot auto-complete the record from this path', () => {
    // The toggle path never touches completion fields or the completion RPC.
    expect(toggleBody).not.toContain('markProcessingComplete');
    expect(toggleBody).not.toContain('completed_by');
    expect(toggleBody).not.toMatch(/record\.completed_at\s*=/);
  });
});

describe('schedule — narrow row patch instead of a page reload', () => {
  it('the view passes the narrow counts callback and keeps the full load for generic mutations', () => {
    expect(view).toContain('onSubtaskCountsChanged={patchRecordSubtaskCounts}');
    expect(view).toContain('onChanged={load}');
  });

  it('patchRecordSubtaskCounts patches records state in place and never calls load', () => {
    const body = slice(view, 'const patchRecordSubtaskCounts', '// Drawer-open deep links', 'patchRecordSubtaskCounts');
    expect(body).toMatch(/setRecords\(\(rows\) =>/);
    expect(body).toMatch(/subtask_done: counts\.done, subtask_total: counts\.total/);
    expect(body).not.toMatch(/\bload\(\)/);
    expect(body).not.toContain('setLoading');
  });
});

describe('drawer — Source details never duplicates Processor/Customer rows', () => {
  it('no program renders a Processor or Customer row inside Source details', () => {
    expect(sourceDetails).not.toContain('label="Processor"');
    expect(sourceDetails).not.toContain('label="Customer"');
  });

  it('the editable Processor/Customer selects above Source details remain', () => {
    expect(drawer).toContain('data-processing-processor-select');
    expect(drawer).toContain('data-processing-customer-select');
  });
});
