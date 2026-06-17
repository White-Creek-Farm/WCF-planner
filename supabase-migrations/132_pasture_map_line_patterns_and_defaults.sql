-- ============================================================================
-- 132_pasture_map_line_patterns_and_defaults.sql
-- ----------------------------------------------------------------------------
-- Adds a line_pattern field (solid / dashed / dotted), separates boundary
-- styling into its own RPC, sets GPS field tracks to white 5px dashed by
-- default, and restyles already-imported OnX line outlines to red 5px solid.
--
-- Depends on: 116, 128, 130, 131.
-- ============================================================================

ALTER TABLE public.land_areas
  ADD COLUMN IF NOT EXISTS line_pattern text;

DO $$
BEGIN
  ALTER TABLE public.land_areas
    ADD CONSTRAINT land_areas_line_pattern_check
    CHECK (line_pattern IS NULL OR line_pattern IN ('solid', 'dashed', 'dotted'));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

COMMENT ON COLUMN public.land_areas.line_pattern IS
  'Optional manager-selected boundary stroke pattern: solid, dashed, or dotted.';

-- Restyle currently imported OnX line outlines as requested. This intentionally
-- targets LineString/MultiLineString raw geometries only, not imported polygons.
UPDATE public.land_areas
   SET line_color = '#dc2626',
       line_weight = 5,
       line_pattern = 'solid',
       updated_at = now()
 WHERE deleted_at IS NULL
   AND source = 'onx_kml'
   AND raw_geometry IS NOT NULL
   AND extensions.ST_GeometryType(raw_geometry) IN ('ST_LineString', 'ST_MultiLineString');

