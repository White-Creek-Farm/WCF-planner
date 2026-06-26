-- ============================================================================
-- 147_pasture_map_grazing_entry_delete_and_parent_overlap.sql
-- ----------------------------------------------------------------------------
-- Build Queue item 1 (groups + grazing-history-edit + parent-pasture coloring).
-- Two server-side changes, both read-derived (no schema change, no RLS change):
--
-- 1) delete_pasture_move(p_move_id): a management/admin per-entry grazing delete.
--    Replaces the per-AREA reset (delete_land_area_grazing_history, mig 143,
--    which stays deployed but unused) with a precise single-move delete. Removes
--    exactly ONE pasture_move_events row; its own pasture_move_impacts rows cascade
--    (move_id REFERENCES pasture_move_events(id) ON DELETE CASCADE, mig 128). All
--    area state (occupied / resting / rested / baseline) is derived ON READ from
--    pasture_move_impacts, so deleting the move event re-derives the Map fills and
--    the Reports timeline. Mirrors the delete_land_area SECDEF / role-gate /
--    REVOKE / GRANT boilerplate (mig 116).
--    COMPLETED-STAY drift fix: a finished stay also has a later move-OUT whose
--    'departure' impacts were derived from this move's destination/overlap areas
--    (record_pasture_move writes a departure on every touched area of the prior
--    move). Deleting only the move-IN row would orphan those departures and leave
--    the area "resting" while Reports shows no stay. So the delete also clears the
--    NEXT move's matching departure impacts (preserving that later move event),
--    keeping the read-derived map color and the Reports record in agreement.
--
-- 2) _land_area_summary(p_id): suppress CHILD-derived state on a PARENT pasture.
--    record_pasture_move writes an 'overlap' impact on every active area whose
--    geometry intersects the destination (mig 128/139). A child paddock sits
--    inside its parent pasture, so a move INTO the paddock gives the PARENT an
--    overlap impact, and clearing the paddock writes a departure on the parent
--    too. The summary counted those identically toward occupancy / rest, so a
--    parent pasture took occupied/resting FILL from its own child paddocks
--    (Ronnie: "clearing the Ewes out of a child paddock recolored the whole
--    parent FP3"). Fix, server-side, in the read function only:
--      - occupancy: ignore 'overlap' impacts whose move destination
--        (to_land_area_id) is a direct child of p_id (a land_areas row with
--        parent_id = p_id). A real 'destination' impact on the pasture itself
--        (a group placed directly in the pasture) is untouched.
--      - resting:   ignore 'departure' impacts whose move from-area
--        (from_land_area_id) is a direct child of p_id.
--      - last touch: same child-destination overlap suppression, so a pasture
--        whose ONLY history is child-derived reads 'baseline' (near-clean fill)
--        instead of the more-visible 'no_history' gray. (This last refinement is
--        beyond the literal "occupied + resting" ask but is required for the
--        parent to truly NOT take any fill from its children; documented here so
--        the intent is explicit.)
--    A child of p_id is the direct parent_id link (the documented pasture >
--    paddock model). Permanent pasture blue stroke and permanent paddock
--    bright-green stroke are designation colors set client-side and are NOT
--    touched here — only the read-derived FILL state changes.
--
-- Depends on: 116, 128, 131, 132 (latest _land_area_summary body), 139.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) _land_area_summary: parent-from-child suppression (body from mig 132 + the
--    three child-suppression guards). Return shape is UNCHANGED from mig 132.
-- ----------------------------------------------------------------------------
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
  -- a direct child paddock of p_id (clearing the child must not rest the parent).
  SELECT max(i.impacted_at)
    INTO v_last_departure
    FROM public.pasture_move_impacts i
   WHERE i.land_area_id = p_id
     AND i.impact_kind = 'departure'
     AND NOT EXISTS (
       SELECT 1
         FROM public.pasture_move_events e
         JOIN public.land_areas c ON c.id = e.from_land_area_id
        WHERE e.id = i.move_id
          AND c.parent_id = p_id
     );

  -- Last touch (also gates baseline-vs-no_history below): ignore overlaps that
  -- only landed in a child paddock so a child-only parent reads as untouched.
  SELECT max(i.impacted_at)
    INTO v_last_touch
    FROM public.pasture_move_impacts i
    LEFT JOIN public.pasture_move_events e ON e.id = i.move_id
   WHERE i.land_area_id = p_id
     AND i.impact_kind IN ('destination', 'overlap')
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
        -- grazing history of its OWN: read it as baseline, not no_history.
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

