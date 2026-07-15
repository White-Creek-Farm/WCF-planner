import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the Processing finish-out cleanup sub-lanes, updated for
// the planner-integration lane's FIXED per-program tables:
//   1) main table — per-program fixed column sets (PROGRAM_TABLES), no
//      Subtasks column, checklist meta inside the Batch cell, sticky first
//      columns, admin maintenance area still gone
//   2) server-derived broiler Time-on-Farm (mig 160) kept as DATA; the client
//      DISPLAYS broiler age from the live projection instead
//   3) soft archive_processing_record (mig 161) + drawer control

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const view = read('src/processing/ProcessingCalendarView.jsx');
const drawer = read('src/processing/ProcessingDrawer.jsx');
const sourceLink = read('src/lib/processingSourceLink.js');
const api = read('src/lib/processingApi.js');
const mig160 = read('supabase-migrations/160_processing_broiler_tof.sql');
const mig161 = read('supabase-migrations/161_processing_archive_record.sql');

describe('sub-lane 1 — main table cleanup', () => {
  it('keeps the Subtasks COLUMN out; checklist meta lives inside the Batch cell', () => {
    // A dedicated Subtasks column must not return. The processing-complete lane
    // restored the handoff Batch-cell meta line ("N-step checklist · done/total"),
    // which is the ONLY sanctioned subtask surface in the table.
    expect(view).not.toContain('>Subtasks</span>');
    expect(view).toMatch(/const checklistMeta =[\s\S]*?-step checklist/);
  });

  it('renders FIXED per-program column sets (PROGRAM_TABLES) — the single shared GRID is retired', () => {
    // Planner-integration lane: one column vocabulary composed per program.
    //   broiler  Batch · Status · Hatch date · Processing date · Processor ·
    //            Count · Customer
    //   cattle   Batch · Status · Processing date · Processor · Count · Age
    //   sheep    (as cattle; section labelled 'Lamb')
    //   pig      Batch · Trip · Status · Processing date · Processor · Count ·
    //            Age (Batch leads and is the sticky identity column)
    expect(view).not.toMatch(/const GRID = '/);
    expect(view).toContain("broiler: ['batch', 'status', 'hatch', 'processing', 'processor', 'count', 'customer']");
    expect(view).toContain("cattle: ['batch', 'status', 'processing', 'processor', 'count', 'age']");
    expect(view).toContain("pig: ['batch', 'trip', 'status', 'processing', 'processor', 'count', 'age']");
    expect(view).toContain("sheep: ['batch', 'status', 'processing', 'processor', 'count', 'age']");
    // Program sections render in the locked order Broiler · Cattle ·
    // Sheep/Lamb · Pig; Trip is a regular (non-sticky) column because it
    // follows the flexible-width Batch column.
    expect(view).toMatch(
      /const PROGRAMS = \[\s*\{key: 'broiler'[\s\S]*?\{key: 'cattle'[\s\S]*?\{key: 'sheep'[\s\S]*?\{key: 'pig'[\s\S]*?\];/,
    );
    expect(view).toMatch(/trip: \{key: 'trip', label: 'Trip', width: '64px'\}/);
    // The count column is labelled 'Count' — the old 'Number' label may not
    // return as a column label, and no 'Farm arrival' column exists anywhere
    // (label-level assertions: the header comment documents the retirement).
    expect(view).toMatch(/label: 'Count'/);
    expect(view).not.toMatch(/label: 'Number'/);
    expect(view).not.toMatch(/label: 'Farm arrival'/);
    // The pig Trip column + broiler Hatch date column exist in the vocabulary.
    expect(view).toMatch(/label: 'Trip'/);
    expect(view).toMatch(/label: 'Hatch date'/);
    // Every missing source value renders the canonical 'Not recorded' text.
    expect(view).toContain('NOT_RECORDED');
    expect(view).toMatch(/displayOrNotRecorded\(/);
    // Search runs over the server-built search_text with a title fallback.
    expect(view).toContain('r.search_text');
  });

  it('keeps the leading columns sticky per program (check cell, sticky cols, group-header label)', () => {
    // stickyCellStyle pins the 20px check column at left:0 and each
    // PROGRAM_TABLES column marked sticky at its accumulated left offset; the
    // LAST sticky column carries the divider shadow.
    expect(view).toContain('function stickyCellStyle(');
    expect(view).toContain('stickyCellStyle(0, rowBg)'); // check cell (data row)
    expect(view).toContain('stickyCellStyle(0, T.tint)'); // check cell (header)
    expect(view).toMatch(/col\.sticky \? stickyCellStyle\(col\.left, rowBg, col\.lastSticky\)/);
    expect(view).toMatch(/col\.sticky \? stickyCellStyle\(col\.left, T\.tint, col\.lastSticky\)/);
    expect(view).toMatch(/position: 'sticky',\s*\n\s*left: 16/); // group-header label
  });

  it('the Admin maintenance panel is gone; Templates is direct; retired filters stay removed', () => {
    // UI-simplification lane: no collapsed Admin area, no Asana import controls.
    expect(view).not.toContain('data-processing-admin-toggle');
    expect(view).not.toContain('data-processing-admin-panel');
    expect(view).not.toContain('adminOpen');
    expect(view).toContain('data-processing-templates-btn="1"');
    expect(view).not.toContain('data-processing-show-archived');
    expect(view).not.toContain('data-processing-status-filter');
    expect(view).not.toContain('data-processing-processor-filter');
    expect(view).toContain('data-processing-search');
    // "+ Add milestone" stays in the normal workflow.
    expect(view).toContain('data-processing-add-milestone-btn="1"');
  });
});

describe('sub-lane 2 — broiler Time-on-Farm (server derivation kept, display retired)', () => {
  it('mig 160 derives time_on_farm_days server-side in both RPCs (processing − hatch from ppp-v4)', () => {
    expect(mig160).toContain('CREATE OR REPLACE FUNCTION public.list_processing_records');
    expect(mig160).toContain('CREATE OR REPLACE FUNCTION public.get_processing_record');
    expect(mig160).toContain("'time_on_farm_days'");
    expect(mig160).toContain("key = 'ppp-v4'");
    expect(mig160).toMatch(/processingDate[\s\S]*?hatchDate[\s\S]*?::date/);
    // Read-only derivation; no schema/table/CHECK change.
    expect(mig160).not.toContain('ALTER TABLE');
    expect(mig160).not.toMatch(/ADD CONSTRAINT|DROP CONSTRAINT/);
    expect(mig160).toContain(
      'GRANT EXECUTE ON FUNCTION public.list_processing_records(int, text, boolean) TO authenticated',
    );
  });

  it('the client never renders time_on_farm_days; Age comes from the LIVE source projection', () => {
    // 'Time on farm' as a display concept stays retired. The broiler Age that
    // replaced it derives from the live planner projection (source.age_days),
    // never the record's backward-compatible time_on_farm_days data column.
    expect(sourceLink).toContain('export function weeksDaysText');
    expect(view).not.toContain('time_on_farm_days');
    expect(view).not.toContain('_timeOnFarmText');
    expect(drawer).not.toContain('time_on_farm_days');
    expect(drawer).not.toContain('Time on farm');
    // Table: one program-aware Age cell (recordAgeText reads the projection);
    // the broiler layout carries no Age column at all (see PROGRAM_TABLES).
    expect(view).toMatch(/recordAgeText\(rec\)/);
    // Drawer: broiler Age renders weeks/days from the projection; cattle/sheep
    // render the live age range.
    expect(drawer).toContain('weeksDaysText(source.age_days)');
    expect(drawer).toContain('ageRangeText(source.age, yearsMonthsText)');
  });
});

describe('sub-lane 3 — soft archive controls', () => {
  it('mig 161 archive_processing_record is SECDEF, operational-gated, refuses planner_batch, preserves links', () => {
    expect(mig161).toContain('CREATE OR REPLACE FUNCTION public.archive_processing_record');
    expect(mig161).toContain('SECURITY DEFINER');
    expect(mig161).toContain('public._processing_require_operational()');
    expect(mig161).toMatch(/v_type = 'planner_batch'[\s\S]*?cannot be archived/);
    // Soft delete only: sets archived, never DELETEs the record or the link.
    expect(mig161).toContain('SET archived = COALESCE(p_archived, true)');
    expect(mig161).not.toContain('DELETE FROM');
    expect(mig161).toContain(
      'GRANT EXECUTE ON FUNCTION public.archive_processing_record(text, boolean) TO authenticated',
    );
  });

  it('api + drawer expose archive with a confirmation', () => {
    expect(api).toContain('export async function archiveProcessingRecord');
    expect(api).toContain("sb.rpc('archive_processing_record'");
    expect(drawer).toContain('archiveProcessingRecord(sb, record.id, true)');
    expect(drawer).toContain('data-processing-record-archive');
    expect(drawer).toContain('data-processing-record-archive-confirm');
    // Only Asana-owned rows are archivable in the drawer (planner refused server-side).
    expect(drawer).toContain("['asana_historical', 'import_exception'].includes(record.record_type)");
  });
});
