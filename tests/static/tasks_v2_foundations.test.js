import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Tasks v2 — migs 050-053 foundation contract locks (T1)
// ============================================================================
// Cheap regression net for the cardinal shape of each migration. Playwright
// covers behavior; this file locks the SQL surface so future edits can't
// silently change the contract.
//
//   050: task_instances v2 columns + FK SET NULL + system-rule unique.
//   051: due-date edits audit + photo sidecar + photo backfill.
//   052: task_system_rules + Simon/Mak fail-closed seed.
//   053: RLS overhaul + 6 SECURITY DEFINER RPCs.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const mig050 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/050_tasks_v2_instance_columns.sql'), 'utf8');
const mig051 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/051_tasks_v2_audit_and_photos.sql'), 'utf8');
const mig052 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/052_tasks_v2_system_rules.sql'), 'utf8');
const mig053 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/053_tasks_v2_rls_and_rpcs.sql'), 'utf8');

describe('Mig 050 — task_instances v2 columns', () => {
  it('adds the eight new columns including from_system_source_event_key', () => {
    expect(mig050).toMatch(/ADD COLUMN IF NOT EXISTS completion_note text/);
    expect(mig050).toMatch(/ADD COLUMN IF NOT EXISTS due_date_edit_count int NOT NULL DEFAULT 0/);
    expect(mig050).toMatch(/ADD COLUMN IF NOT EXISTS created_by_profile_id uuid REFERENCES public\.profiles\(id\)/);
    expect(mig050).toMatch(/ADD COLUMN IF NOT EXISTS created_by_display_name text/);
    expect(mig050).toMatch(/ADD COLUMN IF NOT EXISTS from_recurring_template boolean NOT NULL DEFAULT false/);
    expect(mig050).toMatch(/ADD COLUMN IF NOT EXISTS from_system_rule_id text/);
    expect(mig050).toMatch(/ADD COLUMN IF NOT EXISTS from_system_source_event_key text/);
    expect(mig050).toMatch(/ADD COLUMN IF NOT EXISTS designation text/);
  });

  it('adds the designation CHECK constraint (NULL or recurring/system)', () => {
    expect(mig050).toMatch(/CHECK \(designation IS NULL OR designation IN \('recurring', 'system'\)\)/);
  });

  it('switches template_id FK to ON DELETE SET NULL', () => {
    expect(mig050).toMatch(/DROP CONSTRAINT IF EXISTS task_instances_template_id_fkey/);
    expect(mig050).toMatch(
      /ADD CONSTRAINT task_instances_template_id_fkey[\s\S]*?REFERENCES public\.task_templates\(id\)[\s\S]*?ON DELETE SET NULL/,
    );
  });

  it('partial unique key is (from_system_rule_id, from_system_source_event_key) — Codex correction #1', () => {
    // Two different broiler batches CAN share the same due date and produce
    // two distinct system tasks. Uniqueness keys on the source event, not
    // due_date.
    expect(mig050).toMatch(/DROP INDEX IF EXISTS public\.idx_task_instances_system_rule_due/);
    expect(mig050).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_task_instances_system_rule_event[\s\S]*?ON public\.task_instances \(from_system_rule_id, from_system_source_event_key\)[\s\S]*?WHERE from_system_rule_id IS NOT NULL/,
    );
    // Lookup index on (rule, due_date) is NOT unique.
    expect(mig050).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_task_instances_system_rule_due_at[\s\S]*?ON public\.task_instances \(from_system_rule_id, due_date\)/,
    );
    // Tightly scoped: a single CREATE statement (semicolon-bounded) must
    // not be both UNIQUE AND keyed on (rule, due_date).
    expect(mig050).not.toMatch(/CREATE UNIQUE INDEX[^;]*?\(from_system_rule_id,\s*due_date\)/);
  });

  it('backfills from_recurring_template + designation for existing template_id rows', () => {
    expect(mig050).toMatch(/UPDATE public\.task_instances[\s\S]*?from_recurring_template = true/);
    expect(mig050).toMatch(/designation = COALESCE\(designation, 'recurring'\)/);
  });
});

