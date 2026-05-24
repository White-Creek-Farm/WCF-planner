-- ============================================================================
-- 067_daily_soft_delete.sql
-- ----------------------------------------------------------------------------
-- Soft-delete for daily reports + daily entity registration in the Activity
-- Layer resolver.
--
-- 1. Add deleted_at / deleted_by columns to all 6 daily tables.
-- 2. Add partial indexes on (date) WHERE deleted_at IS NULL for efficient
--    active-record queries.
-- 3. Expand _activity_can_read with 6 daily entity type branches. Soft-
--    deleted rows remain resolver-visible (no deleted_at filter) so
--    record.deleted / record.restored Activity events stay accessible in
--    /activity after the source row is soft-deleted.
-- 4. Transactional SECDEF RPCs:
--    - soft_delete_daily_report: admin-only, sets deleted_at/deleted_by,
--      inserts record.deleted activity event in one transaction.
--    - restore_daily_report: admin-only, clears deleted_at/deleted_by,
--      inserts record.restored activity event in one transaction.
--
-- Apply order: TEST first, PROD after lane approval.
-- ============================================================================

-- ── 1. Soft-delete columns ──────────────────────────────────────────────

ALTER TABLE public.poultry_dailys
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id);

ALTER TABLE public.layer_dailys
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id);

ALTER TABLE public.egg_dailys
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id);

ALTER TABLE public.pig_dailys
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id);

ALTER TABLE public.cattle_dailys
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id);

ALTER TABLE public.sheep_dailys
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id);

-- ── 2. Partial indexes for active-record queries ────────────────────────

CREATE INDEX IF NOT EXISTS poultry_dailys_active_idx
  ON public.poultry_dailys(date) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS layer_dailys_active_idx
  ON public.layer_dailys(date) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS egg_dailys_active_idx
  ON public.egg_dailys(date) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS pig_dailys_active_idx
  ON public.pig_dailys(date) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS cattle_dailys_active_idx
  ON public.cattle_dailys(date) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS sheep_dailys_active_idx
  ON public.sheep_dailys(date) WHERE deleted_at IS NULL;

-- ── 3. Expand _activity_can_read with daily entity types ────────────────
--
-- The function is CREATE OR REPLACE so all existing branches from mig 064
-- must be preserved verbatim. The six new daily branches are added before
-- the final "unknown entity_type" fall-through.
--
-- IMPORTANT: daily branches do NOT filter deleted_at IS NULL. Soft-deleted
-- rows must remain resolver-visible so record.deleted / record.restored
-- Activity events are still readable in /activity.

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
  v_role   text;
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

  -- ── Task entity types: transparency RLS, no program_access ──────────

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

  -- ── Non-task: existence + program_access. Admin bypasses program. ───

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

  IF p_entity_type = 'pig.batch' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.app_store
      WHERE key = 'ppp-feeders-v1'
        AND data::jsonb @> jsonb_build_array(jsonb_build_object('id', p_entity_id))
    ) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'pig' = ANY(v_access);
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

  IF p_entity_type = 'cattle.processing' THEN
    IF NOT EXISTS (SELECT 1 FROM public.cattle_processing_batches WHERE id = p_entity_id) THEN
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

  IF p_entity_type = 'sheep.processing' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sheep_processing_batches WHERE id = p_entity_id) THEN
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

  -- ── Daily report entity types ─────────────────────────────────────────
  -- Existence check does NOT filter deleted_at so soft-deleted rows remain
  -- resolver-visible and their Activity events stay accessible in /activity.

  IF p_entity_type = 'poultry.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.poultry_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'broiler' = ANY(v_access);
  END IF;

  IF p_entity_type = 'layer.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.layer_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'egg.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.egg_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'pig.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.pig_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'pig' = ANY(v_access);
  END IF;

  IF p_entity_type = 'cattle.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.cattle_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  IF p_entity_type = 'sheep.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sheep_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'sheep' = ANY(v_access);
  END IF;

  -- Unknown entity_type. Fail closed.
  RETURN false;
END
$can_read$;

