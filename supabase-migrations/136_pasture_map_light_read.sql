-- ============================================================================
-- 136_pasture_map_light_read.sql
-- Light read-only Pasture Map access (Ronnie-approved product change).
--
-- Light users get a Map-only, READ-ONLY Pasture Map: they may read land areas
-- and the move ledger (the data the Map view needs for areas, occupancy fills,
-- and current animal-group locations) and nothing else.
--
-- This migration ONLY widens the read gate of the two Map-view RPCs to include
-- 'light'. It grants NO write access and does NOT widen any other RPC:
--   * Every write/management RPC keeps its ('farm_team'|'management'|'admin')
--     gate (or stricter): record_pasture_move, create/update/delete/close land
--     area, archive/restore, temp paddocks, line style, planned moves, tracks.
--   * The planning/report RPCs (planned moves, rest, stocking, history) are NOT
--     widened - the client does not fetch them for Light, and Plan/Field/Reports
--     are not rendered for Light.
--
-- Bodies are copied verbatim from 116 (list_land_areas) and 128
-- (list_pasture_moves); the ONLY change is adding 'light' to the read gate.
-- Idempotent: pure CREATE OR REPLACE of two functions; safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.list_land_areas(
  p_include_deleted boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_areas  jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_land_areas: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot read land areas', COALESCE(v_role, 'null');
  END IF;

  SELECT COALESCE(jsonb_agg(public._land_area_summary(a.id)
           ORDER BY a.kind, a.name, a.created_at), '[]'::jsonb)
    INTO v_areas
    FROM public.land_areas a
   WHERE (p_include_deleted OR a.deleted_at IS NULL);

  RETURN jsonb_build_object('land_areas', v_areas);
END
$fn$;
REVOKE ALL ON FUNCTION public.list_land_areas(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_land_areas(boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_pasture_moves(
  p_limit int DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_moves jsonb;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_pasture_moves: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot read pasture moves', COALESCE(v_role, 'null');
  END IF;

  SELECT COALESCE(jsonb_agg(public._pasture_move_summary(m.id)
           ORDER BY m.moved_at DESC, m.created_at DESC), '[]'::jsonb)
    INTO v_moves
    FROM (
      SELECT id, moved_at, created_at
        FROM public.pasture_move_events
       ORDER BY moved_at DESC, created_at DESC
       LIMIT v_limit
    ) m;

  RETURN jsonb_build_object('moves', v_moves);
END
$fn$;
REVOKE ALL ON FUNCTION public.list_pasture_moves(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pasture_moves(int) TO authenticated;
