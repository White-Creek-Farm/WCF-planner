-- ============================================================================
-- 148 - Pasture group records: actual-weight snapshots + planned-move cleanup
-- ----------------------------------------------------------------------------
-- - Adds pasture_move_events.total_weight_lbs for move-time actual group weight
--   snapshots. The client only sends this when the roster has recorded weight
--   data; unknown remains NULL.
-- - Recreates record/list/history RPCs so the snapshot is written and returned.
-- - Drops the unused planned-move worklist table/RPCs. Rotation order is now the
--   planning source, and the group record page records the next rotation move.
-- ============================================================================

ALTER TABLE public.pasture_move_events
  ADD COLUMN IF NOT EXISTS total_weight_lbs numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'pasture_move_events_total_weight_lbs_positive'
       AND conrelid = 'public.pasture_move_events'::regclass
  ) THEN
    ALTER TABLE public.pasture_move_events
      ADD CONSTRAINT pasture_move_events_total_weight_lbs_positive
      CHECK (total_weight_lbs IS NULL OR total_weight_lbs > 0);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._pasture_move_summary(p_id text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
STABLE
AS $fn$
  SELECT jsonb_build_object(
    'id', m.id,
    'animal_type', m.animal_type,
    'group_key', m.group_key,
    'group_label', m.group_label,
    'from_land_area_id', m.from_land_area_id,
    'from_land_area_name', fa.name,
    'to_land_area_id', m.to_land_area_id,
    'to_land_area_name', ta.name,
    'moved_at', m.moved_at,
    'animal_count', m.animal_count,
    'total_weight_lbs', m.total_weight_lbs,
    'notes', m.notes,
    'created_at', m.created_at,
    'impact_count', (
      SELECT count(*) FROM public.pasture_move_impacts i WHERE i.move_id = m.id
    )
  )
  FROM public.pasture_move_events m
  LEFT JOIN public.land_areas fa ON fa.id = m.from_land_area_id
  LEFT JOIN public.land_areas ta ON ta.id = m.to_land_area_id
  WHERE m.id = p_id;
$fn$;
REVOKE ALL ON FUNCTION public._pasture_move_summary(text) FROM PUBLIC, anon, authenticated;

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
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_rows jsonb;
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
    INTO v_rows
    FROM (
      SELECT id, moved_at, created_at
        FROM public.pasture_move_events
       ORDER BY moved_at DESC, created_at DESC
       LIMIT v_limit
    ) m;

  RETURN jsonb_build_object('moves', v_rows);
END
$fn$;
REVOKE ALL ON FUNCTION public.list_pasture_moves(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pasture_moves(int) TO authenticated;

DROP FUNCTION IF EXISTS public.record_pasture_move(text, text, text, text, text, timestamptz, int, text);
DROP FUNCTION IF EXISTS public.record_pasture_move(text, text, text, text, text, timestamptz, int, numeric, text);

CREATE OR REPLACE FUNCTION public.record_pasture_move(
  p_move_id          text,
  p_animal_type      text,
  p_group_key        text,
  p_group_label      text,
  p_to_land_area_id  text,
  p_moved_at         timestamptz,
  p_animal_count     int DEFAULT NULL,
  p_total_weight_lbs numeric DEFAULT NULL,
  p_notes            text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_prev public.pasture_move_events%ROWTYPE;
  v_to public.land_areas%ROWTYPE;
  v_to_geom extensions.geometry;
  v_conflict text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'record_pasture_move: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot record pasture moves', COALESCE(v_role, 'null');
  END IF;

  IF p_move_id IS NULL OR p_move_id !~ '^[A-Za-z0-9-]+$' OR length(p_move_id) > 100 THEN
    RAISE EXCEPTION 'PM_VALIDATION: invalid move id';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pasture_move_events WHERE id = p_move_id) THEN
    RETURN public._pasture_move_summary(p_move_id) || jsonb_build_object('replayed', true);
  END IF;

  IF p_animal_type NOT IN ('cattle_herd', 'sheep_flock', 'breeder_pigs', 'feeder_pigs') THEN
    RAISE EXCEPTION 'PM_VALIDATION: unknown animal type %', COALESCE(p_animal_type, 'null');
  END IF;
  IF p_group_key IS NULL OR length(btrim(p_group_key)) = 0 OR length(p_group_key) > 120 THEN
    RAISE EXCEPTION 'PM_VALIDATION: group key required';
  END IF;
  IF p_group_label IS NULL OR length(btrim(p_group_label)) = 0 OR length(p_group_label) > 160 THEN
    RAISE EXCEPTION 'PM_VALIDATION: group label required';
  END IF;
  IF p_moved_at IS NULL THEN
    RAISE EXCEPTION 'PM_VALIDATION: moved_at required';
  END IF;
  IF p_animal_count IS NOT NULL AND p_animal_count <= 0 THEN
    RAISE EXCEPTION 'PM_VALIDATION: animal_count must be positive';
  END IF;
  IF p_total_weight_lbs IS NOT NULL AND p_total_weight_lbs <= 0 THEN
    RAISE EXCEPTION 'PM_VALIDATION: total_weight_lbs must be positive';
  END IF;

  IF p_to_land_area_id IS NOT NULL THEN
    SELECT * INTO v_to
      FROM public.land_areas
     WHERE id = p_to_land_area_id
       AND deleted_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PM_VALIDATION: destination land area % not found', p_to_land_area_id;
    END IF;
    IF v_to.status <> 'active' THEN
      RAISE EXCEPTION 'PM_VALIDATION: destination land area % is not active', p_to_land_area_id;
    END IF;
    v_to_geom := public._land_area_current_geom(p_to_land_area_id);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pasture_move_group'), hashtext(p_animal_type || ':' || btrim(p_group_key)));

  SELECT * INTO v_prev
    FROM public.pasture_move_events
   WHERE animal_type = p_animal_type
     AND group_key = btrim(p_group_key)
   ORDER BY moved_at DESC, created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF p_animal_type = 'feeder_pigs' AND p_to_land_area_id IS NOT NULL THEN
    WITH latest AS (
      SELECT DISTINCT ON (m.animal_type, m.group_key) m.*
        FROM public.pasture_move_events m
       ORDER BY m.animal_type, m.group_key, m.moved_at DESC, m.created_at DESC
    ),
    target_impacts AS (
      SELECT p_to_land_area_id AS land_area_id
      UNION
      SELECT a.id
        FROM public.land_areas a
       WHERE v_to_geom IS NOT NULL
         AND a.id <> p_to_land_area_id
         AND a.deleted_at IS NULL
         AND a.status = 'active'
         AND a.geometry_status = 'valid'
         AND public._land_area_current_geom(a.id) IS NOT NULL
         AND extensions.ST_Intersects(public._land_area_current_geom(a.id), v_to_geom)
    )
    SELECT l.group_label
      INTO v_conflict
      FROM latest l
      JOIN public.pasture_move_impacts i
        ON i.move_id = l.id
       AND i.impact_kind IN ('destination', 'overlap')
      JOIN target_impacts ti
        ON ti.land_area_id = i.land_area_id
     WHERE l.animal_type = 'feeder_pigs'
       AND l.group_key <> btrim(p_group_key)
     LIMIT 1;

    IF v_conflict IS NOT NULL THEN
      RAISE EXCEPTION 'PM_VALIDATION: feeder pig area already occupied by %', v_conflict;
    END IF;
  END IF;

  INSERT INTO public.pasture_move_events
    (id, animal_type, group_key, group_label, from_land_area_id, to_land_area_id,
     moved_at, animal_count, total_weight_lbs, notes, created_by)
  VALUES
    (p_move_id, p_animal_type, btrim(p_group_key), btrim(p_group_label),
     v_prev.to_land_area_id, p_to_land_area_id, p_moved_at, p_animal_count,
     p_total_weight_lbs, NULLIF(btrim(COALESCE(p_notes, '')), ''), v_caller);

  IF v_prev.id IS NOT NULL THEN
    INSERT INTO public.pasture_move_impacts (move_id, land_area_id, impact_kind, impacted_at)
    SELECT p_move_id, i.land_area_id, 'departure', p_moved_at
      FROM public.pasture_move_impacts i
     WHERE i.move_id = v_prev.id
       AND i.impact_kind IN ('destination', 'overlap')
    ON CONFLICT DO NOTHING;
  END IF;

  IF p_to_land_area_id IS NOT NULL THEN
    INSERT INTO public.pasture_move_impacts (move_id, land_area_id, impact_kind, impacted_at)
    VALUES (p_move_id, p_to_land_area_id, 'destination', p_moved_at)
    ON CONFLICT DO NOTHING;

    IF v_to_geom IS NOT NULL THEN
      INSERT INTO public.pasture_move_impacts (move_id, land_area_id, impact_kind, impacted_at)
      SELECT p_move_id, a.id, 'overlap', p_moved_at
        FROM public.land_areas a
       WHERE a.id <> p_to_land_area_id
         AND a.deleted_at IS NULL
         AND a.status = 'active'
         AND a.geometry_status = 'valid'
         AND public._land_area_current_geom(a.id) IS NOT NULL
         AND extensions.ST_Intersects(public._land_area_current_geom(a.id), v_to_geom)
      ON CONFLICT DO NOTHING;
    END IF;

    UPDATE public.land_areas
       SET baseline_no_history = false,
           updated_at = now()
     WHERE id IN (
       SELECT land_area_id
         FROM public.pasture_move_impacts
        WHERE move_id = p_move_id
          AND impact_kind IN ('destination', 'overlap')
     );
  END IF;

  UPDATE public.land_areas
     SET baseline_no_history = false,
         updated_at = now()
   WHERE id IN (
     SELECT land_area_id
       FROM public.pasture_move_impacts
      WHERE move_id = p_move_id
        AND impact_kind = 'departure'
   );

  RETURN public._pasture_move_summary(p_move_id) || jsonb_build_object('replayed', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.record_pasture_move(text, text, text, text, text, timestamptz, int, numeric, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_pasture_move(text, text, text, text, text, timestamptz, int, numeric, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.list_pasture_history_report(
  p_land_area_id text DEFAULT NULL,
  p_animal_type text DEFAULT NULL,
  p_group_key text DEFAULT NULL,
  p_limit int DEFAULT 200
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  v_rows jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_pasture_history_report: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot read pasture history', COALESCE(v_role, 'null');
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.moved_at DESC, r.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT m.id,
             m.animal_type,
             m.group_key,
             m.group_label,
             m.from_land_area_id,
             fa.name AS from_land_area_name,
             m.to_land_area_id,
             ta.name AS to_land_area_name,
             COALESCE(ta.manual_acres, ta.computed_acres) AS to_land_area_acres,
             m.moved_at,
             m.animal_count,
             m.total_weight_lbs,
             m.notes,
             m.created_at,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'land_area_id', i.land_area_id,
                 'land_area_name', la.name,
                 'impact_kind', i.impact_kind,
                 'impacted_at', i.impacted_at
               ) ORDER BY i.impact_kind, la.name)
               FROM public.pasture_move_impacts i
               JOIN public.land_areas la ON la.id = i.land_area_id
               WHERE i.move_id = m.id
             ), '[]'::jsonb) AS impacted_areas
        FROM public.pasture_move_events m
        LEFT JOIN public.land_areas fa ON fa.id = m.from_land_area_id
        LEFT JOIN public.land_areas ta ON ta.id = m.to_land_area_id
       WHERE (p_animal_type IS NULL OR m.animal_type = p_animal_type)
         AND (p_group_key IS NULL OR m.group_key = p_group_key)
         AND (
           p_land_area_id IS NULL
           OR m.from_land_area_id = p_land_area_id
           OR m.to_land_area_id = p_land_area_id
           OR EXISTS (
             SELECT 1 FROM public.pasture_move_impacts i
              WHERE i.move_id = m.id
                AND i.land_area_id = p_land_area_id
           )
         )
       ORDER BY m.moved_at DESC, m.created_at DESC
       LIMIT v_limit
    ) r;

  RETURN jsonb_build_object('history', v_rows);
END
$fn$;
REVOKE ALL ON FUNCTION public.list_pasture_history_report(text, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pasture_history_report(text, text, text, int) TO authenticated;

DROP FUNCTION IF EXISTS public.update_pasture_planned_move_status(text, text, text);
DROP FUNCTION IF EXISTS public.create_pasture_planned_move(text, text, text, text, text, timestamptz, int, text);
DROP FUNCTION IF EXISTS public.list_pasture_planned_moves(text, int);
DROP FUNCTION IF EXISTS public._pasture_planned_move_summary(text);
DROP TABLE IF EXISTS public.pasture_planned_moves;

NOTIFY pgrst, 'reload schema';
