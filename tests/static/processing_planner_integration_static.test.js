import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the processing-planner-integration lane (migs 175/176/177
// + the client rewiring):
//   • mig 175 — additive foundation: fail-closed broiler identity rekey
//     (source_id name -> immutable ppp-v4 batch.id), the (source_kind,
//     source_id) partial-unique identity index left untouched;
//   • mig 176 — lifecycle + reconcile: broiler enumerated BY BATCH ID with the
//     mutable name as title; pig enumerated from BOTH plannedProcessingTrips
//     and processingTrips (promotion keeps the record); the stale-row sweep
//     applies worked-archive vs empty-delete via _processing_record_worked;
//     completion blockers gate on begun-date (farm timezone America/Chicago)
//     and a positive live Count; the planner upsert NEVER copies source
//     status (Processing owns lifecycle) and stamps template_step_id on the
//     one-time checklist seed;
//   • mig 177 — workflow integration: the Asana subtask importer permanently
//     ignores due_on/start_on; notifications gain the
//     processing_subtask_assigned type; the profile correction fails closed
//     on email resolution + operational role;
//   • client — every pig planned/actual mutation routes through the SECDEF
//     wrappers in src/lib/pigPlannerApi.js (no app_store JSON surgery), and
//     the calendar renders the server-derived effective_status + searches the
//     server-built search_text.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig175 = read('supabase-migrations/175_processing_planner_foundation.sql');
const mig176 = read('supabase-migrations/176_processing_lifecycle_reconcile.sql');
const mig177 = read('supabase-migrations/177_processing_workflow_integration.sql');
const pigApi = read('src/lib/pigPlannerApi.js');
const view = read('src/processing/ProcessingCalendarView.jsx');

// Extract one CREATE OR REPLACE FUNCTION body (same $fn$ convention as the
// other processing migrations).
function fnBody(sql, name) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\b[\\s\\S]*?\\$fn\\$;');
  const m = sql.match(re);
  return m ? m[0] : '';
}

describe('mig 175 — foundation: broiler rekey fails closed; identity index untouched', () => {
  it('the broiler rekey aborts when a LIVE name resolves to anything but exactly one batch', () => {
    expect(mig175).toContain(
      'rekey failed closed — record % source_id % resolves to % batches by name (need exactly 1)',
    );
    expect(mig175).toContain('rekey failed closed — batch named % has no id in ppp-v4');
    // Archived tombstones are skipped (unfixable history never blocks) — the
    // fail-closed RAISE applies to unarchived rows only.
    expect(mig175).toMatch(/IF v_rec\.archived THEN\s*\n\s*CONTINUE;/);
    expect(mig175).toMatch(/IF v_by_name <> 1 THEN/);
  });

  it('leaves the (source_kind, source_id) partial-unique identity index alone', () => {
    // The rekey RELIES on the pre-existing partial-unique index to refuse two
    // rows collapsing onto one batch id — 175 may reference it but must not
    // drop, recreate, or weaken it.
    expect(mig175).toContain('partial-unique index');
    expect(mig175).not.toMatch(/DROP INDEX/i);
    expect(mig175).not.toMatch(/CREATE UNIQUE INDEX/i);
    expect(mig175).not.toMatch(/DROP CONSTRAINT/i);
  });
});

describe('mig 176 — reconcile enumerates the live planner sources correctly', () => {
  const reconcile = fnBody(mig176, 'reconcile_planner_to_processing');
  const groupSync = fnBody(mig176, '_pig_sync_group_records');

  it('broiler rows key on the immutable batch.id; the mutable name is only the title', () => {
    expect(reconcile).toContain("'source_id', btrim(v_b->>'id')");
    expect(reconcile).toContain("'title', COALESCE(NULLIF(btrim(COALESCE(v_b->>'name','')), ''), btrim(v_b->>'id'))");
    // Only batches with a processing date project a record; id-less rows skip.
    expect(reconcile).toContain("CONTINUE WHEN COALESCE(btrim(COALESCE(v_b->>'id','')), '') = '';");
  });

  it('pig enumerates BOTH plannedProcessingTrips and processingTrips (planned first, actual restamps)', () => {
    for (const body of [reconcile, groupSync]) {
      const plannedIdx = body.indexOf("'plannedProcessingTrips'");
      const actualIdx = body.indexOf("'processingTrips'", plannedIdx + 1);
      expect(plannedIdx).toBeGreaterThan(-1);
      expect(actualIdx).toBeGreaterThan(plannedIdx);
      expect(body).toContain("'source_phase', 'planned'");
      expect(body).toContain("'source_phase', 'actual'");
    }
    // Same groupId:tripId identity namespace in both loops (promotion keeps
    // the Processing record).
    expect(reconcile).toContain("(v_g->>'id') || ':' || (v_t->>'id')");
  });

  it('the reconcile ends with the sweep + the freshness stamp', () => {
    expect(reconcile).toContain('public._processing_sweep_stale_planner_rows(v_run, NULL, NULL)');
    expect(reconcile).toContain('last_planner_reconcile_at = now()');
  });
});