describe('Mig 051 — due-date edits + photo sidecar', () => {
  it('creates task_instance_due_date_edits with the documented columns', () => {
    expect(mig051).toMatch(/CREATE TABLE IF NOT EXISTS public\.task_instance_due_date_edits/);
    expect(mig051).toMatch(/edited_by_role text NOT NULL CHECK \(edited_by_role IN \('admin', 'regular'\)\)/);
    expect(mig051).toMatch(/prior_due_date date NOT NULL/);
    expect(mig051).toMatch(/new_due_date date NOT NULL/);
  });

  it('enables RLS with authenticated SELECT on due-date edits and no INSERT policy', () => {
    expect(mig051).toMatch(
      /CREATE POLICY task_instance_due_date_edits_authenticated_select[\s\S]*?FOR SELECT[\s\S]*?TO authenticated[\s\S]*?USING \(true\)/,
    );
    // No INSERT/UPDATE/DELETE policy — RPC-only.
    expect(mig051).not.toMatch(/CREATE POLICY[\s\S]*?task_instance_due_date_edits[\s\S]*?FOR INSERT/);
  });

  it('creates task_instance_photos with belt-and-suspenders sort_order CHECK 0..4', () => {
    expect(mig051).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.task_instance_photos[\s\S]*?kind text NOT NULL CHECK \(kind IN \('creation', 'completion'\)\)[\s\S]*?sort_order int NOT NULL DEFAULT 0 CHECK \(sort_order BETWEEN 0 AND 4\)/,
    );
  });

  it('adds slot unique index on (instance_id, kind, sort_order)', () => {
    expect(mig051).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_task_instance_photos_slot[\s\S]*?ON public\.task_instance_photos \(instance_id, kind, sort_order\)/,
    );
  });

  it('photos table is RLS authenticated SELECT with no INSERT policy', () => {
    expect(mig051).toMatch(
      /CREATE POLICY task_instance_photos_authenticated_select[\s\S]*?FOR SELECT[\s\S]*?TO authenticated[\s\S]*?USING \(true\)/,
    );
    expect(mig051).not.toMatch(/CREATE POLICY[\s\S]*?task_instance_photos[\s\S]*?FOR INSERT/);
  });

  it('backfills photo sidecar from existing single-path columns', () => {
    expect(mig051).toMatch(
      /INSERT INTO public\.task_instance_photos[\s\S]*?'creation'[\s\S]*?ti\.request_photo_path[\s\S]*?ON CONFLICT \(instance_id, kind, sort_order\) DO NOTHING/,
    );
    expect(mig051).toMatch(
      /INSERT INTO public\.task_instance_photos[\s\S]*?'completion'[\s\S]*?ti\.completion_photo_path[\s\S]*?ON CONFLICT \(instance_id, kind, sort_order\) DO NOTHING/,
    );
  });
});

