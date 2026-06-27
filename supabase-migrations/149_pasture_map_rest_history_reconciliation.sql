-- ============================================================================
-- 149_pasture_map_rest_history_reconciliation.sql
-- ----------------------------------------------------------------------------
-- Defect: FP3 and FP3A1 read "Resting / Last grazed" on the Map while the
-- Reports grazing record shows no stay ("0 times grazed"). Read-only PROD
-- forensics (2026-06-26) found the cause:
--
--   The Reports timeline shows VISIBLE STAYS only: move-IN events whose
--   to_land_area_id is the selected area. _land_area_summary, however, derived
--   rest_state / last_touched_at / last_moved_out_at from pasture_move_impacts,
--   including overlap and departure impacts whose move event had LOST its
--   directional link (to_land_area_id / from_land_area_id = NULL).
--
--   Such NULL-link impacts are ORPHANS with no visible stay to explain them.
--   They arise when an area is detached from the ledger after the impact was
--   written -- e.g. delete_land_area_grazing_history (mig 143) nulls an event's
--   from/to but only deletes the RESET area's own impacts, stranding the
--   overlap/departure impacts it wrote on other areas; the land_areas FK on
--   pasture_move_events is ON DELETE SET NULL, so an admin hard-delete of an
--   area produces the same orphan class. On PROD the "Ewes" history was reset on
--   its real destination area, leaving 6 orphan impacts (overlap + departure)
--   stranded on FP3 (parent) and FP3A1 (child), each with to/from = NULL.
--
--   Those NULL links also DEFEAT mig 147's child-from-parent suppression, which
--   keys on the move's to_land_area_id / from_land_area_id pointing at a child
--   of p_id: a NULL link can no longer be recognised as child-derived, so the
--   parent re-counted the orphan and read "resting".
--
-- Fix (server-side, read function only; no schema/RLS/return-shape change):
--   _land_area_summary now ignores impacts whose move event has no directional
--   link for the derivation in question:
--     - occupancy / last-touch (destination, overlap): require the move's
--       to_land_area_id IS NOT NULL (a detached destination is not a stay).
--     - resting (departure):                            require the move's
--       from_land_area_id IS NOT NULL (a detached departure is not a real rest).
--   Mig 147's child-from-parent suppression is preserved verbatim. State is
--   read-derived, so FP3 and FP3A1 re-read as 'baseline' the instant this
--   function is replaced -- no data mutation needed. A real direct stay
--   (Pig Pasture #4) keeps its non-null to_land_area_id and is untouched.
--
-- Invariant enforced: a screen cannot say "Last grazed" / "Resting" for an area
-- unless a visible direct grazing stay (to_land_area_id = area) explains it, or
-- a non-orphan overlap/departure does. Orphan (NULL-link) impacts are inert.
--
-- Stale orphan impact rows are NOT deleted here (the read function now ignores
-- them); a separate, explicitly-approved one-time cleanup can remove them as
-- hygiene if desired.
--
-- Depends on: 116, 128, 131, 132, 139, 147 (latest _land_area_summary body).
-- ============================================================================

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

  -- Last touch (also gates baseline-vs-no_history below): ignore overlaps that
  -- only landed in a child paddock so a child-only parent reads as untouched,
  -- and ignore ORPHAN destination/overlap touches whose move lost its to link.
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

-- Return shape is UNCHANGED from mig 147; no PostgREST reload required (the
-- function is called internally by the area-summary RPCs, not exposed directly).
