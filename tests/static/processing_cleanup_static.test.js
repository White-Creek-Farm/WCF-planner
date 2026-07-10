import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the Processing finish-out cleanup sub-lanes:
//   1) main-table Subtasks column removed + sticky title column + admin maintenance area
//   2) server-derived broiler Time-on-Farm (mig 160)
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
    // processing-complete GRID: check · Batch · Owner · Status · Farm arrival ·
    // Processing · Processor · Number · Customer · Age/TOF · Remaining · chevron.
    expect(view).toContain(
      "const GRID = '20px minmax(190px,1fr) 118px 96px 92px 92px 128px 72px 132px 88px 92px 20px'",
    );
  });

  it('makes the title/batch column sticky (header, rows, group-header label)', () => {
    expect(view).toContain('function stickyFirst(');
    expect(view).toContain('...stickyFirst(T.tint)'); // header
    expect(view).toContain('...stickyFirst(rowBg)'); // data row
    expect(view).toMatch(/position: 'sticky',\s*\n\s*left: 16/); // group-header label
  });

  it('collapses the one-time admin controls into a maintenance area (out of the day-to-day toolbar)', () => {
    expect(view).toContain('data-processing-admin-toggle="1"');
    expect(view).toContain('data-processing-admin-panel="1"');
    expect(view).toContain('const [adminOpen, setAdminOpen] = useState(false)');
    // The one-time controls live inside the collapsed panel now.
    for (const marker of [
      'data-processing-asana-dry-run-btn="1"',
      'data-processing-asana-sync-btn="1"',
      'data-processing-reconciliation-btn="1"',
      'data-processing-templates-btn="1"',
    ]) {
      expect(view).toContain(marker);
    }
    // "+ Add milestone" stays in the normal workflow.
    expect(view).toContain('data-processing-add-milestone-btn="1"');
  });
});

describe('sub-lane 2 — broiler Time-on-Farm', () => {
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

  it('client formats the server value with the shared weeksDaysText (table + drawer)', () => {
    expect(sourceLink).toContain('export function weeksDaysText');
    expect(view).toContain('weeksDaysText(rec.time_on_farm_days)');
    expect(drawer).toContain('weeksDaysText(record.time_on_farm_days)');
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
