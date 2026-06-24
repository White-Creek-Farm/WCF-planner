-- ============================================================================
-- 139_pasture_map_light_farm_team.sql
-- Light users get farm_team-level Pasture Map access (V1 reset, Ronnie-approved).
--
-- This is the V1-reset widening that promotes 'light' from the Map-only,
-- read-only access granted in mig 136 (list_land_areas, list_pasture_moves) to
-- full farm_team-level participation in the Pasture Map: light users may record
-- moves, plan/report, walk field tracks, and manage their OWN temp paddocks,
-- exactly like a farm_team member. This change is pasture-scoped ONLY; it does
-- NOT touch any non-pasture RPC, and it does NOT loosen the management/admin
-- locks on permanent-area geometry edits or the admin-only hard delete.
--
-- This migration ONLY widens the role IN-list of each RPC below from
-- ('farm_team','management','admin') to ('farm_team','management','admin','light').
-- Following mig 136's convention, bodies are reproduced VERBATIM from their
-- current source migrations and the ONLY change is adding 'light' to that gate;
-- the error-message text is NOT changed because these gates do not enumerate the
-- allowed roles in the message (they print the offending caller role only),
-- which is identical to what mig 136 did. All ownership sub-checks
-- (own-row temp-paddock checks), the PM_AREA_OCCUPIED occupancy guard, and the
-- feeder-pig exclusivity logic are preserved unchanged.
--
-- 13 widened RPCs (current source migration in parens):
--    1. record_pasture_move                 (128)
--    2. list_pasture_planned_moves          (129)
--    3. create_pasture_planned_move         (129)
--    4. update_pasture_planned_move_status  (129)
--    5. list_pasture_history_report         (129)
--    6. list_pasture_rest_report            (129)
--    7. list_pasture_stocking_report        (129)
--    8. create_land_area_track              (132 — redefined there, NOT 130)
--    9. create_temp_land_area               (135)
--   10. update_temp_land_area_geometry      (135)
--   11. rename_temp_land_area               (135)
--   12. archive_land_area                   (135)
--   13. restore_land_area                   (135)
--
-- NOT widened (intentionally absent from this migration): import_land_area_batch,
-- create_land_area, update_land_area, update_land_area_geometry,
-- close_land_area_outline, delete_land_area (mgmt/admin); update_land_area_line_style
-- (mgmt/admin); hard_delete_land_area (admin only).
--
-- Idempotent: pure CREATE OR REPLACE of thirteen functions; safe to re-run.
-- NO BEGIN/COMMIT: TEST applies via exec_sql; PROD applies with psql
-- --single-transaction. Apply order: TEST first, PROD after Ronnie approval.
-- ============================================================================

