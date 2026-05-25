-- ============================================================================
-- 070_daily_delete_all_active_roles.sql
-- ----------------------------------------------------------------------------
-- Widen soft_delete_daily_report from admin-only to any active authenticated
-- role. restore_daily_report stays admin-only.
--
-- The only change from the 067 version is removing the admin-only gate
-- (step 2). Authenticated caller + non-null/non-inactive role is still
-- required. Anon and inactive users are still rejected.
--
-- Apply order: TEST first, PROD after lane approval.
-- ============================================================================

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

  -- 2. Resolve table from entity_type
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

  -- 3. Check record exists and is not already deleted
  EXECUTE format(
    'SELECT EXISTS(SELECT 1 FROM public.%I WHERE id = $1 AND deleted_at IS NULL)',
    v_table
  ) INTO v_exists USING p_entity_id;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'soft_delete_daily_report: record not found or already deleted';
  END IF;

  -- 4. Soft-delete
  EXECUTE format(
    'UPDATE public.%I SET deleted_at = now(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL',
    v_table
  ) USING v_caller, p_entity_id;

  -- 5. Insert record.deleted Activity event (same transaction)
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

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 070_daily_delete_all_active_roles.sql
-- ============================================================================