describe('Mig 052 — task_system_rules + Simon/Mak seed', () => {
  it('creates task_system_rules with the four documented generator_kinds', () => {
    expect(mig052).toMatch(
      /CHECK \(generator_kind IN \([\s\S]*?'broiler_4wk_weighin'[\s\S]*?'broiler_6wk_weighin'[\s\S]*?'clean_brooder'[\s\S]*?'pig_6mo_weighin'[\s\S]*?\)\)/,
    );
  });

  it('lead_time_days defaults to 3 with a non-negative CHECK (Codex T4)', () => {
    expect(mig052).toMatch(/lead_time_days int NOT NULL DEFAULT 3 CHECK \(lead_time_days >= 0\)/);
  });

  it('admin RLS gate plus authenticated SELECT for transparency', () => {
    expect(mig052).toMatch(/task_system_rules_authenticated_select[\s\S]*?FOR SELECT[\s\S]*?TO authenticated/);
    expect(mig052).toMatch(/task_system_rules_admin_all[\s\S]*?FOR ALL[\s\S]*?USING \(public\.is_admin\(\)\)/);
  });

  it('seed fails closed on zero or multiple Simon/Mak matches (Codex T5)', () => {
    expect(mig052).toMatch(
      /v_simon_count = 0 THEN[\s\S]*?RAISE EXCEPTION 'tasks v2 mig 052 seed: cannot resolve "Simon"/,
    );
    expect(mig052).toMatch(
      /v_simon_count > 1 THEN[\s\S]*?RAISE EXCEPTION 'tasks v2 mig 052 seed: cannot resolve "Simon"/,
    );
    expect(mig052).toMatch(/v_mak_count = 0 THEN[\s\S]*?RAISE EXCEPTION/);
    expect(mig052).toMatch(/v_mak_count > 1 THEN[\s\S]*?RAISE EXCEPTION/);
  });

  it('seed scopes to eligible profiles only (role IS DISTINCT FROM inactive)', () => {
    const occurrences = mig052.match(/role IS DISTINCT FROM 'inactive'/g) || [];
    // Two count queries + two id queries = 4 occurrences.
    expect(occurrences.length).toBeGreaterThanOrEqual(4);
  });

  it('seeds the four built-in rules with active=true and lead_time_days=3', () => {
    expect(mig052).toMatch(/'broiler-4wk-weighin'[\s\S]*?'broiler_4wk_weighin'[\s\S]*?3,[\s\S]*?true/);
    expect(mig052).toMatch(/'broiler-6wk-weighin'[\s\S]*?'broiler_6wk_weighin'[\s\S]*?3,[\s\S]*?true/);
    expect(mig052).toMatch(/'clean-brooder'[\s\S]*?'clean_brooder'[\s\S]*?3,[\s\S]*?true/);
    expect(mig052).toMatch(/'pig-6mo-weighin'[\s\S]*?'pig_6mo_weighin'[\s\S]*?3,[\s\S]*?true/);
  });

  // Codex T1 lock: assignee mapping must NOT silently flip. Only pig-6mo
  // goes to Mak; the three broiler/clean rules all go to Simon. The match
  // anchors v_<name>_id in the row's assignee slot (between description
  // string and generator_kind string).
  it('maps each rule to the correct assignee variable (Simon / Mak)', () => {
    expect(mig052).toMatch(/'broiler-4wk-weighin'[\s\S]*?v_simon_id,[\s\S]*?'broiler_4wk_weighin'/);
    expect(mig052).toMatch(/'broiler-6wk-weighin'[\s\S]*?v_simon_id,[\s\S]*?'broiler_6wk_weighin'/);
    expect(mig052).toMatch(/'clean-brooder'[\s\S]*?v_simon_id,[\s\S]*?'clean_brooder'/);
    expect(mig052).toMatch(/'pig-6mo-weighin'[\s\S]*?v_mak_id,[\s\S]*?'pig_6mo_weighin'/);
    // Negative lock: no occurrence of v_mak_id between any of the three
    // Simon-owned rule ids and their generator_kinds.
    expect(mig052).not.toMatch(/'broiler-4wk-weighin'[\s\S]*?v_mak_id,[\s\S]*?'broiler_4wk_weighin'/);
    expect(mig052).not.toMatch(/'broiler-6wk-weighin'[\s\S]*?v_mak_id,[\s\S]*?'broiler_6wk_weighin'/);
    expect(mig052).not.toMatch(/'clean-brooder'[\s\S]*?v_mak_id,[\s\S]*?'clean_brooder'/);
    expect(mig052).not.toMatch(/'pig-6mo-weighin'[\s\S]*?v_simon_id,[\s\S]*?'pig_6mo_weighin'/);
  });
});

