import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig = fs.readFileSync(path.join(ROOT, 'supabase-migrations/155_processing_calendar.sql'), 'utf8');

// Slice one CREATE OR REPLACE FUNCTION body (up to its $fn$; terminator) so a
// scoped assertion cannot be satisfied by an unrelated function elsewhere in the
// file. All the plpgsql functions we scope here dollar-quote with $fn$.
function fnBlock(name) {
  const marker = 'FUNCTION public.' + name + '(';
  const start = mig.indexOf('CREATE OR REPLACE ' + marker);
  const from = start >= 0 ? start : mig.indexOf(marker);
  if (from < 0) return '';
  const end = mig.indexOf('$fn$;', from);
  return end < 0 ? mig.slice(from) : mig.slice(from, end);
}

const TABLES = [
  'processing_records',
  'processing_subtasks',
  'processing_attachments',
  'processing_templates',
  'processing_import_exceptions',
  'processing_asana_sync_runs',
  'processing_asana_sync_settings',
];

const IMPORTER_RPCS = [
  'upsert_processing_from_asana',
  'upsert_processing_subtask_from_asana',
  'record_processing_attachment',
  'record_processing_import_exception',
  'start_processing_sync_run',
  'finish_processing_sync_run',
];

const CLIENT_RPCS = [
  'list_processing_records',
  'get_processing_record',
  'get_processing_settings',
  'list_processing_templates',
  'create_processing_milestone',
  'update_processing_milestone',
  'delete_processing_milestone',
  'set_processing_processor',
  'set_processing_customer',
  'mark_processing_complete',
  'reopen_processing_record',
  'add_processing_subtask',
  'update_processing_subtask',
  'set_processing_subtask_done',
  'delete_processing_subtask',
  'apply_current_template',
];

const ADMIN_ONLY_RPCS = ['upsert_processing_template', 'hard_delete_processing_record', 'set_asana_sync_enabled'];

// Every entity_type _activity_can_read handled BEFORE mig 155 was authored. The
// re-issued function must preserve all of them (it is a full re-emit, not a
// partial), plus add processing.record.
const PRIOR_ENTITY_TYPES = [
  'task.instance',
  'broiler.batch',
  'pig.batch',
  'pig.breeder',
  'layer.batch',
  'layer.housing',
  'cattle.animal',
  'cattle.processing',
  'cattle.forecast',
  'cattle.breeding',
  'sheep.animal',
  'sheep.processing',
  'equipment.item',
  'equipment.fuel_bill',
  'poultry.daily',
  'layer.daily',
  'egg.daily',
  'pig.daily',
  'cattle.daily',
  'sheep.daily',
  'weighin.session',
  'cattle.log',
  'todo.item',
];

describe('mig 155 — tables: deny-all RLS + REVOKE from public roles', () => {
  for (const t of TABLES) {
    it(`creates ${t} with RLS enabled, a ${t}_deny_all FOR ALL USING (false) policy, and REVOKEs public roles`, () => {
      expect(mig, `${t} table missing`).toMatch(new RegExp('CREATE TABLE IF NOT EXISTS public\\.' + t + '\\b'));
      expect(mig, `${t} RLS not enabled`).toMatch(
        new RegExp('ALTER TABLE public\\.' + t + '\\s+ENABLE ROW LEVEL SECURITY'),
      );
      expect(mig, `${t} deny-all policy missing`).toMatch(
        new RegExp('CREATE POLICY ' + t + '_deny_all ON public\\.' + t + '\\s+FOR ALL USING \\(false\\)'),
      );
      expect(mig, `${t} not revoked from public roles`).toMatch(
        new RegExp('REVOKE ALL ON TABLE public\\.' + t + ' FROM PUBLIC, anon, authenticated'),
      );
    });
  }
});

describe('mig 155 — SECURITY DEFINER hygiene', () => {
  it('every SECURITY DEFINER function pins SET search_path = public', () => {
    const secdef = (mig.match(/SECURITY DEFINER/g) || []).length;
    const withPath = (mig.match(/SECURITY DEFINER\s+SET search_path = public/g) || []).length;
    expect(secdef).toBeGreaterThan(0);
    expect(withPath).toBe(secdef);
  });
});

describe('mig 155 — operational gate denies light/equipment_tech/inactive', () => {
  const block = fnBlock('_processing_require_operational');

  it('restricts to farm_team/management/admin', () => {
    expect(block).not.toBe('');
    expect(block).toMatch(/NOT IN\s*\(\s*'farm_team'\s*,\s*'management'\s*,\s*'admin'\s*\)/);
  });

  it('never admits light, equipment_tech, or inactive', () => {
    expect(block).not.toContain("'light'");
    expect(block).not.toContain("'equipment_tech'");
    expect(block).not.toContain("'inactive'");
  });
});