REVOKE ALL ON FUNCTION public._activity_can_read(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._activity_can_read(text, text) TO authenticated;

-- ── 4. Transactional SECDEF RPCs ────────────────────────────────────────

-- Table name → entity_type mapping used by both RPCs
-- Validated server-side; clients pass the entity_type, not raw table names.

CREATE OR REPLACE FUNCTION public.soft_delete_daily_report(
  p_entity_type  text,
  p_entity_id    text,
  p_entity_label text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_table  text;
  v_exists boolean;
  v_ae_id  text;
BEGIN
  -- 1. Authenticate
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'soft_delete_daily_report: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'soft_delete_daily_report: caller role % cannot delete', COALESCE(v_role, 'null');
  END IF;

  -- 2. Admin-only
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'soft_delete_daily_report: admin role required';
  END IF;

  -- 3. Resolve table from entity_type
  v_table := CASE p_entity_type
    WHEN 'poultry.daily' THEN 'poultry_dailys'
    WHEN 'layer.daily'   THEN 'layer_dailys'
    WHEN 'egg.daily'     THEN 'egg_dailys'
    WHEN 'pig.daily'     THEN 'pig_dailys'
    WHEN 'cattle.daily'  THEN 'cattle_dailys'
    WHEN 'sheep.daily'   THEN 'sheep_dailys'
    ELSE NULL
  END;
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'soft_delete_daily_report: unsupported entity_type %', p_entity_type;
  END IF;

  -- 4. Check record exists and is not already deleted
  EXECUTE format(
    'SELECT EXISTS(SELECT 1 FROM public.%I WHERE id = $1 AND deleted_at IS NULL)',
    v_table
  ) INTO v_exists USING p_entity_id;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'soft_delete_daily_report: record not found or already deleted';
  END IF;

  -- 5. Soft-delete
  EXECUTE format(
    'UPDATE public.%I SET deleted_at = now(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL',
    v_table
  ) USING v_caller, p_entity_id;

  -- 6. Insert record.deleted Activity event (same transaction)
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id,
    event_type, body, payload
  ) VALUES (
    v_ae_id,
    p_entity_type,
    p_entity_id,
    v_caller,
    'record.deleted',
    'Deleted ' || replace(p_entity_type, '.', ' ') || ' report: ' || COALESCE(NULLIF(p_entity_label, ''), p_entity_id),
    jsonb_build_object('entity_label', COALESCE(NULLIF(p_entity_label, ''), p_entity_id))
  );

  RETURN jsonb_build_object('ok', true, 'event_id', v_ae_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.soft_delete_daily_report(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_daily_report(text, text, text) TO authenticated;

-- ──

CREATE OR REPLACE FUNCTION public.restore_daily_report(
  p_entity_type  text,
  p_entity_id    text,
  p_entity_label text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_table  text;
  v_exists boolean;
  v_ae_id  text;
BEGIN
  -- 1. Authenticate
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'restore_daily_report: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'restore_daily_report: caller role % cannot restore', COALESCE(v_role, 'null');
  END IF;

  -- 2. Admin-only
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'restore_daily_report: admin role required';
  END IF;

  -- 3. Resolve table from entity_type
  v_table := CASE p_entity_type
    WHEN 'poultry.daily' THEN 'poultry_dailys'
    WHEN 'layer.daily'   THEN 'layer_dailys'
    WHEN 'egg.daily'     THEN 'egg_dailys'
    WHEN 'pig.daily'     THEN 'pig_dailys'
    WHEN 'cattle.daily'  THEN 'cattle_dailys'
    WHEN 'sheep.daily'   THEN 'sheep_dailys'
    ELSE NULL
  END;
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'restore_daily_report: unsupported entity_type %', p_entity_type;
  END IF;

  -- 4. Check record exists and IS deleted
  EXECUTE format(
    'SELECT EXISTS(SELECT 1 FROM public.%I WHERE id = $1 AND deleted_at IS NOT NULL)',
    v_table
  ) INTO v_exists USING p_entity_id;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'restore_daily_report: record not found or not deleted';
  END IF;

  -- 5. Restore
  EXECUTE format(
    'UPDATE public.%I SET deleted_at = NULL, deleted_by = NULL WHERE id = $1',
    v_table
  ) USING p_entity_id;

  -- 6. Insert record.restored Activity event (same transaction)
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id,
    event_type, body, payload
  ) VALUES (
    v_ae_id,
    p_entity_type,
    p_entity_id,
    v_caller,
    'record.restored',
    'Restored ' || replace(p_entity_type, '.', ' ') || ' report: ' || COALESCE(NULLIF(p_entity_label, ''), p_entity_id),
    jsonb_build_object('entity_label', COALESCE(NULLIF(p_entity_label, ''), p_entity_id))
  );

  RETURN jsonb_build_object('ok', true, 'event_id', v_ae_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.restore_daily_report(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_daily_report(text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 067_daily_soft_delete.sql
-- ============================================================================
