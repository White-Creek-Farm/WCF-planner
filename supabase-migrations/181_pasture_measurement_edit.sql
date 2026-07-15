-- 181_pasture_measurement_edit.sql
-- Make saved map measurements manageable from their map feature. Geometry and
-- distance remain the immutable measured result; owners and management may edit
-- the display name/color, while the existing delete RPC owns removal.

CREATE OR REPLACE FUNCTION public.update_pasture_measurement(
  p_id text,
  p_name text,
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
  v_row public.pasture_measurements%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RAISE 'update_pasture_measurement: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE 'PM_VALIDATION: caller role % cannot update pasture measurements', coalesce(v_role, '(none)');
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE 'PM_VALIDATION: measurement name required';
  END IF;
  IF p_line_color IS NOT NULL AND p_line_color !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE 'PM_VALIDATION: invalid line_color';
  END IF;

  SELECT *
    INTO v_row
    FROM public.pasture_measurements
   WHERE id = p_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE 'PM_VALIDATION: measurement not found';
  END IF;
  IF v_role NOT IN ('management', 'admin') AND v_row.created_by IS DISTINCT FROM v_caller THEN
    RAISE 'PM_VALIDATION: only the creator or management can update this measurement';
  END IF;

  UPDATE public.pasture_measurements
     SET name = btrim(p_name),
         line_color = p_line_color
   WHERE id = p_id
   RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'geometry', v_row.geometry,
    'distance_ft', v_row.distance_ft,
    'line_color', v_row.line_color,
    'created_at', v_row.created_at
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.update_pasture_measurement(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_pasture_measurement(text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