-- ----------------------------------------------------------------------------
-- 2) delete_pasture_move: management/admin per-entry grazing delete.
--    Deletes exactly one move event; impacts cascade. Returns the deleted move's
--    identity + impact count so the client can refresh the right surfaces.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_pasture_move(
  p_move_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller  uuid := auth.uid();
  v_role    text;
  v_event   public.pasture_move_events%ROWTYPE;
  v_impacts int := 0;
  v_touched text[];
  v_next_id text;
  v_linked  int := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'delete_pasture_move: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot delete a pasture move', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_event FROM public.pasture_move_events WHERE id = p_move_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Idempotent: already gone (e.g. a double-tap or replayed delete).
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'deleted_move_id', p_move_id);
  END IF;

  -- Serialize this group like record_pasture_move does, so a concurrent record and
  -- this delete cannot race on the same group's ledger / impact chain.
  PERFORM pg_advisory_xact_lock(
    hashtext('pasture_move_group'),
    hashtext(v_event.animal_type || ':' || v_event.group_key));

  SELECT count(*) INTO v_impacts
    FROM public.pasture_move_impacts
   WHERE move_id = p_move_id;

  -- A COMPLETED stay also has a later move-OUT whose 'departure' impacts were
  -- derived from THIS move's touched areas (record_pasture_move writes a departure
  -- on every destination/overlap area of the immediately-prior move). Deleting
  -- only this move-IN row would orphan those departures, leaving the area "resting"
  -- while Reports shows the stay gone. So: capture this move's touched areas, find
  -- the next move for the same group (same moved_at/created_at ordering the record
  -- RPC uses to pick the prior move), and clear ONLY that move's matching departure
  -- impacts. The next move event itself is preserved (it is a real later move).
  SELECT array_agg(land_area_id) INTO v_touched
    FROM public.pasture_move_impacts
   WHERE move_id = p_move_id
     AND impact_kind IN ('destination', 'overlap');

  IF v_touched IS NOT NULL THEN
    SELECT id INTO v_next_id
      FROM public.pasture_move_events
     WHERE animal_type = v_event.animal_type
       AND group_key = v_event.group_key
       AND id <> p_move_id
       AND (moved_at, created_at) > (v_event.moved_at, v_event.created_at)
     ORDER BY moved_at ASC, created_at ASC
     LIMIT 1;

    IF v_next_id IS NOT NULL THEN
      DELETE FROM public.pasture_move_impacts
       WHERE move_id = v_next_id
         AND impact_kind = 'departure'
         AND land_area_id = ANY (v_touched);
      GET DIAGNOSTICS v_linked = ROW_COUNT;
    END IF;
  END IF;

  -- Single-row delete; THIS move's own impacts cascade on move_id (mig 128 FK).
  DELETE FROM public.pasture_move_events WHERE id = p_move_id;

  RETURN jsonb_build_object(
    'ok', true,
    'replayed', false,
    'deleted_move_id', p_move_id,
    'animal_type', v_event.animal_type,
    'group_key', v_event.group_key,
    'group_label', v_event.group_label,
    'from_land_area_id', v_event.from_land_area_id,
    'to_land_area_id', v_event.to_land_area_id,
    'impacts_cleared', v_impacts,
    'linked_departure_impacts_cleared', v_linked
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.delete_pasture_move(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_pasture_move(text) TO authenticated;

-- New SECDEF RPC return shape -> refresh PostgREST's schema cache.
NOTIFY pgrst, 'reload schema';