CREATE OR REPLACE FUNCTION public._land_area_summary(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
STABLE
AS $fn$
DECLARE
  v_out jsonb;
  v_current jsonb;
  v_current_count int := 0;
  v_last_departure timestamptz;
  v_last_touch timestamptz;
  v_baseline boolean := true;
  v_rest_days int;
  v_rest_state text;
BEGIN
  WITH latest AS (
    SELECT DISTINCT ON (m.animal_type, m.group_key) m.*
      FROM public.pasture_move_events m
     ORDER BY m.animal_type, m.group_key, m.moved_at DESC, m.created_at DESC
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'move_id', l.id,
           'animal_type', l.animal_type,
           'group_key', l.group_key,
           'group_label', l.group_label,
           'moved_at', l.moved_at,
           'animal_count', l.animal_count,
           'impact_kind', i.impact_kind
         ) ORDER BY l.animal_type, l.group_label), '[]'::jsonb),
         count(*)::int
    INTO v_current, v_current_count
    FROM latest l
    JOIN public.pasture_move_impacts i
      ON i.move_id = l.id
     AND i.land_area_id = p_id
     AND i.impact_kind IN ('destination', 'overlap');

  SELECT max(impacted_at)
    INTO v_last_departure
    FROM public.pasture_move_impacts
   WHERE land_area_id = p_id
     AND impact_kind = 'departure';

  SELECT max(impacted_at)
    INTO v_last_touch
    FROM public.pasture_move_impacts
   WHERE land_area_id = p_id
     AND impact_kind IN ('destination', 'overlap');

  SELECT baseline_no_history
    INTO v_baseline
    FROM public.land_areas
   WHERE id = p_id;

  IF v_current_count > 0 THEN
    v_rest_days := 0;
    v_rest_state := 'occupied';
  ELSIF v_last_departure IS NOT NULL THEN
    v_rest_days := floor(extract(epoch from (now() - v_last_departure)) / 86400)::int;
    v_rest_state := CASE WHEN v_rest_days < 60 THEN 'resting' ELSE 'rested' END;
  ELSIF COALESCE(v_baseline, true) THEN
    v_rest_days := NULL;
    v_rest_state := 'baseline';
  ELSE
    v_rest_days := NULL;
    v_rest_state := 'no_history';
  END IF;

  SELECT jsonb_build_object(
    'id', a.id,
    'parent_id', a.parent_id,
    'kind', a.kind,
    'name', a.name,
    'permanence', a.permanence,
    'designation', a.designation,
    'status', a.status,
    'review_status', a.review_status,
    'geometry_status', a.geometry_status,
    'baseline_no_history', a.baseline_no_history,
    'manual_acres', a.manual_acres,
    'computed_acres', a.computed_acres,
    'effective_acres', COALESCE(a.manual_acres, a.computed_acres),
    'source', a.source,
    'source_external_id', a.source_external_id,
    'import_batch_id', a.import_batch_id,
    'raw_name', a.raw_name,
    'raw_notes', a.raw_notes,
    'raw_color', a.raw_color,
    'line_color', a.line_color,
    'line_weight', a.line_weight,
    'line_pattern', a.line_pattern,
    'created_at', a.created_at,
    'updated_at', a.updated_at,
    'child_count', (SELECT count(*) FROM public.land_areas c
                     WHERE c.parent_id = a.id AND c.deleted_at IS NULL),
    'raw_geometry', CASE WHEN a.raw_geometry IS NULL THEN NULL
                         ELSE extensions.ST_AsGeoJSON(a.raw_geometry)::jsonb END,
    'current_version', (
      SELECT jsonb_build_object(
        'id', v.id,
        'version_number', v.version_number,
        'computed_acres', v.computed_acres,
        'created_at', v.created_at,
        'geometry', extensions.ST_AsGeoJSON(v.geom)::jsonb)
      FROM public.land_area_geometry_versions v
      WHERE v.land_area_id = a.id
      ORDER BY v.version_number DESC
      LIMIT 1
    ),
    'current_occupants', v_current,
    'current_occupancy_count', v_current_count,
    'last_touched_at', v_last_touch,
    'last_moved_out_at', v_last_departure,
    'rest_days', v_rest_days,
    'rest_state', v_rest_state
  )
  INTO v_out
  FROM public.land_areas a
  WHERE a.id = p_id;

  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public._land_area_summary(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.update_land_area_line_style(
  p_id           text,
  p_line_color   text DEFAULT NULL,
  p_line_weight  integer DEFAULT NULL,
  p_line_pattern text DEFAULT NULL,
  p_clear         boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    public.land_areas%ROWTYPE;
  v_color  text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'update_land_area_line_style: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot edit land area line style', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.land_areas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'PM_VALIDATION: land area % not found', p_id;
  END IF;

  IF p_clear THEN
    UPDATE public.land_areas
       SET line_color = NULL,
           line_weight = NULL,
           line_pattern = NULL,
           updated_at = now()
     WHERE id = p_id;
    RETURN public._land_area_summary(p_id);
  END IF;

  IF p_line_color IS NOT NULL THEN
    v_color := lower(btrim(p_line_color));
    IF v_color !~ '^#[0-9a-f]{6}$' THEN
      RAISE EXCEPTION 'PM_VALIDATION: line_color must be a 6-digit hex color';
    END IF;
  END IF;

  IF p_line_weight IS NOT NULL AND (p_line_weight < 1 OR p_line_weight > 10) THEN
    RAISE EXCEPTION 'PM_VALIDATION: line_weight must be between 1 and 10';
  END IF;

  IF p_line_pattern IS NOT NULL AND p_line_pattern NOT IN ('solid', 'dashed', 'dotted') THEN
    RAISE EXCEPTION 'PM_VALIDATION: line_pattern must be solid, dashed, or dotted';
  END IF;

  UPDATE public.land_areas
     SET line_color = COALESCE(v_color, line_color),
         line_weight = COALESCE(p_line_weight, line_weight),
         line_pattern = COALESCE(p_line_pattern, line_pattern),
         updated_at = now()
   WHERE id = p_id;

  RETURN public._land_area_summary(p_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.update_land_area_line_style(text, text, integer, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_land_area_line_style(text, text, integer, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_land_area_track(
  p_id           text,
  p_name         text,
  p_line_geojson jsonb,
  p_source       text DEFAULT 'drawn'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_geom   extensions.geometry;
  v_gtype  text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'create_land_area_track: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot create field tracks', COALESCE(v_role, 'null');
  END IF;

  IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9-]+$' OR length(p_id) > 100 THEN
    RAISE EXCEPTION 'PM_VALIDATION: invalid track id';
  END IF;

  IF EXISTS (SELECT 1 FROM public.land_areas WHERE id = p_id) THEN
    RETURN public._land_area_summary(p_id) || jsonb_build_object('replayed', true);
  END IF;

  IF p_name IS NULL OR length(btrim(p_name)) = 0 OR length(p_name) > 200 THEN
    RAISE EXCEPTION 'PM_VALIDATION: name must be 1..200 characters';
  END IF;
  IF COALESCE(p_source, '') NOT IN ('drawn', 'manual') THEN
    RAISE EXCEPTION 'PM_VALIDATION: track source must be drawn/manual';
  END IF;
  IF p_line_geojson IS NULL OR jsonb_typeof(p_line_geojson) <> 'object' THEN
    RAISE EXCEPTION 'PM_VALIDATION: a GeoJSON LineString object is required';
  END IF;

  v_geom := extensions.ST_Force2D(extensions.ST_SetSRID(
              extensions.ST_GeomFromGeoJSON(p_line_geojson::text), 4326));
  v_gtype := extensions.ST_GeometryType(v_geom);
  IF v_gtype NOT IN ('ST_LineString', 'ST_MultiLineString') THEN
    RAISE EXCEPTION 'PM_VALIDATION: field track must be a line (got %)', v_gtype;
  END IF;
  IF extensions.ST_NPoints(v_geom) < 2 THEN
    RAISE EXCEPTION 'PM_VALIDATION: field track needs at least two GPS points';
  END IF;

  INSERT INTO public.land_areas
    (id, kind, name, status, review_status, geometry_status, baseline_no_history,
     raw_geometry, source, raw_notes, line_color, line_weight, line_pattern, created_by)
  VALUES
    (p_id, 'outline_candidate', btrim(p_name), 'active', 'pending_review',
     'outline_candidate', true, v_geom, p_source, 'created_via=field_track',
     '#ffffff', 5, 'dashed', v_caller);

  RETURN public._land_area_summary(p_id) || jsonb_build_object('replayed', false);
END
$fn$;

REVOKE ALL ON FUNCTION public.create_land_area_track(text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_land_area_track(text, text, jsonb, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
