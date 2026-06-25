-- ============================================================================
-- 143_pasture_map_reset_area_history.sql
-- ----------------------------------------------------------------------------
-- Adds delete_land_area_grazing_history(p_id): a management/admin reset that
-- wipes ONE land area's grazing history so it reads "no move history / baseline"
-- again (e.g. a paddock that only carries test moves yet shows as resting).
--
-- The move ledger is append-only and entangled: a single move event chains two
-- areas (from -> to) and seeds destination/overlap/departure impacts across the
-- areas it touches. Area state (occupied/resting/rested) is derived ON READ from
-- pasture_move_impacts; the Reports timeline is derived from pasture_move_events
-- (rows whose from/to/impact references the area). To reset ONE area without
-- corrupting the others' state we:
--   1. delete the impact rows on this area (clears its derived Map state), and
--   2. null this area out of every event's from/to reference (drops it from the
--      Reports timeline) while LEAVING the events + their impacts on OTHER areas
--      intact — impacts are keyed (move_id, land_area_id, impact_kind), so only
--      this area's rows are removed and every other area keeps its history.
--   3. reset baseline_no_history so the summary reads "no move history".
--
-- Side effects (by design, documented): a group whose latest recorded move was
-- INTO this area becomes "Not placed"; other areas' Reports timelines render this
-- area as "-" where it used to appear as a from/to. No schema change, no new
-- table, no RLS change. SECURITY DEFINER + management/admin gate, mirroring
-- delete_land_area.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_land_area_grazing_history(
  p_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller  uuid := auth.uid();
  v_role    text;
  v_row     public.land_areas%ROWTYPE;
  v_impacts int := 0;
  v_events  int := 0;
  v_n       int;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'delete_land_area_grazing_history: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot reset grazing history', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.land_areas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PM_VALIDATION: land area % not found', p_id;
  END IF;

  -- 1. Drop this area's derived Map state (its impact rows only).
  DELETE FROM public.pasture_move_impacts WHERE land_area_id = p_id;
  GET DIAGNOSTICS v_impacts = ROW_COUNT;

  -- 2. Detach this area from the event ledger so it leaves the Reports timeline.
  --    The events (and their impacts on OTHER areas) are preserved.
  UPDATE public.pasture_move_events SET to_land_area_id = NULL WHERE to_land_area_id = p_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_events := v_events + v_n;
  UPDATE public.pasture_move_events SET from_land_area_id = NULL WHERE from_land_area_id = p_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_events := v_events + v_n;

  -- 3. Reset the no-history flag so the summary derives "no move history".
  UPDATE public.land_areas
     SET baseline_no_history = true,
         updated_at = now()
   WHERE id = p_id;

  RETURN public._land_area_summary(p_id) || jsonb_build_object(
    'ok', true,
    'impacts_cleared', v_impacts,
    'events_detached', v_events
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.delete_land_area_grazing_history(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_land_area_grazing_history(text) TO authenticated;
