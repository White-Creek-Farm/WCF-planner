-- 142_system_task_titles_include_entity_label.sql
-- =====================================================================
-- System-generated task titles include the batch / entity name.
-- (Renumbered 139 -> 142: pasture map lane claimed 139/140/141 on TEST.)
--
-- Problem: generate_system_task_instance set task_instances.title to the bare
-- rule name (e.g. "Broiler 4-week weigh-in"), so a farm user can't tell which
-- batch a system task belongs to without opening surrounding context. The same
-- pain is visible on the EXISTING open system tasks already minted.
--
-- Fix:
--   (a) add an optional p_entity_label arg so new generation produces
--       "<rule name> - <entity label>"  e.g. "Broiler 4-week weigh-in - B-26-04".
--   (b) one-time backfill of OPEN system tasks missing the suffix, deriving the
--       label from the sanitized source_event_key (prefix stripped).
--
-- Signature change (text,date,text) -> (text,date,text,text DEFAULT NULL):
-- DROP the old 3-arg function then CREATE the 4-arg version, so there is ONE
-- function (no lingering overload). The 4th arg DEFAULTs NULL, so the
-- currently-deployed 3-arg cron call still binds to this function and keeps its
-- old behavior until the new cron deploys — no generation gap.
--
-- NO BEGIN/COMMIT: TEST applies via exec_sql; PROD applies with
-- psql --single-transaction (ON_ERROR_STOP=1) after approval.
-- =====================================================================

DROP FUNCTION IF EXISTS public.generate_system_task_instance(text, date, text);

CREATE OR REPLACE FUNCTION public.generate_system_task_instance(
  p_rule_id text,
  p_due_date date,
  p_source_event_key text,
  p_entity_label text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $gen_system$
DECLARE
  v_rule record;
  v_caller uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_instance_id text;
  v_label text := nullif(btrim(coalesce(p_entity_label, '')), '');
  v_title text;
BEGIN
  -- Caller must be admin OR service_role (Edge Function path). Service-role
  -- calls bypass auth.uid() (returns NULL) but the function runs as definer.
  IF v_caller IS NOT NULL AND NOT v_admin THEN
    RAISE EXCEPTION 'generate_system_task_instance: admin or service caller required';
  END IF;

  IF p_rule_id IS NULL OR length(trim(p_rule_id)) = 0 THEN
    RAISE EXCEPTION 'generate_system_task_instance: rule_id required';
  END IF;
  IF p_due_date IS NULL THEN
    RAISE EXCEPTION 'generate_system_task_instance: due_date required';
  END IF;
  IF p_source_event_key IS NULL OR length(trim(p_source_event_key)) = 0 THEN
    RAISE EXCEPTION 'generate_system_task_instance: source_event_key required';
  END IF;

  SELECT id, name, description, assignee_profile_id, generator_kind, active
    INTO v_rule
    FROM public.task_system_rules
    WHERE id = p_rule_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'generate_system_task_instance: rule % not found', p_rule_id;
  END IF;
  IF NOT v_rule.active THEN
    RAISE EXCEPTION 'generate_system_task_instance: rule % is inactive', p_rule_id;
  END IF;

  -- Batch/entity context in the title so the task is identifiable on its own.
  v_title := v_rule.name || CASE WHEN v_label IS NOT NULL THEN ' - ' || v_label ELSE '' END;

  -- Deterministic instance id (rule + event key) so retries are idempotent.
  v_instance_id := 'tisys-' || p_rule_id || '-' || p_source_event_key;

  INSERT INTO public.task_instances (
    id, template_id, assignee_profile_id, due_date, title, description,
    submitted_by_team_member, submission_source, status,
    from_system_rule_id, from_system_source_event_key, designation
  )
  VALUES (
    v_instance_id, NULL, v_rule.assignee_profile_id, p_due_date,
    v_title, v_rule.description,
    NULL, 'admin_manual', 'open',
    v_rule.id, p_source_event_key, 'system'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN jsonb_build_object(
    'ok', true,
    'instance_id', v_instance_id,
    'rule_id', p_rule_id,
    'due_date', p_due_date,
    'source_event_key', p_source_event_key,
    'entity_label', v_label
  );
END;
$gen_system$;

-- Re-apply the grant posture on the new 4-arg signature (mirrors mig 053).
REVOKE ALL ON FUNCTION public.generate_system_task_instance(text, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_system_task_instance(text, date, text, text) TO authenticated;
-- Edge Function service-role intent should be loud (matches mig 053, Codex #6).
GRANT EXECUTE ON FUNCTION public.generate_system_task_instance(text, date, text, text) TO service_role;

-- ---------------------------------------------------------------------
-- One-time backfill of EXISTING open system tasks.
--   * OPEN system-generated rows only (designation='system', status='open').
--   * completed/history rows untouched.
--   * label derived from the sanitized source_event_key (strip broiler/brooder/
--     pig prefix). For the farm's alphanumeric+hyphen batch codes the key part
--     equals the display name (e.g. broiler-B-26-04 -> B-26-04).
--   * idempotent: skips rows already ending with " - <label>".
--   * SAFE: a title-only UPDATE fires no side effects — the emit-completed
--     trigger gates on the status->completed transition, and the photo-mirror
--     trigger guards on (unchanged) photo path columns.
-- ---------------------------------------------------------------------
UPDATE public.task_instances ti
SET title = ti.title || ' - ' || lbl.label
FROM (
  SELECT id,
         btrim(regexp_replace(from_system_source_event_key, '^(broiler|brooder|pig)-', '')) AS label
  FROM public.task_instances
  WHERE designation = 'system'
    AND status = 'open'
    AND from_system_source_event_key IS NOT NULL
) lbl
WHERE ti.id = lbl.id
  AND length(lbl.label) > 0
  AND lbl.label <> 'unknown'
  AND ti.title IS NOT NULL
  AND right(ti.title, length(' - ' || lbl.label)) IS DISTINCT FROM (' - ' || lbl.label);

NOTIFY pgrst, 'reload schema';

-- POST-APPLY VERIFICATION (read-only):
--   SELECT pg_get_function_identity_arguments(oid)
--   FROM pg_proc WHERE proname = 'generate_system_task_instance';
--   -- Expect one row: "p_rule_id text, p_due_date date,
--   --   p_source_event_key text, p_entity_label text".
--   SELECT count(*) FROM task_instances
--   WHERE designation='system' AND status='open' AND title NOT LIKE '% - %';
--   -- Expect 0 (every open system task now carries a " - <label>" suffix,
--   --   except any whose source_event_key stripped to empty/unknown).
-- End of 142_system_task_titles_include_entity_label.sql
