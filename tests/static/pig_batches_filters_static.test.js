import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

import {
  PIG_BATCH_STATUSES,
  PIG_BATCH_FILTER_DIMENSIONS,
  PIG_BATCH_SORT_KEYS,
  buildPigBatchPredicate,
  buildPigBatchComparator,
} from '../../src/lib/pigBatchFilters.js';

// ============================================================================
// Pig Batches operational-list parity — static + behavioral locks
// ============================================================================
// Locks the right-sized filter/sort lib + its wiring into PigBatchesView:
//   - the pure lib exists with predicate + comparator + key/dimension constants
//   - the view imports the lib and the shared savedViewsApi
//   - the saved-view surface_key string 'pig.batches' is present
//   - the export is fed the filtered/sorted rows (visiblePigBatches), not raw
// The lib is pure (no React/Supabase) so its predicate/comparator are exercised
// directly here; Playwright remains the main behavioral proof for the toolbar.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const viewSrc = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchesView.jsx'), 'utf8');
const libSrc = fs.readFileSync(path.join(ROOT, 'src/lib/pigBatchFilters.js'), 'utf8');

describe('pigBatchFilters lib — shape', () => {
  it('exports the documented sort keys and filter dimensions', () => {
    expect(PIG_BATCH_SORT_KEYS).toEqual(['batchName', 'status', 'started', 'current', 'feedPerStarted', 'startDate']);
    expect(PIG_BATCH_FILTER_DIMENSIONS).toEqual([
      'textSearch',
      'status',
      'hasSubBatches',
      'startedRange',
      'startDateRange',
    ]);
    expect(PIG_BATCH_STATUSES).toEqual(['active', 'processed']);
  });

  it('exposes a predicate factory and a comparator factory', () => {
    expect(typeof buildPigBatchPredicate).toBe('function');
    expect(typeof buildPigBatchComparator).toBe('function');
    expect(typeof buildPigBatchPredicate({})).toBe('function');
    expect(typeof buildPigBatchComparator({key: 'status', dir: 'asc'})).toBe('function');
  });

  it('is a pure module — no React, Supabase, or browser globals', () => {
    expect(libSrc).not.toMatch(/from 'react'/);
    expect(libSrc).not.toMatch(/supabase/i);
    expect(libSrc).not.toMatch(/\bwindow\b/);
    expect(libSrc).not.toMatch(/\bdocument\b/);
  });
});

