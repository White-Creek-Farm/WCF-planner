-- ============================================================================
-- 141_pasture_map_measurements.sql
-- Pasture Map V1 reset: SAVED distance measurements.
--
-- Measure has always been a transient line ruler. V1 lets a user SAVE a distance
-- measurement as a lightweight, named layer item. A measurement is a distance
-- LineString ONLY: nameable, deletable, optional line color. It is deliberately
-- NOT a land area -- it has no acreage, is never a move destination, and has no
-- rest / occupancy / report effect. Geometry is stored verbatim as GeoJSON
-- (jsonb); the client computes/holds the distance. There is no geometry-edit RPC
-- (measurements are immutable once saved -- delete and re-measure to change one).
--
-- Access mirrors the other farm_team-level pasture surfaces: farm_team /
-- management / admin / light may read and create; delete is creator-or-management
-- (a light/farm_team user cannot delete someone else's measurement). All access
-- is through SECURITY DEFINER RPCs; the table is deny-all.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pasture_measurements (
  id text PRIMARY KEY,
  name text NOT NULL,
  geometry jsonb NOT NULL,
  distance_ft numeric(12, 2),
  line_color text CHECK (line_color IS NULL OR line_color ~ '^#[0-9A-Fa-f]{6}$'),
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pasture_measurements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pasture_measurements FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pasture_measurements' AND policyname = 'pasture_measurements_deny_all'
  ) THEN
    CREATE POLICY pasture_measurements_deny_all ON public.pasture_measurements FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- list_pasture_measurements() -> { measurements: [ {id,name,geometry,distance_ft,line_color,created_at} ] }
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_pasture_measurements()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_rows jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE 'list_pasture_measurements: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE 'PM_VALIDATION: caller role % cannot read pasture measurements', coalesce(v_role, '(none)');
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'name', m.name,
        'geometry', m.geometry,
        'distance_ft', m.distance_ft,
        'line_color', m.line_color,
        'created_at', m.created_at
      )
      ORDER BY m.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.pasture_measurements m;

  RETURN jsonb_build_object('measurements', v_rows);
END
$fn$;

-- ---------------------------------------------------------------------------
-- create_pasture_measurement(id, name, geometry jsonb, distance_ft, line_color)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_pasture_measurement(
  p_id text,
  p_name text,
  p_geometry jsonb,
  p_distance_ft numeric DEFAULT NULL,
  p_line_color text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE 'create_pasture_measurement: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE 'PM_VALIDATION: caller role % cannot create pasture measurements', coalesce(v_role, '(none)');
  END IF;
  IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9-]+$' THEN
    RAISE 'PM_VALIDATION: invalid measurement id';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE 'PM_VALIDATION: measurement name required';
  END IF;
  IF p_geometry IS NULL OR p_geometry->>'type' <> 'LineString'
     OR jsonb_typeof(p_geometry->'coordinates') <> 'array'
     OR jsonb_array_length(p_geometry->'coordinates') < 2 THEN
    RAISE 'PM_VALIDATION: measurement geometry must be a LineString with >= 2 points';
  END IF;
  IF p_line_color IS NOT NULL AND p_line_color !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE 'PM_VALIDATION: invalid line_color';
  END IF;

  INSERT INTO public.pasture_measurements (id, name, geometry, distance_ft, line_color, created_by)
  VALUES (p_id, btrim(p_name), p_geometry, p_distance_ft, p_line_color, v_caller)
  ON CONFLICT (id) DO NOTHING;

  RETURN jsonb_build_object('id', p_id, 'name', btrim(p_name), 'geometry', p_geometry,
                            'distance_ft', p_distance_ft, 'line_color', p_line_color);
END
$fn$;

-- ---------------------------------------------------------------------------
-- delete_pasture_measurement(id) -> creator-or-management only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_pasture_measurement(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_owner uuid;
BEGIN
  IF v_caller IS NULL THEN
    RAISE 'delete_pasture_measurement: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE 'PM_VALIDATION: caller role % cannot delete pasture measurements', coalesce(v_role, '(none)');
  END IF;

  SELECT created_by INTO v_owner FROM public.pasture_measurements WHERE id = p_id;
  IF v_owner IS NULL AND NOT EXISTS (SELECT 1 FROM public.pasture_measurements WHERE id = p_id) THEN
    RETURN jsonb_build_object('deleted', false);
  END IF;
  IF v_role NOT IN ('management', 'admin') AND v_owner IS DISTINCT FROM v_caller THEN
    RAISE 'PM_VALIDATION: only the creator or management can delete this measurement';
  END IF;

  DELETE FROM public.pasture_measurements WHERE id = p_id;
  RETURN jsonb_build_object('deleted', true);
END
$fn$;

REVOKE ALL ON FUNCTION public.list_pasture_measurements() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_pasture_measurement(text, text, jsonb, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_pasture_measurement(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pasture_measurements() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_pasture_measurement(text, text, jsonb, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_pasture_measurement(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