describe('mig 176 — sweep: worked rows archive dormant, untouched rows delete', () => {
  it('_processing_sweep_stale_planner_rows branches on _processing_record_worked', () => {
    const body = fnBody(mig176, '_processing_sweep_stale_planner_rows');
    expect(body).toContain('IF public._processing_record_worked(v_rec.id) THEN');
    // Worked-archive branch: dormant, restorable (archived + stamp + lineage).
    expect(body).toMatch(/SET archived = true, source_removed_at = now\(\)/);
    expect(body).toContain("'event', 'source_removed'");
    // Empty-remove branch: an untouched auto-created row is deleted outright.
    expect(body).toMatch(/ELSE\s*\n\s*DELETE FROM public\.processing_records WHERE id = v_rec\.id;/);
    // The predicate itself is defined in 175 (seeded template steps alone do
    // not make a record worked).
    expect(mig175).toContain('CREATE OR REPLACE FUNCTION public._processing_record_worked');
    expect(mig175).toMatch(/s\.source = 'native'\s*\n\s*AND s\.template_step_id IS NULL/);
  });
});

describe('mig 176 — completion blockers: begun date (farm tz) + positive live Count', () => {
  it('gates on has-not-begun + zero count, in America/Chicago', () => {
    const blockers = fnBody(mig176, '_processing_completion_blockers');
    expect(blockers).toContain("'Processing Date has not begun'");
    expect(blockers).toContain("'Count must be greater than zero'");
    expect(blockers).toContain('public._processing_today_chicago()');
    expect(blockers).toContain('public._processing_live_source_count(v_rec)');
    expect(fnBody(mig176, '_processing_today_chicago')).toContain("'America/Chicago'");
  });
});

describe('mig 176 — planner upsert: Processing owns status; seeds carry template_step_id', () => {
  const body = fnBody(mig176, 'upsert_processing_from_planner');
  it('the UPDATE branch never copies planner status or touches completion', () => {
    const updateBranch = body.slice(body.indexOf('IF FOUND THEN'), body.indexOf("'updated'"));
    expect(updateBranch.length).toBeGreaterThan(0);
    // No `status =` assignment (match_status is planner bookkeeping, allowed).
    expect(updateBranch).not.toMatch(/(?<![A-Za-z_])status\s*=/);
    expect(updateBranch).not.toContain('completed_at');
  });
  it("the INSERT branch starts every planner row at literal 'planned'", () => {
    const insertBranch = body.slice(body.indexOf("'updated'"));
    expect(insertBranch).toMatch(/'planned', \(p_row->>'number_processed'\)::int,/);
  });
  it('the one-time checklist seed stamps the stable template step id', () => {
    const seedIdx = body.indexOf('INSERT INTO public.processing_subtasks');
    expect(seedIdx).toBeGreaterThan(body.indexOf("'updated'")); // insert branch only
    const seed = body.slice(seedIdx);
    expect(seed).toContain('template_step_id');
    expect(seed).toContain("NULLIF(btrim(COALESCE(v_step->>'id', '')), '')");
  });
});

describe('mig 177 — importer scheduling ban, notification type, fail-closed correction', () => {
  it('the reissued Asana subtask importer ignores due_on/start_on on BOTH branches', () => {
    const body = fnBody(mig177, 'upsert_processing_subtask_from_asana');
    expect(body).toContain('due_on / start_on intentionally ignored (177)');
    // UPDATE branch: no due_on/start_on assignment survives.
    expect(body).not.toMatch(/due_on\s*=\s*COALESCE/);
    expect(body).not.toMatch(/start_on\s*=\s*COALESCE/);
    // INSERT branch: the columns are pinned to NULL, never read from p_row.
    expect(body).toMatch(/v_gid,\s*\n\s*NULL, NULL,/);
    expect(body).not.toContain("(p_row->>'due_on')");
    expect(body).not.toContain("(p_row->>'start_on')");
  });

  it("notifications_type_check includes 'processing_subtask_assigned'", () => {
    expect(mig177).toMatch(
      /ADD CONSTRAINT notifications_type_check\s*\n\s*CHECK \(type IN \([\s\S]*?'processing_subtask_assigned'\)\)/,
    );
  });

  it('correct_processing_imported_assignee fails closed on identity AND role', () => {
    const body = fnBody(mig177, 'correct_processing_imported_assignee');
    expect(body).toContain('resolves to % profiles (need exactly 1)');
    expect(body).toMatch(/NOT IN \('farm_team', 'management', 'admin'\)/);
    expect(body).toContain('is not authorized for Processing');
    // Silent data correction: no notification fan-out from this path.
    expect(body).not.toContain('_processing_notify_assignment');
  });
});

describe('client — pig mutations route through the SECDEF wrappers only', () => {
  it('src/lib/pigPlannerApi.js exports all 8 wrappers', () => {
    for (const name of [
      'pigAddPlannedTrip',
      'pigSetPlannedTripDate',
      'pigMovePlannedPigs',
      'pigDeletePlannedTrip',
      'pigSendToTrip',
      'pigUndoSend',
      'pigUpdateProcessingTrip',
      'pigDeleteProcessingTrip',
    ]) {
      expect(pigApi, `pigPlannerApi exports ${name}`).toMatch(new RegExp(`export async function ${name}\\b`));
    }
  });

  it('the pig client flows import from pigPlannerApi (no client-side feeders JSON surgery)', () => {
    for (const rel of [
      'src/pig/usePigPlannedTrips.js',
      'src/pig/usePigProcessingTrips.js',
      'src/livestock/WeighInSessionPage.jsx',
    ]) {
      expect(read(rel), `${rel} imports pigPlannerApi`).toMatch(/from '\.\.\/lib\/pigPlannerApi\.js'/);
    }
  });

  it('the calendar consumes the server-derived effective_status and search_text', () => {
    expect(view).toContain('processingStatusLabel(rec.effective_status)');
    expect(view).toContain('r.search_text');
  });
});