describe('buildPigBatchPredicate — real fields', () => {
  const rows = [
    {
      id: 'a',
      batchName: 'Group 1 Spring',
      status: 'active',
      giltCount: 10,
      boarCount: 4,
      startDate: '2026-01-10',
      subBatches: [],
    },
    {
      id: 'b',
      batchName: 'Group 2 Fall',
      status: 'active',
      giltCount: 6,
      boarCount: 0,
      startDate: '2026-03-01',
      subBatches: [{id: 's1', name: 'Pen A'}],
    },
    {
      id: 'c',
      batchName: 'Legacy Batch',
      status: 'processed',
      giltCount: 20,
      boarCount: 0,
      startDate: '2025-09-15',
      subBatches: [],
    },
  ];

  it('status filter narrows to a single status; "all" / absent keeps all', () => {
    expect(rows.filter(buildPigBatchPredicate({status: 'active'})).map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows.filter(buildPigBatchPredicate({status: 'processed'})).map((r) => r.id)).toEqual(['c']);
    expect(rows.filter(buildPigBatchPredicate({status: 'all'})).length).toBe(3);
    expect(rows.filter(buildPigBatchPredicate({})).length).toBe(3);
  });

  it('hasSubBatches filter splits partitioned vs flat batches', () => {
    expect(rows.filter(buildPigBatchPredicate({hasSubBatches: true})).map((r) => r.id)).toEqual(['b']);
    expect(rows.filter(buildPigBatchPredicate({hasSubBatches: false})).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('startedRange filters on gilts+boars (metric fallback) or the threaded metric', () => {
    expect(rows.filter(buildPigBatchPredicate({startedRange: {min: 14, max: null}})).map((r) => r.id)).toEqual([
      'a',
      'c',
    ]);
    // ctx metric overrides the gilt+boar fallback for the started dimension.
    const ctx = {metricsById: {a: {started: 2}, b: {started: 2}, c: {started: 2}}};
    expect(rows.filter(buildPigBatchPredicate({startedRange: {min: 14, max: null}}, ctx)).length).toBe(0);
  });

  it('startDateRange filters on the batch start date', () => {
    expect(
      rows.filter(buildPigBatchPredicate({startDateRange: {after: '2026-01-01', before: null}})).map((r) => r.id),
    ).toEqual(['a', 'b']);
    expect(
      rows.filter(buildPigBatchPredicate({startDateRange: {after: null, before: '2025-12-31'}})).map((r) => r.id),
    ).toEqual(['c']);
  });

  it('textSearch matches batch name, sub-batch name, and notes', () => {
    expect(rows.filter(buildPigBatchPredicate({textSearch: 'fall'})).map((r) => r.id)).toEqual(['b']);
    expect(rows.filter(buildPigBatchPredicate({textSearch: 'pen a'})).map((r) => r.id)).toEqual(['b']);
    expect(rows.filter(buildPigBatchPredicate({textSearch: 'legacy'})).map((r) => r.id)).toEqual(['c']);
  });
});

describe('buildPigBatchComparator — single rule + processed-below-active default', () => {
  const rows = [
    {id: 'p', batchName: 'Zeta', status: 'processed', startDate: '2025-01-01'},
    {id: 'a', batchName: 'Beta', status: 'active', startDate: '2026-02-01'},
    {id: 'b', batchName: 'Alpha', status: 'active', startDate: '2026-01-01'},
  ];

  it('always sorts processed batches below active ones regardless of the active key', () => {
    const sorted = [...rows].sort(buildPigBatchComparator({key: 'batchName', dir: 'asc'}));
    expect(sorted.map((r) => r.id)).toEqual(['b', 'a', 'p']);
  });

  it('sorts active status groups newest-first by batch name before processed rows', () => {
    const sorted = [
      {id: 'older', batchName: 'P-26-02', status: 'active'},
      {id: 'processed', batchName: 'P-28-01', status: 'processed'},
      {id: 'newer', batchName: 'P-27-01', status: 'active'},
    ].sort(buildPigBatchComparator({key: 'status', dir: 'asc'}));

    expect(sorted.map((r) => r.id)).toEqual(['newer', 'older', 'processed']);
  });

  it('sorts by batchName within the active block (numeric-aware locale compare)', () => {
    const sorted = [...rows].sort(buildPigBatchComparator({key: 'batchName', dir: 'desc'}));
    // active block desc: Beta, Alpha; processed always last.
    expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'p']);
  });

  it('sorts by startDate and by threaded numeric metrics (started/current/feedPerStarted)', () => {
    const byDate = [...rows].sort(buildPigBatchComparator({key: 'startDate', dir: 'asc'}));
    expect(byDate.map((r) => r.id)).toEqual(['b', 'a', 'p']);
    const ctx = {metricsById: {a: {started: 5}, b: {started: 50}, p: {started: 1}}};
    const byStartedDesc = [...rows].sort(buildPigBatchComparator({key: 'started', dir: 'desc'}, ctx));
    expect(byStartedDesc.map((r) => r.id)).toEqual(['b', 'a', 'p']);
  });

  it('accepts a one-element array sort rule (cattle/sheep-shaped) and falls back to status', () => {
    const arr = [...rows].sort(buildPigBatchComparator([{key: 'startDate', dir: 'asc'}]));
    expect(arr.map((r) => r.id)).toEqual(['b', 'a', 'p']);
    const bad = [...rows].sort(buildPigBatchComparator({key: 'nope', dir: 'asc'}));
    // Unknown key falls back to status grouping (processed last) — stable order.
    expect(bad[bad.length - 1].id).toBe('p');
  });
});

describe('PigBatchesView wiring', () => {
  it('imports the pig-batch filter lib (predicate + comparator + sort keys)', () => {
    expect(viewSrc).toMatch(
      /import \{[\s\S]*?PIG_BATCH_SORT_KEYS,[\s\S]*?buildPigBatchPredicate,[\s\S]*?buildPigBatchComparator,?[\s\S]*?\} from '\.\.\/lib\/pigBatchFilters\.js'/,
    );
  });

  it('imports the shared savedViewsApi (list/create/update/delete + buildViewState) read-only', () => {
    expect(viewSrc).toMatch(
      /import \{[\s\S]*?listSavedViews,[\s\S]*?createSavedView,[\s\S]*?updateSavedView,[\s\S]*?deleteSavedView,[\s\S]*?buildViewState,[\s\S]*?\} from '\.\.\/lib\/savedViewsApi\.js'/,
    );
  });

  it('uses the pig.batches saved-view surface_key for all saved-view CRUD', () => {
    expect(viewSrc).toMatch(/const PIG_BATCHES_SURFACE_KEY = 'pig\.batches'/);
    expect(viewSrc).toMatch(/listSavedViews\(sb, PIG_BATCHES_SURFACE_KEY\)/);
    expect(viewSrc).toMatch(/surfaceKey: PIG_BATCHES_SURFACE_KEY/);
  });

  it('builds view state via buildViewState with a single {key, dir} sort rule', () => {
    expect(viewSrc).toMatch(
      /buildViewState\(\{filters, sortRules: \[\{key: sortRule\.key, dir: sortRule\.dir\}\], viewMode: 'flat'\}\)/,
    );
  });

  it('applies predicate then comparator to produce the rendered/visible set', () => {
    expect(viewSrc).toMatch(/\.filter\(buildPigBatchPredicate\(filters, pigBatchFilterCtx\)\)/);
    expect(viewSrc).toMatch(/\.sort\(buildPigBatchComparator\(sortRule, pigBatchFilterCtx\)\)/);
  });

  it('feeds the FILTERED+SORTED rows (visiblePigBatches) to the export, never raw feederGroups', () => {
    // The export rows map over visiblePigBatches (the predicate+comparator
    // output), so CSV + print export the same set the operator sees.
    expect(viewSrc).toMatch(/const pigBatchExportRows = visiblePigBatches\.map\(/);
    // CSV + print consume pigBatchExportRows (the shared column builder is
    // reused unchanged).
    expect(viewSrc).toMatch(/rowsToCsv\(exportColumns, pigBatchExportRows\)/);
    expect(viewSrc).toMatch(/rows: pigBatchExportRows/);
    expect(viewSrc).toMatch(/buildPigBatchExportColumns\(\{fmt: fmtS\}\)/);
    expect(viewSrc).toContain('started_head: metrics.started');
    expect(viewSrc).toContain('gilts_feed_per_pig: metrics.gilts.feedPerPig');
    expect(viewSrc).toContain('boars_feed_per_pig: metrics.boars.feedPerPig');
  });

  it('passes the SORTED set as the record-sequence order to row click-through', () => {
    // renderPigBatchTile is fed visiblePigBatches as the sequence order, which
    // goToBatch turns into labeledSeqItems for record-page nav.
    expect(viewSrc).toMatch(/visiblePigBatches\.map\(\(g\) => renderPigBatchTile\(g, visiblePigBatches\)\)/);
  });

  it('renders the toolbar surfaces: search, status, sub-batch, ranges, sort, count, clear', () => {
    expect(viewSrc).toContain('data-pig-batches-search');
    expect(viewSrc).toContain('data-pig-batches-filter-status');
    expect(viewSrc).toContain('data-pig-batches-filter-subbatches');
    expect(viewSrc).toContain('data-pig-batches-filter-started-min');
    expect(viewSrc).toContain('data-pig-batches-filter-start-after');
    expect(viewSrc).toContain('data-pig-batches-sort-key');
    expect(viewSrc).toContain('data-pig-batches-sort-dir');
    expect(viewSrc).toContain('data-pig-batches-clear-filters');
    expect(viewSrc).toContain('data-pig-batches-count');
    expect(viewSrc).toContain('data-pig-batches-saved-view-select');
  });

  it('distinguishes true-empty from filtered-no-results', () => {
    expect(viewSrc).toContain('No pig batches yet');
    expect(viewSrc).toContain('data-pig-batches-no-match');
    expect(viewSrc).toContain('No pig batches match the current filters.');
  });

  it('saved-views load failure degrades gracefully (never blocks the list/filters)', () => {
    expect(viewSrc).toContain('data-pig-batches-saved-views-error');
    expect(viewSrc).toContain('Saved views unavailable. Filters still work.');
  });
});
