import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// ============================================================================
// System-generated task titles must include the batch/entity name so a task
// like "Broiler 4-week weigh-in - B-26-04" is identifiable on its own.
// Generation lives in the tasks-cron Edge Function (computes the label) +
// migration 142 (generate_system_task_instance appends it to the rule name).
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const cron = fs.readFileSync(path.join(ROOT, 'supabase/functions/tasks-cron/index.ts'), 'utf8');
const mig142 = fs.readFileSync(
  path.join(ROOT, 'supabase-migrations/142_system_task_titles_include_entity_label.sql'),
  'utf8',
);

describe('system task titles include the batch/entity label — tasks-cron', () => {
  it('SystemEvent carries an entity_label', () => {
    expect(cron).toMatch(/interface SystemEvent \{[\s\S]*?entity_label: string;[\s\S]*?\}/);
  });

  it('broiler events derive the label from the batch display name', () => {
    expect(cron).toMatch(
      /entityLabel = stringField\(batch, 'name'\) \|\| stringField\(batch, 'batchName'\) \|\| stringField\(batch, 'id'\)/,
    );
  });

  it('pig events derive the label from the group/sub-batch display name', () => {
    expect(cron).toMatch(/stringField\(group, 'batchName'\) \|\| stringField\(group, 'id'\)/);
    expect(cron).toMatch(/stringField\(target, 'name'\) \|\| stringField\(group, 'batchName'\)/);
  });

  it('every system event object includes entity_label', () => {
    // Both collectors build their event object with entity_label set.
    const eventLiterals = cron.match(/source_event_key: `[^`]+`,\s*\n\s*entity_label: entityLabel,/g) || [];
    expect(eventLiterals.length).toBeGreaterThanOrEqual(2);
  });

  it('passes p_entity_label to the generate RPC', () => {
    expect(cron).toMatch(/p_entity_label: event\.entity_label/);
  });
});

describe('system task titles include the batch/entity label — migration 142', () => {
  it('adds the optional p_entity_label arg with a NULL default', () => {
    expect(mig142).toMatch(/p_entity_label text DEFAULT NULL/);
  });

  it('drops the old 3-arg signature so there is one canonical function', () => {
    expect(mig142).toMatch(/DROP FUNCTION IF EXISTS public\.generate_system_task_instance\(text, date, text\);/);
  });

  it('appends the trimmed label to the rule name as the stored title', () => {
    expect(mig142).toMatch(/v_label text := nullif\(btrim\(coalesce\(p_entity_label, ''\)\), ''\)/);
    expect(mig142).toMatch(
      /v_title := v_rule\.name \|\| CASE WHEN v_label IS NOT NULL THEN ' - ' \|\| v_label ELSE '' END/,
    );
    // The INSERT stores the composed title, not the bare rule name.
    expect(mig142).toMatch(/p_due_date,\s*\n\s*v_title, v_rule\.description,/);
  });

  it('keeps SECURITY DEFINER + pinned search_path and re-grants the 4-arg signature', () => {
    expect(mig142).toMatch(/SECURITY DEFINER/);
    expect(mig142).toMatch(/SET search_path = public/);
    expect(mig142).toContain(
      'REVOKE ALL ON FUNCTION public.generate_system_task_instance(text, date, text, text) FROM PUBLIC, anon;',
    );
    expect(mig142).toContain(
      'GRANT EXECUTE ON FUNCTION public.generate_system_task_instance(text, date, text, text) TO authenticated;',
    );
    expect(mig142).toContain(
      'GRANT EXECUTE ON FUNCTION public.generate_system_task_instance(text, date, text, text) TO service_role;',
    );
  });

  it('preserves idempotency (deterministic id + ON CONFLICT DO NOTHING)', () => {
    expect(mig142).toMatch(/v_instance_id := 'tisys-' \|\| p_rule_id \|\| '-' \|\| p_source_event_key/);
    expect(mig142).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('backfills OPEN system tasks only, idempotently, deriving the label from the source event key', () => {
    // OPEN + system rows only; completed/history untouched.
    expect(mig142).toMatch(/designation = 'system'\s*\n\s*AND status = 'open'/);
    // label derived by stripping the broiler/brooder/pig prefix from the key
    expect(mig142).toMatch(/regexp_replace\(from_system_source_event_key, '\^\(broiler\|brooder\|pig\)-', ''\)/);
    // appends " - <label>" to the existing title
    expect(mig142).toMatch(/SET title = ti\.title \|\| ' - ' \|\| lbl\.label/);
    // idempotent: skip rows already ending with the label suffix
    expect(mig142).toMatch(
      /right\(ti\.title, length\(' - ' \|\| lbl\.label\)\) IS DISTINCT FROM \(' - ' \|\| lbl\.label\)/,
    );
    // never rewrites completed/history titles
    expect(mig142).not.toMatch(/status = 'completed'/);
  });
});