describe('mig 155 — completion gate + manual completion', () => {
  const gate = fnBlock('_processing_completion_blockers');
  const complete = fnBlock('mark_processing_complete');
  const toggle = fnBlock('set_processing_subtask_done');

  it('gate enforces Processor + Processing Date', () => {
    expect(gate).toContain('Processor is required');
    expect(gate).toContain('Processing Date is required');
  });

  it('gate requires Number Processed only when the row is source-linked', () => {
    expect(gate).toMatch(/number_processed IS NULL[\s\S]*?source_id IS NOT NULL/);
    expect(gate).toContain('Number Processed');
  });

  it('gate blocks on open subtasks', () => {
    expect(gate).toMatch(/done = false/);
    expect(gate).toContain('subtask(s) still open');
  });

  it('mark_processing_complete RAISEs PROCESSING_VALIDATION when blockers exist', () => {
    expect(complete).toContain('_processing_completion_blockers');
    expect(complete).toMatch(
      /array_length\(v_blockers,\s*1\) IS NOT NULL[\s\S]*?RAISE EXCEPTION 'PROCESSING_VALIDATION/,
    );
  });

  it('toggling a subtask never auto-completes the parent record', () => {
    expect(toggle).not.toBe('');
    expect(toggle).not.toMatch(/UPDATE\s+public\.processing_records/);
  });
});

describe('mig 155 — Asana idempotency (keyed on asana_gid)', () => {
  const upsert = fnBlock('upsert_processing_from_asana');

  it('selects the existing record by asana_gid', () => {
    expect(upsert).toMatch(/SELECT id INTO v_id FROM public\.processing_records WHERE asana_gid = v_gid/);
  });

  it('branches insert vs update on the existing-gid result', () => {
    expect(upsert).toMatch(
      /IF v_exists THEN[\s\S]*?UPDATE public\.processing_records[\s\S]*?ELSE[\s\S]*?INSERT INTO public\.processing_records/,
    );
  });

  it('the three imported provenance gids are UNIQUE columns', () => {
    expect(mig).toMatch(/asana_gid\s+text UNIQUE/); // records + subtasks both
    expect((mig.match(/asana_gid\s+text UNIQUE/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(mig).toMatch(/asana_attachment_gid\s+text UNIQUE/);
  });
});

describe('mig 155 — importer RPCs are service_role only (never authenticated)', () => {
  for (const fn of IMPORTER_RPCS) {
    it(`${fn} GRANTed to service_role, REVOKEd from authenticated, NOT granted to authenticated`, () => {
      expect(mig, `${fn} not granted to service_role`).toMatch(
        new RegExp('GRANT EXECUTE ON FUNCTION public\\.' + fn + '\\([^)]*\\) TO service_role'),
      );
      expect(mig, `${fn} not revoked from authenticated`).toMatch(
        new RegExp('REVOKE ALL ON FUNCTION public\\.' + fn + '\\([^)]*\\) FROM PUBLIC, anon, authenticated'),
      );
      expect(mig, `${fn} must NOT be granted to authenticated`).not.toMatch(
        new RegExp('GRANT EXECUTE ON FUNCTION public\\.' + fn + '\\([^)]*\\) TO authenticated'),
      );
    });
  }
});

describe('mig 155 — client RPCs are granted to authenticated', () => {
  for (const fn of CLIENT_RPCS) {
    it(`${fn} GRANTed to authenticated`, () => {
      expect(mig, `${fn} not granted to authenticated`).toMatch(
        new RegExp('GRANT EXECUTE ON FUNCTION public\\.' + fn + '\\([^)]*\\) TO authenticated'),
      );
    });
  }
});

describe('mig 155 — admin-only gate on privileged RPCs', () => {
  for (const fn of ADMIN_ONLY_RPCS) {
    it(`${fn} requires role = admin`, () => {
      const block = fnBlock(fn);
      expect(block).not.toBe('');
      expect(block).toMatch(/v_role\s*<>\s*'admin'/);
    });
  }
});

describe('mig 155 — Activity resolver re-issue preserves every prior branch', () => {
  // The re-issued _activity_can_read is the last function; slice from its
  // definition to EOF so the branch assertions are scoped to that body.
  const canRead = mig.slice(mig.indexOf('CREATE OR REPLACE FUNCTION public._activity_can_read'));

  it('re-issues _activity_can_read', () => {
    expect(mig).toMatch(/CREATE OR REPLACE FUNCTION public\._activity_can_read/);
  });

  it('adds an existence-gated, operational-role processing.record branch', () => {
    expect(canRead).toMatch(
      /p_entity_type = 'processing\.record' THEN[\s\S]*?processing_records[\s\S]*?RETURN v_role IN \('farm_team','management','admin'\)/,
    );
  });

  for (const t of PRIOR_ENTITY_TYPES) {
    it(`still handles the ${t} branch`, () => {
      expect(canRead, `mig 155 dropped the ${t} branch`).toContain(`'${t}'`);
    });
  }

  it('re-REVOKEs anon, re-GRANTs authenticated, and reloads PostgREST', () => {
    expect(mig).toMatch(/REVOKE ALL ON FUNCTION public\._activity_can_read\(text, text\) FROM PUBLIC, anon/);
    expect(mig).toMatch(/GRANT EXECUTE ON FUNCTION public\._activity_can_read\(text, text\) TO authenticated/);
    expect(mig).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

describe('mig 155 — never writes source tables', () => {
  it('has no INSERT/UPDATE/DELETE against cattle, sheep, processing batches, or app_store', () => {
    const writeRe =
      /(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(cattle|sheep|cattle_processing_batches|sheep_processing_batches|app_store)\b/g;
    expect(mig.match(writeRe)).toBeNull();
  });

  it('only touches those source tables through read-only existence checks', () => {
    // The sole references are SELECT existence probes inside _activity_can_read.
    expect(mig).toMatch(/SELECT 1 FROM public\.cattle WHERE id = p_entity_id/);
    expect(mig).toMatch(/SELECT 1 FROM public\.sheep WHERE id = p_entity_id/);
  });
});