describe('Mig 053 — RLS overhaul + RPCs', () => {
  it('drops the v1 assignee_self_select and adds authenticated_select on task_instances', () => {
    expect(mig053).toMatch(/DROP POLICY IF EXISTS task_instances_assignee_self_select ON public\.task_instances/);
    expect(mig053).toMatch(
      /CREATE POLICY task_instances_authenticated_select[\s\S]*?ON public\.task_instances FOR SELECT[\s\S]*?TO authenticated[\s\S]*?USING \(true\)/,
    );
  });

  it('adds task_templates_authenticated_select for recurring template visibility', () => {
    expect(mig053).toMatch(
      /CREATE POLICY task_templates_authenticated_select[\s\S]*?ON public\.task_templates FOR SELECT[\s\S]*?TO authenticated[\s\S]*?USING \(true\)/,
    );
  });

  it('declares all six RPCs as SECURITY DEFINER with search_path public', () => {
    const rpcNames = [
      'complete_task_instance',
      'create_one_time_task_instance',
      'update_task_instance_due_date',
      'assign_task_instance',
      'delete_task_instance',
      'generate_system_task_instance',
    ];
    for (const name of rpcNames) {
      const decl = mig053.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$[a-z_]+\\$;`));
      expect(decl, `expected ${name} declaration`).not.toBeNull();
      expect(decl[0]).toMatch(/SECURITY DEFINER/);
      expect(decl[0]).toMatch(/SET search_path = public/);
    }
  });

  it('REVOKEs anon EXECUTE on every new RPC and GRANTs to authenticated', () => {
    // Substring matches (not regex) — RPC signatures contain bare
    // parentheses that would need escaping if treated as regex.
    const sigs = [
      'complete_task_instance(text, text, text[])',
      'create_one_time_task_instance(jsonb, text[])',
      'update_task_instance_due_date(text, date)',
      'assign_task_instance(text, uuid)',
      'delete_task_instance(text)',
      'generate_system_task_instance(text, date, text)',
    ];
    for (const sig of sigs) {
      expect(mig053).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
      expect(mig053).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated;`);
    }
  });

  it('complete_task_instance v2 requires non-empty completion_note', () => {
    expect(mig053).toMatch(/complete_task_instance: completion_note required \(non-empty\)/);
  });

  it('complete_task_instance v2 caps completion photos at 5', () => {
    expect(mig053).toMatch(/complete_task_instance: max 5 completion photos/);
  });

  it('create_one_time_task_instance enforces title min 3 chars and required fields', () => {
    expect(mig053).toMatch(/create_one_time_task_instance: title required \(min 3 chars\)/);
    expect(mig053).toMatch(/create_one_time_task_instance: description required/);
    expect(mig053).toMatch(/create_one_time_task_instance: due_date required/);
    expect(mig053).toMatch(/create_one_time_task_instance: assignee_profile_id required/);
    expect(mig053).toMatch(/create_one_time_task_instance: max 5 creation photos/);
  });

  it('update_task_instance_due_date enforces 2-edit cap for regular users only', () => {
    expect(mig053).toMatch(/update_task_instance_due_date: regular-user edit limit reached \(2\/2\)/);
    // Admin path bumps due_date but NOT the count.
    expect(mig053).toMatch(/IF v_admin THEN[\s\S]*?SET due_date = p_new_due_date[\s\S]*?WHERE id = p_instance_id/);
  });

  it('assign_task_instance is admin-only', () => {
    expect(mig053).toMatch(/assign_task_instance: admin only/);
  });

  it('delete_task_instance rejects completed tasks for everyone', () => {
    expect(mig053).toMatch(/delete_task_instance: completed tasks cannot be deleted/);
  });

  // Note: the regular-user delete gate (created_by AND assignee both =
  // caller) is locked above under "delete_task_instance regular branch
  // requires created_by AND assignee both = caller (Codex #2)". Codex's
  // earlier "did not create this task" error string was replaced with
  // "regular users can delete only open tasks they assigned to
  // themselves" in the same correction.

  it('generate_system_task_instance idempotency + writes from_system_source_event_key column', () => {
    expect(mig053).toMatch(/v_instance_id := 'tisys-' \|\| p_rule_id \|\| '-' \|\| p_source_event_key/);
    expect(mig053).toMatch(/from_system_source_event_key/);
    expect(mig053).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('generate_system_task_instance grants EXECUTE explicitly to service_role (Codex #6)', () => {
    expect(mig053).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.generate_system_task_instance\(text, date, text\) TO service_role/,
    );
  });

  it('complete_task_instance v2 auth-checks BEFORE the completed-replay path (Codex #3)', () => {
    const fn = mig053.match(/CREATE OR REPLACE FUNCTION public\.complete_task_instance\([\s\S]*?\$complete_v2\$;/);
    expect(fn, 'expected complete_task_instance v2 body').not.toBeNull();
    const body = fn[0];
    const authIdx = body.indexOf('is not the assignee or admin');
    const replayIdx = body.indexOf("v_row.status = 'completed' THEN");
    expect(authIdx).toBeGreaterThan(0);
    expect(replayIdx).toBeGreaterThan(0);
    expect(authIdx).toBeLessThan(replayIdx);
  });

  it('complete_task_instance v2 validates each photo path against the bucket prefix shape (Codex #4)', () => {
    expect(mig053).toMatch(
      /v_expected_prefix := 'task-photos\/' \|\| v_row\.assignee_profile_id::text \|\| '\/' \|\| p_instance_id \|\| '\/'/,
    );
    expect(mig053).toMatch(/completion photo path #% must start with %/);
    expect(mig053).toMatch(/completion photo path #% has empty filename/);
    expect(mig053).toMatch(/completion photo path #% filename must not contain/);
  });

  it('create_one_time_task_instance validates each creation photo path against the request bucket prefix', () => {
    expect(mig053).toMatch(/'task-request-photos\/' \|\| v_id \|\| '\/'/);
    expect(mig053).toMatch(/creation photo path #% must start with %/);
    expect(mig053).toMatch(/creation photo path #% has empty filename/);
    expect(mig053).toMatch(/creation photo path #% filename must not contain/);
  });

  it('delete_task_instance regular branch requires created_by AND assignee both = caller (Codex #2)', () => {
    expect(mig053).toMatch(
      /v_row\.created_by_profile_id IS DISTINCT FROM v_caller[\s\S]*?OR v_row\.assignee_profile_id IS DISTINCT FROM v_caller/,
    );
    expect(mig053).toMatch(/regular users can delete only open tasks they assigned to themselves/);
  });

  it('update_task_instance_due_date uses uuid-based audit ids (Codex #9)', () => {
    expect(mig053).toMatch(/v_audit_id := 'tdde-' \|\| gen_random_uuid\(\)::text/);
    expect(mig053).not.toMatch(/v_audit_id := 'tdde-' \|\| p_instance_id \|\| '-' \|\| .*count/);
  });

  it('BEFORE INSERT trigger auto-sets from_recurring_template/designation (Codex #7)', () => {
    expect(mig053).toMatch(/CREATE OR REPLACE FUNCTION public\._tasks_v2_set_designation/);
    expect(mig053).toMatch(/BEFORE INSERT ON public\.task_instances/);
    expect(mig053).toMatch(/NEW\.from_recurring_template := true/);
    expect(mig053).toMatch(/NEW\.designation := 'recurring'/);
    expect(mig053).toMatch(/NEW\.designation := 'system'/);
  });

  it('AFTER INSERT/UPDATE trigger mirrors legacy photo paths into the sidecar (Codex #8)', () => {
    expect(mig053).toMatch(/CREATE OR REPLACE FUNCTION public\._tasks_v2_mirror_photo_paths/);
    expect(mig053).toMatch(/AFTER INSERT OR UPDATE ON public\.task_instances/);
    expect(mig053).toMatch(/'creation', NEW\.request_photo_path/);
    expect(mig053).toMatch(/'completion', NEW\.completion_photo_path/);
    expect(mig053).toMatch(/ON CONFLICT \(instance_id, kind, sort_order\) DO NOTHING/);
  });

  // Codex T1 reclaim lock: the AFTER trigger fires before the v2 RPC's
  // sidecar insert, so the v2 RPCs must use ON CONFLICT DO UPDATE to write
  // the actual uploader id into the slot the trigger pre-occupied with NULL.
  // Both v2 RPCs must reclaim. The trigger itself stays DO NOTHING since
  // it has no caller-id source.
  it('v2 RPC sidecar inserts reclaim the trigger-occupied slot via DO UPDATE', () => {
    // Two reclaim INSERTs in mig 053 (one in complete v2, one in
    // create_one_time). Each must specify storage_path and
    // uploaded_by_profile_id in the SET clause.
    const reclaimRe =
      /ON CONFLICT \(instance_id, kind, sort_order\) DO UPDATE\s+SET storage_path = EXCLUDED\.storage_path,\s+uploaded_by_profile_id = EXCLUDED\.uploaded_by_profile_id/g;
    const reclaims = mig053.match(reclaimRe) || [];
    expect(reclaims.length).toBe(2);
  });

  it('generate_system_task_instance refuses to generate from inactive rules', () => {
    expect(mig053).toMatch(/generate_system_task_instance: rule % is inactive/);
  });
});
