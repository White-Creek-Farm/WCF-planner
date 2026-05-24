-- ============================================================================
-- 062_activity_entity_expansion.sql
-- ----------------------------------------------------------------------------
-- Expand the activity entity registry beyond tasks. Adds resolver branches
-- to _activity_can_read for broiler.batch, layer.batch, layer.housing,
-- cattle.animal, sheep.animal, equipment.item.
--
-- Preserves the mig-058 role gate: null/blank args → false,
-- profile_role() null → false, inactive → false. Entity existence is
-- checked before any admin shortcut.
--
-- Non-task entities enforce program_access: admin bypasses after
-- existence is confirmed; null/empty program_access = full access;
-- otherwise the required program must be in the array.
--
-- Client-side: src/lib/activityRegistry.js carries matching entity types.
-- Apply order: TEST first, PROD after lane approval.
-- ============================================================================


-- ── 1. Replace _activity_can_read with expanded resolver ────────────────────

CREATE OR REPLACE FUNCTION public._activity_can_read(
  p_entity_type text,
  p_entity_id   text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $can_read$
DECLARE
  v_role text;
  v_access text[];
BEGIN
  IF p_entity_type IS NULL OR length(trim(p_entity_type)) = 0 THEN
    RETURN false;
  END IF;
  IF p_entity_id IS NULL OR length(trim(p_entity_id)) = 0 THEN
    RETURN false;
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL THEN
    RETURN false;
  END IF;
  IF v_role = 'inactive' THEN
    RETURN false;
  END IF;

  -- Task entity types: transparency RLS lets every authed user see every
  -- task row, so the role gate above is sufficient. No program_access check.
  IF p_entity_type = 'task.instance' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_instances WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF p_entity_type = 'task.template' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_templates WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF p_entity_type = 'task.system_rule' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_system_rules WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  -- Non-task entity types: enforce program_access after existence check.
  -- Admin bypasses program_access. Null/empty program_access = full access.

  IF p_entity_type = 'broiler.batch' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.app_store
      WHERE key = 'ppp-v4'
        AND data::jsonb @> jsonb_build_array(jsonb_build_object('name', p_entity_id))
    ) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'broiler' = ANY(v_access);
  END IF;

  IF p_entity_type = 'layer.batch' THEN
    IF NOT EXISTS (SELECT 1 FROM public.layer_batches WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'layer.housing' THEN
    IF NOT EXISTS (SELECT 1 FROM public.layer_housings WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'cattle.animal' THEN
    IF NOT EXISTS (SELECT 1 FROM public.cattle WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  IF p_entity_type = 'sheep.animal' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sheep WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'sheep' = ANY(v_access);
  END IF;

  IF p_entity_type = 'equipment.item' THEN
    IF NOT EXISTS (SELECT 1 FROM public.equipment WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'equipment' = ANY(v_access);
  END IF;

  -- Unknown entity type: fail closed.
  RETURN false;
END
$can_read$;

REVOKE ALL ON FUNCTION public._activity_can_read(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._activity_can_read(text, text) TO authenticated;


-- ── 2. Replace _activity_can_write with same role gate ──────────────────────

CREATE OR REPLACE FUNCTION public._activity_can_write(
  p_entity_type text,
  p_entity_id   text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $can_write$
DECLARE
  v_role text := public.profile_role();
BEGIN
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RETURN false;
  END IF;
  RETURN public._activity_can_read(p_entity_type, p_entity_id);
END
$can_write$;

REVOKE ALL ON FUNCTION public._activity_can_write(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._activity_can_write(text, text) TO authenticated;


-- ── 3. Schema reload ────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 062_activity_entity_expansion.sql
-- ============================================================================
