-- ============================================================================
-- 155_pasture_map_departure_overlap_rest.sql
-- ----------------------------------------------------------------------------
-- Defect: after Mommas moved OUT of FP4D2 and INTO adjacent FP4D1, FP4D2 still
-- read "Occupied now / Days rested: 0" and did not show the rested/resting fill.
-- PROD forensics showed the July 3 move wrote BOTH of these impacts on FP4D2:
--
--   departure  (the group left FP4D2)
--   overlap    (FP4D1's geometry intersects FP4D2's boundary)
--
-- _land_area_summary treated the latest overlap as current occupancy, so the
-- same move that started FP4D2's rest also cancelled it. That is backwards for
-- the field workflow: once a group is moved out of an area, that area should
-- begin resting even if the next destination polygon overlaps its boundary.
--
-- Fix: current occupancy / last-touch ignore an overlap impact when the SAME
-- move also has a departure impact for that SAME area. The departure remains
-- valid and continues to drive last_moved_out_at/rest_days. This fixes existing
-- rows read-only; no data mutation required. Child-parent suppression and
-- orphan-impact guards from 147/149 are preserved.
--
-- Also re-issues _land_area_is_occupied with the same occupancy rule so archive
-- / hard-delete guards agree with the map summary.
--
-- Depends on: 149 (latest _land_area_summary body), 135 (_land_area_is_occupied).
-- ============================================================================

CREATE OR REPLACE FUNCTION public._land_area_is_occupied(p_id text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
STABLE
AS $fn$
  WITH latest AS (
    SELECT DISTINCT ON (m.animal_type, m.group_key) m.*
      FROM public.pasture_move_events m
     ORDER BY m.animal_type, m.group_key, m.moved_at DESC, m.created_at DESC
  )
  SELECT EXISTS (
    SELECT 1
      FROM latest l
      JOIN public.pasture_move_impacts i
        ON i.move_id = l.id
       AND i.land_area_id = p_id
       AND i.impact_kind IN ('destination', 'overlap')
       AND l.to_land_area_id IS NOT NULL
       -- Same-move departure wins over overlap: the group moved OUT of this
       -- area, so an adjacent destination overlap must not keep it occupied.
       AND NOT (
         i.impact_kind = 'overlap'
         AND EXISTS (
           SELECT 1
             FROM public.pasture_move_impacts d
            WHERE d.move_id = i.move_id
              AND d.land_area_id = i.land_area_id
              AND d.impact_kind = 'departure'
         )
       )
       -- Preserve mig 147 parent suppression: a child paddock destination does
       -- not make the parent pasture occupied via overlap.
       AND NOT (
         i.impact_kind = 'overlap'
         AND EXISTS (
           SELECT 1 FROM public.land_areas c
            WHERE c.id = l.to_land_area_id
              AND c.parent_id = p_id
         )
       )
  );
$fn$;
REVOKE ALL ON FUNCTION public._land_area_is_occupied(text) FROM PUBLIC, anon, authenticated;

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
     AND i.impact_kind IN ('destination', 'overlap')
     -- Orphan guard: a move whose destination link was nulled (143-reset /
     -- area hard-delete FK SET NULL) is not a current placement anywhere.
     AND l.to_land_area_id IS NOT NULL
     -- Same-move departure wins over overlap: the area is resting after move-out
     -- even when the new destination intersects the old boundary.
     AND NOT (
       i.impact_kind = 'overlap'
       AND EXISTS (
         SELECT 1
           FROM public.pasture_move_impacts d
          WHERE d.move_id = i.move_id
            AND d.land_area_id = i.land_area_id
            AND d.impact_kind = 'departure'
       )
     )
     -- Suppress child-derived occupancy: an overlap impact whose move landed in a
     -- direct child paddock of p_id does NOT make this pasture "occupied".
     AND NOT (
       i.impact_kind = 'overlap'
       AND EXISTS (
         SELECT 1 FROM public.land_areas c
          WHERE c.id = l.to_land_area_id
            AND c.parent_id = p_id
       )
     );

  -- Resting derives from the latest departure; ignore departures whose move left
  -- a direct child paddock of p_id (clearing the child must not rest the parent),
  -- and ignore ORPHAN departures whose move lost its from link (no real prior
  -- stay to rest from -> no visible Reports row would explain "Resting").
  SELECT max(i.impacted_at)
    INTO v_last_departure
    FROM public.pasture_move_impacts i
   WHERE i.land_area_id = p_id
     AND i.impact_kind = 'departure'
     AND EXISTS (
       SELECT 1 FROM public.pasture_move_events e
        WHERE e.id = i.move_id
          AND e.from_land_area_id IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.pasture_move_events e
         JOIN public.land_areas c ON c.id = e.from_land_area_id
        WHERE e.id = i.move_id
          AND c.parent_id = p_id
     );

  -- Last touch (also gates baseline-vs-no_history below): same occupancy guards
  -- for destination/overlap touches, so a departed area does not stay "touched"
  -- only because the next destination overlaps it.
  SELECT max(i.impacted_at)
    INTO v_last_touch
    FROM public.pasture_move_impacts i
    LEFT JOIN public.pasture_move_events e ON e.id = i.move_id
   WHERE i.land_area_id = p_id
     AND i.impact_kind IN ('destination', 'overlap')
     AND e.to_land_area_id IS NOT NULL
     AND NOT (
       i.impact_kind = 'overlap'
       AND EXISTS (
         SELECT 1
           FROM public.pasture_move_impacts d
          WHERE d.move_id = i.move_id
            AND d.land_area_id = i.land_area_id
            AND d.impact_kind = 'departure'
       )
     )
     AND NOT (
       i.impact_kind = 'overlap'
       AND EXISTS (
         SELECT 1 FROM public.land_areas c
          WHERE c.id = e.to_land_area_id
            AND c.parent_id = p_id
       )
     );

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
  ELSIF COALESCE(v_baseline, true)
        -- A parent whose stored baseline flag was flipped false ONLY by child
        -- overlaps (no self destination/overlap touch, no self departure) has no
        -- grazing history of its OWN: read it as baseline, not no_history. Orphan
        -- (NULL-link) impacts are likewise inert, so an area whose ONLY remaining
        -- impacts are orphans also reads baseline.
        OR (v_last_touch IS NULL AND v_last_departure IS NULL) THEN
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

NOTIFY pgrst, 'reload schema';
