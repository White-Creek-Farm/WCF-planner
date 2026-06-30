-- ============================================================================
-- 152_pasture_map_manager_hard_delete.sql  —  Pasture Map hard-delete role widen
-- ----------------------------------------------------------------------------
-- Widens hard_delete_land_area from admin-ONLY (mig 135) to management + admin,
-- matching the rest of the permanent-area management surface. Hard delete stays
-- the v1 soft-delete/snapshot path (deleted_at, deleted_by); geometry rows are
-- still retained (a true geometry purge remains a future follow-up). The
-- occupancy guard (PM_AREA_OCCUPIED) and child-detach behavior are unchanged —
-- only the role check moves from ('admin') to ('management','admin').
--
-- Scope decision (Ronnie, 2026-06-30): managers get the SAME hard-delete power
-- as admin on ANY area (temp paddocks and permanent pastures/paddocks), not a
-- temp-only subset.
--
-- Depends on: mig 135 (hard_delete_land_area, _land_area_is_occupied).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.hard_delete_land_area(
  p_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    public.land_areas%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'hard_delete_land_area: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot hard delete land areas', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.land_areas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PM_VALIDATION: land area % not found', p_id;
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'id', p_id, 'deleted', true);
  END IF;

  IF public._land_area_is_occupied(p_id) THEN
    RAISE EXCEPTION 'PM_VALIDATION: PM_AREA_OCCUPIED';
  END IF;

  UPDATE public.land_areas SET parent_id = NULL WHERE parent_id = p_id;
  UPDATE public.land_areas
     SET deleted_at = now(), deleted_by = v_caller, updated_at = now()
   WHERE id = p_id;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'id', p_id, 'deleted', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.hard_delete_land_area(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hard_delete_land_area(text) TO authenticated;
