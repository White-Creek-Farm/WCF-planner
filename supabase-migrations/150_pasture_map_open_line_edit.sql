-- ============================================================================
-- 150_pasture_map_open_line_edit.sql  (Pasture Map — Open-line Edit)
-- ----------------------------------------------------------------------------
-- Adds a narrow SECDEF RPC that lets a manager reshape a SAVED Track / Line
-- (an outline_candidate) in place. Until now saved Tracks / Lines could be
-- zoomed, deleted, or closed into a temp paddock, but their LineString geometry
-- could not be edited: create_land_area_track (mig 130) only mints a new line,
-- and update_land_area_geometry (mig 127) intentionally REJECTS line geometry
-- because it writes the MultiPolygon-only land_area_geometry_versions history.
--
--   update_land_area_track(p_id text, p_line_geojson jsonb)
--     management / admin only. Rewrites land_areas.raw_geometry in place with a
--     new LineString / MultiLineString. NO new geometry version is written
--     (the append-only land_area_geometry_versions table is polygon history
--     only), NO acreage is computed, kind / geometry_status / parent_id /
--     baseline_no_history are untouched, and the line is NOT promoted to a
--     permanent area. This preserves the Tracks / Lines contract: draft geometry
--     only — no acreage, no move destination, no rotation seeding, no direct
--     permanent promotion.
--
-- Guard rails:
--   - Only an existing, non-deleted area whose kind = 'outline_candidate' AND
--     geometry_status = 'outline_candidate' is editable here. A real closed
--     polygon paddock/pasture must keep editing its boundary through
--     update_land_area_geometry; it can never be reshaped into a line via this
--     RPC.
--   - Geometry must be ST_LineString / ST_MultiLineString with >= 2 points
--     (mirrors create_land_area_track). Polygon / point / empty geometry is
--     rejected with the 'PM_VALIDATION:' prefix; the bare 'authenticated caller
--     required' stays UNprefixed (mig 112/115/116 convention). PostGIS is
--     schema-qualified to the extensions schema.
--   - Polygon boundary edit behaviour (update_land_area_geometry) is unchanged.
--
-- Return shape is _land_area_summary(p_id), same as the other area RPCs, so the
-- client can refresh the edited line from the response. No new return shape is
-- introduced, so a running PROD instance does not strictly require the schema
-- reload; the file still emits NOTIFY pgrst, 'reload schema' at the end so a
-- clean re-apply into a fresh environment matches the pasture migration
-- convention (mig 131/132/139/140/141/147) and stays idempotent.
--
-- NO BEGIN/COMMIT: TEST applies via exec_sql; PROD applies with psql
-- --single-transaction. Apply order: TEST first, PROD after Ronnie approval.
-- Depends on: mig 116 (land_areas, _land_area_summary, profile_role),
-- mig 130 (create_land_area_track / outline_candidate track model).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_land_area_track(
  p_id           text,
  p_line_geojson jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    public.land_areas%ROWTYPE;
  v_geom   extensions.geometry;
  v_gtype  text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'update_land_area_track: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot edit Tracks / Lines', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.land_areas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'PM_VALIDATION: land area % not found', p_id;
  END IF;

  -- Open-line edit is ONLY for saved Tracks / Lines (outline candidates). A real
  -- closed polygon area keeps its boundary edited through update_land_area_geometry
  -- and must never be reshaped into a line here.
  IF v_row.kind <> 'outline_candidate' OR v_row.geometry_status <> 'outline_candidate' THEN
    RAISE EXCEPTION 'PM_VALIDATION: % is not an editable Track / Line', p_id;
  END IF;

  IF p_line_geojson IS NULL OR jsonb_typeof(p_line_geojson) <> 'object' THEN
    RAISE EXCEPTION 'PM_VALIDATION: a GeoJSON LineString object is required';
  END IF;

  v_geom := extensions.ST_Force2D(extensions.ST_SetSRID(
              extensions.ST_GeomFromGeoJSON(p_line_geojson::text), 4326));
  v_gtype := extensions.ST_GeometryType(v_geom);
  IF v_gtype NOT IN ('ST_LineString', 'ST_MultiLineString') THEN
    RAISE EXCEPTION 'PM_VALIDATION: edited Track / Line must be a line (got %)', v_gtype;
  END IF;
  IF extensions.ST_NPoints(v_geom) < 2 THEN
    RAISE EXCEPTION 'PM_VALIDATION: edited Track / Line needs at least two points';
  END IF;

  -- Draft geometry only: rewrite raw_geometry in place. No acreage, no version
  -- row, no move destination, no rotation seeding, no permanent promotion;
  -- kind / geometry_status / parent_id / baseline_no_history stay as they were.
  UPDATE public.land_areas
     SET raw_geometry = v_geom,
         updated_at   = now()
   WHERE id = p_id;

  RETURN public._land_area_summary(p_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.update_land_area_track(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_land_area_track(text, jsonb) TO authenticated;

-- Schema reload for clean re-apply into fresh environments / convention parity.
NOTIFY pgrst, 'reload schema';