-- 1. record_pasture_move (body verbatim from 128; +light in role gate) ────────
CREATE OR REPLACE FUNCTION public.record_pasture_move(
  p_move_id         text,
  p_animal_type     text,
  p_group_key       text,
  p_group_label     text,
  p_to_land_area_id text,
  p_moved_at        timestamptz,
  p_animal_count    int DEFAULT NULL,
  p_notes           text DEFAULT NULL
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

  -- Serialize one group so concurrent field tablets cannot double-open a group.
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
     moved_at, animal_count, notes, created_by)
  VALUES
    (p_move_id, p_animal_type, btrim(p_group_key), btrim(p_group_label),
     v_prev.to_land_area_id, p_to_land_area_id, p_moved_at, p_animal_count,
     NULLIF(btrim(COALESCE(p_notes, '')), ''), v_caller);

  -- Close the prior move's touched areas so rest starts for all impacted units.
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

    -- If the destination geometry overlaps any other active polygon, mark those
    -- areas as touched too. This is what lets ad-hoc sheep/breeder-pig areas
    -- reset rest on the permanent paddocks they cross.
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

  -- The previous area also now has real history.
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
REVOKE ALL ON FUNCTION public.record_pasture_move(text, text, text, text, text, timestamptz, int, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_pasture_move(text, text, text, text, text, timestamptz, int, text)
  TO authenticated;

-- 2. list_pasture_planned_moves (body verbatim from 129; +light) ──────────────
CREATE OR REPLACE FUNCTION public.list_pasture_planned_moves(
  p_status text DEFAULT 'planned',
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
  v_status text := COALESCE(NULLIF(btrim(p_status), ''), 'planned');
  v_rows jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_pasture_planned_moves: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot read pasture plans', COALESCE(v_role, 'null');
  END IF;

  IF v_status <> 'all' AND v_status NOT IN ('planned', 'completed', 'skipped', 'canceled') THEN
    RAISE EXCEPTION 'PM_VALIDATION: invalid planned move status %', v_status;
  END IF;

  SELECT COALESCE(jsonb_agg(public._pasture_planned_move_summary(p.id)
           ORDER BY p.planned_for, p.created_at), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT id, planned_for, created_at
        FROM public.pasture_planned_moves
       WHERE v_status = 'all' OR status = v_status
       ORDER BY CASE WHEN status = 'planned' THEN 0 ELSE 1 END,
                planned_for,
                created_at
       LIMIT v_limit
    ) p;

  RETURN jsonb_build_object('planned_moves', v_rows);
END
$fn$;
REVOKE ALL ON FUNCTION public.list_pasture_planned_moves(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pasture_planned_moves(text, int) TO authenticated;

-- 3. create_pasture_planned_move (body verbatim from 129; +light) ─────────────
CREATE OR REPLACE FUNCTION public.create_pasture_planned_move(
  p_plan_id         text,
  p_animal_type     text,
  p_group_key       text,
  p_group_label     text,
  p_to_land_area_id text,
  p_planned_for     timestamptz,
  p_animal_count    int DEFAULT NULL,
  p_notes           text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_to public.land_areas%ROWTYPE;
  v_from_id text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'create_pasture_planned_move: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot create pasture plans', COALESCE(v_role, 'null');
  END IF;

  IF p_plan_id IS NULL OR p_plan_id !~ '^[A-Za-z0-9-]+$' OR length(p_plan_id) > 100 THEN
    RAISE EXCEPTION 'PM_VALIDATION: invalid planned move id';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pasture_planned_moves WHERE id = p_plan_id) THEN
    RETURN public._pasture_planned_move_summary(p_plan_id) || jsonb_build_object('replayed', true);
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
  IF p_planned_for IS NULL THEN
    RAISE EXCEPTION 'PM_VALIDATION: planned_for required';
  END IF;
  IF p_animal_count IS NOT NULL AND p_animal_count <= 0 THEN
    RAISE EXCEPTION 'PM_VALIDATION: animal_count must be positive';
  END IF;

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

  SELECT m.to_land_area_id
    INTO v_from_id
    FROM public.pasture_move_events m
   WHERE m.animal_type = p_animal_type
     AND m.group_key = btrim(p_group_key)
   ORDER BY m.moved_at DESC, m.created_at DESC
   LIMIT 1;

  INSERT INTO public.pasture_planned_moves
    (id, animal_type, group_key, group_label, from_land_area_id, to_land_area_id,
     planned_for, animal_count, notes, created_by)
  VALUES
    (p_plan_id, p_animal_type, btrim(p_group_key), btrim(p_group_label),
     v_from_id, p_to_land_area_id, p_planned_for, p_animal_count,
     NULLIF(btrim(COALESCE(p_notes, '')), ''), v_caller);

  RETURN public._pasture_planned_move_summary(p_plan_id) || jsonb_build_object('replayed', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.create_pasture_planned_move(text, text, text, text, text, timestamptz, int, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pasture_planned_move(text, text, text, text, text, timestamptz, int, text)
  TO authenticated;

-- 4. update_pasture_planned_move_status (body verbatim from 129; +light) ──────
CREATE OR REPLACE FUNCTION public.update_pasture_planned_move_status(
  p_plan_id text,
  p_status text,
  p_completed_move_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_status text := COALESCE(NULLIF(btrim(p_status), ''), '');
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'update_pasture_planned_move_status: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot update pasture plans', COALESCE(v_role, 'null');
  END IF;
  IF v_status NOT IN ('planned', 'completed', 'skipped', 'canceled') THEN
    RAISE EXCEPTION 'PM_VALIDATION: invalid planned move status %', COALESCE(v_status, 'null');
  END IF;
  IF p_completed_move_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.pasture_move_events WHERE id = p_completed_move_id)
  THEN
    RAISE EXCEPTION 'PM_VALIDATION: completed move % not found', p_completed_move_id;
  END IF;

  UPDATE public.pasture_planned_moves
     SET status = v_status,
         completed_move_id = CASE WHEN v_status = 'completed' THEN p_completed_move_id ELSE NULL END,
         updated_at = now()
   WHERE id = p_plan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PM_VALIDATION: planned move % not found', p_plan_id;
  END IF;

  RETURN public._pasture_planned_move_summary(p_plan_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.update_pasture_planned_move_status(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_pasture_planned_move_status(text, text, text) TO authenticated;

-- 5. list_pasture_history_report (body verbatim from 129; +light) ─────────────
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
             m.moved_at,
             m.animal_count,
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

-- 6. list_pasture_rest_report (body verbatim from 129; +light) ────────────────
CREATE OR REPLACE FUNCTION public.list_pasture_rest_report()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_areas jsonb;
  v_counts jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_pasture_rest_report: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot read pasture rest report', COALESCE(v_role, 'null');
  END IF;

  WITH summaries AS (
    SELECT public._land_area_summary(a.id) AS s
      FROM public.land_areas a
     WHERE a.deleted_at IS NULL
       AND a.status = 'active'
       AND a.kind IN ('unclassified', 'pasture', 'paddock', 'feeder_pig_area', 'section')
  )
  SELECT COALESCE(jsonb_agg(s ORDER BY
           CASE s->>'rest_state'
             WHEN 'occupied' THEN 0
             WHEN 'resting' THEN 1
             WHEN 'rested' THEN 2
             ELSE 3
           END,
           COALESCE((s->>'rest_days')::int, 999999),
           s->>'name'), '[]'::jsonb)
    INTO v_areas
    FROM summaries;

  WITH summaries AS (
    SELECT public._land_area_summary(a.id) AS s
      FROM public.land_areas a
     WHERE a.deleted_at IS NULL
       AND a.status = 'active'
       AND a.kind IN ('unclassified', 'pasture', 'paddock', 'feeder_pig_area', 'section')
  )
  SELECT jsonb_build_object(
           'occupied', count(*) FILTER (WHERE s->>'rest_state' = 'occupied'),
           'resting', count(*) FILTER (WHERE s->>'rest_state' = 'resting'),
           'rested', count(*) FILTER (WHERE s->>'rest_state' = 'rested'),
           'baseline', count(*) FILTER (WHERE s->>'rest_state' IN ('baseline', 'no_history'))
         )
    INTO v_counts
    FROM summaries;

  RETURN jsonb_build_object('areas', v_areas, 'counts', COALESCE(v_counts, '{}'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.list_pasture_rest_report() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pasture_rest_report() TO authenticated;

-- 7. list_pasture_stocking_report (body verbatim from 129; +light) ────────────
CREATE OR REPLACE FUNCTION public.list_pasture_stocking_report(
  p_since timestamptz DEFAULT (now() - interval '365 days'),
  p_until timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_since timestamptz := COALESCE(p_since, now() - interval '365 days');
  v_until timestamptz := COALESCE(p_until, now());
  v_rows jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_pasture_stocking_report: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot read pasture stocking report', COALESCE(v_role, 'null');
  END IF;
  IF v_since >= v_until THEN
    RAISE EXCEPTION 'PM_VALIDATION: since must be before until';
  END IF;

  WITH ordered AS (
    SELECT m.*,
           LEAD(m.moved_at, 1, v_until) OVER (
             PARTITION BY m.animal_type, m.group_key
             ORDER BY m.moved_at, m.created_at, m.id
           ) AS next_moved_at
      FROM public.pasture_move_events m
     WHERE m.moved_at < v_until
  ),
  clipped AS (
    SELECT o.id,
           o.animal_type,
           o.group_key,
           o.group_label,
           o.animal_count,
           GREATEST(o.moved_at, v_since) AS start_at,
           LEAST(o.next_moved_at, v_until) AS end_at
      FROM ordered o
     WHERE o.animal_count IS NOT NULL
       AND o.next_moved_at > v_since
       AND o.moved_at < v_until
  ),
  area_days AS (
    SELECT i.land_area_id,
           c.animal_type,
           c.group_key,
           c.group_label,
           SUM(c.animal_count * GREATEST(extract(epoch from (c.end_at - c.start_at)) / 86400.0, 0)) AS animal_days
      FROM clipped c
      JOIN public.pasture_move_impacts i
        ON i.move_id = c.id
       AND i.impact_kind IN ('destination', 'overlap')
     GROUP BY i.land_area_id, c.animal_type, c.group_key, c.group_label
  ),
  rollup AS (
    SELECT la.id,
           la.name,
           la.kind,
           COALESCE(la.manual_acres, la.computed_acres) AS acres,
           SUM(ad.animal_days) AS animal_days,
           jsonb_agg(jsonb_build_object(
             'animal_type', ad.animal_type,
             'group_key', ad.group_key,
             'group_label', ad.group_label,
             'animal_days', round(ad.animal_days::numeric, 2)
           ) ORDER BY ad.animal_type, ad.group_label) AS groups
      FROM area_days ad
      JOIN public.land_areas la ON la.id = ad.land_area_id
     WHERE la.deleted_at IS NULL
     GROUP BY la.id, la.name, la.kind, COALESCE(la.manual_acres, la.computed_acres)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'land_area_id', r.id,
           'land_area_name', r.name,
           'kind', r.kind,
           'acres', r.acres,
           'animal_days', round(r.animal_days::numeric, 2),
           'animal_days_per_acre',
             CASE WHEN r.acres IS NULL OR r.acres <= 0 THEN NULL
                  ELSE round((r.animal_days / r.acres)::numeric, 2)
             END,
           'groups', r.groups
         ) ORDER BY
           CASE WHEN r.acres IS NULL OR r.acres <= 0 THEN NULL
                ELSE r.animal_days / r.acres
           END DESC NULLS LAST,
           r.name), '[]'::jsonb)
    INTO v_rows
    FROM rollup r;

  RETURN jsonb_build_object('since', v_since, 'until', v_until, 'areas', v_rows);
END
$fn$;
REVOKE ALL ON FUNCTION public.list_pasture_stocking_report(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pasture_stocking_report(timestamptz, timestamptz) TO authenticated;

-- 8. create_land_area_track (body verbatim from 132 — current def, NOT 130; +light) ──
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
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
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

-- 9. create_temp_land_area (body verbatim from 135; +light) ───────────────────
CREATE OR REPLACE FUNCTION public.create_temp_land_area(
  p_id              text,
  p_name            text,
  p_polygon_geojson jsonb,
  p_source          text DEFAULT 'drawn'
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
    RAISE EXCEPTION 'create_temp_land_area: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot create temp paddocks', COALESCE(v_role, 'null');
  END IF;

  IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9-]+$' OR length(p_id) > 100 THEN
    RAISE EXCEPTION 'PM_VALIDATION: invalid land area id';
  END IF;

  -- Replay idempotency: a committed id returns its summary unchanged.
  IF EXISTS (SELECT 1 FROM public.land_areas WHERE id = p_id) THEN
    RETURN public._land_area_summary(p_id) || jsonb_build_object('replayed', true);
  END IF;

  IF p_name IS NULL OR length(btrim(p_name)) = 0 OR length(p_name) > 200 THEN
    RAISE EXCEPTION 'PM_VALIDATION: name must be 1..200 characters';
  END IF;
  IF COALESCE(p_source, '') NOT IN ('drawn', 'manual') THEN
    RAISE EXCEPTION 'PM_VALIDATION: create source must be drawn/manual';
  END IF;
  IF p_polygon_geojson IS NULL OR jsonb_typeof(p_polygon_geojson) <> 'object' THEN
    RAISE EXCEPTION 'PM_VALIDATION: a GeoJSON polygon object is required';
  END IF;

  v_geom  := extensions.ST_Force2D(extensions.ST_SetSRID(
              extensions.ST_GeomFromGeoJSON(p_polygon_geojson::text), 4326));
  v_gtype := extensions.ST_GeometryType(v_geom);
  IF v_gtype NOT IN ('ST_Polygon', 'ST_MultiPolygon') THEN
    RAISE EXCEPTION 'PM_VALIDATION: temp paddock geometry must be a polygon (got %)', v_gtype;
  END IF;
  IF NOT extensions.ST_IsValid(v_geom) THEN
    RAISE EXCEPTION 'PM_VALIDATION: temp paddock polygon is self-intersecting/invalid; fix and retry';
  END IF;

  INSERT INTO public.land_areas
    (id, kind, name, permanence, status, review_status, geometry_status,
     baseline_no_history, source, created_by)
  VALUES
    (p_id, 'paddock', btrim(p_name), 'temporary', 'active', 'reviewed', 'none',
     true, p_source, v_caller);

  PERFORM public._land_area_add_version(
    p_id, v_geom, p_source, jsonb_build_object('created_via', 'temp_draw'), v_caller);

  RETURN public._land_area_summary(p_id) || jsonb_build_object('replayed', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.create_temp_land_area(text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_temp_land_area(text, text, jsonb, text) TO authenticated;

-- 10. update_temp_land_area_geometry (body verbatim from 135; +light) ─────────
--     Preserves the non-mgmt own-row ownership sub-check unchanged.
CREATE OR REPLACE FUNCTION public.update_temp_land_area_geometry(
  p_id              text,
  p_polygon_geojson jsonb
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
    RAISE EXCEPTION 'update_temp_land_area_geometry: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot edit temp paddocks', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.land_areas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'PM_VALIDATION: land area % not found', p_id;
  END IF;
  IF v_row.permanence IS DISTINCT FROM 'temporary' THEN
    RAISE EXCEPTION 'PM_VALIDATION: % is not a temp paddock', p_id;
  END IF;
  IF v_role NOT IN ('management', 'admin') AND v_row.created_by IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'PM_VALIDATION: only the creator or a manager can edit this temp paddock';
  END IF;

  IF p_polygon_geojson IS NULL OR jsonb_typeof(p_polygon_geojson) <> 'object' THEN
    RAISE EXCEPTION 'PM_VALIDATION: a GeoJSON polygon object is required';
  END IF;

  v_geom  := extensions.ST_Force2D(extensions.ST_SetSRID(
              extensions.ST_GeomFromGeoJSON(p_polygon_geojson::text), 4326));
  v_gtype := extensions.ST_GeometryType(v_geom);
  IF v_gtype NOT IN ('ST_Polygon', 'ST_MultiPolygon') THEN
    RAISE EXCEPTION 'PM_VALIDATION: edited geometry must be a polygon (got %)', v_gtype;
  END IF;
  IF NOT extensions.ST_IsValid(v_geom) THEN
    RAISE EXCEPTION 'PM_VALIDATION: edited polygon is self-intersecting/invalid; fix and retry';
  END IF;

  PERFORM public._land_area_add_version(
    p_id, v_geom, 'drawn', jsonb_build_object('edited_via', 'temp_redraw'), v_caller);

  RETURN public._land_area_summary(p_id) || jsonb_build_object('replayed', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.update_temp_land_area_geometry(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_temp_land_area_geometry(text, jsonb) TO authenticated;

-- 11. rename_temp_land_area (body verbatim from 135; +light) ──────────────────
--     Preserves the non-mgmt own-row ownership sub-check unchanged.
CREATE OR REPLACE FUNCTION public.rename_temp_land_area(
  p_id   text,
  p_name text
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
    RAISE EXCEPTION 'rename_temp_land_area: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot rename temp paddocks', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.land_areas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'PM_VALIDATION: land area % not found', p_id;
  END IF;
  IF v_row.permanence IS DISTINCT FROM 'temporary' THEN
    RAISE EXCEPTION 'PM_VALIDATION: % is not a temp paddock', p_id;
  END IF;
  IF v_role NOT IN ('management', 'admin') AND v_row.created_by IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'PM_VALIDATION: only the creator or a manager can rename this temp paddock';
  END IF;

  IF p_name IS NULL OR length(btrim(p_name)) = 0 OR length(p_name) > 200 THEN
    RAISE EXCEPTION 'PM_VALIDATION: name must be 1..200 characters';
  END IF;

  UPDATE public.land_areas
     SET name = btrim(p_name), updated_at = now()
   WHERE id = p_id;

  RETURN public._land_area_summary(p_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.rename_temp_land_area(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_temp_land_area(text, text) TO authenticated;

-- 12. archive_land_area (body verbatim from 135; +light) ──────────────────────
--     Preserves the own-temp ownership sub-check AND the PM_AREA_OCCUPIED guard.
CREATE OR REPLACE FUNCTION public.archive_land_area(
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
    RAISE EXCEPTION 'archive_land_area: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot archive land areas', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.land_areas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'PM_VALIDATION: land area % not found', p_id;
  END IF;

  -- Ownership: a temp paddock can be archived by its creator; everything else
  -- (permanent areas, other people's temp paddocks) is mgmt/admin only.
  IF v_role NOT IN ('management', 'admin') THEN
    IF v_row.permanence IS DISTINCT FROM 'temporary' OR v_row.created_by IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'PM_VALIDATION: caller cannot archive this area';
    END IF;
  END IF;

  IF public._land_area_is_occupied(p_id) THEN
    RAISE EXCEPTION 'PM_VALIDATION: PM_AREA_OCCUPIED';
  END IF;

  IF v_row.status <> 'retired' THEN
    UPDATE public.land_areas
       SET status = 'retired', updated_at = now()
     WHERE id = p_id;
  END IF;

  RETURN public._land_area_summary(p_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.archive_land_area(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_land_area(text) TO authenticated;

-- 13. restore_land_area (body verbatim from 135; +light) ──────────────────────
--     Preserves the own-temp ownership sub-check unchanged.
CREATE OR REPLACE FUNCTION public.restore_land_area(
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
    RAISE EXCEPTION 'restore_land_area: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot restore land areas', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.land_areas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'PM_VALIDATION: land area % not found', p_id;
  END IF;

  IF v_role NOT IN ('management', 'admin') THEN
    IF v_row.permanence IS DISTINCT FROM 'temporary' OR v_row.created_by IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'PM_VALIDATION: caller cannot restore this area';
    END IF;
  END IF;

  IF v_row.status = 'retired' THEN
    UPDATE public.land_areas
       SET status = 'active', updated_at = now()
     WHERE id = p_id;
  END IF;

  RETURN public._land_area_summary(p_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.restore_land_area(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_land_area(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
