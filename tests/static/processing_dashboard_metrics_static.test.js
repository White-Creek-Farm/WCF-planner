import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the Processing dashboard metrics lane:
//   1) The combined Head Count tile is retired — species are not comparable,
//      so no code path may reduce broilers/cattle/lambs/pigs into one number.
//   2) Row 1 keeps exactly the three operational summaries (Batches
//      scheduled · Completed · Due in 14 days); row 2 shows the selected
//      year's completed processing total per program with a restrained
//      program-dot accent and a truthful incomplete-data disclosure.
//   3) Program filter chips count BATCH records only (milestones excluded)
//      while milestone rows stay visible in the schedule and Add milestone
//      behavior is untouched.
// Behavior-level counting proofs live in
// src/lib/processingDashboardMetrics.test.js.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const view = read('src/processing/ProcessingCalendarView.jsx');
const metrics = read('src/lib/processingDashboardMetrics.js');

describe('combined Head Count retirement', () => {
  it('removes the Head count tile and its "animals processed" subtitle', () => {
    expect(view).not.toContain('Head count');
    expect(view).not.toContain('animals processed');
    expect(view).not.toMatch(/stats\.head\b/);
  });

  it('no code path reduces all species into one head total', () => {
    // The stats memo no longer carries a cross-program animal sum...
    expect(view).not.toMatch(/\bhead:\s/);
    expect(view).not.toMatch(/batchRows\.reduce\(/);
    // ...and the view never adds one program's completed total to another's.
    expect(view).not.toMatch(/completedProgramTotals[\s\S]{0,120}?\.total\s*\+/);
    // The pure module exposes per-program buckets only — no all/combined key.
    expect(metrics).toMatch(
      /PROCESSING_DASHBOARD_PROGRAM_KEYS = Object\.freeze\(\['broiler', 'cattle', 'sheep', 'pig'\]\)/,
    );
    expect(metrics).not.toMatch(/totals\.all\b/);
  });
});

describe('stat rows', () => {
  it('row 1 contains exactly the three existing operational summary tiles', () => {
    expect(view.match(/<StatCard /g)).toHaveLength(3);
    expect(view).toContain('<StatCard label="Batches scheduled" value={stats.scheduled}');
    expect(view).toContain('<StatCard label="Completed" value={stats.completed}');
    expect(view).toContain('<StatCard label="Due in 14 days" value={stats.dueSoon}');
    // The three keep their existing calculations (batch rows of the selected
    // year; completion by the canonical display label; 14-day due window).
    expect(view).toMatch(/const batchRows = yearRows\.filter\(\(r\) => r\._isBatch\);/);
    expect(view).toMatch(/const scheduled = batchRows\.length;/);
    expect(view).toMatch(/r\._statusLabel === PROCESSING_STATUS_DISPLAY\.complete\).length;/);
    expect(view).toMatch(/addDaysISO\(t0, 14\)/);
  });

  it('row 2 renders the four per-program annual totals in schedule order (Lamb == sheep, plural labels)', () => {
    expect(view).toMatch(
      /const PROGRAM_TOTAL_LABELS = \{\s*broiler: 'Broilers processed',\s*cattle: 'Cattle processed',\s*sheep: 'Lambs processed',\s*pig: 'Pigs processed',\s*\};/,
    );
    // The tiles map over PROGRAMS (the locked broiler → cattle → sheep → pig
    // order) and read the pure per-program totals.
    expect(view).toMatch(/\{PROGRAMS\.map\(\(p\) => \{\s*const totals = stats\.completedProgramTotals\[p\.key\];/);
    expect(view).toContain('completedProgramTotals: computeCompletedProgramTotals(yearRows)');
    expect(view).toContain('data-processing-program-total={programKey}');
    expect(view).toContain('data-processing-program-total-value={programKey}');
  });

  it('makes the Year scope visible on the compact tiles and keeps them reactive to the Year control', () => {
    // Every ProgramTotalCard receives the selected year and renders it.
    expect(view).toMatch(/<ProgramTotalCard[\s\S]*?year=\{year\}/);
    expect(view).toMatch(
      /function ProgramTotalCard\(\{programKey, label, total, missingCount, year\}\)[\s\S]*?\{`in \$\{year\}`\}/,
    );
    // Totals derive from yearRows (the selected-year base set), so a Year
    // change recomputes all four tiles.
    expect(view).toMatch(/const stats = useMemo\(\(\) => \{[\s\S]*?\}, \[yearRows\]\);/);
  });

  it('keeps the program accent restrained (dot only) and the incomplete-data disclosure truthful', () => {
    const card = view.slice(
      view.indexOf('function ProgramTotalCard('),
      view.indexOf('// eslint-disable-next-line no-unused-vars -- Header'),
    );
    expect(card).toContain('programDotStyle(programKey, 8)');
    // Neutral tile surface — the program color never becomes the background.
    expect(card).toContain('background: T.card');
    expect(card).not.toContain('getProgramColor');
    // Missing completed-row counts are disclosed, never silently zeroed.
    expect(card).toContain('data-processing-program-total-incomplete={programKey}');
    expect(card).toContain('missing count');
  });

  it('keeps the rows responsive via auto-fit grids that wrap on narrow screens', () => {
    expect(view).toContain("gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))'");
    expect(view).toContain("gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))'");
    expect(view).not.toContain("gridTemplateColumns: 'repeat(4, 1fr)'");
  });
});

describe('batch-only program chips', () => {
  it('chip counts route through the batch-only pure helper (search/year filtering upstream)', () => {
    expect(view).toMatch(
      /const programCounts = useMemo\(\(\) => computeProgramChipCounts\(commonRows\), \[commonRows\]\);/,
    );
    // The old milestone-inclusive counting shapes may not return.
    expect(view).not.toMatch(/\{all: commonRows\.length\}/);
    expect(view).not.toMatch(/counts\[p\.key\] = commonRows\.filter/);
    // The helper is fail-closed: milestone rows are skipped, the canonical
    // program key is resolved and gated FIRST, and 'All' increments only
    // alongside a recognized program bucket — so All can never drift from
    // broiler + cattle + sheep + pig.
    expect(metrics).toMatch(
      /computeProgramChipCounts[\s\S]*?if \(!isBatchRecord\(rec\)\) continue;\s*const key = programKeyOf\(rec\);[\s\S]*?if \(!PROCESSING_DASHBOARD_PROGRAM_KEYS\.includes\(key\)\) continue;\s*counts\[key\] \+= 1;\s*counts\.all \+= 1;/,
    );
  });

  it('section headers count batches truthfully and disclose milestones separately', () => {
    // The per-section header derives a BATCH-only count with the same
    // predicate the chips use (same commonRows base, _isBatch rows only)...
    expect(view).toMatch(/const batchCount = rows\.filter\(\(r\) => r\._isBatch\)\.length;/);
    expect(view).toMatch(/milestoneCount: rows\.length - batchCount/);
    // ...renders it as the "N batch(es)" label...
    expect(view).toMatch(/\{sec\.batchCount\} \{sec\.batchCount === 1 \? 'batch' : 'batches'\}/);
    // ...never calls a milestone a batch (the old all-rows count is retired)...
    expect(view).not.toMatch(/\{sec\.rows\.length\} \{sec\.rows\.length === 1 \? 'batch' : 'batches'\}/);
    // ...and milestone rows are disclosed as milestones when present.
    expect(view).toMatch(/\{sec\.milestoneCount === 1 \? 'milestone' : 'milestones'\}/);
    expect(view).toContain('data-processing-section-count');
  });

  it('milestones stay visible in the schedule and Add milestone behavior is untouched', () => {
    // Sections still enumerate ALL common rows (no batch-only filter), so
    // milestone rows keep their existing schedule locations...
    expect(view).toContain(
      'sortProcessingRecordsForDisplay(commonRows.filter((r) => (r.program || r.source_kind) === p.key))',
    );
    // ...milestone presentation still exists...
    expect(view).toMatch(/_isMilestone: rec\.record_type === 'milestone'/);
    expect(view).toContain("isMilestone ? 'Milestone' : checklistMeta");
    // ...and the global Add milestone entry point is unchanged.
    expect(view).toContain('data-processing-add-milestone-btn="1"');
    expect(view).toContain('<AddMilestoneModal');
  });
});
